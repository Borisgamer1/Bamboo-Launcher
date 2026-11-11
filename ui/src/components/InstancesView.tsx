import React, { useState, useEffect, useRef } from "react";
import { Dialog } from "./Dialog";
import { dialogButton, useLastDefined } from "./dialogSupport";
import {
  Trash2,
  Edit3,
  Plus,
  Search,
  Layers,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { mainErrorText } from "../lib/mainErrors";
import { requestSettingsTarget } from "../lib/settingsNavigation";
import { mergeKeybinds } from "../lib/keybinds";
import { fetchVersionMap, VersionMap } from "../lib/versionApi";
import { useToast } from "./Toast";
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
import { InstanceDetailView, DetailViewBoundary, type DetailTab } from "./instances/InstanceDetailView";
import { CreateInstanceDialog } from "./instances/CreateInstanceDialog";
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

// The record lives in the model module; existing importers keep their path.
export type { ContentItem, Instance } from "./instances/instanceModel";

interface RunningInstance {
  name: string;
  folderName: string;
  startedAt: number;
}


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
          ? () => onReanalyze(instanceFolderKey(analysisTarget), instanceFolderKey(analysisTarget))
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
    if (!newInstanceName.trim() || !newInstanceVersion) return;

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

    const seeded = await window.electronAPI?.instances.create?.({
      folderName,
      name: newInst.name,
      version: newInst.minecraftVersion,
      loader: newInst.modloader.toLowerCase(),
      loaderVersion: newInst.modloaderVersion || '',
      options: {
        ...preferences.gameOptions,
        _mcVersion: newInst.minecraftVersion,
        lang: preferences.instanceDefaults.minecraftLanguage,
        fullscreen: newInst.fullscreen,
        keyBindings: mergeKeybinds(preferences.keybinds, newInst.keybinds),
      },
    });
    if (!seeded?.success) {
      // Nothing was written; do not leave a card that cannot launch.
      addToast({
        type: 'error',
        message: mainErrorText(seeded, lang, t.instanceOptionsFailed),
      });
      return;
    }
    // The main process is the final authority on folder collisions.
    setInstances(prev => [{ ...newInst, folderName: seeded.folderName ?? folderName }, ...prev]);
    setCreateModalOpen(false);
    setNewInstanceName("");
    setNewInstanceVersion(newInstanceVersion);
    setNewInstanceModloader("Fabric");
    setNewInstanceModloaderVersion("");
    setNewInstanceImage(pickRandomInstanceCover());
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
        addToast({ type: 'error', message: mainErrorText(result, lang, 'Rename failed') });
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
      if (result && result.success === false) {
        failure = mainErrorText(result, lang, lang === 'de' ? 'unbekannt' : 'unknown');
      }
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
      const result = await window.electronAPI?.instances.repair?.({
        loader: instance.modloader.toLowerCase(),
        loaderVersion: instance.modloaderVersion || '',
        mcVersion: instance.minecraftVersion,
        folderName,
      });
      if (!result?.success) {
        // A missing answer must never be reported as a repaired install.
        failBackgroundTask(taskId, mainErrorText(result, lang, lang === 'de' ? 'Reparatur fehlgeschlagen' : 'Repair failed'));
        addToast({
          type: 'error',
          message: mainErrorText(result, lang, lang === 'de' ? 'Reparatur fehlgeschlagen' : 'Repair failed'),
        });
        return;
      }
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
        const message = mainErrorText(
          result,
          lang,
          lang === 'de' ? 'Klonen fehlgeschlagen' : 'Clone failed',
        );
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
          message: mainErrorText(result, lang, lang === 'de' ? 'Verknüpfung fehlgeschlagen' : 'Shortcut failed'),
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

  const renameDialog = (
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
  );

  if (selectedInstance) {
    const inst = instances.find(i => i.id === selectedInstance.id) || selectedInstance;
    const running = isRunning(instanceFolderKey(inst));
    return (
      <DetailViewBoundary lang={lang}>
      <InstanceDetailView
        inst={inst}
        instances={instances}
        lang={lang}
        t={t}
        running={running}
        launching={launching}
        launchingFolder={launchingFolder}
        launchProgress={launchProgress}
        hasAccount={hasAccount}
        detailTab={detailTab}
        setDetailTab={setDetailTab}
        preferences={preferences}
        showExportModal={showExportModal}
        onBack={() => {
          setSelectedInstanceId(null);
          onClearSelectedInstanceOverride?.();
        }}
        setSelectedInstanceId={setSelectedInstanceId}
        setInstances={setInstances}
        openModBrowserForInstance={openModBrowserForInstance}
        handleLaunchInstance={handleLaunchInstance}
        onStopGame={onStopGame}
        handleInstanceUpdate={handleInstanceUpdate}
        handleSelectImageForExistingInstance={handleSelectImageForExistingInstance}
        handleDeleteInstance={handleDeleteInstance}
        handleRepairInstance={handleRepairInstance}
        setRenameModal={setRenameModal}
        setRenameName={setRenameName}
        setShowExportModal={setShowExportModal}
        setVersionSwitchTarget={setVersionSwitchTarget}
      />
      {deleteDialog}
      {renameDialog}
      {analysisSheet}
      {versionSwitchModal}
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
            onOpenAnalysis={() => {
              setAnalysisTarget(inst);
              // Ohne gespeicherte Analyse lief der "Neu analysieren"-Knopf ins
              // Leere. Der Kern liefert das Ergebnis direkt, also beim Öffnen
              // einmal anfordern, wenn noch keins da ist.
              if (!analysisFor(analyses, inst)) {
                void onReanalyze?.(instanceFolderKey(inst), instanceFolderKey(inst));
              }
            }}
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

      <CreateInstanceDialog
        open={createModalOpen}
        lang={lang}
        t={t}
        newInstanceName={newInstanceName}
        setNewInstanceName={setNewInstanceName}
        newInstanceVersion={newInstanceVersion}
        setNewInstanceVersion={setNewInstanceVersion}
        newInstanceModloader={newInstanceModloader}
        setNewInstanceModloader={setNewInstanceModloader}
        setNewInstanceModloaderVersion={setNewInstanceModloaderVersion}
        newInstanceImage={newInstanceImage}
        setNewInstanceImage={setNewInstanceImage}
        loadingVersions={loadingVersions}
        minecraftVersions={minecraftVersions}
        effectiveModloaderVersion={effectiveModloaderVersion}
        getModloaderVersions={getModloaderVersions}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateInstance}
      />
      </div>
    </div>
  );
};
