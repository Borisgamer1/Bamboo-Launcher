import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { downloadBuffer, DownloadError, type FetchLike } from '../download/http'
import { runInstallManifest } from '../download/executor'
import type { InstallFile, InstallManifest, InstallTask } from '../download/types'
import type { Logger } from '../logger'
import type { RuntimeComponentEntry, RuntimeFileManifest } from './manifest'

export type { FetchLike }

export interface RuntimeInstallProgress {
  component: string
  completedFiles: number
  totalFiles: number
  bytes: number
  totalBytes: number
  currentFile?: string
}

export interface InstallRuntimeOptions {
  gameRoot: string
  component: string
  entry: RuntimeComponentEntry
  platform?: NodeJS.Platform
  fetchImpl?: FetchLike
  signal?: AbortSignal
  onProgress?: (progress: RuntimeInstallProgress) => void
  logger?: Logger
}

export interface InstalledRuntime {
  component: string
  version?: string
  root: string
  javaPath: string
  files: number
  downloadedBytes: number
}

export async function installRuntime(options: InstallRuntimeOptions): Promise<InstalledRuntime> {
  const platform = options.platform ?? process.platform
  const logger = options.logger
  const manifestDownload = options.entry.manifest
  if (!manifestDownload?.url) throw new Error(`Runtime component ${options.component} has no file manifest`)

  let manifestBuffer: Buffer
  try {
    const response = await downloadBuffer({
      urls: [manifestDownload.url],
      size: manifestDownload.size,
      checksum: manifestDownload.sha1
        ? { algorithm: 'sha1', value: manifestDownload.sha1 }
        : undefined,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    })
    manifestBuffer = response.buffer
  } catch (error) {
    if (error instanceof DownloadError) {
      if (error.code === 'checksum-mismatch') {
        throw new Error(`Runtime file manifest SHA-1 mismatch for ${options.component}`, { cause: error })
      }
      if (error.code === 'size-mismatch') {
        throw new Error(
          `Runtime file manifest size mismatch for ${options.component}: ${error.message}`,
          { cause: error },
        )
      }
    }
    throw error
  }

  let parsed: RuntimeFileManifest
  try {
    parsed = JSON.parse(manifestBuffer.toString('utf8')) as RuntimeFileManifest
  } catch {
    throw new Error(`Runtime file manifest for ${options.component} is not valid JSON`)
  }
  const files = parsed?.files
  if (!files || typeof files !== 'object') throw new Error(`Runtime file manifest for ${options.component} has no files`)

  const root = join(options.gameRoot, 'java', options.component)
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
  const installFiles: InstallFile[] = []
  const directories: string[] = []

  for (const [relative, entry] of entries) {
    if (entry.type === 'directory') {
      directories.push(relative)
      continue
    }
    if (entry.type === 'link') {
      logger?.debug('Skipping runtime link entry', { component: options.component, relative })
      continue
    }
    const raw = entry.downloads?.raw
    if (!raw?.url) throw new Error(`Runtime entry ${relative} has no download url`)
    const file: InstallFile = { path: relative, urls: [raw.url] }
    if (raw.size !== undefined) file.size = raw.size
    if (raw.sha1) file.checksum = { algorithm: 'sha1', value: raw.sha1 }
    if (entry.executable) file.executable = true
    installFiles.push(file)
  }

  const tasks: InstallTask[] = []
  if (directories.length > 0) {
    tasks.push({
      type: 'materialize',
      id: 'runtime-directories',
      root,
      operations: directories.map((directory) => ({ type: 'ensure-directory', path: directory })),
    })
  }
  tasks.push({
    type: 'files',
    id: 'runtime-files',
    destination: root,
    files: installFiles,
    ...(directories.length > 0 ? { dependsOn: ['runtime-directories'] } : {}),
  })
  const manifest: InstallManifest = { version: 1, tasks }

  const report = await runInstallManifest(manifest, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    onProgress: (progress) => {
      options.onProgress?.({
        component: options.component,
        completedFiles: progress.completedFiles,
        totalFiles: progress.totalFiles,
        bytes: progress.bytes,
        totalBytes: progress.totalBytes,
        ...(progress.currentFile ? { currentFile: progress.currentFile } : {}),
      })
    },
  })

  const javaPath = join(root, 'bin', platform === 'win32' ? 'java.exe' : 'java')
  await stat(javaPath).catch(() => {
    throw new Error(`Runtime ${options.component} finished without a java executable at ${javaPath}`)
  })

  logger?.info('Runtime installed', {
    component: options.component,
    version: options.entry.version?.name,
    root,
    downloadedBytes: report.downloadedBytes,
  })

  const result: InstalledRuntime = {
    component: options.component,
    root,
    javaPath,
    files: report.files,
    downloadedBytes: report.downloadedBytes,
  }
  if (options.entry.version?.name) result.version = options.entry.version.name
  return result
}
