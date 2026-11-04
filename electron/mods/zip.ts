import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import unzipper from 'unzipper'
import { resolveInside } from './paths'

interface RawZipEntry {
  path: string
  type: string
  compressedSize: number
  uncompressedSize: number
  stream(password?: string): Readable
}

export interface ZipEntryInfo {
  name: string
  isDirectory: boolean
  size: number
  entry: RawZipEntry
}

export interface ZipExtractResult {
  written: number
  paths: Set<string>
}

export interface ZipArchive {
  readonly entries: readonly ZipEntryInfo[]
  has(name: string): boolean
  read(name: string, options?: { maxBytes?: number }): Promise<Buffer>
  count(prefixes: string | string[]): number
  extract(
    prefixes: string | string[],
    destination: string,
    onEntry?: (relative: string, done: number, total: number) => void,
  ): Promise<ZipExtractResult>
  extractAll(
    destination: string,
    onEntry?: (relative: string, done: number, total: number) => void,
  ): Promise<ZipExtractResult>
}

const normalizeName = (name: string): string => name.replace(/\\/g, '/').replace(/^\.\/+/, '')

const prefixOf = (prefix: string): string => normalizeName(prefix).replace(/\/+$/, '')

const matchesPrefix = (name: string, prefixes: string[]): boolean =>
  prefixes.some((prefix) => {
    const normalized = prefixOf(prefix)
    return normalized === '' || name.startsWith(`${normalized}/`)
  })

function entryStream(entry: ZipEntryInfo): Readable {
  return entry.entry.stream()
}

async function writeEntryToFile(entry: ZipEntryInfo, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const stream = entryStream(entry)
  const output = createWriteStream(target)
  await new Promise<void>((resolve, reject) => {
    let total = 0
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      output.end(() => resolve())
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    output.once('error', fail)
    stream.once('error', fail)
    stream.once('end', finish)
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (!output.write(buffer)) stream.pause()
      // Decompressed streams can stop exactly at the data end without an
      // `end` event; the central directory's size is authoritative.
      if (total >= entry.size) {
        stream.pause()
        finish()
      }
    })
    output.on('drain', () => stream.resume())
    if (entry.size === 0) finish()
  })
}

function createArchive(rawEntries: RawZipEntry[]): ZipArchive {
  const entries: ZipEntryInfo[] = rawEntries.map((entry) => {
    const name = normalizeName(entry.path)
    return {
      name,
      isDirectory: entry.type === 'Directory' || name.endsWith('/'),
      size: entry.uncompressedSize,
      entry,
    }
  })
  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  return {
    entries,
    has: (name) => byName.has(normalizeName(name)),
    read: async (name, options) => {
      const info = byName.get(normalizeName(name))
      if (!info || info.isDirectory) {
        throw new Error(`ZIP-Eintrag fehlt: ${name}`)
      }
      const maxBytes = options?.maxBytes ?? 64 * 1024 * 1024
      if (info.size > maxBytes) {
        throw new Error(`ZIP-Eintrag ist zu groß zum Einlesen: ${name}`)
      }
      const stream = entryStream(info)
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let total = 0
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolve(Buffer.concat(chunks, total))
        }
        stream.on('data', (chunk: Buffer | Uint8Array) => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          total += buffer.length
          if (total > maxBytes) {
            settled = true
            stream.destroy()
            reject(new Error(`ZIP-Eintrag ist zu groß zum Einlesen: ${name}`))
            return
          }
          chunks.push(buffer)
          if (total >= info.size) finish()
        })
        stream.once('end', finish)
        stream.once('error', (error) => {
          if (!settled) reject(error)
        })
        if (info.size === 0) finish()
      })
    },
    count: (prefixes) => {
      const list = Array.isArray(prefixes) ? prefixes : [prefixes]
      return entries.filter((entry) => !entry.isDirectory && matchesPrefix(entry.name, list)).length
    },
    extract: async (prefixes, destination, onEntry) => {
      const list = Array.isArray(prefixes) ? prefixes : [prefixes]
      const selected = entries.filter((entry) => !entry.isDirectory && matchesPrefix(entry.name, list))
      const paths = new Set<string>()
      for (let index = 0; index < selected.length; index += 1) {
        const info = selected[index]
        const prefix = list.find((candidate) => info.name.startsWith(`${prefixOf(candidate)}/`))
        if (!prefix) continue
        const relative = info.name.slice(prefixOf(prefix).length + 1)
        if (!relative) continue
        const target = resolveInside(destination, relative)
        await writeEntryToFile(info, target)
        paths.add(relative)
        onEntry?.(relative, index + 1, selected.length)
      }
      return { written: paths.size, paths }
    },
    extractAll: async (destination, onEntry) => {
      const selected = entries.filter((entry) => !entry.isDirectory)
      const paths = new Set<string>()
      for (let index = 0; index < selected.length; index += 1) {
        const info = selected[index]
        const target = resolveInside(destination, info.name)
        await writeEntryToFile(info, target)
        paths.add(info.name)
        onEntry?.(info.name, index + 1, selected.length)
      }
      return { written: paths.size, paths }
    },
  }
}

/**
 * Opens an archive from its central directory. Entry bytes are streamed on
 * demand, so a multi-gigabyte pack never has to fit into one Buffer.
 */
export async function withZip<T>(
  archivePath: string,
  operation: (archive: ZipArchive) => Promise<T>,
): Promise<T> {
  const directory = await unzipper.Open.file(archivePath)
  return operation(createArchive(directory.files))
}
