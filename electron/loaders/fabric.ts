import { LoaderError } from './errors'
import { fetchJson } from './http'
import {
  DEFAULT_FABRIC_META,
  DEFAULT_QUILT_META,
  listLoaderVersions,
  pickLoaderVersion,
} from './metadata'
import {
  ensureBaseVersion,
  hasVersionJson,
  requireLoaderVersion,
  readMarker,
  writeMarker,
  writeVersionJson,
  installModelFiles,
  versionJsonPath,
  executorOptions,
} from './common'
import { LoaderTransaction } from './transaction'
import { resolveVersionModel } from '../version/resolve'
import type { InstallReport } from '../download/types'
import type { LoaderInstallOptions, LoaderInstallResult, LoaderKind } from './types'

type ProfileKind = 'fabric' | 'quilt'

export interface FabricProfileJson {
  id?: string
  inheritsFrom?: string
  mainClass?: string
  libraries?: unknown[]
  arguments?: Record<string, unknown>
  [key: string]: unknown
}

export function fabricLoaderVersionId(kind: ProfileKind, minecraftVersion: string, loaderVersion: string): string {
  return `${kind}-loader-${loaderVersion}-${minecraftVersion}`
}

export async function fetchFabricLikeProfile(
  kind: ProfileKind,
  options: LoaderInstallOptions & { loaderVersion: string; metaBase?: string },
): Promise<FabricProfileJson> {
  const base = options.metaBase ?? (kind === 'fabric' ? DEFAULT_FABRIC_META : DEFAULT_QUILT_META)
  const prefix = kind === 'fabric' ? '/v2' : '/v3'
  const url = `${base}${prefix}/versions/loader/${options.minecraftVersion}/${options.loaderVersion}/profile/json`
  const profile = await fetchJson<FabricProfileJson>(url, context(options))
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile.libraries)) {
    throw new LoaderError('profile', `Ungültiges ${kind}-Profil für ${options.minecraftVersion}`, {
      loader: kind,
    })
  }
  return profile
}

function context(options: LoaderInstallOptions) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  }
}

export async function installFabricLike(
  kind: ProfileKind,
  options: LoaderInstallOptions,
): Promise<LoaderInstallResult> {
  const gameRoot = options.gameRoot
  const minecraftVersion = options.minecraftVersion
  const transaction = new LoaderTransaction(gameRoot, kind)
  let downloadedBytes = 0
  let skippedFiles = 0
  const processorsRun = 0

  options.onEvent?.({ type: 'status', message: `${kind === 'fabric' ? 'Fabric' : 'Quilt'}-Version wird ermittelt…` })
  let loaderVersion = options.loaderVersion
  if (!loaderVersion) {
    const list = await listLoaderVersions(kind as LoaderKind, {
      minecraftVersion,
      ...(options.metaBase ? { metaBase: options.metaBase } : {}),
      ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
      ...context(options),
    })
    loaderVersion = pickLoaderVersion(list.versions)?.version
    if (!loaderVersion) {
      throw new LoaderError('version-not-found', `Kein ${kind}-Loader für ${minecraftVersion} verfügbar`, {
        loader: kind,
      })
    }
  }
  const version = requireLoaderVersion(loaderVersion, kind)
  const versionId = options.versionId ?? fabricLoaderVersionId(kind, minecraftVersion, version)

  const result = await transaction.run<{
    model: Awaited<ReturnType<typeof resolveVersionModel>>
    report: InstallReport
    alreadyInstalled: boolean
  }>(async () => {
    if (options.signal?.aborted) throw new LoaderError('aborted', 'Loader-Installation abgebrochen')
    await ensureBaseVersion(gameRoot, minecraftVersion, options)

    const marker = await readMarker(gameRoot, versionId)
    const jsonExists = await hasVersionJson(gameRoot, versionId)
    const repeat =
      jsonExists &&
      marker?.loader === kind &&
      marker.loaderVersion === version &&
      marker.minecraftVersion === minecraftVersion

    if (!repeat) {
      options.onProgress?.({ phase: 'profile', message: `${kind}-Profil wird geschrieben`, loader: kind })
      const profile = await fetchFabricLikeProfile(kind, { ...options, loaderVersion: version, ...(options.metaBase ? { metaBase: options.metaBase } : {}) })
      const content: FabricProfileJson = {
        ...profile,
        id: versionId,
        inheritsFrom: profile.inheritsFrom ?? minecraftVersion,
      }
      await writeVersionJson(transaction, gameRoot, versionId, content)
      await writeMarker(transaction, gameRoot, versionId, {
        loader: kind,
        loaderVersion: version,
        minecraftVersion,
        versionId,
        installedAt: new Date().toISOString(),
        ...(options.metaBase ? { metaBase: options.metaBase } : {}),
      })
    } else {
      options.onProgress?.({ phase: 'profile', message: `${kind} ist bereits installiert, prüfe Dateien`, loader: kind })
    }

    const model = await resolveVersionModel(gameRoot, versionId, {
      ...(options.logger ? { logger: options.logger.child('resolve') } : {}),
    })
    options.onProgress?.({ phase: 'inputs', message: 'Bibliotheken werden geprüft', loader: kind })
    const report = await installModelFiles(gameRoot, model, options, `${kind}-${version}`)
    downloadedBytes = report.downloadedBytes
    skippedFiles = report.skippedFiles
    return {
      model,
      report,
      alreadyInstalled: repeat && report.downloadedFiles === 0,
    }
  })

  return {
    loader: kind,
    versionId,
    minecraftVersion,
    loaderVersion: version,
    model: result.model,
    alreadyInstalled: result.alreadyInstalled,
    filesReport: result.report,
    downloadedBytes,
    skippedFiles,
    processorsRun,
    processorOutputs: 0,
    warnings: [],
  }
}

export function fabricVersionJsonPath(gameRoot: string, versionId: string): string {
  return versionJsonPath(gameRoot, versionId)
}

export { executorOptions }
