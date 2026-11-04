import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { attributeMod, findOlderDuplicateJar } from './attribution'
import { findLatestCrashReport, isCrashReportFresh, parseCrashReport } from './crash-report'
import { RULES } from './rules'
import { findLatestLog, readLogTail } from './tail'
import { describeError, getDefaultLogger } from '../logger'
import type {
  AnalysisContext,
  AnalysisResult,
  CrashReportSummary,
  Finding,
  FixAction,
  LogTail,
  ReasonCode,
} from './types'

export const ANCHOR =
  /exception|caused by|unsupportedclassversion|outofmemory|zipexception|duplicate mod|mod resolution failed|mixin|requires|glfw error|crash report|noclassdeffound|incompatible mod/i

const MAX_FINDINGS = RULES.length
const MAX_EVIDENCE = 3
const MAX_RING = 8

interface AnalysisRecord {
  result: AnalysisResult
  context: AnalysisContext
}

const ring: AnalysisRecord[] = []

export function getAnalysis(analysisId: string): AnalysisRecord | undefined {
  return ring.find((entry) => entry.result.id === analysisId)
}

function remember(record: AnalysisRecord): void {
  ring.push(record)
  while (ring.length > MAX_RING) ring.shift()
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch (error) {
    getDefaultLogger().child('logs').debug('log file not accessible', { file, error: describeError(error) })
    return false
  }
}

async function chooseLog(logsDir: string): Promise<{ path?: string }> {
  const latest = join(logsDir, 'latest.log')
  if (await fileExists(latest)) return { path: latest }
  const newest = await findLatestLog(logsDir)
  return newest ? { path: newest.path } : {}
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '')
}

function detectGraphicsVendor(lines: readonly string[]): AnalysisContext['graphicsVendor'] {
  const text = lines.join('\n')
  if (/nvidia|geforce/i.test(text)) return 'nvidia'
  if (/amd|radeon|advanced micro devices/i.test(text)) return 'amd'
  if (/intel/i.test(text)) return 'intel'
  return undefined
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function actionFor(
  action: FixAction | undefined,
  attribution: { jar: string } | undefined,
): FixAction | undefined {
  if (!action) return undefined
  if (action.kind === 'disable-mod' && attribution) {
    return { ...action, jar: attribution.jar }
  }
  return action
}

function fallbackAction(
  ruleId: string,
  context: AnalysisContext,
  attribution: { jar: string } | undefined,
): FixAction | undefined {
  if (!attribution) return undefined
  if (ruleId === 'duplicate-mod') {
    return {
      id: '',
      kind: 'disable-mod',
      jar: attribution.jar,
      targetDir: join(context.instanceDir, 'mods-disabled'),
    }
  }
  return undefined
}

function needsAttribution(ruleIds: readonly string[]): boolean {
  return ruleIds.some((id) =>
    id === 'duplicate-mod' ||
    id === 'mixin-apply-failed' ||
    id === 'corrupt-jar' ||
    id === 'no-class-def',
  )
}

function reportLines(report: CrashReportSummary | undefined): string[] {
  if (!report) return []
  const lines: string[] = []
  if (report.description) lines.push(`Description: ${report.description}`)
  if (report.gpu) lines.push(`Graphics card: ${report.gpu}`)
  lines.push(...report.causes)
  if (report.stacktrace) lines.push(`Stacktrace: ${report.stacktrace}`)
  return lines
}

export async function analyzeInstance(
  input: AnalysisContext,
  options: { logger?: import('../logger').Logger } = {},
): Promise<AnalysisResult> {
  const logsDir = join(input.instanceDir, 'logs')
  const chosen = input.logFile ? { path: input.logFile } : await chooseLog(logsDir)
  const tail: LogTail = chosen.path
    ? await readLogTail(chosen.path, { logger: options.logger })
    : { lines: [], truncated: false, bytes: 0, anchorHits: 0 }

  const stderr = (input.stderrLines ?? []).map(stripAnsi)
  let report: CrashReportSummary | undefined
  let reportStale = false
  if (input.crashReportFile) {
    report = await parseCrashReport(input.crashReportFile, { logger: options.logger })
  } else {
    report = await findLatestCrashReport(join(input.instanceDir, 'crash-reports'))
  }
  if (report && !isCrashReportFresh(report, input.launchStartedAt)) {
    reportStale = true
    report = undefined
  }

  const source = unique([
    ...tail.lines.map(stripAnsi),
    ...stderr,
    ...reportLines(report),
  ])
  let anchorHits = 0
  const hits = new Map<string, { match: RegExpExecArray; line: string }>()
  for (const line of source) {
    if (!ANCHOR.test(line)) continue
    anchorHits += 1
    for (const rule of RULES) {
      if (hits.has(rule.id)) continue
      rule.pattern.lastIndex = 0
      const match = rule.pattern.exec(line)
      if (match) hits.set(rule.id, { match, line })
    }
  }

  const modsDir = join(input.instanceDir, 'mods')
  const attribution =
    needsAttribution([...hits.keys()]) && (await fileExists(modsDir))
      ? await attributeMod(source, modsDir, options)
      : undefined
  const duplicateJar = hits.has('duplicate-mod') ? await findOlderDuplicateJar(modsDir) : undefined
  const graphicsVendor = detectGraphicsVendor(source)
  const ruleContext: AnalysisContext = {
    ...input,
    ...(graphicsVendor ? { graphicsVendor } : {}),
  }

  const findings: Finding[] = []
  for (const rule of RULES) {
    const hit = hits.get(rule.id)
    if (!hit || findings.length >= MAX_FINDINGS) continue
    const sameRule = source.filter((line) => {
      rule.pattern.lastIndex = 0
      return line !== hit.line && rule.pattern.test(line)
    })
    const evidence = unique([hit.line, ...sameRule]).slice(0, MAX_EVIDENCE)

    let actions: FixAction[] = []
    const fixed = actionFor(rule.fix?.(hit.match, ruleContext), attribution)
    if (fixed) actions.push(fixed)
    else {
      const duplicateAttribution = duplicateJar ? { jar: duplicateJar } : attribution
      const fallback = fallbackAction(rule.id, input, duplicateAttribution)
      if (fallback) actions.push(fallback)
    }
    actions = actions.map((action, index) => ({ ...action, id: `${rule.id}-${index}` }))

    findings.push({
      ruleId: rule.id,
      confidence: rule.confidence,
      title: rule.title.de,
      detail: rule.detail(hit.match, ruleContext),
      evidence,
      actions,
    })
  }

  const reasons: ReasonCode[] = []
  for (const finding of findings) reasons.push(`crash.rule-${finding.ruleId}`)
  if (findings.some((finding) => finding.confidence === 'possible')) reasons.push('crash.confidence-low')
  if (reportStale) reasons.push('crash.report-stale')
  if (findings.length === 0) reasons.push('crash.no-signal')
  if (report && tail.lines.length === 0) {
    reasons.push('crash.report-only')
  }

  let at = Date.now()
  while (getAnalysis(`analysis-${input.instanceId}${input.launchId ? `-${input.launchId}` : ''}-${at}`)) {
    at += 1
  }
  const id = `analysis-${input.instanceId}${input.launchId ? `-${input.launchId}` : ''}-${at}`
  const result: AnalysisResult = {
    id,
    instanceId: input.instanceId,
    ...(input.launchId ? { launchId: input.launchId } : {}),
    truncated: tail.truncated,
    findings,
    reasons,
    anchorHits,
  }
  remember({ result, context: input })
  options.logger?.info('Crash analysis complete', {
    analysisId: id,
    findings: findings.length,
    truncated: tail.truncated,
    anchorHits,
    reportStale,
  })
  return result
}

export async function listInstanceLogs(instanceDir: string): Promise<{
  logs: string[]
  crashReports: string[]
}> {
  const logs = (await readdir(join(instanceDir, 'logs'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /\.log(?:\.gz)?$/i.test(entry.name))
    .map((entry) => entry.name)
  const crashReports = (
    await readdir(join(instanceDir, 'crash-reports'), { withFileTypes: true }).catch(() => [])
  )
    .filter((entry) => entry.isFile() && /^crash-.*\.txt$/i.test(entry.name))
    .map((entry) => entry.name)
  return { logs, crashReports }
}
