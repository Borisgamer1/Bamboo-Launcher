import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Download,
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
  Loader2,
} from "lucide-react";
import type { Instance } from "./InstancesView";
import type { ExportFormat, ExportOptions, ExportProgress } from "../services/profileExport";
import { profileExportService } from "../services/profileExport";
import { LanguageType } from "../lib/translations";
import { mainErrorText } from "../lib/mainErrors";
import { useToast } from "./Toast";
import { MOTION, EASE, motionSafe } from "../lib/motionTokens";
import { Dialog } from "./Dialog";

interface ProfileExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  instance: Instance;
  lang: LanguageType;
}

const footerButton =
  "flex-1 bg-surface hover:bg-hover border border-stroke text-ink py-3 rounded-2xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer";
const footerPrimary =
  "bg-accent hover:bg-accent-hover text-accent-contrast py-3 rounded-2xl text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer flex items-center justify-center gap-2 shadow-lg shadow-accent/10";

export const ProfileExportModal: React.FC<ProfileExportModalProps> = ({
  isOpen,
  onClose,
  instance,
  lang,
}) => {
  const t = useCallback((de: string, en: string) => lang === "de" ? de : en, [lang]);
  const { addToast } = useToast();

  type Step = "options" | "progress" | "complete";
  const [step, setStep] = useState<Step>("options");

  const [format, setFormat] = useState<ExportFormat>("zip");
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
  const [includeLauncherSettings] = useState(true);
  const [includeScreenshots, setIncludeScreenshots] = useState(false);
  const [includeIcon, setIncludeIcon] = useState(true);

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

  const buildOptions = useCallback((): ExportOptions => ({
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
  }), [
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
  ]);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setError(null);
    setProgress({ phase: "preparing", percent: 0, message: t("Export wird vorbereitet...", "Preparing export...") });
    setStep("progress");

    const result = await profileExportService.exportInstance(instance, buildOptions());

    if (result.success) {
      setExportResult({
        filePath: result.filePath,
        fileName: result.fileName,
        fileSize: result.fileSize,
      });

      setStep("complete");
    } else {
      setError(mainErrorText(result, lang, t("Export fehlgeschlagen", "Export failed")));
      setStep("options");
    }

    setIsExporting(false);
  }, [buildOptions, t, instance, lang]);

  const folderName = instance.folderName || instance.name.toLowerCase().replace(/\s+/g, "-");

  const handleOpenFileLocation = () => {
    if (exportResult?.filePath) {
      window.electronAPI?.dialogs.showItem?.(exportResult.filePath);
    }
  };

  const handleSaveFile = async () => {
    const ext = format === "mrpack" ? "mrpack" : "zip";
    const suggestedName = `${instance.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;

    const result = await window.electronAPI?.dialogs.save?.({
      defaultPath: suggestedName,
      filters: [
        ...(format === "mrpack" ? [{ name: "Modrinth Modpack", extensions: ["mrpack"] }] : []),
        ...(format === "zip" ? [{ name: "ZIP Archive", extensions: ["zip"] }] : []),
      ],
    });

    if (result && !result.canceled && result.filePath) {
      setIsExporting(true);
      setError(null);
      setProgress({ phase: "preparing", percent: 0, message: t("Export wird vorbereitet...", "Preparing export...") });
      setStep("progress");
      const options = buildOptions();

      const exportResult = await window.electronAPI?.profiles.export?.({
        format,
        instanceName: instance.name,
        folderName,
        manifest: profileExportService.buildManifest(instance, options),
        options,
        savePath: result.filePath ?? '',
        suggestedFileName: (result.filePath ?? '').split(/[/\\]/).pop() ?? '',
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
        setStep("options");
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

  const footer = step === "progress" ? undefined : (
    <div className="flex w-full gap-3">
      {step === "options" ? (
        <>
          <button type="button" onClick={onClose} className={footerButton}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className={`${footerPrimary} flex-[2] disabled:opacity-50 disabled:cursor-not-allowed`}
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
        </>
      ) : (
        <>
          <button type="button" onClick={onClose} className={footerButton}>
            {t("Schließen", "Close")}
          </button>
          <button type="button" onClick={handleSaveFile} className={`${footerPrimary} flex-1`}>
            <Download className="w-4 h-4" />
            {t("Speichern unter...", "Save as...")}
          </button>
        </>
      )}
    </div>
  );

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={t("Profil exportieren", "Export Profile")}
      titleId="profile-export-dialog-title"
      closeLabel={t("Schließen", "Close")}
      icon={<Download className="h-4 w-4" />}
      tone="accent"
      widthClassName="w-[672px]"
      bodyClassName="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6 text-small text-ink-secondary"
      footer={footer}
    >
      <p className="text-small text-ink-secondary mb-4 truncate">{instance.name}</p>

      {step === "options" && (
        <div className="flex flex-col gap-5">
          <div>
            <h4 className="text-micro font-medium text-ink-secondary uppercase mb-3 tracking-label">
              {t("Exportformat", "Export Format")}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: "mrpack" as const, label: "Modrinth", desc: t("Modrinth Modpack (.mrpack)", "Modrinth Modpack (.mrpack)"), icon: FileArchive },
                { id: "zip" as const, label: "ZIP", desc: t("ZIP Archive (.zip)", "ZIP Archive (.zip)"), icon: FileArchive },
              ].map((fmt, index) => (
                <button
                  key={fmt.id}
                  type="button"
                  data-autofocus={index === 0 ? true : undefined}
                  onClick={() => setFormat(fmt.id)}
                  className={`p-4 rounded-2xl border text-left transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                    format === fmt.id
                      ? "border-accent/40 bg-accent/10"
                      : "border-hairline bg-root/30 hover:border-rim"
                  }`}
                >
                  <fmt.icon className={`w-5 h-5 mb-2 ${format === fmt.id ? "text-accent" : "text-ink-secondary"}`} />
                  <span className={`block text-regular font-semibold ${format === fmt.id ? "text-accent" : "text-ink"}`}>{fmt.label}</span>
                  <span className="text-micro text-ink-tertiary mt-1 block">{fmt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-micro font-medium text-ink-secondary uppercase mb-3 tracking-label">
              {t("Inhalte auswählen", "Select Content")}
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {contentItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => item.setEnabled(!item.enabled)}
                    disabled={item.count === 0}
                    className={`flex items-center gap-3 p-3 rounded-2xl border transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
                      item.enabled
                        ? "border-accent/30 bg-accent/5"
                        : "border-hairline bg-root/20 hover:border-rim"
                    } ${item.count === 0 ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                      item.enabled ? "bg-accent/15 text-accent" : "bg-surface text-ink-tertiary"
                    }`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 text-left">
                      <span className={`block text-small font-medium ${item.enabled ? "text-accent" : "text-ink"}`}>
                        {item.label}
                      </span>
                      <span className="text-micro text-ink-tertiary">{item.count} {t("Dateien", "files")}</span>
                    </div>
                    {item.enabled && <Check className="w-4 h-4 text-accent" />}
                  </button>
                );
              })}
            </div>

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

          {error && (
            <div className="p-3 bg-danger/10 border border-danger/20 rounded-2xl flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <span className="text-small text-danger">{error}</span>
            </div>
          )}
        </div>
      )}

      {step === "progress" && (
        <div className="flex flex-col items-center justify-center py-10 gap-4">
          <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
          </div>
          <div className="text-center">
            <p className="text-regular font-medium text-ink">{progress.message}</p>
            <p className="text-micro text-ink-tertiary mt-1">
              {t("Phase:", "Phase:")} {progress.phase}
            </p>
          </div>
          <div className="w-full max-w-xs bg-surface rounded-full h-2 overflow-hidden">
            <motion.div
              className="h-full bg-accent rounded-full"
              initial={{ width: "0%" }}
              animate={{ width: `${progress.percent}%` }}
              transition={motionSafe({ duration: MOTION.slow, ease: EASE.out })}
            />
          </div>
          <span className="text-small font-medium text-ink-secondary">{progress.percent}%</span>
        </div>
      )}

      {step === "complete" && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col items-center justify-center py-6 gap-3">
            <div className="w-16 h-16 rounded-2xl bg-success/10 border border-success/20 flex items-center justify-center">
              <Check className="w-8 h-8 text-success" />
            </div>
            <div className="text-center">
              <p className="text-large font-semibold text-success">
                {t("Export abgeschlossen!", "Export completed!")}
              </p>
              {exportResult?.fileSize && (
                <p className="text-small text-ink-secondary mt-1">
                  {t("Größe:", "Size:")} {(exportResult.fileSize >= 1073741824) ? (exportResult.fileSize / 1073741824).toFixed(2) + ' GB' : (exportResult.fileSize >= 1048576) ? (exportResult.fileSize / 1048576).toFixed(1) + ' MB' : (exportResult.fileSize / 1024).toFixed(0) + ' KB'}
                </p>
              )}
            </div>
          </div>

          {exportResult?.filePath && (
            <div className="bg-surface/40 border border-stroke rounded-2xl p-3 flex items-center justify-between">
              <span className="text-small text-ink-secondary truncate max-w-[70%]">{exportResult.filePath}</span>
              <button
                type="button"
                onClick={handleOpenFileLocation}
                className="p-2 bg-surface hover:bg-hover border border-stroke rounded-xl text-ink-secondary hover:text-ink transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer"
                title={t("Pfad öffnen", "Open file location")}
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
};

interface ToggleButtonProps {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  label: string;
  icon: React.FC<{ className?: string }>;
}

const ToggleButton: React.FC<ToggleButtonProps> = ({ enabled, setEnabled, label, icon: Icon }) => (
  <button
    type="button"
    onClick={() => setEnabled(!enabled)}
    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-small font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,filter] cursor-pointer ${
      enabled
        ? "border-accent/30 bg-accent/5 text-accent"
        : "border-hairline bg-root/20 text-ink-secondary hover:text-ink hover:border-rim"
    }`}
  >
    <Icon className="w-3.5 h-3.5" />
    {label}
  </button>
);
