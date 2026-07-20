import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download,
  X,
  Package,
  Image,
  Shirt,
  Layers,
  Globe,
  Settings,
  Cpu,
  Camera,
  ImageIcon,
  Check,
  FileArchive,
  AlertTriangle,
  ExternalLink,
  FileUp,
  Loader2,
  HardDrive,
} from "lucide-react";
import type { Instance, ContentItem } from "./InstancesView";
import type { ExportFormat, ExportOptions, ExportProgress } from "../services/profileExport";
import { profileExportService } from "../services/profileExport";
import { LanguageType } from "../lib/translations";
import { useToast } from "./Toast";

interface ProfileExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  instance: Instance;
  lang: LanguageType;
}

export const ProfileExportModal: React.FC<ProfileExportModalProps> = ({
  isOpen,
  onClose,
  instance,
  lang,
}) => {
  const t = (de: string, en: string) => lang === "de" ? de : en;
  const { addToast } = useToast();

  // Step tracking
  type Step = "options" | "progress" | "complete";
  const [step, setStep] = useState<Step>("options");

  // Export options
  const [format, setFormat] = useState<ExportFormat>("bamboo");
  const [includeMods, setIncludeMods] = useState(
    (instance.content || []).some((c) => c.type === "mods")
  );
  const [includeResourcepacks, setIncludeResourcepacks] = useState(
    (instance.content || []).some((c) => c.type === "resourcepacks")
  );
  const [includeShaderpacks, setIncludeShaderpacks] = useState(
    (instance.content || []).some((c) => c.type === "shaderpacks")
  );
  const [includeDatapacks, setIncludeDatapacks] = useState(
    (instance.content || []).some((c) => c.type === "datapacks")
  );
  const [includeWorlds, setIncludeWorlds] = useState(false);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeJvmSettings, setIncludeJvmSettings] = useState(true);
  const [includeLauncherSettings, setIncludeLauncherSettings] = useState(true);
  const [includeScreenshots, setIncludeScreenshots] = useState(false);
  const [includeIcon, setIncludeIcon] = useState(true);

  // Export state
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({
    phase: "preparing",
    percent: 0,
    message: "",
  });
  const [exportResult, setExportResult] = useState<{
    filePath?: string;
    fileName?: string;
    fileSize?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);



  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep("options");
      setExportResult(null);
      setError(null);
      setIsExporting(false);
      setProgress({ phase: "preparing", percent: 0, message: "" });
    }
  }, [isOpen]);

  // Subscribe to export progress
  useEffect(() => {
    const unsub = profileExportService.subscribe((p) => {
      setProgress(p);
      if (p.phase === "error") {
        setError(p.message);
        setIsExporting(false);
      }
    });
    return unsub;
  }, []);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setError(null);

    const options: ExportOptions = {
      format,
      includeMods,
      includeResourcepacks,
      includeShaderpacks,
      includeDatapacks,
      includeWorlds,
      includeConfig,
      includeJvmSettings,
      includeLauncherSettings,
      includeScreenshots,
      includeIcon,
      includeBanner: false,
    };

    const result = await profileExportService.exportInstance(instance, options);

    if (result.success) {
      setExportResult({
        filePath: result.filePath,
        fileName: result.fileName,
        fileSize: result.fileSize,
      });

      setStep("complete");
    } else {
      setError(result.error || t("Export fehlgeschlagen", "Export failed"));
    }

    setIsExporting(false);
  }, [
    format,
    includeMods,
    includeResourcepacks,
    includeShaderpacks,
    includeDatapacks,
    includeWorlds,
    includeConfig,
    includeJvmSettings,
    includeLauncherSettings,
    includeScreenshots,
    includeIcon,
    instance,
  ]);

  const handleOpenFileLocation = () => {
    if (exportResult?.filePath) {
      window.electronAPI?.showItemInFolder?.(exportResult.filePath);
    }
  };

  const handleSaveFile = async () => {
    const ext = format === "bamboo" ? "bamboo" : format === "mrpack" ? "mrpack" : "zip";
    const suggestedName = `${instance.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
    
    const result = await window.electronAPI?.showSaveDialog?.({
      defaultPath: suggestedName,
      filters: [
        ...(format === "bamboo" ? [{ name: "Bamboo Package", extensions: ["bamboo"] }] : []),
        ...(format === "mrpack" ? [{ name: "Modrinth Modpack", extensions: ["mrpack"] }] : []),
        ...(format === "zip" ? [{ name: "ZIP Archive", extensions: ["zip"] }] : []),
      ],
    });

    if (result && !result.canceled && result.filePath) {
      // Trigger the export with the chosen save path
      setIsExporting(true);
      
      const options: ExportOptions = {
        format,
        includeMods,
        includeResourcepacks,
        includeShaderpacks,
        includeDatapacks,
        includeWorlds,
        includeConfig,
        includeJvmSettings,
        includeLauncherSettings,
        includeScreenshots,
        includeIcon,
        includeBanner: false,
      };

      const exportResult = await window.electronAPI?.exportProfile?.({
        format,
        instanceName: instance.name,
        folderName: instance.name.toLowerCase().replace(/\s+/g, "-"),
        manifest: profileExportService.buildManifest(instance, options),
        options,
        savePath: result.filePath,
        suggestedFileName: result.filePath.split(/[/\\]/).pop(),
      });

      if (exportResult?.success) {
        setExportResult(exportResult);
        setStep("complete");
        addToast({
          type: "success",
          message: t("Export abgeschlossen!", "Export completed!"),
        });
      } else {
        setError(exportResult?.error || t("Export fehlgeschlagen", "Export failed"));
      }
      setIsExporting(false);
    }
  };

  const contentItems = [
    { key: "mods" as const, label: t("Mods", "Mods"), icon: Package, count: (instance.content || []).filter(c => c.type === "mods").length, enabled: includeMods, setEnabled: setIncludeMods },
    { key: "resourcepacks" as const, label: t("Resource Packs", "Resource Packs"), icon: Image, count: (instance.content || []).filter(c => c.type === "resourcepacks").length, enabled: includeResourcepacks, setEnabled: setIncludeResourcepacks },
    { key: "shaderpacks" as const, label: t("Shader", "Shader"), icon: Shirt, count: (instance.content || []).filter(c => c.type === "shaderpacks").length, enabled: includeShaderpacks, setEnabled: setIncludeShaderpacks },
    { key: "datapacks" as const, label: t("Data Packs", "Data Packs"), icon: Layers, count: (instance.content || []).filter(c => c.type === "datapacks").length, enabled: includeDatapacks, setEnabled: setIncludeDatapacks },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 20, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="bg-slate-950 border border-slate-800/80 rounded-3xl max-w-2xl w-full p-6 shadow-2xl flex flex-col gap-5 max-h-[85vh] overflow-y-auto custom-scrollbar"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                  <Download className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {t("Profil exportieren", "Export Profile")}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">{instance.name}</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Step: Options Selection */}
            {step === "options" && (
              <div className="flex flex-col gap-5">
                {/* Format Selection */}
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                    {t("Exportformat", "Export Format")}
                  </h4>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { id: "bamboo" as const, label: "Bamboo", desc: t("Bamboo Package (.bamboo)", "Bamboo Package (.bamboo)"), icon: Package },
                      { id: "mrpack" as const, label: "Modrinth", desc: t("Modrinth Modpack (.mrpack)", "Modrinth Modpack (.mrpack)"), icon: FileArchive },
                      { id: "zip" as const, label: "ZIP", desc: t("ZIP Archive (.zip)", "ZIP Archive (.zip)"), icon: FileArchive },
                    ].map((fmt) => (
                      <button
                        key={fmt.id}
                        onClick={() => setFormat(fmt.id)}
                        className={`p-4 rounded-2xl border text-left transition-all cursor-pointer ${
                          format === fmt.id
                            ? "border-emerald-500/40 bg-emerald-500/10"
                            : "border-slate-800/60 bg-slate-950/30 hover:border-slate-700"
                        }`}
                      >
                        <fmt.icon className={`w-5 h-5 mb-2 ${format === fmt.id ? "text-emerald-400" : "text-slate-400"}`} />
                        <span className={`block text-sm font-black ${format === fmt.id ? "text-emerald-300" : "text-slate-200"}`}>{fmt.label}</span>
                        <span className="text-[10px] text-slate-500 mt-1 block">{fmt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Content Selection */}
                <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                    {t("Inhalte auswählen", "Select Content")}
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {contentItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.key}
                          onClick={() => item.setEnabled(!item.enabled)}
                          disabled={item.count === 0}
                          className={`flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer ${
                            item.enabled
                              ? "border-emerald-500/30 bg-emerald-500/5"
                              : "border-slate-800/60 bg-slate-950/20 hover:border-slate-700"
                          } ${item.count === 0 ? "opacity-40 cursor-not-allowed" : ""}`}
                        >
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                            item.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-900 text-slate-500"
                          }`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="flex-1 text-left">
                            <span className={`block text-xs font-bold ${item.enabled ? "text-emerald-200" : "text-slate-300"}`}>
                              {item.label}
                            </span>
                            <span className="text-[10px] text-slate-500">{item.count} {t("Dateien", "files")}</span>
                          </div>
                          {item.enabled && <Check className="w-4 h-4 text-emerald-400" />}
                        </button>
                      );
                    })}
                  </div>

                  {/* Additional Options */}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <ToggleButton
                      enabled={includeWorlds}
                      setEnabled={setIncludeWorlds}
                      label={t("Welten", "Worlds")}
                      icon={Globe}
                    />
                    <ToggleButton
                      enabled={includeScreenshots}
                      setEnabled={setIncludeScreenshots}
                      label={t("Screenshots", "Screenshots")}
                      icon={Camera}
                    />
                    <ToggleButton
                      enabled={includeConfig}
                      setEnabled={setIncludeConfig}
                      label={t("Config", "Config")}
                      icon={Settings}
                    />
                    <ToggleButton
                      enabled={includeJvmSettings}
                      setEnabled={setIncludeJvmSettings}
                      label={t("JVM", "JVM")}
                      icon={Cpu}
                    />
                    <ToggleButton
                      enabled={includeIcon}
                      setEnabled={setIncludeIcon}
                      label={t("Icon", "Icon")}
                      icon={ImageIcon}
                    />
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={onClose}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {t("Abbrechen", "Cancel")}
                  </button>
                  <button
                    onClick={handleExport}
                    disabled={isExporting}
                    className="flex-[2] bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-emerald-500/10"
                  >
                    {isExporting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t("Exportiere...", "Exporting...")}
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        {t("Exportieren", "Export")}
                      </>
                    )}
                  </button>
                </div>

                {/* Error Display */}
                {error && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-rose-300">{error}</span>
                  </div>
                )}
              </div>
            )}

            {/* Step: Export Progress */}
            {step === "progress" && (
              <div className="flex flex-col items-center justify-center py-10 gap-4">
                <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-slate-200">{progress.message}</p>
                  <p className="text-[10px] text-slate-500 mt-1">
                    {t("Phase:", "Phase:")} {progress.phase}
                  </p>
                </div>
                <div className="w-full max-w-xs bg-slate-900 rounded-full h-2 overflow-hidden">
                  <motion.div
                    className="h-full bg-emerald-400 rounded-full"
                    initial={{ width: "0%" }}
                    animate={{ width: `${progress.percent}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                <span className="text-xs font-bold text-slate-400">{progress.percent}%</span>
              </div>
            )}

            {/* Step: Export Complete */}
            {step === "complete" && (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col items-center justify-center py-6 gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Check className="w-8 h-8 text-emerald-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-black text-emerald-300">
                      {t("Export abgeschlossen!", "Export completed!")}
                    </p>
                    {exportResult?.fileSize && (
                      <p className="text-xs text-slate-400 mt-1">
                        {t("Größe:", "Size:")} {(exportResult.fileSize >= 1073741824) ? (exportResult.fileSize / 1073741824).toFixed(2) + ' GB' : (exportResult.fileSize >= 1048576) ? (exportResult.fileSize / 1048576).toFixed(1) + ' MB' : (exportResult.fileSize / 1024).toFixed(0) + ' KB'}
                      </p>
                    )}
                  </div>
                </div>

                {exportResult?.filePath && (
                  <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-3 flex items-center justify-between">
                    <span className="text-xs text-slate-400 truncate max-w-[70%]">{exportResult.filePath}</span>
                    <button
                      onClick={handleOpenFileLocation}
                      className="p-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-all cursor-pointer"
                      title={t("Pfad öffnen", "Open file location")}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={onClose}
                    className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                  >
                    {t("Schließen", "Close")}
                  </button>
                  <button
                    onClick={handleSaveFile}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
                  >
                    <Download className="w-4 h-4" />
                    {t("Speichern unter...", "Save as...")}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ===== Sub-components =====

interface ToggleButtonProps {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  label: string;
  icon: React.FC<{ className?: string }>;
}

const ToggleButton: React.FC<ToggleButtonProps> = ({ enabled, setEnabled, label, icon: Icon }) => (
  <button
    onClick={() => setEnabled(!enabled)}
    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
      enabled
        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
        : "border-slate-800/60 bg-slate-950/20 text-slate-400 hover:text-slate-200 hover:border-slate-700"
    }`}
  >
    <Icon className="w-3.5 h-3.5" />
    {label}
  </button>
);
