import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Cloud,
  CloudOff,
  Download,
  FileText,
  X,
} from "lucide-react";
import { contentSyncService, ContentSyncStatus } from "../services/contentSync";

interface ContentSyncIndicatorProps {
  accentText?: string;
  badgeBg?: string;
}

export const ContentSyncIndicator = React.memo(function ContentSyncIndicator({
  accentText = "theme-text",
  badgeBg = "theme-bg-md theme-text theme-border-md",
}: ContentSyncIndicatorProps) {
  const [state, setState] = useState(contentSyncService.state);
  const [statuses, setStatuses] = useState<ContentSyncStatus[]>([]);
  const [progress, setProgress] = useState(contentSyncService.overallProgress);
  const [expanded, setExpanded] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  // Subscribe to service changes
  useEffect(() => {
    const unsub = contentSyncService.subscribe(() => {
      setState(contentSyncService.state);
      setStatuses(contentSyncService.statuses);
      setProgress(contentSyncService.overallProgress);
    });
    return unsub;
  }, []);

  const lastSync = contentSyncService.getLastSyncTime();
  const lastSyncStr = lastSync
    ? new Date(lastSync).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const isActive = state === "checking" || state === "syncing";
  const hasError = state === "error";
  const isComplete = state === "complete";
  const isIdle = state === "idle";

  // Aggregate counts
  const totalFiles = statuses.reduce((sum, s) => sum + s.total, 0);
  const completedFiles = statuses.reduce((sum, s) => {
    return sum + (s.total > 0 ? Math.round((s.progress / 100) * s.total) : 0);
  }, 0);
  const errorCount = statuses.filter((s) => s.status === "error").length;

  const getStatusIcon = () => {
    if (isActive) return <RefreshCw className={`w-3.5 h-3.5 ${accentText} animate-spin`} />;
    if (hasError) return <AlertCircle className="w-3.5 h-3.5 text-rose-400" />;
    if (isComplete || isIdle) return <Cloud className={`w-3.5 h-3.5 ${accentText}`} />;
    return <Cloud className="w-3.5 h-3.5 text-slate-400" />;
  };

  const getStatusText = () => {
    if (isActive && state === "checking") return "Prüfe Updates...";
    if (isActive && state === "syncing") return `Synchronisiere... ${progress}%`;
    if (hasError) return `${errorCount} Fehler` + (totalFiles > 0 ? ` (${completedFiles}/${totalFiles})` : "");
    if (isComplete) return "Alles aktuell";
    if (lastSyncStr) return `Stand: ${lastSyncStr}`;
    return "Bereit";
  };

  return (
    <div className="relative">
      {/* Main trigger button */}
      <button
        onClick={() => setShowDetail(!showDetail)}
        disabled={isActive}
        className={`flex items-center gap-1.5 text-[10px] font-bold transition-all cursor-pointer ${
          isActive
            ? "text-slate-500 cursor-wait"
            : hasError
            ? "text-rose-400 hover:text-rose-300"
            : "text-slate-400 hover:text-slate-200"
        }`}
        title={
          isActive
            ? "Sync läuft..."
            : lastSyncStr
            ? `Letzte Synchronisation: ${lastSyncStr}`
            : "Synchronisieren"
        }
      >
        {getStatusIcon()}
        <span>{getStatusText()}</span>

        {/* Download badge when updates available */}
        {!isActive && !hasError && totalFiles > 0 && completedFiles < totalFiles && (
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeBg}`}>
            {totalFiles - completedFiles}
          </span>
        )}
      </button>

      {/* Detail panel */}
      <AnimatePresence>
        {showDetail && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute bottom-full right-0 mb-2 w-80 bg-slate-950/95 backdrop-blur-xl border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden z-50"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-800/40">
              <div className="flex items-center gap-2">
                <Cloud className={`w-4 h-4 ${accentText}`} />
                <span className="text-xs font-black text-slate-200 tracking-wide">
                  Bamboo Cloud
                </span>
              </div>
              <button
                onClick={() => setShowDetail(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-300 transition-all cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Sync status per type */}
            <div className="p-3 max-h-60 overflow-y-auto custom-scrollbar">
              {statuses.length === 0 ? (
                <div className="flex flex-col items-center py-6 gap-2">
                  <CloudOff className="w-8 h-8 text-slate-700" />
                  <span className="text-[10px] text-slate-500 font-medium">
                    Noch nicht synchronisiert
                  </span>
    
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {statuses.map((s) => (
                    <div
                      key={s.typeSlug}
                      className={`rounded-xl p-2.5 border transition-all ${
                        s.status === "error"
                          ? "bg-rose-500/5 border-rose-500/15"
                          : s.status === "downloading" || s.status === "verifying" || s.status === "checking"
                          ? "bg-sky-500/5 border-sky-500/15"
                          : s.status === "complete"
                          ? "bg-emerald-500/5 border-emerald-500/10"
                          : "bg-slate-900/30 border-slate-800/40"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-slate-200">
                            {s.typeName}
                          </span>          {typeof s.version === "number" && s.version > 0 && (
            <span className="text-[8px] font-mono text-slate-500">
              v{s.version}
            </span>
          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {s.status === "downloading" && (
                            <Download className="w-3 h-3 text-sky-400" />
                          )}
                          {s.status === "verifying" && (
                            <FileText className="w-3 h-3 text-amber-400" />
                          )}
                          {s.status === "complete" && (
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          )}
                          {s.status === "error" && (
                            <AlertCircle className="w-3 h-3 text-rose-400" />
                          )}
                        </div>
                      </div>

                      {/* Progress bar */}
                      {(s.status === "downloading" || s.status === "verifying") && (
                        <div className="mt-1.5">
                          <div className="w-full h-1 bg-slate-800/60 rounded-full overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${s.progress}%` }}
                              transition={{ duration: 0.3 }}
                              className={`h-full rounded-full ${
                                s.status === "verifying"
                                  ? "bg-amber-500"
                                  : "bg-sky-500"
                              }`}
                            />
                          </div>
                          {s.currentFile && (
                            <p className="text-[8px] text-slate-500 mt-1 truncate max-w-[250px]">
                              {s.currentFile}
                            </p>
                          )}
                          {s.total > 0 && (
                            <p className="text-[8px] text-slate-500 mt-0.5">
                              {Math.round((s.progress / 100) * s.total)} /{" "}
                              {s.total} Dateien
                            </p>
                          )}
                        </div>
                      )}

                      {/* Error message */}
                      {s.status === "error" && s.error && (
                        <p className="text-[8px] text-rose-400 mt-1 leading-relaxed">
                          {s.error.length > 80
                            ? s.error.slice(0, 80) + "..."
                            : s.error}
                        </p>
                      )}

                      {/* Idle status */}
                      {s.status === "idle" && (
                        <p className="text-[8px] text-slate-500 mt-1">
                          {s.currentFile || "Keine Änderungen"}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>


          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export default ContentSyncIndicator;
