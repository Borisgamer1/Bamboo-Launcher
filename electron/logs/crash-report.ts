import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '../logger'
import type { CrashReportSummary } from './types'

const MAX_REPORT_BYTES = 256 * 1024
const MAX_MOD_LINES = 500
const MAX_CAUSES = 5

export interface CrashReportOptions {
  logger?: Logger
}

async function readBounded(file: string): Promise<{ text: string; mtimeMs: number; truncated: boolean }> {
  const info = await stat(file)
  const length = Math.min(info.size, MAX_REPORT_BYTES)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      mtimeMs: info.mtimeMs,
      truncated: info.size > MAX_REPORT_BYTES,
    }
  } finally {
    await handle.close()
  }
}

export async function parseCrashReport(
  file: string,
  options: CrashReportOptions = {},
): Promise<CrashReportSummary | undefined> {
  try {
    const { text, mtimeMs, truncated } = await readBounded(file)
    if (text.trim().length === 0) return undefined

    const description = /^\s*Description:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const minecraftVersion = /^\s*Minecraft Version:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const javaVersion = /^\s*Java Version:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const gpu = /^\s*Graphics card #0 name:\s*(.+)$/m.exec(text)?.[1]?.trim()
    const mods: string[] = []
    const systemStart = text.indexOf('-- System Details --')
    const modsStart = text.indexOf('Mod List:', systemStart >= 0 ? systemStart : 0)
    if (modsStart >= 0) {
      const lines = text.slice(modsStart).split(/\r?\n/)
      for (const line of lines.slice(1)) {
        if (mods.length >= MAX_MOD_LINES) break
        const value = line.trim()
        if (!value) break
        if (value.startsWith('--')) break
        mods.push(value)
      }
    }

    const causes: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (causes.length >= MAX_CAUSES) break
      const match = /^\s*Caused by:\s*(.+)$/.exec(line)
      if (match) causes.push(match[1].trim())
    }
    const inlineStacktrace = /^\s*Stacktrace:\s*(\S.+)$/m.exec(text)?.[1]?.trim()
    const stackHeader = /^\s*Stacktrace:\s*$/m.exec(text)
    let stacktrace: string | undefined = inlineStacktrace
    if (!stacktrace && stackHeader) {
      const after = text.slice(stackHeader.index + stackHeader[0].length).split(/\r?\n/)
      stacktrace = after.map((line) => line.trim()).find((line) => line.length > 0)
    }

    const summary: CrashReportSummary = {
      path: file,
      mtimeMs,
      mods,
      causes,
      truncated,
    }
    if (description) summary.description = description
    if (minecraftVersion) summary.minecraftVersion = minecraftVersion
    if (javaVersion) summary.javaVersion = javaVersion
    if (gpu) summary.gpu = gpu
    if (stacktrace) summary.stacktrace = stacktrace
    return summary
  } catch (error) {
    options.logger?.warn('Crash report could not be read', {
      file,
      error: (error as Error).message,
    })
    return undefined
  }
}

export async function findLatestCrashReport(
  crashReportsDir: string,
): Promise<CrashReportSummary | undefined> {
  const entries = await readdir(crashReportsDir, { withFileTypes: true }).catch(() => [])
  const files: Array<{ path: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^crash-.*\.txt$/i.test(entry.name)) continue
    const file = join(crashReportsDir, entry.name)
    const info = await stat(file).catch(() => undefined)
    if (info) files.push({ path: file, mtimeMs: info.mtimeMs })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  if (files.length === 0) return undefined
  return parseCrashReport(files[0].path)
}

export function isCrashReportFresh(
  report: CrashReportSummary,
  launchStartedAt: number | undefined,
): boolean {
  if (launchStartedAt === undefined) return true
  return report.mtimeMs >= launchStartedAt - 5000
}
