import React, { useEffect, useState, useCallback } from "react";
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
  HardDrive,
  ExternalLink,
  Maximize2,
  RefreshCw,
  FolderOpen,
  ImageIcon,
} from "lucide-react";
import { TabType } from "./Sidebar";
import { translations, LanguageType } from "../lib/translations";

interface ScreenshotItem {
  id: string;
  title: string;
  fileName: string;
  source: string;
  instance: string;
  world: string | null;
  date: number;
  sizeBytes: number;
  sizeStr: string;
  dimensions: string;
  url: string;
  absolutePath: string;
  sourceAbsolutePath: string;
}

interface ScreenshotsViewProps {
  setActiveTab: (tab: TabType) => void;
  lang: LanguageType;
}

export const ScreenshotsView: React.FC<ScreenshotsViewProps> = ({ lang }) => {
  const t = translations[lang];
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([]);
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});
  const [loadingImages, setLoadingImages] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Load screenshot image data URLs in batches via IPC (bypasses broken bamboo-file protocol)
  const loadScreenshotImages = useCallback(async (items: ScreenshotItem[]) => {
    if (items.length === 0) return;
    setLoadingImages(true);
    const urls: Record<string, string> = {};
    const batchSize = 5;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map(async (sc) => {
        if (sc.absolutePath && !urls[sc.id]) {
          try {
            const dataUrl = await window.electronAPI?.readImageFile?.(sc.absolutePath);
            if (dataUrl) urls[sc.id] = dataUrl;
          } catch { console.warn('[Screenshots] Failed to load screenshot'); }
        }
      }));
      // Progressive update: show images as batches load
      setImageDataUrls(prev => ({ ...prev, ...urls }));
    }
    setLoadingImages(false);
  }, []);

  const loadScreenshots = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setImageDataUrls({});
    try {
      const result = await window.electronAPI?.collectAllScreenshots?.();
      const items = Array.isArray(result) ? result : [];
      setScreenshots(items);
      // Start loading images in background
      loadScreenshotImages(items);
    } catch (err: any) {
      console.error("[Screenshots] Failed to load:", err);
      setLoadError(err?.message || "Screenshots konnten nicht geladen werden");
    } finally {
      setIsLoading(false);
    }
  }, [loadScreenshotImages]);

  useEffect(() => {
    loadScreenshots();
  }, [loadScreenshots]);

  const handleDelete = async (item: ScreenshotItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.absolutePath) return;
    try {
      const ok = await window.electronAPI?.deleteScreenshotFile?.({
        absolutePath: item.absolutePath,
        sourceAbsolutePath: item.sourceAbsolutePath,
      });
      if (ok) {
        setScreenshots(prev => prev.filter(s => s.id !== item.id));
        if (lightboxIndex !== null) setLightboxIndex(null);
      } else {
        alert(lang === "de" ? "Löschen fehlgeschlagen oder Datei nicht erlaubt." : "Delete failed or file not allowed.");
      }
    } catch (err) {
      console.error("[Screenshots] Delete failed:", err);
    }
  };

  const handleCopyPath = async (item: ScreenshotItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.absolutePath);
    } catch {
      // Fallback: use IPC clipboard
      window.electronAPI?.copyToClipboard?.(item.absolutePath);
    }
  };

  const handleDownload = async (item: ScreenshotItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Reuse the readImageFile IPC to get a data URL, then trigger download
      const dataUrl = await window.electronAPI?.readImageFile?.(item.absolutePath);
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
    window.electronAPI?.openScreenshotsFolder?.();
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
      {/* Header Panel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl theme-bg-light theme-border-light flex items-center justify-center">
            <Camera className="w-6 h-6 theme-text" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide flex items-center gap-2">
              {t.screenshots}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {lang === "de"
                ? "Sammelt Screenshots aus ALLEN Instanzen und Welten in einem zentralen Ordner."
                : "Collects screenshots from ALL instances and worlds into one central folder."}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={loadScreenshots}
            disabled={isLoading}
            className="bg-slate-900 hover:bg-slate-850 text-slate-300 border border-slate-800 hover:border-slate-700 px-4 py-2.5 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            title={lang === "de" ? "Neu scannen" : "Rescan"}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            {lang === "de" ? "Neu laden" : "Refresh"}
          </button>
          <button
            onClick={handleOpenFolder}
            className="theme-bg hover:theme-bg-hover text-slate-950 px-4 py-2.5 rounded-2xl text-xs font-black tracking-wide theme-shadow-lg hover:theme-shadow-lg transition-all duration-300 flex items-center gap-2 cursor-pointer hover:-translate-y-0.5"
          >
            <FolderOpen className="w-4 h-4 stroke-[3]" />
            {lang === "de" ? "Screenshots-Ordner" : "Screenshots Folder"}
            <ExternalLink className="w-3.5 h-3.5 opacity-70" />
          </button>
        </div>
      </div>

      {/* Status bar */}
      {!isLoading && !loadError && (
        <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest px-2">
          <ImageIcon className="w-3 h-3" />
          {lang === "de"
            ? `${screenshots.length} Screenshots aus allen Instanzen`
            : `${screenshots.length} screenshots from all instances`}
        </div>
      )}

      {loadError && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-2xl p-4 text-rose-400 text-xs font-bold">
          {loadError}
        </div>
      )}

      {/* Screenshots Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <AnimatePresence mode="popLayout">
          {screenshots.map((sc, index) => (
            <motion.div
              key={sc.id}
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.25, delay: Math.min(index * 0.02, 0.4) }}
              onClick={() => setLightboxIndex(index)}
              className="bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-4 flex flex-col justify-between group hover:theme-border-md hover:shadow-2xl transition-all duration-300 relative overflow-hidden cursor-pointer"
            >
              {/* Image Preview */}
              <div className="h-44 rounded-2xl overflow-hidden relative border border-slate-900 shrink-0 bg-slate-900/40">
                <img
                  src={imageDataUrls[sc.id] || ''}
                  alt={sc.title}
                  loading="lazy"
                  className={`w-full h-full object-cover group-hover:scale-103 transition-transform duration-500 ${imageDataUrls[sc.id] ? '' : 'opacity-40'}`}
                />
                <div className="absolute inset-0 bg-slate-950/40 group-hover:bg-slate-950/20 transition-colors" />

                {/* Maximize Icon Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <div className="w-12 h-12 rounded-2xl theme-bg text-slate-950 flex items-center justify-center shadow-2xl transition-transform duration-300 hover:scale-110">
                    <Maximize2 className="w-5 h-5 stroke-[2.5]" />
                  </div>
                </div>

                {/* Source badge (instance name instead of file name) */}
                <span className="absolute bottom-3 left-3 text-[9px] font-extrabold px-2 py-0.5 rounded-md border uppercase tracking-wider bg-slate-950/85 theme-text theme-border-md backdrop-blur-sm max-w-[calc(100%-1.5rem)] truncate">
                  {sc.instance || sc.source}
                </span>

                {/* Dimensions Badge */}
                <span className="absolute top-3 right-3 text-[9px] font-extrabold px-2 py-0.5 rounded-md border uppercase tracking-wider bg-slate-950/80 text-slate-300 border-slate-800">
                  {sc.dimensions}
                </span>
              </div>

              {/* Title & Metadata */}
              <div className="mt-4 flex-1 flex flex-col justify-between text-left">
                <div>
                  <h3
                    className="text-sm font-black text-slate-100 group-hover:theme-text-bright transition-colors tracking-wide truncate"
                    title={sc.title}
                  >
                    {sc.title}
                  </h3>

                  <div className="grid grid-cols-2 gap-2 mt-3 text-[11px] text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-slate-500" />
                      <span className="truncate">
                        {new Date(sc.date).toLocaleDateString(
                          lang === "de" ? "de-DE" : "en-US",
                          { day: "numeric", month: "short", year: "numeric" }
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 justify-end">
                      <HardDrive className="w-3.5 h-3.5 text-slate-500" />
                      <span>{sc.sizeStr}</span>
                    </div>
                  </div>
                </div>

                {/* Action Row */}
                <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-slate-900">
                  <span
                    className="text-[10px] theme-text font-bold truncate max-w-[120px]"
                    title={sc.instance || sc.source}
                  >
                    {sc.instance || sc.source}
                  </span>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => handleCopyPath(sc, e)}
                      className="p-2 bg-slate-900/40 hover:bg-slate-800/60 border border-slate-850 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer"
                      title={lang === "de" ? "Pfad kopieren" : "Copy path"}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDownload(sc, e)}
                      className="p-2 bg-slate-900/40 hover:bg-slate-800/60 border border-slate-850 hover:border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all cursor-pointer"
                      title={lang === "de" ? "Herunterladen" : "Download"}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(sc, e)}
                      className="p-2 bg-slate-900/40 hover:bg-rose-500/10 border border-slate-850 hover:border-rose-500/20 text-slate-400 hover:text-rose-400 rounded-lg transition-all cursor-pointer"
                      title={lang === "de" ? "Löschen" : "Delete"}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isLoading && screenshots.length === 0 && (
          <div className="col-span-full py-16 text-center flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400">
              <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
            <p className="text-sm font-bold text-slate-300">
              {lang === "de" ? "Screenshots werden gesammelt..." : "Collecting screenshots..."}
            </p>
          </div>
        )}

        {!isLoading && screenshots.length === 0 && !loadError && (
          <div className="col-span-full py-16 text-center flex flex-col items-center justify-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400">
              <Camera className="w-8 h-8" />
            </div>
            <p className="text-sm font-bold text-slate-300">
              {lang === "de" ? "Keine Screenshots gefunden" : "No screenshots found"}
            </p>
            <p className="text-xs text-slate-500 max-w-md">
              {lang === "de"
                ? "Drücke F2 in Minecraft, um Screenshots aufzunehmen. Sie erscheinen hier automatisch."
                : "Press F2 in Minecraft to take screenshots. They'll appear here automatically."}
            </p>
          </div>
        )}
      </div>

      {/* FULL SCREEN LIGHTBOX MODAL */}
      <AnimatePresence>
        {lightboxIndex !== null && screenshots[lightboxIndex] && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 z-50 select-none"
            onClick={() => setLightboxIndex(null)}
          >
            {/* Top Bar Actions */}
            <div
              className="absolute top-6 left-6 right-6 flex items-center justify-between z-50 pointer-events-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-left max-w-[60%]">
                <h3 className="text-lg font-black text-white tracking-wide truncate">
                  {screenshots[lightboxIndex].title}
                </h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] font-extrabold theme-text theme-bg-light theme-border-light px-2 py-0.5 rounded uppercase tracking-wider">
                    {screenshots[lightboxIndex].source}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(screenshots[lightboxIndex].date).toLocaleString(
                      lang === "de" ? "de-DE" : "en-US"
                    )} • {screenshots[lightboxIndex].dimensions} •{" "}
                    {screenshots[lightboxIndex].sizeStr}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => handleCopyPath(screenshots[lightboxIndex], e)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-800 p-2.5 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-bold"
                >
                  <Copy className="w-4 h-4" />
                  {lang === "de" ? "Pfad" : "Path"}
                </button>
                <button
                  onClick={(e) => handleDownload(screenshots[lightboxIndex], e)}
                  className="theme-bg hover:theme-bg-hover text-slate-950 p-2.5 rounded-xl transition-all cursor-pointer flex items-center gap-1.5 text-xs font-bold theme-shadow-lg"
                >
                  <Download className="w-4 h-4" />
                  {lang === "de" ? "Download" : "Download"}
                </button>
                <button
                  onClick={() => setLightboxIndex(null)}
                  className="bg-slate-900 hover:bg-rose-500/20 border border-slate-800 hover:border-rose-500/30 p-2.5 rounded-xl text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Left Nav Arrow */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigateLightbox("prev");
              }}
              className="absolute left-6 w-14 h-14 rounded-2xl bg-slate-900/60 hover:bg-slate-800/80 border border-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-all cursor-pointer z-50"
            >
              <ChevronLeft className="w-8 h-8" />
            </button>

            {/* Image Container */}
            <motion.div
              key={lightboxIndex}
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="max-w-5xl max-h-[70vh] w-full h-full flex items-center justify-center p-4 z-40 pointer-events-none"
            >
              <img
                src={imageDataUrls[screenshots[lightboxIndex].id] || ''}
                alt={screenshots[lightboxIndex].title}
                className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-slate-800 pointer-events-auto"
              />
            </motion.div>

            {/* Right Nav Arrow */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigateLightbox("next");
              }}
              className="absolute right-6 w-14 h-14 rounded-2xl bg-slate-900/60 hover:bg-slate-800/80 border border-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-all cursor-pointer z-50"
            >
              <ChevronRight className="w-8 h-8" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
