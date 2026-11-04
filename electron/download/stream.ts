/**
 * Streaming download (roadmap phase 4): the response body is written chunk by
 * chunk while SHA-1, SHA-512 and the size are computed from the same bytes, so
 * a large file never lives in memory. The destination is only ever produced by
 * `fsync` + rename of the temporary file, and every failure path deletes that
 * temporary file: a mismatch or an abort leaves no file behind.
 */
import { randomBytes } from 'node:crypto'
import { open, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFile } from '../link'
import { createDualHasher, type DualHash } from './checksum'
import {
  DownloadError,
  isAbortError,
  isTerminalError,
  linkAbortSignal,
  retryDelay,
  type FetchLike,
  type RetryOptions,
} from './http'

const DEFAULT_ATTEMPTS = 3

/** The stage name a transfer shows up under in the metrics. */
export const TRANSFER_STAGE = 'download'

/**
 * What a transfer reports about itself. Declared structurally so this module
 * stays free of the mod pipeline; `ModMetrics` satisfies it as it is.
 */
export interface TransferMetrics {
  downloadBytes(bytes: number): void
  hashBytes(bytes: number): void
}

export interface StreamDownloadOptions {
  urls: string[]
  destination: string
  headers?: Record<string, string>
  fetchImpl?: FetchLike
  signal?: AbortSignal
  retry?: RetryOptions
  expected?: { sha1?: string; sha512?: string; size?: number }
  /** Where the temporary file goes; defaults to the destination directory. */
  tempDirectory?: string
  onProgress?: (bytes: number) => void
  /** Counts the bytes this transfer writes and hashes; absent, nothing is counted. */
  metrics?: TransferMetrics
}

export interface StreamDownloadResult extends DualHash {
  path: string
  attempts: number
}

function abortError(signal?: AbortSignal): DownloadError {
  return new DownloadError('aborted', 'Download aborted', {
    cause: signal?.reason instanceof Error ? signal.reason : undefined,
  })
}

export async function streamToFile(options: StreamDownloadOptions): Promise<StreamDownloadResult> {
  const urls = options.urls.filter((url) => typeof url === 'string' && url.length > 0)
  if (urls.length === 0) throw new DownloadError('invalid', 'No download URL available')
  const fetchImpl = options.fetchImpl ?? fetch
  const retry = options.retry ?? {}
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_ATTEMPTS)
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const tempDirectory = options.tempDirectory ?? dirname(options.destination)
  const metrics = options.metrics
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal)
    const url = urls[attempt % urls.length]
    const temp = `${tempDirectory}/${`${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`}.part`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let done = false
    const linked = linkAbortSignal(options.signal)
    try {
      await mkdir(tempDirectory, { recursive: true })
      const response = await fetchImpl(url, {
        signal: linked.signal,
        headers: options.headers,
        redirect: 'follow',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new DownloadError('http-error', `HTTP ${response.status} for ${url}`, {
          url,
          status: response.status,
        })
      }

      handle = await open(temp, 'wx')
      const hasher = createDualHasher()
      if (response.body) {
        for await (const chunk of response.body) {
          if (options.signal?.aborted) throw abortError(options.signal)
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          await writeAll(handle, buffer)
          hasher.update(buffer)
          metrics?.downloadBytes(buffer.length)
          metrics?.hashBytes(buffer.length)
          options.onProgress?.(buffer.length)
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer())
        await writeAll(handle, buffer)
        hasher.update(buffer)
        metrics?.downloadBytes(buffer.length)
        metrics?.hashBytes(buffer.length)
        options.onProgress?.(buffer.length)
      }
      const hash = hasher.digest()

      if (options.expected?.size !== undefined && options.expected.size !== hash.bytes) {
        throw new DownloadError('size-mismatch', `Expected ${options.expected.size} bytes, got ${hash.bytes}`, {
          url,
        })
      }
      if (options.expected?.sha1 && options.expected.sha1.toLowerCase() !== hash.sha1) {
        throw new DownloadError('checksum-mismatch', `SHA-1 mismatch for ${url}`, { url })
      }
      if (options.expected?.sha512 && options.expected.sha512.toLowerCase() !== hash.sha512) {
        throw new DownloadError('checksum-mismatch', `SHA-512 mismatch for ${url}`, { url })
      }

      await handle.sync()
      await handle.close()
      handle = undefined
      await mkdir(dirname(options.destination), { recursive: true })
      await replaceFile(temp, options.destination)
      done = true
      return { ...hash, path: options.destination, attempts: attempt + 1 }
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw abortError(options.signal)
      if (isTerminalError(error)) throw error
      lastError = error
      if (attempt + 1 < attempts) {
        const delay = retryDelay(attempt, retry)
        retry.onRetry?.({ attempt: attempt + 1, delayMs: delay, error, url })
        await sleep(delay)
      }
    } finally {
      linked.dispose()
      await handle?.close().catch(() => undefined)
      if (!done) await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  if (lastError instanceof DownloadError) throw lastError
  throw new DownloadError('network', `Download failed after ${attempts} attempt(s)`, {
    url: urls[0],
    attempts,
    cause: lastError,
  })
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    if (bytesWritten <= 0) throw new DownloadError('network', 'Write made no progress')
    offset += bytesWritten
  }
}
