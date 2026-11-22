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
  /** Modrinth slug, when the store knows it; projectId is the stable key. */
  slug?: string;
  /** Mod id from the jar metadata, used to spot two versions of one mod offline. */
  modId?: string;
  source?: "modrinth" | "curseforge";
}

/** The version the last check picked for an item, so an update does not fetch it again. */
export interface UpdateTarget {
  versionNumber?: string;
  version: StoreVersion;
  file: StoreFile;
}

/**
 * The list is built from disk scans and identity lookups; one file must never
 * render twice. Updates can leave two file names for the same project (or two
 * jars with the same internal mod id), so the stable project/mod id wins over
 * the file name. Duplicates are merged instead of hidden separately: deleting
 * the visible row must remove the whole project, not resurrect the other file.
 */
export function dedupeContent(items: ContentItem[]): ContentItem[] {
  const seen = new Map<string, number>();
  const result: ContentItem[] = [];
  const rank = (item: ContentItem) =>
    (item.projectId ? 8 : 0) +
    (item.enabled ? 4 : 0) +
    (item.versionNumber ? 2 : 0) +
    (item.modId ? 1 : 0);

  for (const item of items) {
    const keys: string[] = [];
    if (item.projectId) keys.push(`${item.type}:project:${item.projectId.toLowerCase()}`);
    if (item.modId) keys.push(`${item.type}:mod:${item.modId.toLowerCase()}`);
    keys.push(`${item.type}:file:${(item.fileName || item.id).toLowerCase()}`);
    // `x.jar` und `x.jar.disabled` sind derselbe Mod. Ohne diesen Schlüssel
    // blieben nach einem Deaktivieren zwei Zeilen für eine Datei stehen.
    if (item.fileName) {
      keys.push(`${item.type}:base:${item.fileName.replace(/\.disabled$/i, '').toLowerCase()}`);
    }

    const existingIndex = keys
      .map((key) => seen.get(key))
      .find((index): index is number => index !== undefined);

    if (existingIndex === undefined) {
      const index = result.length;
      result.push(item);
      keys.forEach((key) => seen.set(key, index));
      continue;
    }

    const existing = result[existingIndex];
    const preferred = rank(item) > rank(existing) ? item : existing;
    const other = preferred === item ? existing : item;
    result[existingIndex] = {
      ...other,
      ...preferred,
      projectId: preferred.projectId || other.projectId,
      slug: preferred.slug || other.slug,
      modId: preferred.modId || other.modId,
      source: preferred.source || other.source,
      versionNumber: preferred.versionNumber || other.versionNumber,
    };
    keys.forEach((key) => seen.set(key, existingIndex));
  }

  return result;
}

/** Does this instance already contain the store project, by id or slug? */
export function instanceHasProject(
  instance: Instance,
  projectId?: string,
  slug?: string,
): boolean {
  const wanted = new Set(
    [projectId, slug]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return false;
  const matches = (value?: string) => Boolean(value && wanted.has(value.toLowerCase()));

  return (instance.installedMods || []).some(matches) ||
    (instance.content || []).some(
      (item) =>
        matches(item.projectId) ||
        matches(item.slug) ||
        matches(item.id),
    );
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
    // The dropdown writes an executable path already. Interpreting a stored
    // selection - including the legacy display-text label - belongs to the main
    // process alone, so the renderer forwards the value untouched.
    const value = String(patch.javaVersion ?? "").trim();
    if (!value || value === "Automatisch") {
      next.javaPath = "";
      next.javaMode = "auto";
    } else {
      next.javaPath = value;
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

