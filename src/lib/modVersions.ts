/**
 * One owner for "which store version belongs in this instance".
 *
 * Installs (browser, dependency, version switch) and updates (badge check,
 * update run, update-all, modpack update list) all go through these functions,
 * so a version can never be accepted by one path and rejected by another.
 *
 * The rules, stated once:
 *  - Minecraft version: required for mods, resource packs and datapacks. For
 *    worlds only versions that *declare* game versions have to match, because a
 *    world carries its own data and many archives declare nothing.
 *  - Loader: required for mods when the instance has a loader (a loader-less
 *    "Vanilla" instance has no loader to match, so any version is acceptable -
 *    it will be installed but the game cannot load it, which the UI says).
 *    Shader packs must declare a shader loader (iris/optifine/canvas) when they
 *    declare loaders at all. Resource packs, datapacks and worlds have no
 *    loader requirement.
 *  - File: a version needs a downloadable file; the category's preferred
 *    extension wins, and worlds strictly require an archive.
 *
 * There is no "first file of any version" fallback. When nothing is compatible
 * the caller gets `version: null` plus a reason it can show, and at most one
 * `fallback` candidate that is labelled as incompatible in the UI.
 */
import {
  matchesLoader as loaderRuleAllows,
  matchesMinecraftVersion as minecraftRuleAllows,
} from '../../electron/mods/compatibility'
import {
  loaderFilterForInstance,
  type ContentCategory,
  type ProjectType,
} from './contentCategories'

export interface StoreFile {
  url: string
  filename: string
  primary?: boolean
}

export interface StoreVersion {
  versionNumber: string
  versionId?: string
  published?: string
  gameVersions: string[]
  loaders: string[]
  files: StoreFile[]
}

export interface VersionCriteria {
  category: ContentCategory
  minecraftVersion?: string | null
  modloader?: string | null
}

export type VersionMissReason = 'no-versions' | 'mc-version' | 'loader' | 'file'

export interface VersionPick {
  version: StoreVersion | null
  file: StoreFile | null
  /** Best candidate that failed exactly one rule; never used without telling the user. */
  fallback: { version: StoreVersion; file: StoreFile; reason: 'loader' | 'mc-version' } | null
  reason: VersionMissReason | null
  stats: { total: number; mcMatches: number; loaderMatches: number }
}

export type UpdateStatus = 'current' | 'update-available' | 'incompatible' | 'unavailable'

export interface UpdateDecision {
  status: UpdateStatus
  pick: VersionPick
}

const SHADER_LOADERS = ['iris', 'optifine', 'canvas']

const PREFERRED_EXTENSIONS: Record<ContentCategory, string[]> = {
  mods: ['jar'],
  resourcepacks: ['zip'],
  shaderpacks: ['zip'],
  datapacks: ['zip'],
  worlds: ['zip', 'mcworld'],
}

export function curseForgeLoaderType(loader: string | undefined | null): number | undefined {
  const map: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }
  const normalized = (loader || '').toLowerCase()
  return map[normalized]
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/**
 * The file inside a version that fits the category, preferred extension first.
 * A file without a URL is still a file a CurseForge install can fetch (the main
 * process resolves and verifies it by file id), so only a missing name disqualifies one.
 */
export function versionFileFor(version: StoreVersion, category: ContentCategory): StoreFile | null {
  const usable = version.files.filter((file) => file.filename !== '')
  if (usable.length === 0) return null
  const preferred = PREFERRED_EXTENSIONS[category]
  const matching = usable.filter((file) => preferred.includes(extensionOf(file.filename)))
  const candidates = category === 'worlds' ? matching : matching.length > 0 ? matching : usable
  if (candidates.length === 0) return null
  return (
    candidates.find((file) => file.primary && file.url) ??
    candidates.find((file) => file.url) ??
    candidates.find((file) => file.primary) ??
    candidates[0]
  )
}

function matchesMinecraftVersion(version: StoreVersion, criteria: VersionCriteria): boolean {
  return minecraftRuleAllows(version.gameVersions, {
    minecraftVersion: criteria.minecraftVersion,
    acceptUndeclared: criteria.category === 'worlds',
  })
}

function matchesLoader(version: StoreVersion, criteria: VersionCriteria): boolean {
  if (criteria.category === 'shaderpacks') {
    return loaderRuleAllows(version.loaders, {
      acceptedLoaders: SHADER_LOADERS,
      acceptUndeclaredLoaders: true,
    })
  }
  if (criteria.category !== 'mods') return true
  const filter = loaderFilterForInstance(criteria.modloader)
  if (!filter) return true
  return loaderRuleAllows(version.loaders, {
    acceptedLoaders: [filter],
    acceptUndeclaredLoaders: true,
  })
}

/** True when the version passes both the Minecraft and the loader rule. */
export function isVersionCompatible(version: StoreVersion, criteria: VersionCriteria): boolean {
  return matchesMinecraftVersion(version, criteria) && matchesLoader(version, criteria)
}

function newestFirst(versions: StoreVersion[]): StoreVersion[] {
  // The stores return newest first; sorting by date keeps the order deterministic
  // when a caller hands over a mixed list.
  return versions
    .map((version, index) => ({ version, index, time: version.published ? Date.parse(version.published) : NaN }))
    .sort((a, b) => {
      const left = Number.isNaN(a.time) ? -Infinity : a.time
      const right = Number.isNaN(b.time) ? -Infinity : b.time
      if (left !== right) return right - left
      return a.index - b.index
    })
    .map((entry) => entry.version)
}

/** Picks the newest compatible version, or explains why there is none. */
export function pickVersion(versions: StoreVersion[], criteria: VersionCriteria): VersionPick {
  const ordered = newestFirst(versions)
  const stats = {
    total: ordered.length,
    mcMatches: ordered.filter((version) => matchesMinecraftVersion(version, criteria)).length,
    loaderMatches: 0,
  }

  let firstMcMatch: { version: StoreVersion; file: StoreFile } | null = null
  let firstLoaderMatch: { version: StoreVersion; file: StoreFile } | null = null

  for (const version of ordered) {
    const file = versionFileFor(version, criteria.category)
    const mcOk = matchesMinecraftVersion(version, criteria)
    const loaderOk = matchesLoader(version, criteria)
    if (mcOk && loaderOk) stats.loaderMatches += 1
    if (mcOk && !loaderOk && file && !firstLoaderMatch) firstLoaderMatch = { version, file }
    if (!mcOk && loaderOk && file && !firstMcMatch) firstMcMatch = { version, file }
    if (mcOk && loaderOk && file) {
      return {
        version,
        file,
        fallback: null,
        reason: null,
        stats: { ...stats, loaderMatches: stats.loaderMatches },
      }
    }
  }

  const fallback = firstLoaderMatch
    ? { ...firstLoaderMatch, reason: 'loader' as const }
    : firstMcMatch
      ? { ...firstMcMatch, reason: 'mc-version' as const }
      : null

  let reason: VersionMissReason = 'file'
  if (stats.total === 0) reason = 'no-versions'
  else if (stats.mcMatches === 0) reason = 'mc-version'
  else if (stats.loaderMatches === 0) reason = 'loader'

  return { version: null, file: null, fallback, reason, stats }
}

/** Update decision for one installed item, from the store's full version list. */
export function decideUpdate(
  installedVersionNumber: string | undefined,
  versions: StoreVersion[],
  criteria: VersionCriteria,
): UpdateDecision {
  const pick = pickVersion(versions, criteria)
  if (!pick.version) {
    return { status: versions.length === 0 ? 'unavailable' : 'incompatible', pick }
  }
  if (installedVersionNumber && pick.version.versionNumber === installedVersionNumber) {
    return { status: 'current', pick }
  }
  return { status: 'update-available', pick }
}

interface RawModrinthVersion {
  id?: string
  version_number?: string
  date_published?: string
  game_versions?: string[]
  loaders?: string[]
  files?: { url?: string; filename?: string; primary?: boolean }[]
}

export function fromModrinthVersion(raw: RawModrinthVersion): StoreVersion {
  return {
    versionNumber: raw.version_number || '',
    versionId: raw.id,
    published: raw.date_published,
    gameVersions: raw.game_versions || [],
    loaders: raw.loaders || [],
    files: (raw.files || [])
      .filter((file): file is { url: string; filename: string; primary?: boolean } =>
        Boolean(file?.url && file?.filename),
      )
      .map((file) => ({ url: file.url, filename: file.filename, primary: file.primary })),
  }
}

interface RawCurseForgeFile {
  id?: number
  displayName?: string
  fileName?: string
  fileDate?: string
  gameVersions?: string[]
  modLoader?: number | null
  downloadUrl?: string | null
}

const CURSEFORGE_LOADERS: Record<number, string> = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' }

export function fromCurseForgeFile(raw: RawCurseForgeFile): StoreVersion {
  const loader = raw.modLoader == null ? null : CURSEFORGE_LOADERS[raw.modLoader] ?? String(raw.modLoader)
  return {
    versionNumber: raw.displayName || raw.fileName || String(raw.id ?? ''),
    versionId: raw.id === undefined ? undefined : String(raw.id),
    published: raw.fileDate,
    gameVersions: raw.gameVersions || [],
    loaders: loader ? [loader] : [],
    // CurseForge hides the download URL when the author blocks third-party
    // downloads; the core can still fetch those by file id, so the file stays.
    files: raw.fileName ? [{ url: raw.downloadUrl || '', filename: raw.fileName, primary: true }] : [],
  }
}

/** Store project type an instance-content category belongs to, for downloads. */
export function projectTypeForCategory(category: ContentCategory): ProjectType {
  switch (category) {
    case 'mods':
      return 'mod'
    case 'resourcepacks':
      return 'resourcepack'
    case 'shaderpacks':
      return 'shader'
    case 'datapacks':
      return 'datapack'
    default:
      return 'worlds'
  }
}
