import { ModError } from '../errors'
import { CURSEFORGE_LOADER_IDS, loadersFromGameVersions, minecraftVersions } from '../loaders'
import {
  CURSEFORGE_CLASS_ID_TO_TYPE,
  curseForgeClassIdFor,
} from '../../shared/curseforgeClassIds'
import {
  CurseForgeClient,
  type CurseForgeFile,
  type CurseForgeMod,
  type CurseForgeSearchHit,
} from '../curseforge'
import { modsMetrics } from '../metrics'
import { cacheKey, ProviderCache } from '../provider-cache'
import {
  assertFileKeys,
  chunked,
  lessStableChannel,
  uniqueSorted,
  type ModProvider,
  type ProviderOptions,
  type ProviderRequestOptions,
  type ProviderUpdate,
  type ProviderVersionTarget,
  type UpdateLookup,
} from '../provider'
import type {
  DependencyKind,
  FileKey,
  ProviderDependency,
  ProviderDownload,
  ProviderDownloadRequest,
  ProviderFile,
  ProviderFingerprintResult,
  ProviderProject,
  ProviderSearchHit,
  ProviderSearchPage,
  ProviderSearchQuery,
  ProviderVersion,
  UpdateChannel,
} from '../types'

const CURSEFORGE_SORT_FIELDS: Record<string, number> = {
  relevance: 2,
  downloads: 6,
  follows: 2,
  newest: 11,
  updated: 3,
}

const CURSEFORGE_MAX_VERSION_PAGES = 200

const CURSEFORGE_RELATIONS: Record<number, DependencyKind> = {
  1: 'embedded',
  2: 'optional',
  3: 'required',
  4: 'tool',
  5: 'incompatible',
  6: 'include',
}

function channelFromReleaseType(releaseType: number): 'release' | 'beta' | 'alpha' {
  return releaseType === 2 ? 'beta' : releaseType === 3 ? 'alpha' : 'release'
}

const CHANNEL_STAGES: Record<UpdateChannel, number[][]> = {
  release: [[1], [1, 2], [1, 2, 3]],
  beta: [[1, 2], [1, 2, 3]],
  alpha: [[1, 2, 3]],
}

export function curseForgeDependencyKind(relationType: number): DependencyKind {
  return CURSEFORGE_RELATIONS[relationType] ?? 'optional'
}

export function providerVersionFromCurseForgeFile(file: CurseForgeFile): ProviderVersion {
  const hashes: Record<string, string> = {}
  for (const hash of file.hashes) {
    const algorithm = hash.algo === 1 ? 'sha1' : hash.algo === 2 ? 'md5' : undefined
    if (algorithm && hash.value) hashes[algorithm] = hash.value.toLowerCase()
  }
  const dependencies: ProviderDependency[] = file.dependencies.map((dependency) => ({
    ...(dependency.modId > 0 ? { projectId: String(dependency.modId) } : {}),
    type: curseForgeDependencyKind(dependency.relationType),
  }))
  const download: ProviderFile = {
    id: String(file.id),
    filename: file.fileName,
    primary: true,
    ...(file.downloadUrl ? { url: file.downloadUrl } : {}),
    ...(file.fileLength > 0 ? { size: file.fileLength } : {}),
    ...(Object.keys(hashes).length > 0 ? { hashes } : {}),
  }
  return {
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName || file.fileName,
    versionNumber: file.displayName || file.fileName,
    gameVersions: minecraftVersions(file.gameVersions),
    loaders: loadersFromGameVersions(file.gameVersions),
    files: [download],
    dependencies,
    ...(file.fileDate ? { publishedAt: file.fileDate } : {}),
    channel: channelFromReleaseType(file.releaseType),
  }
}

function curseForgeHit(hit: CurseForgeSearchHit): ProviderSearchHit {
  return {
    id: String(hit.id),
    slug: hit.slug,
    title: hit.name,
    description: hit.summary,
    provider: 'curseforge',
    versions: uniqueSorted(
      minecraftVersions(hit.latestFilesIndexes.map((entry) => entry.gameVersion)),
    ),
    ...(hit.classId !== undefined && CURSEFORGE_CLASS_ID_TO_TYPE[hit.classId]
      ? { projectType: CURSEFORGE_CLASS_ID_TO_TYPE[hit.classId] }
      : {}),
    ...(hit.iconUrl ? { iconUrl: hit.iconUrl } : {}),
    ...(hit.author ? { author: hit.author } : {}),
    ...(hit.categories ? { categories: hit.categories } : {}),
    ...(hit.downloadCount !== undefined ? { downloads: hit.downloadCount } : {}),
    ...(hit.allowModDistribution !== undefined
      ? { allowModDistribution: hit.allowModDistribution }
      : {}),
  }
}

function numericId(value: string, kind: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ModError('provider-error', `Invalid CurseForge ${kind} id: ${value}`, {
      [kind]: value,
    })
  }
  return id
}

export class CurseForgeProvider implements ModProvider {
  readonly id = 'curseforge' as const
  readonly #client: CurseForgeClient
  readonly #cache: ProviderCache

  constructor(client: CurseForgeClient, options: ProviderOptions = {}) {
    this.#client = client
    this.#cache = new ProviderCache({ metrics: modsMetrics, ...options.cache })
  }

  async search(
    query: ProviderSearchQuery,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderSearchPage> {
    if (query.categories?.length) {
      throw new ModError(
        'provider-error',
        'CurseForge categories are numeric ids; Modrinth category slugs are not accepted',
        { categories: query.categories },
      )
    }
    const text = (query.query ?? '').trim().toLowerCase()
    const limit = Math.min(50, Math.max(1, query.limit ?? 20))
    const offset = Math.max(0, query.offset ?? 0)
    const gameVersions = uniqueSorted(query.gameVersions ?? []).slice(0, 4)
    const loaderIds = uniqueSorted(
      (query.loaders ?? [])
        .map((loader) => CURSEFORGE_LOADER_IDS[loader])
        .filter((value): value is number => value !== undefined)
        .map(String),
    ).map(Number)
    const projectType = query.projectType?.toLowerCase()
    const classId = projectType ? curseForgeClassIdFor(projectType) : undefined
    const sortField = CURSEFORGE_SORT_FIELDS[query.sort ?? 'relevance'] ?? 2
    const key = cacheKey('curseforge', 'search', {
      query: text,
      gameVersions,
      loaderIds,
      gameVersionTypeId: query.gameVersionTypeId ?? null,
      classId: classId ?? null,
      sortField,
    })
    return this.#cache.search(
      key,
      `${offset}:${limit}`,
      async () => {
        const page = await this.#client.search({
          searchFilter: text,
          index: offset,
          pageSize: limit,
          ...(classId !== undefined ? { classId } : {}),
          ...(gameVersions.length === 1
            ? { gameVersion: gameVersions[0] }
            : gameVersions.length > 1
              ? { gameVersions }
              : {}),
          ...(loaderIds.length === 1
            ? { modLoaderType: loaderIds[0] }
            : loaderIds.length > 1
              ? { modLoaderTypes: loaderIds }
              : {}),
          ...(query.gameVersionTypeId !== undefined
            ? { gameVersionTypeId: query.gameVersionTypeId }
            : {}),
          sortField,
          sortOrder: 'desc',
        })
        return {
          hits: page.hits.map(curseForgeHit),
          offset: page.index,
          limit: page.pageSize,
          total: page.totalCount,
        }
      },
      options.bypassCache,
    )
  }

  async project(
    projectId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderProject> {
    const id = numericId(projectId, 'project')
    return this.#cache.metadata(
      cacheKey('curseforge', 'project', { id }),
      async () => {
        const mod = await this.#client.mod(id)
        return {
          id: String(mod.id),
          slug: mod.slug,
          title: mod.name,
          description: mod.summary,
          provider: 'curseforge',
          ...(mod.classId !== undefined && CURSEFORGE_CLASS_ID_TO_TYPE[mod.classId]
            ? { projectType: CURSEFORGE_CLASS_ID_TO_TYPE[mod.classId] }
            : {}),
          ...(mod.iconUrl ? { iconUrl: mod.iconUrl } : {}),
          ...(mod.author ? { author: mod.author } : {}),
          ...(mod.categories?.length ? { categories: mod.categories } : {}),
          ...(mod.downloadCount !== undefined ? { downloads: mod.downloadCount } : {}),
          ...(mod.allowModDistribution !== undefined
            ? { allowModDistribution: mod.allowModDistribution }
            : {}),
        }
      },
      options.bypassCache,
    )
  }

  async versions(
    projectId: string,
    target: ProviderVersionTarget = {},
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion[]> {
    const id = numericId(projectId, 'project')
    return this.#cache.metadata(
      cacheKey('curseforge', 'versions', {
        id,
        minecraftVersion: target.minecraftVersion ?? null,
        loader: target.loader ?? null,
        gameVersionTypeId: target.gameVersionTypeId ?? null,
      }),
      async () => {
        const byId = new Map<number, CurseForgeFile>()
        for (let page = 0; page < CURSEFORGE_MAX_VERSION_PAGES; page += 1) {
          const index = page * 50
          const result = await this.#client.filesPage(id, {
            ...(target.minecraftVersion ? { gameVersion: target.minecraftVersion } : {}),
            ...(target.loader ? { loader: target.loader } : {}),
            ...(target.gameVersionTypeId !== undefined
              ? { gameVersionTypeId: target.gameVersionTypeId }
              : {}),
            index,
            pageSize: 50,
          })
          for (const file of result.files) byId.set(file.id, file)
          const seen = index + result.files.length
          const total = result.totalCount > 0 ? result.totalCount : seen
          if (result.files.length === 0 || seen >= total) break
        }
        return [...byId.values()].map(providerVersionFromCurseForgeFile)
      },
      options.bypassCache,
    )
  }

  async version(
    projectId: string,
    versionId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion> {
    const modId = numericId(projectId, 'project')
    const fileId = numericId(versionId, 'file')
    return this.#cache.metadata(
      cacheKey('curseforge', 'version', { modId, fileId }),
      async () => providerVersionFromCurseForgeFile(await this.#client.file(modId, fileId)),
      options.bypassCache,
    )
  }

  async filesByIds(
    keys: FileKey[],
    options: ProviderRequestOptions = {},
  ): Promise<ProviderVersion[]> {
    assertFileKeys(keys, 'curseforge')
    const ids = [...new Set(keys.map((key) => numericId(key.fileId ?? '', 'file')))]
    if (ids.length === 0) return []
    const files = await this.#cache.metadata(
      cacheKey('curseforge', 'files', { ids }),
      () => this.#client.filesByIds(ids),
      options.bypassCache,
    )
    const byId = new Map(
      files.map((file) => [String(file.id), providerVersionFromCurseForgeFile(file)]),
    )
    return ids
      .map((id) => byId.get(String(id)))
      .filter((version): version is ProviderVersion => Boolean(version))
  }

  /**
   * Metadata → `download-url` → CDN fallback, resolved by the client, which owns
   * that chain and the distribution policy. The fallback is used only when the
   * author allows third-party distribution; otherwise the file is reported as not
   * obtainable instead of being fetched through an unlisted route.
   */
  async download(
    request: ProviderDownloadRequest,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderDownload> {
    const modId = numericId(request.projectId, 'project')
    const fileId = numericId(request.versionId, 'file')
    const version =
      request.version ?? (await this.version(request.projectId, request.versionId, options))
    const file = version.files.find((entry) => entry.primary) ?? version.files[0]
    if (!file?.filename) {
      throw new ModError('provider-error', `CurseForge file ${fileId} has no filename`, {
        fileId,
        modId,
      })
    }
    const resolved = await this.#client.resolveDownloadUrl(
      { id: fileId, modId, fileName: file.filename, downloadUrl: file.url ?? null },
      { ...(request.excludeUrl ? { exclude: request.excludeUrl } : {}) },
    )
    if (!resolved) {
      throw new ModError('provider-error', `CurseForge file ${fileId} has no download URL`, {
        fileId,
        modId,
      })
    }
    if ('blocked' in resolved) {
      throw new ModError(
        'distribution-blocked',
        `CurseForge project ${request.projectId} does not allow third-party distribution`,
        { projectId: request.projectId, fileId: String(fileId) },
      )
    }
    return {
      url: resolved.url,
      filename: file.filename,
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.hashes ? { hashes: file.hashes } : {}),
      source: resolved.source,
    }
  }

  /**
   * Opt-in identification of JARs nothing else can name: Murmur2 fingerprints in,
   * *candidates* out. A match is confirmed by name/size before anything happens
   * with it, and it is never used as an integrity check (that is SHA-1/SHA-512).
   */
  async fingerprintMatches(
    fingerprints: number[],
    options: ProviderRequestOptions = {},
  ): Promise<ProviderFingerprintResult> {
    const values = [
      ...new Set(fingerprints.filter((value) => Number.isSafeInteger(value) && value > 0)),
    ].sort((left, right) => left - right)
    if (values.length === 0) return { cacheBuilt: true, matches: [], unmatched: [] }
    const result = await this.#cache.metadata(
      cacheKey('curseforge', 'fingerprints', { values }),
      () => this.#client.fingerprintMatches(values),
      options.bypassCache,
    )
    return {
      cacheBuilt: result.cacheBuilt,
      matches: result.matches.map((match) => ({
        fingerprint: match.fingerprint,
        projectId: String(match.modId),
        fileId: String(match.fileId),
        filename: match.fileName,
        ...(match.fileDate ? { publishedAt: match.fileDate } : {}),
      })),
      unmatched: result.unmatched,
    }
  }

  async checkUpdates(
    files: UpdateLookup[],
    target: ProviderVersionTarget,
  ): Promise<Map<string, ProviderUpdate>> {
    const byFileId = new Map<number, UpdateLookup>()
    for (const file of files) {
      const id = Number(file.fileId ?? '')
      if (Number.isSafeInteger(id) && id > 0) byFileId.set(id, file)
    }
    if (byFileId.size === 0) return new Map()

    const installed: CurseForgeFile[] = []
    for (const batch of chunked([...byFileId.keys()], 50)) {
      installed.push(...(await this.#client.filesByIds(batch)))
    }
    const installedById = new Map(installed.map((file) => [String(file.id), file]))
    const modIds = [
      ...new Set([
        ...installed.map((file) => file.modId),
        ...[...byFileId.values()]
          .map((lookup) => Number(lookup.projectId))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ]),
    ]
    const mods: CurseForgeMod[] = []
    for (const batch of chunked(modIds, 50)) {
      mods.push(...(await this.#client.mods(batch)))
    }
    const indexesByMod = new Map(
      mods.map((mod) => [String(mod.id), mod.latestFilesIndexes ?? []]),
    )
    const loaderId = target.loader ? CURSEFORGE_LOADER_IDS[target.loader] : undefined
    const found = new Map<string, ProviderUpdate>()

    for (const [fileId, lookup] of byFileId) {
      const file = installedById.get(String(fileId))
      const projectId = lookup.projectId || (file ? String(file.modId) : '')
      if (!projectId) continue
      const indexes = indexesByMod.get(projectId) ?? []
      const matching = indexes.filter((index) => {
        if (target.minecraftVersion && index.gameVersion !== target.minecraftVersion) return false
        if (
          target.gameVersionTypeId !== undefined &&
          index.gameVersionTypeId !== target.gameVersionTypeId
        ) {
          return false
        }
        if (loaderId !== undefined && index.modLoader !== undefined && index.modLoader !== loaderId) {
          return false
        }
        return true
      })
      const installedChannel = channelFromReleaseType(file?.releaseType ?? 1)
      const channel = lessStableChannel(installedChannel, lookup.channel ?? 'release')
      const candidate = CHANNEL_STAGES[channel]
        .map((stages) => matching.find((index) => stages.includes(index.releaseType)))
        .find((index) => index !== undefined)
      if (!candidate) continue
      found.set(lookup.key, {
        projectId,
        versionId: String(candidate.fileId),
        fileId: String(candidate.fileId),
        channel: channelFromReleaseType(candidate.releaseType),
      })
    }

    // `latestFilesIndexes` carries no date, so the candidate's file date has to come
    // from the file endpoint. Without it no caller could tell an older candidate
    // (e.g. a stale index) from a real update. Files already fetched above are reused.
    if (found.size > 0) {
      const known = new Map(installedById)
      const unknown = [...new Set([...found.values()].map((update) => Number(update.fileId)))].filter(
        (id) => Number.isSafeInteger(id) && id > 0 && !known.has(String(id)),
      )
      for (const batch of chunked(unknown, 50)) {
        for (const file of await this.#client.filesByIds(batch)) known.set(String(file.id), file)
      }
      for (const [key, update] of found) {
        const fileDate = known.get(String(update.fileId))?.fileDate
        if (fileDate) found.set(key, { ...update, publishedAt: fileDate })
      }
    }
    return found
  }
}
