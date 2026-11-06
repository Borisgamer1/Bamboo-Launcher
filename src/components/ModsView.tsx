import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, startTransition } from "react";
import { TabType } from "./Sidebar";
import { Instance } from "./InstancesView";
import { translations, formatMessage, LanguageType } from "../lib/translations";
import type { CurseForgeFailure } from "../lib/curseforge";
import { mainErrorText } from "../lib/mainErrors";
import { fetchVersionMap } from "../lib/versionApi";
import {
  INSTANCE_BROWSER_PROJECT_TYPES,
  installItemTypeFor,
  isInstanceCategory,
  projectTypeToCategory,
  type ProjectType,
} from "../lib/contentCategories";
import type { StoreFile, StoreVersion } from "../lib/modVersions";
import type { DownloadModPayload } from "../electron";
import { useToast } from "./Toast";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from "../lib/backgroundTasks";
import { instanceFolderKeyOf } from "../lib/instanceFolders";
import { type AccentClasses, type ModrinthHit } from "./mods/modDetailModel";
import {
  createInstallPicker,
  fetchModVersionsFromApi,
  isModCompatibleWithInstance,
} from "./mods/modsViewHelpers";
import { ModDetailWindow } from "./mods/ModDetailWindow";
import { ModsHeader } from "./mods/ModsHeader";
import { ModsFilters } from "./mods/ModsFilters";
import { ModsResultList } from "./mods/ModsResultList";
import { useModpackInstall } from "../hooks/useModpackInstall";
import {
  PAGE_SIZE_INFINITE,
  PAGE_SIZE_STORAGE_KEY,
  browserStateKey,
  fetchCurseForgePage,
  projectTypeToCfClassId,
  readBrowserState,
  readProjectSource,
  readProjectType,
  readSavedPageSize,
  sortIndexToCurseForgeSort,
  type ModsPageSize,
  type SavedBrowserState,
} from "../lib/modsBrowser";
import { ModSearchField } from "./mods/ModSearchField";
import { InstancePickerDialog, VersionPickerDialog } from "./mods/InstallDialogs";

const INFINITE_BATCH = 50;
const MODRINTH_MAX_LIMIT = 100;

interface ModrinthSearchPayload {
  hits?: ModrinthHit[];
  total_hits?: number;
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

export const ModsView = React.memo(function ModsView({ setActiveTab, searchQuery: initialSearch, instances = [], setInstances, fromInstanceId, onClearInstance, lang }: ModsViewProps) {
  const { addToast } = useToast();
  const isGlobal = !fromInstanceId;
  const contextInstance = fromInstanceId ? instances.find(i => i.id === fromInstanceId) : null;
  // The browser is unmounted when the instance is opened and mounted again on
  // the way back. Keep the visible page and scroll offset so that round trip
  // returns to the same spot instead of resetting to the first result.
  const [initialBrowserState] = useState(() => readBrowserState(fromInstanceId ?? undefined));
  const [search, setSearch] = useState(() => initialSearch || initialBrowserState?.search || '');
  const [source, setSource] = useState<"modrinth" | "curseforge">(() => initialBrowserState?.source ?? readProjectSource());
  const [pageSize, setPageSize] = useState<ModsPageSize>(() => initialBrowserState?.pageSize ?? readSavedPageSize());
  const [page, setPage] = useState(() => initialBrowserState?.page ?? 1);
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
  const [sortIndex, setSortIndex] = useState<"relevance" | "downloads" | "follows" | "newest" | "updated">(() => initialBrowserState?.sortIndex ?? "downloads");
  const [selectedVersion, setSelectedVersion] = useState<string>(() => initialBrowserState?.selectedVersion ?? contextInstance?.minecraftVersion ?? "all");
  const [selectedCategory, setSelectedCategory] = useState<string>(() => initialBrowserState?.selectedCategory ?? "all");
  const [selectedProjectType, setSelectedProjectType] = useState<string>(() => {
    if (initialBrowserState) return initialBrowserState.selectedProjectType;
    const stored = readProjectType();
    // Browsing for an instance offers instance content only (no modpacks/plugins).
    return !isGlobal && stored !== "all" && !isInstanceCategory(stored) ? "mod" : stored;
  });
  const entryContextId = contextInstance?.id ?? null;
  const appliedContextId = useRef<string | null | undefined>(undefined);
  const [selectedMod, setSelectedMod] = useState<ModrinthHit | null>(null);
  const [installingModId, setInstallingModId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState(0);
  const handleInstallModpack = useModpackInstall({
    lang,
    instances,
    setInstances,
    setInstallingModId,
    setInstallProgress,
    addToast,
  });
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
      if (!initialBrowserState) {
        if (storedType) {
          const nextType = !isGlobal && storedType !== "all" && !isInstanceCategory(storedType) ? "mod" : storedType;
          setSelectedProjectType(nextType);
          setPage(1);
        }
        if (storedSource === "curseforge" || storedSource === "modrinth") setSource(storedSource);
        if (!isGlobal && contextInstance?.minecraftVersion) {
          setSelectedVersion(contextInstance.minecraftVersion);
        }
      }
      sessionStorage.removeItem("bamboo-project-type");
      sessionStorage.removeItem("bamboo-project-source");
    } catch {
      // Session storage is optional; entry intent simply does not apply.
    }
  }

  const resultsRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<number | null>(initialBrowserState?.scrollTop ?? null);
  const scrollTopRef = useRef(initialBrowserState?.scrollTop ?? 0);
  const persistBrowserState = useCallback(() => {
    try {
      sessionStorage.setItem(browserStateKey(fromInstanceId ?? undefined), JSON.stringify({
        page,
        scrollTop: scrollTopRef.current,
        search,
        source,
        sortIndex,
        selectedVersion,
        selectedCategory,
        selectedProjectType,
        pageSize,
      } satisfies SavedBrowserState));
    } catch {
      // Restoring the position is best effort; browsing must not fail with it.
    }
  }, [
    page,
    fromInstanceId,
    search,
    source,
    sortIndex,
    selectedVersion,
    selectedCategory,
    selectedProjectType,
    pageSize,
  ]);

  useEffect(() => {
    persistBrowserState();
    return persistBrowserState;
  }, [persistBrowserState]);

  const openModDetail = (mod: ModrinthHit) => {
    // The detail view replaces the results list, so the scroll container is
    // unmounted. Keep the offset until the list is mounted again on close.
    pendingScrollRef.current = scrollTopRef.current;
    setSelectedMod(mod);
  };

  useEffect(() => {
    // A restored scroll offset is applied below once the results have loaded.
    if (pendingScrollRef.current !== null) return;
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

  // Restore the offset as soon as the rows are in the DOM. A layout effect runs
  // before the first paint and does not depend on an animation frame, so the
  // position also survives a backgrounded or heavily throttled window.
  useLayoutEffect(() => {
    // Do not burn the saved offset on the empty frame between "loading" and
    // the committed results; wait until the rows actually exist.
    if (selectedMod || isLoading || hits.length === 0 || pendingScrollRef.current === null) return;
    const target = pendingScrollRef.current;
    let frame = 0;
    let corrections = 0;
    const apply = () => {
      const results = resultsRef.current;
      if (!results) return;
      results.scrollTop = target;
      scrollTopRef.current = results.scrollTop;
      if (results.scrollTop >= target || corrections >= 3) {
        pendingScrollRef.current = null;
        return;
      }
      // Rows can still settle after the first paint; correct the remaining
      // offset once the browser runs the next frame.
      corrections += 1;
      frame = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [selectedMod, isLoading, hits.length]);

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
          if (!res.ok) throw new Error(`Failed to fetch mods (HTTP ${res.status})`);
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
      // Both stores fail the same way for the user: show the error and a retry.
      if (!append) {
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
    if (selectedMod) return;
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
  }, [pageSize, loadMore, selectedMod]);

  // A restored offset belongs to the query it was saved with. Every new
  // search, filter or page starts at the top and must not inherit it.
  const resetListScroll = useCallback(() => {
    pendingScrollRef.current = null;
    const results = resultsRef.current;
    if (!results) return;
    results.scrollTop = 0;
    scrollTopRef.current = 0;
  }, []);

  const handleFilterChange = () => {
    resetListScroll();
    setPage(1);
  };

  const handlePageChange = (next: number) => {
    resetListScroll();
    setPage(next);
  };

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
    resetListScroll();
    setPage(1);
    setSearch(value);
  }, [resetListScroll]);

  const {
    resolveInstallPick,
    missReason,
    missMessage,
    confirmIncompatibleFallback,
    fetchDependencies,
  } = createInstallPicker({ source, t });

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
      const result = await window.electronAPI?.mods.download?.({
        folderName,
        profileName: inst.name,
        versionId: inst.minecraftVersion,
        downloadUrl: pick.file.url,
        filename: pick.file.filename,
        itemType: installItemTypeFor("mods"),
      });
      if (!result?.success) {
        addToast({
          type: "warning",
          message: formatMessage(t.dependencySkipped, {
            name: depHit.title,
            reason: mainErrorText(result, lang, lang === 'de' ? 'Installation fehlgeschlagen' : 'Installation failed'),
          }),
        });
        return;
      }
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
    } catch (error) {
      console.warn('[Mods] Failed to install dependency');
      addToast({
        type: "warning",
        message: error instanceof Error
          ? error.message
          : lang === 'de'
            ? 'Abhängigkeit konnte nicht installiert werden.'
            : 'Dependency could not be installed.',
      });
    }
  };

  const installModToInstance = async (
    mod: ModrinthHit,
    inst: Instance,
    forcedVersion?: string,
    onProgress?: (percent: number) => void,
  ): Promise<boolean> => {
    setInstallingModId(mod.project_id);
    setInstallProgress(0);
    let backgroundTaskId = "";
    let installFailure = "";
    let simulated = 4;
    const report = (percent: number) => {
      simulated = percent;
      setInstallProgress(percent);
      onProgress?.(percent);
    };
    report(4);
    const ticker = window.setInterval(() => {
      simulated = Math.min(90, simulated + Math.max(1, Math.round((90 - simulated) * 0.1)));
      report(simulated);
    }, 400);
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
          return false;
        }
        version = picked.fallback.version;
        file = picked.fallback.file;
        incompatible = true;
      } else {
        addToast({ type: "warning", message: missMessage(picked.reason, inst, mod) });
        return false;
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

      report(Math.max(simulated, 45));

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
        return false;
      }
      if (category === 'worlds') {
        payload.title = mod.title;
      }
      const result = await window.electronAPI?.mods.download?.(payload);

      report(92);

      if (result?.success) {
        // Switching versions replaces the existing entry and removes the old
        // file; the list must not end up with two versions of the same project.
        const previous = (inst.content || []).find(
          (item) => item.projectId === mod.project_id || item.id === mod.slug,
        );
        if (previous?.fileName && previous.fileName !== file.filename && category !== 'worlds') {
          try {
            await window.electronAPI?.mods.deleteContentFile?.({
              folderName,
              fileName: previous.fileName,
              type: category,
            });
          } catch {
            // A missing old file never blocks the replacement.
          }
        }
        if (setInstances) {
          setInstances(prev => prev.map(i => {
            if (i.id !== inst.id) return i;
            const sameProject = (item: NonNullable<Instance['content']>[number]) =>
              item.projectId === mod.project_id || item.id === mod.slug;
            const content = (i.content || []).filter((item) => !(item.type === category && sameProject(item)));
            const base = {
              ...i,
              installedMods: category === 'mods'
                ? [...new Set([...((i.installedMods || []).filter((slug) => slug !== previous?.id)), mod.slug])]
                : i.installedMods,
              modCount: category === 'mods' ? content.filter((item) => item.type === 'mods').length + 1 : i.modCount,
            };
            // Worlds live in saves/ and are listed from disk, not from the
            // instance's content list.
            if (category === 'worlds') return base;
            return {
              ...base,
              content: [...content, {
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
      } else if (result?.error || result?.code) {
        installFailure = mainErrorText(
          result,
          lang,
          lang === 'de' ? 'Installation fehlgeschlagen' : 'Installation failed',
        );
        addToast({ type: "error", message: installFailure });
      } else {
        installFailure = lang === 'de' ? 'Installation fehlgeschlagen' : 'Installation failed';
      }
      if (!installFailure) report(100);
    } catch (e) {
      installFailure = e instanceof Error ? e.message : "Installation fehlgeschlagen";
      addToast({ type: "error", message: installFailure });
    } finally {
      if (ticker) window.clearInterval(ticker);
      if (backgroundTaskId) {
        if (installFailure) failBackgroundTask(backgroundTaskId, installFailure);
        else completeBackgroundTask(backgroundTaskId);
      }
      setInstallingModId(null);
      setInstallProgress(0);
      onProgress?.(installFailure ? 0 : 100);
    }
    return !installFailure;
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
          contextInstance={contextInstance ?? null}
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
      <ModsHeader
        isGlobal={isGlobal}
        contextInstance={contextInstance ?? null}
        source={source}
        accent={accent}
        lang={lang}
        onBack={() => {
          if (onClearInstance) onClearInstance();
          setActiveTab("singleplayer");
        }}
        onSourceChange={handleSourceChange}
      />

      <ModSearchField
        value={search}
        onQueryChange={handleQueryChange}
        placeholder={formatMessage(t.searchModsOn, { source: source === "modrinth" ? "Modrinth" : "CurseForge" })}
      />

      <ModsFilters
        isGlobal={isGlobal}
        source={source}
        lang={lang}
        accent={accent}
        projectTypeLabel={projectTypeLabel}
        selectedProjectType={selectedProjectType}
        onProjectType={(id) => { setSelectedProjectType(id); handleFilterChange(); }}
        categoriesList={categoriesList}
        selectedCategory={selectedCategory}
        onCategory={(id) => { setSelectedCategory(id); handleFilterChange(); }}
        versionsList={versionsList}
        selectedVersion={selectedVersion}
        onVersion={(id) => { setSelectedVersion(id); handleFilterChange(); }}
        pageSize={pageSize}
        onPageSize={(size) => {
          setPageSize(size);
          // Every page size renumbers the result windows; page 3 of 20 is
          // not page 3 of 500. Start the new paging sequence at its first page.
          handleFilterChange();
        }}
      >

        <ModsResultList
          t={t}
          lang={lang}
          isGlobal={isGlobal}
          source={source}
          accent={accent}
          hits={hits}
          totalHits={totalHits}
          page={page}
          finitePageSize={finitePageSize}
          totalPages={totalPages}
          isInfinite={isInfinite}
          isLoading={isLoading}
          isLoadingMore={isLoadingMore}
          searchError={searchError}
          installingModId={installingModId}
          installProgress={installProgress}
          sortIndex={sortIndex}
          resultsRef={resultsRef}
          sentinelRef={sentinelRef}
          onScrollTop={(top) => { scrollTopRef.current = top; }}
          onSortChange={(sort) => { setSortIndex(sort); handleFilterChange(); }}
          onPageChange={handlePageChange}
          onRetry={() => fetchMods()}
          isInstalledInContext={isInstalledInContext}
          onOpenDetail={openModDetail}
          onInstall={(mod) => {
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
        />
      </ModsFilters>
        </>
      )}

      <InstancePickerDialog
        open={showInstancePicker}
        mod={pendingModForInstall}
        instances={instances}
        t={t}
        isCompatible={isModCompatibleWithInstance}
        isInstalled={isInstalledInContext}
        onClose={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
        onPick={handleCompatibleClick}
        onIncompatible={handleIncompatibleClick}
      />

      <VersionPickerDialog
        open={showVersionPicker && Boolean(versionPickerMod && versionPickerInst)}
        modTitle={versionPickerMod?.title ?? ""}
        instanceName={versionPickerInst?.name ?? ""}
        versions={modVersions}
        t={t}
        onInstall={handleVersionPickerInstall}
        onClose={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
      />

    </div>
  );
});
