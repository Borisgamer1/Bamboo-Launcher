import React, { useState, useEffect, useRef } from "react";
import { Dialog } from "./Dialog";
import { dialogButton, useLastDefined } from "./dialogSupport";
import {
  Trash2,
  Edit3,
  Plus,
  Search,
  Layers,
  Settings,
  RefreshCw,
  ArrowLeft,
  Package,
  Image,
  Shirt,
  Globe,
  Upload,
  Lock,
  Unlock,
  AlertTriangle,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import {
  categoryForTab,
  categoryToProjectType,
  instanceLoadsMods,
  instanceLoadsShaders,
} from "../lib/contentCategories";
import { mergeKeybinds } from "../lib/keybinds";
import { fetchVersionMap, VersionMap } from "../lib/versionApi";
import { useToast } from "./Toast";
import { ProfileExportModal } from "./ProfileExportModal";
import { ProfileImportModal } from "./ProfileImportModal";
import { InstanceContextMenu } from "./instances/InstanceContextMenu";
import {
  InstanceVersionSwitchModal,
  type InstanceVersionSwitchSummary,
} from "./instances/InstanceVersionSwitchModal";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from "../lib/backgroundTasks";
import { instanceFolderKeyOf as instanceFolderKey, uniqueInstanceFolder } from "../lib/instanceFolders";
import { mapProfileToInstance, type IpcProfile } from "../hooks/useInstances";
import { ContentHeader } from "./ContentHeader";
import { InstanceCard } from "./instances/InstanceCard";
import { InstanceCoverPicker } from "./instances/InstanceCoverPicker";
import { PlayArea } from "./instances/PlayArea";
import { InstanceSettingsView } from "./instance-settings/InstanceSettingsView";
import { type LauncherPreferences } from "../lib/launcherPreferences";
import {
  pickRandomInstanceCover,
  prepareInstanceCover,
  saveUploadedInstanceCover,
} from "../lib/instanceCovers";
import { CrashAnalysisSheet } from "./logs/CrashAnalysisSheet";
import type { InstanceLaunchSettingsPatch, LaunchProgress, LogAnalysisResult } from "../electron";
import {
  analysisFor,
  buildLaunchPatch,
  errorMessage,
  type Instance,
} from "./instances/instanceModel";
import { ContentListView } from "./instances/content-list-view";

// The record lives in the model module; existing importers keep their path.
export type { ContentItem, Instance } from "./instances/instanceModel";

interface RunningInstance {
  name: string;
  folderName: string;
  startedAt: number;
}

type DetailTab = "mods" | "resourcepacks" | "shader" | "worlds" | "datapacks" | "settings";


interface InstancesViewProps {
  setActiveTab: (tab: TabType) => void;
  searchQuery: string;
  setActiveInstance: (name: string) => void;
  lang: LanguageType;
  instances: Instance[];
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  openModBrowserForInstance: (instanceId: string) => void;
  onLaunch?: (instanceId: string) => void;
  runningInstances: RunningInstance[];
  onStopGame: (name: string, folderName?: string) => void;
  launching?: boolean;
  launchingFolder?: string;
  launchProgress?: Record<string, LaunchProgress>;
  hasAccount?: boolean;
  preferences: LauncherPreferences;
  setPreferences: React.Dispatch<React.SetStateAction<LauncherPreferences>>;
  selectedInstanceOverride?: string | null;
  onClearSelectedInstanceOverride?: () => void;
  instancesListToken?: number;
  analyses?: Record<string, LogAnalysisResult>;
  onReanalyze?: (key: string, instanceId: string) => Promise<LogAnalysisResult | null>;
}

export const InstancesView: React.FC<InstancesViewProps> = ({
  setActiveTab,
  searchQuery: initialSearch,
  setActiveInstance,
  lang,
  instances,
  setInstances,
  openModBrowserForInstance,
  onLaunch,
  runningInstances,
  onStopGame,
  launching,
  launchingFolder,
  launchProgress,
  hasAccount,
  preferences,
  selectedInstanceOverride,
  onClearSelectedInstanceOverride,
  instancesListToken,
  analyses,
  onReanalyze,
}) => {
  const t = translations[lang];
  const [search, setSearch] = useState(initialSearch);
  const [filterMode, setFilterMode] = useState<string>("all");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  // The selection carries the list token it was made under, so a navigation
  // request to the list invalidates it without an effect or a remount.
  const listToken = instancesListToken ?? 0;
  const [instanceSelection, setInstanceSelection] = useState<{ id: string; listToken: number } | null>(null);
  const selectedInstanceId = instanceSelection?.listToken === listToken ? instanceSelection.id : null;
  const setSelectedInstanceId = (next: React.SetStateAction<string | null>) => {
    setInstanceSelection((previous) => {
      const previousId = previous?.listToken === listToken ? previous.id : null;
      const id = typeof next === "function" ? next(previousId) : next;
      return id ? { id, listToken } : null;
    });
  };
  const selectedInstance = selectedInstanceId
    ? instances.find((entry) => entry.id === selectedInstanceId) ?? null
    : selectedInstanceOverride
      ? instances.find((entry) => entry.id === selectedInstanceOverride) ?? null
      : null;
  const [analysisTarget, setAnalysisTarget] = useState<Instance | null>(null);
  const [detailTabState, setDetailTabState] = useState<{ instanceId: string; value: DetailTab }>({ instanceId: "", value: "mods" });
  // Worlds are detected on disk, so the tab badge is fed by the Worlds tab itself.
  const [detectedWorldCounts, setDetectedWorldCounts] = useState<Record<string, number>>({});
  const detailTab: DetailTab = selectedInstance && detailTabState.instanceId === selectedInstance.id ? detailTabState.value : "mods";
  const setDetailTab = (value: DetailTab) => setDetailTabState({ instanceId: selectedInstance?.id ?? "", value });
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  useEffect(() => {
    const apply = (intent: string | null) => {
      if (intent === "create") setCreateModalOpen(true);
      else if (intent === "import") setShowImportModal(true);
      else return;
      sessionStorage.removeItem("bamboo-instances-intent");
    };
    apply(sessionStorage.getItem("bamboo-instances-intent"));
    const handler = (event: Event) => apply((event as CustomEvent<string>).detail ?? null);
    window.addEventListener("bamboo-instances-intent", handler);
    return () => window.removeEventListener("bamboo-instances-intent", handler);
  }, []);

  const { addToast } = useToast();

  const launchWriteRef = useRef(
    new Map<string, { timer: number; patch: InstanceLaunchSettingsPatch }>(),
  );
  useEffect(() => () => {
    for (const entry of launchWriteRef.current.values()) window.clearTimeout(entry.timer);
    launchWriteRef.current.clear();
  }, []);

  const queueLaunchSettings = (folderName: string, patch: InstanceLaunchSettingsPatch) => {
    const previous = launchWriteRef.current.get(folderName);
    if (previous) window.clearTimeout(previous.timer);
    const merged = { ...(previous?.patch ?? {}), ...patch };
    const timer = window.setTimeout(() => {
      launchWriteRef.current.delete(folderName);
      const request = window.electronAPI?.instances.updateLaunchSettings?.(folderName, merged);
      request?.catch(() => addToast({
        type: "error",
        message: lang === "de"
          ? "Start-Einstellungen konnten nicht gespeichert werden."
          : "Launch settings could not be saved.",
      }));
    }, 250);
    launchWriteRef.current.set(folderName, { timer, patch: merged });
  };

  const handleInstanceUpdate = (instance: Instance, patch: Partial<Instance>) => {
    setInstances(prev => prev.map(item => item.id === instance.id ? { ...item, ...patch } : item));
    const launchPatch = buildLaunchPatch(instance, patch, preferences.instanceDefaults.window);
    if (launchPatch) queueLaunchSettings(instanceFolderKey(instance), launchPatch);
  };

  const analysisSheet = (
    <CrashAnalysisSheet
      key={analysisTarget ? "open" : "closed"}
      open={!!analysisTarget}
      analysis={analysisTarget ? analysisFor(analyses, analysisTarget) : null}
      instanceName={analysisTarget?.name ?? ""}
      folderName={analysisTarget ? instanceFolderKey(analysisTarget) : ""}
      lang={lang}
      onClose={() => setAnalysisTarget(null)}
      onReanalyze={
        analysisTarget && onReanalyze
          ? async () => {
              const current = analysisFor(analyses, analysisTarget);
              if (!current) return null;
              return onReanalyze(instanceFolderKey(analysisTarget), current.instanceId);
            }
          : undefined
      }
    />
  );

  const [newInstanceName, setNewInstanceName] = useState("");
  const [newInstanceVersion, setNewInstanceVersion] = useState("");
  const [newInstanceModloader, setNewInstanceModloader] = useState<Instance["modloader"]>("Fabric");
const [newInstanceModloaderVersion, setNewInstanceModloaderVersion] = useState("");
  const [newInstanceImage, setNewInstanceImage] = useState(pickRandomInstanceCover);

  const handleSelectImageForExistingInstance = async (instanceId: string) => {
    const result = await window.electronAPI?.dialogs.open?.({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
    });
    if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
      const dataUrl = await window.electronAPI?.dialogs.readImage?.(result.filePaths[0]);
      if (dataUrl) {
        const prepared = await prepareInstanceCover(dataUrl);
        const saved = saveUploadedInstanceCover(prepared);
        setInstances(prev => prev.map(i =>
          i.id === instanceId ? { ...i, thumbnail: saved?.dataUrl ?? prepared } : i,
        ));
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
      : loader === "Quilt" ? versionMap.quilt
      : loader === "Neoforge" ? versionMap.neoforge
      : versionMap.forge;
    return map[mcVer] || [];
  };

  const newInstanceModloaderVersions = getModloaderVersions(newInstanceVersion, newInstanceModloader);
  const effectiveModloaderVersion = newInstanceModloaderVersions.includes(newInstanceModloaderVersion)
    ? newInstanceModloaderVersion
    : (newInstanceModloaderVersions[0] ?? "");

  const handleCreateInstance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInstanceName.trim()) return;

    const defaultRam = preferences.instanceDefaults.ramMb || 4096;
    const defaultJava = preferences.instanceDefaults.javaPath || "Automatisch";

    const finalThumbnail = newInstanceImage;

    const folderName = uniqueInstanceFolder(newInstanceName, instances);
    const newInst: Instance = {
      id: `inst_${Date.now()}`,
      folderName,
      name: newInstanceName,
      minecraftVersion: newInstanceVersion,
      modloader: newInstanceModloader,
      modloaderVersion: newInstanceModloader !== "Vanilla" ? effectiveModloaderVersion : undefined,
      lastPlayed: lang === "de" ? "Gerade eben" : "Just now",
      size: "0 MB",
      modCount: 0,
      desc: lang === "de"
        ? `Eine Minecraft ${newInstanceVersion} Instanz mit ${newInstanceModloader}.`
        : `A Minecraft ${newInstanceVersion} instance with ${newInstanceModloader}.`,
      thumbnail: finalThumbnail,
      javaVersion: defaultJava,
      installedMods: [],
      content: [],
      ram: defaultRam,
      jvmArgs: preferences.instanceDefaults.jvmArgs || "",
      keybinds: {},
      fullscreen: preferences.instanceDefaults.window.fullscreen,
      windowMode: preferences.instanceDefaults.window.mode,
      windowWidth: preferences.instanceDefaults.window.width,
      windowHeight: preferences.instanceDefaults.window.height,
      playTimeMs: 0,
      sessionCount: 0,
      lastPlayedAt: 0,
      createdAt: Date.now(),
    };

    setInstances([newInst, ...instances]);
    setCreateModalOpen(false);
    setNewInstanceName("");
    setNewInstanceVersion(newInstanceVersion);
    setNewInstanceModloader("Fabric");
    setNewInstanceModloaderVersion("");
    setNewInstanceImage(pickRandomInstanceCover());

    const seeded = await window.electronAPI?.instances.create?.({
      folderName,
      options: {
        ...preferences.gameOptions,
        _mcVersion: newInst.minecraftVersion,
        lang: preferences.instanceDefaults.minecraftLanguage,
        fullscreen: newInst.fullscreen,
        keyBindings: mergeKeybinds(preferences.keybinds, newInst.keybinds),
      },
    });
    if (seeded && !seeded.success) {
      addToast({ type: 'error', message: t.instanceOptionsFailed });
    } else if (seeded?.folderName && seeded.folderName !== folderName) {
      // The main process is the final authority on folder collisions.
      setInstances(prev => prev.map(item =>
        item.id === newInst.id ? { ...item, folderName: seeded.folderName } : item,
      ));
    }
  };

  const [deleteConfirmModal, setDeleteConfirmModal] = useState<Instance | null>(null);
  const [renameModal, setRenameModal] = useState<Instance | null>(null);
  const deleteShown = useLastDefined(deleteConfirmModal);
  const renameShown = useLastDefined(renameModal);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const [renameName, setRenameName] = useState('');

  const handleDeleteInstance = (id: string) => {
    const inst = instances.find(i => i.id === id);
    if (inst) {
      setDeleteConfirmModal(inst);
    }
  };

  const handleRenameInstance = async () => {
    if (!renameModal || !renameName.trim()) return;
    const folderName = instanceFolderKey(renameModal);
    try {
      const result = await window.electronAPI?.instances.rename?.({ oldFolderName: folderName, newName: renameName.trim() });
      if (result?.success) {
        setInstances(prev => prev.map(i =>
          i.id === renameModal.id ? { ...i, name: renameName.trim(), folderName: result.newFolderName } : i
        ));
        setRenameModal(null);
        setRenameName('');
        addToast({ type: 'success', message: lang === 'de' ? 'Instanz umbenannt' : 'Instance renamed' });
      } else {
        addToast({ type: 'error', message: result?.error || 'Rename failed' });
      }
    } catch (e) {
      addToast({ type: 'error', message: errorMessage(e) || 'Rename failed' });
    }
  };

  const deleteInstanceNow = async (instance: Instance) => {
    const folderName = instanceFolderKey(instance);
    let failure: string | null = null;
    try {
      const result = await window.electronAPI?.instances.deleteFiles?.(folderName);
      if (result && result.success === false) failure = result.error || 'unbekannt';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure) {
      // The folder is still there; removing the card would hide that.
      setDeleteConfirmModal(null);
      addToast({
        type: 'error',
        message: lang === 'de'
          ? `"${instance.name}" konnte nicht gelöscht werden: ${failure}`
          : `"${instance.name}" could not be deleted: ${failure}`,
      });
      return;
    }
    setInstances(prev => prev.filter(i => i.id !== instance.id));
    setSelectedInstanceId(prev => (prev === instance.id ? null : prev));
    setDeleteConfirmModal(null);
    addToast({
      type: 'success',
      message: lang === 'de' ? `"${instance.name}" wurde gelöscht` : `"${instance.name}" was deleted`,
    });
  };

  const confirmDeleteInstance = async () => {
    if (!deleteConfirmModal) return;
    await deleteInstanceNow(deleteConfirmModal);
  };

  // The context menu opens this from the instance grid, so the dialog cannot
  // live inside the detail-view branch.
  const deleteDialog = (
    <Dialog
      open={!!deleteConfirmModal}
      onClose={() => setDeleteConfirmModal(null)}
      returnFocusFallback={() => createTriggerRef.current}
      title={deleteShown ? (lang === "de" ? `"${deleteShown.name}" löschen?` : `Delete "${deleteShown.name}"?`) : ""}
      titleId="delete-dialog-title"
      closeLabel={lang === "de" ? "Schließen" : "Close"}
      icon={<Trash2 className="h-4 w-4" />}
      tone="danger"
      footer={
        <>
          <button data-autofocus onClick={() => setDeleteConfirmModal(null)} className={dialogButton.secondary}>
            {lang === "de" ? "Abbrechen" : "Cancel"}
          </button>
          <button onClick={confirmDeleteInstance} className={dialogButton.danger}>
            {lang === "de" ? "Ja, alles löschen" : "Yes, delete all"}
          </button>
        </>
      }
    >
      <p>
        {lang === "de"
          ? "Diese Aktion löscht die Instanz, alle Mods, Welten, Screenshots und den gesamten Instanzordner unwiderruflich."
          : "This will permanently delete the instance, all mods, worlds, screenshots and the entire instance folder."}
      </p>
    </Dialog>
  );

  const handleRepairInstance = async (instance: Instance) => {
    const folderName = instanceFolderKey(instance);
    const taskId = `repair:${folderName}`;
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de' ? `${instance.name} wird repariert…` : `Repairing ${instance.name}…`,
      detail: lang === 'de' ? 'Version und Loader werden geprüft' : 'Checking version and loader',
      percent: 2,
    });
    try {
      await window.electronAPI?.instances.repair?.({
        loader: instance.modloader.toLowerCase(),
        loaderVersion: instance.modloaderVersion || '',
        mcVersion: instance.minecraftVersion,
        folderName,
      });
      completeBackgroundTask(taskId);
      addToast({
        type: 'success',
        message: lang === 'de' ? 'Installation repariert' : 'Installation repaired',
      });
    } catch (error) {
      failBackgroundTask(taskId, errorMessage(error));
      addToast({
        type: 'error',
        message: errorMessage(error) || (lang === 'de' ? 'Reparatur fehlgeschlagen' : 'Repair failed'),
      });
    }
  };

  const handleCloneInstance = async (instance: Instance) => {
    const taskId = newBackgroundTaskId(`clone:${instanceFolderKey(instance)}`);
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de' ? `${instance.name} wird geklont…` : `Cloning ${instance.name}…`,
      detail: lang === 'de' ? 'Ordner und Einstellungen werden kopiert' : 'Copying folder and settings',
      percent: null,
    });
    try {
      const result = await window.electronAPI?.instances.clone?.({
        folderName: instanceFolderKey(instance),
      });
      if (!result?.success || !result.profile) {
        const message = result?.error || (lang === 'de' ? 'Klonen fehlgeschlagen' : 'Clone failed');
        failBackgroundTask(taskId, message);
        addToast({ type: 'error', message });
        return;
      }
      const cloned = mapProfileToInstance(result.profile as IpcProfile, instances.length);
      setInstances(prev => [{ ...cloned }, ...prev]);
      completeBackgroundTask(taskId);
      addToast({
        type: 'success',
        message: lang === 'de' ? `"${instance.name}" wurde geklont` : `"${instance.name}" was cloned`,
      });
    } catch (error) {
      failBackgroundTask(taskId, errorMessage(error));
      addToast({ type: 'error', message: errorMessage(error) });
    }
  };

  const handleCreateShortcut = async (instance: Instance) => {
    try {
      const result = await window.electronAPI?.instances.createShortcut?.({
        folderName: instanceFolderKey(instance),
        instanceName: instance.name,
      });
      if (result?.success) {
        addToast({
          type: 'success',
          message: lang === 'de' ? 'Desktop-Verknüpfung erstellt' : 'Desktop shortcut created',
        });
      } else {
        addToast({
          type: 'error',
          message: result?.error || (lang === 'de' ? 'Verknüpfung fehlgeschlagen' : 'Shortcut failed'),
        });
      }
    } catch (error) {
      addToast({ type: 'error', message: errorMessage(error) });
    }
  };

  const [contextMenu, setContextMenu] = useState<{ instance: Instance; x: number; y: number } | null>(null);
  const [versionSwitchTarget, setVersionSwitchTarget] = useState<Instance | null>(null);

  const handleVersionSwitchApplied = (instanceId: string, summary: InstanceVersionSwitchSummary) => {
    setInstances(prev => prev.map(item =>
      item.id === instanceId ? { ...item, ...summary } : item,
    ));
  };

  const versionSwitchModal = versionSwitchTarget ? (
    <InstanceVersionSwitchModal
      open
      instance={versionSwitchTarget}
      versionMap={versionMap}
      versionsLoading={loadingVersions}
      lang={lang}
      onClose={() => setVersionSwitchTarget(null)}
      onApplied={handleVersionSwitchApplied}
    />
  ) : null;

  const handleLaunchInstance = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveInstance(instances.find(i => i.id === id)?.name || "");
    onLaunch?.(id);
  };

  const filteredInstances = instances.filter(i => {
    const matchesSearch = i.name.toLowerCase().includes(search.toLowerCase()) || i.desc.toLowerCase().includes(search.toLowerCase());
    const matchesMode = filterMode === "all" || i.modloader === filterMode;
    return matchesSearch && matchesMode;
  });

  const isRunning = (folderName: string) =>
    runningInstances.some((ri) => ri.folderName === folderName);

  if (selectedInstance) {
    const inst = instances.find(i => i.id === selectedInstance.id) || selectedInstance;
    const running = isRunning(instanceFolderKey(inst));
    return (
      <DetailViewBoundary lang={lang}>
      <div className="flex-1 h-full flex flex-col overflow-hidden p-0">
        <div className="relative h-48 shrink-0 bg-black border-b border-hairline overflow-hidden">
          {inst.thumbnail && (
            <img
              src={inst.thumbnail}
              alt={inst.name}
              className="w-full h-full object-cover opacity-40"
              onError={(event) => { (event.target as HTMLImageElement).style.display = "none"; }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-root via-root/60 to-transparent" />

          <div className="absolute inset-0 p-6 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <button
                onClick={() => {
                  setSelectedInstanceId(null);
                  onClearSelectedInstanceOverride?.();
                }}
                className="p-2 rounded-xl bg-root/60 hover:bg-hover border border-stroke/80 text-ink-secondary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-end gap-5">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-stroke/80 shadow-2xl shrink-0 bg-black">
                {inst.thumbnail && (
                  <img
                    src={inst.thumbnail}
                    alt={inst.name}
                    className="w-full h-full object-cover"
                    onError={(event) => { (event.target as HTMLImageElement).style.display = "none"; }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-title2 font-semibold text-ink drop-shadow-lg">{inst.name}</h1>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-small font-medium theme-text theme-bg-light theme-border-md px-2.5 py-0.5 rounded-lg">{inst.minecraftVersion}</span>
                  <span className="text-small font-medium text-info bg-info/15 border border-info/25 px-2.5 py-0.5 rounded-lg">{inst.modloader}{inst.modloaderVersion ? ` ${inst.modloaderVersion}` : ""}</span>
                  <span className="text-small text-ink-secondary">
                    {inst.modloader === "Vanilla" && inst.size}
                    {inst.modloader !== "Vanilla" && (inst.content?.length ? `${inst.content.length} ${t.contentCountUnit}` : inst.size)}
                  </span>
                </div>
              </div>

              <div className="ml-auto shrink-0 pb-0.5">
                <PlayArea
                  running={running}
                  launching={!!launching && launchingFolder === instanceFolderKey(inst)}
                  progress={launchProgress?.[instanceFolderKey(inst)]}
                  hasAccount={!!hasAccount}
                  onPlay={() => handleLaunchInstance(inst.id, { stopPropagation() {} } as React.MouseEvent)}
                  onStop={() => onStopGame(inst.name, inst.folderName)}
                  lang={lang}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 px-6 bg-root/30 border-b border-hairline shrink-0 overflow-x-auto custom-scrollbar">
          {[
            { id: "mods" as const, label: "Mods", icon: Package, count: (inst.content || []).filter(c => c.type === "mods").length },
            { id: "resourcepacks" as const, label: "Resource Packs", icon: Image, count: (inst.content || []).filter(c => c.type === "resourcepacks").length },
            { id: "shader" as const, label: t.shader, icon: Shirt, count: (inst.content || []).filter(c => c.type === "shaderpacks").length },
            { id: "worlds" as const, label: t.worlds, icon: Globe, count: detectedWorldCounts[inst.id] ?? (inst.content || []).filter(c => c.type === "worlds").length },
            { id: "datapacks" as const, label: "Data Packs", icon: Layers, count: (inst.content || []).filter(c => c.type === "datapacks").length },
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setDetailTab(tab.id)}
                className={`px-4 py-3 text-small font-medium flex items-center gap-2 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border-b-2 ${
                  detailTab === tab.id
                    ? "text-accent border-accent bg-accent/5"
                    : "text-ink-secondary hover:text-ink border-transparent hover:border-rim"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
                <span className="text-micro font-medium bg-raised text-ink px-1.5 py-0.5 rounded-full">{tab.count}</span>
              </button>
            );
          })}

          <div className="flex-1" />

          {inst.isModpack && (
            <button
              onClick={() => setDetailTab("mods")}
              className={`shrink-0 px-3 py-3 text-small font-medium flex items-center gap-2 transition-colors cursor-pointer border-b-2 border-transparent ${
                inst.ownContentManagement ? "text-success hover:text-success" : "text-ink-secondary hover:text-ink"
              }`}
              title={lang === "de" ? "Eigene Mods und Datapacks verwalten" : "Manage custom mods and data packs"}
            >
              {inst.ownContentManagement ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
              {lang === "de" ? "Eigene Mods" : "Custom mods"}
            </button>
          )}

          <button
            onClick={() => setDetailTab("settings")}
            className={`px-4 py-3 text-small font-medium flex items-center gap-2 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer border-b-2 ${
              detailTab === "settings"
                ? "theme-text theme-border theme-bg-subtle"
                : "text-ink-secondary hover:text-ink border-transparent hover:border-rim"
            }`}
          >
            <Settings className="w-4 h-4" />
            {t.tabSettings}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {((detailTab === "mods" && !instanceLoadsMods(inst.modloader)) ||
            (detailTab === "shader" && !instanceLoadsShaders(inst.modloader))) && (
            <div className="bg-warning/10 border border-warning/20 rounded-2xl p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
              <p className="text-small font-medium text-warning">
                {detailTab === "shader" ? t.vanillaNoShaderNotice : t.vanillaNoLoaderNotice}
              </p>
            </div>
          )}

          {["mods", "resourcepacks", "shader", "worlds", "datapacks"].includes(detailTab) && (
            <DetailViewBoundary key={detailTab} lang={lang}>
              <ContentListView
                key={`${inst.id}:${inst.minecraftVersion}:${inst.modloader}:${inst.modloaderVersion || ""}`}
                inst={inst}
                instances={instances}
                detailTab={detailTab}
                lang={lang}
                openModBrowserForInstance={(id) => {
                  setSelectedInstanceId(null);
                  sessionStorage.setItem('bamboo-project-type', categoryToProjectType(categoryForTab(detailTab)));
                  sessionStorage.setItem('bamboo-project-source', detailTab === 'worlds' ? 'curseforge' : 'modrinth');
                  openModBrowserForInstance(id);
                }}
                setInstances={setInstances}
                setSelectedInstance={(next) => setSelectedInstanceId(next?.id ?? null)}
                onWorldsDetected={(count) =>
                  setDetectedWorldCounts(prev => (prev[inst.id] === count ? prev : { ...prev, [inst.id]: count }))
                }
              />
            </DetailViewBoundary>
          )}

          {detailTab === "settings" && (
            <InstanceSettingsView
              instance={inst}
              lang={lang}
              preferences={preferences}
              onUpdate={(patch) => handleInstanceUpdate(inst, patch)}
              onRequestRename={() => { setRenameModal(inst); setRenameName(inst.name); }}
              onRequestDelete={() => handleDeleteInstance(inst.id)}
              onRequestImage={() => handleSelectImageForExistingInstance(inst.id)}
              onExport={() => setShowExportModal(true)}
              onOpenFolder={() => window.electronAPI?.instances.openFolder?.(inst.folderName || inst.name.toLowerCase().replace(/\s+/g, "-"))}
              onRepair={() => void handleRepairInstance(inst)}
              onChangeVersion={() => setVersionSwitchTarget(inst)}
            />
          )}
        </div>

        {selectedInstance && (
          <ProfileExportModal
            key={showExportModal ? "profile-export-open" : "profile-export-closed"}
            isOpen={showExportModal}
            onClose={() => setShowExportModal(false)}
            instance={selectedInstance}
            lang={lang}
          />
        )}

        {deleteDialog}

        <Dialog
          open={!!renameModal}
          onClose={() => { setRenameModal(null); setRenameName(""); }}
          title={renameShown ? (lang === "de" ? `"${renameShown.name}" umbenennen` : `Rename "${renameShown.name}"`) : ""}
          titleId="rename-dialog-title"
          closeLabel={lang === "de" ? "Schließen" : "Close"}
          icon={<Edit3 className="h-4 w-4" />}
          tone="accent"
          footer={
            <>
              <button onClick={() => { setRenameModal(null); setRenameName(""); }} className={dialogButton.secondary}>
                {lang === "de" ? "Abbrechen" : "Cancel"}
              </button>
              <button onClick={handleRenameInstance} disabled={!renameName.trim()} className={dialogButton.accent}>
                {lang === "de" ? "Umbenennen" : "Rename"}
              </button>
            </>
          }
        >
          <p className="mb-3">
            {lang === "de" ? "Gib einen neuen Namen für die Instanz ein." : "Enter a new name for the instance."}
          </p>
          <input
            data-autofocus
            type="text"
            value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRenameInstance(); }}
            className="w-full bg-surface border border-stroke-strong rounded-xl px-4 py-2.5 text-regular text-ink font-medium outline-none focus:border-accent/50 transition-colors"
            placeholder={lang === "de" ? "Neuer Name..." : "New name..."}
          />
        </Dialog>

        {analysisSheet}
        {versionSwitchModal}
      </div>
      </DetailViewBoundary>
    );
  }

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden z-10 relative select-none">
      <ContentHeader
        title={t.launcherInstances}
        actions={
          <>
            <button
              onClick={() => setShowImportModal(true)}
              className="h-8 px-3 rounded-lg border border-rim bg-hover text-small font-medium text-ink hover:bg-selected transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {lang === "de" ? "Importieren" : "Import"}
            </button>
            <button
              ref={createTriggerRef}
              data-tour="instance-create"
              onClick={() => setCreateModalOpen(true)}
              className="h-8 px-3 rounded-lg bg-accent text-small font-medium text-accent-contrast hover:bg-accent-hover transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              {t.createInstance}
            </button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 custom-scrollbar">

      <div className="flex flex-col md:flex-row items-center justify-between gap-4 bg-surface/20 border border-stroke p-4 rounded-2xl">
        <div className="w-full md:w-80 relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.searchInstances}
            className="w-full bg-root/40 border border-stroke focus:theme-border rounded-xl py-2 pl-10 pr-4 text-small text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto">
          <button
            onClick={() => setFilterMode("all")}
            className={`px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer whitespace-nowrap ${
              filterMode === "all"
                ? "theme-bg-light theme-text theme-border-light"                      : "bg-surface/40 text-ink-secondary border border-hairline hover:text-ink hover:border-rim"
            }`}
          >
            {lang === "de" ? "Alle" : t.allInstances}
          </button>
          {["Vanilla", "Fabric", "Quilt", "Neoforge", "Forge"].map(loader => (
            <button
              key={loader}
              onClick={() => setFilterMode(loader)}
              className={`px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer whitespace-nowrap ${
                filterMode === loader
                  ? "theme-bg-light theme-text theme-border-light"
                  : "bg-surface/40 text-ink-secondary border border-hairline hover:text-ink hover:border-rim"
              }`}
            >
              {loader}
            </button>
          ))}
        </div>
      </div>

      {!hasAccount && filteredInstances.length > 0 && (
        <div
          id="instances-account-notice"
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-warning/35 bg-surface p-4 sm:flex-row sm:items-center"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-small font-medium text-ink">{t.noAccountSelected}</p>
            <p className="m-0 mt-0.5 text-mini text-ink-secondary">
              {lang === "de"
                ? "Ein Konto genügt für alle Instanzen – melde dich in den Einstellungen unter „Konto“ an."
                : "One account covers every instance – sign in under “Accounts” in Settings."}
            </p>
          </div>
          <button
            onClick={() => {
              requestSettingsTarget("accounts");
              setActiveTab("settings");
            }}
            className="h-8 shrink-0 rounded-lg border border-rim bg-hover px-3 text-small font-medium text-ink transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-selected cursor-pointer"
          >
            {lang === "de" ? "Zum Konto" : "Open accounts"}
          </button>
        </div>
      )}

      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
        onKeyDown={(event) => {
          if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
          const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-instance-card]"));
          const index = cards.indexOf(document.activeElement as HTMLElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "ArrowRight" || event.key === "ArrowDown"
            ? Math.min(index + 1, cards.length - 1)
            : Math.max(index - 1, 0);
          cards[next]?.focus();
        }}
      >
        {filteredInstances.map((inst, index) => (
          <InstanceCard
            key={inst.id}
            instance={inst}
            running={runningInstances.some((ri) => ri.folderName === instanceFolderKey(inst))}
            launching={!!launching && launchingFolder === instanceFolderKey(inst)}
            progress={launchProgress?.[instanceFolderKey(inst)]}
            analysis={analysisFor(analyses, inst)}
            tabIndex={index === 0 ? 0 : -1}
            onOpen={() => setSelectedInstanceId(inst.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ instance: inst, x: event.clientX, y: event.clientY });
            }}
            onOpenAnalysis={() => setAnalysisTarget(inst)}
            onLaunch={(event) => handleLaunchInstance(inst.id, event)}
            onStop={() => onStopGame(inst.name, inst.folderName)}
            onRetry={() => handleLaunchInstance(inst.id, { stopPropagation() {} } as React.MouseEvent)}
            showPlaytime={preferences.behavior.showPlaytime}
            hasAccount={!!hasAccount}
            lang={lang}
          />
        ))}
      </div>

      {analysisSheet}
      {deleteDialog}
      {versionSwitchModal}

      <InstanceContextMenu
        key={contextMenu ? `${contextMenu.instance.id}:${contextMenu.x}:${contextMenu.y}` : "closed"}
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        instance={contextMenu?.instance ?? null}
        lang={lang}
        onClose={() => setContextMenu(null)}
        onDelete={(instance) => {
          setContextMenu(null);
          if (preferences.behavior.confirmDelete) handleDeleteInstance(instance.id);
          else void deleteInstanceNow(instance);
        }}
        onOpenFolder={(instance) => {
          setContextMenu(null);
          void window.electronAPI?.instances.openFolder?.(instanceFolderKey(instance));
        }}
        onRepair={(instance) => {
          setContextMenu(null);
          void handleRepairInstance(instance);
        }}
        onChangeVersion={(instance) => {
          setContextMenu(null);
          setVersionSwitchTarget(instance);
        }}
        onClone={(instance) => {
          setContextMenu(null);
          void handleCloneInstance(instance);
        }}
        onAddContent={(instance) => {
          setContextMenu(null);
          openModBrowserForInstance(instance.id);
        }}
        onChangeImage={(instance) => {
          setContextMenu(null);
          void handleSelectImageForExistingInstance(instance.id);
        }}
        onInstanceOptions={(instance) => {
          setContextMenu(null);
          setSelectedInstanceId(instance.id);
          setDetailTabState({ instanceId: instance.id, value: "settings" });
        }}
        onExport={(instance) => {
          setContextMenu(null);
          setSelectedInstanceId(instance.id);
          setShowExportModal(true);
        }}
        onCreateShortcut={(instance) => {
          setContextMenu(null);
          void handleCreateShortcut(instance);
        }}
      />

      {instances.length === 0 && (
        <div className="py-24 text-center flex flex-col items-center justify-center gap-4">
          <div className="w-20 h-20 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary shadow-2xl">
            <Layers className="w-10 h-10" />
          </div>
          <div>
            <p className="text-large font-semibold text-ink">{t.noInstancesTitle}</p>
            <p className="text-small text-ink-tertiary mt-1 max-w-sm mx-auto">{t.noInstancesDesc}</p>
          </div>
          <button
            data-tour="instance-create"
            onClick={() => setCreateModalOpen(true)}
 className="theme-bg hover:theme-bg-hover text-accent-contrast px-5 py-2.5 rounded-xl text-small font-medium theme-shadow-lg cursor-pointer"
          >
            {t.createInstance}
          </button>
        </div>
      )}

      <ProfileImportModal
        key={showImportModal ? "profile-import-open" : "profile-import-closed"}
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        instances={instances}
        setInstances={setInstances}
        lang={lang}
      />

      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title={t.createInstance}
        titleId="create-dialog-title"
        closeLabel={lang === "de" ? "Schließen" : "Close"}
        icon={<Plus className="h-4 w-4" />}
        tone="accent"
        bodyClassName="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 text-small text-ink-secondary"
        footer={
          <>
            <button type="button" onClick={() => setCreateModalOpen(false)} className={dialogButton.secondary}>
              {t.cancel}
            </button>
            <button
              type="submit"
              form="create-instance-form"
              data-tour="instance-create-confirm"
              className={dialogButton.accent}
            >
              {t.create}
            </button>
          </>
        }
      >
        <form id="create-instance-form" onSubmit={handleCreateInstance} className="flex flex-col gap-4 text-left">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="create-instance-name" className="text-micro font-medium text-ink-secondary uppercase tracking-label">
                    {lang === "de" ? "Instanz Name" : "Instance name"}
                  </label>
                  <input
                    id="create-instance-name"
                    data-autofocus
                    type="text"
                    required
                    value={newInstanceName}
                    onChange={(e) => setNewInstanceName(e.target.value)}
                    placeholder={t.instanceNamePlaceholder}
                    className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-4 text-regular text-ink placeholder:text-ink-tertiary outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                  />
                </div>

                {loadingVersions ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <RefreshCw className="w-10 h-10 theme-text animate-spin" />
                    <p className="text-small text-ink-secondary font-medium">{t.loadingVersions}</p>
                  </div>
                ) : minecraftVersions.length === 0 ? (
                  <div className="py-12 text-center flex flex-col items-center gap-3">
                    <p className="text-small text-ink-secondary font-medium">{t.noVersions}</p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Minecraft Version</label>
                      <select
                        value={newInstanceVersion}
                        onChange={(e) => setNewInstanceVersion(e.target.value)}
                        className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                      >
                        {minecraftVersions.map(ver => (
                            <option key={ver} value={ver} className="bg-root">
                              {ver}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Modloader</label>
                      <select
                        value={newInstanceModloader}
                        onChange={(e) => setNewInstanceModloader(e.target.value as Instance["modloader"])}
                        className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                      >
                        <option value="Vanilla" className="bg-root">Vanilla</option>
                        <option value="Fabric" className="bg-root">Fabric</option>
                        <option value="Quilt" className="bg-root">Quilt</option>
                        <option value="Neoforge" className="bg-root">Neoforge</option>
                        <option value="Forge" className="bg-root">Forge</option>
                      </select>
                    </div>

                    {newInstanceModloader !== "Vanilla" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-micro font-medium text-ink-secondary uppercase tracking-label">Modloader Version</label>
                        <select
                          value={effectiveModloaderVersion}
                          onChange={(e) => setNewInstanceModloaderVersion(e.target.value)}
                          className="w-full bg-surface/40 border border-stroke focus:theme-border rounded-xl py-2.5 px-3 text-regular text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]"
                        >
                          {getModloaderVersions(newInstanceVersion, newInstanceModloader).map(v => (
                            <option key={v} value={v} className="bg-root">{v}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <InstanceCoverPicker
                      value={newInstanceImage}
                      onChange={setNewInstanceImage}
                      lang={lang}
                    />

                  </>
                )}
        </form>
      </Dialog>
      </div>
    </div>
  );
};

class DetailViewBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode; lang: LanguageType }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode; lang: LanguageType }) {
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
      const copy = translations[this.props.lang];
      return this.props.fallback || (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-warning mx-auto mb-4" />
            <h3 className="text-large font-semibold text-ink mb-2">{copy.instanceDetailErrorTitle}</h3>
            <p className="text-regular text-ink-secondary mb-4">{copy.instanceDetailErrorBody}</p>
            <button onClick={() => this.setState({ hasError: false })}
              className="px-5 py-2.5 bg-raised hover:bg-selected rounded-xl text-small font-medium text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer">
              {copy.retry}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
