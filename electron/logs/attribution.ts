import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { describeError, getDefaultLogger, type Logger } from '../logger'

const MAX_JARS = 10
const MAX_METADATA_BYTES = 64 * 1024

export interface ModAttribution {
  modId: string
  jar: string
  confidence: 'likely' | 'possible'
}

interface JarCandidate {
  file: string
  base: string
}

function candidateIds(lines: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const line of lines) {
    const stack = /^\s*at ([a-z0-9_]+)\./.exec(line)
    if (stack) ids.add(stack[1].toLowerCase())
    const caused = /Caused by: .*?([a-z0-9_]+)\./.exec(line)
    if (caused) ids.add(caused[1].toLowerCase())
  }
  return [...ids]
}

function readMetadata(zip: AdmZip, names: string[]): string | undefined {
  for (const name of names) {
    const entry = zip.getEntry(name)
    if (!entry || entry.isDirectory) continue
    const size = entry.header?.size
    if (typeof size === 'number' && size > MAX_METADATA_BYTES) continue
    const data = entry.getData()
    if (data.length > MAX_METADATA_BYTES) continue
    return data.toString('utf8')
  }
  return undefined
}

function jsonId(text: string | undefined): string | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const id = value.id ?? (value.quilt_loader as Record<string, unknown> | undefined)?.id
    return typeof id === 'string' ? id.toLowerCase() : undefined
  } catch (error) {
    getDefaultLogger().child('logs').debug('mod metadata JSON unreadable', { error: describeError(error) })
    return undefined
  }
}

function tomlId(text: string | undefined): string | undefined {
  if (!text) return undefined
  const match = /^\s*modId\s*=\s*"([^"]+)"/m.exec(text) ?? /^\s*modId\s*=\s*'([^']+)'/m.exec(text)
  return match?.[1]?.toLowerCase()
}

async function metadataId(jar: string): Promise<string | undefined> {
  try {
    const zip = new AdmZip(jar)
    return (
      jsonId(readMetadata(zip, ['fabric.mod.json'])) ??
      jsonId(readMetadata(zip, ['quilt.mod.json'])) ??
      tomlId(readMetadata(zip, ['META-INF/neoforge.mods.toml'])) ??
      tomlId(readMetadata(zip, ['META-INF/mods.toml']))
    )
  } catch (error) {
    getDefaultLogger().child('logs').debug('mod jar metadata unreadable', { jar, error: describeError(error) })
    return undefined
  }
}

export async function findOlderDuplicateJar(modsDir: string): Promise<string | undefined> {
  const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => [])
  const groups = new Map<string, Array<{ file: string; mtimeMs: number }>>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
    const match = /^(.*?)-\d[\w.+-]*\.jar$/i.exec(entry.name)
    if (!match) continue
    const info = await stat(join(modsDir, entry.name)).catch(() => undefined)
    if (!info) continue
    const key = match[1].toLowerCase()
    const group = groups.get(key) ?? []
    group.push({ file: entry.name, mtimeMs: info.mtimeMs })
    groups.set(key, group)
  }
  const candidates = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
  if (candidates.length === 0) return undefined
  candidates[0][1].sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
  return candidates[0][1][0].file
}

export async function attributeMod(
  lines: readonly string[],
  modsDir: string,
  options: { logger?: Logger } = {},
): Promise<ModAttribution | undefined> {
  const ids = candidateIds(lines)
  if (ids.length === 0) return undefined
  const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => [])
  const jars: JarCandidate[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
    const match = /^(.*?)-\d[\w.+-]*\.jar$/i.exec(entry.name)
    if (!match) continue
    jars.push({ file: entry.name, base: match[1].toLowerCase() })
  }

  for (const id of ids) {
    const byName = jars.filter((jar) => jar.base === id || jar.base.replace(/[-_]/g, '') === id)
    if (byName.length === 1) {
      return { modId: id, jar: byName[0].file, confidence: 'likely' }
    }
    if (byName.length > 1) {
      for (const candidate of byName.slice(0, MAX_JARS)) {
        if ((await metadataId(join(modsDir, candidate.file))) === id) {
          return { modId: id, jar: candidate.file, confidence: 'likely' }
        }
      }
      return { modId: id, jar: byName[0].file, confidence: 'possible' }
    }
  }

  for (const candidate of jars.slice(0, MAX_JARS)) {
    const id = await metadataId(join(modsDir, candidate.file))
    if (id && ids.includes(id)) {
      return { modId: id, jar: candidate.file, confidence: 'likely' }
    }
  }
  options.logger?.debug('No unambiguous mod attribution', { ids, jars: jars.length })
  return undefined
}
