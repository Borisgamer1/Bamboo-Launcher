import AdmZip from 'adm-zip'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { hashBuffer } from '../download/checksum'
import type { Logger } from '../logger'
import { readModpackLock } from './lock'
import { ModError } from './errors'
import { MOD_INDEX_FILE } from './offline-index'
import type { ModpackFile, ModpackLockFile } from './types'

export const DEFAULT_EXPORT_EXCLUDES = [
  'logs',
  'crash-reports',
  'screenshots',
  'saves',
  'backups',
  '.mixin.out',
] as const

const EXCLUDED_FILES = new Set([
  'modpack.lock.json',
  MOD_INDEX_FILE,
  'modrinth.index.json',
  'curseforge.manifest.json',
  '.DS_Store',
])

export interface ExportFileReference {
  downloads: string[]
  projectId?: string
  versionId?: string
}

export interface ExportModpackOptions {
  instanceDir: string
  destination: string
  name?: string
  versionId?: string
  summary?: string
  dependencies?: Record<string, string>
  resolveFile?: (input: {
    path: string
    sha1: string
    sha512: string
    size: number
    lock?: ModpackLockFile
  }) => ExportFileReference | undefined | Promise<ExportFileReference | undefined>
  exclude?: string[]
  allow?: string[]
  signal?: AbortSignal
  logger?: Logger
}

export interface ExportModpackResult {
  archive: string
  files: number
  overrides: number
  bytes: number
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

async function collectFiles(
  instanceDir: string,
  excluded: Set<string>,
): Promise<string[]> {
  const result: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = normalizePath(relative(instanceDir, absolute))
      if (entry.isDirectory()) {
        if (excluded.has(entry.name) || entry.name.startsWith('.part-')) continue
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (EXCLUDED_FILES.has(entry.name) || entry.name.includes('.part-')) continue
      result.push(relativePath)
    }
  }
  await walk(instanceDir)
  return result.sort()
}

async function writeArchive(destination: string, buffer: Buffer): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const temp = `${destination}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, buffer)
  try {
    await rename(temp, destination)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function exportModpack(options: ExportModpackOptions): Promise<ExportModpackResult> {
  const instanceDir = resolve(options.instanceDir)
  const info = await stat(instanceDir).catch(() => undefined)
  if (!info?.isDirectory()) {
    throw new ModError('not-a-modpack', `Instance directory does not exist: ${instanceDir}`, {
      instanceDir,
    })
  }
  if (options.signal?.aborted) throw new ModError('aborted', 'Export aborted')
  const lock = await readModpackLock(instanceDir, options.logger)
  const lockByPath = new Map<string, ModpackLockFile>(
    (lock?.files ?? []).map((entry) => [normalizePath(entry.path), entry]),
  )
  const allow = new Set(options.allow ?? [])
  const excluded = new Set<string>([
    ...DEFAULT_EXPORT_EXCLUDES.filter((name) => !allow.has(name)),
    ...(options.exclude ?? []),
  ])
  const paths = await collectFiles(instanceDir, excluded)
  const files: ModpackFile[] = []
  const overrides = new AdmZip()
  let overrideBytes = 0

  for (const path of paths) {
    if (options.signal?.aborted) throw new ModError('aborted', 'Export aborted')
    const absolute = join(instanceDir, ...path.split('/'))
    const buffer = await readFile(absolute)
    const sha1 = hashBuffer('sha1', buffer)
    const sha512 = hashBuffer('sha512', buffer)
    const lockEntry = lockByPath.get(path)
    const reference = options.resolveFile
      ? await options.resolveFile({
          path,
          sha1,
          sha512,
          size: buffer.length,
          ...(lockEntry ? { lock: lockEntry } : {}),
        })
      : undefined
    if (reference && reference.downloads.length > 0) {
      files.push({
        path,
        downloads: reference.downloads,
        fileSize: buffer.length,
        hashes: { sha1, sha512 },
      })
      continue
    }
    overrides.addFile(`overrides/${path}`, buffer)
    overrideBytes += buffer.length
  }

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: options.versionId ?? lock?.versionId ?? '1.0.0',
    name: options.name ?? lock?.name ?? 'Modpack',
    ...(options.summary ? { summary: options.summary } : {}),
    files,
    dependencies: options.dependencies ?? lock?.dependencies ?? {},
  }
  const zip = new AdmZip()
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)))
  for (const entry of overrides.getEntries()) {
    zip.addFile(entry.entryName, entry.getData())
  }
  const archive = zip.toBuffer()
  await writeArchive(options.destination, archive)
  options.logger?.info('mrpack exported', {
    destination: options.destination,
    files: files.length,
    overrides: overrides.getEntries().length,
    bytes: overrideBytes,
  })
  return {
    archive: options.destination,
    files: files.length,
    overrides: overrides.getEntries().length,
    bytes: archive.length,
  }
}
