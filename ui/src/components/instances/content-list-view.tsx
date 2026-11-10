import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { Dialog } from "../Dialog";
import { dialogButton } from "../dialogSupport";
import {
  Layers,
  RefreshCw,
  Package,
  Image,
  Shirt,
  Globe,
  FolderOpen,
  Download,
  Upload,
  Archive,
  Trash2,
  Lock,
  Unlock,
  AlertTriangle,
  ArrowUp,
  Sword,
  Blocks,
  Compass,
  Eye,
  Skull,
} from "lucide-react";
import { translations, formatMessage, LanguageType } from "../../lib/translations";
import { mainErrorText } from "../../lib/mainErrors";
import { categoryForTab, installItemTypeFor } from "../../lib/contentCategories";
import {
  decideUpdate,
  isVersionCompatible,
  type UpdateDecision,
  type VersionCriteria,
} from "../../lib/modVersions";
import { useToast } from "../Toast";
import { ContentDetailModal } from "./ContentDetailModal";
import { ModpackUpdateDialog } from "./ModpackUpdateDialog";
import { useInstanceWorlds } from "../../hooks/useInstanceWorlds";
import { useContentUpdates } from "../../hooks/useContentUpdates";
import { useModpackUpdate } from "../../hooks/useModpackUpdate";
import { useContentUpload } from "../../hooks/useContentUpload";
import { contentProjectUrl, fetchContentVersions } from "./contentDetailModel";
import { instanceFolderKeyOf as instanceFolderKey } from "../../lib/instanceFolders";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  updateBackgroundTask,
} from "../../lib/backgroundTasks";
import {
  LockedMark,
  UnlockedMark,
  VisibleMark,
  HiddenMark,
  DeleteMark,
  UpdateMark,
  ExternalMark,
} from "./ContentActionIcons";
import { formatDate, formatPlaytime } from "../../lib/launcherPreferences";
import type { DownloadModPayload, IdentifiedContentFile, WorldSummary } from "../../electron";
import {
  dedupeContent,
  errorMessage,
  type ContentItem,
  type Instance,
  type UpdateTarget,
} from "./instanceModel";

/**
 * Files found on disk start with this stand-in `version` until the store says
 * where they come from. It is not a Minecraft version, so it must never be
 * rendered as "MC Lokal".
 */
const LOCAL_VERSION_PLACEHOLDER = new Set(['Lokal', 'Local']);

/** The content tab of one instance: files on disk, updates and the detail modal. */
export const ContentListView = ({
  inst: initialInst,
  instances,
  detailTab,
  lang,
  openModBrowserForInstance,
  setInstances,
  setSelectedInstance,
  onWorldsDetected,
}: {
  inst: Instance;
  instances: Instance[];
  detailTab: string;
  lang: LanguageType;
  openModBrowserForInstance: (id: string) => void;
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  setSelectedInstance: (inst: Instance | null) => void;
  onWorldsDetected?: (count: number) => void;
}) => {
  const { addToast } = useToast();
  const t = translations[lang];
  const [localInst, setLocalInst] = useState(initialInst);
  const [selectedContentItem, setSelectedContentItem] = useState<ContentItem | null>(null);
  const updateTargets = useRef(new Map<string, UpdateTarget>());
  const updatingAll = useRef(false);
  const [updateAllProgress, setUpdateAllProgress] = useState<{ done: number; total: number } | null>(null);

  const [showOwnModsWarning, setShowOwnModsWarning] = useState(false);
  const [worldToDelete, setWorldToDelete] = useState<WorldSummary | null>(null);
  const [worldBusy, setWorldBusy] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  const contentItems = dedupeContent(localInst.content || [])
    .filter(c => c.type === categoryForTab(detailTab))
    .sort((a, b) => a.name.localeCompare(b.name, lang === 'de' ? 'de' : 'en', { sensitivity: 'base', numeric: true }));

  // Worlds live on disk (saves/<world>/level.dat), not in the profile content list.
  const worldsFolderKey = instanceFolderKey(localInst);
  const { worlds, refresh: refreshWorlds } = useInstanceWorlds({
    folderKey: worldsFolderKey,
    active: detailTab === "worlds",
    onDetected: onWorldsDetected,
  });
  const metadataAttemptRef = useRef<string | null>(null);
  const contentRef = useRef(localInst.content || []);
  useLayoutEffect(() => {
    contentRef.current = localInst.content || [];
  }, [localInst.content]);

  // Packs also ship content through overrides/ (resource packs, shaders, ...).
  // Scan the real folder once per tab so existing installs and override files
  // show up instead of looking missing in the launcher.
  useEffect(() => {
    const typeDir = categoryForTab(detailTab);
    if (!['mods', 'resourcepacks', 'shaderpacks', 'datapacks'].includes(typeDir)) return;
    let cancelled = false;
    void (async () => {
      const files = await window.electronAPI?.mods.listContentFiles?.({
        folderName: worldsFolderKey,
        type: typeDir,
      });
      if (cancelled || !Array.isArray(files) || files.length === 0) return;
      // Shaderpacks ship config/notes as .txt next to the real .zip files.
      const allowed = typeDir === 'mods' ? /\.jar(\.disabled)?$/i : /\.zip(\.disabled)?$/i;
      const usable = files.filter((file) => allowed.test(file));
      if (usable.length === 0) return;
      const known = new Set(
        (contentRef.current || [])
          .filter((item) => item.type === typeDir)
          .map((item) => String(item.fileName || '').toLowerCase()),
      );
      const missing = usable.filter((file) => !known.has(file.toLowerCase()));
      if (missing.length === 0) return;
      const additions = missing.map<ContentItem>((file) => ({
        id: `disk:${typeDir}:${file}`,
        name: file.replace(/\.(jar|zip|disabled)$/i, ''),
        fileName: file,
        version: lang === 'de' ? 'Lokal' : 'Local',
        type: typeDir as ContentItem['type'],
        enabled: !file.endsWith('.disabled'),
        locked: false,
      }));
      const merge = (items: ContentItem[]) => {
        const present = new Set(items.map((item) => String(item.fileName || "").toLowerCase()));
        const fresh = additions.filter((item) => !present.has(item.fileName.toLowerCase()));
        return fresh.length === 0 ? items : [...items, ...fresh];
      };
      // Merge into the live list: two scans racing on one stale snapshot used to add the same file twice.
      setLocalInst((prev) => ({ ...prev, content: merge(prev.content || []) }));
      setInstances((prev) => prev.map((instance) =>
        instance.id === localInst.id
          ? { ...instance, content: merge(instance.content || []) }
          : instance,
      ));
    })();
    return () => { cancelled = true; };
  }, [detailTab, lang, localInst.id, setInstances, worldsFolderKey]);

  const itemCategory = (item: ContentItem) => categoryForTab(item.type);

  /** What this instance can load; the check and the update run share it. */
  const criteriaFor = (item: ContentItem): VersionCriteria => ({
    category: itemCategory(item),
    minecraftVersion: localInst.minecraftVersion,
    modloader: localInst.modloader,
  });

  /** The update run uses the same decision the check uses. */
  const decideForItem = async (item: ContentItem): Promise<UpdateDecision> => {
    const versions = await fetchContentVersions(item);
    return decideUpdate(item.versionNumber, versions, criteriaFor(item));
  };

  /** Plain wording for why an installed item has no fitting version left. */
  const updateMissReason = (reason: string | null): string => {
    switch (reason) {
      case 'no-versions':
        return t.installMissNoVersions;
      case 'mc-version':
        return formatMessage(t.installMissMcVersion, { mc: localInst.minecraftVersion });
      case 'loader':
        return formatMessage(t.installMissLoader, { loader: `${localInst.modloader} ${localInst.minecraftVersion}` });
      default:
        return t.installMissNoFile;
    }
  };

  const { checkingUpdates, checkContentUpdates } = useContentUpdates({
    inst: localInst,
    initialInstanceId: initialInst.id,
    activeTab: detailTab,
    lang,
    contentRef,
    setInst: setLocalInst,
    setInstances,
    updateTargets,
    updatingAll,
    addToast,
  });

  const slug = instanceFolderKey(localInst);

  const withUpdatedInstance = (updater: (inst: Instance) => Instance) => {
    setInstances(prev => prev.map(i => i.id === localInst.id ? updater(i) : i));
    setLocalInst(prev => updater(prev));
  };

  const updateContent = (updater: (items: ContentItem[]) => ContentItem[]) => {
    withUpdatedInstance(i => ({ ...i, content: updater(i.content || []) }));
  };

  // Instances installed before metadata support only know file names. Hash the
  // downloaded files once and resolve them through Modrinth in the background;
  // the list stays interactive while this runs.
  const metadataMissingKey = (localInst.content || [])
    .filter(item => item.fileName && !item.projectId && item.type !== 'worlds')
    .map(item => item.fileName)
    .sort()
    .join('|');

  useEffect(() => {
    const missing = (contentRef.current || []).filter(
      item => item.fileName && !item.projectId && item.type !== 'worlds',
    );
    if (missing.length === 0) return;
    const attemptKey = `${localInst.id}:${missing.length}:${missing.map(item => item.fileName).sort().join('|')}`;
    let cancelled = false;

    const applyMetadata = (instance: Instance, byFileName: Map<string, IdentifiedContentFile>): Instance => {
      const content = (instance.content || []).map((item) => {
        const meta = byFileName.get(item.fileName);
        if (!meta) return item;
        // "Lokal"/"Local" only stood in for a missing version until the file
        // had a source; keeping it would render "MC Lokal" next to the real
        // project.
        const placeholderVersion = LOCAL_VERSION_PLACEHOLDER.has(item.version);
        return {
          ...item,
          id: meta.projectId || item.id,
          name: meta.name || item.name,
          iconUrl: meta.iconUrl || item.iconUrl,
          versionNumber: meta.versionNumber || item.versionNumber,
          projectId: meta.projectId || item.projectId,
          source: meta.source || item.source,
          version: placeholderVersion ? '' : item.version,
        };
      });
      return {
        ...instance,
        content,
        installedMods: [...new Set([
          ...(instance.installedMods || []),
          ...content.map(item => item.projectId).filter((slug): slug is string => Boolean(slug)),
        ])],
      };
    };

    const timer = window.setTimeout(() => {
      if (metadataAttemptRef.current === attemptKey) return;
      metadataAttemptRef.current = attemptKey;
      void (async () => {
        try {
          const metadata = await window.electronAPI?.mods.identifyContentFiles?.({
            folderName: worldsFolderKey,
            files: missing.map(item => ({ fileName: item.fileName, type: item.type })),
          });
          if (cancelled || !metadata) {
            if (!metadata) metadataAttemptRef.current = null;
            return;
          }
          const byFileName = new Map<string, IdentifiedContentFile>();
          for (const [fileName, meta] of Object.entries(metadata)) {
            // A jar's own name and version are worth showing even when no
            // store knows the file; only a fully empty answer is useless.
            if (!meta || (!meta.projectId && !meta.name && !meta.versionNumber)) continue;
            byFileName.set(fileName, meta);
          }
          if (byFileName.size === 0) {
            // Nothing came back: a later mount may still resolve the files.
            metadataAttemptRef.current = null;
            return;
          }
          setInstances(prev => prev.map(instance =>
            instance.id === localInst.id ? applyMetadata(instance, byFileName) : instance
          ));
          setLocalInst(prev => applyMetadata(prev, byFileName));
        } catch {
          metadataAttemptRef.current = null;
        }
      })();
    }, 750);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [localInst.id, metadataMissingKey, setInstances, worldsFolderKey]);

  const handleToggleEnabled = (itemId: string) => {
    updateContent(items => items.map(c => c.id === itemId ? { ...c, enabled: !c.enabled } : c));
  };

  const handleToggleLocked = (itemId: string) => {
    updateContent(items => items.map(c => c.id === itemId ? { ...c, locked: !c.locked } : c));
  };

  const enableOwnContentManagement = () => {
    // Enabling custom content unlocks everything that was pinned by the pack,
    // so the read-only banner and the lock badges disappear for good.
    withUpdatedInstance(instance => ({
      ...instance,
      ownContentManagement: true,
      content: (instance.content || []).map(item => ({ ...item, locked: false })),
    }));
    setShowOwnModsWarning(false);
    addToast({
      type: "success",
      message: lang === "de"
        ? "Eigene Mods sind aktiviert. Alle Inhalte sind jetzt entsperrt."
        : "Custom mods are enabled. All content is unlocked now.",
    });
  };

  const { uploadingFile, uploadProgress, handleUploadLocalMod } = useContentUpload({
    inst: localInst,
    detailTab,
    lang,
    addToast,
    withUpdatedInstance,
    refreshWorlds,
  });

  const handleDeleteContent = async (itemId: string) => {
    const item = (localInst.content || []).find(c => c.id === itemId);
    if (item && item.fileName) {
      const folderName = instanceFolderKey(localInst);
      const typeDir = categoryForTab(item.type);
      const deleteFailed = lang === 'de' ? 'Datei konnte nicht gelöscht werden.' : 'The file could not be deleted.';
      try {
        const removed = await window.electronAPI?.mods.deleteContentFile?.({
          folderName,
          fileName: item.fileName,
          type: typeDir
        });
        // Keep the row when the file survived; hiding it would resurrect it on the next disk scan.
        if (removed === false) {
          addToast({ type: 'error', message: deleteFailed });
          return;
        }
      } catch (e) {
        addToast({ type: 'error', message: errorMessage(e) || deleteFailed });
        return;
      }
    }
    withUpdatedInstance(i => ({
      ...i,
      content: (i.content || []).filter(c => c.id !== itemId),
      installedMods: (i.installedMods || []).filter(s => s !== itemId),
      modCount: item && item.type === 'mods' ? Math.max(0, (i.modCount || 0) - 1) : i.modCount,
    }));
  };

  const handleUpdate = async (itemId: string, options: { silent?: boolean } = {}) => {
    const item = (localInst.content || []).find(c => c.id === itemId);
    if (!item || !item.projectId || !item.source || !item.versionNumber) {
      updateContent(items => items.map(c => c.id === itemId ? { ...c, updateAvailable: false } : c));
      return;
    }

    try {
      const category = itemCategory(item);
      // Reuse the version the last check picked: no second request per mod, so
      // "update all" starts downloading instead of waiting in line.
      const criteria = criteriaFor(item);
      const cached = updateTargets.current.get(itemId);
      // Only reuse a target that still fits. A cached pick for another loader or
      // game version is decided again instead of being installed over the jar.
      const cachedFits = Boolean(
        cached &&
        cached.versionNumber === item.versionNumber &&
        isVersionCompatible(cached.version, criteria),
      );
      const decision: UpdateDecision = cachedFits && cached
        ? {
            status: 'update-available',
            pick: {
              version: cached.version,
              file: cached.file,
              fallback: null,
              reason: null,
              stats: { total: 0, mcMatches: 0, loaderMatches: 0 },
            },
          }
        : await decideForItem(item);

      if (decision.status === 'current') {
        // Deterministic: the newest fitting version is the one already installed.
        updateContent(items => items.map(c => c.id === itemId ? { ...c, updateAvailable: false } : c));
        addToast({
          type: 'success',
          message: formatMessage(t.updateAlreadyCurrent, { name: item.name, version: item.versionNumber }),
        });
        return;
      }

      if (decision.status !== 'update-available' || !decision.pick.version || !decision.pick.file) {
        updateContent(items => items.map(c => c.id === itemId ? { ...c, updateAvailable: false } : c));
        addToast({
          type: 'warning',
          message: formatMessage(t.updateNoCompatible, {
            name: item.name,
            reason: updateMissReason(decision.pick.reason),
          }),
        });
        return;
      }

      // Final gate: an incompatible jar must never replace a working one, no
      // matter which check produced the pick.
      if (!isVersionCompatible(decision.pick.version, criteria)) {
        updateContent(items => items.map(c => c.id === itemId ? { ...c, updateAvailable: false } : c));
        addToast({
          type: 'warning',
          message: decision.pick.version.gameVersions.includes(localInst.minecraftVersion)
            ? formatMessage(t.installMissLoader, { loader: `${localInst.modloader} ${localInst.minecraftVersion}` })
            : formatMessage(t.installMissMcVersion, { mc: localInst.minecraftVersion }),
        });
        return;
      }

      const next = decision.pick.version;
      const file = decision.pick.file;
      const folderName = instanceFolderKey(localInst);
      const typeDir = category;
      const payload: DownloadModPayload = {
        folderName,
        profileName: localInst.name,
        versionId: localInst.minecraftVersion,
        filename: file.filename,
        itemType: installItemTypeFor(category),
      };
      const curseForgeFileId = item.source === 'curseforge' ? Number(next.versionId) : NaN;
      if (Number.isFinite(curseForgeFileId) && curseForgeFileId > 0) {
        payload.curseforgeFileId = curseForgeFileId;
      } else {
        payload.downloadUrl = file.url;
      }

      // The new file lands first; the old one is only removed once it is there,
      // so a failed update never leaves the instance without the content.
      const result = await window.electronAPI?.mods.download?.(payload);
      if (!result?.success) {
        addToast({
          type: 'error',
          message: formatMessage(t.updateFailed, {
            error: mainErrorText(result, lang, t.updateFailedGeneric),
          }),
        });
        return;
      }

      if (item.fileName && item.fileName !== file.filename) {
        try {
          await window.electronAPI?.mods.deleteContentFile?.({ folderName, fileName: item.fileName, type: typeDir });
        } catch { console.warn('[Instances] Old content file could not be removed'); }
      }

      updateTargets.current.delete(itemId);
      updateContent(items => items.map(c =>
        c.id === itemId
          ? { ...c, fileName: file.filename, version: localInst.minecraftVersion, versionNumber: next.versionNumber, updateAvailable: false }
          : c
      ));
      if (!options.silent) {
        addToast({ type: 'success', message: formatMessage(t.updateSuccess, { name: item.name, version: next.versionNumber }) });
      }
    } catch (e) {
      console.error('[Update] Fehler beim Update von', item?.name, e);
      addToast({ type: 'error', message: formatMessage(t.updateFailed, { error: errorMessage(e) }) });
    }
  };

  const modpackContentLocked = Boolean(localInst.isModpack && !localInst.ownContentManagement);

  const handleUpdateAll = async () => {
    if (modpackContentLocked) return;
    const updatable = dedupeContent(localInst.content || [])
      .filter(c => c.updateAvailable && !c.locked && c.projectId && c.source);
    if (updatable.length === 0) return;
    updatingAll.current = true;
    setUpdateAllProgress({ done: 0, total: updatable.length });
    // Lives in the app-wide task bar, so navigating away keeps the run visible.
    const taskId = `content-update:${instanceFolderKey(localInst)}`;
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de' ? `${localInst.name}: Updates` : `${localInst.name}: updates`,
      detail: `0/${updatable.length}`,
      percent: 0,
    });
    let done = 0;
    try {
      for (const item of updatable) {
        await handleUpdate(item.id, { silent: true });
        done += 1;
        setUpdateAllProgress({ done, total: updatable.length });
        updateBackgroundTask(taskId, {
          percent: Math.round((done / updatable.length) * 100),
          detail: `${done}/${updatable.length}`,
        });
      }
      completeBackgroundTask(taskId);
    } catch (error) {
      failBackgroundTask(taskId, errorMessage(error));
      throw error;
    } finally {
      updatingAll.current = false;
      setUpdateAllProgress(null);
    }
    addToast({ type: 'success', message: formatMessage(t.updateAllDone, { count: done }) });
  };

  const updatedNames = contentItems.filter(c => c.updateAvailable).map(c => c.name);
  const hasUpdates = updatedNames.length > 0;

  const {
    modpackUpdateAvailable,
    modpackCheckingUpdates,
    modpackVersions,
    showModpackUpdateModal,
    setShowModpackUpdateModal,
    showModpackUpdateOptions,
    setShowModpackUpdateOptions,
    selectedModpackVersion,
    setSelectedModpackVersion,
    modpackUpdateInstalling,
    modpackUpdateProgress,
    handleModpackNewInstance,
    handleModpackCleanUpdate,
    handleModpackBetaCarryOver,
  } = useModpackUpdate({
    inst: localInst,
    instances,
    setInstances,
    setInst: setLocalInst,
    lang,
    addToast,
  });

  const tabLabels: Record<string, string> = {
    mods: "Mods",
    resourcepacks: "Resource Packs",
    shader: t.shader,
    worlds: t.worlds,
    datapacks: "Data Packs",
  };

  const tabIcons: Record<string, React.ReactNode> = {
    mods: <Package className="w-4 h-4" />,
    resourcepacks: <Image className="w-4 h-4" />,
    shader: <Shirt className="w-4 h-4" />,
    worlds: <Globe className="w-4 h-4" />,
    datapacks: <Layers className="w-4 h-4" />,
  };

  const gamemodeMeta: Record<string, { Icon: React.ComponentType<{ className?: string }>; label: string }> = {
    survival: { Icon: Sword, label: t.gamemodeSurvival },
    creative: { Icon: Blocks, label: t.gamemodeCreative },
    adventure: { Icon: Compass, label: t.gamemodeAdventure },
    spectator: { Icon: Eye, label: t.gamemodeSpectator },
  };

  const handleImportWorld = async () => {
    const picked = await window.electronAPI?.dialogs.open?.({
      properties: ["openFile"],
      filters: [
        {
          name: lang === "de" ? "Minecraft-Welt" : "Minecraft world",
          extensions: ["zip"],
        },
      ],
    });
    if (!picked || picked.canceled || !picked.filePaths?.length) return;
    setWorldBusy("import");
    try {
      const result = await window.electronAPI?.instances.importWorld?.({
        folderName: worldsFolderKey,
        filePath: picked.filePaths[0],
      });
      if (result?.success) {
        await refreshWorlds();
        addToast({
          type: "success",
          message:
            lang === "de"
              ? `Welt „${result.worldName}“ importiert.`
              : `World “${result.worldName}” imported.`,
        });
      } else {
        addToast({
          type: "error",
          message: result?.error || (lang === "de" ? "Import fehlgeschlagen." : "Import failed."),
        });
      }
    } finally {
      setWorldBusy(null);
    }
  };

  const handleExportWorld = async (world: WorldSummary) => {
    setWorldBusy(world.folderName);
    try {
      const result = await window.electronAPI?.instances.exportWorld?.({
        folderName: worldsFolderKey,
        worldName: world.folderName,
      });
      addToast({
        type: result?.success ? "success" : "error",
        message: result?.success
          ? lang === "de"
            ? `Welt exportiert: ${result.path}`
            : `World exported: ${result.path}`
          : result?.error || (lang === "de" ? "Export fehlgeschlagen." : "Export failed."),
      });
    } finally {
      setWorldBusy(null);
    }
  };

  const handleDeleteWorld = async () => {
    if (!worldToDelete) return;
    setWorldBusy(worldToDelete.folderName);
    try {
      const result = await window.electronAPI?.instances.deleteWorld?.({
        folderName: worldsFolderKey,
        worldName: worldToDelete.folderName,
      });
      if (result?.success) {
        await refreshWorlds();
        addToast({
          type: "success",
          message:
            lang === "de"
              ? `Welt „${result.worldName}“ gelöscht.`
              : `World “${result.worldName}” deleted.`,
        });
      } else {
        addToast({
          type: "error",
          message: result?.error || (lang === "de" ? "Löschen fehlgeschlagen." : "Delete failed."),
        });
      }
    } finally {
      setWorldBusy(null);
      setWorldToDelete(null);
    }
  };

  const handleBackupNow = async () => {
    setBackupBusy(true);
    try {
      const result = await window.electronAPI?.instances.createBackup?.({
        folderName: worldsFolderKey,
        reason: lang === "de" ? "Manuell" : "Manual",
      });
      const empty = Boolean(result?.empty);
      addToast({
        type: result?.success ? (empty ? "info" : "success") : "error",
        message: result?.success
          ? empty
            ? lang === "de"
              ? "Es gibt noch keine Welten oder Configs zum Sichern."
              : "There is nothing to back up yet."
            : lang === "de"
              ? "Sicherung angelegt."
              : "Backup created."
          : result?.error || (lang === "de" ? "Sicherung fehlgeschlagen." : "Backup failed."),
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const emptyContentState = (
    <div className="py-16 text-center flex flex-col items-center gap-3 bg-root/20 border border-hairline rounded-2xl">
      <div className="w-14 h-14 text-ink-tertiary">{tabIcons[detailTab]}</div>
      <p className="text-regular text-ink-secondary font-medium">{formatMessage(t.noContentInstalled, { kind: tabLabels[detailTab] })}</p>
      <p className="text-small text-ink-tertiary">{formatMessage(t.noContentHint, { action: detailTab === "mods" ? t.addMods : t.addContentShort, kind: tabLabels[detailTab] })}</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {localInst.isModpack && modpackUpdateAvailable && modpackVersions.length > 0 && (
        <div className="bg-gradient-to-r from-warning/10 via-warning/5 to-transparent border border-warning/20 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-warning/10 border border-warning/20 flex items-center justify-center text-warning shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <p className="text-small font-medium text-warning">
                {lang === 'de' ? translations.de.modpackUpdateAvailable : translations.en.modpackUpdateAvailable}
              </p>
              <p className="text-micro text-warning/70 mt-0.5">
                {modpackVersions[0].version_number} ({lang === 'de' ? translations.de.latestLabel : translations.en.latestLabel})
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowModpackUpdateModal(true)}
            className="bg-warning hover:bg-warning/90 text-accent-contrast px-4 py-2 rounded-xl text-micro font-medium shadow-lg shadow-warning/10 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer shrink-0"
          >
            {modpackCheckingUpdates ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin inline mr-1" /> Check... </>
            ) : (
              <><ArrowUp className="w-3.5 h-3.5 inline mr-1" />{lang === 'de' ? translations.de.modpackUpdateAction : translations.en.modpackUpdateAction}</>
            )}
          </button>
        </div>
      )}

      {modpackUpdateInstalling && (
        <div className="bg-info/10 border border-info/20 rounded-2xl p-4 flex items-center gap-3">
          <RefreshCw className="w-5 h-5 text-info animate-spin shrink-0" />
          <p className="text-small font-medium text-info">{modpackUpdateProgress}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-regular font-medium text-ink">
          {tabLabels[detailTab] || detailTab} ({detailTab === "worlds" ? (worlds?.length ?? 0) : contentItems.length})
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {detailTab === "worlds" && (
            <>
              <button
                onClick={() => void handleBackupNow()}
                disabled={backupBusy}
                className="h-8 px-2 rounded-lg text-ink-secondary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                title={lang === "de" ? "Welten und Configs jetzt sichern" : "Back up worlds and configs now"}
              >
                <Archive className="w-4 h-4" />
                <span className="text-micro font-medium">
                  {backupBusy
                    ? lang === "de" ? "Sichere …" : "Saving …"
                    : lang === "de" ? "Sichern" : "Back up"}
                </span>
              </button>
              <button
                onClick={() => void handleImportWorld()}
                disabled={worldBusy === "import"}
                className="h-8 px-2 rounded-lg text-ink-secondary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                title={lang === "de" ? "Welt aus ZIP importieren" : "Import a world from ZIP"}
              >
                <Upload className="w-4 h-4" />
                <span className="text-micro font-medium">
                  {lang === "de" ? "Importieren" : "Import"}
                </span>
              </button>
              <button
                onClick={() => window.electronAPI?.instances.openProfileFolder?.(slug)}
                className="h-8 w-8 rounded-lg text-ink-secondary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center justify-center"
                title={t.openWorldFolder}
                aria-label={t.openWorldFolder}
              >
                <FolderOpen className="w-4 h-4" />
              </button>
            </>
          )}
          {!(localInst.isModpack && !localInst.ownContentManagement) && (
            <button
              onClick={handleUploadLocalMod}
              disabled={uploadingFile}
              className="h-8 w-8 rounded-lg text-ink-secondary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center justify-center disabled:opacity-50 relative"
              title={uploadingFile ? `${t.uploadOwnFile} ${uploadProgress}%` : t.uploadOwnFile}
              aria-label={t.uploadOwnFile}
            >
              <Upload className={`w-4 h-4 ${uploadingFile ? 'animate-pulse' : ''}`} />
              {uploadingFile && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-root px-1 text-[10px] font-semibold text-accent tabular-nums">
                  {uploadProgress}%
                </span>
              )}
            </button>
          )}
          {!(localInst.isModpack && !localInst.ownContentManagement && (detailTab === "mods" || detailTab === "datapacks")) && (
            <button
              onClick={() => { openModBrowserForInstance(localInst.id); setSelectedInstance(null); }}
              className="theme-bg hover:theme-bg-hover text-accent-contrast px-4 py-2 rounded-xl text-small font-medium flex items-center gap-2 cursor-pointer theme-shadow-lg"
            >
              <Download className="w-4 h-4" />
              {detailTab === "mods" ? t.addMods : t.addContentShort}
            </button>
          )}
          <button
            onClick={() => { void checkContentUpdates({ report: true }); }}
            disabled={checkingUpdates}
            className="h-8 w-8 rounded-lg text-ink-tertiary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center justify-center disabled:opacity-50"
            title={checkingUpdates ? t.loading : t.reloadPackage}
            aria-label={checkingUpdates ? t.loading : t.reloadPackage}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdates ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {hasUpdates && (
        <div className="rounded-2xl border border-accent/30 bg-accent/8 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <RefreshCw className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-small font-semibold text-ink">
              {lang === 'de'
                ? `${updatedNames.length} ${updatedNames.length === 1 ? 'Update' : 'Updates'} verfügbar`
                : `${updatedNames.length} ${updatedNames.length === 1 ? 'update' : 'updates'} available`}
            </p>
            <p className="m-0 mt-0.5 truncate text-micro text-ink-secondary">
              {updatedNames.slice(0, 4).join(' · ')}
              {updatedNames.length > 4 ? ` · +${updatedNames.length - 4}` : ''}
            </p>
          </div>
          <button
            onClick={handleUpdateAll}
            disabled={modpackContentLocked || Boolean(updateAllProgress)}
            title={
              modpackContentLocked
                ? lang === 'de'
                  ? 'Aktiviere zuerst „Eigene Mods“, um Modpack-Inhalte zu aktualisieren.'
                  : 'Enable “Custom mods” first to update modpack content.'
                : t.updateAll
            }
            className={`shrink-0 px-4 py-2 rounded-xl text-small font-semibold flex items-center gap-1.5 transition-colors ${
              modpackContentLocked
                ? 'bg-hover text-ink-tertiary border border-hairline cursor-not-allowed'
                : 'theme-bg hover:theme-bg-hover text-accent-contrast cursor-pointer theme-shadow-lg'
            }`}
          >
            {modpackContentLocked ? <Lock className="w-3.5 h-3.5" /> : <RefreshCw className={`w-3.5 h-3.5 ${updateAllProgress ? "animate-spin" : ""}`} />}
            {updateAllProgress ? `${updateAllProgress.done}/${updateAllProgress.total}` : t.updateAll}
          </button>
        </div>
      )}

      {localInst.isModpack && !localInst.ownContentManagement && (detailTab === "mods" || detailTab === "datapacks") && (
        <div className="rounded-2xl border border-hairline bg-surface/60 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="h-10 w-10 rounded-xl border border-hairline bg-root flex items-center justify-center shrink-0 text-ink-secondary">
            <Lock className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-small font-semibold text-ink">
              {lang === "de" ? "Eigene Mods" : "Custom mods"}
            </p>
            <p className="mt-0.5 text-micro leading-5 text-ink-secondary">
              {lang === "de"
                ? "Die Modpack-Inhalte sind schreibgeschützt. Aktiviere eigene Mods, um zusätzliche Mods und Datapacks hinzuzufügen, zu löschen oder zu sperren."
                : "Modpack content is read-only. Enable custom mods to add, remove or lock additional mods and data packs."}
            </p>
          </div>
          <button
            onClick={() => setShowOwnModsWarning(true)}
            className="shrink-0 px-4 py-2 rounded-xl border border-rim bg-hover hover:bg-selected text-small font-medium text-ink transition-colors cursor-pointer flex items-center gap-2"
          >
            <Unlock className="w-3.5 h-3.5" />
            {lang === "de" ? "Eigene Mods aktivieren" : "Enable custom mods"}
          </button>
        </div>
      )}

      <Dialog
        open={showOwnModsWarning}
        onClose={() => setShowOwnModsWarning(false)}
        title={lang === "de" ? "Eigene Mods aktivieren?" : "Enable custom mods?"}
        titleId="own-mods-warning-title"
        closeLabel={lang === "de" ? "Abbrechen" : "Cancel"}
        icon={<AlertTriangle className="h-4 w-4" />}
        tone="info"
        footer={
          <>
            <button onClick={() => setShowOwnModsWarning(false)} className={dialogButton.secondary}>
              {lang === "de" ? "Abbrechen" : "Cancel"}
            </button>
            <button onClick={enableOwnContentManagement} className={dialogButton.accent}>
              {lang === "de" ? "Trotzdem aktivieren" : "Enable anyway"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-small text-ink-secondary">
          <p className="m-0">
            {lang === "de"
              ? "Bei Modpacks ist das nicht empfohlen: Beim Aktualisieren können eigene Änderungen mit dem Pack kollidieren und Mod-Updates gehen dadurch verloren."
              : "This is not recommended for modpacks: pack updates can conflict with your own changes and mod updates may be lost."}
          </p>
          <p className="m-0">
            {lang === "de"
              ? "Für eigene Instanzen und importierte Packs von einem anderen Launcher ist es genau richtig – dort möchtest du deine Mods schließlich selbst verwalten."
              : "For your own instances and packs imported from another launcher it is exactly right – that is where you want to manage your mods yourself."}
          </p>
          <p className="m-0 text-micro text-ink-tertiary">
            {lang === "de"
              ? "Beim Aktivieren werden alle Inhalte entsperrt und dieser Hinweis verschwindet dauerhaft."
              : "Enabling unlocks all content and this notice disappears for good."}
          </p>
        </div>
      </Dialog>

      <Dialog
        open={worldToDelete !== null}
        onClose={() => setWorldToDelete(null)}
        title={lang === "de" ? "Welt löschen?" : "Delete world?"}
        titleId="world-delete-title"
        closeLabel={lang === "de" ? "Abbrechen" : "Cancel"}
        icon={<Trash2 className="h-4 w-4" />}
        tone="danger"
        footer={
          <>
            <button
              onClick={() => setWorldToDelete(null)}
              className={dialogButton.secondary}
              disabled={worldBusy !== null}
            >
              {lang === "de" ? "Abbrechen" : "Cancel"}
            </button>
            <button
              onClick={() => void handleDeleteWorld()}
              className={dialogButton.danger}
              disabled={worldBusy !== null}
            >
              {worldBusy !== null
                ? lang === "de" ? "Lösche …" : "Deleting …"
                : lang === "de" ? "Endgültig löschen" : "Delete permanently"}
            </button>
          </>
        }
      >
        <p className="m-0 text-small leading-6 text-ink-secondary">
          {lang === "de"
            ? `„${worldToDelete?.name ?? ""}“ wird mit allen Regionen, Spielerdaten und Statistiken gelöscht. Das lässt sich nicht rückgängig machen.`
            : `“${worldToDelete?.name ?? ""}” is deleted with all regions, player data and statistics. This cannot be undone.`}
        </p>
      </Dialog>

      {detailTab === "worlds" ? (
        worlds === null ? (
          <div className="py-16 text-center flex flex-col items-center gap-3 bg-root/20 border border-hairline rounded-2xl">
            <RefreshCw className="w-5 h-5 text-ink-tertiary animate-spin" />
            <p className="text-small text-ink-tertiary">{t.loading}</p>
          </div>
        ) : worlds.length === 0 ? (
          emptyContentState
        ) : (
          <div className="flex flex-col gap-2.5">
            {worlds.map(world => {
              const meta = world.gamemode ? gamemodeMeta[world.gamemode] : null;
              return (
                <div
                  key={world.folderName}
                  className="relative flex items-center gap-3.5 overflow-hidden rounded-2xl border border-stroke bg-surface py-3 pl-4 pr-3"
                >
                  <div className="relative w-12 h-12 rounded-xl border border-hairline bg-root flex items-center justify-center shrink-0 overflow-hidden">
                    {world.iconDataUrl ? (
                      <img src={world.iconDataUrl} alt={world.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    ) : meta ? (
                      <meta.Icon className="w-5 h-5 text-ink-secondary" />
                    ) : (
                      <Globe className="w-5 h-5 text-ink-secondary" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13.5px] font-semibold leading-5 truncate text-ink">{world.name}</span>
                      {world.hardcore && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-danger/25 bg-danger/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-danger">
                          <Skull className="w-2.5 h-2.5" />
                          {t.hardcoreLabel}
                        </span>
                      )}
                      {world.error && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-warning" title={world.error}>
                          <AlertTriangle className="w-2.5 h-2.5" />
                          {t.worldUnreadable}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 min-w-0 text-[12px] leading-none">
                      <span className="text-ink-tertiary font-mono truncate" title={world.folderName}>{world.folderName}</span>
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-md border border-hairline bg-root/70 px-1.5 py-[3px] text-[11px] font-semibold leading-none text-ink-secondary" title={t.gamemodeLabel}>
                        {meta ? <meta.Icon className="w-3 h-3" /> : null}
                        {meta ? meta.label : t.gamemodeUnknown}
                      </span>
                      {world.version && (
                        <span className="shrink-0 rounded-md border border-hairline bg-root/70 px-1.5 py-[3px] text-[11px] font-semibold leading-none text-ink-secondary">MC {world.version}</span>
                      )}
                      {world.playtimeMs !== null && (
                        <span
                          className="shrink-0 rounded-md border border-hairline bg-root/70 px-1.5 py-[3px] text-[11px] font-semibold leading-none text-ink-secondary"
                          title={`${t.worldPlaytimeLabel}: ${world.playtimeApproximate ? t.worldPlaytimeApproxHint : t.worldPlaytimeStatsHint}`}
                        >
                          {world.playtimeApproximate ? "≈ " : ""}{formatPlaytime(world.playtimeMs, lang)}
                        </span>
                      )}
                      {world.lastPlayed && (
                        <>
                          <span className="shrink-0 text-ink-disabled">·</span>
                          <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t.worldLastPlayedLabel} {formatDate(world.lastPlayed, lang)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void handleExportWorld(world)}
                      disabled={worldBusy === world.folderName}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 cursor-pointer"
                      title={lang === "de" ? "Welt als ZIP exportieren" : "Export world as ZIP"}
                      aria-label={lang === "de" ? "Welt als ZIP exportieren" : "Export world as ZIP"}
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => window.electronAPI?.instances.openWorld?.(worldsFolderKey, world.folderName)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-hover hover:text-ink cursor-pointer"
                      title={t.openWorldFolder}
                      aria-label={t.openWorldFolder}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setWorldToDelete(world)}
                      disabled={worldBusy === world.folderName}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50 cursor-pointer"
                      title={lang === "de" ? "Welt löschen" : "Delete world"}
                      aria-label={lang === "de" ? "Welt löschen" : "Delete world"}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : contentItems.length === 0 ? (
        emptyContentState
      ) : (
        <div className="flex flex-col gap-2.5">
          {contentItems.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedContentItem(item)}
              className={`mod-result-row group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border py-3 pl-4 pr-3 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer ${
                item.enabled
                  ? "bg-surface border-stroke hover:bg-raised hover:border-rim"
                  : "bg-root/50 border-dashed border-stroke/70 hover:bg-raised/60 hover:border-stroke"
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 w-[3px] ${
                  item.enabled ? "bg-transparent" : "bg-ink-quaternary"
                }`}
              />

              <div className={`relative w-12 h-12 rounded-xl border flex items-center justify-center shrink-0 overflow-hidden ${
                item.enabled
                  ? "border-hairline bg-root"
                  : "border-stroke/50 bg-root/70 opacity-45"
              }`}>
                {item.iconUrl ? (
                  <img src={item.iconUrl} alt={item.name} loading="lazy" decoding="async" className={`w-full h-full object-cover ${item.enabled ? "" : "grayscale"}`}
                       onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : item.type === "mods" ? <Package className="w-5 h-5 text-ink-secondary" /> :
                   item.type === "resourcepacks" ? <Image className="w-5 h-5 text-ink-secondary" /> :
                   item.type === "shaderpacks" ? <Shirt className="w-5 h-5 text-ink-secondary" /> :
                   item.type === "worlds" ? <Globe className="w-5 h-5 text-ink-secondary" /> :
                   <Layers className="w-5 h-5 text-ink-secondary" />}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[13.5px] font-semibold leading-5 truncate ${item.enabled ? "text-ink" : "text-ink-tertiary"}`}>{item.name}</span>
                  {item.locked && (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-hairline bg-root px-2 py-0.5 text-[11px] font-medium leading-none text-ink-tertiary">
                      <LockedMark className="w-2.5 h-2.5" />
                      {t.lockedLabel}
                    </span>
                  )}
                  {!item.enabled && (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-stroke/70 bg-root px-2 py-0.5 text-[11px] font-semibold leading-none text-ink-tertiary">
                      <HiddenMark className="w-2.5 h-2.5" />
                      {t.disabledLabel}
                    </span>
                  )}
                </div>
                <div className={`mt-1 flex items-center gap-2 min-w-0 text-[12px] leading-none ${item.enabled ? "" : "opacity-70"}`}>
                  <span className="text-ink-tertiary font-mono truncate" title={item.fileName}>{item.fileName}</span>
                  {item.versionNumber && item.versionNumber !== item.version && (
                    <span className={`shrink-0 rounded-md border px-1.5 py-[3px] text-[11px] font-semibold leading-none ${item.enabled ? "border-hairline bg-root/70 text-ink-secondary" : "border-stroke/50 bg-root/60 text-ink-quaternary"}`}>{item.versionNumber}</span>
                  )}
                  {item.version && !item.source && (
                    <span className={`shrink-0 rounded-md border px-1.5 py-[3px] text-[11px] font-semibold leading-none ${item.enabled ? "border-hairline bg-root/70 text-ink-secondary" : "border-stroke/50 bg-root/60 text-ink-quaternary"}`}>
                      {LOCAL_VERSION_PLACEHOLDER.has(item.version) ? t.localVersion : `MC ${item.version}`}
                    </span>
                  )}
                  {item.source && (
                    <>
                      <span className="shrink-0 text-ink-disabled">·</span>
                      <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
                        {item.source === "curseforge" ? "CurseForge" : "Modrinth"}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0 pl-2.5 ml-1 border-l border-hairline" onClick={(e) => e.stopPropagation()}>
                {item.projectId && item.source && (
                  <button
                    onClick={() => {
                      const url = contentProjectUrl(item);
                      if (url) window.electronAPI?.system.openExternal?.(url);
                    }}
                    className="h-9 w-9 rounded-lg border border-stroke bg-root/50 hover:border-rim hover:text-ink text-ink-tertiary flex items-center justify-center transition-colors cursor-pointer"
                    title={t.openProject}
                  >
                    <ExternalMark className="w-4 h-4" />
                  </button>
                )}

                {item.updateAvailable && !item.locked && (
                  <button
                    onClick={() => handleUpdate(item.id)}
                    className="h-9 w-9 rounded-lg border border-accent/30 bg-accent/10 hover:bg-accent/20 text-accent flex items-center justify-center transition-colors cursor-pointer"
                    title={t.updateAvailable}
                  >
                    <UpdateMark className="w-4 h-4" />
                  </button>
                )}                  <button
                    onClick={() => handleToggleEnabled(item.id)}
                    className={`h-9 w-9 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                    item.enabled
                      ? 'border-success/20 bg-success/10 hover:bg-success/20 text-success'
                      : 'border-stroke bg-root/50 hover:border-rim hover:text-ink text-ink-tertiary'
                  }`}
                  title={item.enabled ? (lang === 'de' ? translations.de.disable : translations.en.disable) : (lang === 'de' ? translations.de.enable : translations.en.enable)}
                >
                  {item.enabled ? <VisibleMark className="w-4 h-4" /> : <HiddenMark className="w-4 h-4" />}
                </button>

                <button
                  onClick={() => handleToggleLocked(item.id)}
                  className={`h-9 w-9 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                    item.locked
                      ? 'border-stroke bg-root/60 hover:border-rim hover:text-ink text-ink-secondary'
                      : 'border-stroke bg-root/50 hover:border-rim hover:text-ink text-ink-tertiary'
                  }`}
                  title={item.locked ? (lang === 'de' ? translations.de.unlock : translations.en.unlock) : (lang === 'de' ? translations.de.lock : translations.en.lock)}
                >
                  {item.locked ? <LockedMark className="w-4 h-4" /> : <UnlockedMark className="w-4 h-4" />}
                </button>

                <button
                  onClick={() => handleDeleteContent(item.id)}
                  disabled={item.locked}
                  className="h-9 w-9 rounded-lg border border-danger/20 bg-danger/10 hover:bg-danger/20 text-danger flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t.delete}
                >
                  <DeleteMark className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {selectedContentItem && (
          <ContentDetailModal
            key={selectedContentItem.id}
            item={selectedContentItem}
            onClose={() => setSelectedContentItem(null)}
            localInst={localInst}
            setInstances={setInstances}
            lang={lang}
          />
        )}
      </AnimatePresence>

      <ModpackUpdateDialog
        lang={lang}
        open={showModpackUpdateModal}
        installing={modpackUpdateInstalling}
        versions={modpackVersions}
        optionsOpen={showModpackUpdateOptions}
        selectedVersion={selectedModpackVersion}
        ownContentManagement={Boolean(localInst.ownContentManagement)}
        onClose={() => {
          setShowModpackUpdateModal(false);
          setShowModpackUpdateOptions(false);
          setSelectedModpackVersion("");
        }}
        onOptionsOpenChange={setShowModpackUpdateOptions}
        onSelectVersion={setSelectedModpackVersion}
        onNewInstance={handleModpackNewInstance}
        onCleanUpdate={handleModpackCleanUpdate}
        onBetaCarryOver={handleModpackBetaCarryOver}
      />
    </div>
  );
};

