export type ModLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'legacy' | 'unknown'

export type ProviderId = 'modrinth' | 'curseforge'

export type UpdateChannel = 'release' | 'beta' | 'alpha'

export interface ProjectKey {
  provider: ProviderId
  projectId: string
}

export interface VersionKey extends ProjectKey {
  versionId: string
}

export interface FileKey extends ProjectKey {
  fileId?: string
  sha1?: string
}

export type DependencyKind =
  | 'required'
  | 'optional'
  | 'incompatible'
  | 'embedded'
  | 'tool'
  | 'include'

export type DependencyReason = 'depends' | 'breaks'

export interface ModDependencyInfo {
  id: string
  versionRange?: string
  mandatory: boolean
  reason: DependencyReason
}

export interface ParsedMod {
  id: string
  name: string
  version: string
  loader: ModLoader
  dependencies: ModDependencyInfo[]
  provides: string[]
  minecraftVersionRange?: string
  loaderVersionRange?: string
  source: string
}

export interface MissingDependency {
  id: string
  requiredBy: string[]
  versionRange?: string
}

export interface ProviderFile {
  id?: string
  url?: string
  filename: string
  size?: number
  hashes?: Record<string, string>
  primary?: boolean
}

export interface ProviderDependency {
  projectId?: string
  versionId?: string
  fileName?: string
  type: DependencyKind
}

export interface ProviderVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  files: ProviderFile[]
  dependencies: ProviderDependency[]
  publishedAt?: string
  channel?: 'release' | 'beta' | 'alpha'
}

export interface ProviderProject {
  id: string
  slug: string
  title: string
  description?: string
  projectType?: string
  loaders?: string[]
  gameVersions?: string[]
  provider?: ProviderId
  iconUrl?: string
  author?: string
  categories?: string[]
  downloads?: number
  follows?: number
  allowModDistribution?: boolean
}

export type ProviderSort = 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'

export interface ProviderSearchQuery {
  query?: string
  projectType?: string
  loaders?: ModLoader[]
  gameVersions?: string[]
  categories?: string[]
  gameVersionTypeId?: number
  sort?: ProviderSort
  offset?: number
  limit?: number
}

export interface ProviderSearchHit extends ProviderProject {
  versions: string[]
}

export interface ProviderSearchPage {
  hits: ProviderSearchHit[]
  offset: number
  limit: number
  total: number
}

export interface InstalledFileRecord {
  sha1: string
  sha512?: string
  size?: number
  paths: string[]
  provider?: ProviderId
  projectId?: string
  versionId?: string
  fileId?: string
  name?: string
  versionNumber?: string
  source?: string
  channel?: UpdateChannel
  publishedAt?: string
  stat?: { size: number; mtimeMs: number }
  checkedAt?: number
  lastCheck?: {
    checkedAt: number
    status: 'update-available' | 'up-to-date' | 'unresolved'
    versionId?: string
    fileId?: string
    reason?: string
  }
  installedAt: number
}

export interface ProviderDownloadRequest {
  projectId: string
  /** Modrinth: the version id. CurseForge: the file id (a version *is* a file). */
  versionId: string
  /** Resolved version metadata, when the caller already has it. */
  version?: ProviderVersion
  /**
   * A candidate that just failed (403, expired URL). The chain answers with the
   * next route instead of handing out the same dead URL again.
   */
  excludeUrl?: string
}

/**
 * An obtainable download for one version file. `source` names how the URL was
 * obtained, so a caller can tell an author-sanctioned URL from the CDN fallback.
 */
export interface ProviderDownload {
  url: string
  filename: string
  size?: number
  hashes?: Record<string, string>
  source: 'metadata' | 'endpoint' | 'cdn'
}

/** One CurseForge fingerprint match — a candidate, never proof of identity. */
export interface ProviderFingerprintMatch {
  fingerprint: number
  projectId: string
  fileId: string
  filename: string
  publishedAt?: string
}

export interface ProviderFingerprintResult {
  /** False when the provider's fingerprint index was still building. */
  cacheBuilt: boolean
  matches: ProviderFingerprintMatch[]
  unmatched: number[]
}

export interface ModpackFile {
  path: string
  downloads: string[]
  fileSize?: number
  hashes?: Record<string, string>
  env?: { client?: 'required' | 'optional' | 'unsupported'; server?: string }
}

export interface ModpackManifest {
  name: string
  versionId?: string
  summary?: string
  author?: string
  dependencies: Record<string, string>
  files: ModpackFile[]
}

export interface ModpackLockFile {
  path: string
  sha1?: string
  sha512?: string
  size?: number
  projectId?: number | string
  fileId?: number
  source?: string
}

export interface ModpackLock {
  version: 1
  format: 'mrpack' | 'curseforge'
  name: string
  versionId: string
  upstream: {
    provider: string
    format: string
    name?: string
    versionId?: string
    projectId?: string
    file?: string
  }
  dependencies: Record<string, string>
  files: ModpackLockFile[]
  updatedAt: number
}

export interface ModpackInstallResult {
  format: 'mrpack' | 'curseforge'
  installed: string[]
  skipped: string[]
  overrides: number
  missingDependencies: MissingDependency[]
  installedDependencies: string[]
  downloadedBytes: number
  updated: string[]
  removed: string[]
  kept: string[]
}
