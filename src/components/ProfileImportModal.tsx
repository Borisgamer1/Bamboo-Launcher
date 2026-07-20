import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  X,
  Package,
  Image,
  Shirt,
  Layers,
  Globe,
  HardDrive,
  Download,
  Check,
  AlertTriangle,
  AlertCircle,
  Info,
  FileArchive,
  Search,
  Loader2,
  FolderOpen,
  ExternalLink,
  User,
  FileText,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import type { Instance } from "./InstancesView";
import type {
  ImportPreview,
  ImportFormat,
  ConflictCheck,
  Conflict,
  ImportOptions,
  ImportProgress,
  ImportResult,
} from "../services/profileImport";
import { profileImportService } from "../services/profileImport";
import { LanguageType } from "../lib/translations";
import { useToast } from "./Toast";

interface ProfileImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  instances: Instance[];
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>;
  lang: LanguageType;
  initialFile?: string;
}

export const ProfileImportModal: React.FC<ProfileImportModalProps> = ({
  isOpen,
  onClose,
  instances,
  setInstances,
  lang,
  initialFile,
}) => {
  const t = (de: string, en: string) => (lang === "de" ? de : en);
  const { addToast } = useToast();

  // Step tracking
  type Step = "select" | "preview" | "conflicts" | "progress" | "complete";
  const [step, setStep] = useState<Step>("select");

  // File selection
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile || null);

  // Preview
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Conflict check
  const [conflictCheck, setConflictCheck] = useState<ConflictCheck | null>(null);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);

  // Import options
  const [targetName, setTargetName] = useState("");
  const [installMods, setInstallMods] = useState(true);
  const [installResourcepacks, setInstallResourcepacks] = useState(true);
  const [installShaderpacks, setInstallShaderpacks] = useState(true);
  const [installDatapacks, setInstallDatapacks] = useState(true);
  const [installWorlds, setInstallWorlds] = useState(true);
  const [installConfig, setInstallConfig] = useState(true);
  const [installScreenshots, setInstallScreenshots] = useState(false);

  // Import state
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>({
    phase: "detecting",
    percent: 0,
    message: "",
  });
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setPreview(null);
      setConflictCheck(null);
      setImportResult(null);
      setImportError(null);
      setPreviewError(null);
      setSelectedFile(initialFile || null);

      if (initialFile) {
        loadPreview(initialFile);
      } else {
        setStep("select");
      }
    }
  }, [isOpen, initialFile]);

  // Subscribe to import progress
  useEffect(() => {
    const unsub = profileImportService.subscribe((p) => {
      setProgress(p);
    });
    return unsub;
  }, []);

  const loadPreview = async (filePath: string) => {
    setIsLoadingPreview(true);
    setPreviewError(null);
    try {
      const p = await profileImportService.getPreview(filePath);
      setPreview(p);
      setTargetName(profileImportService.generateUniqueName(p.title, instances));
      setStep("preview");
    } catch (err: any) {
      setPreviewError(err.message);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleSelectFile = async () => {
    const result = await window.electronAPI?.showOpenDialog?.({
      properties: ["openFile"],
      filters: [
        { name: t("Unterstützte Formate", "Supported Formats"), extensions: ["mrpack", "zip"] },
        { name: "Modrinth Modpack", extensions: ["mrpack"] },
        { name: "ZIP Archive", extensions: ["zip"] },
      ],
    });

    if (result && !result.canceled && result.filePaths.length > 0) {
      setSelectedFile(result.filePaths[0]);
      await loadPreview(result.filePaths[0]);
    }
  };

  const handleCheckConflicts = async () => {
    if (!preview) return;
    setIsCheckingConflicts(true);
    try {
      const check = await profileImportService.checkConflicts(preview, instances);
      setConflictCheck(check);
      setStep("conflicts");
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setIsCheckingConflicts(false);
    }
  };

  const handleStartImport = async () => {
    if (!preview || !selectedFile) return;

    setIsImporting(true);
    setImportError(null);

    const options: ImportOptions = {
      targetInstanceName: targetName || preview.title,
      resolutionStrategy: "create_new",
      installMods,
      installResourcepacks,
      installShaderpacks,
      installDatapacks,
      installWorlds,
      installConfig,
      installScreenshots,
    };

    let result: ImportResult;

    result = await profileImportService.importProfile(selectedFile, preview, options, instances);


    if (result.success && result.instanceName) {
      setImportResult(result);
      setStep("complete");

      // Add the imported instance to the instances list if we have the data
      if (preview) {
        const newInstance: Instance = {
          id: result.instanceId || `import_${Date.now()}`,
          name: result.instanceName,
          minecraftVersion: preview.minecraftVersion,
          modloader: preview.modloader as Instance["modloader"],
          modloaderVersion: preview.modloaderVersion,
          lastPlayed: lang === "de" ? "Gerade eben" : "Just now",
          size: profileImportService.formatFileSize(preview.fileSize),
          modCount: preview.modCount,
          desc: preview.description,
          thumbnail: "",
          javaVersion: "Automatisch",
          installedMods: [],
          content: [],
          ram: 4096,
        };
        setInstances((prev) => [newInstance, ...prev]);
      }

      addToast({
        type: "success",
        message: t(
          `"${result.instanceName}" erfolgreich importiert!`,
          `"${result.instanceName}" imported successfully!`
        ),
      });
    } else {
      setImportError(result.error || t("Import fehlgeschlagen", "Import failed"));
    }

    setIsImporting(false);
  };

  const getSeverityIcon = (severity: Conflict["severity"]) => {
    switch (severity) {
      case "error": return <AlertCircle className="w-4 h-4 text-rose-400" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-amber-400" />;
      case "info": return <Info className="w-4 h-4 text-sky-400" />;
    }
  };

  const getSeverityBg = (severity: Conflict["severity"]) => {
    switch (severity) {
      case "error": return "bg-rose-500/5 border-rose-500/20";
      case "warning": return "bg-amber-500/5 border-amber-500/20";
      case "info": return "bg-sky-500/5 border-sky-500/20";
    }
  };

  const getFormatIcon = (fmt: ImportFormat) => {
    switch (fmt) {
      case "mrpack": return FileArchive;
      case "zip": return FileArchive;
      default: return FileArchive;
    }
  };

  const getFormatLabel = (fmt: ImportFormat) => {
    switch (fmt) {
      case "mrpack": return ".mrpack";
      case "zip": return ".zip";
      default: return "?";
    }
  };

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
                <div className="w-10 h-10 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-white tracking-wide">
                    {t("Profil importieren", "Import Profile")}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {step === "select" ? t("Wähle eine Quelle aus", "Select a source") :
                     step === "preview" ? t("Überprüfe das Paket", "Review the package") :
                     step === "conflicts" ? t("Konflikte prüfen", "Check conflicts") :
                     step === "progress" ? t("Importiere...", "Importing...") :
                     t("Import abgeschlossen", "Import completed")}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Step: Select Source */}
            {step === "select" && (
              <div className="flex flex-col gap-4">
                {/* File Selection */}
                <button
                  onClick={handleSelectFile}
                  className="flex items-center gap-4 p-6 rounded-2xl border-2 border-dashed border-slate-700 hover:border-sky-500/50 bg-slate-900/20 hover:bg-sky-500/5 transition-all cursor-pointer group"
                >
                  <div className="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 group-hover:text-sky-400 group-hover:border-sky-500/30 transition-all">
                    <FolderOpen className="w-7 h-7" />
                  </div>
                  <div className="text-left">
                    <span className="block text-sm font-bold text-slate-200 group-hover:text-sky-200 transition-colors">
                      {t("Datei auswählen", "Select File")}
                    </span>
                    <span className="text-xs text-slate-500 mt-1 block">
                      {t("Unterstützt: .mrpack, .zip", "Supported: .mrpack, .zip")}
                    </span>
                  </div>
                </button>

                {/* Cancel */}
                <button
                  onClick={onClose}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                >
                  {t("Abbrechen", "Cancel")}
                </button>
              </div>
            )}

            {/* Step: Preview */}
            {step === "preview" && preview && (
              <div className="flex flex-col gap-4">
                {/* Loading state */}
                {isLoadingPreview && (
                  <div className="flex flex-col items-center justify-center py-8 gap-3">
                    <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
                    <p className="text-sm text-slate-300">{t("Lade Paketinformationen...", "Loading package info...")}</p>
                  </div>
                )}

                {previewError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-rose-300">{previewError}</span>
                  </div>
                )}

                {!isLoadingPreview && (
                  <>
                    {/* Package Info Card */}
                    <div className="bg-gradient-to-br from-slate-900/60 to-slate-950/60 border border-slate-800/60 rounded-2xl p-5">
                      <div className="flex items-start gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
                          {React.createElement(getFormatIcon(preview.format), { className: "w-6 h-6" })}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-lg font-black text-white tracking-wide truncate">{preview.title}</h4>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-lg uppercase">
                              {getFormatLabel(preview.format)}
                            </span>
                            <span className="text-[10px] font-bold text-slate-300 bg-slate-800 px-2 py-0.5 rounded-lg">
                              {preview.minecraftVersion}
                            </span>
                            <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-lg">
                              {preview.modloader}{preview.modloaderVersion ? ` ${preview.modloaderVersion}` : ""}
                            </span>
                          </div>
                          {preview.description && (
                            <p className="text-xs text-slate-400 mt-2">{preview.description}</p>
                          )}
                        </div>
                      </div>

                      {/* Metadata Grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                        <MetaBadge icon={Package} label={t("Mods", "Mods")} value={String(preview.modCount)} />
                        <MetaBadge icon={Image} label={t("Resource Packs", "Resource Packs")} value={String(preview.resourcepackCount)} />
                        <MetaBadge icon={Shirt} label={t("Shader", "Shader")} value={String(preview.shaderCount)} />
                        <MetaBadge icon={Globe} label={t("Welten", "Worlds")} value={String(preview.worldCount)} />
                        <MetaBadge icon={Layers} label={t("Data Packs", "Data Packs")} value={String(preview.datapackCount)} />
                        <MetaBadge icon={HardDrive} label={t("Größe", "Size")} value={profileImportService.formatFileSize(preview.fileSize)} />
                        {preview.author && <MetaBadge icon={User} label={t("Autor", "Author")} value={preview.author} />}
                        <MetaBadge icon={FileText} label={t("Dateien", "Files")} value={String(preview.totalFiles)} />
                      </div>
                    </div>

                    {/* Import Options */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                        {t("Import-Optionen", "Import Options")}
                      </h4>

                      <div className="mb-3">
                        <label className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1 block">
                          {t("Instanzname", "Instance Name")}
                        </label>
                        <input
                          type="text"
                          value={targetName}
                          onChange={(e) => setTargetName(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500/50 rounded-xl py-2.5 px-3 text-sm font-bold text-slate-200 outline-none transition-all"
                        />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <ToggleCheck checked={installMods} setChecked={setInstallMods} label={t("Mods", "Mods")} />
                        <ToggleCheck checked={installResourcepacks} setChecked={setInstallResourcepacks} label={t("Resource Packs", "Resource Packs")} />
                        <ToggleCheck checked={installShaderpacks} setChecked={setInstallShaderpacks} label={t("Shader", "Shader")} />
                        <ToggleCheck checked={installDatapacks} setChecked={setInstallDatapacks} label={t("Data Packs", "Data Packs")} />
                        <ToggleCheck checked={installWorlds} setChecked={setInstallWorlds} label={t("Welten", "Worlds")} />
                        <ToggleCheck checked={installConfig} setChecked={setInstallConfig} label={t("Config", "Config")} />
                        <ToggleCheck checked={installScreenshots} setChecked={setInstallScreenshots} label={t("Screenshots", "Screenshots")} />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3">
                      <button
                        onClick={() => setStep("select")}
                        className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                      >
                        {t("Zurück", "Back")}
                      </button>
                      <button
                        onClick={handleCheckConflicts}
                        disabled={isCheckingConflicts}
                        className="flex-[2] bg-sky-500 hover:bg-sky-400 text-slate-950 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-sky-500/10"
                      >
                        {isCheckingConflicts ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ArrowRight className="w-4 h-4" />
                        )}
                        {t("Weiter zum Import", "Continue to Import")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Step: Conflicts */}
            {(step === "conflicts" || step === "progress") && (
              <div className="flex flex-col gap-4">
                {conflictCheck && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      {conflictCheck.hasConflicts ? (
                        <AlertTriangle className="w-5 h-5 text-amber-400" />
                      ) : (
                        <Check className="w-5 h-5 text-emerald-400" />
                      )}
                      <span className={`text-sm font-black ${conflictCheck.hasConflicts ? "text-amber-300" : "text-emerald-300"}`}>
                        {conflictCheck.hasConflicts
                          ? t("Konflikte gefunden", "Conflicts Found")
                          : t("Keine Konflikte", "No Conflicts")}
                      </span>
                    </div>

                    <div className="flex flex-col gap-2">
                      {conflictCheck.conflicts.map((conflict, i) => (
                        <div
                          key={i}
                          className={`flex items-start gap-3 p-3 rounded-2xl border ${getSeverityBg(conflict.severity)}`}
                        >
                          {getSeverityIcon(conflict.severity)}
                          <div className="flex-1">
                            <p className="text-xs font-bold text-slate-200">{conflict.message}</p>
                            {conflict.resolution && (
                              <p className="text-[10px] text-slate-400 mt-1">{conflict.resolution}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Import Progress */}
                {step === "progress" && (
                  <div className="flex flex-col items-center justify-center py-6 gap-3">
                    <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
                    <p className="text-sm font-bold text-slate-200">{progress.message}</p>
                    <div className="w-full max-w-xs bg-slate-900 rounded-full h-2 overflow-hidden">
                      <motion.div
                        className="h-full bg-sky-400 rounded-full"
                        initial={{ width: "0%" }}
                        animate={{ width: `${progress.percent}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    <span className="text-xs text-slate-400">{progress.percent}%</span>
                  </div>
                )}

                {importError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-rose-300">{importError}</span>
                  </div>
                )}

                {step === "conflicts" && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => setStep("preview")}
                      className="flex-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                    >
                      {t("Zurück", "Back")}
                    </button>
                    <button
                      onClick={handleStartImport}
                      disabled={isImporting}
                      className="flex-[2] bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-emerald-500/10"
                    >
                      {isImporting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t("Importiere...", "Importing...")}
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          {t("Import starten", "Start Import")}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Step: Complete */}
            {step === "complete" && importResult?.success && (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col items-center justify-center py-6 gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Check className="w-8 h-8 text-emerald-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-black text-emerald-300">
                      {t("Import abgeschlossen!", "Import completed!")}
                    </p>
                    <p className="text-sm text-slate-200 mt-1">
                      {t("Instanz:", "Instance:")} {importResult.instanceName}
                    </p>
                  </div>
                </div>

                {importResult.details && (
                  <div className="grid grid-cols-2 gap-2">
                    {importResult.details.modsInstalled > 0 && (
                      <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-3 text-center">
                        <span className="block text-lg font-black text-sky-400">{importResult.details.modsInstalled}</span>
                        <span className="text-[10px] text-slate-400">{t("Mods installiert", "Mods installed")}</span>
                      </div>
                    )}
                    {importResult.details.worldsImported > 0 && (
                      <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-3 text-center">
                        <span className="block text-lg font-black text-emerald-400">{importResult.details.worldsImported}</span>
                        <span className="text-[10px] text-slate-400">{t("Welten importiert", "Worlds imported")}</span>
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={onClose}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 py-3 rounded-2xl text-xs font-black transition-all cursor-pointer shadow-lg shadow-emerald-500/10"
                >
                  {t("Fertig", "Done")}
                </button>
              </div>
            )}

            {/* Error state with retry */}
            {previewError && !isLoadingPreview && step === "select" && (
              <div className="flex flex-col gap-3">
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span className="text-xs text-rose-300">{previewError}</span>
                </div>
                <button
                  onClick={() => { setPreviewError(null); setStep("select"); }}
                  className="bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer"
                >
                  {t("Erneut versuchen", "Try again")}
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ===== Sub-components =====

interface MetaBadgeProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}

const MetaBadge: React.FC<MetaBadgeProps> = ({ icon: Icon, label, value }) => (
  <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-2.5 flex items-center gap-2">
    <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
    <div className="min-w-0">
      <span className="block text-[10px] font-bold text-slate-200 truncate">{value}</span>
      <span className="text-[8px] text-slate-500 uppercase tracking-wider">{label}</span>
    </div>
  </div>
);

interface ToggleCheckProps {
  checked: boolean;
  setChecked: (v: boolean) => void;
  label: string;
}

const ToggleCheck: React.FC<ToggleCheckProps> = ({ checked, setChecked, label }) => (
  <button
    onClick={() => setChecked(!checked)}
    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
      checked
        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
        : "border-slate-800/60 bg-slate-950/20 text-slate-400 hover:text-slate-200 hover:border-slate-700"
    }`}
  >
    {checked && <Check className="w-3 h-3" />}
    {label}
  </button>
);


