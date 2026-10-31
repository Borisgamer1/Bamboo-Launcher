import React, { useState, useEffect, useRef, useCallback, startTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Puzzle, Search, ArrowLeft, X, Download, Users,
  ChevronLeft, ChevronRight, Filter, Check, RefreshCw, Plus, Package, AlertTriangle,
  Star
} from "lucide-react";
import { TabType } from "./Sidebar";
import { Instance } from "./InstancesView";
import { translations, formatMessage, formatNumber, formatCompactNumber, LanguageType } from "../lib/translations";
import { canRetryCurseForge, toCurseForgeFailure, type CurseForgeFailure } from "../lib/curseforge";
import { CurseForgeFailureNotice } from "./mods/CurseForgeFailureNotice";
import { fetchVersionMap } from "../lib/versionApi";
import {
  GLOBAL_BROWSER_PROJECT_TYPES,
  INSTANCE_BROWSER_PROJECT_TYPES,
  curseForgeClassIdFor,
  curseForgeProjectType,
  installItemTypeFor,
  instanceLoadsMods,
  isInstanceCategory,
  projectTypeToCategory,
  type ContentCategory,
  type ProjectType,
} from "../lib/contentCategories";
import {
  fromCurseForgeFile,
  fromModrinthVersion,
  isVersionCompatible,
  pickVersion,
  versionFileFor,
  type StoreFile,
  type StoreVersion,
  type VersionMissReason,
} from "../lib/modVersions";
import type { DownloadModPayload } from "../electron";
import { useToast } from "./Toast";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from "../lib/backgroundTasks";
import { instanceFolderKeyOf, uniqueInstanceFolder, uniqueInstanceName } from "../lib/instanceFolders";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { createDescriptionSanitizer, renderDescription } from "../lib/descriptionHtml";
import {
  buildModpackContentItems,
  mergeOverrideContentItems,
  resolveModpackContentMetadata,
  type ModpackIndexFile,
} from "../lib/modpackContent";
import {
  modpackLoaderLabel,
  pickModpackVersion,
  type ModpackLoader,
} from "../lib/modpackVersions";
import DOMPurify from "dompurify";

const sanitizeDescription = createDescriptionSanitizer(DOMPurify);

const MOD_SKELETON_ROWS = 5;

const ModCardSkeleton: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-surface border border-stroke rounded-2xl px-5 py-2.5 flex items-center gap-4 min-h-[96px] shrink-0 pointer-events-none select-none"
  >
    <div className="w-14 h-14 rounded-2xl bg-hover animate-pulse shrink-0" />
    <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-1/3 rounded bg-hover animate-pulse" />
        <div className="h-2.5 w-20 rounded bg-hover animate-pulse" />
      </div>
      <div className="h-2.5 w-4/5 rounded bg-hover animate-pulse" />
      <div className="h-2.5 w-3/5 rounded bg-hover animate-pulse" />
      <div className="h-2 w-24 rounded bg-hover animate-pulse" />
    </div>
    <div className="h-8 w-20 rounded-lg bg-hover animate-pulse shrink-0" />
  </div>
);

const ModSkeletonList: React.FC<{ count: number; label: string }> = ({ count, label }) => (
  <div
    role="status"
    aria-busy="true"
    aria-live="polite"
    className="flex flex-col gap-2 pointer-events-none select-none"
  >
    <span className="sr-only">{label}</span>
    {Array.from({ length: count }, (_, index) => (
      <ModCardSkeleton key={index} />
    ))}
  </div>
);

interface ModrinthHit {
  project_id: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  project_type: string;
  downloads: number;
  icon_url: string;
  versions: string[];
  follows: number;
  date_created: string;
  date_modified: string;
}

interface ModDetail {
  title?: string;
  author?: string;
  body?: string;
  description?: string;
  icon_url?: string;
  downloads?: number;
  slug?: string;
}

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary?: boolean;
}

interface ModrinthDependency {
  dependency_type?: string;
  project_id?: string;
}

interface ModrinthVersion {
  id?: string;
  version_number?: string;
  version_type?: string;
  date_published?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: ModrinthVersionFile[];
  dependencies?: ModrinthDependency[];
}

interface ModrinthSearchPayload {
  hits?: ModrinthHit[];
  total_hits?: number;
}

function createInstanceId(): string {
  return `inst_${Date.now()}`;
}

interface ModDetailVersion {
  version_number: string;
  date_published: string;
  game_versions: string[];
  loaders: string[];
  files: { url: string; filename: string; primary: boolean }[];
}

interface ModsViewProps {
  setActiveTab: (tab: TabType) => void;
  searchQuery: string;
  instances?: Instance[];
  setInstances?: React.Dispatch<React.SetStateAction<Instance[]>>;
  fromInstanceId?: string | null;
  onClearInstance?: () => void;
  lang: LanguageType;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500] as const;
const PAGE_SIZE_INFINITE = "infinite";
const PAGE_SIZE_STORAGE_KEY = "bamboo-mods-page-size";
const INFINITE_BATCH = 50;
const SEARCH_DEBOUNCE_MS = 300;
const MODRINTH_MAX_LIMIT = 100;
// CurseForge rejects pageSize > 50 and stops serving past result 10,000.
const CURSEFORGE_MAX_PAGE_SIZE = 50;
const CURSEFORGE_SEARCH_LIMIT = 10_000;

type ModsPageSize = (typeof PAGE_SIZE_OPTIONS)[number] | typeof PAGE_SIZE_INFINITE;

function readSavedPageSize(): ModsPageSize {
  try {
    const raw = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (raw === PAGE_SIZE_INFINITE) return PAGE_SIZE_INFINITE;
    const parsed = Number(raw);
    if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)) return parsed as ModsPageSize;
  } catch {
    // Storage can be unavailable; fall back to the default page size.
  }
  return 20;
}

function readProjectSource(): "modrinth" | "curseforge" {
  try {
    return sessionStorage.getItem("bamboo-project-source") === "curseforge" ? "curseforge" : "modrinth";
  } catch {
    return "modrinth";
  }
}

function readProjectType(): string {
  try {
    return sessionStorage.getItem("bamboo-project-type") || "all";
  } catch {
    return "all";
  }
}

function sortIndexToCurseForgeSort(idx: string): number {
  switch (idx) {
    case "downloads": return 6;
    case "relevance": return 2;
    case "follows": return 2;
    case "newest": return 11;
    case "updated": return 3;
    default: return 6;
  }
}

function projectTypeToCfClassId(pt: string): string | undefined {
  const classId = curseForgeClassIdFor(pt);
  return classId === undefined ? undefined : String(classId);
}

interface CurseForgePageResult {
  mapped: ModrinthHit[];
  total: number;
  failure: CurseForgeFailure | null;
  cancelled: boolean;
}

/**
 * Fill one UI page from CurseForge. The API caps a request at 50 results, while
 * the page-size selector offers 100 and 500; consecutive chunks keep the
 * renderer's offset arithmetic (and the "showing X-Y" label) honest. The
 * handler clamps the same limits independently, so no caller can bypass them.
 */
async function fetchCurseForgePage({
  query,
  sortBy,
  gameVersion,
  modFilter,
  projectType,
  index,
  pageSize,
  isCurrent,
}: {
  query: string;
  sortBy: string;
  gameVersion?: string;
  modFilter?: string;
  projectType: ProjectType;
  index: number;
  pageSize: number;
  isCurrent: () => boolean;
}): Promise<CurseForgePageResult> {
  const mapped: ModrinthHit[] = [];
  if (pageSize <= 0 || index >= CURSEFORGE_SEARCH_LIMIT) {
    return { mapped, total: 0, failure: null, cancelled: false };
  }

  let cursor = index;
  let total = 0;
  do {
    const chunkSize = Math.min(
      CURSEFORGE_MAX_PAGE_SIZE,
      pageSize - mapped.length,
      CURSEFORGE_SEARCH_LIMIT - cursor,
    );
    const result = await window.electronAPI?.mods.curseforgeSearch?.({
      query,
      sortBy,
      gameVersion,
      modFilter,
      index: cursor,
      pageSize: chunkSize,
    });
    if (!isCurrent()) return { mapped: [], total: 0, failure: null, cancelled: true };
    const failure = toCurseForgeFailure(result);
    if (!result || failure || !('data' in result)) {
      return { mapped, total, failure: failure ?? { code: 'unavailable' }, cancelled: false };
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

  return { mapped, total, failure: null, cancelled: false };
}

type AccentClasses = {
  text: string;
  bg: string;
  bgLight: string;
  border: string;
  glow: string;
  hoverText: string;
  borderHover: string;
  cardHover: string;
};

const ModSearchField = React.memo(function ModSearchField({
  value,
  placeholder,
  onQueryChange,
}: {
  value: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);

  // Adjust the draft when the owner resets the query, without an effect round-trip.
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(value);
  }

  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onQueryChange(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value, onQueryChange]);

  return (
    <div className="relative shrink-0">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" />
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-root/40 border border-stroke/80 rounded-2xl py-3 pl-11 pr-4 text-small text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] focus:border-[color:var(--accent)]/50"
      />
    </div>
  );
});

function cfLoaderNameToType(loader: string): number | undefined {
  const map: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
  return map[loader.toLowerCase()];
}

export const ModsView = React.memo(function ModsView({ setActiveTab, searchQuery: initialSearch, instances = [], setInstances, fromInstanceId, onClearInstance, lang }: ModsViewProps) {
  const { addToast } = useToast();
  const isGlobal = !fromInstanceId;
  const contextInstance = fromInstanceId ? instances.find(i => i.id === fromInstanceId) : null;
  const [search, setSearch] = useState(initialSearch);
  const [source, setSource] = useState<"modrinth" | "curseforge">(readProjectSource);
  const [pageSize, setPageSize] = useState<ModsPageSize>(readSavedPageSize);
  const [page, setPage] = useState(1);
  const [totalHits, setTotalHits] = useState(0);
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const hitsRef = useRef<ModrinthHit[]>([]);
  const [searchError, setSearchError] = useState<CurseForgeFailure | null>(null);
  const t = translations[lang];
  const projectTypeLabel: Record<ProjectType, string> = {
    mod: t.projectTypeMods,
    modpack: t.projectTypeModpacks,
    resourcepack: t.projectTypeResourcePacks,
    shader: t.projectTypeShaders,
    datapack: t.projectTypeDataPacks,
    worlds: t.projectTypeWorlds,
    plugin: t.projectTypePlugins,
  };
  const [sortIndex, setSortIndex] = useState<"relevance" | "downloads" | "follows" | "newest" | "updated">("downloads");
  const [selectedVersion, setSelectedVersion] = useState<string>(() => contextInstance?.minecraftVersion || "all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedProjectType, setSelectedProjectType] = useState<string>(() => {
    const stored = readProjectType();
    // Browsing for an instance offers instance content only (no modpacks/plugins).
    return !isGlobal && stored !== "all" && !isInstanceCategory(stored) ? "mod" : stored;
  });
  const entryContextId = contextInstance?.id ?? null;
  const appliedContextId = useRef<string | null | undefined>(undefined);
  const [selectedMod, setSelectedMod] = useState<ModrinthHit | null>(null);
  const [installingModId, setInstallingModId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState(0);
  const [showInstancePicker, setShowInstancePicker] = useState(false);
  const [pendingModForInstall, setPendingModForInstall] = useState<ModrinthHit | null>(null);

  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [versionPickerMod, setVersionPickerMod] = useState<ModrinthHit | null>(null);
  const [versionPickerInst, setVersionPickerInst] = useState<Instance | null>(null);
  const [modVersions, setModVersions] = useState<string[]>([]);

  // Browser entry intent arrives through sessionStorage, and the instance context can
  // resolve after the first render. Adjust state in render (React's documented pattern
  // for derived state) so no extra effect round-trip is needed.
  if (appliedContextId.current !== entryContextId) {
    appliedContextId.current = entryContextId;
    try {
      const storedType = sessionStorage.getItem("bamboo-project-type");
      const storedSource = sessionStorage.getItem("bamboo-project-source");
      if (storedType) {
        const nextType = !isGlobal && storedType !== "all" && !isInstanceCategory(storedType) ? "mod" : storedType;
        setSelectedProjectType(nextType);
        setPage(1);
      }
      if (storedSource === "curseforge" || storedSource === "modrinth") setSource(storedSource);
      sessionStorage.removeItem("bamboo-project-type");
      sessionStorage.removeItem("bamboo-project-source");
    } catch {
      // Session storage is optional; entry intent simply does not apply.
    }
    if (!isGlobal && contextInstance?.minecraftVersion) {
      setSelectedVersion(contextInstance.minecraftVersion);
    }
  }

  const resultsRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (resultsRef.current) {
      resultsRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [page, selectedProjectType, search, source, pageSize]);

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize));
    } catch {
      // Persisting the page size is best effort.
    }
  }, [pageSize]);

  const [mcVersions, setMcVersions] = useState<string[]>([]);
  useEffect(() => {
    fetchVersionMap().then(vm => {
      if (vm?.minecraftVersions) {
        setMcVersions(vm.minecraftVersions.filter(v => /^\d+\.\d+(\.\d+)?$/.test(v)));
      }
    }).catch(() => {});
  }, []);

  const queryKey = [search, source, page, pageSize, sortIndex, selectedVersion, selectedCategory, selectedProjectType].join("\u0000");
  const isLoading = loadedQueryKey !== queryKey;

  const fetchMods = useCallback(async (append = false) => {
    if (append) {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setIsLoadingMore(true);
    }
    const requestId = ++requestSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const batchSize = pageSize === PAGE_SIZE_INFINITE ? INFINITE_BATCH : pageSize;
    const offset = append ? hitsRef.current.length : (page - 1) * batchSize;
    try {
      if (source === "curseforge") {
        const page = await fetchCurseForgePage({
          query: search,
          sortBy: String(sortIndexToCurseForgeSort(sortIndex)),
          gameVersion: selectedVersion !== "all" ? selectedVersion : undefined,
          modFilter: projectTypeToCfClassId(selectedProjectType),
          projectType: (selectedProjectType === "all" ? "mod" : selectedProjectType) as ProjectType,
          index: offset,
          pageSize: batchSize,
          isCurrent: () => requestId === requestSeq.current,
        });
        if (page.cancelled || requestId !== requestSeq.current) return;
        if (!page.failure) {
          const total = page.total || (append ? hitsRef.current.length + page.mapped.length : page.mapped.length);
          // CurseForge search cannot exclude a class id, so instance browsing filters
          // modpack/plugin hits out client-side instead of offering them as content.
          const visible = isGlobal ? page.mapped : page.mapped.filter((hit) => isInstanceCategory(hit.project_type));
          if (append) {
            setHits(prev => [...prev, ...visible]);
            setTotalHits(total);
          } else {
            startTransition(() => {
              setHits(visible);
              setTotalHits(total);
            });
          }
          setSearchError(null);
        } else if (!append) {
          setHits([]);
          setTotalHits(0);
          setSearchError(page.failure);
        }
      } else {
        const facets: string[][] = [];
        if (selectedProjectType !== "all") {
          facets.push([`project_type:${selectedProjectType}`]);
        } else if (!isGlobal) {
          // One OR group: only project types that can live inside an instance.
          facets.push(
            INSTANCE_BROWSER_PROJECT_TYPES
              .filter((type) => type !== "worlds")
              .map((type) => `project_type:${type}`),
          );
        }
        if (selectedVersion !== "all") {
          facets.push([`versions:${selectedVersion}`]);
        }
        if (selectedCategory !== "all") {
          facets.push([`categories:${selectedCategory.toLowerCase()}`]);
        }
        const facetQuery = facets.length > 0 ? `&facets=${encodeURIComponent(JSON.stringify(facets))}` : "";
        const collected: ModrinthHit[] = [];
        let cursor = offset;
        let total = 0;
        while (collected.length < batchSize) {
          const chunk = Math.min(MODRINTH_MAX_LIMIT, batchSize - collected.length);
          const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(search)}&limit=${chunk}&offset=${cursor}&index=${sortIndex}${facetQuery}`;
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error("Failed to fetch mods");
          const data = (await res.json()) as ModrinthSearchPayload;
          total = data.total_hits || total;
          const batch = data.hits || [];
          collected.push(...batch);
          cursor += batch.length;
          if (batch.length === 0 || cursor >= total) break;
        }
        if (requestId !== requestSeq.current) return;
        const nextTotal = total || collected.length;
        if (append) {
          setHits(prev => [...prev, ...collected]);
          setTotalHits(nextTotal);
        } else {
          startTransition(() => {
            setHits(collected);
            setTotalHits(nextTotal);
          });
        }
      }
    } catch (e) {
      if (controller.signal.aborted || requestId !== requestSeq.current) return;
      if (source === "curseforge" && !append) {
        setHits([]);
        setTotalHits(0);
        setSearchError({ code: 'network', detail: e instanceof Error ? e.message : undefined });
      }
    } finally {
      if (requestId === requestSeq.current) setLoadedQueryKey(queryKey);
      if (append) {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [search, source, page, pageSize, sortIndex, selectedVersion, selectedCategory, selectedProjectType, isGlobal, queryKey]);

  useEffect(() => {
    hitsRef.current = hits;
  }, [hits]);

  useEffect(() => {
    void fetchMods(false);
  }, [fetchMods]);

  const loadMore = useCallback(() => {
    if (isLoading || isLoadingMore || loadingMoreRef.current) return;
    if (hits.length === 0 || hits.length >= totalHits) return;
    void fetchMods(true);
  }, [fetchMods, hits.length, isLoading, isLoadingMore, totalHits]);

  useEffect(() => {
    if (pageSize !== PAGE_SIZE_INFINITE) return;
    const root = resultsRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: "800px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [pageSize, loadMore]);

  const handleFilterChange = () => setPage(1);

  const handleSourceChange = (next: "modrinth" | "curseforge") => {
    setSource(next);
    if (next === "curseforge") {
      setSelectedCategory("all");
      // CurseForge has no follower metric; its closest field is popularity.
      if (sortIndex === "follows") setSortIndex("downloads");
    } else if (selectedProjectType === "worlds") {
      // Worlds are a CurseForge-only project type.
      setSelectedProjectType("all");
    }
    handleFilterChange();
  };

  const handleQueryChange = useCallback((value: string) => {
    setPage(1);
    setSearch(value);
  }, []);

  const isModCompatibleWithInstance = (mod: ModrinthHit, inst: Instance): boolean => {
    if (mod.project_type === "worlds") return true;
    if (!mod.versions || mod.versions.length === 0) return false;
    return mod.versions.some(v => v === inst.minecraftVersion);
  };

  const fetchModVersionsFromApi = async (mod: ModrinthHit): Promise<string[]> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return mod.versions || [];
      const data = (await res.json()) as ModrinthVersion[];
      const allVersions: string[] = data.flatMap((v) => v.game_versions || []);
      return [...new Set(allVersions)].filter((v: string) => /^\d+\.\d+(\.\d+)?$/.test(v));
    } catch {
      return mod.versions || [];
    }
  };

  /**
   * The store's version list for a project, in the shared shape. One owner for
   * both sources, so Modrinth and CurseForge items are judged identically.
   */
  const fetchStoreVersions = async (
    mod: ModrinthHit,
    modSource: "modrinth" | "curseforge" = source,
  ): Promise<StoreVersion[]> => {
    try {
      if (modSource === "curseforge") {
        const files = await window.electronAPI?.mods.curseforgeFiles?.(mod.project_id, undefined, undefined);
        if (toCurseForgeFailure(files)) return [];
        if (!Array.isArray(files)) return [];
        return files.map(fromCurseForgeFile);
      }
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, {
        headers: { 'User-Agent': 'BambooLauncher/0.2.0' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((entry) => fromModrinthVersion(entry as Parameters<typeof fromModrinthVersion>[0]));
    } catch {
      return [];
    }
  };

  type InstallPick =
    | { kind: "picked"; version: StoreVersion; file: StoreFile; explicit: boolean }
    | {
        kind: "missing";
        reason: VersionMissReason | "unknown-version";
        /** Best candidate that failed one rule; only used after an explicit confirmation. */
        fallback: { version: StoreVersion; file: StoreFile; reason: "loader" | "mc-version" } | null;
      };

  /**
   * Resolves the version to install through the shared selector. There is no
   * "first version with any file" fallback: either a version fits the instance's
   * Minecraft version and loader, or the caller gets the reason plus - at most -
   * one candidate that the UI has to label as incompatible.
   */
  const resolveInstallPick = async (
    mod: ModrinthHit,
    inst: Instance,
    category: ContentCategory,
    forcedVersionNumber?: string,
    modSource: "modrinth" | "curseforge" = source,
  ): Promise<InstallPick> => {
    const versions = await fetchStoreVersions(mod, modSource);
    if (forcedVersionNumber) {
      const chosen = versions.find((version) => version.versionNumber === forcedVersionNumber);
      if (!chosen) return { kind: "missing", reason: "unknown-version", fallback: null };
      const file = versionFileFor(chosen, category);
      if (!file) return { kind: "missing", reason: "file", fallback: null };
      // A version the user picked by hand is installed as picked; swapping in a
      // different one silently is exactly what used to happen here.
      return { kind: "picked", version: chosen, file, explicit: true };
    }
    const pick = pickVersion(versions, {
      category,
      minecraftVersion: inst.minecraftVersion,
      modloader: inst.modloader,
    });
    if (pick.version && pick.file) {
      return { kind: "picked", version: pick.version, file: pick.file, explicit: false };
    }
    return {
      kind: "missing",
      reason: versions.length === 0 ? "no-versions" : pick.reason ?? "file",
      fallback: pick.fallback,
    };
  };

  /** Why a project cannot be installed here - said plainly, never silently. */
  const missReason = (reason: VersionMissReason | "unknown-version", inst: Instance): string => {
    switch (reason) {
      case "no-versions":
        return t.installMissNoVersions;
      case "mc-version":
        return formatMessage(t.installMissMcVersion, { mc: inst.minecraftVersion });
      case "loader":
        return formatMessage(t.installMissLoader, { loader: `${inst.modloader} ${inst.minecraftVersion}` });
      case "unknown-version":
        return t.installMissVersionGone;
      default:
        return t.installMissNoFile;
    }
  };

  const missMessage = (reason: VersionMissReason | "unknown-version", inst: Instance, mod: ModrinthHit): string => {
    return formatMessage(t.installMissTitle, { name: mod.title, reason: missReason(reason, inst) });
  };

  /** The explicit yes/no that a labelled, incompatible install requires. */
  const confirmIncompatibleFallback = (
    mod: ModrinthHit,
    inst: Instance,
    fallback: { version: StoreVersion; reason: "loader" | "mc-version" },
  ): boolean => {
    const reason =
      fallback.reason === "mc-version"
        ? formatMessage(t.installMissMcVersion, { mc: inst.minecraftVersion })
        : formatMessage(t.installMissLoader, { loader: `${inst.modloader} ${inst.minecraftVersion}` });
    return window.confirm(
      formatMessage(t.installIncompatibleFallback, {
        name: mod.title,
        version: fallback.version.versionNumber || "?",
        reason,
      }),
    );
  };

  const getLatestModpackVersion = async (
    mod: ModrinthHit,
    preferredGameVersion?: string,
  ): Promise<{ url: string; mcVersion: string; loader: ModpackLoader; versionNumber: string } | null> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return null;
      const data = (await res.json()) as ModrinthVersion[];
      const latest = pickModpackVersion(data, {
        ...(preferredGameVersion ? { gameVersion: preferredGameVersion } : {}),
      });
      if (!latest) return null;
      return {
        url: latest.url,
        mcVersion: latest.mcVersion,
        loader: latest.loader,
        versionNumber: latest.versionNumber,
      };
    } catch {
      return null;
    }
  };

  const handleInstallModpack = async (mod: ModrinthHit, preferredGameVersion?: string) => {
    setInstallingModId(mod.project_id);
    setInstallProgress(3);
    const newId = createInstanceId();
    let addedInstance = false;
    let unsubscribeProgress: (() => void) | undefined;
    let backgroundTaskId = "";
    let installFailure = "";
    try {
      const versionInfo = await getLatestModpackVersion(mod, preferredGameVersion);
      if (!versionInfo) {
        addToast({
          type: "error",
          message: lang === "de"
            ? `Keine gültige Modpack-Version für ${mod.title}${preferredGameVersion ? ` und Minecraft ${preferredGameVersion}` : ""} gefunden`
            : `No valid modpack version found for ${mod.title}${preferredGameVersion ? ` and Minecraft ${preferredGameVersion}` : ""}`,
        });
        return;
      }
      // Same modpack, second version (or a second copy) gets its own folder and
      // a name that names the version, so both instances stay distinguishable.
      const folderName = uniqueInstanceFolder(
        `${mod.slug}-${versionInfo.mcVersion}-${versionInfo.versionNumber}`,
        instances,
      );
      const nameTaken = instances.some(
        (instance) => instance.name.trim().toLowerCase() === mod.title.trim().toLowerCase(),
      );
      const instanceName = nameTaken
        ? uniqueInstanceName(`${mod.title} (${versionInfo.versionNumber})`, instances)
        : mod.title;
      backgroundTaskId = `modpack:${folderName}`;
      beginBackgroundTask({
        id: backgroundTaskId,
        title: lang === "de"
          ? `${mod.title} ${versionInfo.versionNumber} wird installiert…`
          : `Installing ${mod.title} ${versionInfo.versionNumber}…`,
        detail: versionInfo.versionNumber,
        percent: 3,
      });
      setInstallProgress(6);
      const newInst: Instance = {
        id: newId,
        folderName,
        name: instanceName,
        minecraftVersion: versionInfo.mcVersion,
        modloader: modpackLoaderLabel(versionInfo.loader),
        modloaderVersion: "",
        lastPlayed: "Gerade eben",
        size: "Modpack wird installiert...",
        modCount: 0,
        thumbnail: mod.icon_url || "",
        desc: mod.description,
        javaVersion: "Automatisch",
        installedMods: [],
        content: [],
        ram: 6144,
        isModpack: true,
        modpackProjectId: mod.project_id,
        modpackSource: "modrinth",
        modpackVersion: versionInfo.versionNumber,
      };
      if (setInstances) {
        setInstances(prev => [newInst, ...prev]);
        addedInstance = true;
      }
      unsubscribeProgress = window.electronAPI?.mods.onModpackProgress?.((data) => {
        if (data?.folderName === folderName && Number.isFinite(data.percent)) {
          setInstallProgress(Math.max(0, Math.min(100, Math.round(data.percent))));
        }
      });
      const result = await window.electronAPI?.mods.installModpack?.({
        folderName,
        mcVersion: versionInfo.mcVersion,
        loader: versionInfo.loader,
        mrpackUrl: versionInfo.url,
        mode: "install",
      });
      if (!result?.success) {
        if (addedInstance && setInstances) {
          setInstances(prev => prev.filter(instance => instance.id !== newId));
        }
        installFailure = result?.error || (lang === "de" ? "Modpack-Installation fehlgeschlagen" : "Modpack installation failed");
        addToast({
          type: "error",
          message: installFailure,
        });
        return;
      }

      let defaultRam = 6144;
      try {
        const settings = await window.electronAPI?.settings.get?.();
        if (settings?.defaultRam && typeof settings.defaultRam === 'number') {
          defaultRam = settings.defaultRam;
        }
      } catch {
        // Fall back to the default RAM when settings cannot be read.
      }
      const fileList = (result.index?.files || []) as ModpackIndexFile[];
      const contentItems = mergeOverrideContentItems(
        buildModpackContentItems(fileList),
        result.overrideFiles || [],
      );
      const installedSlugs = contentItems
        .map(item => item.projectId)
        .filter((slug): slug is string => Boolean(slug));
      if (setInstances) {
        setInstances(prev => prev.map(instance =>
          instance.id === newId ? {
            ...instance,
            ...(result.loader ? { modloader: modpackLoaderLabel(result.loader) } : {}),
            folderName: result.folderName || instance.folderName,
            minecraftVersion: result.mcVersion || instance.minecraftVersion,
            modloaderVersion: result.loaderVersion || instance.modloaderVersion || "",
            modCount: contentItems.filter(item => item.type === 'mods').length,
            size: `${contentItems.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
            content: contentItems,
            installedMods: installedSlugs,
            ram: defaultRam,
          } : instance
        ));
      }
      setInstallProgress(100);

      // Project pages, icons and versions arrive after the pack is usable, so a
      // slow metadata lookup never delays or fails the installation.
      void resolveModpackContentMetadata(fileList).then((metadata) => {
        if (!setInstances || Object.keys(metadata).length === 0) return;
        const enriched = mergeOverrideContentItems(
          buildModpackContentItems(fileList, metadata),
          result.overrideFiles || [],
        );
        const enrichedSlugs = enriched
          .map(item => item.projectId)
          .filter((slug): slug is string => Boolean(slug));
        setInstances(prev => prev.map(instance =>
          instance.id === newId ? {
            ...instance,
            content: enriched,
            installedMods: enrichedSlugs,
            modCount: enriched.filter(item => item.type === 'mods').length,
          } : instance
        ));
      }).catch(() => {
        // File-name entries remain a complete, usable fallback.
      });
      addToast({
        type: "success",
        message: lang === "de" ? `${mod.title} wurde installiert.` : `${mod.title} was installed.`,
      });
    } catch (e) {
      if (addedInstance && setInstances) {
        setInstances(prev => prev.filter(instance => instance.id !== newId));
      }
      installFailure = e instanceof Error ? e.message : "Modpack-Installation fehlgeschlagen";
      addToast({ type: "error", message: installFailure });
    } finally {
      if (backgroundTaskId) {
        if (installFailure) failBackgroundTask(backgroundTaskId, installFailure);
        else completeBackgroundTask(backgroundTaskId);
      }
      unsubscribeProgress?.();
      setInstallingModId(null);
      setInstallProgress(0);
    }
  };

  const fetchDependencies = async (mod: ModrinthHit, inst: Instance): Promise<{ projectId: string; slug: string }[]> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, {
        headers: { 'User-Agent': 'BambooLauncher/0.2.0' },
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as ModrinthVersion[];
      if (!Array.isArray(raw)) return [];
      // The dependency list is read from the very version the selector installs.
      const pick = pickVersion(raw.map(fromModrinthVersion), {
        category: "mods",
        minecraftVersion: inst.minecraftVersion,
        modloader: inst.modloader,
      });
      if (!pick.version) return [];
      const chosen = raw.find((version) => version.version_number === pick.version?.versionNumber);
      if (!chosen?.dependencies) return [];
      const deps: { projectId: string; slug: string }[] = [];
      for (const dep of chosen.dependencies) {
        if (dep.dependency_type !== 'required') continue;
        if (dep.project_id) {
          try {
            const slugRes = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}`);
            if (slugRes.ok) {
              const p = await slugRes.json();
              deps.push({ projectId: dep.project_id, slug: p.slug || p.id });
            }
          } catch { console.warn('[Mods] Failed to fetch dependency slug'); }
        }
      }
      return deps;
    } catch {
      return [];
    }
  };

  const installDependency = async (dep: { slug: string }, inst: Instance) => {
    try {
      const depRes = await fetch(`https://api.modrinth.com/v2/search?query=${dep.slug}&limit=1&facets=${encodeURIComponent(JSON.stringify([['project_type:mod']]))}`);
      if (!depRes.ok) return;
      const depData = await depRes.json();
      const depHit = depData.hits?.[0] as ModrinthHit | undefined;
      if (!depHit) return;
      // Dependencies are Modrinth projects, whatever source the browser shows.
      const pick = await resolveInstallPick(depHit, inst, "mods", undefined, "modrinth");
      if (pick.kind !== "picked") {
        addToast({
          type: "warning",
          message: formatMessage(t.dependencySkipped, {
            name: depHit.title,
            reason: missReason(pick.reason, inst),
          }),
        });
        return;
      }
      const folderName = instanceFolderKeyOf(inst);
      await window.electronAPI?.mods.download?.({
        folderName,
        profileName: inst.name,
        versionId: inst.minecraftVersion,
        downloadUrl: pick.file.url,
        filename: pick.file.filename,
        itemType: installItemTypeFor("mods"),
      });
      if (setInstances) {
        setInstances(prev => prev.map(i =>
          i.id === inst.id ? {
            ...i,
            installedMods: [...(i.installedMods || []), depHit.slug],
            modCount: (i.modCount || 0) + 1,              content: [...(i.content || []), {
                    id: depHit.slug, name: depHit.title, fileName: pick.file.filename,
                    version: inst.minecraftVersion, type: "mods", enabled: true, locked: false,
                    iconUrl: depHit.icon_url,
                    versionNumber: pick.version.versionNumber,
                    projectId: depHit.project_id,
                    source: "modrinth",
                  }]
          } : i
        ));
      }
    } catch { console.warn('[Mods] Failed to install dependency'); }
  };

  const installModToInstance = async (mod: ModrinthHit, inst: Instance, forcedVersion?: string) => {
    setInstallingModId(mod.project_id);
    setInstallProgress(0);
    let backgroundTaskId = "";
    let installFailure = "";
    try {
      const category = projectTypeToCategory(mod.project_type) ?? 'mods';
      const picked = await resolveInstallPick(mod, inst, category, forcedVersion);

      let version: StoreVersion;
      let file: StoreFile;
      let incompatible = false;
      if (picked.kind === 'picked') {
        version = picked.version;
        file = picked.file;
      } else if (picked.fallback) {
        // Nothing fits; only an explicit yes installs a labelled mismatch.
        if (!confirmIncompatibleFallback(mod, inst, picked.fallback)) {
          addToast({ type: "warning", message: missMessage(picked.reason, inst, mod) });
          return;
        }
        version = picked.fallback.version;
        file = picked.fallback.file;
        incompatible = true;
      } else {
        addToast({ type: "warning", message: missMessage(picked.reason, inst, mod) });
        return;
      }

      if (category === 'mods' && !incompatible) {
        const deps = await fetchDependencies(mod, inst);
        for (const dep of deps) {
          const alreadyInstalled = (inst.installedMods || []).includes(dep.slug) ||
            (inst.content || []).some(c => c.id === dep.slug);
          if (!alreadyInstalled) {
            await installDependency(dep, inst);
          }
        }
      }

      setInstallProgress(60);

      const folderName = instanceFolderKeyOf(inst);
      if (category === 'worlds') {
        backgroundTaskId = newBackgroundTaskId(`world:${folderName}`);
        beginBackgroundTask({
          id: backgroundTaskId,
          title: lang === 'de' ? `Welt wird installiert: ${mod.title}` : `Installing world: ${mod.title}`,
          detail: inst.name,
          percent: 1,
        });
      }
      const payload: DownloadModPayload = {
        folderName,
        profileName: inst.name,
        versionId: inst.minecraftVersion,
        filename: file.filename,
        itemType: installItemTypeFor(category),
        ...(backgroundTaskId ? { taskId: backgroundTaskId } : {}),
      };
      const curseForgeFileId = source === 'curseforge' ? Number(version.versionId) : NaN;
      if (Number.isFinite(curseForgeFileId) && curseForgeFileId > 0) {
        payload.curseforgeFileId = curseForgeFileId;
      } else {
        payload.downloadUrl = file.url;
      }
      if (!payload.curseforgeFileId && !payload.downloadUrl) {
        addToast({ type: "warning", message: missMessage('file', inst, mod) });
        return;
      }
      if (category === 'worlds') {
        payload.title = mod.title;
      }
      const result = await window.electronAPI?.mods.download?.(payload);

      setInstallProgress(90);

      if (result?.success) {
        if (setInstances) {
          setInstances(prev => prev.map(i => {
            if (i.id !== inst.id) return i;
            const base = {
              ...i,
              installedMods: category === 'mods' ? [...(i.installedMods || []), mod.slug] : i.installedMods,
              modCount: category === 'mods' ? (i.modCount || 0) + 1 : i.modCount,
            };
            // Worlds live in saves/ and are listed from disk, not from the
            // instance's content list.
            if (category === 'worlds') return base;
            return {
              ...base,
              content: [...(i.content || []), {
                id: mod.slug,
                name: mod.title,
                fileName: file.filename,
                version: inst.minecraftVersion,
                type: category,
                enabled: true,
                locked: false,
                iconUrl: mod.icon_url,
                versionNumber: version.versionNumber || inst.minecraftVersion,
                projectId: mod.project_id,
                source,
              }],
            };
          }));
        }
        if (category === 'worlds') {
          const installed = result.worlds?.[0];
          addToast({
            type: "success",
            message: installed
              ? installed.renamed
                ? formatMessage(t.worldInstalledRenamed, { name: installed.folderName })
                : formatMessage(t.worldInstalled, { name: installed.folderName })
              : formatMessage(t.worldInstalled, { name: mod.title }),
          });
        } else if (incompatible) {
          addToast({
            type: "warning",
            message: formatMessage(t.installIncompatibleDone, {
              name: mod.title,
              version: version.versionNumber || "?",
            }),
          });
        }
      } else if (result?.error) {
        installFailure = result.error;
        addToast({ type: "error", message: result.error });
      } else {
        installFailure = lang === 'de' ? 'Installation fehlgeschlagen' : 'Installation failed';
      }
      setInstallProgress(100);
    } catch (e) {
      installFailure = e instanceof Error ? e.message : "Installation fehlgeschlagen";
      addToast({ type: "error", message: installFailure });
    } finally {
      if (backgroundTaskId) {
        if (installFailure) failBackgroundTask(backgroundTaskId, installFailure);
        else completeBackgroundTask(backgroundTaskId);
      }
      setInstallingModId(null);
      setInstallProgress(0);
    }
  };

  const handleOpenInstancePicker = (mod: ModrinthHit) => {
    if (instances.length === 0) {
      addToast({ type: "warning", message: lang === "de" ? "Keine Instanzen verfügbar. Erstelle zuerst eine Instanz." : "No instances available. Create an instance first." });
      return;
    }
    setPendingModForInstall(mod);
    setShowInstancePicker(true);
  };

  const handleInstallToInstance = async (inst: Instance) => {
    if (!pendingModForInstall) return;
    setShowInstancePicker(false);
    await installModToInstance(pendingModForInstall, inst);
    setPendingModForInstall(null);
  };

  const handleInstallToContextInstance = async (mod: ModrinthHit) => {
    if (!contextInstance) return;
    await installModToInstance(mod, contextInstance);
  };

  const handleCompatibleClick = (inst: Instance) => {
    handleInstallToInstance(inst);
  };

  const handleIncompatibleClick = async (mod: ModrinthHit, inst: Instance) => {
    const confirmed = window.confirm(
      formatMessage(t.incompatibleInstanceConfirm, {
        name: inst.name,
        mod: mod.title,
        mc: inst.minecraftVersion,
      }),
    );
    if (!confirmed) return;
    setShowInstancePicker(false);
    setVersionPickerMod(mod);
    setVersionPickerInst(inst);
    const versions = await fetchModVersionsFromApi(mod);
    setModVersions(versions);
    setShowVersionPicker(true);
  };

  const handleVersionPickerInstall = async (version: string) => {
    if (!versionPickerMod || !versionPickerInst) return;
    setShowVersionPicker(false);
    await installModToInstance(versionPickerMod, versionPickerInst, version);
    setVersionPickerMod(null);
    setVersionPickerInst(null);
  };

  const finitePageSize = pageSize === PAGE_SIZE_INFINITE ? hits.length || 1 : pageSize;
  const totalPages = Math.ceil(totalHits / finitePageSize) || 1;
  const isInfinite = pageSize === PAGE_SIZE_INFINITE;

  const categoriesList = [
    { id: "all", label: t.allCategories },
    { id: "optimization", label: t.categoryPerformance },
    { id: "utility", label: t.categoryUtility },
    { id: "adventure", label: t.categoryAdventure },
    { id: "technology", label: t.categoryTechnology },
    { id: "magic", label: t.categoryMagic },
    { id: "decoration", label: t.categoryDecoration },
    { id: "worldgen", label: t.categoryWorldGen }
  ];

  const versionsList = [
    { id: "all", label: t.allVersions },
    ...mcVersions.map(v => ({ id: v, label: v }))
  ];

  const accent: AccentClasses = {
    text: "theme-text",
    bg: "theme-bg",
    bgLight: "theme-bg-light",
    border: "theme-border-light",
    glow: "theme-shadow-sm",
    hoverText: "group-hover:theme-text-bright",
    borderHover: "hover:theme-border-md",
    cardHover: "hover:theme-border-md",
  };

  const isInstalledInContext = (slug: string): boolean => {
    if (isGlobal || !contextInstance) return false;
    return (contextInstance.installedMods || []).includes(slug) ||
      (contextInstance.content || []).some(c => c.id === slug);
  };

  return (
    <div className="flex-1 overflow-hidden h-full p-6 flex flex-col gap-4 custom-scrollbar z-10 relative select-none">

      {selectedMod ? (
        <ModDetailWindow
          mod={selectedMod}
          source={source}
          contextInstance={contextInstance}
          isGlobal={isGlobal}
          accent={accent}
          onClose={() => setSelectedMod(null)}
          instances={instances}
          installModToInstance={installModToInstance}
                    fullWindow
                    lang={lang}
        />
      ) : (
        <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface border border-hairline rounded-2xl p-5 shadow-2xl shrink-0">
        <div className="flex items-center gap-4">
          {!isGlobal && (
            <button
              onClick={() => {
                if (onClearInstance) onClearInstance();
                setActiveTab("singleplayer");
              }}
              className="p-2 bg-surface/60 hover:bg-selected border border-stroke/80 hover:border-[color:var(--accent)]/30 text-ink-secondary hover:text-ink rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
          )}
          <div className="flex items-center gap-3">
            {!isGlobal && contextInstance && (
              <div className="w-10 h-10 rounded-xl overflow-hidden border border-stroke-strong shrink-0 bg-surface">
                {contextInstance.thumbnail ? (
                  <img src={contextInstance.thumbnail} alt={contextInstance.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-black" />
                )}
              </div>
            )}
            <div>
              <h2 className="text-title3 font-semibold text-ink flex items-center gap-2">
                {!isGlobal && contextInstance ? contextInstance.name : t.modBrowserTitle}
              </h2>
              {!isGlobal && contextInstance && (
                <p className="text-micro text-ink-secondary mt-0.5">
                  {contextInstance.minecraftVersion} · {contextInstance.modloader}{contextInstance.modloaderVersion ? ` ${contextInstance.modloaderVersion}` : ""}
                </p>
              )}
              <p className="text-micro text-ink-secondary mt-0.5">
                {!isGlobal && contextInstance
                  ? formatMessage(t.modBrowserInstanceDesc, { instance: contextInstance.name })
                  : t.modBrowserDesc}
              </p>
              {!isGlobal && contextInstance && !instanceLoadsMods(contextInstance.modloader) && (
                <p className="text-micro text-warning mt-1 flex items-center gap-1.5 max-w-2xl">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {t.vanillaNoLoaderNotice}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex bg-surface/40 border border-stroke p-1 rounded-xl shrink-0">
          <button
            onClick={() => handleSourceChange("modrinth")}
            className={`px-3 py-1.5 rounded-lg text-small font-semibold  flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
              source === "modrinth"
                ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
                : "text-ink-secondary hover:text-ink"
            }`}
          >
            Modrinth
          </button>
          <button
            onClick={() => handleSourceChange("curseforge")}
            className={`px-3 py-1.5 rounded-lg text-small font-semibold  flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
              source === "curseforge"
                ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
                : "text-ink-secondary hover:text-ink"
            }`}
          >
            CurseForge
          </button>
        </div>
      </div>

      <ModSearchField
        value={search}
        onQueryChange={handleQueryChange}
        placeholder={formatMessage(t.searchModsOn, { source: source === "modrinth" ? "Modrinth" : "CurseForge" })}
      />

      <div className="flex shrink-0 gap-1.5 flex-wrap items-center">
        <span className="text-micro font-medium text-ink-tertiary uppercase mr-1 tracking-label">{t.projectType}:</span>
        {[
          { id: "all", label: t.projectTypeAll },
          ...(isGlobal ? GLOBAL_BROWSER_PROJECT_TYPES : INSTANCE_BROWSER_PROJECT_TYPES)
            // Worlds are a CurseForge-only project type with their own path (see #18/#22).
            .filter((type) => type !== "worlds" || source === "curseforge")
            .map((type) => ({ id: type, label: projectTypeLabel[type] })),
        ].map((pt) => {
          const isSelected = selectedProjectType === pt.id;
          return (
            <button
              key={pt.id}
              onClick={() => { setSelectedProjectType(pt.id); handleFilterChange(); }}
              className={`px-3 py-1.5 rounded-lg text-micro font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border ${
                isSelected
                  ? `${accent.bgLight} ${accent.text} ${accent.border}`
                  : "bg-surface/20 border-stroke text-ink-secondary hover:text-ink hover:border-rim"
              }`}
            >
              {pt.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-stretch flex-1 min-h-0 max-lg:overflow-y-auto max-lg:pr-1 custom-scrollbar">
        <div className={`w-full lg:w-64 shrink-0 flex flex-col gap-4 bg-surface border border-hairline rounded-2xl p-4 shadow-2xl h-fit max-h-[calc(100vh-16rem)] overflow-y-auto custom-scrollbar lg:max-h-full ${source === "modrinth" ? "lg:min-h-0 lg:overflow-hidden" : ""}`}>
          <div className="flex shrink-0 items-center gap-2 text-micro font-medium text-ink-secondary uppercase border-b border-hairline pb-2.5 tracking-label">
            <Filter className="w-3.5 h-3.5 text-accent"  />
            {source === "modrinth" ? t.filterModDatabase : t.curseforgeSearch}
          </div>

          {source === "modrinth" && (
          <div className="flex flex-col gap-1 lg:min-h-0">
            <label className="shrink-0 text-micro font-medium text-ink-tertiary uppercase mb-1.5 text-left block tracking-label">{t.categories}</label>
            <div className="flex flex-col gap-0.5">
              {categoriesList.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => { setSelectedCategory(cat.id); handleFilterChange(); }}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-micro font-medium text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                      isSelected
                        ? "bg-accent/10 text-accent border-accent/20"
                        : "text-ink-secondary hover:text-ink hover:bg-hover"
                    }`}
                  >
                    <span>{cat.label}</span>
                    {isSelected && <Check className="w-3 h-3 text-accent"  />}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {isGlobal && (
          <div className="flex shrink-0 flex-col gap-1.5 mt-1">
            <label className="text-micro font-medium text-ink-tertiary uppercase text-left block tracking-label">{t.minecraftVersionLabel}</label>
            <select
              value={selectedVersion}
              onChange={(e) => { setSelectedVersion(e.target.value); handleFilterChange(); }}
              className="w-full bg-root border border-stroke rounded-lg px-2.5 py-1.5 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
            >
              {versionsList.map((ver) => (
                <option key={ver.id} value={ver.id}>{ver.label}</option>
              ))}
            </select>
          </div>
          )}

          <div className="flex shrink-0 flex-col gap-1.5 mt-1">
            <label className="text-micro font-medium text-ink-tertiary uppercase text-left block tracking-label">{t.itemsPerPage}</label>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(e.target.value === PAGE_SIZE_INFINITE ? PAGE_SIZE_INFINITE : Number(e.target.value) as ModsPageSize);
                // Every page size renumbers the result windows; page 3 of 20 is
                // not page 3 of 500. Start the new paging sequence at its first page.
                handleFilterChange();
              }}
              className="w-full bg-root border border-stroke rounded-lg px-2.5 py-1.5 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size} {t.perPage}</option>
              ))}
              <option value={PAGE_SIZE_INFINITE}>Infinite</option>
            </select>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-3 min-h-0 max-lg:min-h-[360px]">

          <div className="flex flex-row items-center justify-between gap-4 bg-surface/20 border border-stroke p-2 rounded-xl shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-micro text-ink-secondary font-medium">{t.sortBy}:</span>
              <select
                value={sortIndex}
                onChange={(e) => { setSortIndex(e.target.value as typeof sortIndex); handleFilterChange(); }}
                className="bg-root border border-stroke rounded-lg px-2.5 py-1 text-small font-medium text-ink outline-none focus:border-[color:var(--accent)]/50"
              >
                <option value="downloads">{t.mostDownloads}</option>
                <option value="relevance">{t.relevance}</option>
                {source !== "curseforge" && <option value="follows">{t.mostFollowed}</option>}
                <option value="newest">{t.newestReleased}</option>
                <option value="updated">{t.recentlyUpdated}</option>
              </select>
            </div>

            {hits.length > 0 && !isInfinite && !isLoading && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-micro text-ink-tertiary font-medium hidden sm:inline">
                  {t.page} {page} {t.of} {totalPages}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={page === 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="p-1 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    disabled={page === totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    className="p-1 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div ref={resultsRef} className="relative flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
            <div className="flex flex-col gap-2">
              {isLoading ? (
                <ModSkeletonList count={MOD_SKELETON_ROWS} label={t.queryingStore} />
              ) : (
                <>
              {hits.map((mod) => {
                const _installed = isInstalledInContext(mod.slug);
                const isInstalling = installingModId === mod.project_id;
                const showInstallBtn = isGlobal || !_installed;

                return (
                  <div
                    key={mod.project_id}
                    onClick={() => setSelectedMod(mod)}
                    className={`mod-result-row bg-surface border rounded-2xl px-5 py-2.5 flex items-center gap-4 group cursor-pointer transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] hover:shadow-xl text-left relative overflow-hidden min-h-[96px] shrink-0 ${accent.bgLight} ${accent.border}`}
                  >
                    <div className="w-14 h-14 rounded-2xl bg-surface border border-stroke flex items-center justify-center shrink-0 overflow-hidden relative shadow-md">
                      {mod.icon_url ? (
                        <img src={mod.icon_url} alt={mod.title} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-[var(--t-out)] ease-[var(--ease-out)]" />
                      ) : (
                        <Puzzle className="w-6 h-6 text-ink-tertiary" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-ink/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col justify-center h-full">
                      <div className="flex items-center gap-2">
                        <h3 className={`text-regular font-semibold text-ink ${accent.hoverText} transition-colors  truncate`}>
                          {mod.title}
                        </h3>
                        <span className="text-micro text-ink-tertiary font-medium truncate">
                          {formatMessage(t.byAuthor, { author: mod.author })}
                        </span>
                      </div>
                      <p className="text-micro text-ink-secondary line-clamp-2 mt-0.5 font-medium">
                        {mod.description}
                      </p>
                      <div className="flex items-center gap-3 text-micro text-ink-tertiary font-medium mt-1">
                        <span className="flex items-center gap-0.5 shrink-0">
                          <Download className="w-3 h-3 text-ink-tertiary" />
                          {formatCompactNumber(mod.downloads, lang)}
                        </span>
                        {/* CurseForge has no follow count; its API only exposes a
                            0-5 rating, so a person icon here was never meaningful. */}
                        {source !== "curseforge" && (
                          <span className="flex items-center gap-0.5 shrink-0">
                            <Users className="w-3 h-3 text-ink-tertiary" />
                            {formatCompactNumber(mod.follows, lang)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 pl-2" onClick={(e) => e.stopPropagation()}>
                      {showInstallBtn ? (
                        <button
                          type="button"
                          disabled={isInstalling}
                          onClick={() => {
                            if (mod.project_type === "modpack") {
                              // A modpack is a whole instance; never content of one.
                              if (isGlobal) {
                                handleInstallModpack(mod, selectedVersion !== "all" ? selectedVersion : undefined);
                              } else {
                                addToast({ type: "warning", message: t.modpackNotInstanceContent });
                              }
                            } else if (isGlobal) {
                              handleOpenInstancePicker(mod);
                            } else {
                              handleInstallToContextInstance(mod);
                            }
                          }}
                          className={`relative overflow-hidden px-3 py-1.5 rounded-lg text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] flex items-center gap-1 cursor-pointer ${
                            isInstalling
                              ? "bg-accent/10 text-accent border-[color:var(--accent)]/20"
                              : `${accent.bg} text-accent-contrast shadow-lg ${accent.glow}`
                          }`}
                        >
                          {isInstalling && (
                            <span
                              aria-hidden
                              className="absolute inset-y-0 left-0 bg-accent/20 transition-[width] duration-300 ease-[var(--ease-out)]"
                              style={{ width: `${installProgress}%` }}
                            />
                          )}
                          <span className="relative flex items-center gap-1 tabular-nums">
                            {isInstalling ? (
                              <>
                                <RefreshCw className="w-3 h-3 animate-spin" />
                                {installProgress}%
                              </>
                            ) : (
                              <>
                                <Plus className="w-3 h-3 stroke-[3]" />
                                {t.install}
                              </>
                            )}
                          </span>
                        </button>
                      ) : (
                        <span className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-micro font-medium text-accent bg-[color:var(--accent)]/10 border border-[color:var(--accent)]/20">
                          <Check className="w-3 h-3 stroke-[3]" />
                          {t.installed}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {isLoadingMore && (
                <ModSkeletonList count={2} label={t.queryingStore} />
              )}

              {searchError && (
                <div className="flex flex-col items-center gap-3">
                  <CurseForgeFailureNotice
                    failure={searchError}
                    lang={lang}
                    className="py-24"
                    actions={canRetryCurseForge(searchError) ? (
                      <>
                        <button
                          type="button"
                          onClick={() => fetchMods()}
                          className="px-3 py-1.5 rounded-lg bg-surface border border-stroke hover:border-rim text-small font-medium text-ink flex items-center gap-1.5 transition-[color,background-color,border-color,box-shadow,opacity] cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          {t.cfRetry}
                        </button>
                      </>
                    ) : undefined}
                  />
                </div>
              )}

              {hits.length === 0 && !searchError && (
                <div className="py-24 text-center flex flex-col items-center justify-center gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
                    <Puzzle className="w-8 h-8" />
                  </div>
                  <p className="text-regular font-medium text-ink">{t.noModsFound}</p>
                  <p className="text-small text-ink-tertiary">{t.noModsFoundHint}</p>
                </div>
              )}
                </>
              )}

              <div ref={sentinelRef} aria-hidden className="h-px w-full shrink-0" />
            </div>
          </div>

          {hits.length > 0 && !isLoading && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-surface/20 border border-stroke p-2 rounded-xl shrink-0 mt-2">
              <span className="text-micro text-ink-secondary font-medium">
                {isInfinite ? (
                  <>
                    <strong className="text-ink">{formatNumber(hits.length, lang)}</strong> {t.of} <strong className="text-ink">{formatNumber(totalHits, lang)}</strong> {t.mods}
                  </>
                ) : (
                  <>
                    {t.showing} <strong className="text-ink">{formatNumber((page - 1) * finitePageSize + 1, lang)}</strong> - <strong className="text-ink">{formatNumber(Math.min(page * finitePageSize, totalHits), lang)}</strong> {t.of} <strong className="text-ink">{formatNumber(totalHits, lang)}</strong> {t.mods}
                  </>
                )}
              </span>
              {!isInfinite && (
                <div className="flex items-center gap-1">
                  <button
                    disabled={page === 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="p-1.5 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-micro font-medium text-ink px-3 py-1.5 bg-root/60 border border-stroke rounded-lg">
                    {t.page} {page} / {totalPages}
                  </span>
                  <button
                    disabled={page === totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    className="p-1.5 bg-root border border-stroke hover:border-rim text-ink-secondary hover:text-ink rounded-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
        </>
      )}

      <AnimatePresence>
        {showInstancePicker && pendingModForInstall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-hairline flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 text-accent"  />
                  <h3 className="text-large font-semibold text-ink">{t.installModTitle}</h3>
                </div>
                <button
                  onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
                  className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
                <p className="text-small text-ink-secondary mb-2">
                  {t.chooseInstanceForModPrefix} <strong className="text-ink">{pendingModForInstall.title}</strong>:
                </p>

                {instances.length === 0 ? (
                  <div className="py-8 text-center flex flex-col items-center gap-2">
                    <Package className="w-10 h-10 text-ink-tertiary" />
                    <p className="text-regular text-ink-secondary">{t.noInstancesYet}</p>
                    <p className="text-small text-ink-tertiary">{t.createInstanceFirst}</p>
                  </div>
                ) : (
                  instances.map(inst => {
                    const isCompatible = isModCompatibleWithInstance(pendingModForInstall, inst);
                    const alreadyInstalled = isInstalledInContext(pendingModForInstall.slug);
                    return (
                      <div
                        key={inst.id}
                        onClick={() => {
                          if (alreadyInstalled) return;
                          if (isCompatible) {
                            handleCompatibleClick(inst);
                          } else {
                            handleIncompatibleClick(pendingModForInstall, inst);
                          }
                        }}
                        className={`p-4 rounded-2xl border flex items-center justify-between gap-4 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                          alreadyInstalled
                            ? "bg-accent/10 border-[color:var(--accent)]/20 opacity-60 cursor-default"
                            : isCompatible
                            ? "bg-surface/20 border-stroke hover:border-[color:var(--accent)]/30 hover:bg-hover"
                            : "bg-surface/10 border-hairline opacity-50 hover:opacity-80 hover:border-warning/30"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-surface border border-stroke overflow-hidden shrink-0">
                            {inst.thumbnail ? (
                              <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="h-full w-full bg-black" />
                            )}
                          </div>
                          <div className="text-left min-w-0">
                            <span className="text-regular font-medium text-ink truncate block">{inst.name}</span>
                            <span className="text-micro text-ink-tertiary">{inst.minecraftVersion} · {inst.modloader}</span>
                          </div>
                        </div>

                        <div className="shrink-0">
                          {alreadyInstalled ? (
                            <span className="flex items-center gap-1 text-micro font-medium text-accent border border-[color:var(--accent)]/20 px-3 py-1.5 rounded-lg bg-accent/10">
                              <Check className="w-3 h-3" /> {t.installed}
                            </span>
                          ) : isCompatible ? (
                            <span className="bg-accent hover:opacity-80 text-accent-contrast px-4 py-1.5 rounded-lg text-micro font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] block" style={{ backgroundColor: 'var(--accent)' }}>
                              {t.install}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-3 py-1.5 rounded-lg">
                              <AlertTriangle className="w-3 h-3" /> {t.notCompatibleShort}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="p-4 bg-surface/40 border-t border-hairline flex justify-end">
                <button
                  onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {t.cancel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showVersionPicker && versionPickerMod && versionPickerInst && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-hairline flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-warning" />
                  <h3 className="text-large font-semibold text-ink">{t.chooseVersionTitle}</h3>
                </div>
                <button
                  onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
                  className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-4">
                <p className="text-small text-ink-secondary">
                  {t.chooseMcVersionForPrefix} <strong className="text-ink">{versionPickerMod.title}</strong> {t.inInstance} <strong className="text-ink">{versionPickerInst.name}</strong>:
                </p>
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                  {modVersions.length === 0 ? (
                    <p className="text-small text-ink-tertiary py-4 text-center">{t.noVersions}</p>
                  ) : (
                    modVersions.map(ver => (
                      <button
                        key={ver}
                        onClick={() => handleVersionPickerInstall(ver)}
                        className="bg-surface/20 hover:bg-hover border border-stroke hover:border-[color:var(--accent)]/30 px-4 py-2.5 rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] text-left"
                      >
                        {ver}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="p-4 bg-surface/40 border-t border-hairline flex justify-end">
                <button
                  onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {t.cancel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
});

interface ModDetailWindowProps {
  mod: ModrinthHit;
  source: "modrinth" | "curseforge";
  contextInstance: Instance | null;
  isGlobal: boolean;
  accent: AccentClasses;
  onClose: () => void;
  instances: Instance[];
  installModToInstance: (mod: ModrinthHit, inst: Instance, forcedVersion?: string) => Promise<void>;
  fullWindow?: boolean;
  lang: LanguageType;
}

const ModDetailWindow: React.FC<ModDetailWindowProps> = ({
  mod, source, contextInstance, isGlobal, accent, onClose,
  instances, installModToInstance, fullWindow, lang,
}) => {
  const tr = translations[lang];
  const [tab, setTab] = useState<"description" | "versions">("description");
  const [project, setProject] = useState<ModDetail | null>(null);
  const [versions, setVersions] = useState<ModDetailVersion[]>([]);
  const [detailFailure, setDetailFailure] = useState<CurseForgeFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaderFilter, setLoaderFilter] = useState("");
  const [versionFilter, setVersionFilter] = useState("");

  const [showInstallPicker, setShowInstallPicker] = useState(false);
  const [installVer, setInstallVer] = useState<ModDetailVersion | null>(null);
  const [showIncompWarning, setShowIncompWarning] = useState(false);
  const [incompVer, setIncompVer] = useState<ModDetailVersion | null>(null);
  const [incompInst, setIncompInst] = useState<Instance | null>(null);

  const isCurseforge = source === "curseforge";

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setDetailFailure(null);
      try {
        if (isCurseforge && window.electronAPI?.mods.curseforgeProject) {
          const projectData = await window.electronAPI?.mods.curseforgeProject(mod.project_id);
          const projectFailure = toCurseForgeFailure(projectData);
          if (projectFailure) setDetailFailure(projectFailure);
          if (!projectFailure && projectData && 'name' in projectData) {
            setProject({
              title: projectData.name,
              author: projectData.authors?.[0]?.name || "Unknown",
              body: projectData.fullDescription || projectData.description || projectData.summary || "",
              description: projectData.summary || "",
              icon_url: projectData.logo?.url || mod.icon_url,
              downloads: projectData.downloadCount,
              slug: projectData.slug || mod.slug,
            });
          }
          const cfLoaderType = contextInstance?.modloader ? cfLoaderNameToType(contextInstance.modloader) : undefined;
          const filesResult = await window.electronAPI?.mods.curseforgeFiles?.(mod.project_id, undefined, cfLoaderType);
          const filesFailure = toCurseForgeFailure(filesResult);
          if (filesFailure) setDetailFailure((current) => current ?? filesFailure);
          if (!filesFailure && Array.isArray(filesResult)) {
            setVersions(filesResult.map((f) => ({
              version_number: f.displayName || f.fileName || String(f.id),
              date_published: f.fileDate || "",
              game_versions: f.gameVersions || [],
              loaders: (() => {
                const num = f.modLoader;
                if (num == null) return [];
                const map: Record<number, string> = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
                return map[num as number] ? [map[num as number]] : [String(num).toLowerCase()];
              })(),
              files: [{ url: f.downloadUrl || "", filename: f.fileName || `${mod.slug}.jar`, primary: true }],
            })));
          }
        } else {
          const [projectRes, versionsRes] = await Promise.all([
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}`, { headers: { 'User-Agent': 'BambooLauncher/0.2.0' } }),
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, { headers: { 'User-Agent': 'BambooLauncher/0.2.0' } }),
          ]);
          if (projectRes.ok) {
            const p = (await projectRes.json()) as ModDetail;
            setProject({
              title: p.title,
              author: p.author,
              body: p.body,
              description: p.description,
              icon_url: p.icon_url,
              downloads: p.downloads,
              slug: p.slug,
            });
          }
          if (versionsRes.ok) {
            const v = (await versionsRes.json()) as ModrinthVersion[];
            setVersions(v.map((ver) => ({
              version_number: ver.version_number || "",
              date_published: ver.date_published || "",
              game_versions: ver.game_versions || [],
              loaders: ver.loaders || [],
              files: (ver.files || []).map((f) => ({
                url: f.url,
                filename: f.filename,
                primary: f.primary || false,
              })),
            })));
          }
        }
      } catch (err) {
        console.error("Failed to load mod details:", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [mod.project_id, mod.icon_url, mod.slug, contextInstance?.modloader, isCurseforge]);

    const desc = project?.body || project?.description || mod.description || (lang === "de" ? "Keine Beschreibung verfügbar." : "No description available.");
  const allLoaders = [...new Set(versions.flatMap(v => v.loaders))].sort();
  const allMcVersions = [...new Set(versions.flatMap(v => v.game_versions))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  let filteredVersions = versions;
  if (loaderFilter) filteredVersions = filteredVersions.filter(v => v.loaders.includes(loaderFilter));
  if (versionFilter) filteredVersions = filteredVersions.filter(v => v.game_versions.includes(versionFilter));

  const profileMc = contextInstance?.minecraftVersion || "";
  const detailCategory = projectTypeToCategory(mod.project_type) ?? "mods";

  const toStoreVersion = (ver: ModDetailVersion): StoreVersion => ({
    versionNumber: ver.version_number,
    published: ver.date_published,
    gameVersions: ver.game_versions,
    loaders: ver.loaders,
    files: ver.files,
  });

  // The version list is judged by the same selector the install uses, so a row
  // can never look installable here and be refused on install (or the reverse).
  const isVersionInstallable = (ver: ModDetailVersion): boolean => {
    const version = toStoreVersion(ver);
    if (!versionFileFor(version, detailCategory)) return false;
    return isVersionCompatible(version, {
      category: detailCategory,
      minecraftVersion: profileMc,
      modloader: contextInstance?.modloader,
    });
  };

  const handleInstallVersion = (ver: ModDetailVersion) => {
    const incompatible = !isVersionInstallable(ver);

    if (incompatible && contextInstance) {
      setIncompVer(ver);
      setIncompInst(contextInstance);
      setShowIncompWarning(true);
    } else if (isGlobal) {
      setInstallVer(ver);
      setShowInstallPicker(true);
    } else if (contextInstance) {
      installModToInstance(mod, contextInstance, ver.version_number);
    }
  };

  const handleInstallFromPicker = async (inst: Instance) => {
    if (installVer) {
      setShowInstallPicker(false);
      await installModToInstance(mod, inst, installVer.version_number);
      setInstallVer(null);
    }
  };

  const handleIncompConfirm = async () => {
    if (incompVer && incompInst) {
      setShowIncompWarning(false);
      await installModToInstance(mod, incompInst, incompVer.version_number);
      setIncompVer(null);
      setIncompInst(null);
    }
  };

  const handleInstall = (ver: ModDetailVersion) => handleInstallVersion(ver);

  const detailContent = (
    <>
      <div className="px-6 pt-6 pb-4 border-b border-hairline flex items-start justify-between gap-4 shrink-0">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="w-14 h-14 rounded-2xl bg-surface border border-stroke overflow-hidden shrink-0 shadow-lg">
            <img
              src={project?.icon_url || mod.icon_url}
              alt={project?.title || mod.title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            {(!project?.icon_url && !mod.icon_url) && (
              <div className="w-full h-full flex items-center justify-center">
                <Package className="w-7 h-7 text-ink-tertiary" />
              </div>
            )}
          </div>
          <div className="text-left min-w-0 flex-1">
            <h2 className="text-title3 font-semibold text-ink truncate">
              {project?.title || mod.title}
            </h2>
            <p className="text-small text-ink-secondary mt-0.5">{formatMessage(tr.byAuthor, { author: project?.author || mod.author })}</p>
            <div className="flex items-center gap-3 mt-1.5 text-micro text-ink-tertiary">
              <span className="flex items-center gap-1">
                <Download className="w-3.5 h-3.5" />
                {formatCompactNumber(project?.downloads ?? mod.downloads, lang)}
              </span>
              {/* CurseForge only exposes a 0-5 rating here, not a follower count. */}
              {!isCurseforge && (
                <span className="flex items-center gap-1">
                  <Star className="w-3.5 h-3.5" />
                  {formatCompactNumber(mod.follows, lang)}
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-surface hover:bg-hover border border-stroke text-ink-secondary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shrink-0"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex border-b border-hairline shrink-0 px-6">
        <button
          onClick={() => setTab("description")}
          className={`px-5 py-3 text-small font-medium  transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] border-b-2 cursor-pointer ${
            tab === "description"
                ? `${accent.text} ${accent.border}`
                : "text-ink-secondary border-transparent hover:text-ink"
          }`}
        >
          {tr.descriptionTab}
        </button>
        <button
          onClick={() => setTab("versions")}
          className={`px-5 py-3 text-small font-medium  transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] border-b-2 cursor-pointer ${
            tab === "versions"
              ? `${accent.text} ${accent.border}`
              : "text-ink-secondary border-transparent hover:text-ink"
          }`}
        >
          {tr.versions} ({versions.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {tab === "description" ? (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-ink-secondary animate-spin" />
              </div>
            ) : detailFailure ? (
              <CurseForgeFailureNotice
                failure={detailFailure}
                lang={lang}
                title={tr.cfDetailFailed}
                className="py-10"
              />
            ) : (
              <div
                className="mod-description"
                onClick={(event) => {
                  const anchor = (event.target as HTMLElement).closest("a");
                  if (!anchor) return;
                  event.preventDefault();
                  const href = anchor.getAttribute("href") ?? "";
                  if (/^https?:\/\//i.test(href)) window.electronAPI?.system.openExternal?.(href);
                }}
                dangerouslySetInnerHTML={{
                  __html: renderDescription(
                    desc,
                    isCurseforge ? "html" : "markdown",
                    sanitizeDescription,
                  ),
                }}
              />
            )}
          </div>
        ) : (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-ink-secondary animate-spin" />
              </div>
            ) : detailFailure && versions.length === 0 ? (
              <CurseForgeFailureNotice
                failure={detailFailure}
                lang={lang}
                title={tr.cfDetailFailed}
                className="py-10"
              />
            ) : versions.length === 0 ? (
              <p className="text-regular text-ink-secondary py-12 text-center">{tr.noVersionsFound}</p>
            ) : (
              <>
                <div className="flex gap-3 mb-4 flex-wrap">
                  <select
                    value={loaderFilter}
                    onChange={(e) => setLoaderFilter(e.target.value)}
                    className="bg-surface border border-stroke rounded-lg px-3 py-1.5 text-small font-medium text-ink outline-none"
                  >
                    <option value="">{tr.allLoaders}</option>
                    {allLoaders.map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                  <select
                    value={versionFilter}
                    onChange={(e) => setVersionFilter(e.target.value)}
                    className="bg-surface border border-stroke rounded-lg px-3 py-1.5 text-small font-medium text-ink outline-none"
                  >
                    <option value="">{tr.allMcVersions}</option>
                    {allMcVersions.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <span className="text-micro text-ink-tertiary self-center font-medium">
                    {formatMessage(tr.versionCount, { count: filteredVersions.length })}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {[...filteredVersions].sort((a, b) => {
                    const aCompatible = isVersionInstallable(a);
                    const bCompatible = isVersionInstallable(b);
                    if (aCompatible && !bCompatible) return -1;
                    if (!aCompatible && bCompatible) return 1;
                    return new Date(b.date_published).getTime() - new Date(a.date_published).getTime();
                  }).map(ver => {
                    const incompatible = !isVersionInstallable(ver);

                    return (
                      <div
                        key={ver.version_number}
                        className={`bg-surface/30 border rounded-xl p-4 flex items-center justify-between gap-4 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] ${
                          incompatible
                            ? "border-hairline opacity-50"
                            : `border-hairline ${accent.cardHover || 'hover:border-rim'}`
                        }`}
                      >
                        <div className="flex-1 min-w-0 text-left">
                          <div className="flex items-center gap-2">
                            <span className="text-small font-medium text-ink">
                              {ver.version_number}
                            </span>
                            {incompatible && (
                              <AlertTriangle className="w-4 h-4 text-warning shrink-0" aria-label={tr.incompatibleWithInstance} />
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-micro text-ink-tertiary">
                            <span>{new Date(ver.date_published).toLocaleDateString()}</span>
                            <span>·</span>
                            <span>{ver.loaders.join(', ') || tr.allLabel}</span>
                            <span>·</span>
                            <span>{ver.game_versions.slice(0, 3).join(', ')}{ver.game_versions.length > 3 ? ' ...' : ''}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleInstall(ver)}
 className={`shrink-0 px-4 py-2 rounded-xl text-micro font-semibold transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shadow-lg ${
                            incompatible
                              ? "bg-warning/10 text-warning border border-warning/20 hover:bg-warning/20"
                              : `${accent.bg} text-accent-contrast ${accent.glow}`
                          }`}
                        >
                          {incompatible ? `⚠️ ${tr.install}` : tr.install}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="p-4 bg-surface/40 border-t border-hairline flex justify-between items-center shrink-0">
        <span className="text-micro text-ink-tertiary font-medium">
          {tr.source}: {source === "modrinth" ? "Modrinth API v2" : "CurseForge API"}
        </span>
        <button
          onClick={onClose}
          className="bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
        >
          {tr.close}
        </button>
      </div>
    </>
  );

  return (
    <>
      {fullWindow ? (
        <div className="flex flex-col h-full w-full overflow-hidden bg-surface border border-hairline rounded-2xl shadow-2xl">
          {detailContent}
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/94 flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {detailContent}
          </motion.div>
        </motion.div>
      )}

      <AnimatePresence>
        {showInstallPicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-large font-semibold text-ink mb-4">{tr.installInto}</h3>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                {instances.map(inst => (
                  <button
                    key={inst.id}
                    onClick={() => handleInstallFromPicker(inst)}
                    className="bg-surface/30 hover:bg-hover border border-hairline rounded-xl px-4 py-3 text-left text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  >
                    {inst.name} · {inst.minecraftVersion}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
                className="mt-4 bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
              >
                {tr.cancel}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showIncompWarning && incompVer && incompInst && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowIncompWarning(false); }}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
              className="bg-root border border-warning/30 rounded-2xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-2xl bg-warning/10 border border-warning/20 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-warning" />
                </div>
                <div>
                  <h3 className="text-large font-semibold text-ink">{tr.incompatibleVersionTitle}</h3>
                  <p className="text-small text-ink-secondary mt-0.5">
                    {formatMessage(tr.incompatibleVersionBody, {
                      version: incompVer.version_number,
                      instance: incompInst.name,
                      mc: incompInst.minecraftVersion,
                      loader: incompInst.modloader,
                    })}
                  </p>
                </div>
              </div>
              <p className="text-small text-ink-tertiary mb-5">
                {tr.incompatibleVersionWarning}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setShowIncompWarning(false); }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink px-5 py-2.5 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {tr.cancel}
                </button>
                <button
                  onClick={handleIncompConfirm}
                  className="bg-warning hover:bg-warning/90 text-accent-contrast px-5 py-2.5 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shadow-lg shadow-warning/10"
                >
                  {tr.installAnyway}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};