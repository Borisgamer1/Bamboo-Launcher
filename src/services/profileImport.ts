import type { Instance } from "../components/InstancesView";
import type { IpcProfile } from "../hooks/useInstances";

export type ImportFormat = "mrpack" | "zip";

export interface ImportPreview {
  format: ImportFormat;
  title: string;
  minecraftVersion: string;
  modloader: string;
  modloaderVersion?: string;
  description: string;
  author?: string;
  fileSize: number;
  totalFiles: number;
  modCount: number;
  resourcepackCount: number;
  shaderCount: number;
  datapackCount: number;
  worldCount: number;
  hasIcon: boolean;
  hasBanner: boolean;
  hasConfig: boolean;
  hasScreenshots: boolean;
  worlds?: string[];
  isModpack?: boolean;
}

export interface ConflictCheck {
  hasConflicts: boolean;
  conflicts: Conflict[];
}

export interface Conflict {
  // Java is checked at launch, never at import: every player already has it.
  type: "existing_instance" | "version_mismatch" | "duplicate_name" | "mod_conflict";
  severity: "error" | "warning" | "info";
  message: string;
  resolution?: string;
  autoResolvable?: boolean;
}

export interface ImportOptions {
  targetInstanceName: string;
  resolutionStrategy: "create_new" | "overwrite" | "merge" | "skip";
  installMods: boolean;
  installResourcepacks: boolean;
  installShaderpacks: boolean;
  installDatapacks: boolean;
  installWorlds: boolean;
  installConfig: boolean;
  installScreenshots: boolean;
}

export interface ImportResult {
  success: boolean
  instanceId?: string
  instanceName?: string
  profile?: IpcProfile
  error?: string
  warnings?: string[]
  details?: {
    modsInstalled: number;
    resourcepacksInstalled: number;
    shaderpacksInstalled: number;
    datapacksInstalled: number;
    worldsImported: number;
    conflicts: Conflict[];
  };
}

class ProfileImportService {
  async getPreview(filePath: string): Promise<ImportPreview> {
    const preview = await window.electronAPI?.profiles.importPreview?.(filePath);

    if (!preview || preview.error) {
      throw new Error(preview?.error || "Konnte keine Vorschau des Pakets erstellen.");
    }

    return {
      format: preview.format ?? "zip",
      title: preview.title || "Unbekanntes Paket",
      minecraftVersion: preview.minecraftVersion || "1.21",
      modloader: preview.modloader || "Vanilla",
      modloaderVersion: preview.modloaderVersion,
      description: preview.description || "",
      author: preview.author,
      fileSize: preview.fileSize || 0,
      totalFiles: preview.totalFiles || 0,
      modCount: preview.modCount || 0,
      resourcepackCount: preview.resourcepackCount || 0,
      shaderCount: preview.shaderCount || 0,
      datapackCount: preview.datapackCount || 0,
      worldCount: preview.worldCount || 0,
      hasIcon: preview.hasIcon || false,
      hasBanner: preview.hasBanner || false,
      hasConfig: preview.hasConfig || false,
      hasScreenshots: preview.hasScreenshots || false,
      worlds: preview.worlds,
      isModpack: preview.isModpack,
    };
  }

  async checkConflicts(
    preview: ImportPreview,
    existingInstances: Instance[],
    targetName?: string
  ): Promise<ConflictCheck> {
    const conflicts: Conflict[] = [];
    // The name the user typed in the import dialog is what will be created, so
    // it is the only name that may count as an existing-instance conflict.
    const target = (targetName || preview.title).trim() || preview.title;

    const nameMatch = existingInstances.find(
      (i) => i.name.toLowerCase() === target.toLowerCase()
    );

    if (nameMatch) {
      conflicts.push({
        type: "existing_instance",
        severity: "error",
        message: `Eine Instanz mit dem Namen "${target}" existiert bereits.`,
        resolution: "Möchtest du sie überschreiben oder eine neue Instanz erstellen?",
        autoResolvable: true,
      });
    }

    const duplicateNames = existingInstances.filter(
      (i) => i.name.toLowerCase() === target.toLowerCase()
    );
    if (duplicateNames.length > 1) {
      conflicts.push({
        type: "duplicate_name",
        severity: "warning",
        message: `Es gibt ${duplicateNames.length} Instanzen mit demselben Namen.`,
        resolution: "Wähle einen eindeutigen Namen für die importierte Instanz.",
        autoResolvable: true,
      });
    }

    // No loader/version warnings here: the launcher installs the required
    // modloader and Minecraft version itself, so they are never a conflict.

    if (preview.minecraftVersion && existingInstances.length > 0) {
      const sameVersion = existingInstances.some(
        (i) => i.minecraftVersion === preview.minecraftVersion
      );
      if (!sameVersion) {
        conflicts.push({
          type: "version_mismatch",
          severity: "info",
          message: `Minecraft ${preview.minecraftVersion} wird noch nicht in deinen Instanzen verwendet.`,
          resolution: "Der Launcher lädt die benötigte Version automatisch herunter.",
          autoResolvable: true,
        });
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
    };
  }

  async importProfile(
    filePath: string,
    preview: ImportPreview,
    options: ImportOptions,
    taskId: string,
  ): Promise<ImportResult> {
    try {
      const result = await window.electronAPI?.profiles.import?.({
        filePath,
        taskId,
        targetInstanceName: options.targetInstanceName || preview.title,
        installMods: options.installMods,
        installResourcepacks: options.installResourcepacks,
        installShaderpacks: options.installShaderpacks,
        installDatapacks: options.installDatapacks,
        installWorlds: options.installWorlds,
        installConfig: options.installConfig,
        installScreenshots: options.installScreenshots,
      });

      if (!result || !result.success) {
        throw new Error(result?.error || "Import fehlgeschlagen");
      }

      return {
        success: true,
        instanceId: result.instanceId,
        instanceName: result.instanceName,
        profile: result.profile as IpcProfile | undefined,
        ...(Array.isArray(result.warnings) && result.warnings.length > 0
          ? { warnings: result.warnings }
          : {}),
        details: {
          modsInstalled: result.modsInstalled || 0,
          resourcepacksInstalled: result.resourcepacksInstalled || 0,
          shaderpacksInstalled: result.shaderpacksInstalled || 0,
          datapacksInstalled: result.datapacksInstalled || 0,
          worldsImported: result.worldsImported || 0,
          conflicts: [],
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  generateUniqueName(baseName: string, existingInstances: Instance[]): string {
    const existingNames = new Set(existingInstances.map((i) => i.name.toLowerCase()));
    if (!existingNames.has(baseName.toLowerCase())) {
      return baseName;
    }

    let counter = 1;
    while (existingNames.has(`${baseName} (${counter})`.toLowerCase())) {
      counter++;
    }
    return `${baseName} (${counter})`;
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
}

export const profileImportService = new ProfileImportService();
export default profileImportService;
