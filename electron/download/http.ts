import type { Checksum } from './checksum'
import { hashBuffer } from './checksum'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type DownloadErrorCode =
  | 'http-error'
  | 'network'
  | 'checksum-mismatch'
  | 'size-mismatch'
  | 'aborted'
  | 'invalid'

export class DownloadError extends Error {
  readonly code: DownloadErrorCode
  readonly url?: string
  readonly status?: number
  readonly attempts?: number

  constructor(
    code: DownloadErrorCode,
    message: string,
    options: { url?: string; status?: number; attempts?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = code === 'aborted' ? 'AbortError' : 'DownloadError'
    this.code = code
    this.url = options.url
    this.status = options.status
    this.attempts = options.attempts
  }
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; url: string }) => void
}

export interface RequestOptions {
  urls: string[]
  headers?: Record<string, string>
  fetchImpl?: FetchLike
  signal?: AbortSignal
  method?: string
  body?: string | Uint8Array
  retry?: RetryOptions
  acceptStatuses?: number[]
  checksum?: Checksum
  size?: number
}

export interface BufferedResponse {
  buffer: Buffer
  url: string
  status: number
  headers: Record<string, string>
  attempts: number
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY = 250
const DEFAULT_MAX_DELAY = 4_000

const TERMINAL_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EISDIR'])

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'AbortError' ||
        (error as { code?: string }).code === 'ABORT_ERR'),
  )
}

export function isTerminalError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (isAbortError(error)) return true
  const code = (error as { code?: string }).code
  return typeof code === 'string' && TERMINAL_CODES.has(code)
}

function abortFrom(signal?: AbortSignal): DownloadError {
  const reason = signal?.reason
  return new DownloadError('aborted', 'Download aborted', {
    cause: reason instanceof Error ? reason : undefined,
  })
}

export interface LinkedAbortSignal {
  signal?: AbortSignal
  dispose: () => void
}

/**
 * fetch() keeps an abort listener on the signal it receives in Electron's Node
 * 20 until that response finishes. Passing one long-lived install signal to
 * hundreds of files therefore exceeds the listener limit. Each transfer gets a
 * fresh signal linked to the caller's signal instead, and drops the link as
 * soon as the transfer no longer needs it.
 */
export function linkAbortSignal(signal?: AbortSignal): LinkedAbortSignal {
  if (!signal) return { dispose: () => undefined }
  if (signal.aborted) return { signal, dispose: () => undefined }
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => signal.removeEventListener('abort', onAbort),
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

export function retryDelay(attempt: number, retry: RetryOptions = {}): number {
  const base = retry.baseDelayMs ?? DEFAULT_BASE_DELAY
  const max = retry.maxDelayMs ?? DEFAULT_MAX_DELAY
  const random = retry.random ?? Math.random
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt))
  return Math.round(ceiling * (0.5 + random()))
}

export async function requestBuffer(options: RequestOptions): Promise<BufferedResponse> {
  const urls = options.urls.filter((url) => typeof url === 'string' && url.length > 0)
  if (urls.length === 0) {
    throw new DownloadError('invalid', 'No download URL available')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const retry = options.retry ?? {}
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_ATTEMPTS)
  const sleep = retry.sleep ?? sleepDefault
  const random = retry.random ?? Math.random
  const accepted = new Set(options.acceptStatuses ?? [])
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortFrom(options.signal)
    const url = urls[attempt % urls.length]
    const linked = linkAbortSignal(options.signal)
    try {
      const response = await fetchImpl(url, {
        signal: linked.signal,
        headers: options.headers,
        redirect: 'follow',
        ...(options.method ? { method: options.method } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      })
      if (!response.ok && !accepted.has(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        throw new DownloadError('http-error', `HTTP ${response.status} for ${url}`, {
          url,
          status: response.status,
        })
      }
      const buffer = accepted.has(response.status) && response.status === 304
        ? Buffer.alloc(0)
        : Buffer.from(await response.arrayBuffer())
      if (options.size !== undefined && options.size >= 0 && buffer.length !== options.size) {
        throw new DownloadError(
          'size-mismatch',
          `Expected ${options.size} bytes from ${url}, got ${buffer.length}`,
          { url },
        )
      }
      if (options.checksum) {
        const actual = hashBuffer(options.checksum.algorithm, buffer)
        if (actual.toLowerCase() !== options.checksum.value.toLowerCase()) {
          throw new DownloadError('checksum-mismatch', `Checksum mismatch for ${url}`, { url })
        }
      }
      return {
        buffer,
        url,
        status: response.status,
        headers: headersToObject(response.headers),
        attempts: attempt + 1,
      }
    } catch (error) {
      if (isAbortError(error) || isTerminalError(error)) {
        throw isAbortError(error) ? abortFrom(options.signal) : error
      }
      lastError = error
      if (attempt + 1 < attempts) {
        const delay = retryDelay(attempt, { ...retry, random })
        retry.onRetry?.({ attempt: attempt + 1, delayMs: delay, error, url })
        await sleep(delay)
      }
    } finally {
      linked.dispose()
    }
  }

  if (lastError instanceof DownloadError) throw lastError
  throw new DownloadError('network', `Download failed after ${attempts} attempt(s)`, {
    url: urls[0],
    attempts,
    cause: lastError,
  })
}

export interface TextResponse extends Omit<BufferedResponse, 'buffer'> {
  text: string
}

export async function requestText(options: RequestOptions): Promise<TextResponse> {
  const response = await requestBuffer(options)
  return {
    text: response.buffer.toString('utf8'),
    url: response.url,
    status: response.status,
    headers: response.headers,
    attempts: response.attempts,
  }
}

export async function downloadBuffer(
  options: RequestOptions,
): Promise<{ buffer: Buffer; url: string; attempts: number }> {
  const response = await requestBuffer(options)
  return { buffer: response.buffer, url: response.url, attempts: response.attempts }
}
