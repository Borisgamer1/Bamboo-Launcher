// ============================================================
// Profile Import Service v0.1.0
// Supports: .bamboo, .mrpack, .zip
// ============================================================

import type { Instance } from "../components/InstancesView";

// ===== Types =====

export type ImportFormat = "bamboo" | "mrpack" | "zip" | "unknown";

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
  type: "existing_instance" | "version_mismatch" | "missing_loader" | "missing_java" | "duplicate_name" | "mod_conflict";
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

export interface ImportProgress {
  phase: "detecting" | "preparing" | "downloading" | "extracting" | "installing" | "verifying" | "complete" | "error";
  percent: number;
  message: string;
}

export interface ImportResult {
  success: boolean;
  instanceId?: string;
  instanceName?: string;
  error?: string;
  details?: {
    modsInstalled: number;
    resourcepacksInstalled: number;
    shaderpacksInstalled: number;
    datapacksInstalled: number;
    worldsImported: number;
    conflicts: Conflict[];
  };
}

// ===== Service =====

class ProfileImportService {
  private progressListeners: Set<(progress: ImportProgress) => void> = new Set();

  subscribe(listener: (progress: ImportProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private notify(progress: ImportProgress) {
    this.progressListeners.forEach((fn) => fn(progress));
  }

  /**
   * Detect the format of a given file based on extension and content
   */
  detectFormat(filePath: string): ImportFormat {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".bamboo")) return "bamboo";
    if (lower.endsWith(".mrpack")) return "mrpack";
    if (lower.endsWith(".zip")) return "zip";
    return "unknown";
  }

  /**
   * Get a preview of the import content from a file
   */
  async getPreview(filePath: string): Promise<ImportPreview> {
    this.notify({ phase: "detecting", percent: 10, message: "Analysiere Datei..." });

    const format = this.detectFormat(filePath);

    if (format === "unknown") {
      throw new Error("Unbekanntes Dateiformat. Unterstützt werden: .bamboo, .mrpack, .zip");
    }

    this.notify({ phase: "preparing", percent: 30, message: "Lese Paketinformationen..." });

    // Use Electron IPC to read the preview — format is detected server-side
    const preview = await window.electronAPI?.importPreview?.(filePath);

    if (!preview) {
      throw new Error("Konnte keine Vorschau des Pakets erstellen.");
    }

    return {
      format,
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

  /**
   * Check for conflicts with existing instances
   */
  async checkConflicts(
    preview: ImportPreview,
    existingInstances: Instance[]
  ): Promise<ConflictCheck> {
    const conflicts: Conflict[] = [];

    // Check for existing instance with same name
    const nameMatch = existingInstances.find(
      (i) => i.name.toLowerCase() === preview.title.toLowerCase()
    );

    if (nameMatch) {
      conflicts.push({
        type: "existing_instance",
        severity: "error",
        message: `Eine Instanz mit dem Namen "${preview.title}" existiert bereits.`,
        resolution: "Möchtest du sie überschreiben oder eine neue Instanz erstellen?",
        autoResolvable: true,
      });
    }

    // Check for duplicate names (case-insensitive)
    const duplicateNames = existingInstances.filter(
      (i) => i.name.toLowerCase() === preview.title.toLowerCase()
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

    // Check modloader compatibility
    if (preview.modloader !== "Vanilla") {
      const compatibleInstances = existingInstances.filter(
        (i) => i.modloader === preview.modloader
      );
      if (compatibleInstances.length === 0) {
        conflicts.push({
          type: "missing_loader",
          severity: "warning",
          message: `Der Modloader "${preview.modloader}" wird für diese Instanz benötigt.`,
          resolution: `Der Launcher wird ${preview.modloader} automatisch installieren.`,
          autoResolvable: true,
        });
      }
    }

    // Check Java version compatibility
    const majorVersion = parseInt(preview.minecraftVersion.split(".")[0] || "1");
    if (majorVersion >= 21) {
      conflicts.push({
        type: "missing_java",
        severity: "info",
        message: `Minecraft ${preview.minecraftVersion} benötigt Java 21 oder neuer.`,
        resolution: "Der Launcher prüft automatisch auf eine kompatible Java-Version.",
        autoResolvable: true,
      });
    } else if (majorVersion >= 1 && parseInt(preview.minecraftVersion.split(".")[1] || "0") >= 17) {
      conflicts.push({
        type: "missing_java",
        severity: "info",
        message: `Minecraft ${preview.minecraftVersion} benötigt Java 17 oder neuer.`,
        resolution: "Der Launcher prüft automatisch auf eine kompatible Java-Version.",
        autoResolvable: true,
      });
    }

    // Version mismatch warning
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

  /**
   * Execute the import
   */
  async importProfile(
    filePath: string,
    preview: ImportPreview,
    options: ImportOptions,
    existingInstances: Instance[]
  ): Promise<ImportResult> {
    try {
      this.notify({ phase: "preparing", percent: 10, message: "Import wird vorbereitet..." });

      this.notify({ phase: "extracting", percent: 25, message: "Extrahiere Paket..." });

      const result = await window.electronAPI?.importProfile?.({
        filePath,
        format: preview.format,
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

      this.notify({ phase: "installing", percent: 60, message: "Installiere Inhalte..." });

      this.notify({ phase: "verifying", percent: 85, message: "Überprüfe Installation..." });

      this.notify({ phase: "complete", percent: 100, message: "Import abgeschlossen!" });

      return {
        success: true,
        instanceId: result.instanceId,
        instanceName: result.instanceName,
        details: {
          modsInstalled: result.modsInstalled || 0,
          resourcepacksInstalled: result.resourcepacksInstalled || 0,
          shaderpacksInstalled: result.shaderpacksInstalled || 0,
          datapacksInstalled: result.datapacksInstalled || 0,
          worldsImported: result.worldsImported || 0,
          conflicts: [],
        },
      };
    } catch (err: any) {
      this.notify({ phase: "error", percent: 0, message: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Generate a unique instance name to avoid conflicts
   */
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

  /**
   * Format file size for display
   */
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
