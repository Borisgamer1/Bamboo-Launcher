import type { FetchLike } from '../download/http'
import type { Logger } from '../logger'
import { LAUNCHER_VERSION } from '../launch/args'

export const CURSEFORGE_API_BASE = 'https://api.curseforge.com/v1'

export interface CurseForgeHttpOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: FetchLike
  logger?: Logger
  sleep?: (ms: number) => Promise<void>
  retries?: number
}

export interface CurseForgeRequestOptions {
  query?: Record<string, string>
  method?: string
  body?: string
  headers?: Record<string, string>
}

/** Statuses where a second request can plausibly succeed. */
const RETRY_STATUS = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504])

/**
 * One owner of CurseForge HTTP: API key, retry policy, rate-limit wait and the
 * JSON request shape. The core client and the legacy renderer bridge both use
 * it, so a retry or header fix lands in one place.
 */
export class CurseForgeHttp {
  readonly #key: string
  readonly #base: string
  readonly #fetch?: FetchLike
  readonly #logger?: Logger
  readonly #sleep: (ms: number) => Promise<void>
  readonly #retries: number

  constructor(options: CurseForgeHttpOptions) {
    this.#key = options.apiKey
    this.#base = (options.baseUrl ?? CURSEFORGE_API_BASE).replace(/\/$/, '')
    this.#fetch = options.fetchImpl
    this.#logger = options.logger
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#retries = Math.max(1, options.retries ?? 3)
  }

  async request(
    target: string,
    options: CurseForgeRequestOptions = {},
    attempts = this.#retries,
  ): Promise<Response> {
    const url = new URL(target.startsWith('http') ? target : `${this.#base}${target}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.#key,
      'user-agent': `BambooLauncher/${LAUNCHER_VERSION}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    }
    const fetchImpl = this.#fetch ?? fetch
    let lastError: unknown
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      let response: Response
      try {
        response = await fetchImpl(url.toString(), {
          headers,
          ...(options.method ? { method: options.method } : {}),
          ...(options.body ? { body: options.body } : {}),
          redirect: 'follow',
        })
      } catch (error) {
        lastError = error
        if (attempt + 1 >= Math.max(1, attempts)) throw error
        await this.#sleep(250 * (attempt + 1))
        continue
      }
      if (!RETRY_STATUS.has(response.status) || attempt + 1 >= Math.max(1, attempts)) {
        return response
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? '')
      const delay = response.status === 429 && Number.isFinite(retryAfter)
        ? Math.min(60_000, Math.max(250, retryAfter * 1000))
        : 250 * (attempt + 1)
      await response.body?.cancel().catch(() => undefined)
      this.#logger?.warn('CurseForge request will be retried', {
        status: response.status,
        attempt: attempt + 1,
        delay,
      })
      await this.#sleep(delay)
    }
    throw lastError instanceof Error ? lastError : new Error('CurseForge request failed')
  }
}
