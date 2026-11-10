import React, { useState } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  FolderOpen,
  Globe,
  HardDrive,
  Image,
  Layers,
  Loader2,
  Package,
  Shirt,
} from "lucide-react";
import type { Instance } from "./InstancesView";
import type {
  ExternalInstanceCounts,
  ExternalInstancePreviewPayload,
  ImportProfileResult,
} from "../electron-api";
import type { LanguageType } from "../lib/translations";
import { instanceFolderKeyOf } from "../lib/instanceFolders";
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from "../lib/backgroundTasks";

interface ExternalImportPanelProps {
  instances: Instance[];
  lang: LanguageType;
  onBack: () => void;
  onImported: (result: ImportProfileResult, iconDataUrl: string | null) => void;
}

type Preview = ExternalInstancePreviewPayload & {
  sourceLabel: string;
  name: string;
  minecraftVersion: string;
  counts: ExternalInstanceCounts;
};

const LOADER_LABELS: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
};

/// Instanznamen dürfen keine Pfadtrenner enthalten; Pack-Namen aus anderen
/// Launchern tun das gelegentlich.
function safeName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 60);
  return cleaned || "Import";
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * Übernimmt eine fertige Instanz aus Prism/MultiMC, der CurseForge App oder
 * der Modrinth App. Der Ordner wird erkannt, die Inhalte werden kopiert und
 * der erkannte Loader installiert; fremde Versionen und Assets bleiben liegen.
 */
export const ExternalImportPanel: React.FC<ExternalImportPanelProps> = ({
  instances,
  lang,
  onBack,
  onImported,
}) => {
  const t = (de: string, en: string) => (lang === "de" ? de : en);
  const [directory, setDirectory] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [iconSrc, setIconSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetMode, setTargetMode] = useState<"new" | "existing">("new");
  const [mergeFolder, setMergeFolder] = useState(() =>
    instances.length > 0 ? instanceFolderKeyOf(instances[0]) : "",
  );
  const [isImporting, setIsImporting] = useState(false);
  const [installMods, setInstallMods] = useState(true);
  const [installResourcepacks, setInstallResourcepacks] = useState(true);
  const [installShaderpacks, setInstallShaderpacks] = useState(true);
  const [installDatapacks, setInstallDatapacks] = useState(true);
  const [installWorlds, setInstallWorlds] = useState(true);
  const [installConfig, setInstallConfig] = useState(true);
  const [installScreenshots, setInstallScreenshots] = useState(false);

  const nameTaken =
    targetMode === "new" &&
    instances.some(
      (instance) => instance.name.trim().toLowerCase() === targetName.trim().toLowerCase(),
    );
  const mergeTarget = instances.find(
    (instance) => instanceFolderKeyOf(instance) === mergeFolder,
  );
  const wantsMerge = targetMode === "existing";
  const missingTarget = wantsMerge ? !mergeTarget : nameTaken || !targetName.trim();
  // Ein Merge ergänzt nur Inhalte; er kann die Version einer Instanz nicht
  // ändern. Bei abweichender Version oder Loader ist ein Hinweis angebracht.
  const loaderLabel = (loader?: string | null) =>
    loader ? LOADER_LABELS[loader] ?? loader : t("Vanilla", "Vanilla");
  const versionMismatch =
    !!preview &&
    !!mergeTarget &&
    (mergeTarget.minecraftVersion !== preview.minecraftVersion ||
      mergeTarget.modloader.toLowerCase() !== loaderLabel(preview.loader).toLowerCase());

  const uniqueName = (raw: string) => {
    const base = safeName(raw);
    const names = new Set(instances.map((instance) => instance.name.trim().toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    let counter = 1;
    while (names.has(`${base} (${counter})`.toLowerCase())) counter += 1;
    return `${base} (${counter})`;
  };

  const chooseFolder = async () => {
    const result = await window.electronAPI?.dialogs.open?.({ properties: ["openDirectory"] });
    if (!result || result.canceled || !result.filePaths?.length) return;
    const selected = result.filePaths[0];
    setDirectory(selected);
    setIsLoading(true);
    setError(null);
    try {
      const detected = await window.electronAPI?.profiles.externalPreview?.(selected);
      if (!detected || !detected.success) {
        throw new Error(
          detected?.error ||
            t(
              "Dieser Ordner ist keine unterstützte Instanz.",
              "This folder is not a supported instance.",
            ),
        );
      }
      const value = detected as Preview;
      setPreview(value);
      setTargetName(uniqueName(value.name));
      // A filesystem path cannot be loaded by the webview directly.
      setIconSrc(
        value.iconPath
          ? (await window.electronAPI?.dialogs.readImage?.(value.iconPath)) ?? null
          : null,
      );
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const startImport = async () => {
    const target = wantsMerge ? mergeFolder : targetName.trim();
    if (!directory || !preview || !target) return;
    setIsImporting(true);
    setError(null);
    const label = wantsMerge ? mergeTarget?.name ?? target : targetName;
    const taskId = newBackgroundTaskId("import");
    beginBackgroundTask({
      id: taskId,
      title: t(`Importiere ${label}…`, `Importing ${label}…`),
      detail: t("Kopiere Mods, Welten und Configs…", "Copying mods, worlds and configs…"),
      // Copying reports no byte progress; an indeterminate bar beats a fake 5 %.
      percent: null,
    });
    try {
      const result = await window.electronAPI?.profiles.importExternal?.({
        directory,
        targetInstanceName: target,
        mergeIntoExisting: wantsMerge,
        installMods,
        installResourcepacks,
        installShaderpacks,
        installDatapacks,
        installWorlds,
        installConfig,
        installScreenshots,
      });
      if (!result || !result.success) {
        throw new Error(result?.error || t("Import fehlgeschlagen", "Import failed"));
      }
      completeBackgroundTask(
        taskId,
        t("Import abgeschlossen", "Import completed"),
      );
      onImported(result, wantsMerge ? null : iconSrc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      failBackgroundTask(taskId, message);
    } finally {
      setIsImporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <Loader2 className="h-8 w-8 animate-spin text-info" />
        <p className="text-regular text-ink">
          {t("Erkenne Launcher-Instanz…", "Detecting launcher instance…")}
        </p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex flex-col gap-4">
        <button
          data-autofocus
          onClick={() => void chooseFolder()}
          className="group flex cursor-pointer items-center gap-4 rounded-2xl border-2 border-dashed border-stroke-strong bg-surface/20 p-6 transition-[color,background-color,border-color,box-shadow,opacity,transform] hover:border-info/50 hover:bg-info/5"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stroke bg-surface text-ink-secondary transition-colors group-hover:border-info/30 group-hover:text-info">
            <FolderOpen className="h-7 w-7" />
          </div>
          <div className="text-left">
            <span className="block text-regular font-medium text-ink group-hover:text-info">
              {t("Instanz-Ordner auswählen", "Select instance folder")}
            </span>
            <span className="mt-1 block text-small text-ink-tertiary">
              {t(
                "Prism/MultiMC, CurseForge App oder Modrinth App",
                "Prism/MultiMC, CurseForge App or Modrinth App",
              )}
            </span>
          </div>
        </button>

        {error && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-danger/20 bg-danger/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <span className="text-small text-danger">{error}</span>
          </div>
        )}

        <button
          onClick={onBack}
          className="self-start text-small font-medium text-ink-secondary transition-colors hover:text-ink"
        >
          {t("Zurück zur Dateiauswahl", "Back to file import")}
        </button>
      </div>
    );
  }

  const counts = preview.counts;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-hairline bg-surface/40 p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-info/20 bg-info/10 text-info">
            {iconSrc ? (
              <img
                src={iconSrc}
                alt=""
                className="h-full w-full object-cover"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <Package className="h-6 w-6" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-large font-semibold text-ink">{preview.name}</h4>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="rounded-lg border border-info/20 bg-info/10 px-2 py-0.5 text-micro font-medium uppercase tracking-label text-info">
                {preview.sourceLabel}
              </span>
              <span className="rounded-lg bg-raised px-2 py-0.5 text-micro font-medium text-ink">
                {preview.minecraftVersion}
              </span>
              <span className="rounded-lg border border-warning/20 bg-warning/10 px-2 py-0.5 text-micro font-medium text-warning">
                {preview.loader
                  ? `${LOADER_LABELS[preview.loader] ?? preview.loader}${
                      preview.loaderVersion ? ` ${preview.loaderVersion}` : ""
                    }`
                  : t("Vanilla", "Vanilla")}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetaBadge icon={Package} label="Mods" value={String(counts.mods)} />
          <MetaBadge icon={Image} label="Resource Packs" value={String(counts.resourcepacks)} />
          <MetaBadge icon={Shirt} label="Shader" value={String(counts.shaderpacks)} />
          <MetaBadge icon={Globe} label={t("Welten", "Worlds")} value={String(counts.worlds)} />
          <MetaBadge icon={Layers} label="Data Packs" value={String(counts.datapacks)} />
          <MetaBadge icon={FileText} label="Config" value={String(counts.config)} />
          <MetaBadge icon={HardDrive} label={t("Größe", "Size")} value={formatBytes(counts.bytes)} />
          <MetaBadge icon={FileText} label={t("Dateien", "Files")} value={String(counts.files)} />
        </div>
      </div>

      <div>
        <h4 className="mb-3 text-micro font-medium uppercase tracking-label text-ink-secondary">
          {t("Import-Optionen", "Import Options")}
        </h4>

        <div className="mb-3">
          <label className="mb-1 block text-micro font-medium uppercase tracking-label text-ink-tertiary">
            {t("Ziel", "Target")}
          </label>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => setTargetMode("new")}
              className={`rounded-xl border px-3 py-2 text-small font-medium transition-[color,background-color,border-color] ${
                !wantsMerge
                  ? "border-info/30 bg-info/10 text-info"
                  : "border-hairline bg-root/20 text-ink-secondary hover:border-rim hover:text-ink"
              }`}
            >
              {t("Neue Instanz", "New instance")}
            </button>
            <button
              onClick={() => setTargetMode("existing")}
              disabled={instances.length === 0}
              className={`rounded-xl border px-3 py-2 text-small font-medium transition-[color,background-color,border-color] disabled:cursor-not-allowed disabled:opacity-40 ${
                wantsMerge
                  ? "border-info/30 bg-info/10 text-info"
                  : "border-hairline bg-root/20 text-ink-secondary hover:border-rim hover:text-ink"
              }`}
            >
              {t("Bestehende Instanz", "Existing instance")}
            </button>
          </div>

          {wantsMerge ? (
            <>
              <select
                value={mergeFolder}
                onChange={(event) => setMergeFolder(event.target.value)}
                className="w-full rounded-xl border border-stroke bg-root px-3 py-2.5 text-regular font-medium text-ink outline-none transition-[border-color] focus:border-info/50"
              >
                {instances.map((instance) => {
                  const folder = instanceFolderKeyOf(instance);
                  return (
                    <option key={folder} value={folder}>
                      {instance.name} · {instance.minecraftVersion} · {instance.modloader}
                    </option>
                  );
                })}
              </select>
              <p className="mt-1.5 text-micro text-ink-tertiary">
                {t(
                  "Nur fehlende Dateien kommen dazu; vorhandene Dateien und Welten bleiben unverändert.",
                  "Only missing files are added; existing files and worlds stay untouched.",
                )}
              </p>
              {versionMismatch && mergeTarget && (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span className="text-micro text-warning">
                    {t(
                      `Achtung: Die Instanz nutzt Minecraft ${mergeTarget.minecraftVersion} (${mergeTarget.modloader}), das Pack bringt ${preview.minecraftVersion} (${loaderLabel(preview.loader)}) mit. Mods können unpassend sein.`,
                      `Careful: the instance uses Minecraft ${mergeTarget.minecraftVersion} (${mergeTarget.modloader}), the pack brings ${preview.minecraftVersion} (${loaderLabel(preview.loader)}). Mods may not fit.`,
                    )}
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="mb-1 block text-micro font-medium uppercase tracking-label text-ink-tertiary">
                {t("Instanzname", "Instance Name")}
              </label>
              <input
                type="text"
                value={targetName}
                onChange={(event) => setTargetName(event.target.value)}
                aria-invalid={nameTaken}
                className={`w-full rounded-xl border bg-root px-3 py-2.5 text-regular font-medium text-ink outline-none transition-[border-color] ${
                  nameTaken ? "border-danger/60 focus:border-danger" : "border-stroke focus:border-info/50"
                }`}
              />
              {nameTaken && (
                <p className="mt-1 text-micro text-danger">
                  {t(
                    "Dieser Name ist bereits vergeben – wähle einen anderen.",
                    "This name is already taken – choose another.",
                  )}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <ToggleCheck checked={installMods} setChecked={setInstallMods} label="Mods" />
          <ToggleCheck
            checked={installResourcepacks}
            setChecked={setInstallResourcepacks}
            label="Resource Packs"
          />
          <ToggleCheck checked={installShaderpacks} setChecked={setInstallShaderpacks} label="Shader" />
          <ToggleCheck checked={installDatapacks} setChecked={setInstallDatapacks} label="Data Packs" />
          <ToggleCheck checked={installWorlds} setChecked={setInstallWorlds} label={t("Welten", "Worlds")} />
          <ToggleCheck checked={installConfig} setChecked={setInstallConfig} label="Config" />
          <ToggleCheck
            checked={installScreenshots}
            setChecked={setInstallScreenshots}
            label="Screenshots"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-danger/20 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span className="text-small text-danger">{error}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onBack}
          disabled={isImporting}
          className="rounded-xl border border-stroke bg-surface px-3 py-2 text-small font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
        >
          {t("Zurück", "Back")}
        </button>
        <button
          onClick={() => {
            setPreview(null);
            setIconSrc(null);
            setDirectory(null);
            setError(null);
          }}
          disabled={isImporting}
          className="rounded-xl border border-stroke bg-surface px-3 py-2 text-small font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50"
        >
          {t("Anderen Ordner wählen", "Choose another folder")}
        </button>
        <button
          onClick={() => void startImport()}
          disabled={isImporting || missingTarget}
          className="flex items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-small font-medium text-info transition-colors hover:bg-info/20 disabled:opacity-50"
        >
          {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
          {isImporting
            ? t("Importiere…", "Importing…")
            : wantsMerge
              ? t("In Instanz übernehmen", "Merge into instance")
              : t("Instanz importieren", "Import instance")}
        </button>
      </div>
    </div>
  );
};

interface MetaBadgeProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
}

const MetaBadge: React.FC<MetaBadgeProps> = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-2 rounded-xl border border-hairline bg-surface/40 p-2.5">
    <Icon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
    <div className="min-w-0">
      <span className="block truncate text-micro font-medium text-ink">{value}</span>
      <span className="text-micro font-medium uppercase tracking-label text-ink-tertiary">{label}</span>
    </div>
  </div>
);

interface ToggleCheckProps {
  checked: boolean;
  setChecked: (value: boolean) => void;
  label: string;
}

const ToggleCheck: React.FC<ToggleCheckProps> = ({ checked, setChecked, label }) => (
  <button
    onClick={() => setChecked(!checked)}
    className={`flex cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-2 text-small font-medium transition-[color,background-color,border-color] ${
      checked
        ? "border-success/30 bg-success/5 text-success"
        : "border-hairline bg-root/20 text-ink-secondary hover:border-rim hover:text-ink"
    }`}
  >
    {checked && <Check className="h-3 w-3" />}
    {label}
  </button>
);
