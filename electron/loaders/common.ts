import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writeJsonFile } from '../atomic'
import { hashFile } from '../download/checksum'
import { runInstallManifest, type ExecutorOptions } from '../download/executor'
import type { InstallFile, InstallReport } from '../download/types'
import { installVersion } from '../install/version'
import { describeError, getDefaultLogger } from '../logger'
import type { LibraryModel } from '../version/libraries'
import type { ResolvedVersionModel } from '../version/resolve'
import { LoaderError } from './errors'
import { LoaderTransaction } from './transaction'
import type {
  LoaderInstallMarker,
  LoaderInstallOptions,
  LoaderJavaRuntime,
} from './types'

export const LOADER_MARKER_FILE = 'bamboo-loader.json'
export const INSTALL_PROFILE_FILE = 'install_profile.json'

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    getDefaultLogger().child('loaders').debug('path probe failed; treating as absent', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function readJsonSafe<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    getDefaultLogger().child('loaders').debug('json read failed; using fallback', {
      file,
      error: describeError(error),
    })
    return undefined
  }
}

export function versionDirectory(gameRoot: string, versionId: string): string {
  return join(gameRoot, 'versions', versionId)
}

export function versionJsonPath(gameRoot: string, versionId: string): string {
  return join(versionDirectory(gameRoot, versionId), `${versionId}.json`)
}

export function markerPath(gameRoot: string, versionId: string): string {
  return join(versionDirectory(gameRoot, versionId), LOADER_MARKER_FILE)
}

export function profilePath(gameRoot: string, versionId: string): string {
  return join(versionDirectory(gameRoot, versionId), INSTALL_PROFILE_FILE)
}

export async function readMarker(gameRoot: string, versionId: string): Promise<LoaderInstallMarker | undefined> {
  return readJsonSafe<LoaderInstallMarker>(markerPath(gameRoot, versionId))
}

export async function writeMarker(
  transaction: LoaderTransaction,
  gameRoot: string,
  versionId: string,
  marker: LoaderInstallMarker,
): Promise<void> {
  await transaction.writeJson(markerPath(gameRoot, versionId), marker)
}

export async function hasVersionJson(gameRoot: string, versionId: string): Promise<boolean> {
  return pathExists(versionJsonPath(gameRoot, versionId))
}

export function executorOptions(options: LoaderInstallOptions): ExecutorOptions {
  const result: ExecutorOptions = {}
  if (options.signal) result.signal = options.signal
  if (options.fetchImpl) result.fetchImpl = options.fetchImpl
  if (options.retry) result.retry = options.retry
  if (options.telemetry) result.telemetry = options.telemetry
  return result
}

export async function ensureBaseVersion(
  gameRoot: string,
  minecraftVersion: string,
  options: LoaderInstallOptions,
): Promise<void> {
  if (options.installBaseVersion === false) return
  await installVersion(gameRoot, minecraftVersion, {
    cacheDir: options.cacheDir ?? join(gameRoot, 'cache'),
    withAssets: options.installAssets === true,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger.child('base') } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
}

export async function ensureClientJar(
  gameRoot: string,
  minecraftVersion: string,
  options: LoaderInstallOptions,
): Promise<boolean> {
  const clientJar = join(gameRoot, 'versions', minecraftVersion, `${minecraftVersion}.jar`)
  if (await pathExists(clientJar)) return false
  await ensureBaseVersion(gameRoot, minecraftVersion, { ...options, installBaseVersion: true })
  return true
}

export async function resolveJavaRuntimes(options: LoaderInstallOptions): Promise<LoaderJavaRuntime[]> {
  const configured = options.java
  let runtimes: LoaderJavaRuntime[]
  if (typeof configured === 'function') {
    runtimes = normalizeJavaOption(await configured())
  } else {
    runtimes = normalizeJavaOption(configured)
  }
  if (runtimes.length === 0 && options.javaPath) runtimes = [{ path: options.javaPath }]
  if (runtimes.length === 0) runtimes = [{ path: 'java' }]
  return runtimes
}

function normalizeJavaOption(value: LoaderJavaOptionsInput): LoaderJavaRuntime[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  const result: LoaderJavaRuntime[] = []
  const seen = new Set<string>()
  for (const runtime of list) {
    const path = typeof runtime === 'string' ? runtime : runtime.path
    if (!path) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(typeof runtime === 'string' ? { path: runtime } : runtime)
  }
  return result
}

type LoaderJavaOptionsInput =
  | string
  | LoaderJavaRuntime
  | LoaderJavaRuntime[]
  | undefined

export async function libraryFileIsValid(library: LibraryModel): Promise<boolean> {
  try {
    const info = await stat(library.absolutePath)
    if (!info.isFile()) return false
    if (library.size !== undefined && library.size >= 0 && info.size !== library.size) return false
    if (library.sha1) {
      return (await hashFile('sha1', library.absolutePath)).toLowerCase() === library.sha1.toLowerCase()
    }
    return true
  } catch (error) {
    getDefaultLogger().child('loaders').debug('library validation failed; treating file as missing', {
      file: library.absolutePath,
      error: describeError(error),
    })
    return false
  }
}

export function libraryInstallFile(library: LibraryModel): InstallFile | undefined {
  if (!library.url) return undefined
  const file: InstallFile = {
    path: `libraries/${library.path}`,
    urls: [library.url],
    validator: 'zip',
  }
  if (library.size !== undefined && library.size >= 0) file.size = library.size
  if (library.sha1) file.checksum = { algorithm: 'sha1', value: library.sha1 }
  return file
}

export function modelInstallFiles(model: ResolvedVersionModel): InstallFile[] {
  const files = new Map<string, InstallFile>()
  for (const library of [...model.libraries, ...model.natives]) {
    const file = libraryInstallFile(library)
    if (file) files.set(file.path, file)
  }
  const client = model.downloads.client
  if (client?.url) {
    const file: InstallFile = {
      path: `versions/${model.jarVersion}/${basename(model.clientJar)}`,
      urls: [client.url],
      validator: 'zip',
    }
    if (client.size !== undefined) file.size = client.size
    if (client.sha1) file.checksum = { algorithm: 'sha1', value: client.sha1 }
    files.set(file.path, file)
  }
  return [...files.values()]
}

export async function installModelFiles(
  gameRoot: string,
  model: ResolvedVersionModel,
  options: LoaderInstallOptions,
  id: string,
): Promise<InstallReport> {
  const files = modelInstallFiles(model)
  if (files.length === 0) {
    return {
      tasks: 0,
      files: 0,
      downloadedFiles: 0,
      skippedFiles: 0,
      bytes: 0,
      downloadedBytes: 0,
      durationMs: 0,
    }
  }
  return runInstallManifest(
    { version: 1, tasks: [{ type: 'files', id: `${id}:model-files`, destination: gameRoot, files }] },
    executorOptions(options),
  )
}

export async function writeVersionJson(
  transaction: LoaderTransaction,
  gameRoot: string,
  versionId: string,
  value: unknown,
): Promise<void> {
  await transaction.writeJson(versionJsonPath(gameRoot, versionId), value)
}

export async function writeJsonDirect(file: string, value: unknown): Promise<void> {
  await writeJsonFile(file, value)
}

export function requireLoaderVersion(loaderVersion: string | undefined, loader: string): string {
  if (!loaderVersion) {
    throw new LoaderError('invalid', `${loader}-Version fehlt und konnte nicht aus Metadaten gewählt werden`)
  }
  return loaderVersion
}
