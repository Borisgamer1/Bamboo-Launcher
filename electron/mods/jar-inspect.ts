import AdmZip from 'adm-zip'
import { describeError, getDefaultLogger } from '../logger'
import { parseModMetadata, parseTomlSubset } from './metadata'

const METADATA_ENTRIES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info',
]

const ICON_ENTRIES = ['icon.png', 'assets/icon.png', 'logo.png', 'pack.png']

export interface JarMetadata {
  modName: string | null
  modVersion: string | null
  modLoader: string | null
  mcVersion: string | null
  iconBase64: string | null
  description: string
  authors: string
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function authorNames(value: unknown): string {
  if (!Array.isArray(value)) return text(value)
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : text((entry as Record<string, unknown> | null)?.name),
    )
    .filter(Boolean)
    .join(', ')
}

/** Presentation fields that the dependency parser does not need. */
function presentation(entries: Record<string, Buffer>): { description: string; authors: string } {
  const fabric = entries['fabric.mod.json']
  if (fabric) {
    try {
      const raw = JSON.parse(fabric.toString('utf8')) as Record<string, unknown>
      return { description: text(raw.description), authors: authorNames(raw.authors) }
    } catch {
      // The core parser already reported the broken manifest.
    }
  }
  const quilt = entries['quilt.mod.json']
  if (quilt) {
    try {
      const raw = JSON.parse(quilt.toString('utf8')) as Record<string, unknown>
      const metadata = (raw.quilt_loader ?? {}) as Record<string, unknown>
      const meta = (metadata.metadata ?? {}) as Record<string, unknown>
      return { description: text(meta.description), authors: authorNames(meta.authors ?? metadata.authors) }
    } catch {
      // Same as above: presence of the file is enough for the core parser.
    }
  }
  for (const name of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    const toml = entries[name]
    if (!toml) continue
    const tables = parseTomlSubset(toml.toString('utf8'))
    const mod = tables.find((table) => table.path[0] === 'mods')
    const authors = tables
      .filter((table) => table.path[0] === 'authors')
      .map((table) => text(table.values.name))
      .filter(Boolean)
    return {
      description: text(mod?.values.description),
      authors: authors.join(', '),
    }
  }
  const legacy = entries['mcmod.info']
  if (legacy) {
    try {
      const parsed: unknown = JSON.parse(legacy.toString('utf8'))
      const first = Array.isArray(parsed) ? parsed[0] : parsed
      if (first && typeof first === 'object') {
        const raw = first as Record<string, unknown>
        return {
          description: text(raw.description),
          authors: authorNames(raw.authorList ?? raw.authors),
        }
      }
    } catch {
      // A legacy descriptor is optional; the filename fallback stays.
    }
  }
  return { description: '', authors: '' }
}

/**
 * Reads the metadata the upload/local-mod UI shows. Name, version and loader
 * come from the same parser the installer uses, so a jar is categorised once.
 */
export function inspectJarMetadata(jarPath: string): JarMetadata {
  const result: JarMetadata = {
    modName: null,
    modVersion: null,
    modLoader: null,
    mcVersion: null,
    iconBase64: null,
    description: '',
    authors: '',
  }
  try {
    const zip = new AdmZip(jarPath)
    const entries = zip.getEntries()
    const wanted: Record<string, Buffer> = {}
    for (const entry of entries) {
      if (METADATA_ENTRIES.includes(entry.entryName)) wanted[entry.entryName] = entry.getData()
    }

    const mod = parseModMetadata(wanted)
    if (mod) {
      result.modName = mod.name || null
      result.modVersion = mod.version || null
      result.modLoader = mod.loader === 'unknown' ? null : mod.loader
    }
    const { description, authors } = presentation(wanted)
    result.description = description
    result.authors = authors

    if (entries.some((entry) => entry.entryName === 'fabric.mod.json')) {
      try {
        const raw = JSON.parse(wanted['fabric.mod.json']?.toString('utf8') ?? '{}') as Record<string, unknown>
        const icon = text(raw.icon)
        const iconEntry = icon ? entries.find((entry) => entry.entryName === icon) : undefined
        if (iconEntry) result.iconBase64 = `data:image/png;base64,${iconEntry.getData().toString('base64')}`
      } catch {
        // The core parser owns the manifest error; the icon stays absent.
      }
    }
    if (!result.iconBase64) {
      for (const icon of ICON_ENTRIES) {
        const iconEntry = entries.find((entry) => entry.entryName === icon)
        if (iconEntry) {
          result.iconBase64 = `data:image/png;base64,${iconEntry.getData().toString('base64')}`
          break
        }
      }
    }
  } catch (error) {
    getDefaultLogger().child('mods:jar-inspect').debug('jar metadata unreadable', {
      jarPath,
      error: describeError(error),
    })
  }
  return result
}
