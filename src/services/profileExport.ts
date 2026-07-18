// ============================================================
// Profile Export Service v0.1.0
// Supports: .bamboo, .mrpack, .zip
// ============================================================

import type { Instance } from "../components/InstancesView";

// ===== Types =====

export type ExportFormat = "bamboo" | "mrpack" | "zip";

export interface ExportOptions {
  format: ExportFormat;
  includeMods: boolean;
  includeResourcepacks: boolean;
  includeShaderpacks: boolean;
  includeDatapacks: boolean;
  includeWorlds: boolean;
  includeConfig: boolean;
  includeJvmSettings: boolean;
  includeLauncherSettings: boolean;
  includeScreenshots: boolean;
  includeIcon: boolean;
  includeBanner: boolean;
  selectedWorlds?: string[]; // If empty, all worlds; if null, none
}

export interface ExportProgress {
  phase: "preparing" | "collecting" | "packaging" | "hashing" | "complete" | "error";
  percent: number;
  message: string;
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  error?: string;
}

export interface BambooManifest {
  formatVersion: number;
  launcher: string;
  launcherVersion: string;
  exportedAt: string;
  instance: {
    name: string;
    minecraftVersion: string;
    modloader: string;
    modloaderVersion?: string;
    ram?: number;
    javaVersion?: string;
    description: string;
    lastPlayed: string;
    isModpack?: boolean;
    modpackProjectId?: string;
    modpackSource?: string;
    modpackVersion?: string;
    contentManagement?: boolean;
  };
  contents: {
    mods: { count: number; files: string[] };
    resourcepacks: { count: number; files: string[] };
    shaderpacks: { count: number; files: string[] };
    datapacks: { count: number; files: string[] };
    worlds: { count: number; files: string[] };
    config: { count: number; files: string[] };
    screenshots: { count: number; files: string[] };
    icon: string | null;
    banner: string | null;
  };
  metadata: {
    author?: string;
    description?: string;
    tags?: string[];
    totalSize?: number;
  };
}

// ===== Constants =====
const BAMBOO_FORMAT_VERSION = 1;
const LAUNCHER_NAME = "Bamboo Launcher";
const LAUNCHER_VERSION = "0.1.0";

// ===== Service =====

class ProfileExportService {
  private progressListeners: Set<(progress: ExportProgress) => void> = new Set();

  subscribe(listener: (progress: ExportProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private notify(progress: ExportProgress) {
    this.progressListeners.forEach((fn) => fn(progress));
  }

  private generateInstanceId(instance: Instance): string {
    return instance.id || `inst_export_${Date.now()}`;
  }

  /**
   * Build a BambooManifest from an Instance and export options
   */
  buildManifest(instance: Instance, options: ExportOptions): BambooManifest {
    const contentFiles = instance.content || [];
    const installedMods = instance.installedMods || [];

    const filterContent = (type: string): string[] => {
      return contentFiles
        .filter((c) => c.type === type)
        .map((c) => c.fileName || c.name);
    };

    return {
      formatVersion: BAMBOO_FORMAT_VERSION,
      launcher: LAUNCHER_NAME,
      launcherVersion: LAUNCHER_VERSION,
      exportedAt: new Date().toISOString(),
      instance: {
        name: instance.name,
        minecraftVersion: instance.minecraftVersion,
        modloader: instance.modloader,
        modloaderVersion: instance.modloaderVersion,
        ram: instance.ram,
        javaVersion: instance.javaVersion,
        description: instance.desc,
        lastPlayed: instance.lastPlayed,
        isModpack: instance.isModpack,
        modpackProjectId: instance.modpackProjectId,
        modpackSource: instance.modpackSource,
        modpackVersion: instance.modpackVersion,
        contentManagement: instance.ownContentManagement,
      },
      contents: {
        mods: {
          count: options.includeMods ? filterContent("mods").length : 0,
          files: options.includeMods ? filterContent("mods") : [],
        },
        resourcepacks: {
          count: options.includeResourcepacks ? filterContent("resourcepacks").length : 0,
          files: options.includeResourcepacks ? filterContent("resourcepacks") : [],
        },
        shaderpacks: {
          count: options.includeShaderpacks ? filterContent("shaderpacks").length : 0,
          files: options.includeShaderpacks ? filterContent("shaderpacks") : [],
        },
        datapacks: {
          count: options.includeDatapacks ? filterContent("datapacks").length : 0,
          files: options.includeDatapacks ? filterContent("datapacks") : [],
        },
        worlds: {
          count: options.includeWorlds ? (options.selectedWorlds?.length || 0) : 0,
          files: options.includeWorlds ? (options.selectedWorlds || []) : [],
        },
        config: {
          count: options.includeConfig ? 1 : 0,
          files: options.includeConfig ? ["options.txt", "servers.dat"] : [],
        },
        screenshots: {
          count: options.includeScreenshots ? 0 : 0, // Will be filled during collection
          files: [],
        },
        icon: options.includeIcon ? (instance.thumbnail || null) : null,
        banner: options.includeBanner ? null : null,
      },
      metadata: {
        author: "",
        description: instance.desc,
        totalSize: 0,
      },
    };
  }

  /**
   * Export an instance to the selected format
   */
  async exportInstance(
    instance: Instance,
    options: ExportOptions
  ): Promise<ExportResult> {
    try {
      this.notify({ phase: "preparing", percent: 0, message: "Export wird vorbereitet..." });

      // Get the folder name for this instance
      const folderName = instance.name.toLowerCase().replace(/\\s+/g, "-");

      this.notify({ phase: "collecting", percent: 10, message: "Sammle Daten..." });

      // Build manifest
      const manifest = this.buildManifest(instance, options);

      this.notify({ phase: "packaging", percent: 30, message: "Erstelle Paket..." });

      let result: ExportResult;

      switch (options.format) {
        case "bamboo":
          result = await this.exportBamboo(instance, folderName, manifest, options);
          break;
        case "mrpack":
          result = await this.exportMrpack(instance, folderName, manifest, options);
          break;
        case "zip":
          result = await this.exportZip(instance, folderName, manifest, options);
          break;
        default:
          return { success: false, error: `Unsupported format: ${options.format}` };
      }

      this.notify({ phase: "complete", percent: 100, message: "Export abgeschlossen!" });

      if (options.format === "bamboo" || options.format === "zip") {
        return result;
      }

      return result;
    } catch (err: any) {
      this.notify({ phase: "error", percent: 0, message: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Export as .bamboo format (ZIP-based with manifest.json)
   */
  private async exportBamboo(
    instance: Instance,
    folderName: string,
    manifest: BambooManifest,
    options: ExportOptions
  ): Promise<ExportResult> {
    this.notify({ phase: "collecting", percent: 40, message: "Sammle Dateien für .bamboo..." });

    // Use Electron IPC to create the package
    const result = await window.electronAPI?.exportProfile?.({
      format: "bamboo",
      instanceName: instance.name,
      folderName,
      manifest,
      options,
      suggestedFileName: `${instance.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.bamboo`,
    });

    return {
      success: result?.success || false,
      filePath: result?.filePath,
      fileName: result?.fileName,
      fileSize: result?.fileSize,
      error: result?.error,
    };
  }

  /**
   * Export as .mrpack format (Modrinth modpack format)
   */
  private async exportMrpack(
    instance: Instance,
    folderName: string,
    manifest: BambooManifest,
    options: ExportOptions
  ): Promise<ExportResult> {
    this.notify({ phase: "collecting", percent: 40, message: "Sammle Dateien für .mrpack..." });

    // Build Modrinth index.json
    const mrpackIndex = {
      formatVersion: 1,
      game: "minecraft",
      versionId: `${instance.minecraftVersion}-${instance.modloader}-${instance.modloaderVersion || "latest"}`,
      name: instance.name,
      summary: instance.desc,
      files: [] as Array<{
        path: string;
        hashes: { sha512: string; sha1: string };
        env: { client: string; server: string };
        downloads: string[];
        fileSize: number;
      }>,
      dependencies: {
        minecraft: instance.minecraftVersion,
        ...(instance.modloader === "Fabric" ? { fabricLoader: instance.modloaderVersion || "0.16.10" } : {}),
        ...(instance.modloader === "Forge" ? { forge: instance.modloaderVersion || "" } : {}),
        ...(instance.modloader === "Neoforge" ? { neoforge: instance.modloaderVersion || "" } : {}),
      } as Record<string, string>,
    };

    const result = await window.electronAPI?.exportProfile?.({
      format: "mrpack",
      instanceName: instance.name,
      folderName,
      manifest,
      mrpackIndex,
      options,
      suggestedFileName: `${instance.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.mrpack`,
    });

    return {
      success: result?.success || false,
      filePath: result?.filePath,
      fileName: result?.fileName,
      fileSize: result?.fileSize,
      error: result?.error,
    };
  }

  /**
   * Export as simple .zip format
   */
  private async exportZip(
    instance: Instance,
    folderName: string,
    manifest: BambooManifest,
    options: ExportOptions
  ): Promise<ExportResult> {
    this.notify({ phase: "collecting", percent: 40, message: "Sammle Dateien für .zip..." });

    const result = await window.electronAPI?.exportProfile?.({
      format: "zip",
      instanceName: instance.name,
      folderName,
      manifest,
      options,
      suggestedFileName: `${instance.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.zip`,
    });

    return {
      success: result?.success || false,
      filePath: result?.filePath,
      fileName: result?.fileName,
      fileSize: result?.fileSize,
      error: result?.error,
    };
  }

  /**
   * Get default export options for an instance
   */
  getDefaultOptions(instance: Instance): ExportOptions {
    return {
      format: "bamboo",
      includeMods: (instance.content || []).some((c) => c.type === "mods"),
      includeResourcepacks: (instance.content || []).some((c) => c.type === "resourcepacks"),
      includeShaderpacks: (instance.content || []).some((c) => c.type === "shaderpacks"),
      includeDatapacks: (instance.content || []).some((c) => c.type === "datapacks"),
      includeWorlds: false,
      includeConfig: true,
      includeJvmSettings: true,
      includeLauncherSettings: true,
      includeScreenshots: false,
      includeIcon: true,
      includeBanner: false,
    };
  }
}

export const profileExportService = new ProfileExportService();
export default profileExportService;
