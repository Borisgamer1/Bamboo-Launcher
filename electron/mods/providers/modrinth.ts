import { ModError } from '../errors'
import { MODRINTH_LOADER_NAMES } from '../loaders'
import { modsMetrics } from '../metrics'
import { ModrinthClient, type ModrinthSearchHit } from '../modrinth'
import { cacheKey, ProviderCache } from '../provider-cache'
import {
  assertFileKeys,
  chunked,
  uniqueSorted,
  type ModProvider,
  type ProviderOptions,
  type ProviderRequestOptions,
  type ProviderUpdate,
  type ProviderVersionTarget,
  type UpdateLookup,
} from '../provider'
import type {
  FileKey,
  ProviderDownload,
  ProviderDownloadRequest,
  ProviderProject,
  ProviderSearchHit,
  ProviderSearchPage,
  ProviderSearchQuery,
  ProviderVersion,
  UpdateChannel,
} from '../types'

function modrinthFacets(query: ProviderSearchQuery): string[][] {
  const groups: string[][] = []
  if (query.projectType) groups.push([`project_type:${query.projectType.toLowerCase()}`])
  const loaders = uniqueSorted(
    (query.loaders ?? [])
      .map((loader) => MODRINTH_LOADER_NAMES[loader])
      .filter((value): value is string => Boolean(value))
      .map((value) => `categories:${value}`),
  )
  if (loaders.length > 0) groups.push(loaders)
  const categories = uniqueSorted(
    (query.categories ?? []).map((category) => `categories:${category.toLowerCase()}`),
  )
  if (categories.length > 0) groups.push(categories)
  const versions = uniqueSorted(
    (query.gameVersions ?? []).map((version) => `versions:${version}`),
  )
  if (versions.length > 0) groups.push(versions)
  return groups
}

function sha1FromKey(key: { sha1?: string; projectId: string }): string {
  const sha1 = key.sha1?.trim().toLowerCase()
  if (!sha1 || !/^[a-f0-9]{40}$/.test(sha1)) {
    throw new ModError('provider-error', `Invalid SHA-1 in file key: ${key.sha1 ?? ''}`, {
      projectId: key.projectId,
    })
  }
  return sha1
}

const UPDATE_BATCH_SIZE = 100

const CHANNEL_STAGES: Record<UpdateChannel, UpdateChannel[][]> = {
  release: [['release'], ['beta'], ['alpha']],
  beta: [['release', 'beta'], ['alpha']],
  alpha: [['release', 'beta', 'alpha']],
}

function modrinthHit(hit: ModrinthSearchHit): ProviderSearchHit {
  return {
    id: hit.projectId,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    provider: 'modrinth',
    versions: hit.versions,
    ...(hit.projectType ? { projectType: hit.projectType } : {}),
    ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}),
    ...(hit.author ? { author: hit.author } : {}),
    ...(hit.categories ? { categories: hit.categories } : {}),
    ...(hit.downloads !== undefined ? { downloads: hit.downloads } : {}),
    ...(hit.follows !== undefined ? { follows: hit.follows } : {}),
  }
}

export class ModrinthProvider implements ModProvider {
  readonly id = 'modrinth' as const
  readonly #client: ModrinthClient
  readonly #cache: ProviderCache

  constructor(client: ModrinthClient, options: ProviderOptions = {}) {
    this.#client = client
    this.#cache = new ProviderCache({ metrics: modsMetrics, ...options.cache })
  }

  async search(
    query: ProviderSearchQuery,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderSearchPage> {
    const text = (query.query ?? '').trim().toLowerCase()
    const limit = Math.min(100, Math.max(1, query.limit ?? 20))
    const offset = Math.max(0, query.offset ?? 0)
    const facets = modrinthFacets(query)
    const key = cacheKey('modrinth', 'search', {
      query: text,
      facets,
      sort: query.sort ?? 'relevance',
    })
    return this.#cache.search(
      key,
      `${offset}:${limit}`,
      async () => {
        const page = await this.#client.searchPage(text, {
          limit,
          offset,
          facets,
          ...(query.sort ? { index: query.sort } : {}),
        })
        return {
          // A response may carry more than the requested page; only the page the
          // caller asked for is ever materialised.
          hits: page.hits.slice(0, limit).map(modrinthHit),
          offset: page.offset,
          limit: page.limit,
          total: page.total,
        }
      },
      options.bypassCache,
    )
  }

  async project(
    projectId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderProject> {
    const id = projectId.trim()
    if (!id) throw new ModError('provider-error', 'Missing Modrinth project id')
    return this.#cache.metadata(
      cacheKey('modrinth', 'project', { id }),
      async () => ({ ...(await this.#client.project(id)), provider: 'modrinth' }),
      options.bypassCache,
    )
  }

  async versions(
    projectId: string,
    target: ProviderVersionTarget = {},
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion[]> {
    const id = projectId.trim()
    if (!id) throw new ModError('provider-error', 'Missing Modrinth project id')
    return this.#cache.metadata(
      cacheKey('modrinth', 'versions', {
        id,
        minecraftVersion: target.minecraftVersion ?? null,
        loader: target.loader ?? null,
      }),
      () =>
        this.#client.versions(id, {
          ...(target.minecraftVersion ? { minecraftVersion: target.minecraftVersion } : {}),
          ...(target.loader ? { loader: target.loader } : {}),
        }),
      options.bypassCache,
    )
  }

  async version(
    _projectId: string,
    versionId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion> {
    const id = versionId.trim()
    if (!id) throw new ModError('provider-error', 'Missing Modrinth version id')
    return this.#cache.metadata(
      cacheKey('modrinth', 'version', { id }),
      () => this.#client.version(id),
      options.bypassCache,
    )
  }

  async filesByIds(
    keys: FileKey[],
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion[]> {
    assertFileKeys(keys, 'modrinth')
    const hashes = [...new Set(keys.map(sha1FromKey))]
    if (hashes.length === 0) return []
    const found = await this.#cache.metadata(
      cacheKey('modrinth', 'files', { hashes }),
      () => this.#client.versionsByHashes(hashes),
      options.bypassCache,
    )
    return hashes
      .map((hash) => found[hash])
      .filter((version): version is ProviderVersion => Boolean(version))
  }

  async download(
    request: ProviderDownloadRequest,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderDownload> {
    const version =
      request.version ?? (await this.version(request.projectId, request.versionId, options))
    const file = version.files.find((entry) => entry.primary) ?? version.files[0]
    if (!file?.url) {
      throw new ModError('provider-error', `Modrinth version ${version.id} has no download URL`, {
        projectId: request.projectId,
        versionId: request.versionId,
      })
    }
    // Modrinth serves one URL per file and has no CDN route to fall back to, so a
    // second round can only report that there is nothing else to try.
    if (request.excludeUrl === file.url) {
      throw new ModError(
        'provider-error',
        `Modrinth version ${version.id} has no download URL besides the failed one`,
        { projectId: request.projectId, versionId: request.versionId },
      )
    }
    return {
      url: file.url,
      filename: file.filename,
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.hashes ? { hashes: file.hashes } : {}),
      source: 'metadata',
    }
  }

  async checkUpdates(
    files: UpdateLookup[],
    target: ProviderVersionTarget,
  ): Promise<Map<string, ProviderUpdate>> {
    const minecraftVersion = target.minecraftVersion?.trim()
    if (!minecraftVersion) {
      throw new ModError('provider-error', 'Modrinth update checks need a Minecraft version')
    }
    const groups = new Map<UpdateChannel, UpdateLookup[]>()
    for (const file of files) {
      const channel = file.channel ?? 'release'
      const group = groups.get(channel)
      if (group) group.push(file)
      else groups.set(channel, [file])
    }

    const found = new Map<string, ProviderUpdate>()
    for (const [channel, group] of groups) {
      let pending = group
      for (const stage of CHANNEL_STAGES[channel]) {
        if (pending.length === 0) break
        const unresolved: UpdateLookup[] = []
        for (const batch of chunked(pending, UPDATE_BATCH_SIZE)) {
          const versions = await this.#client.updateMany(
            batch.map(sha1FromKey),
            {
              minecraftVersion,
              ...(target.loader ? { loader: target.loader } : {}),
            },
            stage,
          )
          for (const lookup of batch) {
            const version = versions[lookup.sha1?.trim().toLowerCase() ?? '']
            if (!version) {
              unresolved.push(lookup)
              continue
            }
            const primary = version.files.find((file) => file.primary) ?? version.files[0]
            found.set(lookup.key, {
              projectId: version.projectId,
              versionId: version.id,
              ...(primary ? { fileId: primary.id } : {}),
              ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
              channel: version.channel ?? 'release',
            })
          }
        }
        pending = unresolved
      }
    }
    return found
  }
}
