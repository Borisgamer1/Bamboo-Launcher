import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, readTextFile, writeJsonFile, writeTextFileAtomic } from '../atomic'
import { requestText, type FetchLike } from '../download/http'
import { describeError, type Logger } from '../logger'

export const VERSION_MANIFEST_SOURCES = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
]

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface VersionManifestEntry {
  id: string
  type: string
  url: string
  time?: string
  releaseTime?: string
  sha1?: string
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionManifestEntry[]
}

export type VersionManifestSource = 'cache' | 'network' | 'not-modified' | 'stale-cache'

export interface VersionManifestResult {
  manifest: VersionManifest
  source: VersionManifestSource
  etag?: string
}

export interface VersionManifestOptions {
  cacheDir: string
  fetchImpl?: FetchLike
  sources?: string[]
  logger?: Logger
  maxAgeMs?: number
}

export class VersionManifestError extends Error {
  readonly code = 'manifest-unavailable'
  readonly details: string[]

  constructor(message: string, details: string[] = []) {
    super(message)
    this.name = 'VersionManifestError'
    this.details = details
  }
}

export function isVersionManifest(value: unknown): value is VersionManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  const latest = manifest.latest
  if (!latest || typeof latest !== 'object') return false
  const { release, snapshot } = latest as Record<string, unknown>
  if (typeof release !== 'string' || typeof snapshot !== 'string') return false
  if (!Array.isArray(manifest.versions)) return false
  return manifest.versions.every(
    (entry) =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as VersionManifestEntry).id === 'string' &&
      typeof (entry as VersionManifestEntry).url === 'string' &&
      typeof (entry as VersionManifestEntry).type === 'string',
  )
}

export class VersionManifestService {
  #cacheFile: string
  #etagFile: string
  #fetch?: FetchLike
  #sources: string[]
  #logger?: Logger
  #maxAgeMs: number

  constructor(options: VersionManifestOptions) {
    this.#cacheFile = join(options.cacheDir, 'version_manifest.json')
    this.#etagFile = join(options.cacheDir, 'version_manifest.etag')
    this.#fetch = options.fetchImpl
    this.#sources = options.sources ?? VERSION_MANIFEST_SOURCES
    this.#logger = options.logger
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  async #cacheAge(): Promise<number | undefined> {
    try {
      return Date.now() - (await stat(this.#cacheFile)).mtimeMs
    } catch (error) {
      this.#logger?.debug('cached version manifest has no usable mtime', { error: describeError(error) })
      return undefined
    }
  }

  async get(options: { force?: boolean; maxAgeMs?: number } = {}): Promise<VersionManifestResult> {
    const cached = await readJsonFile<VersionManifest>(this.#cacheFile, this.#logger)
    const cache = cached && isVersionManifest(cached) ? cached : undefined
    const etag = (await readTextFile(this.#etagFile))?.trim() || undefined
    const maxAge = options.maxAgeMs ?? this.#maxAgeMs

    if (cache && !options.force) {
      const age = await this.#cacheAge()
      if (age !== undefined && age < maxAge) {
        return { manifest: cache, source: 'cache', ...(etag ? { etag } : {}) }
      }
    }

    const errors: string[] = []
    for (const source of this.#sources) {
      try {
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (etag) headers['If-None-Match'] = etag
        const response = await requestText({
          urls: [source],
          headers,
          fetchImpl: this.#fetch,
          acceptStatuses: [304],
          retry: { attempts: 2 },
        })
        if (response.status === 304) {
          if (cache) return { manifest: cache, source: 'not-modified', ...(etag ? { etag } : {}) }
          errors.push(`${source}: 304 without cached manifest`)
          continue
        }
        let data: unknown
        try {
          data = JSON.parse(response.text)
        } catch {
          errors.push(`${source}: invalid manifest body`)
          continue
        }
        if (!isVersionManifest(data)) {
          errors.push(`${source}: invalid manifest body`)
          continue
        }
        await writeJsonFile(this.#cacheFile, data)
        const nextEtag = response.headers.etag?.trim()
        if (nextEtag) await writeTextFileAtomic(this.#etagFile, `${nextEtag}\n`)
        else await rm(this.#etagFile, { force: true })
        this.#logger?.info('Version manifest refreshed', { source, versions: data.versions.length })
        return { manifest: data, source: 'network', ...(nextEtag ? { etag: nextEtag } : {}) }
      } catch (error) {
        errors.push(`${source}: ${(error as Error).message}`)
      }
    }

    if (cache) {
      this.#logger?.warn('Version manifest unreachable; using stale cache', { errors })
      return { manifest: cache, source: 'stale-cache', ...(etag ? { etag } : {}) }
    }
    throw new VersionManifestError('Unable to load the Minecraft version manifest', errors)
  }
}
