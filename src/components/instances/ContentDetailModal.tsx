import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Download,
  Globe,
  Image,
  Layers,
  Lock,
  Package,
  RefreshCw,
  Shirt,
  Trash2,
  X,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { categoryForTab, installItemTypeFor } from '../../lib/contentCategories'
import { toCurseForgeFailure } from '../../lib/curseforge'
import { createDescriptionSanitizer, renderDescription } from '../../lib/descriptionHtml'
import { instanceFolderKeyOf as instanceFolderKey } from '../../lib/instanceFolders'
import { isVersionCompatible, versionFileFor } from '../../lib/modVersions'
import { LAUNCHER_VERSION } from '../../lib/version'
import { EASE, MOTION, motionSafe } from '../../lib/motionTokens'
import { formatMessage, translations, type LanguageType } from '../../lib/translations'
import type { DownloadModPayload } from '../../electron'
import { useToast } from '../Toast'
import { ExternalMark } from './ContentActionIcons'
import { contentProjectUrl, fetchContentVersions } from './contentDetailModel'
import type { ContentItem, Instance } from '../InstancesView'

/** Third-party descriptions are untrusted; the same sanitizer guards them here and in the browser. */
const sanitizeDescription = createDescriptionSanitizer(DOMPurify);

export const ContentDetailModal = ({
  item,
  onClose,
  localInst,
  setInstances,
  lang,
}: {
  item: ContentItem;
  onClose: () => void;
  localInst: Instance;
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  lang: LanguageType;
}) => {
  const { addToast } = useToast();
  const t = translations[lang];

  const handleDelete = async () => {
    if (item.fileName) {
      const folderName = instanceFolderKey(localInst);
      const typeDir = categoryForTab(item.type);
      try {
        await window.electronAPI?.mods.deleteContentFile?.({ folderName, fileName: item.fileName, type: typeDir });
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
            modCount: item.type === 'mods' ? Math.max(0, (i.modCount || 0) - 1) : i.modCount,
          }
        : i
    ));
    onClose();
  };

  const [showVersionPicker, setShowVersionPicker] = useState(false);
  const [availableVersions, setAvailableVersions] = useState<{
    version_number: string
    date_published: string
    url: string
    filename: string
    isCompatible: boolean
    curseforgeFileId?: number
  }[]>([]);
  const [fetchingVersions, setFetchingVersions] = useState(false);
  const [installingVersion, setInstallingVersion] = useState(false);
  const [installPercent, setInstallPercent] = useState(0);
  const [description, setDescription] = useState("");
  const [descriptionFormat, setDescriptionFormat] = useState<"markdown" | "html">("markdown");
  const [loadingDescription, setLoadingDescription] = useState(false);
  const [projectSlug, setProjectSlug] = useState("");

  // A single file download has no real progress events, so the display eases
  // towards 90% and only reaches 100% when the install actually succeeded.
  useEffect(() => {
    if (!installingVersion) return;
    const timer = window.setInterval(() => {
      setInstallPercent(current => current >= 90 ? current : Math.min(90, current + Math.max(1, Math.round((90 - current) / 8))));
    }, 220);
    return () => window.clearInterval(timer);
  }, [installingVersion]);

  // The saved content entry only names the file. The store project holds the
  // description and the canonical page, fetched once when the details open.
  useEffect(() => {
    const projectId = item.projectId;
    const source = item.source;
    if (!projectId || !source) return;
    let cancelled = false;
    void (async () => {
      setDescription("");
      setProjectSlug("");
      setLoadingDescription(true);
      try {
        if (source === "curseforge") {
          const project = await window.electronAPI?.mods.curseforgeProject?.(projectId);
          if (cancelled || !project || toCurseForgeFailure(project) || !("name" in project)) return;
          setDescription(project.fullDescription || project.description || project.summary || "");
          setDescriptionFormat("html");
          if (project.slug) setProjectSlug(project.slug);
        } else {
          const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}`, {
            headers: { "User-Agent": `BambooLauncher/${LAUNCHER_VERSION}` },
          });
          if (!res.ok) return;
          const project = await res.json() as { body?: unknown; description?: unknown; slug?: unknown };
          if (cancelled) return;
          const body = typeof project.body === "string" ? project.body.trim() : "";
          setDescription(body || (typeof project.description === "string" ? project.description : ""));
          setDescriptionFormat("markdown");
          if (typeof project.slug === "string") setProjectSlug(project.slug);
        }
      } catch {
        // The facts and actions stay usable when the store cannot be reached.
      } finally {
        if (!cancelled) setLoadingDescription(false);
      }
    })();
    return () => { cancelled = true; };
  }, [item.projectId, item.source]);

  const typeLabel = item.type === "resourcepacks"
    ? t.projectTypeResourcePacks
    : item.type === "shaderpacks"
      ? t.projectTypeShaders
      : item.type === "datapacks"
        ? t.projectTypeDataPacks
        : item.type === "worlds"
          ? t.projectTypeWorlds
          : t.projectTypeMods;
  const sourceLabel = item.source === "curseforge"
    ? "CurseForge"
    : item.source === "modrinth"
      ? "Modrinth"
      : t.localVersion;
  const projectUrl = contentProjectUrl(item, projectSlug);

  const handleFetchVersions = async () => {
    if (!item.projectId || !item.source) return;
    setFetchingVersions(true);
    try {
      // Same selector as the browser and the update run: the listed file is the
      // one that gets installed, and "compatible" means MC version AND loader.
      const category = categoryForTab(item.type);
      const criteria = {
        category,
        minecraftVersion: localInst.minecraftVersion,
        modloader: localInst.modloader,
      };
      const versions = (await fetchContentVersions(item))
        .map((version) => {
          const file = versionFileFor(version, category);
          if (!file) return null;
          const fileId = item.source === 'curseforge' ? Number(version.versionId) : NaN;
          return {
            version_number: version.versionNumber,
            date_published: version.published || '',
            url: file.url,
            filename: file.filename,
            isCompatible: isVersionCompatible(version, criteria),
            ...(Number.isFinite(fileId) && fileId > 0 ? { curseforgeFileId: fileId } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      setAvailableVersions(versions);
      setShowVersionPicker(true);
    } catch (e) {
      console.error('[ContentDetailModal] Fehler beim Abrufen der Versionen:', e);
    } finally {
      setFetchingVersions(false);
    }
  };

  const handleSwitchVersion = async (ver: {
    version_number: string
    url: string
    filename: string
    isCompatible: boolean
    curseforgeFileId?: number
  }) => {
    setInstallPercent(8);
    setInstallingVersion(true);
    try {
      const folderName = instanceFolderKey(localInst);
      const category = categoryForTab(item.type);
      const typeDir = category;

      const payload: DownloadModPayload = {
        folderName,
        profileName: localInst.name,
        versionId: localInst.minecraftVersion,
        filename: ver.filename,
        itemType: installItemTypeFor(category),
      };
      if (ver.curseforgeFileId) payload.curseforgeFileId = ver.curseforgeFileId;
      else payload.downloadUrl = ver.url;
      if (category === 'worlds') payload.title = item.name;

      // Version switch installs first and only then removes the recorded old
      // file, so a failed download never leaves the item without a file.
      const result = await window.electronAPI?.mods.download?.(payload);

      if (!result?.success) {
        addToast({ type: 'error', message: result?.error || t.versionChangeFailed });
        return;
      }

      if (item.fileName && item.fileName !== ver.filename) {
        try {
          await window.electronAPI?.mods.deleteContentFile?.({ folderName, fileName: item.fileName, type: typeDir });
        } catch (e) {
          console.warn('[ContentDetailModal] Alte Datei konnte nicht entfernt werden:', e);
        }
      }

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
      addToast({ type: 'success', message: formatMessage(t.versionChanged, { version: ver.version_number }) });
    } catch (e) {
      console.error('[ContentDetailModal] Fehler beim Version-Wechsel:', e);
      addToast({ type: 'error', message: t.versionChangeFailed });
    } finally {
      setInstallingVersion(false);
      setInstallPercent(0);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
        className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="bg-root border border-stroke/80 rounded-2xl w-full max-w-[460px] max-h-[calc(100vh-2rem)] overflow-hidden shadow-2xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 border-b border-hairline px-5 py-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stroke bg-surface">
              {item.iconUrl ? (
                <img src={item.iconUrl} alt={item.name} className="h-full w-full object-cover"
                     onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : item.type === "mods" ? <Package className="h-5 w-5 text-ink-secondary" /> :
                 item.type === "resourcepacks" ? <Image className="h-5 w-5 text-ink-secondary" /> :
                 item.type === "shaderpacks" ? <Shirt className="h-5 w-5 text-ink-secondary" /> :
                 item.type === "worlds" ? <Globe className="h-5 w-5 text-ink-secondary" /> :
                 <Layers className="h-5 w-5 text-ink-secondary" />}
            </div>
            <div className="min-w-0 flex-1 text-left">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-large font-semibold text-ink" title={item.name}>{item.name}</h3>
                <span className="shrink-0 rounded-md border border-hairline bg-root/70 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-ink-secondary">
                  {typeLabel}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-micro text-ink-tertiary" title={item.fileName}>{item.fileName}</p>
            </div>
            <button onClick={onClose} aria-label={lang === "de" ? "Schließen" : "Close"} className="shrink-0 cursor-pointer rounded-lg border border-stroke bg-surface p-2 text-ink-secondary transition-colors hover:bg-hover hover:text-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="custom-scrollbar flex flex-col gap-4 overflow-y-auto px-5 py-4 text-left">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t.version}</dt>
                <dd className="mt-0.5 truncate text-small font-medium text-ink">{item.versionNumber || item.version}</dd>
                {item.versionNumber && item.versionNumber !== item.version && (
                  <span className="mt-0.5 block truncate text-micro text-ink-tertiary">MC {item.version}</span>
                )}
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t.source}</dt>
                <dd className="mt-0.5 truncate text-small font-medium text-ink">{sourceLabel}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t.projectType}</dt>
                <dd className="mt-0.5 truncate text-small font-medium text-ink">{typeLabel}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">Status</dt>
                <dd className={`mt-0.5 flex items-center gap-1.5 text-small font-medium ${item.enabled ? "text-ink" : "text-warning"}`}>
                  {item.enabled ? t.enabledLabel : t.disabledLabel}
                  {item.locked && <Lock className="h-3 w-3 text-ink-tertiary" />}
                </dd>
              </div>
            </dl>

            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t.descriptionTab}</span>
                {loadingDescription && <RefreshCw className="h-3.5 w-3.5 animate-spin text-ink-tertiary" />}
              </div>
              {description ? (
                <div
                  className="mod-description mt-1.5 max-h-44 overflow-y-auto custom-scrollbar pr-2"
                  style={{ fontSize: 13, lineHeight: "19px" }}
                  onClick={(event) => {
                    const anchor = (event.target as HTMLElement).closest("a");
                    if (!anchor) return;
                    event.preventDefault();
                    const href = anchor.getAttribute("href") ?? "";
                    if (/^https?:\/\//i.test(href)) window.electronAPI?.system.openExternal?.(href);
                  }}
                  dangerouslySetInnerHTML={{ __html: renderDescription(description, descriptionFormat, sanitizeDescription) }}
                />
              ) : loadingDescription ? null : (
                <p className="mt-1.5 text-small text-ink-tertiary">{t.noDescriptionAvailable}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-surface/40 px-5 py-3">
            <button onClick={handleDelete} disabled={item.locked} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-danger/20 bg-danger/10 px-3 text-micro font-medium text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-30">
              <Trash2 className="h-3.5 w-3.5" />
              {t.delete}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {projectUrl && (
                <button onClick={() => window.electronAPI?.system.openExternal?.(projectUrl)} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-stroke bg-surface px-3 text-micro font-medium text-ink-secondary transition-colors hover:border-rim hover:text-ink">
                  <ExternalMark className="h-3.5 w-3.5" />
                  {lang === "de" ? "Im Browser öffnen" : "Open in browser"}
                </button>
              )}
              {item.projectId && item.source && (
                <button onClick={handleFetchVersions} disabled={fetchingVersions} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border theme-border-light theme-bg-light px-3 text-micro font-medium theme-text transition-colors hover:theme-bg-md disabled:opacity-50">
                  <RefreshCw className={`h-3.5 w-3.5 ${fetchingVersions ? "animate-spin" : ""}`} />
                  {t.changeVersion}
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      {showVersionPicker && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
          className="fixed inset-0 bg-root/80 flex items-center justify-center p-4 z-[60]"
          onClick={() => setShowVersionPicker(false)}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="bg-root border border-stroke/80 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-hairline flex items-center justify-between">
              <h3 className="text-large font-semibold text-ink">{formatMessage(t.changeVersionTitle, { name: item.name })}</h3>
              <button onClick={() => setShowVersionPicker(false)} className="bg-surface hover:bg-hover border border-stroke p-2 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 max-h-80 overflow-y-auto custom-scrollbar flex flex-col gap-2">
              {availableVersions.length === 0 ? (
                <p className="text-small text-ink-tertiary text-center py-8">{t.noProjectVersions}</p>
              ) : (
                availableVersions.map((ver) => (
                  <button
                    key={ver.version_number}
                    onClick={() => {
                      if (!ver.isCompatible) {
                        addToast({ type: 'warning', message: formatMessage(t.incompatibleWarningToast, { mc: localInst.minecraftVersion }) });
                      }
                      handleSwitchVersion(ver);
                    }}
                    disabled={installingVersion || ver.version_number === item.versionNumber}
                    className={`flex items-center justify-between bg-surface/30 hover:bg-raised border border-stroke rounded-xl px-4 py-3 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed text-left w-full ${
                      ver.version_number === item.versionNumber ? 'border-theme-text/30' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-regular font-medium text-ink truncate">{ver.version_number}</span>
                        {!ver.isCompatible && (
                          <span className="text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-1.5 py-0.5 rounded shrink-0">{t.notCompatibleShort}</span>
                        )}
                      </div>
                      <span className="text-micro text-ink-tertiary block mt-0.5">{new Date(ver.date_published).toLocaleDateString()}</span>
                    </div>
                    <div className="shrink-0 ml-3">
                      {ver.version_number === item.versionNumber ? (
                        <span className="text-micro theme-text font-medium">{lang === 'de' ? 'Installiert' : 'Installed'}</span>
                      ) : (
                        installingVersion ? (
                          <span className="flex items-center gap-1.5 text-micro font-medium tabular-nums theme-text">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            {installPercent}%
                          </span>
                        ) : (
                          <Download className="w-4 h-4 text-ink-secondary" />
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
