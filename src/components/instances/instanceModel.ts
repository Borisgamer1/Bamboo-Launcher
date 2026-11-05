import { parseJvmArgs } from "../../lib/gameOptions";
import { instanceFolderKeyOf as instanceFolderKey } from "../../lib/instanceFolders";
import type { LauncherPreferences } from "../../lib/launcherPreferences";
import type { StoreFile, StoreVersion } from "../../lib/modVersions";
import type { InstanceLaunchSettingsPatch, LogAnalysisResult } from "../../electron";

/**
 * The instance record and the pure helpers the instance views share. Kept out of
 * the view module so another screen can use an instance without importing it.
 */

export interface ContentItem {
  id: string;
  name: string;
  fileName: string;
  version: string;
  type: "mods" | "resourcepacks" | "shaderpacks" | "worlds" | "datapacks";
  enabled: boolean;
  locked: boolean;
  updateAvailable?: boolean;
  iconUrl?: string;
  versionNumber?: string;
  projectId?: string;
  source?: "modrinth" | "curseforge";
}

/** The version the last check picked for an item, so an update does not fetch it again. */
export interface UpdateTarget {
  versionNumber?: string;
  version: StoreVersion;
  file: StoreFile;
}

/** The list is built from disk scans and identity lookups; one file must never render twice. */
export function dedupeContent(items: ContentItem[]): ContentItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${(item.fileName || item.id).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface Instance {
  folderName?: string;
  id: string;
  name: string;
  minecraftVersion: string;
  modloader: "Vanilla" | "Fabric" | "Quilt" | "Neoforge" | "Forge";
  modloaderVersion?: string;
  lastPlayed: string;
  size: string;
  modCount: number;
  thumbnail: string;
  desc: string;
  javaVersion?: string;
  installedMods: string[];
  content?: ContentItem[];
  ram?: number;
  playTimeMs?: number;
  sessionCount?: number;
  lastPlayedAt?: number;
  createdAt?: number;
  jvmArgs?: string;
  keybinds?: Record<string, string>;
  fullscreen?: boolean;
  windowMode?: "default" | "custom";
  windowWidth?: number;
  windowHeight?: number;
  isModpack?: boolean;
  ownContentManagement?: boolean;
  modpackProjectId?: string;
  modpackSource?: "modrinth" | "curseforge";
  modpackVersion?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function analysisFor(
  analyses: Record<string, LogAnalysisResult> | undefined,
  instance: Instance,
): LogAnalysisResult | null {
  if (!analyses) return null
  return analyses[instanceFolderKey(instance)] ?? analyses[instance.id] ?? null
}

export function buildLaunchPatch(
  instance: Instance,
  patch: Partial<Instance>,
  defaults: LauncherPreferences["instanceDefaults"]["window"],
): InstanceLaunchSettingsPatch | null {
  const next: InstanceLaunchSettingsPatch = {};
  let touched = false;

  if ("javaVersion" in patch) {
    const value = String(patch.javaVersion ?? "");
    if (!value || value === "Automatisch") {
      next.javaPath = "";
      next.javaMode = "auto";
    } else {
      const selectedPath = /\((.+)\)\s*$/.exec(value)?.[1] || value;
      next.javaPath = selectedPath;
      next.javaMode = "pinned";
    }
    touched = true;
  }

  if (typeof patch.ram === "number") {
    next.maxMemory = Math.max(0, Math.round(patch.ram));
    next.memoryMode = "explicit";
    touched = true;
  }

  if (typeof patch.jvmArgs === "string") {
    next.extraJvmArgs = parseJvmArgs(patch.jvmArgs);
    touched = true;
  }

  if ("fullscreen" in patch || "windowMode" in patch || "windowWidth" in patch || "windowHeight" in patch) {
    const merged = { ...instance, ...patch };
    const fullscreen = merged.fullscreen ?? defaults.fullscreen;
    const mode = merged.windowMode || defaults.mode;
    next.resolution =
      !fullscreen && mode === "custom"
        ? {
            width: Number(merged.windowWidth) || defaults.width,
            height: Number(merged.windowHeight) || defaults.height,
          }
        : null;
    touched = true;
  }

  return touched ? next : null;
}

