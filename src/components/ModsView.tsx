import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Puzzle, Search, ArrowLeft, X, CheckCircle, Download, Users,
  ChevronLeft, ChevronRight, Filter, Check, RefreshCw, Plus, Package, AlertTriangle, Lock,
  FileCode, Globe, Clock, Tag, Layers, Star
} from "lucide-react";
import { TabType } from "./Sidebar";
import { ThemeType } from "./ParticleBackground";
import { Instance, ContentItem } from "./InstancesView";
import { LanguageType } from "../lib/translations";
import { fetchVersionMap, VersionMap } from "../lib/versionApi";
import { useToast } from "./Toast";

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

interface ModDetailProject {
  title?: string;
  author?: string;
  body?: string;
  description?: string;
  icon_url?: string;
  downloads?: number;
  slug?: string;
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
  theme: ThemeType;
  onClearInstance?: () => void;
  lang: LanguageType;
}

function renderModrinthMarkdown(text: string): string {
  let html = String(text ?? '')
    .replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, '<a href="$3" target="_blank" rel="noopener"><img src="$2" alt="$1" style="max-width:100%;border-radius:12px;margin:8px 0"></a>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:12px;margin:8px 0">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-100 font-bold">$1</strong>')
    .replace(/__([^_]+)__/g, '<strong class="text-slate-100 font-bold">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(?<!_)_{1}(?!_)([^_]+)_{1}(?!_)/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(51,65,85,0.6);padding:2px 6px;border-radius:4px;font-size:12px;color:#94a3b8">$1</code>')
    .replace(/^### (.+)$/gm, '<h3 style="color:#e2e8f0;margin:16px 0 8px;font-size:14px;font-weight:800">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#e2e8f0;margin:16px 0 8px;font-size:16px;font-weight:800">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="color:#e2e8f0;margin:16px 0 8px;font-size:20px;font-weight:800">$1</h1>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid rgba(71,85,105,0.5);margin:12px 0">')
    .replace(/^- (.+)$/gm, '<li style="margin:4px 0;color:#94a3b8">$1</li>')
    .replace(/\n\n/g, '</p><p style="margin-bottom:10px;font-size:13px;color:#94a3b8;line-height:1.7">')
    .replace(/\n/g, '<br>');
  html = '<p style="margin-bottom:10px;font-size:14px;color:#94a3b8;line-height:1.7">' + html + '</p>';
  return html;
}

function sanitizeHtml(html: string): string {
  const ALLOWED_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','li','ul','ol','hr','br','strong','em','s','code','pre','a','img','div','span','table','thead','tbody','tr','th','td','blockquote','sup','sub','u','i','b']);
  return html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tag) => {
    if (ALLOWED_TAGS.has(tag.toLowerCase())) return match;
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).replace(/&(?!(?:amp|lt|gt|quot|#039|#[0-9]+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

export const ModsView: React.FC<ModsViewProps> = ({ setActiveTab, searchQuery: initialSearch, instances = [], setInstances, fromInstanceId, theme, onClearInstance, lang }) => {
  const { addToast } = useToast();
  const isGlobal = !fromInstanceId;
  const contextInstance = fromInstanceId ? instances.find(i => i.id === fromInstanceId) : null;
  const [search, setSearch] = useState(initialSearch);
  const [source, setSource] = useState<"modrinth" | "curseforge">("modrinth");
  const [limit, setLimit] = useState(10);
  const [page, setPage] = useState(1);
  const [totalHits, setTotalHits] = useState(0);
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sortIndex, setSortIndex] = useState<"relevance" | "downloads" | "follows" | "newest" | "updated">("downloads");
  const [selectedVersion, setSelectedVersion] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedProjectType, setSelectedProjectType] = useState<string>("all");
  const [selectedMod, setSelectedMod] = useState<ModrinthHit | null>(null);
  const [installingModId, setInstallingModId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState(0);
  const [showInstancePicker, setShowInstancePicker] = useState(false);
  const [pendingModForInstall, setPendingModForInstall] = useState<ModrinthHit | null>(null);

  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [versionPickerMod, setVersionPickerMod] = useState<ModrinthHit | null>(null);
  const [versionPickerInst, setVersionPickerInst] = useState<Instance | null>(null);
  const [modVersions, setModVersions] = useState<string[]>([]);

  // Issue 11: Auto-set project type from sessionStorage when coming from instance detail tab
  useEffect(() => {
    const storedType = sessionStorage.getItem('bamboo-project-type');
    const storedSource = sessionStorage.getItem('bamboo-project-source');
    if (storedType) {
      setSelectedProjectType(storedType);
      sessionStorage.removeItem('bamboo-project-type');
      setPage(1);
    }
    if (storedSource) {
      if (storedSource === 'curseforge' || storedSource === 'modrinth') {
        setSource(storedSource);
      }
      sessionStorage.removeItem('bamboo-project-source');
    }
  }, [contextInstance?.id]);
  
  // Issue 12+13: Reset to page 1 when search/filter changes + scroll to top
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(1);
  }, [search]);

  // Auto-scroll to top of results when page or project type changes
  useEffect(() => {
    if (resultsRef.current) {
      resultsRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [page, selectedProjectType]);
  
  // Fix: Clamp limit to max 50 when switching to CurseForge (CF API max pageSize = 50)
  useEffect(() => {
    if (source === "curseforge" && limit > 50) {
      setLimit(50);
    }
  }, [source]);

  // Fix: Reset category to "all" when switching to CurseForge (categories unsupported)
  useEffect(() => {
    if (source === "curseforge") {
      setSelectedCategory("all");
    }
  }, [source]);

  // Fix: Auto-set version filter to instance MC version when browsing from instance
  useEffect(() => {
    if (!isGlobal && contextInstance?.minecraftVersion) {
      setSelectedVersion(contextInstance.minecraftVersion);
    }
  }, [contextInstance?.id]);
  
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  useEffect(() => {
    fetchVersionMap().then(vm => {
      if (vm?.minecraftVersions) {
        setMcVersions(vm.minecraftVersions.filter(v => /^\d+\.\d+(\.\d+)?$/.test(v)));
      }
    }).catch(() => {});
  }, []);

  const sortIndexToCurseForgeSort = (idx: string): number => {
    // Issue 2: Correct CurseForge API sortField values:
    // 1=Featured, 2=Popularity, 3=Last Updated, 4=Name, 5=Author, 6=Total Downloads, 7=Recently Created
    switch (idx) {
      case "downloads": return 6;  // Total Downloads
      case "relevance": return 1;  // Featured/Relevance
      case "follows": return 2;    // Popularity (best proxy for follows)
      case "newest": return 7;     // Recently Created
      case "updated": return 3;    // Last Updated
      default: return 6;
    }
  };

  const projectTypeToCfClassId = (pt: string): string | undefined => {
    // Fix: Pass slug directly so main.js CF_CLASS_IDS lookup works:
    // CF_CLASS_IDS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945, worlds: 17 }
    // If we return numbers ("6", "4471"), CF_CLASS_IDS["6"] is undefined → fallback to 6 (Mods)!
    if (pt === "all") return undefined;
    // CurseForge has no separate plugin class — map to "mod" (classId 6)
    return pt === "plugin" ? "mod" : pt;
  };

  const fetchMods = async () => {
    setIsLoading(true);
    try {
      if (source === "curseforge") {
        const result = await window.electronAPI?.curseforgeSearch?.({
          query: search,
          sortBy: String(sortIndexToCurseForgeSort(sortIndex)),
          gameVersion: selectedVersion !== "all" ? selectedVersion : undefined,
          modFilter: projectTypeToCfClassId(selectedProjectType),
          index: (page - 1) * limit,
          pageSize: limit,
        });
        if (result?.data) {
          const mapped: ModrinthHit[] = result.data.map((item: any) => ({
            project_id: String(item.id),
            slug: item.slug || String(item.id),
            author: item.authors?.[0]?.name || item.authors?.[0] || "Unknown",
            title: item.name,
            description: item.summary || "",
            categories: (item.categories || []).map((c: any) => typeof c === "string" ? c : c.slug || c.name || String(c)),
            client_side: "required",
            server_side: "optional",
            project_type: selectedProjectType === "all" ? "mod" : selectedProjectType,
            downloads: item.downloadCount || 0,
            icon_url: item.logo?.url || "",
            versions: [...new Set((item.latestFiles || []).flatMap((f: any) =>
              (f.gameVersions || []).filter((v: string) => /^\d+\.\d+(\.\d+)?$/.test(v))
            ))],
            follows: item.rating || 0,
            date_created: item.dateCreated || "",
            date_modified: item.dateModified || "",
          }));
          setHits(mapped);
          setTotalHits(result.pagination?.totalCount || mapped.length);
        } else {
          setHits([]);
          setTotalHits(0);
        }
      } else {
        const offset = (page - 1) * limit;
        let url = `https://api.modrinth.com/v2/search?query=${search}&limit=${limit}&offset=${offset}&index=${sortIndex}`;
        const facets: string[][] = [];
        if (selectedProjectType !== "all") {
          facets.push([`project_type:${selectedProjectType}`]);
        }
        if (selectedVersion !== "all") {
          facets.push([`versions:${selectedVersion}`]);
        }
        if (selectedCategory !== "all") {
          facets.push([`categories:${selectedCategory.toLowerCase()}`]);
        }
        if (facets.length > 0) {
          url += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch mods");
        const data = await res.json();
        setHits(data.hits || []);
        setTotalHits(data.total_hits || 0);
      }
    } catch (e) {
      console.error("Error fetching mods:", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      fetchMods();
    }, 400);
    return () => clearTimeout(delayDebounce);
  }, [search, source, page, limit, sortIndex, selectedVersion, selectedCategory, selectedProjectType]);

  const handleFilterChange = () => setPage(1);

  const isModCompatibleWithInstance = (mod: ModrinthHit, inst: Instance): boolean => {
    if (!mod.versions || mod.versions.length === 0) return false;
    return mod.versions.some(v => v === inst.minecraftVersion);
  };

  const fetchModVersionsFromApi = async (mod: ModrinthHit): Promise<string[]> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return mod.versions || [];
      const data = await res.json();
      const allVersions: string[] = data.flatMap((v: any) => v.game_versions || []);
      return [...new Set(allVersions)].filter((v: string) => /^\d+\.\d+(\.\d+)?$/.test(v));
    } catch {
      return mod.versions || [];
    }
  };

  const getDownloadUrlForVersion = async (mod: ModrinthHit, mcVersion: string): Promise<{ url: string; filename: string; version_number?: string } | null> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return null;
      const data = await res.json();
      // Try to find a compatible version first
      const compatible = data.find((v: any) =>
        v.game_versions?.includes(mcVersion) && v.files?.length > 0
      );
      if (compatible) return { url: compatible.files[0].url, filename: compatible.files[0].filename, version_number: compatible.version_number };
      // Fallback: return the first version with files even if not marked as compatible
      const fallback = data.find((v: any) => v.files?.length > 0);
      if (fallback) return { url: fallback.files[0].url, filename: fallback.files[0].filename, version_number: fallback.version_number };
      return null;
    } catch {
      return null;
    }
  };

  const getLatestModpackVersion = async (mod: ModrinthHit): Promise<{ url: string; mcVersion: string; loader: string; versionNumber: string } | null> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return null;
      const data = await res.json();
      const latest = data.find((v: any) =>
        v.files?.length > 0 && v.files[0].url?.endsWith('.mrpack')
      );
      if (!latest) return null;
      const mcVer = (latest.game_versions || []).find((v: string) => /^\d+\.\d+(\.\d+)?$/.test(v)) || "1.21";
      const loader = (latest.loaders || []).find((l: string) => ["fabric", "forge", "neoforge", "quilt"].includes(l)) || "fabric";
      return { url: latest.files[0].url, mcVersion: mcVer, loader, versionNumber: latest.version_number };
    } catch {
      return null;
    }
  };

  const handleInstallModpack = async (mod: ModrinthHit) => {
    setInstallingModId(mod.project_id);
    setInstallProgress(0);
    try {
      const versionInfo = await getLatestModpackVersion(mod);
      if (!versionInfo) {
        addToast({ type: "error", message: lang === "de" ? `Keine gültige Modpack-Version für ${mod.title} gefunden` : `No valid modpack version found for ${mod.title}` });
        return;
      }
      const newId = `inst_${Date.now()}`;
      const folderName = mod.slug;
      const newInst: Instance = {
        id: newId,
        name: mod.title,
        minecraftVersion: versionInfo.mcVersion,
        modloader: versionInfo.loader === "fabric" ? "Fabric" : versionInfo.loader === "forge" ? "Forge" : versionInfo.loader === "neoforge" ? "Neoforge" : "Fabric",
        modloaderVersion: "",
        lastPlayed: "Gerade eben",
        size: "Modpack wird installiert...",
        modCount: 0,
        thumbnail: mod.icon_url || "",
        desc: mod.description,
        javaVersion: "Automatisch",
        installedMods: [],
        content: [],
        // Issue 4: Use higher default RAM for modpacks (6144 MB), don't use the settings default
        ram: 6144,
        // Issue 10: Mark as modpack and store project info for update checking
        isModpack: true,
        modpackProjectId: mod.project_id,
        modpackSource: "modrinth",
        modpackVersion: versionInfo.versionNumber,
      };
      if (setInstances) {
        setInstances(prev => [newInst, ...prev]);
      }
      const result = await window.electronAPI?.installModpackMrpack?.({
        folderName,
        mcVersion: versionInfo.mcVersion,
        loader: versionInfo.loader,
        mrpackUrl: versionInfo.url,
      });
      if (result?.success && setInstances) {
        const index = result.index;
        const fileList = index?.files || [];
        // Get default RAM from settings
        let defaultRam = 6144;
        try {
          const settings = await window.electronAPI?.getSettings?.();
          if (settings?.defaultRam && typeof settings.defaultRam === 'number') {
            defaultRam = settings.defaultRam;
          }
        } catch {}
        // Build content items from the modpack index files
        const contentItems = fileList
          .filter((f: any) => f.path && f.downloads?.[0])
          .map((f: any) => {
            const path = f.path;
            let type: "mods" | "resourcepacks" | "shaderpacks" | "datapacks" | "worlds" | null = null;
            if (path.startsWith('overrides/mods/') || path.startsWith('mods/')) type = 'mods';
            else if (path.startsWith('overrides/resourcepacks/') || path.startsWith('resourcepacks/')) type = 'resourcepacks';
            else if (path.startsWith('overrides/shaderpacks/') || path.startsWith('shaderpacks/')) type = 'shaderpacks';
            else if (path.startsWith('overrides/datapacks/') || path.startsWith('datapacks/')) type = 'datapacks';
            else if (path.startsWith('overrides/saves/') || path.startsWith('overrides/worlds/') || path.startsWith('saves/') || path.startsWith('worlds/')) type = 'worlds';
            if (!type) return null; // Skip config, scripts, etc.
            const fileName = path.split('/').pop() || f.filename || path;
            return {
              id: fileName.replace(/\.(jar|zip|disabled)$/i, '') + '_' + Date.now(),
              name: fileName.replace(/\.(jar|zip|disabled|png)$/i, '').replace(/[-_]/g, ' '),
              fileName: fileName,
              version: index.name || 'Modpack',
              type,
              enabled: true,
              locked: true,
            };
          })
          .filter(Boolean) as ContentItem[];
        setInstances(prev => prev.map(i =>
          i.id === newId ? { 
            ...i, 
            modCount: contentItems.filter(c => c.type === 'mods').length,
            size: `${contentItems.length} Inhalte`,
            content: contentItems,
            ram: defaultRam,
          } : i
        ));
      }
    } catch (e: any) {
      addToast({ type: "error", message: e.message || "Modpack-Installation fehlgeschlagen" });
    } finally {
      setInstallingModId(null);
      setInstallProgress(0);
    }
  };

  const fetchDependencies = async (mod: ModrinthHit, mcVersion: string): Promise<{ projectId: string; slug: string }[]> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
      if (!res.ok) return [];
      const data = await res.json();
      const match = data.find((v: any) =>
        v.game_versions?.includes(mcVersion) && v.files?.length > 0
      );
      if (!match?.dependencies) return [];
      const deps: { projectId: string; slug: string }[] = [];
      for (const dep of match.dependencies) {
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

  const installDependency = async (dep: { slug: string }, inst: Instance, mcVersion: string) => {
    try {
      const depRes = await fetch(`https://api.modrinth.com/v2/search?query=${dep.slug}&limit=1&facets=${encodeURIComponent(JSON.stringify([['project_type:mod']]))}`);
      if (!depRes.ok) return;
      const depData = await depRes.json();
      const depHit = depData.hits?.[0] as ModrinthHit | undefined;
      if (!depHit) return;
      const depDownload = await getDownloadUrlForVersion(depHit, mcVersion);
      if (!depDownload) return;
      const folderName = inst.name.toLowerCase().replace(/\s+/g, "-");
      await window.electronAPI?.downloadMod?.({
        folderName,
        profileName: inst.name,
        versionId: mcVersion,
        downloadUrl: depDownload.url,
        filename: depDownload.filename,
        itemType: "mods",
      });
      if (setInstances) {
        setInstances(prev => prev.map(i =>
          i.id === inst.id ? {
            ...i,
            installedMods: [...(i.installedMods || []), depHit.slug],
            modCount: (i.modCount || 0) + 1,              content: [...(i.content || []), {
                    id: depHit.slug, name: depHit.title, fileName: depDownload.filename,
                    version: mcVersion, type: "mods", enabled: true, locked: false,
                    iconUrl: depHit.icon_url,
                    // Issue 6: Track version number and source for update checking
                    versionNumber: mcVersion,
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
    try {
      const targetVersion = forcedVersion || inst.minecraftVersion;
      const downloadInfo = await getDownloadUrlForVersion(mod, targetVersion);
      if (!downloadInfo) {
        addToast({ type: "warning", message: lang === "de" ? `Keine Version für ${targetVersion} verfügbar` : `No version available for ${targetVersion}` });
        return;
      }
      // Check if the version is actually compatible with the instance's MC version
      if (!forcedVersion && downloadInfo.version_number) {
        try {
          const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
          if (res.ok) {
            const data = await res.json();
            const verMatch = data.find((v: any) => v.version_number === downloadInfo.version_number);
            if (verMatch && !verMatch.game_versions?.includes(inst.minecraftVersion)) {
              addToast({ type: "warning", message: lang === "de" ? `${downloadInfo.version_number} ist nicht als kompatibel mit ${inst.minecraftVersion} markiert. Installation auf eigene Gefahr.` : `${downloadInfo.version_number} is not marked as compatible with ${inst.minecraftVersion}. Install at your own risk.` });
            }
          }
        } catch { /* ignore */ }
      }

      // Issue 18: Determine correct content type based on project type
      const contentType = mod.project_type === 'resourcepack' ? 'resourcepacks'
        : mod.project_type === 'shader' ? 'shaderpacks'
        : mod.project_type === 'datapack' ? 'datapacks'
        : mod.project_type === 'plugin' ? 'mods'
        : 'mods';

      // Issue 5: Update progress during download
      setInstallProgress(30);

      // Resolve dependencies (only for mods)
      if (contentType === 'mods') {
        const deps = await fetchDependencies(mod, targetVersion);
        for (const dep of deps) {
          const alreadyInstalled = (inst.installedMods || []).includes(dep.slug) ||
            (inst.content || []).some(c => c.id === dep.slug);
          if (!alreadyInstalled) {
            await installDependency(dep, inst, targetVersion);
          }
        }
      }

      setInstallProgress(60);

      const folderName = inst.name.toLowerCase().replace(/\s+/g, "-");
      const result = await window.electronAPI?.downloadMod?.({
        folderName,
        profileName: inst.name,
        versionId: targetVersion,
        downloadUrl: downloadInfo.url,
        filename: downloadInfo.filename,
        itemType: contentType === 'shaderpacks' ? 'shader' : contentType === 'resourcepacks' ? 'resourcepack' : 'mods',
      });
      
      setInstallProgress(90);
      
      if (result?.success) {
        if (setInstances) {
          setInstances(prev => prev.map(i =>
            i.id === inst.id
              ? {
                  ...i,
                  installedMods: contentType === 'mods' ? [...(i.installedMods || []), mod.slug] : i.installedMods,
                  modCount: contentType === 'mods' ? (i.modCount || 0) + 1 : i.modCount,
                  content: [...(i.content || []), {
                    id: mod.slug,
                    name: mod.title,
                    fileName: downloadInfo.filename,
                    version: targetVersion,
                    type: contentType,
                    enabled: true,
                    locked: false,
                    iconUrl: mod.icon_url,
                    // Issue 6: Track version number and source for update checking
                    versionNumber: downloadInfo.version_number || targetVersion,
                    projectId: mod.project_id,
                    source: "modrinth",
                  }]
                }
              : i
          ));
        }
      }
      setInstallProgress(100);
    } catch (e: any) {
      addToast({ type: "error", message: e.message || "Installation fehlgeschlagen" });
    } finally {
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
      `${inst.name} unterstützt ${mod.title} nicht standardmäßig (${inst.minecraftVersion}).\nMöchtest du manuell eine Version auswählen?`
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

  const totalPages = Math.ceil(totalHits / limit) || 1;

  const categoriesList = [
    { id: "all", label: "All Categories" },
    { id: "optimization", label: "Performance" },
    { id: "utility", label: "Utility" },
    { id: "adventure", label: "Adventure" },
    { id: "technology", label: "Technology" },
    { id: "magic", label: "Magic" },
    { id: "decoration", label: "Decoration" },
    { id: "worldgen", label: "World Gen" }
  ];

  const versionsList = [
    { id: "all", label: "All Versions" },
    ...mcVersions.map(v => ({ id: v, label: v }))
  ];

  // Theme accents – automatisch via CSS-Variablen
  const accent = {
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
          setInstances={setInstances}
          installModToInstance={installModToInstance}
          handleInstallModpack={handleInstallModpack}                    handleOpenInstancePicker={handleOpenInstancePicker}
                    fullWindow
                    lang={lang}
        />
      ) : (
        <>
      {/* 1. Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-5 shadow-2xl shrink-0">
        <div className="flex items-center gap-4">
          {!isGlobal && (
            <button
              // Issue 13: Back button goes to instance detail view, not just instances list
              onClick={() => {
                // Issue 14: Signal to parent to restore instance detail view
                sessionStorage.setItem('bamboo-restore-detail', 'true');
                if (onClearInstance) onClearInstance();
                setActiveTab("singleplayer");
              }}
              className="p-2 bg-slate-900/60 hover:bg-slate-800/60 border border-slate-800/80 hover:border-[color:var(--theme-accent)]/30 text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
          )}
          <div className="flex items-center gap-3">
            {!isGlobal && contextInstance && (
              <div className="w-10 h-10 rounded-xl overflow-hidden border border-slate-700 shrink-0 bg-slate-900">
                {contextInstance.thumbnail ? (
                  <img src={contextInstance.thumbnail} alt={contextInstance.name} className="w-full h-full object-cover" />
                ) : (
                  <Package className="w-5 h-5 text-slate-500 m-2.5" />
                )}
              </div>
            )}
            <div>
              <h2 className="text-xl font-black text-white tracking-wide flex items-center gap-2">
                {!isGlobal && contextInstance ? contextInstance.name : "Mod Browser"}
              </h2>
              {!isGlobal && contextInstance && (
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {contextInstance.minecraftVersion} · {contextInstance.modloader}{contextInstance.modloaderVersion ? ` ${contextInstance.modloaderVersion}` : ""}
                </p>
              )}
              <p className="text-[11px] text-slate-400 mt-0.5">
                {!isGlobal && contextInstance
                  ? `Durchsuche und installiere Mods für ${contextInstance.name}`
                  : "Browse, query, and install thousands of modifications directly from CurseForge and Modrinth APIs."}
              </p>
            </div>
          </div>
        </div>

        <div className="flex bg-slate-900/40 border border-slate-800 p-1 rounded-xl shrink-0">
          <button
            onClick={() => { setSource("modrinth"); handleFilterChange(); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-black tracking-wide flex items-center gap-1.5 transition-all cursor-pointer ${
              source === "modrinth"
                ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Modrinth
          </button>
          <button
            onClick={() => { setSource("curseforge"); handleFilterChange(); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-black tracking-wide flex items-center gap-1.5 transition-all cursor-pointer ${
              source === "curseforge"
                ? `${accent.bgLight} ${accent.text} ${accent.border} shadow-inner`
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            CurseForge
          </button>
        </div>
      </div>

      {/* I12: Search - typing automatically resets to page 1 */}
      <div className="relative shrink-0">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          placeholder={`Search mods on ${source === "modrinth" ? "Modrinth" : "CurseForge"}...`}
          className="w-full bg-slate-950/40 border border-slate-800/80 rounded-2xl py-3 pl-11 pr-4 text-xs text-slate-200 placeholder-slate-400 outline-none transition-all focus:border-[color:var(--theme-accent)]/50"
        />
      </div>

      {/* 2b. Project Type Filter */}
      <div className="flex shrink-0 gap-1.5 flex-wrap items-center">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mr-1">Project Type:</span>
        {[
          // Issue 3: Add Plugins for Modrinth, only show Worlds for CF
          { id: "all", label: "All" },
          { id: "mod", label: "Mods" },
          { id: "modpack", label: "Modpacks" },
          { id: "resourcepack", label: "Resource Packs" },
          { id: "shader", label: "Shaders" },
          { id: "datapack", label: "Data Packs" },
          { id: "plugin", label: "Plugins" },
          ...(source === 'curseforge' ? [{ id: "worlds", label: "Worlds" }] : []),
        ].map((pt) => {
          const isSelected = selectedProjectType === pt.id;
          return (
            <button
              key={pt.id}
              onClick={() => { setSelectedProjectType(pt.id); handleFilterChange(); }}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer border ${
                isSelected
                  ? `${accent.bgLight} ${accent.text} ${accent.border}`
                  : "bg-slate-900/20 border-slate-850 text-slate-400 hover:text-slate-200 hover:border-slate-700"
              }`}
            >
              {pt.label}
            </button>
          );
        })}
      </div>

      {/* 3. Main Layout */}
      <div className="flex flex-col xl:flex-row gap-4 items-stretch flex-1 min-h-0">          {/* LEFT COLUMN: Filters */}
        <div className="w-full xl:w-64 shrink-0 flex flex-col gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-2xl p-4 shadow-2xl h-fit max-h-[calc(100vh-16rem)] overflow-y-auto custom-scrollbar">
          <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-900 pb-2.5">
            <Filter className="w-3.5 h-3.5 theme-accent-text" style={{ color: 'var(--theme-accent)' }} />
            {source === "modrinth" ? "Filter Mod Database" : "CurseForge Search"}
          </div>

          {/* Fix: Categories filter only works with Modrinth facets */}
          {source === "modrinth" && (
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 text-left block">Categories</label>
            <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
              {categoriesList.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => { setSelectedCategory(cat.id); handleFilterChange(); }}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-left transition-all cursor-pointer ${
                      isSelected
                        ? "theme-accent-bg-light theme-accent-text theme-accent-border-light"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/40"
                    }`}
                  >
                    <span>{cat.label}</span>
                    {isSelected && <Check className="w-3 h-3 theme-accent-text" style={{ color: 'var(--theme-accent)' }} />}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Fix: Hide version filter when browsing from instance — auto-locked to instance MC version */}
          {isGlobal && (
          <div className="flex flex-col gap-1.5 mt-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider text-left block">Minecraft Version</label>
            <select
              value={selectedVersion}
              onChange={(e) => { setSelectedVersion(e.target.value); handleFilterChange(); }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-300 outline-none focus:border-[color:var(--theme-accent)]/50"
            >
              {versionsList.map((ver) => (
                <option key={ver.id} value={ver.id}>{ver.label}</option>
              ))}
            </select>
          </div>
          )}

          <div className="flex flex-col gap-1.5 mt-1">
            <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider text-left block">Items Per Page</label>
            <select
              value={limit}
              onChange={(e) => { setLimit(parseInt(e.target.value)); handleFilterChange(); }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-300 outline-none focus:border-[color:var(--theme-accent)]/50"
            >
              <option value={10}>10 per page</option>
              <option value={20}>20 per page</option>
              <option value={50}>50 per page</option>
              {/* Fix: CF API max pageSize is 50 — hide 100/500 for CurseForge */}
              {source === "modrinth" && <option value={100}>100 per page</option>}
              {source === "modrinth" && <option value={500}>500 per page</option>}
            </select>
          </div>
        </div>

        {/* RIGHT COLUMN: Results */}
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          
          <div className="flex flex-row items-center justify-between gap-4 bg-slate-900/20 border border-slate-850 p-2 rounded-xl shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 font-bold">Sort by:</span>
              <select
                value={sortIndex}
                onChange={(e) => { setSortIndex(e.target.value as any); handleFilterChange(); }}
                className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-200 outline-none focus:border-[color:var(--theme-accent)]/50"
              >
                <option value="downloads">Most Downloads</option>
                <option value="relevance">Relevance</option>
                <option value="follows">Most Followed</option>
                <option value="newest">Newest Released</option>
                <option value="updated">Recently Updated</option>
              </select>
            </div>

            {hits.length > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-[10px] text-slate-500 font-bold hidden sm:inline">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={page === 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="p-1 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    disabled={page === totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    className="p-1 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Results */}
          <div ref={resultsRef} className="relative flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/10 backdrop-blur-sm rounded-2xl z-40">
                <div className="flex flex-col items-center gap-2">
                  <RefreshCw className="w-8 h-8 theme-accent-text animate-spin" style={{ color: 'var(--theme-accent)' }} />
                  <span className="text-[10px] font-bold text-slate-400">Querying store database...</span>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {hits.map((mod, index) => {
                const _installed = isInstalledInContext(mod.slug);
                const isInstalling = installingModId === mod.project_id;
                const showInstallBtn = isGlobal || !_installed;

                return (
                  <motion.div
                    key={mod.project_id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.015 }}
                    onClick={() => setSelectedMod(mod)}
                    className={`bg-slate-950/45 backdrop-blur-xl border rounded-2xl px-5 py-2.5 flex items-center gap-4 group cursor-pointer transition-all duration-300 hover:shadow-xl text-left relative overflow-hidden min-h-[96px] shrink-0 ${accent.bgLight} ${accent.border}`}
                  >
                    <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-850 flex items-center justify-center shrink-0 overflow-hidden relative shadow-md">
                      {mod.icon_url ? (
                        <img src={mod.icon_url} alt={mod.title} className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-500" />
                      ) : (
                        <Puzzle className="w-6 h-6 text-slate-500" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col justify-center h-full">
                      <div className="flex items-center gap-2">
                        <h3 className={`text-sm font-black text-slate-100 ${accent.hoverText} transition-colors tracking-wide truncate`}>
                          {mod.title}
                        </h3>
                        <span className="text-[10px] text-slate-500 font-bold truncate">
                          by {mod.author}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5 leading-relaxed font-medium">
                        {mod.description}
                      </p>
                      <div className="flex items-center gap-3 text-[9px] text-slate-500 font-bold mt-1">
                        <span className="flex items-center gap-0.5 shrink-0">
                          <Download className="w-3 h-3 text-slate-600" />
                          {mod.downloads.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-0.5 shrink-0">
                          <Users className="w-3 h-3 text-slate-600" />
                          {mod.follows.toLocaleString()}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0 pl-2" onClick={(e) => e.stopPropagation()}>
                      {showInstallBtn ? (
                        <button
                          type="button"
                          disabled={isInstalling}
                          onClick={() => {
                            if (mod.project_type === "modpack") {
                              handleInstallModpack(mod);
                            } else if (isGlobal) {
                              handleOpenInstancePicker(mod);
                            } else {
                              handleInstallToContextInstance(mod);
                            }
                          }}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all flex items-center gap-1 cursor-pointer ${
                            isInstalling
                              ? "theme-accent-bg-light theme-accent-text border-[color:var(--theme-accent)]/20"
                              : `${accent.bg} text-slate-950 shadow-lg ${accent.glow}`
                          }`}
                        >
                          {isInstalling ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              {installProgress}%
                            </>
                          ) : (
                            <>
                              <Plus className="w-3 h-3 stroke-[3]" />
                              Installieren
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-black theme-accent-text bg-[color:var(--theme-accent)]/10 border border-[color:var(--theme-accent)]/20">
                          <Check className="w-3 h-3 stroke-[3]" />
                          Installiert
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {hits.length === 0 && !isLoading && (
                <div className="py-24 text-center flex flex-col items-center justify-center gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400">
                    <Puzzle className="w-8 h-8" />
                  </div>
                  <p className="text-sm font-bold text-slate-300">No modifications found.</p>
                  <p className="text-xs text-slate-500">Try adjusting your query or categories filter.</p>
                </div>
              )}
            </div>
          </div>

          {hits.length > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-900/20 border border-slate-850 p-2 rounded-xl shrink-0 mt-2">
              <span className="text-[10px] text-slate-400 font-bold">
                Showing <strong className="text-slate-200">{(page - 1) * limit + 1}</strong> - <strong className="text-slate-200">{Math.min(page * limit, totalHits)}</strong> of <strong className="text-slate-200">{totalHits.toLocaleString()}</strong> mods
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={page === 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="p-1.5 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] font-black text-slate-200 px-3 py-1.5 bg-slate-950/60 border border-slate-850 rounded-lg">
                  Page {page} / {totalPages}
                </span>
                <button
                  disabled={page === totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  className="p-1.5 bg-slate-950 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}

      {/* INSTANCE PICKER MODAL */}
      <AnimatePresence>
        {showInstancePicker && pendingModForInstall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Plus className="w-5 h-5 theme-accent-text" style={{ color: 'var(--theme-accent)' }} />
                  <h3 className="text-lg font-black text-white tracking-wide">Mod installieren</h3>
                </div>
                <button
                  onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-3 max-h-[60vh] overflow-y-auto custom-scrollbar">
                <p className="text-xs text-slate-400 mb-2">
                  Wähle eine Instanz zur Installation von <strong className="text-slate-200">{pendingModForInstall.title}</strong>:
                </p>

                {instances.length === 0 ? (
                  <div className="py-8 text-center flex flex-col items-center gap-2">
                    <Package className="w-10 h-10 text-slate-600" />
                    <p className="text-sm text-slate-400">Keine Instanzen vorhanden</p>
                    <p className="text-xs text-slate-500">Erstelle zuerst eine Instanz im Instanzen-Tab.</p>
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
                        className={`p-4 rounded-2xl border flex items-center justify-between gap-4 transition-all cursor-pointer ${
                          alreadyInstalled
                            ? "theme-accent-bg-light border-[color:var(--theme-accent)]/20 opacity-60 cursor-default"
                            : isCompatible
                            ? "bg-slate-900/20 border-slate-850 hover:border-[color:var(--theme-accent)]/30 hover:bg-slate-900/40"
                            : "bg-slate-900/10 border-slate-850/50 opacity-50 hover:opacity-80 hover:border-amber-500/30"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shrink-0">
                            {inst.thumbnail ? (
                              <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover" />
                            ) : (
                              <Package className="w-5 h-5 text-slate-500 m-2.5" />
                            )}
                          </div>
                          <div className="text-left min-w-0">
                            <span className="text-sm font-bold text-slate-200 truncate block">{inst.name}</span>
                            <span className="text-[10px] text-slate-500">{inst.minecraftVersion} · {inst.modloader}</span>
                          </div>
                        </div>

                        <div className="shrink-0">
                          {alreadyInstalled ? (
                            <span className="flex items-center gap-1 text-[10px] font-bold theme-accent-text border border-[color:var(--theme-accent)]/20 px-3 py-1.5 rounded-lg theme-accent-bg-light">
                              <Check className="w-3 h-3" /> Installiert
                            </span>
                          ) : isCompatible ? (
                            <span className="bg-[var(--theme-accent)] hover:opacity-80 text-slate-950 px-4 py-1.5 rounded-lg text-[10px] font-black tracking-wide transition-all block" style={{ backgroundColor: 'var(--theme-accent)' }}>
                              Installieren
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg">
                              <AlertTriangle className="w-3 h-3" /> Inkompatibel
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="p-4 bg-slate-900/40 border-t border-slate-900 flex justify-end">
                <button
                  onClick={() => { setShowInstancePicker(false); setPendingModForInstall(null); }}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  Abbrechen
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* VERSION PICKER MODAL */}
      <AnimatePresence>
        {showVersionPicker && versionPickerMod && versionPickerInst && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                  <h3 className="text-lg font-black text-white tracking-wide">Version wählen</h3>
                </div>
                <button
                  onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-4">
                <p className="text-xs text-slate-400">
                  Wähle eine Minecraft-Version für <strong className="text-slate-200">{versionPickerMod.title}</strong> in <strong className="text-slate-200">{versionPickerInst.name}</strong>:
                </p>
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                  {modVersions.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center">Keine Versionen verfügbar</p>
                  ) : (
                    modVersions.map(ver => (
                      <button
                        key={ver}
                        onClick={() => handleVersionPickerInstall(ver)}
                        className="bg-slate-900/20 hover:bg-slate-900/40 border border-slate-850 hover:border-[color:var(--theme-accent)]/30 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-200 transition-all text-left"
                      >
                        {ver}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="p-4 bg-slate-900/40 border-t border-slate-900 flex justify-end">
                <button
                  onClick={() => { setShowVersionPicker(false); setVersionPickerMod(null); setVersionPickerInst(null); }}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  Abbrechen
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};

// ===== MOD DETAIL WINDOW COMPONENT (Large View with Description + Versions Tabs) =====
interface ModDetailWindowProps {
  mod: ModrinthHit;
  source: "modrinth" | "curseforge";
  contextInstance: Instance | null;
  isGlobal: boolean;
  accent: any;
  onClose: () => void;
  instances: Instance[];
  setInstances?: React.Dispatch<React.SetStateAction<Instance[]>>;
  installModToInstance: (mod: ModrinthHit, inst: Instance, forcedVersion?: string) => Promise<void>;
  handleInstallModpack: (mod: ModrinthHit) => Promise<void>;
  handleOpenInstancePicker: (mod: ModrinthHit) => void;
  fullWindow?: boolean;
  lang: LanguageType;
}

const ModDetailWindow: React.FC<ModDetailWindowProps> = ({
  mod, source, contextInstance, isGlobal, accent, onClose,
  instances, setInstances, installModToInstance, handleInstallModpack, handleOpenInstancePicker, fullWindow, lang
}) => {
  const [tab, setTab] = useState<"description" | "versions">("description");
  const [project, setProject] = useState<ModDetail | null>(null);
  const [versions, setVersions] = useState<ModDetailVersion[]>([]);
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
      try {
        if (isCurseforge && window.electronAPI?.curseforgeProject) {
          const projectData: any = await window.electronAPI.curseforgeProject(mod.project_id);
          if (projectData && typeof projectData === 'object' && !projectData.error) {
            setProject({
              title: projectData.name,
              author: projectData.authors?.[0]?.name || "Unknown",
              body: projectData.description || "",
              description: projectData.summary || "",
              icon_url: projectData.logo?.url || mod.icon_url,
              downloads: projectData.downloadCount,
              slug: projectData.slug || mod.slug,
            });
          }
          const filesResult = await window.electronAPI?.curseforgeFiles?.(mod.project_id);
          if (Array.isArray(filesResult)) {
            setVersions(filesResult.map((f: any) => ({
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
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}`, { headers: { 'User-Agent': 'BambooLauncher/0.1.0' } }),
            fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, { headers: { 'User-Agent': 'BambooLauncher/0.1.0' } }),
          ]);
          if (projectRes.ok) {
            const p = await projectRes.json();
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
            const v = await versionsRes.json();
            setVersions(v.map((ver: any) => ({
              version_number: ver.version_number,
              date_published: ver.date_published,
              game_versions: ver.game_versions || [],
              loaders: ver.loaders || [],
              files: ver.files?.map((f: any) => ({
                url: f.url,
                filename: f.filename,
                primary: f.primary || false,
              })) || [],
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
  }, [mod.project_id]);

    const desc = project?.body || project?.description || mod.description || (lang === "de" ? "Keine Beschreibung verfügbar." : "No description available.");
  const allLoaders = [...new Set(versions.flatMap(v => v.loaders))].sort();
  const allMcVersions = [...new Set(versions.flatMap(v => v.game_versions))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  let filteredVersions = versions;
  if (loaderFilter) filteredVersions = filteredVersions.filter(v => v.loaders.includes(loaderFilter));
  if (versionFilter) filteredVersions = filteredVersions.filter(v => v.game_versions.includes(versionFilter));

  const profileLoader = contextInstance?.modloader?.toLowerCase() || "";
  const profileMc = contextInstance?.minecraftVersion || "";

  const handleInstallVersion = (ver: ModDetailVersion) => {
    const mcOk = !profileMc || ver.game_versions.includes(profileMc);
    const loaderOk = !profileLoader || profileLoader === "vanilla" || ver.loaders.includes(profileLoader);
    const incompatible = !mcOk || !loaderOk;

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
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-800/60 flex items-start justify-between gap-4 shrink-0">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden shrink-0 shadow-lg">
            <img
              src={project?.icon_url || mod.icon_url}
              alt={project?.title || mod.title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            {(!project?.icon_url && !mod.icon_url) && (
              <div className="w-full h-full flex items-center justify-center">
                <Package className="w-7 h-7 text-slate-500" />
              </div>
            )}
          </div>
          <div className="text-left min-w-0 flex-1">
            <h2 className="text-xl font-black text-white tracking-wide truncate">
              {project?.title || mod.title}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">von {project?.author || mod.author}</p>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500">
              <span className="flex items-center gap-1">
                <Download className="w-3.5 h-3.5" />
                {(project?.downloads ?? mod.downloads).toLocaleString()}
              </span>
              <span className="flex items-center gap-1">
                <Star className="w-3.5 h-3.5" />
                {mod.follows.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all cursor-pointer shrink-0"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800/60 shrink-0 px-6">
        <button
          onClick={() => setTab("description")}
          className={`px-5 py-3 text-xs font-bold tracking-wide transition-all border-b-2 cursor-pointer ${
            tab === "description"
                ? `${accent.text} ${accent.border}`
                : "text-slate-400 border-transparent hover:text-slate-200"
          }`}
        >
          Beschreibung
        </button>
        <button
          onClick={() => setTab("versions")}
          className={`px-5 py-3 text-xs font-bold tracking-wide transition-all border-b-2 cursor-pointer ${
            tab === "versions"
              ? `${accent.text} ${accent.border}`
              : "text-slate-400 border-transparent hover:text-slate-200"
          }`}
        >
          Versionen ({versions.length})
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {tab === "description" ? (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-slate-400 animate-spin" />
              </div>
            ) : (
              <div
                className="mod-description"
                dangerouslySetInnerHTML={{
                  __html: isCurseforge
                    ? sanitizeHtml(desc)
                    : renderModrinthMarkdown(desc)
                }}
              />
            )}
          </div>
        ) : (
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 text-slate-400 animate-spin" />
              </div>
            ) : versions.length === 0 ? (
              <p className="text-sm text-slate-400 py-12 text-center">Keine Versionen gefunden.</p>
            ) : (
              <>
                {/* Version Filters */}
                <div className="flex gap-3 mb-4 flex-wrap">
                  <select
                    value={loaderFilter}
                    onChange={(e) => setLoaderFilter(e.target.value)}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-300 outline-none"
                  >
                    <option value="">Alle Loader</option>
                    {allLoaders.map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                  <select
                    value={versionFilter}
                    onChange={(e) => setVersionFilter(e.target.value)}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-300 outline-none"
                  >
                    <option value="">Alle MC-Versionen</option>
                    {allMcVersions.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <span className="text-[11px] text-slate-500 self-center font-medium">
                    {filteredVersions.length} Versionen
                  </span>
                </div>

                {/* I20: Sort - compatible versions first */}
                <div className="flex flex-col gap-2">
                  {[...filteredVersions].sort((a, b) => {
                    const aCompatible = !profileMc || a.game_versions.includes(profileMc);
                    const bCompatible = !profileMc || b.game_versions.includes(profileMc);
                    if (aCompatible && !bCompatible) return -1;
                    if (!aCompatible && bCompatible) return 1;
                    return new Date(b.date_published).getTime() - new Date(a.date_published).getTime();
                  }).map(ver => {
                    const mcOk = !profileMc || ver.game_versions.includes(profileMc);
                    const loaderOk = !profileLoader || profileLoader === "vanilla" || ver.loaders.includes(profileLoader);
                    const incompatible = !mcOk || !loaderOk;

                    return (
                      <div
                        key={ver.version_number}
                        className={`bg-slate-900/30 border rounded-xl p-4 flex items-center justify-between gap-4 transition-all ${
                          incompatible
                            ? "border-slate-800/30 opacity-50"
                            : `border-slate-800/60 ${accent.cardHover || 'hover:border-slate-700'}`
                        }`}
                      >
                        <div className="flex-1 min-w-0 text-left">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-slate-100">
                              {ver.version_number}
                            </span>
                            {incompatible && (
                              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-label="Inkompatibel mit aktueller Instanz" />
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                            <span>{new Date(ver.date_published).toLocaleDateString()}</span>
                            <span>·</span>
                            <span>{ver.loaders.join(', ') || 'Alle'}</span>
                            <span>·</span>
                            <span>{ver.game_versions.slice(0, 3).join(', ')}{ver.game_versions.length > 3 ? ' ...' : ''}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleInstall(ver)}
                          className={`shrink-0 px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all cursor-pointer shadow-lg ${
                            incompatible
                              ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20"
                              : `${accent.bg} text-slate-950 ${accent.glow}`
                          }`}
                        >
                          {incompatible ? "⚠️ Installieren" : "Installieren"}
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

      {/* Bottom bar - only Close button (no Install button) */}
      <div className="p-4 bg-slate-900/40 border-t border-slate-800/60 flex justify-between items-center shrink-0">
        <span className="text-[10px] text-slate-500 font-bold">
          Source: {source === "modrinth" ? "Modrinth API v2" : "CurseForge API"}
        </span>
        <button
          onClick={onClose}
          className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
        >
          Close
        </button>
      </div>
    </>
  );

  return (
    <>
      {fullWindow ? (
        <div className="flex flex-col h-full w-full overflow-hidden bg-slate-950/95 border border-slate-800/60 rounded-3xl shadow-2xl">
          {detailContent}
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-slate-950/90 backdrop-blur-lg flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            className="bg-slate-950 border border-slate-800/80 rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {detailContent}
          </motion.div>
        </motion.div>
      )}

      {/* Instance Picker inside modal */}
      <AnimatePresence>
        {showInstallPicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-base font-black text-white mb-4">Installieren in:</h3>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                {instances.map(inst => (
                  <button
                    key={inst.id}
                    onClick={() => handleInstallFromPicker(inst)}
                    className="bg-slate-900/30 hover:bg-slate-800/50 border border-slate-800/60 rounded-xl px-4 py-3 text-left text-xs font-bold text-slate-200 transition-all"
                  >
                    {inst.name} · {inst.minecraftVersion}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setShowInstallPicker(false); setInstallVer(null); }}
                className="mt-4 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-bold transition-all"
              >
                Abbrechen
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Incompatible Version Warning */}
      <AnimatePresence>
        {showIncompWarning && incompVer && incompInst && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-[60]"
            onClick={() => { setShowIncompWarning(false); }}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-slate-950 border border-amber-500/30 rounded-3xl max-w-md w-full p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white">Inkompatible Version!</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {incompVer.version_number} ist nicht kompatibel mit {incompInst.name} ({incompInst.minecraftVersion} · {incompInst.modloader})
                  </p>
                </div>
              </div>
              <p className="text-xs text-slate-500 mb-5">
                Die Installation kann zu Fehlern im Spiel führen. Trotzdem fortfahren?
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setShowIncompWarning(false); }}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  Abbrechen
                </button>
                <button
                  onClick={handleIncompConfirm}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 px-5 py-2.5 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer shadow-lg shadow-amber-500/10"
                >
                  Trotzdem installieren
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};