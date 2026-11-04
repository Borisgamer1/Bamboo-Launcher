import { readFile, stat } from 'node:fs/promises'
import { hashBuffer } from '../download/checksum'
import { DownloadError, type FetchLike } from '../download/http'
import { LAUNCHER_VERSION } from '../launch/args'
import { streamToFile, TRANSFER_STAGE } from '../download/stream'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { ModError } from './errors'
import { CURSEFORGE_LOADER_IDS } from './loaders'
import { modsMetrics, type ModMetrics } from './metrics'
import type { ModLoader } from './types'

const DEFAULT_BASE = 'https://api.curseforge.com/v1'
const RELATION_REQUIRED = 3

/** The search endpoint reaches at most this many results (`index + pageSize`). */
export const CURSEFORGE_SEARCH_LIMIT = 10_000

/** A response list is either a list or a malformed answer — never a raw TypeError. */
function asArray<T>(value: unknown, what: string): T[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ModError('provider-error', `CurseForge returned ${what} that is not a list`)
  }
  return value as T[]
}

const CURSEFORGE_CDN_HOSTS = new Set([
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  'media.forgecdn.net',
])

function isCurseForgeCdnHost(rawUrl: string): boolean {
  try {
    return CURSEFORGE_CDN_HOSTS.has(new URL(rawUrl).hostname.toLowerCase())
  } catch (error) {
    getDefaultLogger().child('mods:curseforge').debug('CDN host check on unparsable URL', {
      error: describeError(error),
    })
    return false
  }
}

const MAX_CDN_REDIRECTS = 5

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export interface CurseForgeClientOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: FetchLike
  logger?: Logger
  sleep?: (ms: number) => Promise<void>
  rateLimitRetries?: number
  cdnBase?: string
  metrics?: ModMetrics
}

export interface CurseForgeFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  fileLength: number
  downloadUrl: string | null
  gameVersions: string[]
  hashes: Array<{ value: string; algo: number }>
  dependencies: Array<{ modId: number; relationType: number }>
  releaseType: number
  fileDate: string
}

export interface CurseForgeLatestFileIndex {
  gameVersion: string
  fileId: number
  filename: string
  releaseType: number
  gameVersionTypeId?: number
  modLoader?: number
}

export interface CurseForgeSearchHit {
  id: number
  name: string
  slug: string
  summary: string
  classId?: number
  downloadCount?: number
  iconUrl?: string
  author?: string
  categories?: string[]
  latestFilesIndexes: CurseForgeLatestFileIndex[]
  allowModDistribution?: boolean
}

export interface CurseForgeSearchQuery {
  gameId?: number
  classId?: number
  categoryId?: number
  gameVersion?: string
  gameVersions?: string[]
  modLoaderType?: number
  modLoaderTypes?: number[]
  gameVersionTypeId?: number
  searchFilter?: string
  slug?: string
  sortField?: number
  sortOrder?: 'asc' | 'desc'
  index?: number
  pageSize?: number
}

export interface CurseForgeSearchPage {
  hits: CurseForgeSearchHit[]
  index: number
  pageSize: number
  resultCount: number
  totalCount: number
}

export interface CurseForgeFilePage {
  files: CurseForgeFile[]
  index: number
  pageSize: number
  totalCount: number
}

export const CURSEFORGE_MINECRAFT_GAME_ID = 432

/** One exact fingerprint match: a candidate, not proof of identity. */
export interface CurseForgeFingerprintMatch {
  fingerprint: number
  fileId: number
  modId: number
  fileName: string
  fileDate?: string
}

/**
 * The outcome of the download chain: a URL together with the route it came from,
 * `blocked` when the author forbids third-party distribution and no
 * author-sanctioned URL exists, or `undefined` when nothing is obtainable.
 */
export type CurseForgeDownloadResolution =
  | { url: string; source: 'metadata' | 'endpoint' | 'cdn' }
  | { blocked: true }
  | undefined

export interface CurseForgeFingerprintResult {
  /** False while the service was still building its fingerprint index. */
  cacheBuilt: boolean
  matches: CurseForgeFingerprintMatch[]
  unmatched: number[]
}

export interface CurseForgeMod {
  id: number
  name: string
  slug: string
  summary: string
  classId?: number
  downloadCount?: number
  iconUrl?: string
  author?: string
  categories?: string[]
  allowModDistribution?: boolean
  latestFilesIndexes?: CurseForgeLatestFileIndex[]
}

function projectMeta(raw: Record<string, unknown>): Pick<
  CurseForgeMod,
  'iconUrl' | 'author' | 'categories'
> {
  const logo = raw.logo && typeof raw.logo === 'object' ? (raw.logo as Record<string, unknown>) : {}
  const authors = Array.isArray(raw.authors) ? raw.authors : []
  const author = authors[0] && typeof authors[0] === 'object'
    ? String((authors[0] as Record<string, unknown>).name ?? '')
    : ''
  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .map((entry) =>
          entry && typeof entry === 'object'
            ? String((entry as Record<string, unknown>).name ?? '')
            : '',
        )
        .filter(Boolean)
    : []
  return {
    ...(typeof logo.url === 'string' ? { iconUrl: logo.url } : {}),
    ...(author ? { author } : {}),
    ...(categories.length ? { categories } : {}),
  }
}

function normalizeFile(raw: Record<string, unknown>): CurseForgeFile {
  return {
    id: Number(raw.id ?? 0),
    modId: Number(raw.modId ?? 0),
    displayName: String(raw.displayName ?? ''),
    fileName: String(raw.fileName ?? ''),
    fileLength: Number(raw.fileLength ?? 0),
    downloadUrl: typeof raw.downloadUrl === 'string' && raw.downloadUrl ? raw.downloadUrl : null,
    gameVersions: Array.isArray(raw.gameVersions) ? raw.gameVersions.map(String) : [],
    hashes: Array.isArray(raw.hashes)
      ? raw.hashes.map((entry) => ({
          value: String((entry as Record<string, unknown>).value ?? ''),
          algo: Number((entry as Record<string, unknown>).algo ?? 0),
        }))
      : [],
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map((entry) => ({
          modId: Number((entry as Record<string, unknown>).modId ?? 0),
          relationType: Number((entry as Record<string, unknown>).relationType ?? 0),
        }))
      : [],
    releaseType: Number(raw.releaseType ?? 0),
    fileDate: String(raw.fileDate ?? ''),
  }
}

function normalizeIndexes(raw: unknown): CurseForgeLatestFileIndex[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      gameVersion: String(entry.gameVersion ?? ''),
      fileId: Number(entry.fileId ?? 0),
      filename: String(entry.filename ?? ''),
      releaseType: Number(entry.releaseType ?? 0),
      ...(typeof entry.gameVersionTypeId === 'number'
        ? { gameVersionTypeId: entry.gameVersionTypeId }
        : {}),
      ...(typeof entry.modLoader === 'number' ? { modLoader: entry.modLoader } : {}),
    }))
    .filter((entry) => entry.fileId > 0)
}

function normalizeMod(raw: Record<string, unknown>, fallbackId: number): CurseForgeMod {
  return {
    id: Number(raw.id ?? fallbackId),
    name: String(raw.name ?? ''),
    slug: String(raw.slug ?? ''),
    summary: String(raw.summary ?? ''),
    ...(typeof raw.classId === 'number' ? { classId: raw.classId } : {}),
    ...(typeof raw.downloadCount === 'number' ? { downloadCount: raw.downloadCount } : {}),
    ...projectMeta(raw),
    ...(typeof raw.allowModDistribution === 'boolean'
      ? { allowModDistribution: raw.allowModDistribution }
      : {}),
    latestFilesIndexes: normalizeIndexes(raw.latestFilesIndexes),
  }
}

function normalizeSearchHit(raw: Record<string, unknown>): CurseForgeSearchHit {
  const indexes = normalizeIndexes(raw.latestFilesIndexes)
  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ''),
    slug: String(raw.slug ?? ''),
    summary: String(raw.summary ?? ''),
    ...(typeof raw.classId === 'number' ? { classId: raw.classId } : {}),
    ...(typeof raw.downloadCount === 'number' ? { downloadCount: raw.downloadCount } : {}),
    ...projectMeta(raw),
    latestFilesIndexes: indexes,
    ...(typeof raw.allowModDistribution === 'boolean'
      ? { allowModDistribution: raw.allowModDistribution }
      : {}),
  }
}

export function requiredCurseForgeDependencies(file: CurseForgeFile): number[] {
  return file.dependencies
    .filter((dependency) => dependency.relationType === RELATION_REQUIRED)
    .map((dependency) => dependency.modId)
}

const DEFAULT_CDN_BASE = 'https://mediafilez.forgecdn.net/files'

export function curseForgeCdnUrl(
  file: Pick<CurseForgeFile, 'id' | 'fileName'>,
  cdnBase = DEFAULT_CDN_BASE,
): string | undefined {
  if (!Number.isInteger(file.id) || file.id <= 0 || !file.fileName) return undefined
  const digits = String(file.id).padStart(4, '0')
  const directory = digits.slice(0, -3)
  const name = encodeURIComponent(file.fileName).replace(/%2F/gi, '/')
  return `${cdnBase.replace(/\/$/, '')}/${directory}/${digits.slice(-3)}/${name}`
}

export function curseForgeFileIdFromUrl(raw: string): number | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    getDefaultLogger().child('mods:curseforge').debug('file id lookup on unparsable URL', {
      error: describeError(error),
    })
    return undefined
  }
  if (!CURSEFORGE_CDN_HOSTS.has(url.hostname.toLowerCase())) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'files' || parts.length < 4) return undefined
  if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return undefined
  const id = Number(parts[1]) * 1000 + Number(parts[2])
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export class CurseForgeClient {
  readonly #key: string
  readonly #base: string
  readonly #fetch?: FetchLike
  readonly #logger?: Logger
  readonly #sleep: (ms: number) => Promise<void>
  readonly #retries: number
  readonly #cdnBase: string
  readonly #metrics?: ModMetrics

  constructor(options: CurseForgeClientOptions) {
    if (!options.apiKey) {
      throw new ModError('missing-api-key', 'CurseForge requires an API key')
    }
    this.#key = options.apiKey
    this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    this.#fetch = options.fetchImpl
    this.#logger = options.logger
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#retries = Math.max(1, options.rateLimitRetries ?? 3)
    this.#cdnBase = options.cdnBase ?? DEFAULT_CDN_BASE
    this.#metrics = options.metrics ?? modsMetrics
  }

  async #json<T>(
    pathname: string,
    query: Record<string, string> = {},
    init?: { method: string; body: string },
  ): Promise<T> {
    this.#metrics?.request()
    const url = new URL(`${this.#base}${pathname}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const fetchImpl = this.#fetch ?? fetch
    let lastStatus = 0
    for (let attempt = 0; attempt < this.#retries; attempt += 1) {
      const response = await fetchImpl(url.toString(), {
        headers: {
          'x-api-key': this.#key,
          accept: 'application/json',
          'user-agent': `BambooLauncher/${LAUNCHER_VERSION}`,
          ...(init ? { 'content-type': 'application/json' } : {}),
        },
        ...(init ? { method: init.method, body: init.body } : {}),
        redirect: 'follow',
      })
      if (response.status === 429) {
        lastStatus = 429
        const retryAfter = Number(response.headers.get('retry-after') ?? '1')
        const delayMs = Math.min(60_000, Math.max(250, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000))
        await response.body?.cancel().catch(() => undefined)
        this.#logger?.warn('CurseForge rate limit hit; waiting', { delayMs, attempt: attempt + 1 })
        if (attempt + 1 < this.#retries) await this.#sleep(delayMs)
        continue
      }
      const transient = response.status === 401 || response.status === 403 || response.status >= 500
      if (transient && attempt + 1 < this.#retries) {
        lastStatus = response.status
        await response.body?.cancel().catch(() => undefined)
        this.#logger?.warn('CurseForge upstream rejected the request; retrying', {
          status: response.status,
          attempt: attempt + 1,
        })
        await this.#sleep(250 * (attempt + 1))
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new ModError('provider-error', `CurseForge HTTP ${response.status} for ${pathname}`, {
          status: response.status,
          pathname,
        })
      }
      try {
        return (await response.json()) as T
      } catch (error) {
        // Same contract as Modrinth: malformed bodies become provider errors.
        throw new ModError(
          'provider-error',
          `CurseForge returned invalid JSON for ${pathname}: ${(error as Error).message}`,
        )
      }
    }
    throw new ModError('provider-error', `CurseForge rate limit persisted for ${pathname}`, {
      status: lastStatus,
    })
  }

  async mod(id: number): Promise<CurseForgeMod> {
    const body = await this.#json<{ data?: Record<string, unknown> }>(`/mods/${id}`)
    return normalizeMod(body.data ?? {}, id)
  }

  async mods(ids: number[]): Promise<CurseForgeMod[]> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]
    if (unique.length === 0) return []
    const body = await this.#json<{ data?: Array<Record<string, unknown>> }>(
      '/mods',
      {},
      { method: 'POST', body: JSON.stringify({ modIds: unique }) },
    )
    return asArray<Record<string, unknown>>(body.data, 'mods').map((entry) => normalizeMod(entry, 0))
  }

  async file(modId: number, fileId: number): Promise<CurseForgeFile> {
    const body = await this.#json<{ data?: Record<string, unknown> }>(`/mods/${modId}/files/${fileId}`)
    return normalizeFile(body.data ?? {})
  }

  async filesByIds(fileIds: number[]): Promise<CurseForgeFile[]> {
    const ids = fileIds.filter((id) => Number.isInteger(id) && id > 0)
    if (ids.length === 0) return []
    const body = await this.#json<{ data?: Array<Record<string, unknown>> }>(
      '/mods/files',
      {},
      { method: 'POST', body: JSON.stringify({ fileIds: ids }) },
    )
    return asArray<Record<string, unknown>>(body.data, 'files').map(normalizeFile)
  }

  async files(
    modId: number,
    options: {
      gameVersion?: string
      loader?: ModLoader
      gameVersionTypeId?: number
      index?: number
      pageSize?: number
    } = {},
  ): Promise<CurseForgeFile[]> {
    return (await this.filesPage(modId, options)).files
  }

  async filesPage(
    modId: number,
    options: {
      gameVersion?: string
      loader?: ModLoader
      gameVersionTypeId?: number
      index?: number
      pageSize?: number
    } = {},
  ): Promise<CurseForgeFilePage> {
    const loaderId = options.loader ? CURSEFORGE_LOADER_IDS[options.loader] : undefined
    const index = Math.max(0, options.index ?? 0)
    const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20))
    const body = await this.#json<{
      data?: Array<Record<string, unknown>>
      pagination?: Record<string, unknown>
    }>(`/mods/${modId}/files`, {
      ...(options.gameVersion ? { gameVersion: options.gameVersion } : {}),
      ...(loaderId !== undefined ? { modLoaderType: String(loaderId) } : {}),
      ...(options.gameVersionTypeId !== undefined
        ? { gameVersionTypeId: String(options.gameVersionTypeId) }
        : {}),
      index: String(index),
      pageSize: String(pageSize),
    })
    const files = asArray<Record<string, unknown>>(body.data, 'files').map(normalizeFile)
    const pagination = body.pagination ?? {}
    return {
      files,
      index: typeof pagination.index === 'number' ? pagination.index : index,
      pageSize: typeof pagination.pageSize === 'number' ? pagination.pageSize : pageSize,
      totalCount:
        typeof pagination.totalCount === 'number' && pagination.totalCount >= 0
          ? pagination.totalCount
          : files.length,
    }
  }

  async search(query: CurseForgeSearchQuery): Promise<CurseForgeSearchPage> {
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20))
    const index = Math.max(0, query.index ?? 0)
    if (index + pageSize > CURSEFORGE_SEARCH_LIMIT) {
      throw new ModError(
        'pagination-limit',
        `CurseForge search reaches at most ${CURSEFORGE_SEARCH_LIMIT} results, so index ${index} ` +
          `with pageSize ${pageSize} cannot be served`,
        { index, pageSize, limit: CURSEFORGE_SEARCH_LIMIT },
      )
    }
    const gameVersions = query.gameVersions?.filter(Boolean).slice(0, 4) ?? []
    const loaderTypes = query.modLoaderTypes?.filter((id) => Number.isInteger(id)) ?? []
    const body = await this.#json<{
      data?: Array<Record<string, unknown>>
      pagination?: Record<string, unknown>
    }>('/mods/search', {
      gameId: String(query.gameId ?? CURSEFORGE_MINECRAFT_GAME_ID),
      ...(query.classId !== undefined ? { classId: String(query.classId) } : {}),
      ...(query.categoryId !== undefined ? { categoryId: String(query.categoryId) } : {}),
      ...(query.gameVersion ? { gameVersion: query.gameVersion } : {}),
      ...(gameVersions.length > 0 ? { gameVersions: gameVersions.join(',') } : {}),
      ...(query.modLoaderType !== undefined
        ? { modLoaderType: String(query.modLoaderType) }
        : {}),
      ...(loaderTypes.length > 0 ? { modLoaderTypes: loaderTypes.join(',') } : {}),
      ...(query.gameVersionTypeId !== undefined
        ? { gameVersionTypeId: String(query.gameVersionTypeId) }
        : {}),
      ...(query.searchFilter ? { searchFilter: query.searchFilter } : {}),
      ...(query.slug ? { slug: query.slug } : {}),
      ...(query.sortField !== undefined ? { sortField: String(query.sortField) } : {}),
      ...(query.sortOrder ? { sortOrder: query.sortOrder } : {}),
      index: String(index),
      pageSize: String(pageSize),
    })
    const pagination = body.pagination ?? {}
    const data = asArray<Record<string, unknown>>(body.data, 'search results')
    return {
      // More hits than the requested page are never materialised.
      hits: data.slice(0, pageSize).map(normalizeSearchHit),
      index: typeof pagination.index === 'number' ? pagination.index : index,
      pageSize: typeof pagination.pageSize === 'number' ? pagination.pageSize : pageSize,
      resultCount:
        typeof pagination.resultCount === 'number'
          ? pagination.resultCount
          : (body.data ?? []).length,
      totalCount: typeof pagination.totalCount === 'number' ? pagination.totalCount : 0,
    }
  }

  /**
   * `GET /mods/{modId}/files/{fileId}/download-url`. Returns undefined when
   * CurseForge withholds the URL (403/404), so the caller — which knows the
   * project's distribution policy — decides about a CDN fallback. Deliberately
   * not cached: the API documents no lifetime for these URLs.
   */
  async downloadUrl(modId: number, fileId: number): Promise<string | undefined> {
    try {
      const body = await this.#json<{ data?: string }>(
        `/mods/${modId}/files/${fileId}/download-url`,
      )
      return body.data || undefined
    } catch (error) {
      const status = (error as { details?: { status?: number } }).details?.status
      if (status !== 403 && status !== 404) throw error
      this.#logger?.warn('CurseForge withheld the download URL', { modId, fileId, status })
      return undefined
    }
  }

  /**
   * `POST /fingerprints`: Murmur2 candidates for files the caller cannot identify
   * any other way. Only exact matches are reported; the fuzzy folder variant is
   * not used. A match is a candidate and must be confirmed by name/size before
   * anything is installed from it.
   */
  async fingerprintMatches(
    fingerprints: number[],
    gameId?: number,
  ): Promise<CurseForgeFingerprintResult> {
    const values = [
      ...new Set(fingerprints.filter((value) => Number.isSafeInteger(value) && value > 0)),
    ]
    if (values.length === 0) return { cacheBuilt: true, matches: [], unmatched: [] }
    const body = await this.#json<{ data?: Record<string, unknown> }>(
      gameId !== undefined ? `/fingerprints/${gameId}` : '/fingerprints',
      {},
      { method: 'POST', body: JSON.stringify({ fingerprints: values }) },
    )
    const data = body.data ?? {}
    const matches: CurseForgeFingerprintMatch[] = []
    for (const entry of Array.isArray(data.exactMatches) ? data.exactMatches : []) {
      if (!entry || typeof entry !== 'object') continue
      const raw = entry as Record<string, unknown>
      const fingerprint = Number(raw.id ?? 0)
      const file =
        raw.file && typeof raw.file === 'object' ? (raw.file as Record<string, unknown>) : undefined
      if (!file) continue
      const fileId = Number(file.id ?? 0)
      if (!Number.isSafeInteger(fingerprint) || !Number.isSafeInteger(fileId) || fileId <= 0) {
        continue
      }
      matches.push({
        fingerprint,
        fileId,
        modId: Number(file.modId ?? 0),
        fileName: String(file.fileName ?? ''),
        ...(typeof file.fileDate === 'string' && file.fileDate ? { fileDate: file.fileDate } : {}),
      })
    }
    const reported = Array.isArray(data.unmatchedFingerprints)
      ? data.unmatchedFingerprints.map(Number).filter((value) => Number.isSafeInteger(value))
      : []
    return {
      cacheBuilt: data.isCacheBuilt !== false,
      matches,
      unmatched:
        reported.length > 0
          ? reported
          : values.filter((value) => !matches.some((match) => match.fingerprint === value)),
    }
  }

  /**
   * The one download chain: the URL from the metadata, then `download-url`, then the
   * CDN — where the CDN step needs the author's permission. `exclude` skips the
   * candidate that just failed, which is how a caller gets a second round after a
   * 403 or an expired URL.
   */
  async resolveDownloadUrl(
    file: Pick<CurseForgeFile, 'id' | 'modId' | 'fileName' | 'downloadUrl'>,
    options: { exclude?: string } = {},
  ): Promise<CurseForgeDownloadResolution> {
    if (file.downloadUrl && file.downloadUrl !== options.exclude) {
      return { url: file.downloadUrl, source: 'metadata' }
    }
    const endpoint = await this.downloadUrl(file.modId, file.id)
    if (endpoint && endpoint !== options.exclude) return { url: endpoint, source: 'endpoint' }
    if ((await this.#allowsModDistribution(file.modId)) === false) return { blocked: true }
    const fallback = curseForgeCdnUrl(file, this.#cdnBase)
    if (!fallback || fallback === options.exclude) return undefined
    return { url: fallback, source: 'cdn' }
  }

  async #allowsModDistribution(modId: number): Promise<boolean | undefined> {
    return (await this.mod(modId)).allowModDistribution
  }

  async #fetchCdn(url: string, init?: RequestInit): Promise<Response> {
    const fetchImpl = this.#fetch ?? fetch
    let current = url
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(current, {
        ...init,
        headers: isCurseForgeCdnHost(current) ? { 'x-api-key': this.#key } : {},
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (!isRedirectStatus(response.status) || !location || hop >= MAX_CDN_REDIRECTS) {
        return response
      }
      await response.body?.cancel().catch(() => undefined)
      current = new URL(location, current).toString()
    }
  }

  /**
   * The whole download for one file: policy-checked resolution, then the phase 4
   * transfer, then — if that route turned out to be dead — one more resolution
   * round without it. Every caller gets the policy for free.
   */
  async download(
    file: CurseForgeFile,
    destination: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ bytes: number; skipped: boolean }> {
    const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value
    const existing = await stat(destination).catch(() => undefined)
    if (existing?.isFile()) {
      const buffer = await readFile(destination)
      const matches = sha1
        ? hashBuffer('sha1', buffer).toLowerCase() === sha1.toLowerCase()
        : file.fileLength > 0 && buffer.length === file.fileLength
      if (matches) return { bytes: 0, skipped: true }
    }
    const resolved = await this.#resolveDownload(file)
    try {
      return await this.#transfer(resolved, file, destination, options)
    } catch (error) {
      // A dead or expired candidate is a failure of that route, not of the file, so
      // the chain gets one more round without the URL that just failed. A checksum
      // mismatch is not retried: that is a property of the bytes, not of the route.
      const routeFailed =
        error instanceof DownloadError && (error.code === 'http-error' || error.code === 'network')
      if (!routeFailed) throw error
      const second = await this.resolveDownloadUrl(file, { exclude: resolved.url }).catch(
        () => undefined,
      )
      if (!second || 'blocked' in second) throw error
      return await this.#transfer(second, file, destination, options)
    }
  }

  async #resolveDownload(
    file: CurseForgeFile,
  ): Promise<Extract<CurseForgeDownloadResolution, { url: string }>> {
    const resolved = await this.resolveDownloadUrl(file)
    if (!resolved) {
      throw new ModError('provider-error', `CurseForge file ${file.id} has no download URL`, {
        fileId: file.id,
        modId: file.modId,
      })
    }
    if ('blocked' in resolved) {
      throw new ModError(
        'distribution-blocked',
        `CurseForge project ${file.modId} does not allow third-party distribution`,
        { projectId: String(file.modId), fileId: String(file.id) },
      )
    }
    return resolved
  }

  /** The transfer is the streaming phase 4 pipeline: one pass, fsync, atomic rename. */
  async #transfer(
    resolved: Extract<CurseForgeDownloadResolution, { url: string }>,
    file: CurseForgeFile,
    destination: string,
    options: { signal?: AbortSignal },
  ): Promise<{ bytes: number; skipped: boolean }> {
    const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value
    const expected = {
      ...(sha1 ? { sha1 } : {}),
      ...(file.fileLength > 0 ? { size: file.fileLength } : {}),
    }
    const metrics = this.#metrics
    const transfer = () =>
      streamToFile({
        urls: [resolved.url],
        destination,
        fetchImpl: (target, init) => this.#fetchCdn(target, init),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(Object.keys(expected).length > 0 ? { expected } : {}),
        ...(metrics ? { metrics } : {}),
      })
    const downloaded = metrics
      ? await metrics.measure(TRANSFER_STAGE, transfer)
      : await transfer()
    this.#logger?.info('CurseForge file downloaded', {
      modId: file.modId,
      fileId: file.id,
      file: destination,
      bytes: downloaded.bytes,
      source: resolved.source,
    })
    return { bytes: downloaded.bytes, skipped: false }
  }
}
