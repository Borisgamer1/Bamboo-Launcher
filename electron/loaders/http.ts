import { requestBuffer, requestText, type FetchLike, type RetryOptions } from '../download/http'
import { describeError, getDefaultLogger } from '../logger'
import { LoaderError } from './errors'

export interface LoaderHttpContext {
  fetchImpl?: FetchLike
  retry?: RetryOptions
  signal?: AbortSignal
}

export async function fetchJson<T>(urls: string | string[], context: LoaderHttpContext = {}): Promise<T> {
  const response = await requestText({
    urls: Array.isArray(urls) ? urls : [urls],
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.retry ? { retry: context.retry } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    headers: { accept: 'application/json' },
  })
  try {
    return JSON.parse(response.text) as T
  } catch (error) {
    throw new LoaderError('metadata', `Ungültiges JSON von ${response.url}`, { cause: error })
  }
}

export async function fetchText(urls: string | string[], context: LoaderHttpContext = {}): Promise<string> {
  const response = await requestText({
    urls: Array.isArray(urls) ? urls : [urls],
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.retry ? { retry: context.retry } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  })
  return response.text
}

export async function fetchBuffer(
  urls: string | string[],
  context: LoaderHttpContext = {},
): Promise<Buffer> {
  const response = await requestBuffer({
    urls: Array.isArray(urls) ? urls : [urls],
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.retry ? { retry: context.retry } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  })
  return response.buffer
}

export async function fetchMavenSha1(
  url: string,
  context: LoaderHttpContext = {},
): Promise<string | undefined> {
  try {
    const text = await fetchText(`${url}.sha1`, context)
    const digest = text.trim().split(/\s+/)[0]?.toLowerCase()
    return digest && /^[a-f0-9]{40}$/.test(digest) ? digest : undefined
  } catch (error) {
    getDefaultLogger().child('loaders:http').debug('sha1 sidecar unavailable; checksum is optional', {
      url,
      error: describeError(error),
    })
    return undefined
  }
}

export async function fetchContentLength(
  url: string,
  context: LoaderHttpContext = {},
): Promise<number | undefined> {
  const fetchImpl = context.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      ...(context.signal ? { signal: context.signal } : {}),
    })
    if (!response.ok) return undefined
    const size = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined
  } catch (error) {
    getDefaultLogger().child('loaders:http').debug('content length probe failed; size is optional', {
      url,
      error: describeError(error),
    })
    return undefined
  }
}
