import { ModError } from './errors'
import type { ProviderCacheOptions } from './provider-cache'
import type {
  FileKey,
  ModLoader,
  ProviderDownload,
  ProviderDownloadRequest,
  ProviderId,
  ProviderProject,
  ProviderSearchPage,
  ProviderSearchQuery,
  ProviderVersion,
  UpdateChannel,
} from './types'

export interface ProviderRequestOptions {
  bypassCache?: boolean
}

export interface ProviderVersionTarget {
  minecraftVersion?: string
  loader?: ModLoader
  gameVersionTypeId?: number
}

export interface ProviderOptions {
  cache?: ProviderCacheOptions
}

const CHANNEL_RANK: Record<UpdateChannel, number> = { release: 0, beta: 1, alpha: 2 }

export function lessStableChannel(left: UpdateChannel, right: UpdateChannel): UpdateChannel {
  return CHANNEL_RANK[left] >= CHANNEL_RANK[right] ? left : right
}

export function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }
  return chunks
}

export interface UpdateLookup {
  key: string
  projectId: string
  versionId?: string
  fileId?: string
  sha1?: string
  channel?: UpdateChannel
}

export interface ProviderUpdate {
  projectId: string
  versionId: string
  fileId?: string
  publishedAt?: string
  channel: UpdateChannel
}

export interface ModProvider {
  readonly id: ProviderId
  search(query: ProviderSearchQuery, options?: ProviderRequestOptions): Promise<ProviderSearchPage>
  project(projectId: string, options?: ProviderRequestOptions): Promise<ProviderProject>
  versions(
    projectId: string,
    target?: ProviderVersionTarget,
    options?: ProviderRequestOptions,
  ): Promise<ProviderVersion[]>
  version(
    projectId: string,
    versionId: string,
    options?: ProviderRequestOptions,
  ): Promise<ProviderVersion>
  filesByIds(keys: FileKey[], options?: ProviderRequestOptions): Promise<ProviderVersion[]>
  /**
   * Resolves a URL that can actually be downloaded. Modrinth always carries one in
   * its metadata; CurseForge may withhold it, so the adapter walks metadata →
   * `download-url` → CDN fallback and reports which path it used.
   */
  download(
    request: ProviderDownloadRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderDownload>
  checkUpdates(
    files: UpdateLookup[],
    target: ProviderVersionTarget,
    options?: ProviderRequestOptions,
  ): Promise<Map<string, ProviderUpdate>>
}

export function assertFileKeys(keys: FileKey[], provider: ProviderId): void {
  for (const key of keys) {
    if (key.provider !== provider) {
      throw new ModError('provider-error', `File key belongs to ${key.provider}, not ${provider}`, {
        projectId: key.projectId,
      })
    }
    if (!key.fileId && !key.sha1) {
      throw new ModError('provider-error', 'File key needs a fileId or a sha1', {
        projectId: key.projectId,
      })
    }
  }
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}
