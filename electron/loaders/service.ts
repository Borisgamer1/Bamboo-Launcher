import type { FetchLike, RetryOptions } from '../download/http'
import type { Logger } from '../logger'
import { withoutTelemetry, type TelemetryService } from '../telemetry'
import { diagnoseInstallation, repairInstallation, type DiagnoseOptions, type RepairOptions } from './diagnose'
import { installFabricLike } from './fabric'
import { installForgeLike } from './forge'
import { installOptifine } from './optifine'
import { listLoaderVersions, resolveLoaderVersion, type LoaderMetadataOptions } from './metadata'
import type {
  LoaderInstallOptions,
  LoaderInstallResult,
  LoaderJavaOption,
  LoaderVersionList,
  LoaderKind,
} from './types'

export interface LoaderServiceOptions {
  gameRoot: () => string
  cacheDir?: string
  logger?: Logger
  fetchImpl?: FetchLike
  retry?: RetryOptions
  java?: LoaderJavaOption
  javaPath?: string
  telemetry?: TelemetryService
}

export type LoaderInstallRequest = Omit<LoaderInstallOptions, 'gameRoot'> & {
  gameRoot?: string
}

export async function installLoader(
  kind: LoaderKind,
  options: LoaderInstallOptions,
): Promise<LoaderInstallResult> {
  if (kind === 'fabric' || kind === 'quilt') return installFabricLike(kind, options)
  if (kind === 'forge' || kind === 'forge-legacy') return installForgeLike('forge', options)
  if (kind === 'neoforge') return installForgeLike('neoforge', options)
  return installOptifine(options)
}

export class LoaderService {
  readonly #getGameRoot: () => string
  readonly #options: LoaderServiceOptions

  constructor(options: LoaderServiceOptions) {
    this.#getGameRoot = options.gameRoot
    this.#options = options
  }

  #common(request: LoaderInstallRequest): LoaderInstallOptions {
    const gameRoot = request.gameRoot ?? this.#getGameRoot()
    return {
      ...request,
      gameRoot,
      ...(request.cacheDir ?? this.#options.cacheDir ? { cacheDir: request.cacheDir ?? this.#options.cacheDir } : {}),
      ...(request.logger ?? this.#options.logger ? { logger: request.logger ?? this.#options.logger } : {}),
      ...(request.fetchImpl ?? this.#options.fetchImpl
        ? { fetchImpl: request.fetchImpl ?? this.#options.fetchImpl }
        : {}),
      ...(request.retry ?? this.#options.retry ? { retry: request.retry ?? this.#options.retry } : {}),
      ...(request.java ?? this.#options.java ? { java: request.java ?? this.#options.java } : {}),
      ...(request.javaPath ?? this.#options.javaPath
        ? { javaPath: request.javaPath ?? this.#options.javaPath }
        : {}),
      ...(request.telemetry ?? this.#options.telemetry
        ? { telemetry: request.telemetry ?? this.#options.telemetry }
        : {}),
    }
  }

  async install(kind: LoaderKind, request: LoaderInstallRequest): Promise<LoaderInstallResult> {
    const options = this.#common(request)
    const telemetry = options.telemetry
    if (!telemetry) return installLoader(kind, options)
    return telemetry.measure('loader', () => installLoader(kind, withoutTelemetry(options)))
  }

  async listVersions(
    kind: LoaderKind,
    minecraftVersion: string,
    options: Partial<LoaderMetadataOptions> = {},
  ): Promise<LoaderVersionList> {
    return listLoaderVersions(kind, {
      minecraftVersion,
      ...(this.#options.cacheDir ? { cacheDir: this.#options.cacheDir } : {}),
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      ...(this.#options.retry ? { retry: this.#options.retry } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
      ...options,
    })
  }

  async resolveVersion(
    kind: LoaderKind,
    minecraftVersion: string,
    requested?: string,
    options: Partial<LoaderMetadataOptions> = {},
  ) {
    return resolveLoaderVersion(kind, {
      minecraftVersion,
      ...(requested ? { requested } : {}),
      ...(this.#options.cacheDir ? { cacheDir: this.#options.cacheDir } : {}),
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      ...(this.#options.retry ? { retry: this.#options.retry } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
      ...options,
    })
  }

  async diagnose(versionId: string, options: Omit<DiagnoseOptions, 'gameRoot' | 'versionId'> = {}) {
    return diagnoseInstallation({
      gameRoot: this.#getGameRoot(),
      versionId,
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
      ...options,
    })
  }

  async repair(request: Omit<RepairOptions, 'gameRoot'> & { gameRoot?: string }) {
    const gameRoot = request.gameRoot ?? this.#getGameRoot()
    return repairInstallation({
      ...request,
      gameRoot,
      ...(request.cacheDir ?? this.#options.cacheDir
        ? { cacheDir: request.cacheDir ?? this.#options.cacheDir }
        : {}),
      ...(request.logger ?? this.#options.logger
        ? { logger: request.logger ?? this.#options.logger }
        : {}),
      ...(request.fetchImpl ?? this.#options.fetchImpl
        ? { fetchImpl: request.fetchImpl ?? this.#options.fetchImpl }
        : {}),
      ...(request.retry ?? this.#options.retry ? { retry: request.retry ?? this.#options.retry } : {}),
      ...(request.java ?? this.#options.java ? { java: request.java ?? this.#options.java } : {}),
      ...(request.javaPath ?? this.#options.javaPath
        ? { javaPath: request.javaPath ?? this.#options.javaPath }
        : {}),
    })
  }
}
