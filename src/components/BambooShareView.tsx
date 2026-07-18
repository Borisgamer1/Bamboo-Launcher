import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Share2,
  Copy,
  Check,
  Search,
  Loader2,
  Download,
  Clock,
  HardDrive,
  User,
  Package,
  Globe,
  ExternalLink,
  AlertTriangle,
  Trash2,
  RefreshCw,
  FileArchive,
} from "lucide-react";
import { LanguageType } from "../lib/translations";
import type { Instance } from "./InstancesView";
import { bambooShareService } from "../services/bambooShare";
import { ProfileImportModal } from "./ProfileImportModal";
import { useToast } from "./Toast";
import type { ShareInfo, ShareListEntry } from "../services/bambooShare";

interface BambooShareViewProps {
  lang: LanguageType;
  instances: Instance[];
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
}

export const BambooShareView: React.FC<BambooShareViewProps> = ({
  lang,
  instances,
  setInstances,
}) => {
  const t = (de: string, en: string) => (lang === "de" ? de : en);
  const { addToast } = useToast();

  // Code input
  const [codeInput, setCodeInput] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [validatedInfo, setValidatedInfo] = useState<ShareInfo | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importCode, setImportCode] = useState<string | null>(null);

  // My shares
  const [myShares, setMyShares] = useState<ShareListEntry[]>([]);
  const [isLoadingShares, setIsLoadingShares] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);

  // Stats
  const [stats, setStats] = useState<{
    totalShares: number;
    activeShares: number;
    totalDownloads: number;
    totalSizeBytes: number;
  } | null>(null);

  // Load stats on mount
  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const s = await bambooShareService.getStats();
      setStats(s);
    } catch {
      // Ignore - server might not be running
    }
  };

  const handleValidateCode = async () => {
    const code = codeInput.trim().toUpperCase();
    if (code.length < 4) return;

    setIsValidating(true);
    setValidationError(null);
    setValidatedInfo(null);

    try {
      const info = await bambooShareService.getShareInfo(code);
      setValidatedInfo(info);
      addToast({
        type: "success",
        message: t("Share gefunden!", "Share found!"),
      });
    } catch (err: any) {
      setValidationError(err.message);
    } finally {
      setIsValidating(false);
    }
  };

  const handleImportFromCode = (code: string) => {
    setImportCode(code);
    setShowImportModal(true);
  };

  const handleDeleteShare = async (code: string) => {
    try {
      await bambooShareService.deleteShare(code);
      setMyShares((prev) => prev.filter((s) => s.shareCode !== code));
      addToast({
        type: "success",
        message: t("Share gelöscht!", "Share deleted!"),
      });
    } catch (err: any) {
      addToast({
        type: "error",
        message: err.message,
      });
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const formatDate = (dateStr: string): string => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto h-full p-6 flex flex-col gap-6 custom-scrollbar z-10 relative select-none">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-950/45 backdrop-blur-xl border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Share2 className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white tracking-wide">
              {t("Bamboo Share", "Bamboo Share")}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {t(
                "Teile Profile mit eindeutigen Codes oder importiere Profile von anderen.",
                "Share profiles with unique codes or import profiles from others."
              )}
            </p>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="flex items-center gap-3">
            <StatBadge
              icon={Package}
              value={String(stats.activeShares)}
              label={t("Aktiv", "Active")}
            />
            <StatBadge
              icon={Download}
              value={String(stats.totalDownloads)}
              label={t("Downloads", "Downloads")}
            />
          </div>
        )}
      </div>

      {/* Code Input Section */}
      <div className="bg-gradient-to-br from-slate-900/60 to-slate-950/60 border border-slate-800/60 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Search className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white">
              {t("Share-Code eingeben", "Enter Share Code")}
            </h3>
            <p className="text-xs text-slate-400">
              {t(
                "Gib einen Bamboo Share Code ein, um ein Profil zu importieren.",
                "Enter a Bamboo Share code to import a profile."
              )}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={codeInput}
            onChange={(e) => {
              setCodeInput(e.target.value.toUpperCase());
              setValidatedInfo(null);
              setValidationError(null);
            }}
            placeholder="XXXXXXXX"
            maxLength={8}
            className="flex-1 bg-slate-950 border border-slate-700 focus:border-amber-500/50 rounded-2xl py-4 px-5 text-lg font-black text-slate-200 placeholder-slate-600 outline-none transition-all tracking-[0.3em] uppercase text-center"
            onKeyDown={(e) => e.key === "Enter" && handleValidateCode()}
          />
          <button
            onClick={handleValidateCode}
            disabled={codeInput.length < 4 || isValidating}
            className="bg-amber-500 hover:bg-amber-400 text-slate-950 px-8 py-4 rounded-2xl text-sm font-black transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-amber-500/10 hover:-translate-y-0.5 active:translate-y-0"
          >
            {isValidating ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Search className="w-5 h-5" />
            )}
            {t("Suchen", "Search")}
          </button>
        </div>

        {/* Validation Result */}
        <AnimatePresence>
          {validationError && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mt-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-rose-300">{validationError}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {t(
                    "Der Code ist möglicherweise abgelaufen oder ungültig.",
                    "The code may be expired or invalid."
                  )}
                </p>
              </div>
            </motion.div>
          )}

          {validatedInfo && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mt-4 bg-slate-900/60 border border-amber-500/20 rounded-2xl p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-sm font-black text-white truncate">{validatedInfo.title}</h4>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-lg">
                      {validatedInfo.minecraftVersion}
                    </span>
                    <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-lg">
                      {validatedInfo.modloader}
                    </span>
                    {validatedInfo.authorName !== "Unknown" && (
                      <span className="text-[10px] text-slate-400 flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {validatedInfo.authorName}
                      </span>
                    )}
                  </div>
                  {validatedInfo.description && (
                    <p className="text-xs text-slate-400 mt-2 line-clamp-2">{validatedInfo.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-3">
                    <span className="text-[10px] text-slate-500 flex items-center gap-1">
                      <Package className="w-3 h-3" />
                      {validatedInfo.modCount} {t("Mods", "Mods")}
                    </span>
                    <span className="text-[10px] text-slate-500 flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      {formatSize(validatedInfo.fileSize)}
                    </span>
                    <span className="text-[10px] text-slate-500 flex items-center gap-1">
                      <Download className="w-3 h-3" />
                      {validatedInfo.downloadCount} {t("Downloads", "Downloads")}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleImportFromCode(validatedInfo.shareCode)}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer flex items-center gap-2 shrink-0 shadow-lg shadow-emerald-500/10 hover:-translate-y-0.5"
                >
                  <Download className="w-4 h-4" />
                  {t("Importieren", "Import")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* What is Bamboo Share */}
      <div className="bg-slate-950/30 border border-slate-800/60 rounded-3xl p-6">
        <h3 className="text-sm font-black text-slate-200 mb-3">
          {t("Was ist Bamboo Share?", "What is Bamboo Share?")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              icon: Share2,
              title: t("Code teilen", "Share a Code"),
              desc: t(
                "Exportiere eine Instanz und erstelle einen eindeutigen Share-Code zum Teilen.",
                "Export an instance and create a unique share code to share."
              ),
            },
            {
              icon: Search,
              title: t("Code eingeben", "Enter a Code"),
              desc: t(
                "Gib einen Share-Code ein, um eine Vorschau zu sehen und zu importieren.",
                "Enter a share code to see a preview and import."
              ),
            },
            {
              icon: Download,
              title: t("Automatisch importieren", "Auto-Import"),
              desc: t(
                "Der Launcher lädt alle benötigten Daten herunter und installiert sie.",
                "The launcher downloads and installs all required data."
              ),
            },
          ].map((item, i) => {
            const Icon = item.icon;
            return (
              <div key={i} className="bg-slate-900/30 border border-slate-800/60 rounded-2xl p-4 text-left">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-3">
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-black text-slate-200 mb-1">{item.title}</h4>
                <p className="text-[10px] text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Import Modal */}
      <ProfileImportModal
        isOpen={showImportModal}
        onClose={() => {
          setShowImportModal(false);
          setImportCode(null);
          setCodeInput("");
          setValidatedInfo(null);
        }}
        instances={instances}
        setInstances={setInstances}
        lang={lang}
        initialCode={importCode || undefined}
      />
    </div>
  );
};

// ===== Sub-components =====

interface StatBadgeProps {
  icon: React.FC<{ className?: string }>;
  value: string;
  label: string;
}

const StatBadge: React.FC<StatBadgeProps> = ({ icon: Icon, value, label }) => (
  <div className="bg-slate-900/40 border border-slate-800 rounded-2xl px-4 py-2.5 flex items-center gap-2">
    <Icon className="w-4 h-4 text-amber-400" />
    <div>
      <span className="block text-xs font-black text-white">{value}</span>
      <span className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</span>
    </div>
  </div>
);
