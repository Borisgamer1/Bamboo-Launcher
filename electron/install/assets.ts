import { join } from 'node:path'
import type { InstallReport, InstallFile, InstallFilesTask } from '../download/types'
import { runInstallManifest, type ExecutorOptions } from '../download/executor'
import { DownloadError } from '../download/http'
import type { Logger } from '../logger'
import { ASSET_OBJECT_BASE_URL, type ResolvedAssets, resolveAssets } from '../version/assets'
import type { ResolvedVersionModel } from '../version/resolve'

export interface AssetInstallOptions extends ExecutorOptions {
  logger?: Logger
  objectBaseUrls?: string[]
}

export interface AssetInstallResult {
  assets: ResolvedAssets
  indexReport?: InstallReport
  objectsReport: InstallReport
  downloadedBytes: number
  skippedFiles: number
}

const EMPTY_REPORT: InstallReport = {
  tasks: 0,
  files: 0,
  downloadedFiles: 0,
  skippedFiles: 0,
  bytes: 0,
  downloadedBytes: 0,
  durationMs: 0,
}

function indexTask(gameRoot: string, model: ResolvedVersionModel): InstallFilesTask {
  const info = model.assetIndex
  if (!info?.url) {
    throw new DownloadError(
      'invalid',
      `Version ${model.id} has no asset index URL; cannot install assets/${model.assets.id}.json`,
    )
  }
  const file: InstallFile = { path: `${model.assets.id}.json`, urls: [info.url] }
  if (info.size !== undefined) file.size = info.size
  if (info.sha1) file.checksum = { algorithm: 'sha1', value: info.sha1 }
  file.validator = 'json'
  return {
    type: 'files',
    id: 'asset-index',
    destination: join(gameRoot, 'assets', 'indexes'),
    files: [file],
  }
}

export async function installAssets(
  gameRoot: string,
  model: ResolvedVersionModel,
  options: AssetInstallOptions = {},
): Promise<AssetInstallResult> {
  let assets = model.assets
  let indexReport: InstallReport | undefined

  if (!assets.available) {
    indexReport = await runInstallManifest({ version: 1, tasks: [indexTask(gameRoot, model)] }, options)
    assets = await resolveAssets({
      gameRoot,
      indexId: model.assets.id,
      assetsField: model.assets.legacyVirtual ? 'legacy' : undefined,
      indexInfo: model.assetIndex,
      logger: options.logger,
    })
    if (!assets.available) {
      throw new DownloadError(
        'invalid',
        `Asset index ${model.assets.id} is still unavailable after downloading it`,
      )
    }
  }

  let objectsReport = EMPTY_REPORT
  if (assets.objects.length > 0) {
    const bases = (options.objectBaseUrls ?? [ASSET_OBJECT_BASE_URL]).map((base) =>
      base.endsWith('/') ? base.slice(0, -1) : base,
    )
    const unique = new Map<string, InstallFile>()
    for (const object of assets.objects) {
      if (unique.has(object.path)) continue
      unique.set(object.path, {
        path: object.path,
        urls: bases.map((base) => `${base}/${object.path.slice('objects/'.length)}`),
        size: object.size,
        checksum: { algorithm: 'sha1', value: object.hash },
      })
    }
    const files = [...unique.values()]
    objectsReport = await runInstallManifest(
      {
        version: 1,
        tasks: [
          {
            type: 'files',
            id: 'asset-objects',
            destination: join(gameRoot, 'assets'),
            files,
          },
        ],
      },
      options,
    )
  }

  return {
    assets,
    ...(indexReport ? { indexReport } : {}),
    objectsReport,
    downloadedBytes: (indexReport?.downloadedBytes ?? 0) + objectsReport.downloadedBytes,
    skippedFiles: (indexReport?.skippedFiles ?? 0) + objectsReport.skippedFiles,
  }
}
