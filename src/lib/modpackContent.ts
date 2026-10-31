export interface ModpackIndexFile {
  path?: string
  filename?: string
  downloads?: string[]
  hashes?: Record<string, string>
  env?: { client?: string; server?: string }
}

export type ModpackContentType =
  | 'mods'
  | 'resourcepacks'
  | 'shaderpacks'
  | 'datapacks'
  | 'worlds'

export interface ModpackContentItem {
  id: string
  name: string
  fileName: string
  version: string
  type: ModpackContentType
  enabled: boolean
  locked: boolean
  iconUrl?: string
  versionNumber?: string
  projectId?: string
  source?: 'modrinth' | 'curseforge'
}

export interface ModpackFileMetadata {
  title: string
  slug: string
  iconUrl: string
  versionNumber: string
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface ModrinthVersionRecord {
  project_id?: string
  version_number?: string
}

interface ModrinthProjectRecord {
  id?: string
  slug?: string
  title?: string
  icon_url?: string
}

const CONTENT_TYPE_BY_PREFIX: Array<[string, ModpackContentType]> = [
  ['mods/', 'mods'],
  ['overrides/mods/', 'mods'],
  ['client-overrides/mods/', 'mods'],
  ['resourcepacks/', 'resourcepacks'],
  ['overrides/resourcepacks/', 'resourcepacks'],
  ['client-overrides/resourcepacks/', 'resourcepacks'],
  ['shaderpacks/', 'shaderpacks'],
  ['overrides/shaderpacks/', 'shaderpacks'],
  ['client-overrides/shaderpacks/', 'shaderpacks'],
  ['datapacks/', 'datapacks'],
  ['overrides/datapacks/', 'datapacks'],
  ['client-overrides/datapacks/', 'datapacks'],
  ['saves/', 'worlds'],
  ['overrides/saves/', 'worlds'],
  ['client-overrides/saves/', 'worlds'],
  ['worlds/', 'worlds'],
]

/** The content folders a modpack index file can populate. */
export function modpackContentType(path: string): ModpackContentType | null {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  for (const [prefix, type] of CONTENT_TYPE_BY_PREFIX) {
    if (normalized.startsWith(prefix)) return type
  }
  return null
}

function fileNameFor(file: ModpackIndexFile): string {
  const path = (file.path || file.filename || '').replace(/\\/g, '/')
  return path.split('/').pop() || file.filename || 'unknown'
}

function displayName(fileName: string): string {
  return fileName
    .replace(/\.(jar|zip|disabled|mcworld)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim() || fileName
}

/**
 * One mapping from a Modrinth modpack index to the instance's content list.
 * Metadata is optional: without it the list still works from file names, and
 * `resolveModpackContentMetadata` fills in project titles, icons and versions.
 */
export function buildModpackContentItems(
  files: ModpackIndexFile[],
  metadata: Record<string, ModpackFileMetadata> = {},
): ModpackContentItem[] {
  const items: ModpackContentItem[] = []
  for (const file of files) {
    if (file.env?.client === 'unsupported') continue
    const normalized = (file.path || '').replace(/\\/g, '/')
    const type = modpackContentType(normalized)
    if (!type) continue
    const fileName = fileNameFor(file)
    const meta = metadata[normalized]
    items.push({
      id: meta?.slug || `modpack:${normalized || fileName}`,
      name: meta?.title || displayName(fileName),
      fileName,
      version: '',
      type,
      enabled: true,
      locked: true,
      ...(meta?.iconUrl ? { iconUrl: meta.iconUrl } : {}),
      ...(meta?.versionNumber ? { versionNumber: meta.versionNumber } : {}),
      ...(meta?.slug ? { projectId: meta.slug, source: 'modrinth' as const } : {}),
    })
  }
  return items
}

/**
 * Resolve installed modpack files through Modrinth's hash lookup. One version
 * request and at most a handful of project requests are enough for a whole
 * pack; any network failure simply leaves the file-name fallback in place.
 */
/**
 * Adds the pack's override files (resource packs, shaders, ...) to the content
 * list. They are not part of `modrinth.index.json`, so without this the files
 * exist on disk but the instance tabs look empty.
 */
export function mergeOverrideContentItems(
  items: ModpackContentItem[],
  overridePaths: string[],
): ModpackContentItem[] {
  if (overridePaths.length === 0) return items;
  const key = (item: ModpackContentItem) => `${item.type}:${(item.fileName || '').toLowerCase()}`;
  const seen = new Set(items.map(key));
  const extras = buildModpackContentItems(overridePaths.map((path) => ({ path })))
    .filter((item) => !seen.has(key(item)));
  return extras.length > 0 ? [...items, ...extras] : items;
}

export async function resolveModpackContentMetadata(
  files: ModpackIndexFile[],
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, ModpackFileMetadata>> {
  const pathsByHash = new Map<string, string[]>()
  for (const file of files) {
    const path = (file.path || '').replace(/\\/g, '/')
    const hash = (file.hashes?.sha1 || file.hashes?.SHA1 || '').toLowerCase()
    if (!path || !hash) continue
    const paths = pathsByHash.get(hash)
    if (paths) paths.push(path)
    else pathsByHash.set(hash, [path])
  }
  const hashes = [...pathsByHash.keys()]
  if (hashes.length === 0) return {}

  const versionsByHash = new Map<string, ModrinthVersionRecord>()
  for (let index = 0; index < hashes.length; index += 100) {
    const chunk = hashes.slice(index, index + 100)
    try {
      const response = await fetchImpl('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }),
      })
      if (!response.ok) continue
      const payload = await response.json() as Record<string, ModrinthVersionRecord> | null
      if (!payload || Array.isArray(payload)) continue
      for (const [hash, version] of Object.entries(payload)) {
        if (version && typeof version === 'object') versionsByHash.set(hash, version)
      }
    } catch {
      // Metadata is an enhancement; the installed pack remains usable without it.
    }
  }

  const projectIds = [...new Set(
    [...versionsByHash.values()]
      .map((version) => version.project_id)
      .filter((id): id is string => Boolean(id)),
  )]
  const projectsById = new Map<string, ModrinthProjectRecord>()
  for (let index = 0; index < projectIds.length; index += 50) {
    const chunk = projectIds.slice(index, index + 50)
    try {
      const response = await fetchImpl(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`,
      )
      if (!response.ok) continue
      const payload = await response.json() as ModrinthProjectRecord[] | null
      if (!Array.isArray(payload)) continue
      for (const project of payload) {
        if (project?.id) projectsById.set(project.id, project)
      }
    } catch {
      // Keep whatever was resolved from the other chunks.
    }
  }

  const metadata: Record<string, ModpackFileMetadata> = {}
  for (const [hash, paths] of pathsByHash) {
    const version = versionsByHash.get(hash)
    const project = version?.project_id ? projectsById.get(version.project_id) : undefined
    if (!version || !project?.title || !project.slug) continue
    const entry: ModpackFileMetadata = {
      title: project.title,
      slug: project.slug,
      iconUrl: project.icon_url || '',
      versionNumber: version.version_number || '',
    }
    for (const path of paths) metadata[path] = entry
  }
  return metadata
}
