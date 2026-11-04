import type { ModMetrics } from './metrics'
import type { ProviderId, ProviderSearchPage } from './types'

export const PROVIDER_SEARCH_TTL_MS = 10 * 60_000
export const PROVIDER_METADATA_TTL_MS = 30 * 60_000
const MAX_ENTRIES = 200

/** The stage name under which cache misses show up in the metrics. */
export const PROVIDER_LOAD_STAGE = 'provider-load'

export interface ProviderCacheOptions {
  now?: () => number
  metrics?: ModMetrics
}

interface Slot {
  value: unknown
  expiresAt: number
}

export function cacheKey(
  provider: ProviderId,
  kind: string,
  parts: Record<string, unknown> = {},
): string {
  return JSON.stringify(canonical({ provider, kind, ...parts }))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    )
  }
  return value
}

class TtlCache {
  readonly #ttlMs: number
  readonly #entries = new Map<string, Slot>()
  readonly #inflight = new Map<string, Promise<unknown>>()
  readonly #now: () => number
  readonly #metrics?: ModMetrics

  constructor(ttlMs: number, now: () => number, metrics?: ModMetrics) {
    this.#ttlMs = ttlMs
    this.#now = now
    this.#metrics = metrics
  }

  async get<T>(key: string, load: () => Promise<T>, bypassCache = false): Promise<T> {
    const hit = this.#entries.get(key) as Slot | undefined
    if (hit) {
      this.#touch(key, hit)
      if (!bypassCache && this.#now() < hit.expiresAt) {
        this.#metrics?.cacheHit()
        return hit.value as T
      }
      if (!bypassCache) {
        this.#metrics?.cacheHit()
        void this.#refresh(key, load).catch(() => undefined)
        return hit.value as T
      }
    }
    this.#metrics?.cacheMiss()
    return this.#refresh(key, load)
  }

  #refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
    const pending = this.#inflight.get(key) as Promise<T> | undefined
    if (pending) return pending
    const metrics = this.#metrics
    const promise = (metrics ? metrics.measure(PROVIDER_LOAD_STAGE, load) : load())
      .then((value) => {
        this.#store(key, { value, expiresAt: this.#now() + this.#ttlMs })
        return value
      })
      .finally(() => this.#inflight.delete(key))
    this.#inflight.set(key, promise)
    return promise
  }

  #store(key: string, slot: Slot): void {
    this.#entries.delete(key)
    this.#entries.set(key, slot)
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  #touch(key: string, slot: Slot): void {
    this.#entries.delete(key)
    this.#entries.set(key, slot)
  }
}

export class ProviderCache {
  readonly #metadata: TtlCache
  readonly #search: TtlCache

  constructor(options: ProviderCacheOptions = {}) {
    const now = options.now ?? Date.now
    this.#metadata = new TtlCache(PROVIDER_METADATA_TTL_MS, now, options.metrics)
    this.#search = new TtlCache(PROVIDER_SEARCH_TTL_MS, now, options.metrics)
  }

  metadata<T>(key: string, load: () => Promise<T>, bypassCache = false): Promise<T> {
    return this.#metadata.get(key, load, bypassCache)
  }

  search(
    key: string,
    page: string,
    load: () => Promise<ProviderSearchPage>,
    bypassCache = false,
  ): Promise<ProviderSearchPage> {
    return this.#search.get(`${key}\u0000${page}`, load, bypassCache)
  }
}
