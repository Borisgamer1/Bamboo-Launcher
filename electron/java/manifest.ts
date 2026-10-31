import { componentsForMajor } from './metadata'
import { parseJavaMajorVersion } from './version'

export const JAVA_RUNTIME_MANIFEST_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'

export interface RuntimeDownload {
  url: string
  sha1?: string
  size?: number
}

export interface RuntimeComponentEntry {
  version?: { name?: string; released?: string }
  manifest?: RuntimeDownload
}

export type RuntimeManifest = Record<string, Record<string, RuntimeComponentEntry[]>>

export interface RuntimeManifestFileEntry {
  type?: 'file' | 'directory' | 'link'
  executable?: boolean
  downloads?: { raw?: RuntimeDownload; lzma?: RuntimeDownload }
}

export interface RuntimeFileManifest {
  files: Record<string, RuntimeManifestFileEntry>
}

export function parseRuntimeManifest(json: unknown): RuntimeManifest {
  if (!json || typeof json !== 'object') return {}
  const root = json as Record<string, unknown>
  const inner = root.manifest && typeof root.manifest === 'object' ? (root.manifest as Record<string, unknown>) : root
  const result: RuntimeManifest = {}
  for (const [platform, components] of Object.entries(inner)) {
    if (!components || typeof components !== 'object' || Array.isArray(components)) continue
    const entries: Record<string, RuntimeComponentEntry[]> = {}
    for (const [component, value] of Object.entries(components as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      entries[component] = value.filter((entry): entry is RuntimeComponentEntry => Boolean(entry) && typeof entry === 'object')
    }
    result[platform] = entries
  }
  return result
}

export function runtimePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') {
    if (arch === 'ia32') return 'windows-x86'
    if (arch === 'arm64') return 'windows-arm64'
    return 'windows-x64'
  }
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  if (platform === 'linux') return arch === 'ia32' ? 'linux-i386' : 'linux'
  return `${platform}-${arch}`
}

function runtimeMajor(entry: RuntimeComponentEntry): number | undefined {
  return parseJavaMajorVersion(entry.version?.name ?? '')
}

function sortEntries(entries: RuntimeComponentEntry[]): RuntimeComponentEntry[] {
  return [...entries].sort((a, b) =>
    (b.version?.name ?? '').localeCompare(a.version?.name ?? '', undefined, { numeric: true }),
  )
}

export interface ResolvedRuntime {
  component: string
  entry: RuntimeComponentEntry
}

export function resolveRuntimeComponent(
  manifest: RuntimeManifest,
  platform: string,
  requiredMajor: number,
  hint?: string,
): ResolvedRuntime | undefined {
  const platformEntries = manifest[platform]
  if (!platformEntries) return undefined

  const candidates = [...new Set([...(hint ? [hint] : []), ...componentsForMajor(requiredMajor)])]
  for (const component of candidates) {
    const entries = (platformEntries[component] ?? []).filter((entry) => runtimeMajor(entry) === requiredMajor)
    if (entries.length > 0) return { component, entry: sortEntries(entries)[0] }
  }

  for (const [component, entries] of Object.entries(platformEntries)) {
    const matching = entries.filter((entry) => runtimeMajor(entry) === requiredMajor)
    if (matching.length > 0) return { component, entry: sortEntries(matching)[0] }
  }
  return undefined
}
