import type { Logger } from '../logger'
import type { FetchLike } from '../download/http'
import {
  type FeatureSet,
  type PlatformInfo,
  currentPlatform,
} from './rules'
import { type ResolvedVersionModel, listInstalledVersions, resolveVersionModel } from './resolve'
import { VersionManifestService } from './manifest'

export interface VersionResolverOptions {
  gameRoot: string
  cacheDir: string
  fetchImpl?: FetchLike
  sources?: string[]
  logger?: Logger
  platform?: PlatformInfo
  maxDepth?: number
  maxManifestAgeMs?: number
}

export class VersionResolver {
  readonly manifest: VersionManifestService
  #gameRoot: string
  #platform: PlatformInfo
  #maxDepth: number
  #logger?: Logger

  constructor(options: VersionResolverOptions) {
    this.#gameRoot = options.gameRoot
    this.#platform = options.platform ?? currentPlatform()
    this.#maxDepth = options.maxDepth ?? 8
    this.#logger = options.logger
    this.manifest = new VersionManifestService({
      cacheDir: options.cacheDir,
      fetchImpl: options.fetchImpl,
      sources: options.sources,
      logger: options.logger?.child('manifest'),
      maxAgeMs: options.maxManifestAgeMs,
    })
  }

  async resolve(
    versionId: string,
    options: { platform?: PlatformInfo; features?: FeatureSet } = {},
  ): Promise<ResolvedVersionModel> {
    return resolveVersionModel(this.#gameRoot, versionId, {
      platform: options.platform ?? this.#platform,
      features: options.features,
      maxDepth: this.#maxDepth,
      logger: this.#logger,
    })
  }

  async listInstalled(): Promise<string[]> {
    return listInstalledVersions(this.#gameRoot)
  }
}
