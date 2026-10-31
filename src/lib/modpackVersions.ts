export type ModpackLoader = "fabric" | "quilt" | "forge" | "neoforge";

export interface ModrinthVersionFileLike {
  url?: string;
  filename?: string;
}

export interface ModrinthVersionLike {
  id?: string;
  version_number?: string;
  version_type?: string;
  date_published?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: ModrinthVersionFileLike[];
}

export interface ModpackVersionSummary {
  versionNumber: string;
  datePublished: string;
  url: string;
  fileName: string;
  mcVersion: string;
  gameVersions: string[];
  loader: ModpackLoader;
  versionType: "release" | "beta" | "alpha";
}

const SUPPORTED_LOADERS: ModpackLoader[] = ["fabric", "quilt", "neoforge", "forge"];

const MC_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

function isMcVersion(value: string): boolean {
  return MC_VERSION.test(value);
}

/** Highest Minecraft release first; keeps multi-version pack files unambiguous. */
function compareMcVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function normalizeModpackLoader(value: string | undefined): ModpackLoader | undefined {
  const loader = (value || "").toLowerCase();
  return SUPPORTED_LOADERS.find((candidate) => candidate === loader);
}

/** Display label used by the instance model, which stores capitalised names. */
export function modpackLoaderLabel(loader: ModpackLoader | string | undefined): "Fabric" | "Quilt" | "Forge" | "Neoforge" {
  switch ((loader || "").toLowerCase()) {
    case "quilt": return "Quilt";
    case "forge": return "Forge";
    case "neoforge": return "Neoforge";
    default: return "Fabric";
  }
}

export function isModpackVersion(version: ModrinthVersionLike): boolean {
  return Boolean(version.files?.some((file) =>
    file.filename?.toLowerCase().endsWith(".mrpack") || file.url?.toLowerCase().includes(".mrpack")
  ));
}

/**
 * One interpretation of a Modrinth version record. `dependencies` on this API
 * is a list of project dependencies, not the loader map from the .mrpack index,
 * so the loader version is deliberately not claimed here.
 */
export function toModpackVersion(
  version: ModrinthVersionLike,
  preferredGameVersion?: string,
): ModpackVersionSummary | undefined {
  const file = version.files?.find((entry) =>
    entry.filename?.toLowerCase().endsWith(".mrpack") || entry.url?.toLowerCase().includes(".mrpack")
  );
  if (!file?.url) return undefined;
  const gameVersions = (version.game_versions || []).filter(isMcVersion).sort(compareMcVersions);
  if (gameVersions.length === 0) return undefined;
  const mcVersion = preferredGameVersion && gameVersions.includes(preferredGameVersion)
    ? preferredGameVersion
    : gameVersions[0];
  const loader = (version.loaders || [])
    .map(normalizeModpackLoader)
    .find((candidate): candidate is ModpackLoader => Boolean(candidate));
  if (!loader) return undefined;
  const versionType = version.version_type === "beta" || version.version_type === "alpha"
    ? version.version_type
    : "release";
  return {
    versionNumber: version.version_number || version.id || "unbekannt",
    datePublished: version.date_published || "",
    url: file.url,
    fileName: file.filename || file.url.split("/").pop() || "modpack.mrpack",
    mcVersion,
    gameVersions,
    loader,
    versionType,
  };
}

/**
 * Newest stable release wins over a newer beta/alpha. When a Minecraft version
 * is selected in the browser, only pack versions for that release qualify;
 * silently installing a pack for a different Minecraft version is the bug this
 * prevents.
 */
export function pickModpackVersion(
  versions: ModrinthVersionLike[],
  options: { gameVersion?: string; loader?: ModpackLoader } = {},
): ModpackVersionSummary | undefined {
  let candidates = versions
    .map((version) => toModpackVersion(version, options.gameVersion))
    .filter((version): version is ModpackVersionSummary => Boolean(version));
  if (options.gameVersion) {
    candidates = candidates.filter((version) => version.gameVersions.includes(options.gameVersion!));
  }
  if (options.loader) {
    const matching = candidates.filter((version) => version.loader === options.loader);
    if (matching.length > 0) candidates = matching;
  }
  if (candidates.length === 0) return undefined;
  const stable = candidates.filter((version) => version.versionType === "release");
  const pool = stable.length > 0 ? stable : candidates;
  return pool.sort((a, b) =>
    new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime()
  )[0];
}
