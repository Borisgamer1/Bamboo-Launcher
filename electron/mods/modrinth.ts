import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { downloadBuffer, requestText, type FetchLike, type RetryOptions } from '../download/http'
import { hashBuffer } from '../download/checksum'
import { streamToFile, TRANSFER_STAGE } from '../download/stream'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { isVersionCompatible } from './compatibility'
import { ModError } from './errors'
import { MODRINTH_LOADER_NAMES } from './loaders'
import { modsMetrics, type ModMetrics } from './metrics'
import type { ModLoader, ProviderProject, ProviderVersion } from './types'

const DEFAULT_BASE = 'https://api.modrinth.com/v2'
const DEFAULT_USER_AGENT = 'BambooLauncher/0.1 (bamboo-launcher)'

export interface ModrinthClientOptions {
  baseUrl?: string
  userAgent?: string
  fetchImpl?: FetchLike
  retry?: RetryOptions
  logger?: Logger
  metrics?: ModMetrics
}

export interface ModrinthSearchHit {
  projectId: string
  slug: string
  title: string
  description: string
  iconUrl?: string
  versions: string[]
  projectType?: string
  author?: string
  categories?: string[]
  downloads?: number
  follows?: number
}

export interface ModrinthSearchPage {
  hits: ModrinthSearchHit[]
  offset: number
  limit: number
  total: number
}

interface RawVersion {
  id?: string
  project_id?: string
  name?: string
  version_number?: string
  version_type?: string
  date_published?: string
  game_versions?: string[]
  loaders?: string[]
  files?: Array<{
    url?: string
    filename?: string
    size?: number
    hashes?: Record<string, string>
    primary?: boolean
  }>
  dependencies?: Array<{
    project_id?: string
    version_id?: string
    file_name?: string
    dependency_type?: string
  }>
}

function normalizeVersion(raw: RawVersion): ProviderVersion | undefined {
  if (!raw.id || !raw.project_id) return undefined
  const files = (raw.files ?? [])
    .filter((file) => file.url && file.filename)
    .map((file) => ({
      url: String(file.url),
      filename: String(file.filename),
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.hashes ? { hashes: file.hashes } : {}),
      ...(file.primary !== undefined ? { primary: file.primary } : {}),
    }))
  if (files.length === 0) return undefined
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name ?? raw.version_number ?? raw.id,
    versionNumber: raw.version_number ?? '',
    gameVersions: raw.game_versions ?? [],
    loaders: raw.loaders ?? [],
    publishedAt: raw.date_published,
    channel:
      raw.version_type === 'beta' ? 'beta' : raw.version_type === 'alpha' ? 'alpha' : 'release',
    files,
    dependencies: (raw.dependencies ?? []).map((dependency) => ({
      ...(dependency.project_id ? { projectId: dependency.project_id } : {}),
      ...(dependency.version_id ? { versionId: dependency.version_id } : {}),
      ...(dependency.file_name ? { fileName: dependency.file_name } : {}),
      type:
        dependency.dependency_type === 'required' ||
        dependency.dependency_type === 'incompatible' ||
        dependency.dependency_type === 'embedded'
          ? dependency.dependency_type
          : 'optional',
    })),
  }
}

export function pickModrinthVersion(
  versions: ProviderVersion[],
  target: { minecraftVersion: string; loader?: ModLoader },
): ProviderVersion | undefined {
  if (!target.minecraftVersion) return undefined
  const loaderName = target.loader ? MODRINTH_LOADER_NAMES[target.loader] : undefined
  return versions.find((version) =>
    isVersionCompatible(version, {
      minecraftVersion: target.minecraftVersion,
      ...(loaderName ? { acceptedLoaders: [loaderName] } : {}),
    }),
  )
}

/** A response list is either a list or a malformed answer — never a raw TypeError. */
function asArray<T>(value: unknown, what: string): T[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ModError('provider-error', `Modrinth returned ${what} that is not a list`)
  }
  return value as T[]
}

export class ModrinthClient {
  readonly #base: string
  readonly #headers: Record<string, string>
  readonly #fetch?: FetchLike
  readonly #retry?: RetryOptions
  readonly #logger?: Logger
  readonly #metrics?: ModMetrics

  constructor(options: ModrinthClientOptions = {}) {
    this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    this.#headers = {
      'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
      accept: 'application/json',
    }
    this.#fetch = options.fetchImpl
    this.#retry = options.retry
    this.#logger = options.logger
    this.#metrics = options.metrics ?? modsMetrics
  }

  async #json<T>(
    pathname: string,
    query?: Record<string, string>,
    init?: { method: string; body: string },
  ): Promise<T> {
    this.#metrics?.request()
    const url = new URL(`${this.#base}${pathname}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    const response = await requestText({
      urls: [url.toString()],
      headers: {
        ...this.#headers,
        ...(init ? { 'content-type': 'application/json' } : {}),
      },
      ...(init ? { method: init.method, body: init.body } : {}),
      ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      ...(this.#retry ? { retry: this.#retry } : {}),
    })
    try {
      return JSON.parse(response.text) as T
    } catch (error) {
      // A hostile or broken response has to arrive as the provider's own error
      // class, so callers can classify it instead of seeing a bare SyntaxError.
      throw new ModError(
        'provider-error',
        `Modrinth returned invalid JSON for ${pathname}: ${(error as Error).message}`,
      )
    }
  }

  async search(query: string, options: { limit?: number; facets?: string[] } = {}): Promise<ModrinthSearchHit[]> {
    const page = await this.searchPage(query, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.facets?.length ? { facets: options.facets.map((facet) => [facet]) } : {}),
    })
    return page.hits
  }

  async searchPage(
    query: string,
    options: {
      limit?: number
      offset?: number
      index?: string
      facets?: string[][]
    } = {},
  ): Promise<ModrinthSearchPage> {
    const facets = options.facets?.filter((group) => group.length > 0)
    const body = await this.#json<{
      hits?: Array<Record<string, unknown>>
      total_hits?: number
      offset?: number
      limit?: number
    }>('/search', {
      query,
      limit: String(Math.min(100, Math.max(1, options.limit ?? 10))),
      ...(options.offset !== undefined ? { offset: String(Math.max(0, options.offset)) } : {}),
      ...(options.index ? { index: options.index } : {}),
      ...(facets?.length ? { facets: JSON.stringify(facets) } : {}),
    })
    const hits = asArray<Record<string, unknown>>(body.hits, 'search hits').map((hit) => ({
      projectId: String(hit.project_id ?? ''),
      slug: String(hit.slug ?? ''),
      title: String(hit.title ?? ''),
      description: String(hit.description ?? ''),
      ...(typeof hit.icon_url === 'string' ? { iconUrl: hit.icon_url } : {}),
      versions: Array.isArray(hit.versions) ? hit.versions.map(String) : [],
      ...(typeof hit.project_type === 'string' ? { projectType: hit.project_type } : {}),
      ...(typeof hit.author === 'string' ? { author: hit.author } : {}),
      ...(Array.isArray(hit.categories)
        ? { categories: hit.categories.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(typeof hit.downloads === 'number' ? { downloads: hit.downloads } : {}),
      ...(typeof hit.follows === 'number' ? { follows: hit.follows } : {}),
    }))
    return {
      hits,
      offset: typeof body.offset === 'number' ? body.offset : (options.offset ?? 0),
      limit: typeof body.limit === 'number' ? body.limit : (options.limit ?? 10),
      total: typeof body.total_hits === 'number' ? body.total_hits : hits.length,
    }
  }

  async project(idOrSlug: string): Promise<ProviderProject> {
    const raw = await this.#json<Record<string, unknown>>(`/project/${encodeURIComponent(idOrSlug)}`)
    return {
      id: String(raw.id ?? ''),
      slug: String(raw.slug ?? ''),
      title: String(raw.title ?? ''),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.project_type === 'string' ? { projectType: raw.project_type } : {}),
      ...(Array.isArray(raw.loaders) ? { loaders: raw.loaders.map(String) } : {}),
      ...(Array.isArray(raw.game_versions) ? { gameVersions: raw.game_versions.map(String) } : {}),
    }
  }

  async versions(
    idOrSlug: string,
    options: { minecraftVersion?: string; loader?: ModLoader } = {},
  ): Promise<ProviderVersion[]> {
    const loaderName = options.loader ? MODRINTH_LOADER_NAMES[options.loader] : undefined
    const raw = await this.#json<RawVersion[]>(
      `/project/${encodeURIComponent(idOrSlug)}/version`,
      {
        ...(options.minecraftVersion
          ? { game_versions: JSON.stringify([options.minecraftVersion]) }
          : {}),
        ...(loaderName ? { loaders: JSON.stringify([loaderName]) } : {}),
      },
    )
    return asArray<RawVersion>(raw, 'versions')
      .map(normalizeVersion)
      .filter((version): version is ProviderVersion => Boolean(version))
  }

  async versionFile(hash: string, algorithm: 'sha1' | 'sha512' = 'sha1'): Promise<ProviderVersion | undefined> {
    try {
      const raw = await this.#json<RawVersion | null>(
        `/version_file/${encodeURIComponent(hash)}`,
        { algorithm },
      )
      return raw ? normalizeVersion(raw) : undefined
    } catch (error) {
      if (error instanceof Error && this.#isMissing(error)) {
        this.#logger?.debug('Modrinth has no version for hash', { hash, algorithm })
        return undefined
      }
      throw error
    }
  }

  #isMissing(error: Error): boolean {
    const candidate = error as Error & { code?: string; status?: number }
    return candidate.code === 'http-error' && candidate.status === 404
  }

  /**
   * Downloads the exact file whose SHA-1 is given, from the Modrinth mirror.
   * The endpoint is a lookup, not a trust boundary: the transfer verifies the
   * hash again and leaves no destination behind on a mismatch.
   */
  async downloadFileByHash(
    hash: string,
    destination: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ bytes: number; skipped: boolean } | undefined> {
    const expected = hash.trim().toLowerCase()
    if (!expected) return undefined
    const version = await this.versionFile(expected)
    if (!version) return undefined
    const file = version.files.find((entry) => entry.hashes?.sha1?.toLowerCase() === expected)
    const url = file?.url
    if (!file || !url) return undefined

    const existing = await stat(destination).catch(() => undefined)
    if (existing?.isFile()) {
      const existingBuffer = await readFile(destination)
      this.#metrics?.hashBytes(existingBuffer.length)
      if (hashBuffer('sha1', existingBuffer).toLowerCase() === expected) {
        return { bytes: 0, skipped: true }
      }
    }

    const metrics = this.#metrics
    const transfer = () =>
      streamToFile({
        urls: [url],
        destination,
        headers: { 'user-agent': this.#headers['user-agent'] },
        ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
        ...(this.#retry ? { retry: this.#retry } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        expected: {
          sha1: expected,
          ...(file.size !== undefined ? { size: file.size } : {}),
        },
        ...(metrics ? { metrics } : {}),
      })
    const downloaded = metrics ? await metrics.measure(TRANSFER_STAGE, transfer) : await transfer()
    this.#logger?.info('Modrinth fallback downloaded', {
      hash: expected,
      project: version.projectId,
      version: version.versionNumber,
      file: destination,
      bytes: downloaded.bytes,
    })
    return { bytes: downloaded.bytes, skipped: false }
  }

  async version(id: string): Promise<ProviderVersion> {
    const raw = await this.#json<RawVersion>(`/version/${encodeURIComponent(id)}`)
    const version = normalizeVersion(raw)
    if (!version) throw new Error(`Modrinth version ${id} has no downloadable file`)
    return version
  }

  async versionsByHashes(
    hashes: string[],
    algorithm: 'sha1' | 'sha512' = 'sha1',
  ): Promise<Record<string, ProviderVersion>> {
    const unique = [
      ...new Set(hashes.map((hash) => hash.trim().toLowerCase()).filter(Boolean)),
    ]
    if (unique.length === 0) return {}
    const raw = await this.#json<Record<string, RawVersion | null>>(
      '/version_files',
      undefined,
      { method: 'POST', body: JSON.stringify({ hashes: unique, algorithm }) },
    )
    const result: Record<string, ProviderVersion> = {}
    for (const [hash, value] of Object.entries(raw ?? {})) {
      const version = value ? normalizeVersion(value) : undefined
      if (version) result[hash.toLowerCase()] = version
    }
    return result
  }

  async updateMany(
    hashes: string[],
    target: { minecraftVersion: string; loader?: ModLoader },
    versionTypes?: Array<'release' | 'beta' | 'alpha'>,
  ): Promise<Record<string, ProviderVersion>> {
    const loaderName = target.loader ? MODRINTH_LOADER_NAMES[target.loader] : undefined
    if (hashes.length === 0) return {}
    const raw = await this.#json<Record<string, RawVersion | RawVersion[] | null>>(
      '/version_files/update_many',
      undefined,
      {
        method: 'POST',
        body: JSON.stringify({
          hashes,
          algorithm: 'sha1',
          game_versions: [target.minecraftVersion],
          ...(loaderName ? { loaders: [loaderName] } : {}),
          ...(versionTypes?.length ? { version_types: versionTypes } : {}),
        }),
      },
    )
    const result: Record<string, ProviderVersion> = {}
    for (const [hash, value] of Object.entries(raw ?? {})) {
      const versions = (Array.isArray(value) ? value : value ? [value] : [])
        .map(normalizeVersion)
        .filter((version): version is ProviderVersion => Boolean(version))
        .sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))
      if (versions[0]) result[hash.toLowerCase()] = versions[0]
    }
    return result
  }

  async resolveVersion(
    idOrSlug: string,
    target: { minecraftVersion: string; loader?: ModLoader },
  ): Promise<ProviderVersion> {
    const versions = await this.versions(idOrSlug, target)
    const picked = pickModrinthVersion(versions, target)
    if (!picked) {
      throw new Error(
        `No Modrinth version of ${idOrSlug} for ${target.minecraftVersion}/${target.loader ?? 'any'}`,
      )
    }
    return picked
  }

  async downloadVersion(
    version: ProviderVersion,
    destination: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ bytes: number; skipped: boolean; file: string }> {
    const file = version.files.find((entry) => entry.primary) ?? version.files[0]
    if (!file) throw new Error(`Modrinth version ${version.id} has no file`)
    if (!file.url) throw new Error(`Modrinth version ${version.id} has no download URL`)
    const expectedSha512 = file.hashes?.sha512
    const expectedSha1 = file.hashes?.sha1
    const existing = await stat(destination).catch(() => undefined)
    if (existing?.isFile()) {
      const buffer = await readFile(destination)
      const matches =
        (expectedSha512 && hashBuffer('sha512', buffer).toLowerCase() === expectedSha512.toLowerCase()) ||
        (expectedSha1 && hashBuffer('sha1', buffer).toLowerCase() === expectedSha1.toLowerCase()) ||
        (!expectedSha512 && !expectedSha1 && file.size !== undefined && buffer.length === file.size)
      this.#metrics?.hashBytes(buffer.length)
      if (matches) return { bytes: 0, skipped: true, file: destination }
    }
    const metrics = this.#metrics
    const verified = Boolean(expectedSha512 ?? expectedSha1)
    const url = file.url
    const transfer = () =>
      downloadBuffer({
        urls: [url],
        headers: { 'user-agent': this.#headers['user-agent'] },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
        ...(this.#retry ? { retry: this.#retry } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(expectedSha512
          ? { checksum: { algorithm: 'sha512' as const, value: expectedSha512 } }
          : expectedSha1
            ? { checksum: { algorithm: 'sha1' as const, value: expectedSha1 } }
            : {}),
      })
    const downloaded = metrics ? await metrics.measure(TRANSFER_STAGE, transfer) : await transfer()
    metrics?.downloadBytes(downloaded.buffer.length)
    // Only the checksum path really hashes the body; without one nothing is hashed.
    if (verified) metrics?.hashBytes(downloaded.buffer.length)
    await mkdir(dirname(destination), { recursive: true })
    const temp = `${destination}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(temp, downloaded.buffer)
    try {
      await rename(temp, destination)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    this.#logger?.info('Mod downloaded', {
      project: version.projectId,
      version: version.versionNumber,
      file: destination,
      bytes: downloaded.buffer.length,
    })
    return { bytes: downloaded.buffer.length, skipped: false, file: destination }
  }
}

export function modrinthVersionIdFromCdnUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    getDefaultLogger().child('mods:modrinth').debug('version id lookup on unparsable URL', {
      error: describeError(error),
    })
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'cdn.modrinth.com' && host !== 'cdn-raw.modrinth.com') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'data' || parts[2] !== 'versions' || parts.length < 5) return undefined
  try {
    return decodeURIComponent(parts[3])
  } catch (error) {
    getDefaultLogger().child('mods:modrinth').debug('version id is not valid percent-encoding', {
      error: describeError(error),
    })
    return undefined
  }
}
