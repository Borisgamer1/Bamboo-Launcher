import type { Instance } from "../InstancesView";
import { translations, formatMessage, type LanguageType } from "../../lib/translations";
import { toCurseForgeFailure } from "../../lib/curseforge";
import { LAUNCHER_VERSION } from "../../lib/version";
import type { ContentCategory } from "../../lib/contentCategories";
import {
  fromCurseForgeFile,
  fromModrinthVersion,
  pickVersion,
  versionFileFor,
  type StoreFile,
  type StoreVersion,
  type VersionMissReason,
} from "../../lib/modVersions";
import type { ModrinthHit, ModrinthVersion } from "./modDetailModel";

type ModsCopy = (typeof translations)[LanguageType];

export async function fetchModVersionsFromApi(mod: ModrinthHit): Promise<string[]> {
  try {
    const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`);
    if (!res.ok) return mod.versions || [];
    const data = (await res.json()) as ModrinthVersion[];
    const allVersions: string[] = data.flatMap((v) => v.game_versions || []);
    return [...new Set(allVersions)].filter((v: string) => /^\d+\.\d+(\.\d+)?$/.test(v));
  } catch {
    return mod.versions || [];
  }
}

export const isModCompatibleWithInstance = (mod: ModrinthHit, inst: Instance): boolean => {
  if (mod.project_type === "worlds") return true;
  if (!mod.versions || mod.versions.length === 0) return false;
  return mod.versions.some(v => v === inst.minecraftVersion);
};

type InstallPick =
  | { kind: "picked"; version: StoreVersion; file: StoreFile; explicit: boolean }
  | {
      kind: "missing";
      reason: VersionMissReason | "unknown-version";
      /** Best candidate that failed one rule; only used after an explicit confirmation. */
      fallback: { version: StoreVersion; file: StoreFile; reason: "loader" | "mc-version" } | null;
    };

/**
 * Version selection and the messages around a missing match. Kept out of the
 * view so the browser only wires state and rendering.
 */
export function createInstallPicker({ source, t }: { source: "modrinth" | "curseforge"; t: ModsCopy }) {
  /**
   * The store's version list for a project, in the shared shape. One owner for
   * both sources, so Modrinth and CurseForge items are judged identically.
   */
  const fetchStoreVersions = async (
    mod: ModrinthHit,
    modSource: "modrinth" | "curseforge" = source,
  ): Promise<StoreVersion[]> => {
    try {
      if (modSource === "curseforge") {
        const files = await window.electronAPI?.mods.curseforgeFiles?.(mod.project_id, undefined, undefined);
        if (toCurseForgeFailure(files)) return [];
        if (!Array.isArray(files)) return [];
        return files.map(fromCurseForgeFile);
      }
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, {
        headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((entry) => fromModrinthVersion(entry as Parameters<typeof fromModrinthVersion>[0]));
    } catch {
      return [];
    }
  };

  /**
   * Resolves the version to install through the shared selector. There is no
   * "first version with any file" fallback: either a version fits the instance's
   * Minecraft version and loader, or the caller gets the reason plus - at most -
   * one candidate that the UI has to label as incompatible.
   */
  const resolveInstallPick = async (
    mod: ModrinthHit,
    inst: Instance,
    category: ContentCategory,
    forcedVersionNumber?: string,
    modSource: "modrinth" | "curseforge" = source,
  ): Promise<InstallPick> => {
    const versions = await fetchStoreVersions(mod, modSource);
    if (forcedVersionNumber) {
      const chosen = versions.find((version) => version.versionNumber === forcedVersionNumber);
      if (chosen) {
        const file = versionFileFor(chosen, category);
        if (!file) return { kind: "missing", reason: "file", fallback: null };
        // A version the user picked by hand is installed as picked; swapping in
        // a different one silently is exactly what used to happen here.
        return { kind: "picked", version: chosen, file, explicit: true };
      }
      // The global version dialog picks a Minecraft version, not a store release.
      const byGameVersion = pickVersion(versions, {
        category,
        minecraftVersion: forcedVersionNumber,
        modloader: inst.modloader,
      });
      if (byGameVersion.version && byGameVersion.file) {
        return {
          kind: "picked",
          version: byGameVersion.version,
          file: byGameVersion.file,
          explicit: true,
        };
      }
      return { kind: "missing", reason: "unknown-version", fallback: null };
    }
    const pick = pickVersion(versions, {
      category,
      minecraftVersion: inst.minecraftVersion,
      modloader: inst.modloader,
    });
    if (pick.version && pick.file) {
      return { kind: "picked", version: pick.version, file: pick.file, explicit: false };
    }
    return {
      kind: "missing",
      reason: versions.length === 0 ? "no-versions" : pick.reason ?? "file",
      fallback: pick.fallback,
    };
  };

  /** Why a project cannot be installed here - said plainly, never silently. */
  const missReason = (reason: VersionMissReason | "unknown-version", inst: Instance): string => {
    switch (reason) {
      case "no-versions":
        return t.installMissNoVersions;
      case "mc-version":
        return formatMessage(t.installMissMcVersion, { mc: inst.minecraftVersion });
      case "loader":
        return formatMessage(t.installMissLoader, { loader: `${inst.modloader} ${inst.minecraftVersion}` });
      case "unknown-version":
        return t.installMissVersionGone;
      default:
        return t.installMissNoFile;
    }
  };

  const missMessage = (reason: VersionMissReason | "unknown-version", inst: Instance, mod: ModrinthHit): string => {
    return formatMessage(t.installMissTitle, { name: mod.title, reason: missReason(reason, inst) });
  };

  /** The explicit yes/no that a labelled, incompatible install requires. */
  const confirmIncompatibleFallback = (
    mod: ModrinthHit,
    inst: Instance,
    fallback: { version: StoreVersion; reason: "loader" | "mc-version" },
  ): boolean => {
    const reason =
      fallback.reason === "mc-version"
        ? formatMessage(t.installMissMcVersion, { mc: inst.minecraftVersion })
        : formatMessage(t.installMissLoader, { loader: `${inst.modloader} ${inst.minecraftVersion}` });
    return window.confirm(
      formatMessage(t.installIncompatibleFallback, {
        name: mod.title,
        version: fallback.version.versionNumber || "?",
        reason,
      }),
    );
  };

  const fetchDependencies = async (mod: ModrinthHit, inst: Instance): Promise<{ projectId: string; slug: string }[]> => {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version`, {
        headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as ModrinthVersion[];
      if (!Array.isArray(raw)) return [];
      // The dependency list is read from the very version the selector installs.
      const pick = pickVersion(raw.map(fromModrinthVersion), {
        category: "mods",
        minecraftVersion: inst.minecraftVersion,
        modloader: inst.modloader,
      });
      if (!pick.version) return [];
      const chosen = raw.find((version) => version.version_number === pick.version?.versionNumber);
      if (!chosen?.dependencies) return [];
      const deps: { projectId: string; slug: string }[] = [];
      for (const dep of chosen.dependencies) {
        if (dep.dependency_type !== 'required') continue;
        if (dep.project_id) {
          try {
            const slugRes = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}`);
            if (slugRes.ok) {
              const p = await slugRes.json();
              deps.push({ projectId: dep.project_id, slug: p.slug || p.id });
            }
          } catch { console.warn('[Mods] Failed to fetch dependency slug'); }
        }
      }
      return deps;
    } catch {
      return [];
    }
  };

  return {
    resolveInstallPick,
    missReason,
    missMessage,
    confirmIncompatibleFallback,
    fetchDependencies,
  };
}
