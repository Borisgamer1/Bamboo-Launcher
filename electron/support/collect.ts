import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findLatestCrashReport } from '../logs/crash-report'
import { findLatestLog, readLogTail } from '../logs/tail'
import { sanitizeSupportText } from './sanitize'
import { describeError, getDefaultLogger } from '../logger'

export interface SupportRoots {
  appData: string
  gameRoot: string
}

export interface SettingsSummary {
  currentTheme: string
  lang: string
  telemetryEnabled: boolean
}

export interface InstanceSummary {
  label: string
  version: string
  loader: string
  loaderVersion: string
  managed: boolean
}

export interface JavaSummary {
  label: string
  version: string
  majorVersion: number
  architecture: string
  vendor: string
  source: string
  valid: boolean
}

export interface InstalledVersionSummary {
  id: string
  type: string
  inheritsFrom: string
  javaMajor: number
  loader: string
  loaderVersion: string
  installedAt: string
}

export interface LogCollection {
  files: Record<string, string>
  count: number
}

export interface SupportData {
  settings: SettingsSummary
  instances: InstanceSummary[]
  java: JavaSummary[]
  versions: InstalledVersionSummary[]
  logs: LogCollection
}

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_LOG_FILES = 10

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch (error) {
    getDefaultLogger().child('support').debug('JSON file unreadable', { error: describeError(error) })
    return undefined
  }
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text ? safeJson(text) : undefined
}

export async function readSettingsSummary(appData: string): Promise<SettingsSummary> {
  const raw = await readJsonFile(join(appData, 'settings.json'))
  return {
    currentTheme: typeof raw?.currentTheme === 'string' ? raw.currentTheme : 'dark',
    lang: typeof raw?.lang === 'string' ? raw.lang : 'de',
    telemetryEnabled: raw?.telemetryEnabled === true,
  }
}

function summarizeInstances(raw: unknown): InstanceSummary[] {
  if (!raw || typeof raw !== 'object') return []
  const instances = (raw as { instances?: unknown }).instances
  if (!Array.isArray(instances)) return []
  return instances.slice(0, 500).map((entry, index) => {
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    return {
      label: `instance-${index + 1}`,
      version: String(value.version ?? ''),
      loader: String(value.loader ?? ''),
      loaderVersion: String(value.loaderVersion ?? ''),
      managed: value.managed !== false,
    }
  })
}

export async function readInstanceSummaries(appData: string): Promise<InstanceSummary[]> {
  return summarizeInstances(await readJsonFile(join(appData, 'instances.json')))
}

function summarizeJava(raw: unknown): JavaSummary[] {
  if (!raw || typeof raw !== 'object') return []
  const records = (raw as { records?: unknown }).records
  if (!Array.isArray(records)) return []
  return records.slice(0, 100).map((entry, index) => {
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    return {
      label: `java-${index + 1}`,
      version: String(value.version ?? ''),
      majorVersion: Number(value.majorVersion ?? 0),
      architecture: String(value.architecture ?? ''),
      vendor: String(value.vendor ?? ''),
      source: String(value.source ?? ''),
      valid: value.valid !== false,
    }
  })
}

export async function readJavaSummaries(appData: string): Promise<JavaSummary[]> {
  return summarizeJava(await readJsonFile(join(appData, 'java.json')))
}

export async function readInstalledVersions(gameRoot: string): Promise<InstalledVersionSummary[]> {
  const dir = join(gameRoot, 'versions')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const versions: InstalledVersionSummary[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)) {
    if (!entry.isDirectory()) continue
    const folder = join(dir, entry.name)
    const version = await readJsonFile(join(folder, `${entry.name}.json`))
    const marker = await readJsonFile(join(folder, 'bamboo-loader.json'))
    const javaVersion = version?.javaVersion
    const javaMajor =
      javaVersion && typeof javaVersion === 'object'
        ? Number((javaVersion as { majorVersion?: unknown }).majorVersion ?? 0)
        : 0
    versions.push({
      id: entry.name,
      type: String(version?.type ?? ''),
      inheritsFrom: String(version?.inheritsFrom ?? ''),
      javaMajor: Number.isFinite(javaMajor) ? javaMajor : 0,
      loader: String(marker?.loader ?? 'vanilla'),
      loaderVersion: String(marker?.loaderVersion ?? ''),
      installedAt: String(marker?.installedAt ?? ''),
    })
  }
  return versions
}

export async function readLogs(roots: SupportRoots): Promise<LogCollection> {
  const dir = join(roots.appData, 'logs')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: Record<string, string> = {}
  let count = 0
  for (const entry of entries) {
    if (count >= MAX_LOG_FILES) break
    if (!entry.isFile() || !/\.log(?:\.\d+)?$/.test(entry.name)) continue
    const file = join(dir, entry.name)
    const info = await stat(file).catch(() => undefined)
    if (!info || info.size > MAX_LOG_BYTES) continue
    const text = await readFile(file, 'utf8').catch(() => '')
    files[`logs/${basename(entry.name)}`] = sanitizeSupportText(text, roots)
    count += 1
  }

  const gameLogs = join(roots.gameRoot, 'logs')
  const chosen = (await findLatestLog(gameLogs)) ?? { path: join(gameLogs, 'latest.log') }
  const tail = await readLogTail(chosen.path)
  if (tail.lines.length > 0) {
    files['game/latest.log'] = sanitizeSupportText(tail.lines.join('\n'), roots)
    count += 1
  }
  const report = await findLatestCrashReport(join(roots.gameRoot, 'crash-reports'))
  if (report) {
    const text = await readFile(report.path, 'utf8').catch(() => '')
    if (text.length > 0) {
      files['game/crash-report.txt'] = sanitizeSupportText(text.slice(0, 256 * 1024), roots)
      count += 1
    }
  }
  return { files, count }
}

export async function collectSupportData(roots: SupportRoots): Promise<SupportData> {
  const [settings, instances, java, versions, logs] = await Promise.all([
    readSettingsSummary(roots.appData),
    readInstanceSummaries(roots.appData),
    readJavaSummaries(roots.appData),
    readInstalledVersions(roots.gameRoot),
    readLogs(roots),
  ])
  return { settings, instances, java, versions, logs }
}
