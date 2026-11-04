import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runInstallManifest, type ExecutorOptions } from '../download/executor'
import { DownloadError } from '../download/http'
import type { InstallFile, InstallManifest, InstallReport, InstallTask } from '../download/types'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { withoutTelemetry, type TelemetryService } from '../telemetry'
import { VersionManifestService } from '../version/manifest'
import { resolveVersionModel, type ResolvedVersionModel } from '../version/resolve'
import { installAssets, type AssetInstallResult } from './assets'

export interface VersionInstallOptions extends ExecutorOptions {
  cacheDir: string
  manifest?: VersionManifestService
  manifestSources?: string[]
  logger?: Logger
  objectBaseUrls?: string[]
  withAssets?: boolean
  telemetry?: TelemetryService
}

export interface VersionInstallResult {
  model: ResolvedVersionModel
  versionJsonDownloaded: boolean
  filesReport: InstallReport
  assets?: AssetInstallResult
  downloadedBytes: number
  skippedFiles: number
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch (error) {
    getDefaultLogger().child('install:version').debug('file probe failed; treating as missing', {
      target,
      error: describeError(error),
    })
    return false
  }
}

function libraryFiles(model: ResolvedVersionModel): InstallFile[] {
  const files = new Map<string, InstallFile>()
  for (const library of [...model.libraries, ...model.natives]) {
    if (!library.url) continue
    const file: InstallFile = {
      path: `libraries/${library.path}`,
      urls: [library.url],
      validator: 'zip',
    }
    if (library.size !== undefined) file.size = library.size
    if (library.sha1) file.checksum = { algorithm: 'sha1', value: library.sha1 }
    files.set(file.path, file)
  }
  return [...files.values()]
}

export async function installVersion(
  gameRoot: string,
  versionId: string,
  options: VersionInstallOptions,
): Promise<VersionInstallResult> {
  if (!options.telemetry) return installVersionInternal(gameRoot, versionId, options)
  return options.telemetry.measure('install', () =>
    installVersionInternal(gameRoot, versionId, withoutTelemetry(options)),
  )
}

async function installVersionInternal(
  gameRoot: string,
  versionId: string,
  options: VersionInstallOptions,
): Promise<VersionInstallResult> {
  const logger = options.logger
  const versionDir = join(gameRoot, 'versions', versionId)
  const versionFile = join(versionDir, `${versionId}.json`)
  let versionJsonDownloaded = false

  if (!(await fileExists(versionFile))) {
    const manifestService =
      options.manifest ??
      new VersionManifestService({
        cacheDir: options.cacheDir,
        fetchImpl: options.fetchImpl,
        sources: options.manifestSources,
        logger: logger?.child('manifest'),
      })
    const manifest = await manifestService.get()
    const entry = manifest.manifest.versions.find((candidate) => candidate.id === versionId)
    if (!entry) {
      throw new DownloadError(
        'invalid',
        `Version ${versionId} is not present in the Minecraft version manifest`,
      )
    }
    const file: InstallFile = { path: `${versionId}.json`, urls: [entry.url], validator: 'json' }
    if (entry.sha1) file.checksum = { algorithm: 'sha1', value: entry.sha1 }
    const task: InstallTask = {
      type: 'files',
      id: 'version-json',
      destination: versionDir,
      files: [file],
    }
    await runInstallManifest({ version: 1, tasks: [task] }, options)
    versionJsonDownloaded = true
  }

  let model = await resolveVersionModel(gameRoot, versionId, { logger })
  const client = model.downloads.client
  if (!client?.url) {
    throw new DownloadError('invalid', `Version ${versionId} has no client jar download`)
  }

  const clientFile: InstallFile = {
    path: `versions/${model.jarVersion}/${model.jarVersion}.jar`,
    urls: [client.url],
    validator: 'zip',
  }
  if (client.size !== undefined) clientFile.size = client.size
  if (client.sha1) clientFile.checksum = { algorithm: 'sha1', value: client.sha1 }

  const tasks: InstallTask[] = [
    {
      type: 'files',
      id: 'version-files',
      destination: gameRoot,
      files: [clientFile, ...libraryFiles(model)],
    },
  ]
  const manifest: InstallManifest = { version: 1, tasks }
  const filesReport = await runInstallManifest(manifest, options)

  let assets: AssetInstallResult | undefined
  if (options.withAssets !== false) {
    assets = await installAssets(gameRoot, model, {
      ...options,
      logger,
    })
    model = await resolveVersionModel(gameRoot, versionId, { logger })
  }

  return {
    model,
    versionJsonDownloaded,
    filesReport,
    ...(assets ? { assets } : {}),
    downloadedBytes: filesReport.downloadedBytes + (assets?.downloadedBytes ?? 0),
    skippedFiles: filesReport.skippedFiles + (assets?.skippedFiles ?? 0),
  }
}
