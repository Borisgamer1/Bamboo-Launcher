import AdmZip from 'adm-zip'
import { describeError, getDefaultLogger } from '../logger'
import type { ModDependencyInfo, ModLoader, ParsedMod } from './types'

const PLATFORM_IDS = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'quilt_loader',
  'quiltloader',
  'forge',
  'neoforge',
  'javafml',
  'lowcodefml',
  'fml',
])

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function versionRange(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map(asString).filter(Boolean)
    return parts.length > 0 ? parts.join(' || ') : undefined
  }
  const text = asString(value)
  return text ? text : undefined
}

function uniqueDependencies(list: ModDependencyInfo[]): ModDependencyInfo[] {
  const seen = new Set<string>()
  const result: ModDependencyInfo[] = []
  for (const dependency of list) {
    if (!dependency.id || PLATFORM_IDS.has(dependency.id.toLowerCase())) continue
    const key = dependency.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(dependency)
  }
  return result
}

function parseFabric(raw: Record<string, unknown>): ParsedMod | undefined {
  const id = asString(raw.id)
  if (!id) return undefined
  const depends = (raw.depends ?? {}) as Record<string, unknown>
  const dependencies: ModDependencyInfo[] = []
  for (const [depId, range] of Object.entries(depends)) {
    if (PLATFORM_IDS.has(depId.toLowerCase())) continue
    dependencies.push({
      id: depId,
      mandatory: true,
      ...(versionRange(range) ? { versionRange: versionRange(range) } : {}),
      reason: 'depends',
    })
  }
  const provides = Array.isArray(raw.provides)
    ? raw.provides.map(asString).filter(Boolean)
    : []
  return {
    id,
    name: asString(raw.name) || id,
    version: asString(raw.version),
    loader: 'fabric',
    dependencies: uniqueDependencies(dependencies),
    provides,
    ...(versionRange(depends.minecraft) ? { minecraftVersionRange: versionRange(depends.minecraft) } : {}),
    ...(versionRange(depends.fabricloader) || versionRange(depends['fabric-loader'])
      ? { loaderVersionRange: versionRange(depends.fabricloader) ?? versionRange(depends['fabric-loader']) }
      : {}),
    source: 'fabric.mod.json',
  }
}

function quiltDependencyList(value: unknown): ModDependencyInfo[] {
  if (!Array.isArray(value)) return []
  const result: ModDependencyInfo[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const id = asString(raw.id)
    if (!id) continue
    const range = versionRange(raw.versions) ?? versionRange(raw.version)
    result.push({
      id,
      mandatory: raw.optional !== true,
      ...(range ? { versionRange: range } : {}),
      reason: 'depends',
    })
  }
  return result
}

function parseQuilt(raw: Record<string, unknown>): ParsedMod | undefined {
  const loader = (raw.quilt_loader ?? {}) as Record<string, unknown>
  const metadata = (loader.metadata ?? {}) as Record<string, unknown>
  const id = asString(loader.id) || asString(raw.id)
  if (!id) return undefined
  const dependencies = [
    ...quiltDependencyList(loader.depends),
    ...quiltDependencyList(raw.depends),
  ]
  const providesRaw = loader.provides ?? raw.provides
  const provides = Array.isArray(providesRaw)
    ? providesRaw
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : asString((entry as Record<string, unknown>)?.id),
        )
        .filter(Boolean)
    : []
  return {
    id,
    name: asString(metadata.name) || id,
    version: asString(loader.version) || asString(raw.version),
    loader: 'quilt',
    dependencies: uniqueDependencies(dependencies),
    provides,
    source: 'quilt.mod.json',
  }
}

interface TomlTable {
  path: string[]
  values: Record<string, unknown>
}

function unquote(input: string): string {
  const text = input.trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index).trimEnd()
  }
  return line
}

function parseTomlValue(input: string): unknown {
  const text = input.trim()
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part))
      .filter((part) => part.length > 0)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  return unquote(text)
}

export function parseTomlSubset(text: string): TomlTable[] {
  const tables: TomlTable[] = [{ path: [], values: {} }]
  let current = tables[0]
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].trim()
    if (!rawLine || rawLine.startsWith('#')) continue
    const line = stripTomlComment(rawLine)
    if (!line) continue
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const path = line
        .slice(2, -2)
        .split('.')
        .map((part) => part.trim())
        .filter(Boolean)
      current = { path, values: {} }
      tables.push(current)
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const path = line
        .slice(1, -1)
        .split('.')
        .map((part) => part.trim())
        .filter(Boolean)
      current = { path, values: {} }
      tables.push(current)
      continue
    }
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim()
    if (value.startsWith("'''") || value.startsWith('"""')) {
      const quote = value.slice(0, 3)
      let rest = value.slice(3)
      while (!rest.includes(quote) && index + 1 < lines.length) {
        index += 1
        rest = lines[index]
      }
      current.values[key] = rest.includes(quote) ? rest.slice(0, rest.indexOf(quote)) : rest
      continue
    }
    current.values[key] = parseTomlValue(value)
  }
  return tables
}

function parseForgeToml(
  text: string,
  loader: 'forge' | 'neoforge',
  source: string,
): ParsedMod | undefined {
  const tables = parseTomlSubset(text)
  const mods = tables.filter((table) => table.path[0] === 'mods')
  const mod = mods.find((table) => asString(table.values.modId) || asString(table.values.modid))
  if (!mod) return undefined
  const id = asString(mod.values.modId) || asString(mod.values.modid)
  const dependencies: ModDependencyInfo[] = []
  let minecraftVersionRange: string | undefined
  let loaderVersionRange: string | undefined
  for (const table of tables) {
    if (table.path[0] !== 'dependencies') continue
    const depId = asString(table.values.modId) || asString(table.values.modid)
    if (!depId) continue
    const range = versionRange(table.values.versionRange) ?? versionRange(table.values.version)
    const mandatory = table.values.mandatory !== false
    if (depId.toLowerCase() === 'minecraft') {
      minecraftVersionRange = range
      continue
    }
    if (depId.toLowerCase() === 'forge' || depId.toLowerCase() === 'neoforge') {
      loaderVersionRange = range
      continue
    }
    if (PLATFORM_IDS.has(depId.toLowerCase())) continue
    if (!mandatory) continue
    dependencies.push({
      id: depId,
      mandatory: true,
      ...(range ? { versionRange: range } : {}),
      reason: 'depends',
    })
  }
  const providesRaw = mod.values.provides
  const provides = Array.isArray(providesRaw)
    ? providesRaw.map(asString).filter(Boolean)
    : typeof providesRaw === 'string' && providesRaw
      ? [providesRaw]
      : []
  return {
    id,
    name:
      asString(mod.values.displayName) ||
      asString(mod.values.displayname) ||
      id,
    version: asString(mod.values.version),
    loader,
    dependencies: uniqueDependencies(dependencies),
    provides,
    ...(minecraftVersionRange ? { minecraftVersionRange } : {}),
    ...(loaderVersionRange ? { loaderVersionRange } : {}),
    source,
  }
}

function parseLegacy(text: string): ParsedMod | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    getDefaultLogger().child('mods:metadata').debug('legacy metadata is not valid JSON', {
      error: describeError(error),
    })
    return undefined
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.modList)
      ? ((parsed as Record<string, unknown>).modList as unknown[])
      : [parsed]
  const first = list.find(
    (entry) => entry && typeof entry === 'object' && asString((entry as Record<string, unknown>).modid),
  ) as Record<string, unknown> | undefined
  if (!first) return undefined
  const id = asString(first.modid)
  const requiredMods = Array.isArray(first.requiredMods)
    ? first.requiredMods.map(asString).filter(Boolean)
    : []
  return {
    id,
    name: asString(first.name) || id,
    version: asString(first.version),
    loader: 'legacy',
    dependencies: uniqueDependencies(
      requiredMods.map((depId) => ({ id: depId, mandatory: true, reason: 'depends' as const })),
    ),
    provides: [],
    source: 'mcmod.info',
  }
}

function bufferText(buffer: Buffer | undefined): string | undefined {
  if (!buffer) return undefined
  try {
    return buffer.toString('utf8')
  } catch (error) {
    getDefaultLogger().child('mods:metadata').debug('metadata buffer is not decodable', {
      error: describeError(error),
    })
    return undefined
  }
}

function parseJson(buffer: Buffer | undefined): Record<string, unknown> | undefined {
  const text = bufferText(buffer)
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch (error) {
    getDefaultLogger().child('mods:metadata').debug('metadata file is not valid JSON', {
      error: describeError(error),
    })
    return undefined
  }
}

export function parseModMetadata(entries: Record<string, Buffer>): ParsedMod | undefined {
  const fabric = parseJson(entries['fabric.mod.json'])
  if (fabric) {
    const parsed = parseFabric(fabric)
    if (parsed) return parsed
  }
  const quilt = parseJson(entries['quilt.mod.json'])
  if (quilt) {
    const parsed = parseQuilt(quilt)
    if (parsed) return parsed
  }
  const neoforge = bufferText(entries['META-INF/neoforge.mods.toml'])
  if (neoforge) {
    const parsed = parseForgeToml(neoforge, 'neoforge', 'META-INF/neoforge.mods.toml')
    if (parsed) return parsed
  }
  const forge = bufferText(entries['META-INF/mods.toml'])
  if (forge) {
    const parsed = parseForgeToml(forge, 'forge', 'META-INF/mods.toml')
    if (parsed) return parsed
  }
  const legacy = bufferText(entries['mcmod.info'])
  if (legacy) return parseLegacy(legacy)
  return undefined
}

const METADATA_FILES = new Set([
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info',
])

function parseArchive(zip: AdmZip): ParsedMod | undefined {
  const entries: Record<string, Buffer> = {}
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (METADATA_FILES.has(entry.entryName)) entries[entry.entryName] = entry.getData()
  }
  return parseModMetadata(entries)
}

export async function readModMetadataList(jarPath: string): Promise<ParsedMod[]> {
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch (error) {
    getDefaultLogger().child('mods:metadata').debug('mod archive could not be opened', {
      jarPath,
      error: describeError(error),
    })
    return []
  }
  const result: ParsedMod[] = []
  const top = parseArchive(zip)
  if (top) result.push(top)
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (!name.startsWith('META-INF/jars/') || !name.toLowerCase().endsWith('.jar')) continue
    try {
      const nested = parseArchive(new AdmZip(entry.getData()))
      if (nested) result.push(nested)
    } catch (error) {
      // A broken nested jar must not hide the other metadata entries.
      getDefaultLogger().child('mods:metadata').debug('nested mod jar could not be read', {
        jarPath,
        entry: name,
        error: describeError(error),
      })
    }
  }
  return result
}

export async function readModMetadata(jarPath: string): Promise<ParsedMod | undefined> {
  return (await readModMetadataList(jarPath))[0]
}

export function loaderFromModMetadata(mod: ParsedMod | undefined): ModLoader {
  return mod?.loader ?? 'unknown'
}
