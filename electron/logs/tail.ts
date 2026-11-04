import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createGunzip } from 'node:zlib'
import type { Logger } from '../logger'
import type { LogTail } from './types'

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_LINES = 2000
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g')

export interface LogTailOptions {
  maxBytes?: number
  maxLines?: number
  logger?: Logger
}

export interface LogFileInfo {
  path: string
  mtimeMs: number
  size: number
  gzip: boolean
}

function emptyTail(path?: string): LogTail {
  return {
    lines: [],
    truncated: false,
    bytes: 0,
    anchorHits: 0,
    ...(path ? { path } : {}),
  }
}

function retryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESTALE'
}

async function readSlice(file: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readGzipSlice(file: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const stream = createReadStream(file).pipe(createGunzip())
  let buffer = Buffer.alloc(0)
  let truncated = false
  try {
    for await (const chunk of stream) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next])
      if (buffer.length > maxBytes) {
        buffer = buffer.subarray(buffer.length - maxBytes)
        truncated = true
      }
    }
  } finally {
    stream.destroy()
  }
  return { buffer, truncated }
}

function normalize(text: string, maxLines: number, dropFirst: boolean): { lines: string[]; truncated: boolean } {
  const clean = text.replace(ANSI, '')
  if (clean.length === 0) return { lines: [], truncated: false }
  let lines = clean.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let truncated = false
  if (dropFirst && lines.length > 0) {
    lines.shift()
    truncated = true
  }
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    truncated = true
  }
  return { lines, truncated }
}

export async function readLogTail(file: string, options: LogTailOptions = {}): Promise<LogTail> {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES)
  let attempt = 0
  for (;;) {
    try {
      const info = await stat(file)
      if (!info.isFile()) return emptyTail(file)
      if (info.size === 0) return emptyTail(file)
      if (basename(file).toLowerCase().endsWith('.gz')) {
        const { buffer, truncated } = await readGzipSlice(file, maxBytes)
        const normalized = normalize(buffer.toString('utf8'), maxLines, truncated)
        return {
          lines: normalized.lines,
          truncated: truncated || normalized.truncated,
          bytes: info.size,
          anchorHits: 0,
          path: file,
        }
      }
      const truncatedByBytes = info.size > maxBytes
      const buffer = truncatedByBytes
        ? await readSlice(file, info.size - maxBytes, maxBytes)
        : await readSlice(file, 0, info.size)
      const normalized = normalize(buffer.toString('utf8'), maxLines, truncatedByBytes)
      return {
        lines: normalized.lines,
        truncated: truncatedByBytes || normalized.truncated,
        bytes: info.size,
        anchorHits: 0,
        path: file,
      }
    } catch (error) {
      if (attempt === 0 && retryable(error)) {
        attempt += 1
        continue
      }
      options.logger?.warn('Could not read Minecraft log tail', {
        file,
        error: (error as Error).message,
      })
      return emptyTail(file)
    }
  }
}

export async function discoverLogs(logsDir: string): Promise<LogFileInfo[]> {
  const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => [])
  const files: LogFileInfo[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.log(?:\.gz)?$/i.test(entry.name)) continue
    const file = join(logsDir, entry.name)
    const info = await stat(file).catch(() => undefined)
    if (!info) continue
    files.push({
      path: file,
      mtimeMs: info.mtimeMs,
      size: info.size,
      gzip: entry.name.toLowerCase().endsWith('.gz'),
    })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
}

export async function findLatestLog(logsDir: string): Promise<LogFileInfo | undefined> {
  return (await discoverLogs(logsDir))[0]
}

export async function readLanPort(file: string): Promise<number | undefined> {
  const tail = await readLogTail(file, { maxBytes: 64 * 1024, maxLines: 500 })
  for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
    const match = /Published (?:a )?LAN server on port (\d+)/i.exec(tail.lines[index])
    if (match) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    }
  }
  return undefined
}
