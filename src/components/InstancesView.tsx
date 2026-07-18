import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Play, 
  Trash2, 
  Plus, 
  Search, 
  Calendar, 
  HardDrive, 
  X,
  Cpu,
  Layers,
  Settings,
  RefreshCw,
  Info,
  Check,
  ArrowLeft,
  Package,
  Image,
  Sliders,
  Wrench,
  Zap,
  Shirt,
  Globe,
  FolderOpen,
  Download,
  Upload,
  ImageIcon,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  AlertTriangle,
  ArrowUp
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { fetchVersionMap, VersionMap } from "../lib/versionApi";
import { useToast } from "./Toast";
import { ProfileExportModal } from "./ProfileExportModal";
import { ProfileImportModal } from "./ProfileImportModal";

export interface ContentItem {
  id: string;
  name: string;
  fileName: string;
  version: string;
  type: "mods" | "resourcepacks" | "shaderpacks" | "worlds" | "datapacks";
  enabled: boolean;
  locked: boolean;
  updateAvailable?: boolean;
  iconUrl?: string;
  // Issue 6: Track actual mod version number and source for live update checking
  versionNumber?: string;
  projectId?: string;
  source?: "modrinth" | "curseforge";
}

export interface Instance {
  id: string;
  name: string;
  minecraftVersion: string;
  modloader: "Vanilla" | "Fabric" | "Neoforge" | "Forge";
  modloaderVersion?: string;
  lastPlayed: string;
  size: string;
  modCount: number;
  thumbnail: string;
  desc: string;
  javaVersion?: string;
  installedMods: string[];
  content?: ContentItem[];
  ram?: number;
  // Issue 10: Modpack-specific fields
  isModpack?: boolean;
  ownContentManagement?: boolean;
  modpackProjectId?: string;
  modpackSource?: "modrinth" | "curseforge";
  modpackVersion?: string;
}

interface RunningInstance {
  name: string;
  startedAt: number;
}

interface InstancesViewProps {
  setActiveTab: (tab: TabType) => void;
  searchQuery: string;
  activeInstance: string;
  setActiveInstance: (name: string) => void;
  lang: LanguageType;
  instances: Instance[];
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  openModBrowserForInstance: (instanceId: string) => void;
  onLaunch?: (instanceId: string) => void;
  runningInstances: RunningInstance[];
  onStopGame: (name: string) => void;
  // Issue 13: Auto-select an instance when navigating back from mod browser
  selectedInstanceOverride?: string | null;
}

export const InstancesView: React.FC<InstancesViewProps> = ({ 
  setActiveTab, 
  searchQuery: initialSearch,
  activeInstance,
  setActiveInstance,
  lang,
  instances,
  setInstances,
  openModBrowserForInstance,
  onLaunch,
  runningInstances,
  onStopGame,
  selectedInstanceOverride
}) => {
  const t = translations[lang];
  const [search, setSearch] = useState(initialSearch);
  const [filterMode, setFilterMode] = useState<string>("all");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null);
  const [detailTab, setDetailTab] = useState<"mods" | "resourcepacks" | "shader" | "worlds" | "datapacks" | "settings">("mods");
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Issue 13: Auto-select instance when navigating back from mod browser
  useEffect(() => {
    if (selectedInstanceOverride && !selectedInstance) {
      const found = instances.find(i => i.id === selectedInstanceOverride);
      if (found) {
        setSelectedInstance(found);
      }
    }
  }, [selectedInstanceOverride]);

  useEffect(() => {
    setDetailTab("mods");
  }, [selectedInstance]);
  const [ramAllocation, setRamAllocation] = useState(4096);
  const [ramSliderValue, setRamSliderValue] = useState(4096);
  
  // Java scanning
  const [isScanningJava, setIsScanningJava] = useState(false);
  const [scannedJavaVersions, setScannedJavaVersions] = useState<string[]>([]);
  const [selectedJavaVersion, setSelectedJavaVersion] = useState("Automatisch");

  // Instance Creator Form
  const [newInstanceName, setNewInstanceName] = useState("");
  const [newInstanceVersion, setNewInstanceVersion] = useState("");
  const [newInstanceModloader, setNewInstanceModloader] = useState<Instance["modloader"]>("Fabric");
const [newInstanceModloaderVersion, setNewInstanceModloaderVersion] = useState("");
  const [newInstanceImage, setNewInstanceImage] = useState("");

  const handleSelectImageForNewInstance = async () => {
    const result = await window.electronAPI?.showOpenDialog?.({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (result && !result.canceled && result.filePaths.length > 0) {
      const dataUrl = await window.electronAPI?.readImageFile?.(result.filePaths[0]);
      if (dataUrl) setNewInstanceImage(dataUrl);
    }
  };

  const handleSelectImageForExistingInstance = async (instanceId: string) => {
    const result = await window.electronAPI?.showOpenDialog?.({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
    });
    if (result && !result.canceled && result.filePaths.length > 0) {
      const dataUrl = await window.electronAPI?.readImageFile?.(result.filePaths[0]);
      if (dataUrl) {
        setInstances(prev => prev.map(i => i.id === instanceId ? { ...i, thumbnail: dataUrl } : i));
      }
    }
  };

  const [versionMap, setVersionMap] = useState<VersionMap | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(true);

  useEffect(() => {
    fetchVersionMap().then(vm => {
      setVersionMap(vm);
      setLoadingVersions(false);
      if (vm.minecraftVersions.length > 0) {
        setNewInstanceVersion(vm.minecraftVersions[0]);
      }
    }).catch(() => setLoadingVersions(false));
  }, []);

  const minecraftVersions = versionMap?.minecraftVersions || [];

  const getModloaderVersions = (mcVer: string, loader: Instance["modloader"]): string[] => {
    if (loader === "Vanilla" || !versionMap) return [];
    const map = loader === "Fabric" ? versionMap.fabric
      : loader === "Neoforge" ? versionMap.neoforge
      : versionMap.forge;
    return map[mcVer] || [];
  };

  useEffect(() => {
    const versions = getModloaderVersions(newInstanceVersion, newInstanceModloader);
    if (versions.length > 0) {
      setNewInstanceModloaderVersion(versions[0]);
    } else {
      setNewInstanceModloaderVersion("");
    }
  }, [newInstanceVersion, newInstanceModloader]);

  const handleCreateInstance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInstanceName.trim()) return;

    let defaultRam = 4096;
    try {
      const settings = await window.electronAPI?.getSettings?.();
      if (settings?.defaultRam && typeof settings.defaultRam === 'number') {
        defaultRam = settings.defaultRam;
      }
    } catch { console.warn('[Instances] Failed to load settings for default RAM'); }

    const thumbnails = [
      "https://images.unsplash.com/photo-1605918321755-0752487167a6?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=300&q=80",
      "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&w=300&q=80"
    ];
    let finalThumbnail = newInstanceImage || "";
    if (!finalThumbnail) {
      finalThumbnail = thumbnails[Math.floor(Math.random() * thumbnails.length)];
    }

    const newInst: Instance = {
      id: `inst_${Date.now()}`,
      name: newInstanceName,
      minecraftVersion: newInstanceVersion,
      modloader: newInstanceModloader,
      modloaderVersion: newInstanceModloader !== "Vanilla" ? newInstanceModloaderVersion : undefined,
      lastPlayed: lang === "de" ? "Gerade eben" : "Just now",
      // Issue 8: Use "0 MB" instead of placeholder text until calculated
      size: "0 MB", 
      modCount: 0,
      desc: lang === "de" 
        ? `Eine Minecraft ${newInstanceVersion} Instanz mit ${newInstanceModloader}.` 
        : `A Minecraft ${newInstanceVersion} instance with ${newInstanceModloader}.`,
      thumbnail: finalThumbnail,
      javaVersion: "Automatisch",
      installedMods: [],
      content: [],
      ram: defaultRam,
    };

    setInstances([newInst, ...instances]);
    setCreateModalOpen(false);
    setNewInstanceName("");
    setNewInstanceVersion(newInstanceVersion);
    setNewInstanceModloader("Fabric");
    setNewInstanceModloaderVersion("");
    setNewInstanceImage("");
  };

  // Issue 9: Delete confirmation before deleting instance + delete complete folder
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<Instance | null>(null);

  const handleDeleteInstance = (id: string) => {
    const inst = instances.find(i => i.id === id);
    if (inst) {
      setDeleteConfirmModal(inst);
    }
  };

  const confirmDeleteInstance = async () => {
    if (!deleteConfirmModal) return;
    const folderName = deleteConfirmModal.name.toLowerCase().replace(/\s+/g, '-');
    try {
      // Delete the actual folder on disk (Issue 9)
      await window.electronAPI?.deleteProfileFiles?.(folderName);
    } catch { console.warn('[Instances] Failed to delete profile files'); }
    setInstances(prev => prev.filter(i => i.id !== deleteConfirmModal.id));
    setSelectedInstance(null);
    setDeleteConfirmModal(null);
  };

  const handleLaunchInstance = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveInstance(instances.find(i => i.id === id)?.name || "");
    onLaunch?.(id);
  };

  const triggerJavaScan = async (forceRescan = false) => {
    setIsScanningJava(true);
    setScannedJavaVersions([]);
    try {
      const versions = await window.electronAPI?.getJavaVersions?.(forceRescan);
      if (versions && versions.length > 0) {
        setScannedJavaVersions(versions.map(v => `${v.verStr} (${v.path})`));
      }
    } catch { console.warn('[Instances] Java scan failed'); }
    setIsScanningJava(false);
  };

  // Java scan is now ONLY manual (triggered by the scan button)
  // No automatic scan on startup

  const saveInstanceSettings = () => {
    if (!selectedInstance) return;
    setInstances(prev => prev.map(inst => {
      if (inst.id === selectedInstance.id) {
        return {
          ...inst,
          javaVersion: selectedJavaVersion
        };
      }
      return inst;
    }));
  };

  // Filter & Search
  const filteredInstances = instances.filter(i => {
    const matchesSearch = i.name.toLowerCase().includes(search.toLowerCase()) || i.desc.toLowerCase().includes(search.toLowerCase());
    const matchesMode = filterMode === "all" || i.modloader === filterMode;
    return matchesSearch && matchesMode;
  });

  const isRunning = (name: string) => runningInstances.some((ri: { name: string }) => ri.name === name);

  if (selectedInstance) {
    const inst = selectedInstance;
    const running = isRunning(inst.name);
    return (
      <DetailViewBoundary>
      <div className="flex-1 h-full flex flex-col overflow-hidden p-0">
        {/* Hero Banner */}
        <div className="relative h-48 shrink-0 bg-slate-950/60 border-b border-slate-800/40 overflow-hidden">
          <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent" />
          
          {/* Back + Content Overlay */}
          <div className="absolute inset-0 p-6 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setSelectedInstance(null)}
                className="p-2 rounded-xl bg-slate-950/60 hover:bg-slate-800 border border-slate-800/80 text-slate-400 hover:text-white transition-all cursor-pointer backdrop-blur-sm"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (running) { onStopGame(inst.name); } else { handleLaunchInstance(inst.id, e as any); }
                }}
                className={`px-6 py-2.5 rounded-xl text-xs font-black tracking-wide transition-all flex items-center gap-2 cursor-pointer hover:-translate-y-0.5 ${
                  running
                    ? "bg-rose-500 hover:bg-rose-400 text-white shadow-lg shadow-rose-500/20"
                    : "theme-bg hover:theme-bg-hover text-slate-950 theme-shadow-lg"
                }`}
              >
                {running ? <X className="w-4 h-4" /> : <Play className="w-4 h-4 fill-slate-950" />}
                {running ? "Stoppen" : "Starten"}
              </button>
            </div>
            
            <div className="flex items-end gap-5">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-slate-800/80 shadow-2xl shrink-0 bg-slate-900">
                <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-black text-white tracking-wide drop-shadow-lg">{inst.name}</h1>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-xs font-bold theme-text theme-bg-light theme-border-md px-2.5 py-0.5 rounded-lg">{inst.minecraftVersion}</span>
                  <span className="text-xs font-bold text-sky-400 bg-sky-500/15 border border-sky-500/25 px-2.5 py-0.5 rounded-lg">{inst.modloader}{inst.modloaderVersion ? ` ${inst.modloaderVersion}` : ""}</span>
                  {/* Issue 7: Modpacks show size in MB, not mod count */}
                  <span className="text-xs text-slate-400">
                    {inst.modloader === "Vanilla" && inst.size}
                    {inst.modloader !== "Vanilla" && (inst.content?.length ? `${inst.content.length} Inhalte` : inst.size)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex items-center gap-0.5 px-6 bg-slate-950/30 border-b border-slate-800/40 shrink-0">
          {[
            { id: "mods" as const, label: "Mods", icon: Package, count: (inst.content || []).filter(c => c.type === "mods").length },
            { id: "resourcepacks" as const, label: "Resource Packs", icon: Image, count: (inst.content || []).filter(c => c.type === "resourcepacks").length },
            { id: "shader" as const, label: "Shader", icon: Shirt, count: (inst.content || []).filter(c => c.type === "shaderpacks").length },
            { id: "worlds" as const, label: "Welten", icon: Globe, count: (inst.content || []).filter(c => c.type === "worlds").length },
            { id: "datapacks" as const, label: "Data Packs", icon: Layers, count: (inst.content || []).filter(c => c.type === "datapacks").length },
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setDetailTab(tab.id)}
                className={`px-4 py-3 text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border-b-2 ${
                  detailTab === tab.id
                    ? "text-emerald-400 border-emerald-400 bg-emerald-500/5"
                    : "text-slate-400 hover:text-slate-200 border-transparent hover:border-slate-600"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                <span className="text-[9px] font-bold bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded-full">{tab.count}</span>
              </button>
            );
          })}
          
          <div className="flex-1" />
          
          {/* Settings Button (right side) */}
          <button
            onClick={() => setDetailTab("settings")}
            className={`px-4 py-3 text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border-b-2 ${
              detailTab === "settings"
                ? "theme-text theme-border theme-bg-subtle"
                : "text-slate-400 hover:text-slate-200 border-transparent hover:border-slate-600"
            }`}
          >
            <Settings className="w-4 h-4" />
            Einstellungen
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {["mods", "resourcepacks", "shader", "worlds", "datapacks"].includes(detailTab) && (
            <DetailViewBoundary key={detailTab}>
              <ContentListView
                inst={inst}
                detailTab={detailTab}
                lang={lang}
                openModBrowserForInstance={(id) => {
                  // Issue 13: Store instance in sessionStorage for back-navigation to detail view
                  sessionStorage.setItem('bamboo-last-instance-id', inst.id);
                  setSelectedInstance(null);
                  // Issue 11: Pass content tab type so ModsView can auto-set project type filter
                  const tabMap: Record<string, string> = {
                    mods: 'mod',
                    resourcepacks: 'resourcepack',
                    shader: 'shader',
                    worlds: 'worlds',
                    datapacks: 'datapack'
                  };
                  const type = tabMap[detailTab] || 'mod';
                  // Issue 2: On CF, 'plugin' is searched as 'mod' since CF has no plugin class
                  const finalType = type === 'plugin' ? 'mod' : type;
                  // Store in sessionStorage so ModsView can read it
                  sessionStorage.setItem('bamboo-project-type', finalType);
                  sessionStorage.setItem('bamboo-project-source', detailTab === 'worlds' ? 'curseforge' : 'modrinth');
                  openModBrowserForInstance(id);
                }}
                setInstances={setInstances}
                setSelectedInstance={setSelectedInstance}
              />
            </DetailViewBoundary>
          )}

          {detailTab === "settings" && (
            <div className="max-w-3xl mx-auto flex flex-col gap-6">
              {/* General Info */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">Allgemein</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div className="bg-slate-900/40 border border-slate-850 rounded-2xl p-4 col-span-2">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Name</span>
                    <input
                      type="text"
                      value={inst.name}
                      onChange={(e) => {
                        setInstances(prev => prev.map(i => i.id === inst.id ? { ...i, name: e.target.value } : i));
                      }}
                      className="w-full bg-transparent border-b border-slate-700 focus:theme-border py-1 text-sm font-black text-slate-200 outline-none mt-1"
                    />
                  </div>
                  <div className="bg-slate-900/40 border border-slate-850 rounded-2xl p-4">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Version</span>
                    <p className="text-sm font-black text-slate-200 mt-1">{inst.minecraftVersion}</p>
                  </div>
                  <div className="bg-slate-900/40 border border-slate-850 rounded-2xl p-4">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Modloader</span>
                    <p className="text-sm font-black text-slate-200 mt-1">{inst.modloader} {inst.modloaderVersion || ""}</p>
                  </div>
                  <div className="bg-slate-900/40 border border-slate-850 rounded-2xl p-4">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Größe</span>
                    <p className="text-sm font-black text-slate-200 mt-1">{inst.size}</p>
                  </div>
                  <div className="bg-slate-900/40 border border-slate-850 rounded-2xl p-4 col-span-3">
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Instanz Bild</span>
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        type="button"
                        onClick={() => handleSelectImageForExistingInstance(inst.id)}
                        className="bg-slate-900/40 hover:bg-slate-800/60 border border-slate-800 focus:border-emerald-500/50 rounded-xl py-2.5 px-4 text-xs text-slate-200 outline-none transition-all flex items-center gap-2"
                      >
                        <Upload className="w-4 h-4" />
                        Bild auswählen
                      </button>
                      {inst.thumbnail && (
                        <img src={inst.thumbnail} alt="Preview" className="w-12 h-12 rounded-xl object-cover border border-slate-800" />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Java Version */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">Java</h3>
                <div className="flex gap-2">
                  <select
                    value={selectedJavaVersion}
                    onChange={(e) => setSelectedJavaVersion(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-3 text-xs font-bold text-slate-200 outline-none"
                  >
                    <option value="Automatisch">{t.javaAuto}</option>
                    {scannedJavaVersions.map(ver => (
                      <option key={ver} value={ver}>{ver}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={isScanningJava}
                    onClick={() => triggerJavaScan(true)}
                    className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isScanningJava ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                    {isScanningJava ? "Scanne..." : t.scanJava}
                  </button>
                </div>
              </div>

              {/* RAM Allocation */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">RAM</h3>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">Arbeitsspeicher</span>
                  <span className="text-sm font-black theme-text">{ramSliderValue} MB</span>
                </div>
                <input
                  type="range"
                  min={1024}
                  max={16384}
                  step={256}
                  value={ramSliderValue}
                  onChange={(e) => setRamSliderValue(Number(e.target.value))}
                  className="w-full accent-[var(--theme-accent)]"
                />
                <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                  <span>1 GB</span>
                  <span>Empfohlen: 4-8 GB</span>
                  <span>16 GB</span>
                </div>
              </div>

              {/* Issue 10: Modpack own content management toggle */}
              {inst.isModpack && (
                <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                  <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">
                    <Package className="w-4 h-4 inline mr-1.5" />
                    Modpack-Verwaltung
                  </h3>
                  <div className="flex items-center justify-between bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
                    <div className="flex-1">
                      <span className="block text-xs font-bold text-slate-200">{(lang === 'de' ? translations.de.ownContentManagement : translations.en.ownContentManagement)}</span>
                      <span className="text-[10px] text-slate-400 mt-1 block leading-normal">{lang === 'de' ? translations.de.ownContentManagementDesc : translations.en.ownContentManagementDesc}</span>
                      {inst.ownContentManagement && (
                        <span className="text-[9px] font-bold theme-text theme-bg-light theme-border-light px-2 py-0.5 rounded inline-block mt-2">
                          Automatische Updates deaktiviert
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setInstances(prev => prev.map(i =>
                          i.id === inst.id ? { ...i, ownContentManagement: !i.ownContentManagement } : i
                        ));
                      }}
                      className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-300 cursor-pointer shrink-0 ml-4 ${inst.ownContentManagement ? "theme-bg" : "bg-slate-800"}`}
                    >
                      <div
                        className="w-5 h-5 rounded-full bg-slate-950 shadow-md transform transition-transform duration-300"
                        style={{ transform: inst.ownContentManagement ? "translateX(20px)" : "translateX(0)" }}
                      />
                    </button>
                  </div>
                </div>
              )}

              {/* Ordner öffnen */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">{lang === "de" ? "Ordner" : "Folders"}</h3>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => window.electronAPI?.openInstanceFolder?.(inst.name.toLowerCase().replace(/\s+/g, "-"))}
                    className="bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/20 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <FolderOpen className="w-4 h-4" />
                    {lang === "de" ? "Instanzordner öffnen" : "Open Instance Folder"}
                  </button>
                  <button
                    onClick={() => window.electronAPI?.openProfileFolder?.(inst.name.toLowerCase().replace(/\s+/g, "-"))}
                    className="bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/20 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <FolderOpen className="w-4 h-4" />
                    {lang === "de" ? "Profilordner öffnen" : "Open Profile Folder"}
                  </button>
                </div>
              </div>

              {/* Repair + Actions */}
              <div className="bg-slate-950/40 border border-slate-800/60 rounded-3xl p-6">
                <h3 className="text-sm font-black text-slate-200 uppercase tracking-wider mb-4">Aktionen</h3>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={async () => {
                      // Clean-Install: erst Ordner löschen, dann neu installieren
                      const folderName = inst.name.toLowerCase().replace(/\s+/g, '-');
                      try {
                        await window.electronAPI?.deleteProfileFiles?.(folderName);
                      } catch {}
                      window.electronAPI?.repairProfile?.({ 
                        loader: inst.modloader.toLowerCase(), 
                        loaderVersion: inst.modloaderVersion || "", 
                        mcVersion: inst.minecraftVersion 
                      });
                    }}
                    className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-4 h-4" />
                    {lang === "de" ? "Clean-Neuinstallation" : "Clean Reinstall"}
                  </button>
                  <button
                    onClick={() => setShowExportModal(true)}
                    className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Download className="w-4 h-4" />
                    {lang === "de" ? "Exportieren" : "Export"}
                  </button>

                  <button
                    onClick={() => handleDeleteInstance(inst.id)}
                    className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 px-5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <Trash2 className="w-4 h-4" />
                    {lang === "de" ? "Löschen" : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* EXPORT MODAL */}
        {selectedInstance && (
          <ProfileExportModal
            isOpen={showExportModal}
            onClose={() => setShowExportModal(false)}
            instance={selectedInstance}
            lang={lang}
          />
        )}

        {/* DELETE CONFIRMATION MODAL */}
        <AnimatePresence>
          {deleteConfirmModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 pointer-events-auto"
              onClick={() => setDeleteConfirmModal(null)}
            >
              <motion.div
                initial={{ scale: 0.95, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 20 }}
                className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-sm w-full p-6 shadow-2xl flex flex-col gap-4 text-left"
                onClick={e => e.stopPropagation()}
              >
                <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                  <Trash2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {lang === "de" ? `"${deleteConfirmModal.name}" löschen?` : `Delete "${deleteConfirmModal.name}"?`}
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed mt-2">
                    {lang === "de"
                      ? "Diese Aktion löscht die Instanz, alle Mods, Welten, Screenshots und den gesamten Instanzordner unwiderruflich."
                      : "This will permanently delete the instance, all mods, worlds, screenshots and the entire instance folder."}
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setDeleteConfirmModal(null)}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {lang === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                  <button
                    onClick={confirmDeleteInstance}
                    className="flex-1 bg-rose-500 hover:bg-rose-400 text-white py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg shadow-rose-500/10"
                  >
                    {lang === "de" ? "Ja, alles löschen" : "Yes, delete all"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </DetailViewBoundary>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide flex items-center gap-2">
              {t.launcherInstances}
            </h2>
            <p className="text-xs text-slate-400 mt-1">{t.instancesDesc}</p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImportModal(true)}
            className="bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/20 px-5 py-3 rounded-2xl text-xs font-black tracking-wider uppercase transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer hover:-translate-y-0.5"
          >
            <Upload className="w-4 h-4" />
            {lang === "de" ? "Profil Importieren" : "Import Profile"}
          </button>
          <button
            onClick={() => setCreateModalOpen(true)}
            className="theme-bg hover:theme-bg-hover text-slate-950 px-5 py-3 rounded-2xl text-xs font-black tracking-wider uppercase theme-shadow-lg hover:theme-shadow-lg transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            {t.createInstance}
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 bg-slate-900/20 border border-slate-850 p-4 rounded-2xl">
        <div className="w-full md:w-80 relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchInstances}
            className="w-full bg-slate-950/40 border border-slate-800 focus:theme-border rounded-xl py-2 pl-10 pr-4 text-xs text-slate-200 placeholder-slate-400 outline-none transition-all"
          />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto">
          <button
            onClick={() => setFilterMode("all")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
              filterMode === "all"
                ? "theme-bg-light theme-text theme-border-light"                      : "bg-slate-900/40 text-slate-400 border border-slate-800/50 hover:text-slate-200 hover:border-slate-700"
            }`}
          >
            {lang === "de" ? "Alle" : t.allInstances}
          </button>
          {["Vanilla", "Fabric", "Neoforge", "Forge"].map(loader => (
            <button
              key={loader}
              onClick={() => setFilterMode(loader)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                filterMode === loader
                  ? "theme-bg-light theme-text theme-border-light"
                  : "bg-slate-900/40 text-slate-400 border border-slate-800/50 hover:text-slate-200 hover:border-slate-700"
              }`}
            >
              {loader}
            </button>
          ))}
        </div>
      </div>

      {/* Instances Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <AnimatePresence mode="popLayout">
          {filteredInstances.map((inst, index) => {
            const isRunning = runningInstances.some((ri: { name: string }) => ri.name === inst.name);
            return (
              <motion.div
                key={inst.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.25, delay: index * 0.03 }}
                onClick={() => setSelectedInstance(inst)}
                className={`bg-slate-950/45 backdrop-blur-xl border rounded-3xl p-4 flex flex-col justify-between group hover:shadow-2xl transition-all duration-300 relative overflow-hidden cursor-pointer ${
                  isRunning ? "border-rose-500/50 shadow-rose-500/10" : "border-slate-800/60 hover:theme-border-light"
                }`}
              >
                {/* Thumbnail 0.5x (16:9) */}
                <div className="aspect-video rounded-xl overflow-hidden relative border border-slate-900 shrink-0">
                  <img src={inst.thumbnail} alt={inst.name} className="w-full h-full object-cover group-hover:scale-103 transition-transform duration-500" />
                  <div className="absolute inset-0 bg-slate-950/45 group-hover:bg-slate-950/25 transition-colors" />
                  
                  {/* Smaller Play Button in Top Right on hover as requested! */}
<div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRunning) {
                            onStopGame(inst.name);
                          } else {
                            handleLaunchInstance(inst.id, e);
                          }
                        }}
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-lg transition-transform duration-300 hover:scale-110 cursor-pointer ${
                          isRunning
                            ? "bg-rose-500 hover:bg-rose-400 text-white"
                            : "theme-bg hover:theme-bg-hover text-slate-950"
                        }`}
                      >
                        {isRunning ? (
                          <X className="w-5 h-5 stroke-[2.5]" />
                        ) : (
                          <Play className="w-5 h-5 fill-slate-950 stroke-[2.5]" />
                        )}
                      </button>
                    </div>

                  {/* Mode Badge */}
                  <span className={`absolute top-3 left-3 text-[9px] font-extrabold px-2 py-0.5 rounded-md border uppercase tracking-wider bg-slate-950/80 theme-text theme-border-light`}>
                    {inst.modloader}
                  </span>
                </div>

                {/* Instance Metadata */}
                <div className="mt-4 flex-1 flex flex-col justify-between text-left">
                  <div>
                    <h3 className="text-base font-black text-slate-100 group-hover:theme-text-bright transition-colors tracking-wide truncate">
                      {inst.name}
                    </h3>
                    <p className="text-[11px] text-slate-400 line-clamp-2 mt-1.5 leading-relaxed font-medium">
                      {inst.desc}
                    </p>
                    
                    <div className="grid grid-cols-2 gap-2 mt-3 text-[11px] text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-500" />
                        <span className="truncate">{inst.lastPlayed}</span>
                      </div>
                      <div className="flex items-center gap-1.5 justify-end">
                        <Cpu className="w-3.5 h-3.5 text-slate-500" />
                        {/* Issue 21: Use content filter for accurate mod count (no fallback to installedMods) */}
                        <span>{(inst.content || []).filter(c => c.type === 'mods').length} {t.modsCount}</span>
                      </div>
                    </div>
                  </div>

                  {/* Action buttons footer */}
                  <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-slate-900">
                    <span className="text-[10px] font-bold text-slate-500 bg-slate-900/40 border border-slate-850 px-2 py-0.5 rounded flex items-center gap-1 truncate max-w-[180px]" title={inst.size}>
                      <HardDrive className="w-3 h-3 shrink-0" /> {inst.size}
                    </span>
                    
                    <div className="flex items-center gap-1.5">
                      {isRunning ? (
                        <span className="text-[9px] font-black text-rose-400 uppercase">Läuft</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* EMPTY STATE IF NO INSTANCES COMPLYING WITH REQUIREMENT 6 */}
      {instances.length === 0 && (
        <div className="py-24 text-center flex flex-col items-center justify-center gap-4">
          <div className="w-20 h-20 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 shadow-2xl">
            <Layers className="w-10 h-10" />
          </div>
          <div>
            <p className="text-base font-black text-slate-200">Keine Instanzen gefunden / No instances found</p>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">Erstelle deine erste Minecraft-Instanz, um Mods zu konfigurieren und Abenteuer zu starten.</p>
          </div>
          <button
            onClick={() => setCreateModalOpen(true)}
            className="theme-bg hover:theme-bg-hover text-slate-950 px-5 py-2.5 rounded-xl text-xs font-black uppercase theme-shadow-lg cursor-pointer"
          >
            Neue Instanz erstellen
          </button>
        </div>
      )}

      {/* IMPORT MODAL */}
      <ProfileImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        instances={instances}
        setInstances={setInstances}
        lang={lang}
      />

      {/* CREATE NEW INSTANCE MODAL (EXACTLY AS SPECIFIED BY USER!) */}
      <AnimatePresence>
        {createModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => setCreateModalOpen(false)}
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
                  <Plus className="w-5 h-5 theme-text" />
                  <h3 className="text-lg font-black text-white tracking-wide">{t.createInstance}</h3>
                </div>
                <button
                  onClick={() => setCreateModalOpen(false)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateInstance} className="p-6 flex flex-col gap-4 text-left overflow-y-auto max-h-[70vh] custom-scrollbar">
                {loadingVersions ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <RefreshCw className="w-10 h-10 theme-text animate-spin" />
                    <p className="text-xs text-slate-400 font-bold">Lade Versionen...</p>
                  </div>
                ) : minecraftVersions.length === 0 ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <p className="text-xs text-slate-400 font-bold">Keine Versionen verfügbar</p>
                  </div>
                ) : (
                  <> 
                    {/* 1. Instanz Name */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Instanz Name</label>
                      <input
                        type="text"
                        required
                        value={newInstanceName}
                        onChange={(e) => setNewInstanceName(e.target.value)}
                        placeholder="z.B. Sodium Boosted 1.21.4"
                        className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-4 text-sm text-slate-200 placeholder-slate-500 outline-none transition-all"
                      />
                    </div>

                    {/* 2. Minecraft Version */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Minecraft Version</label>
                      <select
                        value={newInstanceVersion}
                        onChange={(e) => setNewInstanceVersion(e.target.value)}
                        className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-3 text-sm text-slate-200 outline-none transition-all"
                      >
                        {minecraftVersions.map(ver => {
                          // Calculate version popularity percentage based on position in list
                          const idx = minecraftVersions.indexOf(ver);
                          const total = minecraftVersions.length;
                          const pct = Math.round((1 - idx / total) * 100);
                          return (
                            <option key={ver} value={ver} className="bg-slate-950">
                              {ver} {pct >= 90 ? "★" : ""}
                            </option>
                          );
                        })}
                      </select>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.max(0, Math.round((1 - minecraftVersions.indexOf(newInstanceVersion) / minecraftVersions.length) * 100))}%`,
                              background: "var(--theme-accent)",
                            }}
                          />
                        </div>
                        <span
                          className="text-[10px] font-bold font-mono"
                          style={{ color: "var(--theme-accent)" }}
                        >
                          {Math.max(0, Math.round((1 - minecraftVersions.indexOf(newInstanceVersion) / minecraftVersions.length) * 100))}%
                        </span>
                      </div>
                    </div>

                    {/* 3. Modloader */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Modloader</label>
                      <select
                        value={newInstanceModloader}
                        onChange={(e) => setNewInstanceModloader(e.target.value as Instance["modloader"])}
                        className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-3 text-sm text-slate-200 outline-none transition-all"
                      >
                        <option value="Vanilla" className="bg-slate-950">Vanilla</option>
                        <option value="Fabric" className="bg-slate-950">Fabric</option>
                        <option value="Neoforge" className="bg-slate-950">Neoforge</option>
                        <option value="Forge" className="bg-slate-950">Forge</option>
                      </select>
                    </div>

                    {/* 4. Modloader Version */}
                    {newInstanceModloader !== "Vanilla" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Modloader Version</label>
                        <select
                          value={newInstanceModloaderVersion}
                          onChange={(e) => setNewInstanceModloaderVersion(e.target.value)}
                          className="w-full bg-slate-900/40 border border-slate-800 focus:theme-border rounded-xl py-2.5 px-3 text-sm text-slate-200 outline-none transition-all"
                        >
                          {getModloaderVersions(newInstanceVersion, newInstanceModloader).map(v => (
                            <option key={v} value={v} className="bg-slate-950">{v}</option>
                          ))}
                        </select>
                      </div>
                    )}

                     {/* 5. Custom Thumbnail Upload */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Instanz Bild</label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSelectImageForNewInstance}
                          className="bg-slate-900/40 hover:bg-slate-800/60 border border-slate-800 focus:border-emerald-500/50 rounded-xl py-2.5 px-4 text-xs text-slate-200 outline-none transition-all flex items-center gap-2"
                        >
                          <Upload className="w-4 h-4" />
                          Bild auswählen
                        </button>
                        {newInstanceImage && (
                          <img src={newInstanceImage} alt="Preview" className="w-12 h-12 rounded-xl object-cover border border-slate-800" />
                        )}
                      </div>
                    </div>

                    <div className="flex gap-3 mt-4 pt-4 border-t border-slate-900">
                      <button
                        type="button"
                        onClick={() => setCreateModalOpen(false)}
                        className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        {t.cancel}
                      </button>
                      <button
                        type="submit"
                        className="flex-1 theme-bg hover:theme-bg-hover text-slate-950 py-3 rounded-xl text-xs font-black tracking-wide theme-shadow-lg transition-all cursor-pointer"
                      >
                        {t.create}
                      </button>
                    </div>
                  </>
                )}
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};

// ===== NESTED ERROR BOUNDARY to prevent ContentListView crashes from blacking out the whole screen =====
class DetailViewBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error('[DetailViewBoundary] Error in instance detail view:', error);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
            <h3 className="text-lg font-black text-white mb-2">Detailansicht konnte nicht geladen werden</h3>
            <p className="text-sm text-slate-400 mb-4">Ein Fehler ist beim Rendern der Instanz-Details aufgetreten.</p>
            <button onClick={() => this.setState({ hasError: false })}
              className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs font-bold text-slate-200 transition-all cursor-pointer">
              Erneut versuchen
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ===== CONTENT DETAIL MODAL =====
const ContentDetailModal = ({
  item,
  onClose,
  localInst,
  setInstances,
}: {
  item: ContentItem;
  onClose: () => void;
  localInst: Instance;
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
}) => {
  const { addToast } = useToast();
  const [detailTab, setDetailTab] = useState<"info" | "actions">("info");

  const handleDelete = async () => {
    // Also delete the actual file from disk so it doesn't reappear on reload
    if (item.fileName) {
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      const typeDir = item.type === 'resourcepacks' ? 'resourcepacks'
        : item.type === 'shaderpacks' ? 'shaderpacks'
        : item.type === 'datapacks' ? 'datapacks'
        : 'mods';
      try {
        await window.electronAPI?.deleteContentFile?.({ folderName, fileName: item.fileName, type: typeDir });
      } catch (e) {
        console.warn('[ContentDetailModal] Konnte Datei nicht von Platte löschen:', e);
      }
    }
    setInstances(prev => prev.map(i =>
      i.id === localInst.id
        ? { 
            ...i, 
            content: (i.content || []).filter(c => c.id !== item.id), 
            installedMods: (i.installedMods || []).filter(s => s !== item.id),
            // Issue 21: Decrement modCount when deleting a mod
            modCount: item.type === 'mods' ? Math.max(0, (i.modCount || 0) - 1) : i.modCount,
          }
        : i
    ));
    onClose();
  };

  const handleToggleEnabled = () => {
    setInstances(prev => prev.map(i =>
      i.id === localInst.id
        ? { ...i, content: (i.content || []).map(c => c.id === item.id ? { ...c, enabled: !c.enabled } : c) }
        : i
    ));
  };

  const handleToggleLocked = () => {
    setInstances(prev => prev.map(i =>
      i.id === localInst.id
        ? { ...i, content: (i.content || []).map(c => c.id === item.id ? { ...c, locked: !c.locked } : c) }
        : i
    ));
  };

  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [availableVersions, setAvailableVersions] = useState<{ version_number: string; date_published: string; url: string; filename: string; isCompatible: boolean }[]>([]);
  const [fetchingVersions, setFetchingVersions] = useState(false);
  const [installingVersion, setInstallingVersion] = useState(false);

  const handleFetchVersions = async () => {
    if (!item.projectId || !item.source) return;
    setFetchingVersions(true);
    try {
      const slug = item.projectId;
      const res = await fetch(`https://api.modrinth.com/v2/project/${slug}/version`, {
        headers: { 'User-Agent': 'BambooLauncher/0.1.0' }
      });
      if (!res.ok) return;
      const data = await res.json();
      const mcVer = localInst.minecraftVersion;
      const versions = data
        .filter((v: any) => v.files?.length > 0)
        .map((v: any) => ({
          version_number: v.version_number,
          date_published: v.date_published,
          url: v.files[0].url,
          filename: v.files[0].filename,
          isCompatible: v.game_versions?.includes(mcVer) ?? false,
        }));
      setAvailableVersions(versions);
      setShowVersionPicker(true);
    } catch (e) {
      console.error('[ContentDetailModal] Fehler beim Abrufen der Versionen:', e);
    } finally {
      setFetchingVersions(false);
    }
  };

  const handleSwitchVersion = async (ver: { version_number: string; url: string; filename: string; isCompatible: boolean }) => {
    setInstallingVersion(true);
    try {
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      const typeDir = item.type === 'resourcepacks' ? 'resourcepacks'
        : item.type === 'shaderpacks' ? 'shaderpacks'
        : item.type === 'datapacks' ? 'datapacks'
        : 'mods';

      // 1. DELETE old file from disk BEFORE downloading new one
      if (item.fileName) {
        try {
          await window.electronAPI?.deleteContentFile?.({
            folderName,
            fileName: item.fileName,
            type: typeDir
          });
          console.log('[ContentDetailModal] Alte Datei gelöscht:', item.fileName);
        } catch (e) {
          console.warn('[ContentDetailModal] Alte Datei konnte nicht gelöscht werden, fahre mit Download fort:', e);
        }
      }

      // 1b. Scan directory for ANY other files matching this mod (robust delete by pattern)
      try {
        const diskFiles = await window.electronAPI?.listContentFiles?.({ folderName, type: typeDir });
        if (diskFiles && diskFiles.length > 0) {
          const modSlug = item.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
          const projLower = (item.projectId || '').toLowerCase();
          const newFilename = ver.filename.toLowerCase();
          const oldFilename = (item.fileName || '').toLowerCase();
          const toDelete = diskFiles.filter((f: string) => {
            const lower = f.toLowerCase();
            if (lower === newFilename) return false; // Don't delete the NEW file
            if (lower === oldFilename && item.fileName) return false; // Already deleted above
            // Match by slug OR project ID in filename
            return lower.includes(modSlug) || (projLower && lower.includes(projLower));
          });
          for (const oldFile of toDelete) {
            try {
              await window.electronAPI?.deleteContentFile?.({ folderName, fileName: oldFile, type: typeDir });
              console.log('[ContentDetailModal] Alte Version gelöscht (Pattern-Match):', oldFile);
            } catch (e2) {
              console.warn('[ContentDetailModal] Konnte nicht löschen (Pattern):', oldFile, e2);
            }
          }
          if (toDelete.length > 0) {
            console.log('[ContentDetailModal] Insgesamt', toDelete.length, 'alte Dateien gelöscht via Pattern-Match');
          }
        }
      } catch (e3) {
        console.warn('[ContentDetailModal] Fehler beim Scannen nach alten Dateien:', e3);
      }

      // 2. Download new version
      const result = await window.electronAPI?.downloadMod?.({
        folderName,
        profileName: localInst.name,
        versionId: localInst.minecraftVersion,
        downloadUrl: ver.url,
        filename: ver.filename,
        itemType: item.type === 'resourcepacks' ? 'resourcepack' : item.type === 'shaderpacks' ? 'shader' : item.type === 'datapacks' ? 'datapack' : 'mods',
      });

      if (result?.success) {
        // 3. Update version number AND fileName on the card so tile text refreshes
        setInstances(prev => prev.map(i =>
          i.id === localInst.id
            ? {
                ...i,
                content: (i.content || []).map(c =>
                  c.id === item.id
                    ? { ...c, version: localInst.minecraftVersion, versionNumber: ver.version_number, fileName: ver.filename, updateAvailable: false }
                    : c
                )
              }
            : i
        ));
        setShowVersionPicker(false);
        onClose();
        addToast({ type: 'success', message: `Version gewechselt zu ${ver.version_number}` });
      }
    } catch (e: any) {
      console.error('[ContentDetailModal] Fehler beim Version-Wechsel:', e);
      addToast({ type: 'error', message: 'Version-Wechsel fehlgeschlagen' });
    } finally {
      setInstallingVersion(false);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20 }}
          className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-6 border-b border-slate-900 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center overflow-hidden">
                {item.iconUrl ? (
                  <img src={item.iconUrl} alt={item.name} className="w-full h-full object-cover"
                       onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : item.type === "mods" ? <Package className="w-6 h-6 text-slate-400" /> :
                   item.type === "resourcepacks" ? <Image className="w-6 h-6 text-slate-400" /> :
                   item.type === "shaderpacks" ? <Shirt className="w-6 h-6 text-slate-400" /> :
                   item.type === "worlds" ? <Globe className="w-6 h-6 text-slate-400" /> :
                   <Layers className="w-6 h-6 text-slate-400" />}
              </div>
              <div className="text-left">
                <h3 className="text-lg font-black text-white tracking-wide">{item.name}</h3>
                <p className="text-[10px] text-slate-400 font-mono">{item.fileName}</p>
              </div>
            </div>
            <button onClick={onClose} className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-6 flex flex-col gap-4 text-left">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-900/20 border border-slate-850 rounded-2xl p-3">
                <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wider">Version</span>
                <span className="text-sm font-black text-slate-200 mt-1 block">{item.version}</span>
                {item.versionNumber && item.versionNumber !== item.version && (
                  <span className="text-[9px] theme-text mt-0.5 block">{item.versionNumber}</span>
                )}
              </div>
              <div className="bg-slate-900/20 border border-slate-850 rounded-2xl p-3 flex items-center justify-between">
                <div>
                  <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wider">Status</span>
                  <span className={`text-sm font-black mt-1 block ${item.enabled ? 'theme-text' : 'text-amber-400'}`}>
                    {item.enabled ? 'Aktiviert' : 'Deaktiviert'}
                  </span>
                </div>
                {item.locked && <Lock className="w-4 h-4 text-amber-400" />}
              </div>
            </div>
            {item.projectId && item.source && (
              <button
                onClick={handleFetchVersions}
                disabled={fetchingVersions}
                className="w-full theme-bg-light hover:theme-bg-md theme-text theme-border-light border rounded-xl py-2.5 px-4 text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {fetchingVersions ? (
                  <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Versionen werden geladen...</>
                ) : (
                  <><RefreshCw className="w-3.5 h-3.5" /> Version wechseln</>
                )}
              </button>
            )}
          </div>
          <div className="p-4 bg-slate-900/40 border-t border-slate-900 flex justify-end items-center">
            <button onClick={handleDelete} disabled={item.locked} className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 px-4 py-2 rounded-xl text-[10px] font-bold transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
              <Trash2 className="w-3.5 h-3.5 inline mr-1" />
              Löschen
            </button>
          </div>
        </motion.div>
      </motion.div>

      {/* Version Picker Modal */}
      {showVersionPicker && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-[60]"
          onClick={() => setShowVersionPicker(false)}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-md w-full overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-slate-900 flex items-center justify-between">
              <h3 className="text-base font-black text-white">Version wechseln – {item.name}</h3>
              <button onClick={() => setShowVersionPicker(false)} className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 max-h-80 overflow-y-auto custom-scrollbar flex flex-col gap-2">
              {availableVersions.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-8">Keine Versionen für dieses Projekt gefunden.</p>
              ) : (
                availableVersions.map((ver) => (
                  <button
                    key={ver.version_number}
                    onClick={() => {
                      if (!ver.isCompatible) {
                        addToast({ type: 'warning', message: `Diese Version ist nicht als kompatibel mit ${localInst.minecraftVersion} markiert. Installation auf eigene Gefahr.` });
                      }
                      handleSwitchVersion(ver);
                    }}
                    disabled={installingVersion || ver.version_number === item.versionNumber}
                    className={`flex items-center justify-between bg-slate-900/30 hover:bg-slate-900/60 border border-slate-850 rounded-xl px-4 py-3 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-left w-full ${
                      ver.version_number === item.versionNumber ? 'border-theme-text/30' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-200 truncate">{ver.version_number}</span>
                        {!ver.isCompatible && (
                          <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded shrink-0">Inkompatibel</span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">{new Date(ver.date_published).toLocaleDateString()}</span>
                    </div>
                    <div className="shrink-0 ml-3">
                      {ver.version_number === item.versionNumber ? (
                        <span className="text-[10px] theme-text font-bold">Aktuell</span>
                      ) : (
                        installingVersion ? (
                          <RefreshCw className="w-4 h-4 animate-spin theme-text" />
                        ) : (
                          <Download className="w-4 h-4 text-slate-400" />
                        )
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
};

// ===== CONTENT LIST VIEW (Mods, Resource Packs, Shader, Worlds, Data Packs) =====
const ContentListView = ({
  inst: initialInst,
  detailTab,
  lang,
  openModBrowserForInstance,
  setInstances,
  setSelectedInstance,
}: {
  inst: Instance;
  detailTab: string;
  lang: LanguageType;
  openModBrowserForInstance: (id: string) => void;
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  setSelectedInstance: (inst: Instance | null) => void;
}) => {
  const { addToast } = useToast();
  const [localInst, setLocalInst] = useState(initialInst);
  const [selectedContentItem, setSelectedContentItem] = useState<ContentItem | null>(null);
  // Issue 6: Update checking state
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [lastUpdateCheck, setLastUpdateCheck] = useState(0);
  // Issue 24: Upload progress state
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  useEffect(() => {
    setLocalInst(initialInst);
  }, [initialInst.id]);

  const contentItems = (localInst.content || []).filter(c => c.type === (detailTab === "shader" ? "shaderpacks" : detailTab));

  // ===== Issue 6: Live Mod Update Checking =====
  const checkContentUpdates = async () => {
    // Use latest instance data via setLocalInst callback to avoid stale closure
    let currentContent: ContentItem[] = [];
    setLocalInst(prev => {
      currentContent = prev.content || [];
      return prev; // Don't actually update, just read
    });
    
    // If setLocalInst didn't sync yet, fallback to localInst
    const items = currentContent.length > 0 ? currentContent : (localInst.content || []);
    const mcVer = localInst.minecraftVersion;
    let updatedItems = [...items];

    // Only check items that have projectId (skip local files without update tracking)
    const itemsToCheck = items.filter(c => c.projectId && c.source === 'modrinth' && c.versionNumber);
    if (itemsToCheck.length === 0) {
      // File names reconciled but nothing to check for updates - done
      setCheckingUpdates(false);
      return;
    }
    
    setCheckingUpdates(true);

    // 1. Scan content directories to reconcile file names on disk with stored data
    const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
    try {
      const scanTypes: { type: string; dir: string }[] = [
        { type: 'mods', dir: 'mods' },
        { type: 'resourcepacks', dir: 'resourcepacks' },
        { type: 'shaderpacks', dir: 'shaderpacks' },
        { type: 'datapacks', dir: 'datapacks' },
      ];
      for (const st of scanTypes) {
        const diskFiles = await window.electronAPI?.listContentFiles?.({ folderName, type: st.dir });
        if (!diskFiles || diskFiles.length === 0) continue;
        for (let i = 0; i < updatedItems.length; i++) {
          const ci = updatedItems[i];
          if (ci.type !== st.type) continue;
          const slug = ci.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const projLower = (ci.projectId || '').toLowerCase();
          // If stored fileName doesn't exist on disk, try to find a matching file
          if (ci.fileName) {
            if (!diskFiles.includes(ci.fileName)) {
              const match = diskFiles.find((f: string) =>
                f.toLowerCase().includes(slug) || (projLower && f.toLowerCase().includes(projLower))
              );
              if (match) updatedItems[i] = { ...ci, fileName: match };
            }
          } else {
            const match = diskFiles.find((f: string) =>
              f.toLowerCase().includes(slug) || (projLower && f.toLowerCase().includes(projLower))
            );
            if (match) updatedItems[i] = { ...ci, fileName: match };
          }
        }
      }
    } catch (e) {
      console.warn('[Update Check] Fehler beim Scannen der Dateien:', e);
    }

    // 2. Check each item in batches for updates (existing logic)
    const batchSize = 5;
    for (let i = 0; i < itemsToCheck.length; i += batchSize) {
      const batch = itemsToCheck.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const res = await fetch(`https://api.modrinth.com/v2/project/${item.projectId}/version`, {
              headers: { 'User-Agent': 'BambooLauncher/0.1.0' }
            });
            if (!res.ok) return null;
            const versions = await res.json();
            if (!Array.isArray(versions) || versions.length === 0) return null;
            // Find the latest version compatible with the instance's MC version
            const compatible = versions.find((v: any) =>
              v.game_versions?.includes(mcVer) && v.files?.length > 0
            );
            if (!compatible) return null;
            // Compare version numbers directly (both are mod version numbers now)
            if (compatible.version_number !== item.versionNumber) {
              return { id: item.id, updateAvailable: true };
            }
          } catch (e) {
            console.warn('[Update Check] Fehler beim Prüfen von', item.name, e);
          }
          return null;
        })
      );
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const idx = updatedItems.findIndex(c => c.id === result.value.id);
          if (idx !== -1) {
            updatedItems[idx] = { ...updatedItems[idx], updateAvailable: true };
          }
        }
      }
    }
    
    // Update both instance states with reconciled content and update flags
    setInstances(prev => prev.map(i => 
      i.id === localInst.id ? { ...i, content: updatedItems } : i
    ));
    setLocalInst(prev => ({ ...prev, content: updatedItems }));
    setCheckingUpdates(false);
    setLastUpdateCheck(Date.now());
    console.log('[Update Check] Paket-Neuladen abgeschlossen. Items:', updatedItems.length, 'Updates:', updatedItems.filter(c => c.updateAvailable).length);
  };

  // Issue 6: Auto-check for updates on mount and periodically (every 5 minutes)
  useEffect(() => {
    const timer = setTimeout(() => {
      checkContentUpdates();
    }, 1000); // Small delay to let the component mount fully
    const interval = setInterval(() => {
      checkContentUpdates();
    }, 5 * 60 * 1000); // 5 minutes
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [initialInst.id, detailTab]);
  const slug = localInst.name.toLowerCase().replace(/\s+/g, "-");

  const withUpdatedInstance = (updater: (inst: Instance) => Instance) => {
    setInstances(prev => prev.map(i => i.id === localInst.id ? updater(i) : i));
    setLocalInst(prev => updater(prev));
  };

  const updateContent = (updater: (items: ContentItem[]) => ContentItem[]) => {
    withUpdatedInstance(i => ({ ...i, content: updater(i.content || []) }));
  };

  const handleToggleEnabled = (itemId: string) => {
    updateContent(items => items.map(c => c.id === itemId ? { ...c, enabled: !c.enabled } : c));
  };

  const handleToggleLocked = (itemId: string) => {
    updateContent(items => items.map(c => c.id === itemId ? { ...c, locked: !c.locked } : c));
  };

  // Issue 24: Upload a local mod/resourcepack/shader file
  const handleUploadLocalMod = async () => {
    const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
    const typeMap: Record<string, string> = {
      mods: 'mods',
      resourcepacks: 'resourcepack',
      shader: 'shader',
      worlds: 'worlds',
      datapacks: 'datapack'
    };
    const itemType = typeMap[detailTab] || 'mods';
    
    try {
      // Use per-type file filters
      const typeFilters: Record<string, { name: string; extensions: string[] }> = {
        mods: { name: 'Mods', extensions: ['jar', 'disabled'] },
        resourcepacks: { name: 'Resource Packs', extensions: ['zip'] },
        shader: { name: 'Shader Packs', extensions: ['zip'] },
        datapacks: { name: 'Data Packs', extensions: ['zip'] },
        worlds: { name: 'World Archives', extensions: ['zip', 'mcworld'] },
      };
      const filterItem = typeFilters[detailTab] || typeFilters.mods;
      const result = await window.electronAPI?.showOpenDialog?.({
        properties: ['openFile'],
        filters: [filterItem],
      });
      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return;
      
      setUploadingFile(true);
      setUploadProgress(0);
      
      // Listen for progress updates
      const unsub = window.electronAPI?.onUploadProgress?.((data: { percent: number }) => {
        if (data && typeof data.percent === 'number') {
          setUploadProgress(data.percent);
        }
      });
      
      try {
        const uploadResult = await window.electronAPI?.uploadLocalMod?.({
          folderName,
          filePath: result.filePaths[0],
          itemType,
        });
        
        if (uploadResult?.success) {
          setUploadProgress(100);
          const fileName = result.filePaths[0].split(/[\\/]/).pop() || 'unknown';
          const displayType = detailTab === 'mods' ? 'Mod' : detailTab === 'resourcepacks' ? 'Resource Pack' : detailTab === 'shader' ? 'Shader' : 'Datei';
          
          // Add to content list and update modCount
          const contentType = detailTab === 'shader' ? 'shaderpacks' : detailTab;
          withUpdatedInstance(i => ({
            ...i,
            content: [...(i.content || []), {
              id: fileName,
              name: fileName.replace(/\.(jar|zip|disabled)$/i, ''),
              fileName: fileName,
              version: 'Lokal',
              type: contentType as ContentItem['type'],
              enabled: true,
              locked: false,
            }],
            modCount: contentType === 'mods' ? (i.modCount || 0) + 1 : i.modCount,
          }));
          
          addToast({ type: 'success', message: `${displayType} ${fileName} erfolgreich hochgeladen` });
        } else {
          addToast({ type: 'error', message: uploadResult?.error || 'Upload fehlgeschlagen' });
        }
      } finally {
        if (unsub) unsub();
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Upload fehlgeschlagen' });
    } finally {
      setUploadingFile(false);
      setUploadProgress(0);
    }
  };

  const handleDeleteContent = async (itemId: string) => {
    // Issue 1: Also delete the actual file from disk (Issue 23)
    const item = (localInst.content || []).find(c => c.id === itemId);
    if (item && item.fileName) {
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      const typeDir = item.type === 'resourcepacks' ? 'resourcepacks' : item.type === 'shaderpacks' ? 'shaderpacks' : 'mods';
      try {
        // Delete the file from disk
        await window.electronAPI?.deleteContentFile?.({
          folderName,
          fileName: item.fileName,
          type: typeDir
        });
      } catch { console.warn('[Instances] Failed to save instance settings'); }
    }
    // Issue 21: Also decrement modCount when deleting a mod
    if (item && item.type === 'mods') {
      withUpdatedInstance(i => ({ ...i, modCount: Math.max(0, (i.modCount || 0) - 1) }));
    }
    updateContent(items => items.filter(c => c.id !== itemId));
  };

  const handleUpdate = async (itemId: string) => {
    const item = (localInst.content || []).find(c => c.id === itemId);
    if (!item || !item.projectId || !item.source) {
      // Fallback: nur Flag entfernen falls keine Projekt-ID
      updateContent(items => items.map(c => c.id === itemId ? { ...c, updateAvailable: false } : c));
      return;
    }

    try {
      const mcVer = localInst.minecraftVersion;
      // 1. Fetch latest compatible version
      const slug = item.projectId;
      const res = await fetch(`https://api.modrinth.com/v2/project/${slug}/version`, {
        headers: { 'User-Agent': 'BambooLauncher/0.1.0' }
      });
      if (!res.ok) return;
      const versions = await res.json();
      const compatible = versions.find((v: any) =>
        v.game_versions?.includes(mcVer) && v.files?.length > 0
      );
      if (!compatible) return;

      // 2. Delete old file from disk
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      const typeDir = item.type === 'resourcepacks' ? 'resourcepacks' : item.type === 'shaderpacks' ? 'shaderpacks' : item.type === 'datapacks' ? 'datapacks' : 'mods';
      if (item.fileName) {
        try {
          await window.electronAPI?.deleteContentFile?.({ folderName, fileName: item.fileName, type: typeDir });
        } catch { console.warn('[Instances] Failed to delete content file'); }
      }

      // 3. Download new version
      const newFile = compatible.files[0];
      const result = await window.electronAPI?.downloadMod?.({
        folderName,
        profileName: localInst.name,
        versionId: mcVer,
        downloadUrl: newFile.url,
        filename: newFile.filename,
        itemType: item.type === 'resourcepacks' ? 'resourcepack' : item.type === 'shaderpacks' ? 'shader' : item.type === 'datapacks' ? 'datapack' : 'mods',
      });

      if (result?.success) {
        // 4. Update content entry: neue Dateiname, Version, entferne Update-Flag
        updateContent(items => items.map(c =>
          c.id === itemId
            ? { ...c, fileName: newFile.filename, version: mcVer, versionNumber: compatible.version_number, updateAvailable: false }
            : c
        ));
        addToast({ type: 'success', message: `${item.name} erfolgreich aktualisiert auf ${compatible.version_number}` });
      }
    } catch (e: any) {
      console.error('[Update] Fehler beim Update von', item?.name, e);
      addToast({ type: 'error', message: `Update fehlgeschlagen: ${e.message}` });
    }
  };

  const handleUpdateAll = async () => {
    const updatable = (localInst.content || []).filter(c => c.updateAvailable && !c.locked && c.projectId && c.source);
    for (const item of updatable) {
      await handleUpdate(item.id);
    }
  };

  const hasUpdates = contentItems.some(c => c.updateAvailable);

  // Issue 10: Modpack update checking
  const [modpackUpdateAvailable, setModpackUpdateAvailable] = useState(false);
  const [modpackCheckingUpdates, setModpackCheckingUpdates] = useState(false);
  const [modpackVersions, setModpackVersions] = useState<{ version_number: string; date_published: string; url: string; mcVersion: string; loader: string }[]>([]);
  const [showModpackUpdateModal, setShowModpackUpdateModal] = useState(false);
  const [showModpackUpdateOptions, setShowModpackUpdateOptions] = useState(false);
  const [selectedModpackVersion, setSelectedModpackVersion] = useState<string>("");
  const [modpackUpdateInstalling, setModpackUpdateInstalling] = useState(false);
  const [modpackUpdateProgress, setModpackUpdateProgress] = useState("");

  const checkModpackUpdates = async () => {
    if (!localInst.isModpack || !localInst.modpackProjectId) return;
    setModpackCheckingUpdates(true);
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${localInst.modpackProjectId}/version`, {
        headers: { 'User-Agent': 'BambooLauncher/0.1.0' }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return;
      
      // Filter for .mrpack files and extract info
      const packVersions = data
        .filter((v: any) => v.files?.some((f: any) => f.url?.endsWith('.mrpack')))
        .map((v: any) => {
          const mrpackFile = v.files.find((f: any) => f.url?.endsWith('.mrpack'));
          const mcVer = (v.game_versions || []).find((g: string) => /^\d+\.\d+(\.\d+)?$/.test(g)) || "1.21";
          const loader = (v.loaders || []).find((l: string) => ["fabric", "forge", "neoforge", "quilt"].includes(l)) || "fabric";
          return {
            version_number: v.version_number,
            date_published: v.date_published,
            url: mrpackFile?.url || "",
            mcVersion: mcVer,
            loader,
          };
        })
        .sort((a: any, b: any) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime());
      
      setModpackVersions(packVersions);
      
      // Check if newer version exists compared to current modpackVersion
      if (packVersions.length > 0 && packVersions[0].version_number !== localInst.modpackVersion) {
        setModpackUpdateAvailable(true);
      }
    } catch (e) {
      console.warn('[Modpack Update] Fehler beim Prüfen', e);
    } finally {
      setModpackCheckingUpdates(false);
    }
  };

  useEffect(() => {
    if (localInst.isModpack && localInst.modpackProjectId) {
      checkModpackUpdates();
    }
  }, [localInst.modpackProjectId, localInst.modpackVersion]);

  // Issue 10: Handle modpack update options
  const handleModpackNewInstance = async () => {
    if (!selectedModpackVersion) return;
    const versionData = modpackVersions.find(v => v.version_number === selectedModpackVersion);
    if (!versionData) return;
    
    setModpackUpdateInstalling(true);
    setModpackUpdateProgress("Erstelle neue Instanz...");
    
    try {
      const newId = `inst_${Date.now()}`;
      const newInst: Instance = {
        id: newId,
        name: `${localInst.name} (${versionData.mcVersion})`,
        minecraftVersion: versionData.mcVersion,
        modloader: versionData.loader === "fabric" ? "Fabric" : versionData.loader === "forge" ? "Forge" : versionData.loader === "neoforge" ? "Neoforge" : "Fabric",
        modloaderVersion: "",
        lastPlayed: lang === "de" ? "Gerade eben" : "Just now",
        size: "Installiere...",
        modCount: 0,
        thumbnail: localInst.thumbnail,
        desc: `${localInst.name} - ${selectedModpackVersion}`,
        javaVersion: "Automatisch",
        installedMods: [],
        content: [],
        ram: localInst.ram || 6144,
        isModpack: true,
        modpackProjectId: localInst.modpackProjectId,
        modpackSource: localInst.modpackSource,
        modpackVersion: selectedModpackVersion,
      };
      
      setInstances(prev => [newInst, ...prev]);
      
      const folderName = newInst.name.toLowerCase().replace(/\s+/g, '-');
      const result = await window.electronAPI?.installModpackMrpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
      });
      
      if (result?.success) {
        setInstances(prev => prev.map(i =>
          i.id === newId ? { ...i, modCount: result.modCount || 0, size: `${result.modCount || 0} Mods` } : i
        ));
        addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackNewInstanceCreated : translations.en.modpackNewInstanceCreated });
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Fehler beim Erstellen der neuen Instanz' });
    } finally {
      setModpackUpdateInstalling(false);
      setModpackUpdateProgress("");
      setShowModpackUpdateModal(false);
      setShowModpackUpdateOptions(false);
      setModpackUpdateAvailable(false);
    }
  };

  const handleModpackCleanUpdate = async () => {
    if (!selectedModpackVersion) return;
    const versionData = modpackVersions.find(v => v.version_number === selectedModpackVersion);
    if (!versionData) return;
    
    setModpackUpdateInstalling(true);
    setModpackUpdateProgress("Installiere neues Modpack...");
    
    try {
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      
      // First, save current configs (worlds, options.txt)
      setModpackUpdateProgress("Sichere Welten & Konfiguration...");
      
      // Install the new modpack version (keeps existing saves & config)
      const result = await window.electronAPI?.installModpackMrpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
      });
      
      if (result?.success) {
        setInstances(prev => prev.map(i =>
          i.id === localInst.id ? {
            ...i,
            minecraftVersion: versionData.mcVersion,
            modloader: versionData.loader === "fabric" ? "Fabric" : versionData.loader === "forge" ? "Forge" : versionData.loader === "neoforge" ? "Neoforge" : "Fabric",
            modCount: result.modCount || 0,
            size: `${result.modCount || 0} Mods`,
            installedMods: [],
            content: [],
            modpackVersion: selectedModpackVersion,
          } : i
        ));
        addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackUpdatedClean : translations.en.modpackUpdatedClean });
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Fehler beim Update' });
    } finally {
      setModpackUpdateInstalling(false);
      setModpackUpdateProgress("");
      setShowModpackUpdateModal(false);
      setShowModpackUpdateOptions(false);
      setModpackUpdateAvailable(false);
    }
  };

  const handleModpackBetaCarryOver = async () => {
    if (!selectedModpackVersion) return;
    const versionData = modpackVersions.find(v => v.version_number === selectedModpackVersion);
    if (!versionData) return;
    
    setModpackUpdateInstalling(true);
    setModpackUpdateProgress("Übernehme eigene Mods (BETA)...");
    
    try {
      const folderName = localInst.name.toLowerCase().replace(/\s+/g, '-');
      const currentMods = (localInst.content || []).filter(c => c.type === 'mods' && c.projectId);
      
      // Save current own mod project IDs before update
      const ownModIds = currentMods.map(m => m.projectId).filter(Boolean);
      
      // Install new modpack version (keeps existing saves & config)
      const result = await window.electronAPI?.installModpackMrpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
      });
      
      if (result?.success) {
        setModpackUpdateProgress("Suche kompatible Versionen für eigene Mods...");
        
        // Try to re-install own mods with new MC version
        const newContent: ContentItem[] = [];
        for (const projectId of ownModIds) {
          try {
            // Fetch versions for this mod
            const modRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
              headers: { 'User-Agent': 'BambooLauncher/0.1.0' }
            });
            if (!modRes.ok) continue;
            const modVersions = await modRes.json();
            
            // Find version compatible with new MC version
            const compatible = modVersions.find((v: any) =>
              v.game_versions?.includes(versionData.mcVersion) && v.files?.length > 0
            );
            if (!compatible) continue;
            
            // Download the mod
            const dlResult = await window.electronAPI?.downloadMod?.({
              folderName,
              profileName: localInst.name,
              versionId: versionData.mcVersion,
              downloadUrl: compatible.files[0].url,
              filename: compatible.files[0].filename,
              itemType: 'mods',
            });
            
            if (dlResult?.success) {
              const originalMod = currentMods.find(m => m.projectId === projectId);
              newContent.push({
                id: originalMod?.id || projectId,
                name: originalMod?.name || projectId,
                fileName: compatible.files[0].filename,
                version: versionData.mcVersion,
                type: 'mods',
                enabled: true,
                locked: false,
                iconUrl: originalMod?.iconUrl,
                versionNumber: compatible.version_number,
                projectId: projectId,
                source: 'modrinth',
              });
            }
          } catch { console.warn('[Instances] Failed to fetch mod version'); }
        }
        
        setInstances(prev => prev.map(i =>
          i.id === localInst.id ? {
            ...i,
            minecraftVersion: versionData.mcVersion,
            modloader: versionData.loader === "fabric" ? "Fabric" : versionData.loader === "forge" ? "Forge" : versionData.loader === "neoforge" ? "Neoforge" : "Fabric",
            modCount: (result.modCount || 0) + newContent.length,
            size: `${(result.modCount || 0) + newContent.length} Mods`,
            installedMods: [],
            content: newContent,
            modpackVersion: selectedModpackVersion,
          } : i
        ));
        
        addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackBetaComplete : translations.en.modpackBetaComplete });
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Fehler beim Beta-Update' });
    } finally {
      setModpackUpdateInstalling(false);
      setModpackUpdateProgress("");
      setShowModpackUpdateModal(false);
      setShowModpackUpdateOptions(false);
      setModpackUpdateAvailable(false);
    }
  };

  const tabLabels: Record<string, string> = {
    mods: "Mods",
    resourcepacks: "Resource Packs",
    shader: "Shader",
    worlds: "Welten",
    datapacks: "Data Packs",
  };

  const tabIcons: Record<string, React.ReactNode> = {
    mods: <Package className="w-4 h-4" />,
    resourcepacks: <Image className="w-4 h-4" />,
    shader: <Shirt className="w-4 h-4" />,
    worlds: <Globe className="w-4 h-4" />,
    datapacks: <Layers className="w-4 h-4" />,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Issue 10: Modpack update banner */}
      {localInst.isModpack && modpackUpdateAvailable && modpackVersions.length > 0 && (
        <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-bold text-amber-300">
                {lang === 'de' ? translations.de.modpackUpdateAvailable : translations.en.modpackUpdateAvailable}
              </p>
              <p className="text-[10px] text-amber-400/70 mt-0.5">
                {modpackVersions[0].version_number} ({lang === 'de' ? 'Neueste' : 'Latest'})
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowModpackUpdateModal(true)}
            className="bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2 rounded-xl text-[10px] font-black tracking-wide shadow-lg shadow-amber-500/10 transition-all cursor-pointer shrink-0"
          >
            {modpackCheckingUpdates ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin inline mr-1" /> Check... </>
            ) : (
              <><ArrowUp className="w-3.5 h-3.5 inline mr-1" />{lang === 'de' ? translations.de.modpackUpdateAction : translations.en.modpackUpdateAction}</>
            )}
          </button>
        </div>
      )}

      {/* Modpack update installing progress */}
      {modpackUpdateInstalling && (
        <div className="bg-sky-500/10 border border-sky-500/20 rounded-2xl p-4 flex items-center gap-3">
          <RefreshCw className="w-5 h-5 text-sky-400 animate-spin shrink-0" />
          <p className="text-xs font-bold text-sky-300">{modpackUpdateProgress}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-200">
          {tabLabels[detailTab] || detailTab} ({contentItems.length})
        </h3>
        <div className="flex items-center gap-2">
          {/* Issue 6: Manual 'Check for Updates' button */}
          <button
            onClick={checkContentUpdates}
            disabled={checkingUpdates}
            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50 ${
              checkingUpdates
                ? "theme-bg-light theme-text theme-border-light"
                : "theme-bg-light hover:theme-bg-md theme-text theme-border-light"
            }`}
            title={lang === "de" ? "Paket neu laden" : "Reload Package"}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdates ? 'animate-spin' : ''}`} />
            {checkingUpdates ? (lang === 'de' ? 'Lade...' : 'Loading...') : (lang === 'de' ? 'Paket neu laden' : 'Reload Package')}
          </button>
          {hasUpdates && (
            <button
              onClick={handleUpdateAll}
              className="theme-bg hover:theme-bg-hover text-slate-950 px-4 py-2 rounded-xl text-[10px] font-black tracking-wide flex items-center gap-1.5 cursor-pointer theme-shadow-lg"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Update All
            </button>
          )}
          {/* Issue 24: Upload local mod/resourcepack/shader button */}
          <button
            onClick={handleUploadLocalMod}
            disabled={uploadingFile}
            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50 ${
              uploadingFile
                ? "theme-bg-light theme-text theme-border-light"
                : "theme-bg-light hover:theme-bg-md theme-text theme-border-light"
            }`}
            title="Eigene Datei hochladen"
          >
            <Upload className={`w-3.5 h-3.5 ${uploadingFile ? 'animate-pulse' : ''}`} />
            {uploadingFile ? `${uploadProgress}%` : 'Hochladen'}
          </button>
          {/* Issue 10: Modpack special treatment - only show Add Mods if ownContentManagement enabled */}
          {(localInst.isModpack && detailTab === "mods" && !localInst.ownContentManagement) ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-xl font-bold">
                <AlertTriangle className="w-3 h-3 inline mr-1" />
                {(lang === 'de' ? translations.de.ownContentManagementDisabled : translations.en.ownContentManagementDisabled)}
              </span>
            </div>
          ) : (
            <button
              onClick={() => { openModBrowserForInstance(localInst.id); setSelectedInstance(null); }}
              className="theme-bg hover:theme-bg-hover text-slate-950 px-5 py-2.5 rounded-xl text-xs font-black tracking-wide flex items-center gap-2 cursor-pointer theme-shadow-lg"
            >
              <Download className="w-4 h-4" />
              {detailTab === "mods" ? "Mods hinzufügen" : "Inhalt hinzufügen"}
            </button>
          )}
        </div>
      </div>      {detailTab === "worlds" && (
        <button
          onClick={() => window.electronAPI?.openProfileFolder?.(slug)}
          className="mt-4 w-full theme-bg-light theme-text theme-border-light border rounded-xl py-2.5 px-4 text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          {lang === "de" ? "Welt-Ordner öffnen" : "Open World Folder"}
        </button>
      )}

      {contentItems.length === 0 ? (
        <div className="py-16 text-center flex flex-col items-center gap-3 bg-slate-950/20 border border-slate-800/40 rounded-3xl">
          <div className="w-14 h-14 text-slate-600">{tabIcons[detailTab]}</div>
          <p className="text-sm text-slate-400 font-bold">Keine {tabLabels[detailTab]} installiert</p>
          <p className="text-xs text-slate-500">Klicke auf "Inhalt hinzufügen", um {tabLabels[detailTab]} zu durchsuchen.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {contentItems.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedContentItem(item)}
              className={`bg-slate-950/40 border rounded-2xl p-4 flex items-center gap-4 transition-all cursor-pointer ${
                item.enabled ? "border-slate-800/60 hover:border-slate-700 hover:bg-slate-950/60" : "border-slate-800/30 opacity-60"
              }`}
            >
              <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
                {item.iconUrl ? (
                  <img src={item.iconUrl} alt={item.name} className="w-full h-full object-cover"
                       onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : item.type === "mods" ? <Package className="w-5 h-5 text-slate-400" /> :
                   item.type === "resourcepacks" ? <Image className="w-5 h-5 text-slate-400" /> :
                   item.type === "shaderpacks" ? <Shirt className="w-5 h-5 text-slate-400" /> :
                   item.type === "worlds" ? <Globe className="w-5 h-5 text-slate-400" /> :
                   <Layers className="w-5 h-5 text-slate-400" />}
              </div>

              {/* Info: Name (bold), FileName + Version side by side */}
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <span className="text-sm font-black text-slate-100 truncate block leading-tight">{item.name}</span>
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-slate-500 font-mono truncate max-w-[200px]">{item.fileName}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400 font-semibold">{item.version}</span>
                </div>
              </div>

              {/* Issue 15 + 19: Change Version Button instead of Lock/Enable/Disable/Delete in list view */}
              <div className="flex items-center justify-center gap-1.5 shrink-0 self-stretch" onClick={(e) => e.stopPropagation()}>
                {item.updateAvailable && !item.locked && (
                  <button
                    onClick={() => handleUpdate(item.id)}
                    className="p-2 rounded-xl theme-bg-light hover:theme-bg-md theme-text transition-all cursor-pointer"
                    title="Update verfügbar"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* Enable/Disable (Eye) */}
                <button
                  onClick={() => handleToggleEnabled(item.id)}
                  className={`p-2 rounded-xl transition-all cursor-pointer ${
                    item.enabled
                      ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400'
                      : 'bg-slate-800/40 hover:bg-slate-700/60 text-slate-500'
                  }`}
                  title={item.enabled ? (lang === 'de' ? 'Deaktivieren' : 'Disable') : (lang === 'de' ? 'Aktivieren' : 'Enable')}
                >
                  {item.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>

                {/* Lock/Unlock */}
                <button
                  onClick={() => handleToggleLocked(item.id)}
                  className={`p-2 rounded-xl transition-all cursor-pointer ${
                    item.locked
                      ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400'
                      : 'bg-slate-800/40 hover:bg-slate-700/60 text-slate-500'
                  }`}
                  title={item.locked ? (lang === 'de' ? 'Entsperren' : 'Unlock') : (lang === 'de' ? 'Sperren' : 'Lock')}
                >
                  {item.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>

                <button
                  onClick={() => handleDeleteContent(item.id)}
                  disabled={item.locked}
                  className="p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Löschen"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Content Detail Modal */}
      <AnimatePresence>
        {selectedContentItem && (
          <ContentDetailModal
            item={selectedContentItem}
            onClose={() => setSelectedContentItem(null)}
            localInst={localInst}
            setInstances={setInstances}
          />
        )}
      </AnimatePresence>

      {/* Issue 10: Modpack Update Modal */}
      <AnimatePresence>
        {showModpackUpdateModal && modpackVersions.length > 0 && !modpackUpdateInstalling && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
            onClick={() => { setShowModpackUpdateModal(false); setShowModpackUpdateOptions(false); setSelectedModpackVersion(""); }}
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
                  <Package className="w-5 h-5 text-amber-400" />
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {lang === 'de' ? translations.de.modpackUpdateAvailable : translations.en.modpackUpdateAvailable}
                  </h3>
                </div>
                <button
                  onClick={() => { setShowModpackUpdateModal(false); setShowModpackUpdateOptions(false); setSelectedModpackVersion(""); }}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-4 text-left">
                {!showModpackUpdateOptions ? (
                  <>
                    <p className="text-xs text-slate-400">
                      {lang === 'de' ? translations.de.modpackSelectVersion : translations.en.modpackSelectVersion}
                    </p>
                    <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                      {modpackVersions.map(ver => (
                        <button
                          key={ver.version_number}
                          onClick={() => {
                            setSelectedModpackVersion(ver.version_number);
                            // If ownContentManagement is enabled, show 3 options
                            if (localInst.ownContentManagement) {
                              setShowModpackUpdateOptions(true);
                            } else {
                              handleModpackCleanUpdate();
                            }
                          }}
                          className={`bg-slate-900/20 hover:bg-slate-900/40 border border-slate-850 hover:border-amber-500/30 px-4 py-3 rounded-xl text-left transition-all ${
                            selectedModpackVersion === ver.version_number ? 'border-amber-500/30 bg-amber-500/5' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-bold text-slate-200">{ver.version_number}</span>
                            <span className="text-[10px] text-slate-500">
                              {new Date(ver.date_published).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US')}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-slate-400 bg-slate-800/60 px-2 py-0.5 rounded">{ver.mcVersion}</span>
                            <span className="text-[10px] text-slate-400 bg-slate-800/60 px-2 py-0.5 rounded">{ver.loader}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-slate-400 mb-1">
                      {lang === 'de' ? 'Update-Optionen für' : 'Update options for'} <strong className="text-slate-200">{selectedModpackVersion}</strong>:
                    </p>
                    <div className="flex flex-col gap-3">
                      {/* Option 1: New Instance */}
                      <button
                        onClick={handleModpackNewInstance}
                        className="bg-slate-900/20 hover:bg-slate-900/40 border border-slate-850 hover:theme-border-md px-4 py-4 rounded-xl text-left transition-all group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl theme-bg-light theme-border-light flex items-center justify-center theme-text shrink-0">
                            <Plus className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <span className="text-sm font-bold text-slate-200 group-hover:theme-text-bright transition-colors block">
                              {lang === 'de' ? translations.de.modpackNewInstance : translations.en.modpackNewInstance}
                            </span>
                            <span className="text-[10px] text-slate-400 mt-1 block leading-relaxed">
                              {lang === 'de' ? translations.de.modpackNewInstanceDesc : translations.en.modpackNewInstanceDesc}
                            </span>
                          </div>
                        </div>
                      </button>

                      {/* Option 2: Clean Update */}
                      <button
                        onClick={handleModpackCleanUpdate}
                        className="bg-slate-900/20 hover:bg-slate-900/40 border border-slate-850 hover:border-sky-500/30 px-4 py-4 rounded-xl text-left transition-all group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
                            <RefreshCw className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <span className="text-sm font-bold text-slate-200 group-hover:text-sky-300 transition-colors block">
                              {lang === 'de' ? translations.de.modpackCleanUpdate : translations.en.modpackCleanUpdate}
                            </span>
                            <span className="text-[10px] text-slate-400 mt-1 block leading-relaxed">
                              {lang === 'de' ? translations.de.modpackCleanUpdateDesc : translations.en.modpackCleanUpdateDesc}
                            </span>
                          </div>
                        </div>
                      </button>

                      {/* Option 3: BETA Carry Over */}
                      <button
                        onClick={handleModpackBetaCarryOver}
                        className="bg-slate-900/20 hover:bg-slate-900/40 border border-slate-850 hover:border-violet-500/30 px-4 py-4 rounded-xl text-left transition-all group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-400 shrink-0">
                            <Zap className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-slate-200 group-hover:text-violet-300 transition-colors">
                                {lang === 'de' ? translations.de.modpackBetaCarryOver : translations.en.modpackBetaCarryOver}
                              </span>
                              <span className="text-[8px] font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded uppercase">BETA</span>
                            </div>
                            <span className="text-[10px] text-slate-400 mt-1 block leading-relaxed">
                              {lang === 'de' ? translations.de.modpackBetaCarryOverDesc : translations.en.modpackBetaCarryOverDesc}
                            </span>
                          </div>
                        </div>
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="p-4 bg-slate-900/40 border-t border-slate-900 flex justify-between items-center">
                <button
                  onClick={() => {
                    if (showModpackUpdateOptions) {
                      setShowModpackUpdateOptions(false);
                    } else {
                      setShowModpackUpdateModal(false);
                      setSelectedModpackVersion("");
                    }
                  }}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                >
                  {showModpackUpdateOptions ? (lang === 'de' ? 'Zurück' : 'Back') : (lang === 'de' ? 'Abbrechen' : 'Cancel')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
