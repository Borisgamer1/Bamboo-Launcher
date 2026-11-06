import { toCurseForgeFailure, type CurseForgeFailure } from './curseforge'
import {
  curseForgeClassIdFor,
  curseForgeProjectType,
  type ProjectType,
} from './contentCategories'
import type { ModrinthHit } from '../components/mods/modDetailModel'

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500] as const
export const PAGE_SIZE_INFINITE = 'infinite'
export const PAGE_SIZE_STORAGE_KEY = 'bamboo-mods-page-size'
export const SEARCH_DEBOUNCE_MS = 300
// CurseForge rejects pageSize > 50 and stops serving past result 10,000.
export const CURSEFORGE_MAX_PAGE_SIZE = 50
export const CURSEFORGE_SEARCH_LIMIT = 10_000

export type ModsPageSize = (typeof PAGE_SIZE_OPTIONS)[number] | typeof PAGE_SIZE_INFINITE

export function readSavedPageSize(): ModsPageSize {
  try {
    const raw = localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    if (raw === PAGE_SIZE_INFINITE) return PAGE_SIZE_INFINITE
    const parsed = Number(raw)
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)) return parsed as ModsPageSize
  } catch {
    // Storage can be unavailable; fall back to the default page size.
  }
  return 20
}

export function readProjectSource(): 'modrinth' | 'curseforge' {
  try {
    return sessionStorage.getItem('bamboo-project-source') === 'curseforge' ? 'curseforge' : 'modrinth'
  } catch {
    return 'modrinth'
  }
}

export function readProjectType(): string {
  try {
    return sessionStorage.getItem('bamboo-project-type') || 'all'
  } catch {
    return 'all'
  }
}

export function sortIndexToCurseForgeSort(idx: string): number {
  switch (idx) {
    case 'downloads': return 6
    case 'relevance': return 2
    case 'follows': return 2
    case 'newest': return 11
    case 'updated': return 3
    default: return 6
  }
}

export function projectTypeToCfClassId(pt: string): string | undefined {
  const classId = curseForgeClassIdFor(pt)
  return classId === undefined ? undefined : String(classId)
}

interface CurseForgePageResult {
  mapped: ModrinthHit[]
  total: number
  failure: CurseForgeFailure | null
  cancelled: boolean
}

/**
 * Fill one UI page from CurseForge. The API caps a request at 50 results, while
 * the page-size selector offers 100 and 500; consecutive chunks keep the
 * renderer's offset arithmetic (and the "showing X-Y" label) honest. The
 * handler clamps the same limits independently, so no caller can bypass them.
 */
export async function fetchCurseForgePage({
  query,
  sortBy,
  gameVersion,
  modFilter,
  projectType,
  index,
  pageSize,
  isCurrent,
}: {
  query: string
  sortBy: string
  gameVersion?: string
  modFilter?: string
  projectType: ProjectType
  index: number
  pageSize: number
  isCurrent: () => boolean
}): Promise<CurseForgePageResult> {
  const mapped: ModrinthHit[] = []
  if (pageSize <= 0 || index >= CURSEFORGE_SEARCH_LIMIT) {
    return { mapped, total: 0, failure: null, cancelled: false }
  }

  let cursor = index
  let total = 0
  do {
    const chunkSize = Math.min(
      CURSEFORGE_MAX_PAGE_SIZE,
      pageSize - mapped.length,
      CURSEFORGE_SEARCH_LIMIT - cursor,
    )
    const result = await window.electronAPI?.mods.curseforgeSearch?.({
      query,
      sortBy,
      gameVersion,
      modFilter,
      index: cursor,
      pageSize: chunkSize,
    })
    if (!isCurrent()) return { mapped: [], total: 0, failure: null, cancelled: true }
    const failure = toCurseForgeFailure(result)
    if (!result || failure || !('data' in result)) {
      return { mapped, total, failure: failure ?? { code: 'unavailable' }, cancelled: false }
    }
    mapped.push(...result.data.map((item) => ({
      project_id: String(item.id),
      slug: item.slug || String(item.id),
      author: item.authors?.[0]?.name || "Unknown",
      title: item.name,
      description: item.summary || "",
      categories: (item.categories || []).map((c) => typeof c === "string" ? c : c.slug || c.name || String(c)),
      client_side: "required",
      server_side: "optional",
      project_type: curseForgeProjectType(item.classId, projectType),
      downloads: item.downloadCount || 0,
      icon_url: item.logo?.url || "",
      versions: [...new Set((item.latestFiles || []).flatMap((f) =>
        (f.gameVersions || []).filter((v: string) => /^\d+\.\d+(?:\.\d+)?$/.test(v))
      ))],
      follows: item.rating || 0,
      date_created: item.dateCreated || "",
      date_modified: item.dateModified || "",
    })));
    total = Math.min(result.pagination?.totalCount || total, CURSEFORGE_SEARCH_LIMIT);
    cursor += result.data.length;
    if (result.data.length === 0 || (total > 0 && cursor >= total)) break;
  } while (mapped.length < pageSize && cursor < CURSEFORGE_SEARCH_LIMIT);

  return { mapped, total, failure: null, cancelled: false }
}

export interface SavedBrowserState {
  page: number
  scrollTop: number
  search: string
  source: 'modrinth' | 'curseforge'
  sortIndex: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  selectedVersion: string
  selectedCategory: string
  selectedProjectType: string
  pageSize: ModsPageSize
}

export function browserStateKey(instanceId?: string): string {
  return `bamboo-browser-state:${instanceId ?? 'global'}`
}

export function readBrowserState(instanceId?: string): SavedBrowserState | null {
  try {
    const raw = sessionStorage.getItem(browserStateKey(instanceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedBrowserState>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      page: Number.isFinite(parsed.page) ? Math.max(1, Number(parsed.page)) : 1,
      scrollTop: Number.isFinite(parsed.scrollTop) ? Math.max(0, Number(parsed.scrollTop)) : 0,
      search: typeof parsed.search === 'string' ? parsed.search : '',
      source: parsed.source === 'curseforge' ? 'curseforge' : 'modrinth',
      sortIndex: ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(String(parsed.sortIndex))
        ? (parsed.sortIndex as SavedBrowserState['sortIndex'])
        : 'downloads',
      selectedVersion: typeof parsed.selectedVersion === 'string' ? parsed.selectedVersion : 'all',
      selectedCategory: typeof parsed.selectedCategory === 'string' ? parsed.selectedCategory : 'all',
      selectedProjectType: typeof parsed.selectedProjectType === 'string' ? parsed.selectedProjectType : 'all',
      pageSize: parsed.pageSize === PAGE_SIZE_INFINITE || typeof parsed.pageSize === 'number'
        ? (parsed.pageSize as ModsPageSize)
        : readSavedPageSize(),
    }
  } catch {
    return null
  }
}
