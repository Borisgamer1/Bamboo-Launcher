import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareMavenVersions } from '../version/libraries'
import { describeError, getDefaultLogger } from '../logger'
import { LoaderError } from './errors'
import { fetchJson, fetchText, type LoaderHttpContext } from './http'
import type { LoaderKind, LoaderVersionEntry, LoaderVersionList } from './types'

export const DEFAULT_FABRIC_META = 'https://meta.fabricmc.net'
export const DEFAULT_QUILT_META = 'https://meta.quiltmc.org'
export const DEFAULT_FORGE_MAVEN = 'https://maven.minecraftforge.net'
export const DEFAULT_NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases'
export const DEFAULT_NEOFORGE_API = 'https://maven.neoforged.net/api/maven/versions/releases'
export const DEFAULT_OPTIFINE_MIRROR = 'https://bmclapi2.bangbang93.com'
export const DEFAULT_FORGE_SITE = 'https://files.minecraftforge.net'
export const DEFAULT_BMCL_API = 'https://bmclapi2.bangbang93.com'

export interface LoaderMetadataOptions extends LoaderHttpContext {
  minecraftVersion?: string
  metaBase?: string
  mavenBase?: string
  neoforgeMaven?: string
  optifineMirror?: string
  cacheDir?: string
  maxAgeMs?: number
  logger?: { warn(message: string, data?: unknown): void; debug(message: string, data?: unknown): void }
}

interface FabricEntry {
  loader?: { version?: string; stable?: boolean; maven?: string }
}

export function parseForgeIndexHtml(html: string, minecraftVersion: string): LoaderVersionEntry[] {
  const pattern = new RegExp(
    `forge-${minecraftVersion.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-([0-9][0-9A-Za-z._-]*?)-installer\\.jar`,
    'g',
  )
  const versions: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const version = match[1]
    if (seen.has(version)) continue
    seen.add(version)
    versions.push(version)
  }
  return versions.map((version) => ({
    version,
    stable: !/beta|alpha|pre/i.test(version),
    installerUrl: `${DEFAULT_FORGE_MAVEN}/net/minecraftforge/forge/${minecraftVersion}-${version}/forge-${minecraftVersion}-${version}-installer.jar`,
  }))
}

export function parseForgeMirrorList(value: unknown, minecraftVersion: string): LoaderVersionEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((version) => ({
      version,
      stable: !/beta|alpha|pre/i.test(version),
      installerUrl: `${DEFAULT_FORGE_MAVEN}/net/minecraftforge/forge/${minecraftVersion}-${version}/forge-${minecraftVersion}-${version}-installer.jar`,
    }))
}

export function parseNeoForgeList(value: unknown, minecraftVersion: string): LoaderVersionEntry[] {
  const versions =
    value && typeof value === 'object' && Array.isArray((value as { versions?: unknown }).versions)
      ? ((value as { versions: unknown[] }).versions.filter((entry): entry is string => typeof entry === 'string'))
      : []
  const project = neoforgeProject(minecraftVersion)
  const prefix = project === 'forge' ? `${minecraftVersion}-` : `${minecraftVersion.replace(/^1\./, '')}.`
  return versions
    .filter((version) => version.startsWith(prefix))
    .sort(compareMavenVersions)
    .map((version) => ({ version, stable: !/beta|alpha|pre/i.test(version) }))
}

export function neoforgeProject(minecraftVersion: string): 'forge' | 'neoforge' {
  return minecraftVersion === '1.20.1' ? 'forge' : 'neoforge'
}

export function neoforgeInstallerUrl(
  minecraftVersion: string,
  loaderVersion: string,
  mavenBase = DEFAULT_NEOFORGE_MAVEN,
): string {
  const project = neoforgeProject(minecraftVersion)
  return `${mavenBase}/net/neoforged/${project}/${loaderVersion}/${project}-${loaderVersion}-installer.jar`
}

export function forgeArtifactVersion(minecraftVersion: string, loaderVersion: string): string {
  return loaderVersion.startsWith(`${minecraftVersion}-`)
    ? loaderVersion
    : `${minecraftVersion}-${loaderVersion}`
}

export function forgeInstallerUrl(
  minecraftVersion: string,
  loaderVersion: string,
  mavenBase = DEFAULT_FORGE_MAVEN,
): string {
  const artifact = forgeArtifactVersion(minecraftVersion, loaderVersion)
  return `${mavenBase}/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`
}

export function pickLoaderVersion(
  entries: LoaderVersionEntry[],
  requested?: string,
): LoaderVersionEntry | undefined {
  if (entries.length === 0) return undefined
  if (requested) {
    const exact = entries.find((entry) => entry.version === requested)
    if (!exact) return undefined
    return exact
  }
  const stable = entries.find((entry) => entry.stable !== false)
  return stable ?? entries[0]
}

async function cachePath(options: LoaderMetadataOptions, loader: LoaderKind, mc: string): Promise<string | undefined> {
  if (!options.cacheDir) return undefined
  await mkdir(options.cacheDir, { recursive: true }).catch(() => undefined)
  return join(options.cacheDir, `loader-versions-${loader}-${mc}.json`)
}

async function readCache(
  file: string | undefined,
  maxAgeMs: number,
): Promise<LoaderVersionEntry[] | undefined> {
  if (!file) return undefined
  try {
    const info = await stat(file)
    if (Date.now() - info.mtimeMs > maxAgeMs) return undefined
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { versions?: unknown }
    if (!Array.isArray(parsed.versions)) return undefined
    return parsed.versions.filter(
      (entry): entry is LoaderVersionEntry =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as LoaderVersionEntry).version === 'string',
    )
  } catch (error) {
    getDefaultLogger().child('loaders:metadata').debug('version cache unreadable; fetching fresh data', {
      file,
      error: describeError(error),
    })
    return undefined
  }
}

async function writeCache(file: string | undefined, versions: LoaderVersionEntry[]): Promise<void> {
  if (!file) return
  await writeFile(file, JSON.stringify({ versions }), 'utf8').catch(() => undefined)
}

async function loadFabricLike(
  loader: 'fabric' | 'quilt',
  minecraftVersion: string,
  options: LoaderMetadataOptions,
): Promise<{ versions: LoaderVersionEntry[]; source: LoaderVersionList['source'] }> {
  const metaBase = options.metaBase ?? (loader === 'fabric' ? DEFAULT_FABRIC_META : DEFAULT_QUILT_META)
  const path = loader === 'fabric'
    ? `/v2/versions/loader/${minecraftVersion}`
    : `/v3/versions/loader/${minecraftVersion}`
  const file = await cachePath(options, loader, minecraftVersion)
  const cached = await readCache(file, options.maxAgeMs ?? 6 * 60 * 60 * 1000)
  if (cached && cached.length > 0) return { versions: cached, source: 'cache' }
  const body = await fetchJson<FabricEntry[]>(`${metaBase}${path}`, options)
  if (!Array.isArray(body)) {
    throw new LoaderError('metadata', `Unerwartete ${loader}-Antwort für ${minecraftVersion}`)
  }
  const versions: LoaderVersionEntry[] = []
  for (const entry of body) {
    const version = entry?.loader?.version
    if (typeof version !== 'string' || version.length === 0) continue
    versions.push({
      version,
      stable: entry.loader?.stable !== false && !/beta|alpha|pre/i.test(version),
    })
  }
  if (versions.length === 0) {
    throw new LoaderError('version-not-found', `${loader}-Loader für Minecraft ${minecraftVersion} nicht gefunden`)
  }
  await writeCache(file, versions)
  return { versions, source: 'network' }
}

async function loadForge(
  minecraftVersion: string,
  options: LoaderMetadataOptions,
): Promise<{ versions: LoaderVersionEntry[]; source: LoaderVersionList['source'] }> {
  const file = await cachePath(options, 'forge', minecraftVersion)
  const cached = await readCache(file, options.maxAgeMs ?? 6 * 60 * 60 * 1000)
  if (cached && cached.length > 0) return { versions: cached, source: 'cache' }
  let versions: LoaderVersionEntry[] = []
  let source: LoaderVersionList['source'] = 'network'
  try {
    const html = await fetchText(
      `${DEFAULT_FORGE_SITE}/net/minecraftforge/forge/index_${minecraftVersion}.html`,
      options,
    )
    versions = parseForgeIndexHtml(html, minecraftVersion)
  } catch (error) {
    options.logger?.warn('Forge-Indexseite nicht lesbar, nutze Mirror', {
      error: (error as Error).message,
    })
  }
  if (versions.length === 0) {
    const mirror = await fetchJson<unknown>(
      `${options.optifineMirror ?? DEFAULT_BMCL_API}/forge/minecraft/${minecraftVersion}`,
      options,
    )
    versions = parseForgeMirrorList(mirror, minecraftVersion)
    source = 'mirror'
  }
  if (versions.length === 0) {
    throw new LoaderError('version-not-found', `Forge für Minecraft ${minecraftVersion} nicht gefunden`)
  }
  await writeCache(file, versions)
  return { versions, source }
}

async function loadNeoForge(
  minecraftVersion: string,
  options: LoaderMetadataOptions,
): Promise<{ versions: LoaderVersionEntry[]; source: LoaderVersionList['source'] }> {
  const project = neoforgeProject(minecraftVersion)
  const file = await cachePath(options, 'neoforge', minecraftVersion)
  const cached = await readCache(file, options.maxAgeMs ?? 6 * 60 * 60 * 1000)
  if (cached && cached.length > 0) return { versions: cached, source: 'cache' }
  const api = options.neoforgeMaven ?? DEFAULT_NEOFORGE_API
  const body = await fetchJson<unknown>(`${api}/net/neoforged/${project}`, options)
  const versions = parseNeoForgeList(body, minecraftVersion)
  if (versions.length === 0) {
    throw new LoaderError('version-not-found', `NeoForge für Minecraft ${minecraftVersion} nicht gefunden`)
  }
  await writeCache(file, versions)
  return { versions, source: 'network' }
}

interface OptifineEntry {
  mcversion?: string
  patch?: string
  type?: string
  filename?: string
}

export function parseOptifineList(value: unknown, minecraftVersion: string): LoaderVersionEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (entry): entry is OptifineEntry =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        (entry as OptifineEntry).mcversion === minecraftVersion &&
        typeof (entry as OptifineEntry).type === 'string' &&
        typeof (entry as OptifineEntry).patch === 'string',
    )
    .map((entry) => ({
      version: `${entry.type}_${entry.patch}`,
      stable: !/pre|beta|alpha/i.test(entry.patch ?? ''),
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.patch ? { patch: entry.patch } : {}),
      ...(entry.filename ? { filename: entry.filename } : {}),
    }))
}

export function optifineInstallerUrl(
  minecraftVersion: string,
  entry: Pick<LoaderVersionEntry, 'type' | 'patch'>,
  mirror = DEFAULT_OPTIFINE_MIRROR,
): string {
  if (!entry.type || !entry.patch) {
    throw new LoaderError('metadata', 'OptiFine-Eintrag ohne Typ/Patch')
  }
  return `${mirror}/optifine/${minecraftVersion}/${entry.type}/${entry.patch}`
}

async function loadOptifine(
  minecraftVersion: string,
  options: LoaderMetadataOptions,
): Promise<{ versions: LoaderVersionEntry[]; source: LoaderVersionList['source'] }> {
  const file = await cachePath(options, 'optifine', minecraftVersion)
  const cached = await readCache(file, options.maxAgeMs ?? 6 * 60 * 60 * 1000)
  if (cached && cached.length > 0) return { versions: cached, source: 'cache' }
  const mirror = options.optifineMirror ?? DEFAULT_OPTIFINE_MIRROR
  const body = await fetchJson<unknown>(`${mirror}/optifine/versionList`, options)
  const versions = parseOptifineList(body, minecraftVersion)
  if (versions.length === 0) {
    throw new LoaderError('version-not-found', `OptiFine für Minecraft ${minecraftVersion} nicht gefunden`)
  }
  await writeCache(file, versions)
  return { versions, source: 'network' }
}

export async function listLoaderVersions(
  loader: LoaderKind,
  options: LoaderMetadataOptions,
): Promise<LoaderVersionList> {
  const base = loader === 'forge-legacy' ? 'forge' : loader
  if (base === 'fabric' || base === 'quilt') {
    const { versions, source } = await loadFabricLike(base, options.minecraftVersion ?? '', options)
    return { loader, versions, source, ...(options.minecraftVersion ? { minecraftVersion: options.minecraftVersion } : {}) }
  }
  if (!options.minecraftVersion) {
    throw new LoaderError('invalid', `minecraftVersion ist für ${loader} erforderlich`)
  }
  const { versions, source } =
    base === 'forge'
      ? await loadForge(options.minecraftVersion, options)
      : base === 'neoforge'
        ? await loadNeoForge(options.minecraftVersion, options)
        : await loadOptifine(options.minecraftVersion, options)
  return { loader, versions, source, minecraftVersion: options.minecraftVersion }
}

export async function resolveLoaderVersion(
  loader: LoaderKind,
  options: LoaderMetadataOptions & { requested?: string },
): Promise<LoaderVersionEntry> {
  const list = await listLoaderVersions(loader, options)
  const picked = pickLoaderVersion(list.versions, options.requested)
  if (!picked) {
    throw new LoaderError(
      'version-not-found',
      `${loader} ${options.requested ?? '(neueste)'} ist für Minecraft ${options.minecraftVersion ?? '?'} nicht verfügbar`,
      { loader },
    )
  }
  return picked
}

export { fetchText as fetchLoaderText }
