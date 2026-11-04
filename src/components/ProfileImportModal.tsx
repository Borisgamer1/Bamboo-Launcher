import React, { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  Upload,
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
  Loader2,
  FolderOpen,
  User,
  FileText,
  ArrowRight,
} from "lucide-react";
import type { Instance } from "./InstancesView";
import type {
  ImportPreview,
  ImportFormat,
  ConflictCheck,
  Conflict,
  ImportOptions,
  ImportResult,
} from "../services/profileImport";
import { profileImportService } from "../services/profileImport";
import { mapProfileToInstance } from "../hooks/useInstances";
import { LanguageType } from "../lib/translations";
import { useToast } from "./Toast";
import { Dialog } from "./Dialog";
import { dialogButton } from "./dialogSupport";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import {
  IMPORT_AUTO_DISMISS_MS,
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
  useBackgroundTasks,
} from "../lib/backgroundTasks";

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
  type Step = "select" | "preview" | "conflicts" | "progress" | "complete";
  const [step, setStep] = useState<Step>("select");

  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile || null);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [conflictCheck, setConflictCheck] = useState<ConflictCheck | null>(null);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);

  const [targetName, setTargetName] = useState("");
  const [installMods, setInstallMods] = useState(true);
  const [installResourcepacks, setInstallResourcepacks] = useState(true);
  const [installShaderpacks, setInstallShaderpacks] = useState(true);
  const [installDatapacks, setInstallDatapacks] = useState(true);
  const [installWorlds, setInstallWorlds] = useState(true);
  const [installConfig, setInstallConfig] = useState(true);
  const [installScreenshots, setInstallScreenshots] = useState(false);

  const [isImporting, setIsImporting] = useState(false);
  const [importTaskId, setImportTaskId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const backgroundTasks = useBackgroundTasks();
  const importTask = backgroundTasks.find((task) => task.id === importTaskId);
  const importPercent = Math.max(0, Math.min(100, Math.round(importTask?.percent ?? 0)));
  const importMessage =
    importTask?.detail ||
    t("Import wird vorbereitet...", "Preparing import...");
  // Closing never cancels an import: it keeps running in the footer task bar and
  // can be watched from there.
  const requestClose = () => onClose();
  // The dialog itself refuses an existing instance name, so the conflict step
  // cannot be reached with a name that is guaranteed to collide.
  const requestedName = (targetName.trim() || preview?.title || '').toLowerCase();
  const nameTaken = !!requestedName && instances.some((instance) => instance.name.trim().toLowerCase() === requestedName);

  const loadPreview = async (filePath: string) => {
    setIsLoadingPreview(true);
    setPreviewError(null);
    try {
      const p = await profileImportService.getPreview(filePath);
      setPreview(p);
      setTargetName(profileImportService.generateUniqueName(p.title, instances));
      setStep("preview");
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // Read at load time only: re-running when the instance list changes would reload
  // the preview right after an import completes.
  const instancesRef = useRef(instances);
  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  useEffect(() => {
    if (!isOpen || !initialFile) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await profileImportService.getPreview(initialFile);
        if (cancelled) return;
        setPreview(p);
        setTargetName(profileImportService.generateUniqueName(p.title, instancesRef.current));
        setStep("preview");
      } catch (err) {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, initialFile]);

  const handleSelectFile = async () => {
    const result = await window.electronAPI?.dialogs.open?.({
      properties: ["openFile"],
      filters: [
        { name: t("Unterstützte Formate", "Supported Formats"), extensions: ["mrpack", "zip"] },
        { name: "Modrinth Modpack", extensions: ["mrpack"] },
        { name: "ZIP Archive", extensions: ["zip"] },
      ],
    });

    if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
      setSelectedFile(result.filePaths[0]);
      await loadPreview(result.filePaths[0]);
    }
  };

  const handleCheckConflicts = async () => {
    if (!preview) return;
    setIsCheckingConflicts(true);
    try {
      const check = await profileImportService.checkConflicts(preview, instances, targetName);
      setConflictCheck(check);
      setStep("conflicts");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCheckingConflicts(false);
    }
  };

  const handleStartImport = async () => {
    if (!preview || !selectedFile) return;

    setIsImporting(true);
    setImportError(null);
    setStep("progress");

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

    const taskId = newBackgroundTaskId("import");
    setImportTaskId(taskId);
    beginBackgroundTask({
      id: taskId,
      title: t(`Importiere ${options.targetInstanceName}…`, `Importing ${options.targetInstanceName}…`),
      detail: t("Import wird vorbereitet…", "Preparing import…"),
      percent: 0,
    });

    const result: ImportResult = await profileImportService.importProfile(
      selectedFile,
      preview,
      options,
      taskId,
    );

    if (result.success && result.profile) {
      const newInstance = mapProfileToInstance(result.profile, instances.length);
      setImportResult(result);
      setInstances((prev) => [newInstance, ...prev]);
      setStep("complete");

      addToast({
        type: "success",
        message: t(
          `"${result.instanceName}" erfolgreich importiert!`,
          `"${result.instanceName}" imported successfully!`
        ),
      });
      const warningCount = result.warnings?.length ?? 0;
      completeBackgroundTask(
        taskId,
        warningCount > 0
          ? t(
              `Import abgeschlossen – ${warningCount} Datei(en) nicht geladen`,
              `Import completed – ${warningCount} file(s) not downloaded`,
            )
          : t("Import abgeschlossen", "Import completed"),
        IMPORT_AUTO_DISMISS_MS,
      );
    } else {
      const message = result.error || t("Import fehlgeschlagen", "Import failed");
      setImportError(message);
      failBackgroundTask(taskId, message);
    }

    setIsImporting(false);
  };

  const getSeverityIcon = (severity: Conflict["severity"]) => {
    switch (severity) {
      case "error": return <AlertCircle className="w-4 h-4 text-danger" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-warning" />;
      case "info": return <Info className="w-4 h-4 text-info" />;
    }
  };

  const getSeverityBg = (severity: Conflict["severity"]) => {
    switch (severity) {
      case "error": return "bg-danger/5 border-danger/20";
      case "warning": return "bg-warning/5 border-warning/20";
      case "info": return "bg-info/5 border-info/20";
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

  const stepLabel =
    step === "select" ? t("Wähle eine Quelle aus", "Select a source") :
    step === "preview" ? t("Überprüfe das Paket", "Review the package") :
    step === "conflicts" ? t("Konflikte prüfen", "Check conflicts") :
    step === "progress" ? t("Importiere...", "Importing...") :
    t("Import abgeschlossen", "Import completed");

  const footer =
    step === "select" ? (
      <button onClick={onClose} className={dialogButton.secondary}>
        {t("Abbrechen", "Cancel")}
      </button>
    ) : step === "preview" && !isLoadingPreview ? (
      <>
        <button onClick={() => setStep("select")} className={dialogButton.secondary}>
          {t("Zurück", "Back")}
        </button>
        <button
          onClick={handleCheckConflicts}
          disabled={isCheckingConflicts || nameTaken}
          className={`${dialogButton.info} flex items-center gap-2`}
        >
          {isCheckingConflicts ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          {t("Weiter zum Import", "Continue to Import")}
        </button>
      </>
    ) : step === "conflicts" ? (
      <>
        <button onClick={() => setStep("preview")} className={dialogButton.secondary}>
          {t("Zurück", "Back")}
        </button>
        <button
          onClick={handleStartImport}
          disabled={isImporting}
          className={`${dialogButton.accent} flex items-center gap-2`}
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
      </>
    ) : step === "progress" ? (
      <button onClick={onClose} className={dialogButton.secondary}>
        {t("Im Hintergrund weiter", "Continue in background")}
      </button>
    ) : step === "complete" ? (
      <button onClick={onClose} className={dialogButton.accent}>
        {t("Fertig", "Done")}
      </button>
    ) : undefined;

  return (
    <Dialog
      open={isOpen}
      onClose={requestClose}
      title={t("Profil importieren", "Import Profile")}
      titleId="import-dialog-title"
      closeLabel={t("Schließen", "Close")}
      icon={<Upload className="h-4 w-4" />}
      tone="info"
      bodyClassName="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-4 text-small text-ink-secondary"
      footer={footer}
    >
      <p className="text-small text-ink-tertiary">{stepLabel}</p>

            {step === "select" && isLoadingPreview && (
              <div className="flex flex-col items-center justify-center gap-3 py-8">
                <Loader2 className="w-8 h-8 text-info animate-spin" />
                <p className="text-regular text-ink">{t("Lade Paketinformationen...", "Loading package info...")}</p>
              </div>
            )}

            {step === "select" && previewError && (
              <div className="flex items-start gap-2.5 rounded-2xl border border-danger/20 bg-danger/10 p-3">
                <AlertTriangle className="w-4 h-4 shrink-0 text-danger" />
                <span className="text-small text-danger">{previewError}</span>
              </div>
            )}

            {step === "select" && !isLoadingPreview && (
              <div className="flex flex-col gap-4">
                <button
                  data-autofocus
                  onClick={handleSelectFile}
                  className="flex items-center gap-4 p-6 rounded-2xl border-2 border-dashed border-stroke-strong hover:border-info/50 bg-surface/20 hover:bg-info/5 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer group"
                >
                  <div className="w-14 h-14 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary group-hover:text-info group-hover:border-info/30 transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter]">
                    <FolderOpen className="w-7 h-7" />
                  </div>
                  <div className="text-left">
                    <span className="block text-regular font-medium text-ink group-hover:text-info transition-colors">
                      {t("Datei auswählen", "Select File")}
                    </span>
                    <span className="text-small text-ink-tertiary mt-1 block">
                      {t("Unterstützt: .mrpack, .zip", "Supported: .mrpack, .zip")}
                    </span>
                  </div>
                </button>

              </div>
            )}

            {step === "preview" && preview && (
              <div className="flex flex-col gap-4">
                {isLoadingPreview && (
                  <div className="flex flex-col items-center justify-center py-8 gap-3">
                    <Loader2 className="w-8 h-8 text-info animate-spin" />
                    <p className="text-regular text-ink">{t("Lade Paketinformationen...", "Loading package info...")}</p>
                  </div>
                )}

                {previewError && (
                  <div className="p-3 bg-danger/10 border border-danger/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                    <span className="text-small text-danger">{previewError}</span>
                  </div>
                )}

                {!isLoadingPreview && (
                  <>
                    <div className="bg-gradient-to-br from-surface/60 to-root/60 border border-hairline rounded-2xl p-5">
                      <div className="flex items-start gap-4">
                        <div className="w-14 h-14 rounded-2xl bg-info/10 border border-info/20 flex items-center justify-center text-info shrink-0">
                          {React.createElement(getFormatIcon(preview.format), { className: "w-6 h-6" })}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="text-large font-semibold text-ink truncate">{preview.title}</h4>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <span className="text-micro font-medium text-info bg-info/10 border border-info/20 px-2 py-0.5 rounded-lg uppercase tracking-label">
                              {getFormatLabel(preview.format)}
                            </span>
                            <span className="text-micro font-medium text-ink bg-raised px-2 py-0.5 rounded-lg">
                              {preview.minecraftVersion}
                            </span>
                            <span className="text-micro font-medium text-warning bg-warning/10 border border-warning/20 px-2 py-0.5 rounded-lg">
                              {preview.modloader}{preview.modloaderVersion ? ` ${preview.modloaderVersion}` : ""}
                            </span>
                          </div>
                          {preview.description && (
                            <p className="text-small text-ink-secondary mt-2">{preview.description}</p>
                          )}
                        </div>
                      </div>

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

                    <div>
                      <h4 className="text-micro font-medium text-ink-secondary uppercase mb-3 tracking-label">
                        {t("Import-Optionen", "Import Options")}
                      </h4>

                      <div className="mb-3">
                        <label className="text-micro text-ink-tertiary font-medium uppercase mb-1 block tracking-label">
                          {t("Instanzname", "Instance Name")}
                        </label>
                        <input
                          type="text"
                          value={targetName}
                          onChange={(e) => setTargetName(e.target.value)}
                          aria-invalid={nameTaken}
                          className={`w-full bg-root border rounded-xl py-2.5 px-3 text-regular font-medium text-ink outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] ${nameTaken ? 'border-danger/60 focus:border-danger' : 'border-stroke focus:border-info/50'}`}
                        />
                        {nameTaken && (
                          <p className="mt-1 text-micro text-danger">
                            {t(
                              'Dieser Name ist bereits vergeben – wähle einen anderen.',
                              'This name is already taken – choose another.'
                            )}
                          </p>
                        )}
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

                  </>
                )}
              </div>
            )}

            {(step === "conflicts" || step === "progress") && (
              <div className="flex flex-col gap-4">
                {conflictCheck && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      {conflictCheck.hasConflicts ? (
                        <AlertTriangle className="w-5 h-5 text-warning" />
                      ) : (
                        <Check className="w-5 h-5 text-success" />
                      )}
                      <span className={`text-regular font-semibold ${conflictCheck.hasConflicts ? "text-warning" : "text-success"}`}>
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
                            <p className="text-small font-medium text-ink">{conflict.message}</p>
                            {conflict.resolution && (
                              <p className="text-micro text-ink-secondary mt-1">{conflict.resolution}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {step === "progress" && (
                  <div className="flex flex-col items-center justify-center py-6 gap-3">
                    <Loader2 className="w-8 h-8 text-info animate-spin" />
                    <p className="text-regular font-medium text-ink">{importMessage}</p>
                    <div className="w-full max-w-xs bg-surface rounded-full h-2 overflow-hidden">
                      <motion.div
                        className="h-full bg-info rounded-full"
                        initial={{ width: "0%" }}
                        animate={{ width: `${importPercent}%` }}
                        transition={motionSafe({ duration: MOTION.slow, ease: EASE.out })}
                      />
                    </div>
                    <span className="text-small text-ink-secondary tabular-nums">{importPercent}%</span>
                    <p className="m-0 text-micro text-ink-tertiary text-center max-w-xs">
                      {t(
                        "Du kannst dieses Fenster schließen – der Import läuft unten in der Leiste weiter.",
                        "You can close this window – the import keeps running in the bar below.",
                      )}
                    </p>
                  </div>
                )}

                {importError && (
                  <div className="p-3 bg-danger/10 border border-danger/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                    <span className="text-small text-danger">{importError}</span>
                  </div>
                )}
              </div>
            )}

            {step === "complete" && importResult?.success && (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col items-center justify-center py-6 gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-success/10 border border-success/20 flex items-center justify-center">
                    <Check className="w-8 h-8 text-success" />
                  </div>
                  <div className="text-center">
                    <p className="text-large font-semibold text-success">
                      {t("Import abgeschlossen!", "Import completed!")}
                    </p>
                    <p className="text-regular text-ink mt-1">
                      {t("Instanz:", "Instance:")} {importResult.instanceName}
                    </p>
                  </div>
                </div>

                {importResult.details && (
                  <div className="grid grid-cols-2 gap-2">
                    {importResult.details.modsInstalled > 0 && (
                      <div className="bg-surface/40 border border-stroke rounded-2xl p-3 text-center">
                        <span className="block text-large font-semibold text-info">{importResult.details.modsInstalled}</span>
                        <span className="text-micro text-ink-secondary">{t("Mods installiert", "Mods installed")}</span>
                      </div>
                    )}
                    {importResult.details.worldsImported > 0 && (
                      <div className="bg-surface/40 border border-stroke rounded-2xl p-3 text-center">
                        <span className="block text-large font-semibold text-success">{importResult.details.worldsImported}</span>
                        <span className="text-micro text-ink-secondary">{t("Welten importiert", "Worlds imported")}</span>
                      </div>
                    )}
                  </div>
                )}

                {importResult.warnings && importResult.warnings.length > 0 && (
                  <div className="p-3 bg-warning/10 border border-warning/20 rounded-2xl flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-small font-medium text-warning">
                        {t(
                          "Einige Dateien konnten nicht geladen werden:",
                          "Some files could not be downloaded:",
                        )}
                      </p>
                      <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-4">
                        {importResult.warnings.map((warning) => (
                          <li key={warning} className="text-small break-words text-ink-secondary">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

              </div>
            )}

            {previewError && !isLoadingPreview && step === "select" && (
              <div className="flex flex-col gap-3">
                <div className="p-3 bg-danger/10 border border-danger/20 rounded-2xl flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                  <span className="text-small text-danger">{previewError}</span>
                </div>
                <button
                  onClick={() => { setPreviewError(null); setStep("select"); }}
                  className="bg-surface hover:bg-hover border border-stroke text-ink py-3 rounded-2xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                >
                  {t("Erneut versuchen", "Try again")}
                </button>
              </div>
            )}
    </Dialog>
  );
};

interface MetaBadgeProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}

const MetaBadge: React.FC<MetaBadgeProps> = ({ icon: Icon, label, value }) => (
  <div className="bg-surface/40 border border-hairline rounded-xl p-2.5 flex items-center gap-2">
    <Icon className="w-3.5 h-3.5 text-ink-tertiary shrink-0" />
    <div className="min-w-0">
      <span className="block text-micro font-medium text-ink truncate">{value}</span>
      <span className="text-micro text-ink-tertiary uppercase font-medium tracking-label">{label}</span>
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
    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
      checked
        ? "border-success/30 bg-success/5 text-success"
        : "border-hairline bg-root/20 text-ink-secondary hover:text-ink hover:border-rim"
    }`}
  >
    {checked && <Check className="w-3 h-3" />}
    {label}
  </button>
);

