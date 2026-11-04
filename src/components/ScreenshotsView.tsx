import React, { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  Trash2,
  Copy,
  Download,
  ChevronLeft,
  ChevronRight,
  X,
  Calendar,
  ExternalLink,
  Maximize2,
  RefreshCw,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";
import { MOTION, EASE, motionSafe, staggerDelay } from "../lib/motionTokens";

interface ScreenshotsViewProps {
  setActiveTab: (tab: TabType) => void;
  lang: LanguageType;
}

function screenshotDate(timestamp: number, lang: LanguageType, withTime = false): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return lang === "de" ? "Unbekanntes Datum" : "Unknown date";
  return date.toLocaleString(lang === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export const ScreenshotsView: React.FC<ScreenshotsViewProps> = ({ lang }) => {
  const t = translations[lang];
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    item: ScreenshotItem;
    x: number;
    y: number;
  } | null>(null);

  const loadScreenshotImages = useCallback(async (items: ScreenshotItem[]) => {
    if (items.length === 0) return;
    const urls: Record<string, string> = {};
    const batchSize = 5;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map(async (sc) => {
        if (sc.absolutePath && !urls[sc.id]) {
          try {
            const dataUrl = await window.electronAPI?.dialogs.readImage?.(sc.absolutePath);
            if (dataUrl) urls[sc.id] = dataUrl;
          } catch { console.warn('[Screenshots] Failed to load screenshot'); }
        }
      }));
      setImageDataUrls(prev => ({ ...prev, ...urls }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI?.screenshots.collect?.();
        if (cancelled) return;
        const items = Array.isArray(result) ? result : [];
        setScreenshots(items);
        setImageDataUrls({});
        setIsLoading(false);
        void loadScreenshotImages(items);
      } catch (err) {
        if (cancelled) return;
        console.error("[Screenshots] Failed to load:", err);
        setLoadError(err instanceof Error ? err.message : "Screenshots konnten nicht geladen werden");
        setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadScreenshotImages, reloadToken]);

  const handleDelete = async (item: ScreenshotItem) => {
    if (!item.absolutePath) return;
    setContextMenu(null);
    try {
      const ok = await window.electronAPI?.screenshots.delete?.({
        absolutePath: item.absolutePath,
        sourceAbsolutePath: item.sourceAbsolutePath,
      });
      if (ok) {
        setScreenshots(prev => prev.filter(s => s.id !== item.id));
        setImageDataUrls(prev => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        setLightboxIndex(null);
      } else {
        alert(lang === "de" ? "Löschen fehlgeschlagen oder Datei nicht erlaubt." : "Delete failed or file not allowed.");
      }
    } catch (err) {
      console.error("[Screenshots] Delete failed:", err);
      alert(lang === "de" ? "Screenshot konnte nicht gelöscht werden." : "Screenshot could not be deleted.");
    }
  };

  const openContextMenu = (event: React.MouseEvent, item: ScreenshotItem) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 196;
    const height = 56;
    const margin = 8;
    setContextMenu({
      item,
      x: Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin)),
    });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const handleCopyPath = async (item: ScreenshotItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.absolutePath);
    } catch {
      window.electronAPI?.system.copy?.(item.absolutePath);
    }
  };

  const handleDownload = async (item: ScreenshotItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const dataUrl = await window.electronAPI?.dialogs.readImage?.(item.absolutePath);
      if (!dataUrl) return;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = item.fileName || `${item.title}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error("[Screenshots] Download failed:", err);
    }
  };

  const handleOpenFolder = () => {
    window.electronAPI?.screenshots.openFolder?.();
  };

  const navigateLightbox = (direction: "prev" | "next") => {
    if (lightboxIndex === null || screenshots.length === 0) return;
    if (direction === "prev") {
      setLightboxIndex(lightboxIndex === 0 ? screenshots.length - 1 : lightboxIndex - 1);
    } else {
      setLightboxIndex(lightboxIndex === screenshots.length - 1 ? 0 : lightboxIndex + 1);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface border border-hairline rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl theme-bg-light theme-border-light flex items-center justify-center">
            <Camera className="w-6 h-6 theme-text" />
          </div>
          <div>
            <h2 className="text-title2 font-semibold text-ink flex items-center gap-2">
              {t.screenshots}
            </h2>
            <p className="text-small text-ink-secondary mt-1">
              {lang === "de"
                ? "Sammelt Screenshots aus ALLEN Instanzen und Welten in einem zentralen Ordner."
                : "Collects screenshots from ALL instances and worlds into one central folder."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              setIsLoading(true);
              setLoadError(null);
              setReloadToken((token) => token + 1);
            }}
            disabled={isLoading}
            className="bg-surface hover:bg-hover text-ink border border-stroke hover:border-rim px-4 py-2.5 rounded-2xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            title={lang === "de" ? "Neu scannen" : "Rescan"}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            {lang === "de" ? "Neu laden" : "Refresh"}
          </button>
          <button
            onClick={handleOpenFolder}
            className="theme-bg hover:theme-bg-hover text-accent-contrast px-4 py-2.5 rounded-2xl text-small font-medium theme-shadow-lg hover:theme-shadow-lg transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] flex items-center gap-2 cursor-pointer hover:-translate-y-px"
          >
            <FolderOpen className="w-4 h-4 stroke-[3]" />
            {lang === "de" ? "Screenshots-Ordner" : "Screenshots Folder"}
            <ExternalLink className="w-3.5 h-3.5 opacity-70" />
          </button>
        </div>
      </div>

      {!isLoading && !loadError && (
        <div className="flex items-center gap-2 text-micro font-medium text-ink-tertiary uppercase px-2 tracking-label">
          <ImageIcon className="w-3 h-3" />
          {`${screenshots.length} Screenshots`}
        </div>
      )}

      {loadError && (
        <div className="bg-danger/10 border border-danger/20 rounded-2xl p-4 text-danger text-small font-medium">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
        <AnimatePresence mode="popLayout">
          {screenshots.map((sc, index) => (
            <motion.div
              key={sc.id}
              layout
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={motionSafe({ duration: MOTION.slow, delay: staggerDelay(index), ease: EASE.out })}
              onClick={() => setLightboxIndex(index)}
              onContextMenu={(event) => openContextMenu(event, sc)}
              title={lang === "de" ? "Rechtsklick zum Löschen" : "Right-click to delete"}
              className="group relative overflow-hidden rounded-3xl bg-surface border border-hairline hover:border-rim hover:shadow-2xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] duration-[var(--t-base)] ease-[var(--ease-out)] cursor-pointer shadow-lg"
            >
              <div className="relative aspect-video overflow-hidden bg-root/40">
                <img
                  src={imageDataUrls[sc.id] || ''}
                  alt={screenshotDate(sc.date, lang)}
                  loading="lazy"
                  className={`w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-[var(--t-out)] ease-[var(--ease-out)] ${imageDataUrls[sc.id] ? '' : 'opacity-40'}`}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-root/90 via-root/10 to-transparent opacity-90" />

                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--t-base)] ease-[var(--ease-out)]">
                  <div className="w-12 h-12 rounded-2xl theme-bg text-accent-contrast flex items-center justify-center shadow-2xl transition-transform duration-[var(--t-base)] ease-[var(--ease-out)] hover:scale-110">
                    <Maximize2 className="w-5 h-5 stroke-[2.5]" />
                  </div>
                </div>

                <div className="absolute inset-x-0 bottom-0 p-4 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-white/70" />
                  <span className="text-small font-medium text-white drop-shadow-sm">
                    {screenshotDate(sc.date, lang)}
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isLoading && screenshots.length === 0 && (
          <div className="col-span-full py-16 text-center flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
              <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
            <p className="text-regular font-medium text-ink">
              {lang === "de" ? "Screenshots werden gesammelt..." : "Collecting screenshots..."}
            </p>
          </div>
        )}

        {!isLoading && screenshots.length === 0 && !loadError && (
          <div className="col-span-full py-16 text-center flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
              <Camera className="w-8 h-8" />
            </div>
            <p className="text-regular font-medium text-ink">
              {lang === "de" ? "Keine Screenshots gefunden" : "No screenshots found"}
            </p>
            <p className="text-small text-ink-tertiary max-w-md">
              {lang === "de"
                ? "Drücke F2 in Minecraft, um Screenshots aufzunehmen. Sie erscheinen hier automatisch."
                : "Press F2 in Minecraft to take screenshots. They'll appear here automatically."}
            </p>
          </div>
        )}
      </div>

      {createPortal(
      <AnimatePresence>
        {lightboxIndex !== null && screenshots[lightboxIndex] && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
            className="fixed inset-0 z-[120] flex flex-col select-none pt-[42px]"
            style={{ backgroundColor: "color-mix(in srgb, var(--bg-base, #0b0d0b) 97%, transparent)" }}
            onClick={() => setLightboxIndex(null)}
          >
            <div
              className="relative z-50 flex w-full shrink-0 flex-col gap-3 px-6 py-4 pointer-events-auto sm:flex-row sm:items-center sm:justify-between"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="min-w-0 text-left sm:max-w-[60%]">
                <h3 className="text-large font-semibold text-ink truncate">
                  {screenshotDate(screenshots[lightboxIndex].date, lang, true)}
                </h3>
                <span className="text-small text-ink-secondary">
                  {screenshots[lightboxIndex].dimensions} • {screenshots[lightboxIndex].sizeStr}
                </span>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  onClick={(e) => handleCopyPath(screenshots[lightboxIndex], e)}
                  className="bg-surface hover:bg-hover border border-stroke p-2.5 rounded-xl text-ink-secondary hover:text-ink transition-colors cursor-pointer flex items-center gap-1.5 text-small font-medium"
                >
                  <Copy className="w-4 h-4" />
                  {lang === "de" ? "Pfad" : "Path"}
                </button>
                <button
                  onClick={(e) => handleDownload(screenshots[lightboxIndex], e)}
                  className="theme-bg hover:theme-bg-hover text-accent-contrast p-2.5 rounded-xl transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer flex items-center gap-1.5 text-small font-medium theme-shadow-lg"
                >
                  <Download className="w-4 h-4" />
                  {lang === "de" ? "Download" : "Download"}
                </button>
                <button
                  onClick={() => setLightboxIndex(null)}
                  className="bg-surface hover:bg-danger/20 border border-stroke hover:border-danger/30 p-2.5 rounded-xl text-ink-secondary hover:text-danger transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="relative flex min-h-0 w-full flex-1 items-center justify-center px-6 pb-6">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigateLightbox("prev");
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 w-14 h-14 rounded-2xl bg-surface/60 hover:bg-selected border border-stroke text-ink-secondary hover:text-ink flex items-center justify-center transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer z-50"
              >
                <ChevronLeft className="w-8 h-8" />
              </button>

              <motion.div
                key={lightboxIndex}
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.95, transition: motionSafe({ duration: MOTION.instant, ease: EASE.out }) }}
                transition={motionSafe({ duration: MOTION.base, ease: EASE.out })}
                className="flex h-full w-full max-w-5xl items-center justify-center p-4 z-40 pointer-events-none"
              >
                <img
                  src={imageDataUrls[screenshots[lightboxIndex].id] || ''}
                  alt={screenshotDate(screenshots[lightboxIndex].date, lang)}
                  className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-stroke pointer-events-auto"
                />
              </motion.div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigateLightbox("next");
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 w-14 h-14 rounded-2xl bg-surface/60 hover:bg-selected border border-stroke text-ink-secondary hover:text-ink flex items-center justify-center transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer z-50"
              >
                <ChevronRight className="w-8 h-8" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
      )}

      <AnimatePresence>
        {contextMenu && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60]"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={motionSafe({ duration: MOTION.instant, ease: EASE.out })}
              className="absolute min-w-[176px] p-1.5 rounded-xl border border-hairline bg-surface shadow-2xl"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleDelete(contextMenu.item)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-small font-medium text-ink-secondary hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                {lang === "de" ? "Löschen" : "Delete"}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
