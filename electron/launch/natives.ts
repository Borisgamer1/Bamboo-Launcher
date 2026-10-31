import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { hashFile, sha1Hex } from '../download/checksum'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import type { ResolvedVersionModel } from '../version/resolve'
import { LaunchError } from './errors'
import type { NativesResult } from './types'

const STALE_LOCK_MS = 120_000
const LOCK_TIMEOUT_MS = 30_000
const OS_SEGMENTS = new Set(['windows', 'linux', 'macosx', 'osx', 'macos'])
const ARCH_SEGMENTS = new Set(['x64', 'amd64', 'x86', 'i386', 'arm64', 'aarch64', 'arm'])

interface NativesCache {
  libraries: string[]
  files: Record<string, { size: number; sha1: string }>
}

export interface NativesOptions {
  directory?: string
  logger?: Logger
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    // Existence probes are expected to fail and are reported by the caller's error.
    getDefaultLogger().child('launch:natives').debug('native file probe failed', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function withFileLock<T>(
  lockFile: string,
  fn: (waitedMs: number) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true })
  const started = Date.now()
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await handle.close()
      acquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lockFile)
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockFile, { force: true })
          continue
        }
      } catch (error) {
        // The lock file disappeared between open and stat; retry the acquisition.
        getDefaultLogger().child('launch:natives').debug('natives lock vanished while inspecting it', {
          lockFile,
          error: describeError(error),
        })
        continue
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new LaunchError('lock-timeout', `Natives-Sperre blieb zu lange belegt: ${lockFile}`)
      }
      await sleep(100)
    }
  }
  try {
    return await fn(Date.now() - started)
  } finally {
    await rm(lockFile, { force: true }).catch((error) => {
      getDefaultLogger().child('launch:natives').debug('natives lock file could not be removed', {
        lockFile,
        error: describeError(error),
      })
    })
  }
}

function isExcluded(entryName: string, patterns: string[] | undefined): boolean {
  if (entryName.startsWith('META-INF/')) return true
  if (entryName.endsWith('.sha1') || entryName.endsWith('.git')) return true
  for (const pattern of patterns ?? []) {
    if (!pattern) continue
    if (pattern.endsWith('/') ? entryName.startsWith(pattern) : entryName === pattern || basename(entryName) === pattern) {
      return true
    }
  }
  return false
}

function stripPlatformPrefix(entryName: string): string | undefined {
  const segments = entryName.split('/').filter(Boolean)
  if (segments.length === 0) return undefined
  if (!OS_SEGMENTS.has(segments[0].toLowerCase())) return segments.join('/')
  segments.shift()
  if (segments.length > 0 && ARCH_SEGMENTS.has(segments[0].toLowerCase())) segments.shift()
  if (segments.length === 0) return undefined
  return segments.join('/')
}

async function readCache(cacheFile: string): Promise<NativesCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as NativesCache
    if (!parsed || !Array.isArray(parsed.libraries) || typeof parsed.files !== 'object') return undefined
    return parsed
  } catch (error) {
    // A missing or corrupt cache just forces a fresh extraction.
    getDefaultLogger().child('launch:natives').debug('natives cache unusable; re-extracting', {
      cacheFile,
      error: describeError(error),
    })
    return undefined
  }
}

async function cacheIsValid(cache: NativesCache, directory: string, libraries: string[]): Promise<boolean> {
  if (cache.libraries.length !== libraries.length) return false
  if ([...cache.libraries].sort().join('|') !== [...libraries].sort().join('|')) return false
  for (const [relative, entry] of Object.entries(cache.files)) {
    const target = join(directory, relative)
    try {
      const info = await stat(target)
      if (info.size !== entry.size) return false
      if ((await hashFile('sha1', target)) !== entry.sha1) return false
    } catch (error) {
      // Any missing or unreadable file invalidates the cache.
      getDefaultLogger().child('launch:natives').debug('natives cache entry invalid', {
        target,
        error: describeError(error),
      })
      return false
    }
  }
  return true
}

export async function prepareNatives(
  model: ResolvedVersionModel,
  options: NativesOptions = {},
): Promise<NativesResult> {
  const directory = options.directory ?? model.nativeDirectory
  if (model.natives.length === 0) {
    return { directory, extracted: 0, skipped: 0, files: 0, cacheHit: true, lockWaitMs: 0 }
  }
  const cacheFile = `${directory}.json`
  const lockFile = `${directory}.lock`
  const libraryNames = model.natives.map((library) => basename(library.absolutePath))

  return withFileLock(lockFile, async (lockWaitMs) => {
    const cache = await readCache(cacheFile)
    if (cache && (await cacheIsValid(cache, directory, libraryNames))) {
      return {
        directory,
        extracted: 0,
        skipped: Object.keys(cache.files).length,
        files: Object.keys(cache.files).length,
        cacheHit: true,
        lockWaitMs,
      }
    }

    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    const files: Record<string, { size: number; sha1: string }> = {}
    let extracted = 0

    for (const library of model.natives) {
      if (!(await pathExists(library.absolutePath))) {
        throw new LaunchError('natives', `Native-Archiv fehlt: ${library.absolutePath}`, [library.name])
      }
      let zip: AdmZip
      try {
        zip = new AdmZip(library.absolutePath)
      } catch (error) {
        throw new LaunchError('natives', `Native-Archiv ist nicht lesbar: ${library.absolutePath}`, [
          (error as Error).message,
        ])
      }
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        const entryName = entry.entryName.replace(/\\/g, '/')
        if (isExcluded(entryName, library.extractExclude)) continue
        const relative = stripPlatformPrefix(entryName)
        if (!relative) continue
        const target = join(directory, relative)
        const data = entry.getData()
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, data)
        files[relative] = { size: data.length, sha1: sha1Hex(data) }
        extracted += 1
      }
    }

    await writeFile(cacheFile, `${JSON.stringify({ libraries: libraryNames, files }, null, 2)}\n`)
    options.logger?.debug('Natives extracted', { directory, extracted })
    return { directory, extracted, skipped: 0, files: extracted, cacheHit: false, lockWaitMs }
  })
}

export { readCache as readNativesCache }
