import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MOTION, EASE, motionSafe } from "../../lib/motionTokens";
import { Dialog } from "../Dialog";
import { dialogButton } from "../dialogSupport";
import {
  Layers,
  RefreshCw,
  Package,
  Image,
  Zap,
  Shirt,
  Globe,
  FolderOpen,
  Download,
  Upload,
  Lock,
  Unlock,
  AlertTriangle,
  ArrowUp,
  Sword,
  Blocks,
  Compass,
  Eye,
  Skull,
  X,
  Plus,
} from "lucide-react";
import { translations, formatMessage, LanguageType } from "../../lib/translations";
import { categoryForTab, installItemTypeFor } from "../../lib/contentCategories";
import {
  decideUpdate,
  fromModrinthVersion,
  pickVersion,
  type UpdateDecision,
} from "../../lib/modVersions";
import { LAUNCHER_VERSION } from "../../lib/version";
import {
  buildModpackContentItems,
  mergeOverrideContentItems,
  type ModpackIndexFile,
} from "../../lib/modpackContent";
import { modpackLoaderLabel, toModpackVersion, type ModpackLoader } from "../../lib/modpackVersions";
import { useToast } from "../Toast";
import { ContentDetailModal } from "./ContentDetailModal";
import { contentProjectUrl, fetchContentVersions } from "./contentDetailModel";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from "../../lib/backgroundTasks";
import { instanceFolderKeyOf as instanceFolderKey, uniqueInstanceFolder, uniqueInstanceName } from "../../lib/instanceFolders";
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
import type { ModrinthVersionFile } from "../mods/modDetailModel";
import {
  dedupeContent,
  errorMessage,
  type ContentItem,
  type Instance,
  type UpdateTarget,
} from "./instanceModel";

interface ModrinthVersion {
  id?: string;
  version_number: string;
  version_type?: string;
  date_published: string;
  game_versions?: string[];
  loaders?: string[];
  files?: ModrinthVersionFile[];
}


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
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const updateTargets = useRef(new Map<string, UpdateTarget>());
  const updatingAll = useRef(false);
  const [updateAllProgress, setUpdateAllProgress] = useState<{ done: number; total: number } | null>(null);

  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showOwnModsWarning, setShowOwnModsWarning] = useState(false);

  const contentItems = dedupeContent(localInst.content || [])
    .filter(c => c.type === categoryForTab(detailTab))
    .sort((a, b) => a.name.localeCompare(b.name, lang === 'de' ? 'de' : 'en', { sensitivity: 'base', numeric: true }));

  // Worlds live on disk (saves/<world>/level.dat), not in the profile content list.
  const worldsFolderKey = instanceFolderKey(localInst);
  const [worldsState, setWorldsState] = useState<{ key: string; list: WorldSummary[] } | null>(null);
  const worldsKey = detailTab === "worlds" ? worldsFolderKey : null;
  const worlds = worldsState?.key === worldsKey ? worldsState.list : null;

  const onWorldsDetectedRef = useRef(onWorldsDetected);
  useEffect(() => { onWorldsDetectedRef.current = onWorldsDetected; });
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
      const known = new Set(
        (contentRef.current || [])
          .filter((item) => item.type === typeDir)
          .map((item) => String(item.fileName || '').toLowerCase()),
      );
      const missing = files.filter((file) => !known.has(file.toLowerCase()));
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

  const loadWorlds = React.useCallback(async () => {
    try {
      const list = await window.electronAPI?.instances.listWorlds?.(worldsFolderKey);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('[Instances] Welten konnten nicht gelesen werden:', e);
      return [];
    }
  }, [worldsFolderKey]);

  useEffect(() => {
    if (detailTab !== "worlds") return;
    let cancelled = false;
    void loadWorlds().then(list => {
      if (cancelled) return;
      setWorldsState({ key: worldsFolderKey, list });
      onWorldsDetectedRef.current?.(list.length);
    });
    return () => { cancelled = true; };
  }, [detailTab, loadWorlds, worldsFolderKey]);

  const itemCategory = (item: ContentItem) => categoryForTab(item.type);

  /** The one update decision: the check and the update run both use it. */
  const decideForItem = async (item: ContentItem): Promise<UpdateDecision> => {
    const versions = await fetchContentVersions(item);
    return decideUpdate(item.versionNumber, versions, {
      category: itemCategory(item),
      minecraftVersion: localInst.minecraftVersion,
      modloader: localInst.modloader,
    });
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

  const checkContentUpdates = async (options: { report?: boolean } = {}) => {
    let currentContent: ContentItem[] = [];
    setLocalInst(prev => {
      currentContent = prev.content || [];
      return prev;
    });

    const items = currentContent.length > 0 ? currentContent : (localInst.content || []);
    /** id -> result of this run; merged into the live list instead of swapping it. */
    const checks = new Map<string, { updateAvailable: boolean; versionNumber?: string }>();
    const renamed = new Map<string, string>();
    // Worlds are user data on disk, not a store file that gets replaced in place;
    // a newer "world" release is a different world, so it is not an update.
    const itemsToCheck = items.filter(
      c => c.projectId && c.source && c.versionNumber && itemCategory(c) !== 'worlds',
    );
    if (itemsToCheck.length === 0) {
      setCheckingUpdates(false);
      return;
    }

    setCheckingUpdates(true);

    const folderName = instanceFolderKey(localInst);
    try {
      const scanTypes: { type: string; dir: string }[] = [
        { type: 'mods', dir: 'mods' },
        { type: 'resourcepacks', dir: 'resourcepacks' },
        { type: 'shaderpacks', dir: 'shaderpacks' },
        { type: 'datapacks', dir: 'datapacks' },
      ];
      for (const st of scanTypes) {
        const diskFiles = await window.electronAPI?.mods.listContentFiles?.({ folderName, type: st.dir });
        if (!diskFiles || diskFiles.length === 0) continue;
        for (let i = 0; i < items.length; i++) {
          const ci = items[i];
          if (ci.type !== st.type) continue;
          const slug = ci.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const projLower = (ci.projectId || '').toLowerCase();
          if (ci.fileName && diskFiles.includes(ci.fileName)) continue;
          const match = diskFiles.find((f: string) =>
            f.toLowerCase().includes(slug) || (projLower && f.toLowerCase().includes(projLower))
          );
          if (match) renamed.set(ci.id, match);
        }
      }
    } catch (e) {
      console.warn('[Update Check] Fehler beim Scannen der Dateien:', e);
    }

    // One request per 64 jars covers everything Modrinth hosts. Only the rest -
    // CurseForge content and jars it no longer knows - needs a version list each.
    const counts = { updates: 0, current: 0, incompatible: 0 };
    let queue = itemsToCheck;
    try {
      const batched = await window.electronAPI?.mods.checkUpdates?.({ folderName });
      if (batched) {
        const resolved = new Set(batched.resolved.map((file) => file.toLowerCase()));
        const updates = new Map(batched.updates.map((entry) => [entry.file.toLowerCase(), entry]));
        queue = [];
        for (const item of itemsToCheck) {
          const file = String(item.fileName || '').toLowerCase();
          const hit = updates.get(file);
          if (hit) {
            counts.updates += 1;
            updateTargets.current.set(item.id, {
              versionNumber: item.versionNumber,
              version: {
                versionNumber: hit.versionNumber,
                versionId: hit.versionId,
                gameVersions: [],
                loaders: [],
                files: [{ url: hit.url, filename: hit.fileName }],
              },
              file: { url: hit.url, filename: hit.fileName },
            });
            checks.set(item.id, { updateAvailable: true, versionNumber: item.versionNumber });
            continue;
          }
          if (resolved.has(file)) {
            counts.current += 1;
            updateTargets.current.delete(item.id);
            checks.set(item.id, { updateAvailable: false, versionNumber: item.versionNumber });
            continue;
          }
          queue.push(item);
        }
      }
    } catch (e) {
      console.warn('[Update Check] Sammelabfrage fehlgeschlagen, prüfe einzeln:', e);
    }

    const batchSize = 5;
    for (let i = 0; i < queue.length; i += batchSize) {
      const batch = queue.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const decision = await decideForItem(item);
            return { id: item.id, versionNumber: item.versionNumber, decision };
          } catch (e) {
            console.warn('[Update Check] Fehler beim Prüfen von', item.name, e);
            return null;
          }
        })
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { id, versionNumber, decision } = result.value;
        if (decision.status === 'update-available') {
          counts.updates += 1;
          if (decision.pick.version && decision.pick.file) {
            updateTargets.current.set(id, {
              versionNumber,
              version: decision.pick.version,
              file: decision.pick.file,
            });
          }
        } else {
          if (decision.status === 'current') counts.current += 1;
          else counts.incompatible += 1;
          updateTargets.current.delete(id);
        }
        checks.set(id, { updateAvailable: decision.status === 'update-available', versionNumber });
      }
    }

    // Merge by id into the live list. Swapping in this run's snapshot used to
    // resurrect the old version of anything updated while the check was running.
    const mergeCheck = (current: ContentItem[]) => current.map(item => {
      const check = checks.get(item.id);
      const newName = renamed.get(item.id);
      if (!check && !newName) return item;
      if (check && check.versionNumber !== item.versionNumber) return item;
      return {
        ...item,
        ...(newName ? { fileName: newName } : {}),
        ...(check ? { updateAvailable: check.updateAvailable } : {}),
      };
    });
    setInstances(prev => prev.map(i =>
      i.id === localInst.id ? { ...i, content: mergeCheck(i.content || []) } : i
    ));
    setLocalInst(prev => ({ ...prev, content: mergeCheck(prev.content || []) }));
    setCheckingUpdates(false);
    console.log('[Update Check] abgeschlossen.', counts, 'Items:', checks.size);
    if (options.report) {
      addToast({
        type: counts.updates > 0 ? 'success' : 'info',
        message: formatMessage(t.updateCheckSummary, counts),
      });
    }
  };

  const checkContentUpdatesRef = useRef(checkContentUpdates);
  useEffect(() => {
    checkContentUpdatesRef.current = checkContentUpdates;
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkContentUpdatesRef.current();
    }, 1000);
    const interval = setInterval(() => {
      if (updatingAll.current) return;
      void checkContentUpdatesRef.current();
    }, 5 * 60 * 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [initialInst.id, detailTab]);
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
        return {
          ...item,
          id: meta.projectId || item.id,
          name: meta.name || item.name,
          iconUrl: meta.iconUrl || item.iconUrl,
          versionNumber: meta.versionNumber || item.versionNumber,
          projectId: meta.projectId || item.projectId,
          source: meta.source,
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
            if (meta && meta.projectId) byFileName.set(fileName, meta);
          }
          if (byFileName.size === 0) return;
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

  const handleUploadLocalMod = async () => {
    const folderName = instanceFolderKey(localInst);
    const itemType = installItemTypeFor(categoryForTab(detailTab));
    const isWorldUpload = detailTab === 'worlds';
    let backgroundTaskId = '';
    let uploadSucceeded = false;
    let uploadFailure = '';

    try {
      const typeFilters: Record<string, { name: string; extensions: string[] }> = {
        mods: { name: 'Mods', extensions: ['jar', 'disabled'] },
        resourcepacks: { name: 'Resource Packs', extensions: ['zip'] },
        shader: { name: 'Shader Packs', extensions: ['zip'] },
        datapacks: { name: 'Data Packs', extensions: ['zip'] },
        worlds: { name: 'World Archives', extensions: ['zip', 'mcworld'] },
      };
      const filterItem = typeFilters[detailTab] || typeFilters.mods;
      const result = await window.electronAPI?.dialogs.open?.({
        properties: ['openFile'],
        filters: [filterItem],
      });
      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return;

      setUploadingFile(true);
      setUploadProgress(0);

      if (isWorldUpload) {
        const fileNameForTask = result.filePaths[0].split(/[\\/]/).pop() || 'Welt';
        backgroundTaskId = newBackgroundTaskId(`world:${folderName}`);
        beginBackgroundTask({
          id: backgroundTaskId,
          title: lang === 'de' ? `Welt wird installiert: ${fileNameForTask}` : `Installing world: ${fileNameForTask}`,
          detail: lang === 'de' ? 'Archiv wird entpackt' : 'Extracting archive',
          percent: 1,
        });
      }

      const unsub = window.electronAPI?.mods.onUploadProgress?.((data: { percent: number }) => {
        if (data && typeof data.percent === 'number') {
          setUploadProgress(data.percent);
        }
      });

      try {
        const uploadResult = await window.electronAPI?.mods.uploadLocal?.({
          folderName,
          filePath: result.filePaths[0],
          itemType,
          ...(backgroundTaskId ? { taskId: backgroundTaskId } : {}),
        });

        if (uploadResult?.success) {
          uploadSucceeded = true;
          setUploadProgress(100);
          const fileName = result.filePaths[0].split(/[\\/]/).pop() || 'unknown';
          const contentType = categoryForTab(detailTab);

          if (contentType === 'worlds') {
            // A world is a folder in saves/, detected from disk - not a content
            // file, so it gets no entry in the instance content list.
            const installed = uploadResult.worlds?.[0];
            const list = await loadWorlds();
            setWorldsState({ key: worldsFolderKey, list });
            onWorldsDetectedRef.current?.(list.length);
            addToast({
              type: 'success',
              message: installed
                ? installed.renamed
                  ? formatMessage(t.worldInstalledRenamed, { name: installed.folderName })
                  : formatMessage(t.worldInstalled, { name: installed.folderName })
                : formatMessage(t.worldInstalled, { name: fileName }),
            });
            return;
          }

          const displayType = detailTab === 'mods' ? 'Mod' : detailTab === 'resourcepacks' ? 'Resource Pack' : detailTab === 'shader' ? 'Shader' : t.fileLabel;
          withUpdatedInstance(i => ({
            ...i,
            content: [...(i.content || []), {
              id: fileName,
              name: uploadResult.modName || fileName.replace(/\.(jar|zip|disabled)$/i, ''),
              fileName: fileName,
              version: uploadResult.modVersion || t.localVersion,
              ...(uploadResult.modVersion && uploadResult.modVersion !== 'unknown'
                ? { versionNumber: uploadResult.modVersion }
                : {}),
              ...(uploadResult.iconBase64 ? { iconUrl: uploadResult.iconBase64 } : {}),
              type: contentType as ContentItem['type'],
              enabled: true,
              locked: false,
            }],
            modCount: contentType === 'mods' ? (i.modCount || 0) + 1 : i.modCount,
          }));

          addToast({ type: 'success', message: formatMessage(t.uploadSuccess, { type: displayType, file: fileName }) });
        } else {
          uploadFailure = uploadResult?.error || t.uploadFailed;
          addToast({ type: 'error', message: uploadFailure });
        }
      } finally {
        if (unsub) unsub();
      }
    } catch (e) {
      uploadFailure = errorMessage(e) || t.uploadFailed;
      addToast({ type: 'error', message: uploadFailure });
    } finally {
      if (backgroundTaskId) {
        if (uploadSucceeded) completeBackgroundTask(backgroundTaskId);
        else failBackgroundTask(backgroundTaskId, uploadFailure || t.uploadFailed);
      }
      setUploadingFile(false);
      setUploadProgress(0);
    }
  };

  const handleDeleteContent = async (itemId: string) => {
    const item = (localInst.content || []).find(c => c.id === itemId);
    if (item && item.fileName) {
      const folderName = instanceFolderKey(localInst);
      const typeDir = categoryForTab(item.type);
      try {
        await window.electronAPI?.mods.deleteContentFile?.({
          folderName,
          fileName: item.fileName,
          type: typeDir
        });
      } catch { console.warn('[Instances] Failed to save instance settings'); }
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
      const cached = updateTargets.current.get(itemId);
      const decision: UpdateDecision = cached && cached.versionNumber === item.versionNumber
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
          message: formatMessage(t.updateFailed, { error: result?.error || t.updateFailedGeneric }),
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
    let done = 0;
    try {
      for (const item of updatable) {
        await handleUpdate(item.id, { silent: true });
        done += 1;
        setUpdateAllProgress({ done, total: updatable.length });
      }
    } finally {
      updatingAll.current = false;
      setUpdateAllProgress(null);
    }
    addToast({ type: 'success', message: formatMessage(t.updateAllDone, { count: done }) });
  };

  const updatedNames = contentItems.filter(c => c.updateAvailable).map(c => c.name);
  const hasUpdates = updatedNames.length > 0;

  const [modpackUpdateAvailable, setModpackUpdateAvailable] = useState(false);
  const [modpackCheckingUpdates, setModpackCheckingUpdates] = useState(
    () => Boolean(localInst.isModpack && localInst.modpackProjectId),
  );
  const [modpackVersions, setModpackVersions] = useState<{
    version_number: string;
    date_published: string;
    url: string;
    mcVersion: string;
    loader: ModpackLoader;
    versionType: "release" | "beta" | "alpha";
  }[]>([]);
  const [showModpackUpdateModal, setShowModpackUpdateModal] = useState(false);
  const [showModpackUpdateOptions, setShowModpackUpdateOptions] = useState(false);
  const [selectedModpackVersion, setSelectedModpackVersion] = useState<string>("");
  const [modpackUpdateInstalling, setModpackUpdateInstalling] = useState(false);
  const [modpackUpdateProgress, setModpackUpdateProgress] = useState("");

  useEffect(() => {
    if (!localInst.isModpack || !localInst.modpackProjectId) return;
    void (async () => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${localInst.modpackProjectId}/version`, {
        headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return;

      const packVersions = (data as ModrinthVersion[])
        .map((version) => {
          const summary = toModpackVersion(version);
          return summary ? {
            version_number: summary.versionNumber,
            date_published: summary.datePublished,
            url: summary.url,
            mcVersion: summary.mcVersion,
            loader: summary.loader,
            versionType: summary.versionType,
          } : null;
        })
        .filter((version): version is NonNullable<typeof version> => Boolean(version))
        .sort((a, b) => {
          const typeOrder = Number(a.versionType !== "release") - Number(b.versionType !== "release");
          return typeOrder || new Date(b.date_published).getTime() - new Date(a.date_published).getTime();
        });

      setModpackVersions(packVersions);

      if (packVersions.length > 0 && packVersions[0].version_number !== localInst.modpackVersion) {
        setModpackUpdateAvailable(true);
      }
    } catch (e) {
      console.warn('[Modpack Update] Fehler beim Prüfen', e);
    } finally {
      setModpackCheckingUpdates(false);
    }
    })();
  }, [localInst.isModpack, localInst.modpackProjectId, localInst.modpackVersion]);

  const handleModpackNewInstance = async () => {
    if (!selectedModpackVersion) return;
    const versionData = modpackVersions.find(v => v.version_number === selectedModpackVersion);
    if (!versionData) return;

    const newId = `inst_${Date.now()}`;
    // The version is part of the folder identity: two versions of the same
    // modpack must never end up in one shared profile directory.
    const folderName = uniqueInstanceFolder(
      `${localInst.modpackProjectId || localInst.folderName || localInst.name}-${versionData.mcVersion}-${versionData.version_number}`,
      instances,
    );
    const nameTaken = instances.some(
      (entry) => entry.name.trim().toLowerCase() === localInst.name.trim().toLowerCase(),
    );
    const instanceName = uniqueInstanceName(
      nameTaken ? `${localInst.name} (${selectedModpackVersion})` : localInst.name,
      instances,
    );
    const taskId = `modpack:${folderName}`;
    let failure = "";

    setModpackUpdateInstalling(true);
    setModpackUpdateProgress(t.createInstanceProgress);
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de'
        ? `${instanceName} ${selectedModpackVersion} wird installiert…`
        : `Installing ${instanceName} ${selectedModpackVersion}…`,
      detail: selectedModpackVersion,
      percent: 2,
    });

    try {
      const newInst: Instance = {
        id: newId,
        folderName,
        name: instanceName,
        minecraftVersion: versionData.mcVersion,
        modloader: modpackLoaderLabel(versionData.loader),
        modloaderVersion: "",
        lastPlayed: lang === "de" ? "Gerade eben" : "Just now",
        size: t.installing,
        modCount: 0,
        thumbnail: localInst.thumbnail,
        desc: `${localInst.name} - ${selectedModpackVersion}`,
        javaVersion: t.automatic,
        installedMods: [],
        content: [],
        ram: localInst.ram || 6144,
        isModpack: true,
        modpackProjectId: localInst.modpackProjectId,
        modpackSource: localInst.modpackSource,
        modpackVersion: selectedModpackVersion,
      };

      setInstances(prev => [newInst, ...prev]);

      const result = await window.electronAPI?.mods.installModpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
        mode: "install",
      });

      if (!result?.success) {
        failure = result?.error || t.createInstanceFailed;
        setInstances(prev => prev.filter(instance => instance.id !== newId));
        addToast({ type: 'error', message: failure });
        return;
      }

      const content = mergeOverrideContentItems(
        buildModpackContentItems((result.index?.files || []) as ModpackIndexFile[]),
        result.overrideFiles || [],
      ) as ContentItem[];
      setInstances(prev => prev.map(i =>
        i.id === newId ? {
          ...i,
          folderName: result.folderName || i.folderName,
          minecraftVersion: result.mcVersion || i.minecraftVersion,
          modloader: result.loader ? modpackLoaderLabel(result.loader) : i.modloader,
          modloaderVersion: result.loaderVersion || i.modloaderVersion,
          modCount: content.filter(item => item.type === 'mods').length,
          size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
          content,
          installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
        } : i
      ));
      addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackNewInstanceCreated : translations.en.modpackNewInstanceCreated });
    } catch (e) {
      failure = errorMessage(e) || t.createInstanceFailed;
      setInstances(prev => prev.filter(instance => instance.id !== newId));
      addToast({ type: 'error', message: failure });
    } finally {
      if (failure) failBackgroundTask(taskId, failure);
      else completeBackgroundTask(taskId);
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

    const folderName = instanceFolderKey(localInst);
    const taskId = `modpack:${folderName}`;
    let failure = "";

    setModpackUpdateInstalling(true);
    setModpackUpdateProgress(t.installingModpackProgress);
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de'
        ? `${localInst.name} ${selectedModpackVersion} wird aktualisiert…`
        : `Updating ${localInst.name} ${selectedModpackVersion}…`,
      detail: selectedModpackVersion,
      percent: 2,
    });

    try {
      setModpackUpdateProgress(t.securingWorldsProgress);

      const result = await window.electronAPI?.mods.installModpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
        mode: "update",
      });

      if (!result?.success) {
        failure = result?.error || t.updateFailedGeneric;
        addToast({ type: 'error', message: failure });
        return;
      }

      const content = mergeOverrideContentItems(
        buildModpackContentItems((result.index?.files || []) as ModpackIndexFile[]),
        result.overrideFiles || [],
      ) as ContentItem[];
      setInstances(prev => prev.map(i =>
        i.id === localInst.id ? {
          ...i,
          folderName: result.folderName || i.folderName,
          minecraftVersion: result.mcVersion || versionData.mcVersion,
          modloader: result.loader ? modpackLoaderLabel(result.loader) : modpackLoaderLabel(versionData.loader),
          modloaderVersion: result.loaderVersion || i.modloaderVersion,
          modCount: content.filter(item => item.type === 'mods').length,
          size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
          installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
          content,
          modpackVersion: selectedModpackVersion,
        } : i
      ));
      addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackUpdatedClean : translations.en.modpackUpdatedClean });
    } catch (e) {
      failure = errorMessage(e) || t.updateFailedGeneric;
      addToast({ type: 'error', message: failure });
    } finally {
      if (failure) failBackgroundTask(taskId, failure);
      else completeBackgroundTask(taskId);
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

    const folderName = instanceFolderKey(localInst);
    const taskId = `modpack:${folderName}`;
    let failure = "";

    setModpackUpdateInstalling(true);
    setModpackUpdateProgress(t.carryOverProgress);
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de'
        ? `${localInst.name} ${selectedModpackVersion} wird aktualisiert…`
        : `Updating ${localInst.name} ${selectedModpackVersion}…`,
      detail: selectedModpackVersion,
      percent: 2,
    });

    try {
      const currentMods = (localInst.content || []).filter(c => c.type === 'mods' && c.projectId);

      const ownModIds = currentMods.map(m => m.projectId).filter(Boolean);

      const result = await window.electronAPI?.mods.installModpack?.({
        folderName,
        mcVersion: versionData.mcVersion,
        loader: versionData.loader,
        mrpackUrl: versionData.url,
        mode: "update",
      });

      if (!result?.success) {
        failure = result?.error || t.betaUpdateFailed;
        addToast({ type: 'error', message: failure });
        return;
      }

      {
        setModpackUpdateProgress(t.searchingCompatibleProgress);

        const newContent: ContentItem[] = [];
        for (const projectId of ownModIds) {
          try {
            const modRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
              headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` }
            });
            if (!modRes.ok) continue;
            const modVersions: ModrinthVersion[] = await modRes.json();

            // Carried-over mods go through the same selector: a version only
            // qualifies when it fits the new Minecraft version and loader.
            const pick = pickVersion(modVersions.map(fromModrinthVersion), {
              category: 'mods',
              minecraftVersion: versionData.mcVersion,
              modloader: versionData.loader,
            });
            if (!pick.version || !pick.file) continue;

            const dlResult = await window.electronAPI?.mods.download?.({
              folderName,
              profileName: localInst.name,
              versionId: versionData.mcVersion ?? '',
              downloadUrl: pick.file.url,
              filename: pick.file.filename,
              itemType: 'mods',
            });

            if (dlResult?.success) {
              const originalMod = currentMods.find(m => m.projectId === projectId);
              newContent.push({
                id: originalMod?.id || projectId || '',
                name: originalMod?.name || projectId || '',
                fileName: pick.file.filename ?? '',
                version: versionData.mcVersion ?? '',
                type: 'mods',
                enabled: true,
                locked: false,
                iconUrl: originalMod?.iconUrl,
                versionNumber: pick.version.versionNumber,
                projectId: projectId,
                source: 'modrinth',
              });
            }
          } catch { console.warn('[Instances] Failed to fetch mod version'); }
        }

        const carried = new Set(newContent.map(item => item.fileName));
        const packItems = mergeOverrideContentItems(
          buildModpackContentItems((result.index?.files || []) as ModpackIndexFile[]),
          result.overrideFiles || [],
        );
        const content = [
          ...packItems.filter(item => !carried.has(item.fileName)),
          ...newContent,
        ] as ContentItem[];
        setInstances(prev => prev.map(i =>
          i.id === localInst.id ? {
            ...i,
            folderName: result.folderName || i.folderName,
            minecraftVersion: result.mcVersion || versionData.mcVersion,
            modloader: result.loader ? modpackLoaderLabel(result.loader) : modpackLoaderLabel(versionData.loader),
            modloaderVersion: result.loaderVersion || i.modloaderVersion,
            modCount: content.filter(item => item.type === 'mods').length,
            size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
            installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
            content,
            modpackVersion: selectedModpackVersion,
          } : i
        ));

        addToast({ type: 'success', message: lang === 'de' ? translations.de.modpackBetaComplete : translations.en.modpackBetaComplete });
      }
    } catch (e) {
      failure = errorMessage(e) || t.betaUpdateFailed;
      addToast({ type: 'error', message: failure });
    } finally {
      if (failure) failBackgroundTask(taskId, failure);
      else completeBackgroundTask(taskId);
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
            <button
              onClick={() => window.electronAPI?.instances.openProfileFolder?.(slug)}
              className="h-8 w-8 rounded-lg text-ink-secondary hover:text-ink hover:bg-hover transition-colors cursor-pointer flex items-center justify-center"
              title={t.openWorldFolder}
              aria-label={t.openWorldFolder}
            >
              <FolderOpen className="w-4 h-4" />
            </button>
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
                  {item.version && (
                    <span className={`shrink-0 rounded-md border px-1.5 py-[3px] text-[11px] font-semibold leading-none ${item.enabled ? "border-hairline bg-root/70 text-ink-secondary" : "border-stroke/50 bg-root/60 text-ink-quaternary"}`}>MC {item.version}</span>
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

      <AnimatePresence>
        {showModpackUpdateModal && modpackVersions.length > 0 && !modpackUpdateInstalling && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
            onClick={() => { setShowModpackUpdateModal(false); setShowModpackUpdateOptions(false); setSelectedModpackVersion(""); }}
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
                  <Package className="w-5 h-5 text-warning" />
                  <h3 className="text-large font-semibold text-ink">
                    {lang === 'de' ? translations.de.modpackUpdateAvailable : translations.en.modpackUpdateAvailable}
                  </h3>
                </div>
                <button
                  onClick={() => { setShowModpackUpdateModal(false); setShowModpackUpdateOptions(false); setSelectedModpackVersion(""); }}
                  className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 flex flex-col gap-4 text-left">
                {!showModpackUpdateOptions ? (
                  <>
                    <p className="text-small text-ink-secondary">
                      {lang === 'de' ? translations.de.modpackSelectVersion : translations.en.modpackSelectVersion}
                    </p>
                    <div className="flex flex-col gap-2 max-h-60 overflow-y-auto custom-scrollbar">
                      {modpackVersions.map(ver => (
                        <button
                          key={ver.version_number}
                          onClick={() => {
                            setSelectedModpackVersion(ver.version_number);
                            if (localInst.ownContentManagement) {
                              setShowModpackUpdateOptions(true);
                            } else {
                              handleModpackCleanUpdate();
                            }
                          }}
                          className={`bg-surface/20 hover:bg-hover border border-stroke hover:border-warning/30 px-4 py-3 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] ${
                            selectedModpackVersion === ver.version_number ? 'border-warning/30 bg-warning/5' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-regular font-medium text-ink">{ver.version_number}</span>
                            <span className="text-micro text-ink-tertiary">
                              {new Date(ver.date_published).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US')}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-micro text-ink-secondary bg-selected px-2 py-0.5 rounded">{ver.mcVersion}</span>
                            <span className="text-micro text-ink-secondary bg-selected px-2 py-0.5 rounded">{ver.loader}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-small text-ink-secondary mb-1">
                      {lang === 'de' ? translations.de.updateOptionsFor : translations.en.updateOptionsFor} <strong className="text-ink">{selectedModpackVersion}</strong>:
                    </p>
                    <div className="flex flex-col gap-3">
                      <button
                        onClick={handleModpackNewInstance}
                        className="bg-surface/20 hover:bg-hover border border-stroke hover:theme-border-md px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl theme-bg-light theme-border-light flex items-center justify-center theme-text shrink-0">
                            <Plus className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <span className="text-regular font-medium text-ink group-hover:theme-text-bright transition-colors block">
                              {lang === 'de' ? translations.de.modpackNewInstance : translations.en.modpackNewInstance}
                            </span>
                            <span className="text-micro text-ink-secondary mt-1 block">
                              {lang === 'de' ? translations.de.modpackNewInstanceDesc : translations.en.modpackNewInstanceDesc}
                            </span>
                          </div>
                        </div>
                      </button>

                      <button
                        onClick={handleModpackCleanUpdate}
                        className="bg-surface/20 hover:bg-hover border border-stroke hover:border-info/30 px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-info/10 border border-info/20 flex items-center justify-center text-info shrink-0">
                            <RefreshCw className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <span className="text-regular font-medium text-ink group-hover:text-info transition-colors block">
                              {lang === 'de' ? translations.de.modpackCleanUpdate : translations.en.modpackCleanUpdate}
                            </span>
                            <span className="text-micro text-ink-secondary mt-1 block">
                              {lang === 'de' ? translations.de.modpackCleanUpdateDesc : translations.en.modpackCleanUpdateDesc}
                            </span>
                          </div>
                        </div>
                      </button>

                      <button
                        onClick={handleModpackBetaCarryOver}
                        className="bg-surface/20 hover:bg-hover border border-stroke hover:border-accent/30 px-4 py-4 rounded-xl text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent shrink-0">
                            <Zap className="w-5 h-5" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-regular font-medium text-ink group-hover:text-accent transition-colors">
                                {lang === 'de' ? translations.de.modpackBetaCarryOver : translations.en.modpackBetaCarryOver}
                              </span>
                              <span className="text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded uppercase tracking-label">BETA</span>
                            </div>
                            <span className="text-micro text-ink-secondary mt-1 block">
                              {lang === 'de' ? translations.de.modpackBetaCarryOverDesc : translations.en.modpackBetaCarryOverDesc}
                            </span>
                          </div>
                        </div>
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="p-4 bg-surface/40 border-t border-hairline flex justify-between items-center">
                <button
                  onClick={() => {
                    if (showModpackUpdateOptions) {
                      setShowModpackUpdateOptions(false);
                    } else {
                      setShowModpackUpdateModal(false);
                      setSelectedModpackVersion("");
                    }
                  }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink px-4 py-2 rounded-xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {showModpackUpdateOptions ? (lang === 'de' ? translations.de.back : translations.en.back) : (lang === 'de' ? translations.de.cancel : translations.en.cancel)}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

