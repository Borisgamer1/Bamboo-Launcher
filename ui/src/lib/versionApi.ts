export interface McVersion {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface VersionMap {
  minecraftVersions: string[];
  fabric: Record<string, string[]>;
  quilt: Record<string, string[]>;
  neoforge: Record<string, string[]>;
  forge: Record<string, string[]>;
}

interface MojangManifestEntry {
  id: string;
  type: string;
  releaseTime: string;
}

interface MojangManifest {
  versions: MojangManifestEntry[];
}

interface FabricGameVersion {
  version: string;
}

interface FabricLoaderVersion {
  version: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

/**
 * Newest stable first, pre-releases after all stable builds. Quilt Meta lists
 * versions newest-first including betas, and every picker uses the first entry
 * as default, so without this a new Quilt instance would silently start on a
 * beta loader.
 */
function compareLoaderVersions(a: string, b: string): number {
  const aPrerelease = a.includes("-");
  const bPrerelease = b.includes("-");
  if (aPrerelease !== bPrerelease) return aPrerelease ? 1 : -1;
  const aParts = a.split(/[.-]/);
  const bParts = b.split(/[.-]/);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const left = Number(aParts[index] ?? 0);
    const right = Number(bParts[index] ?? 0);
    if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) {
      return right - left;
    }
  }
  return b.localeCompare(a);
}

async function fetchLoaderVersions(kind: "forge" | "neoforge"): Promise<string[]> {
  const api = window.electronAPI;
  const versions = kind === "forge"
    ? await api?.loaders.forgeVersions()
    : await api?.loaders.neoforgeVersions();
  if (versions && versions.length > 0) return versions;
  throw new Error(`No ${kind} version source available`);
}

function nfVersionToMc(parts: string[]): string | null {
  if (parts.length < 2) return null;
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (isNaN(major) || isNaN(minor)) return null;
  if (major < 20) return null;

  if (major >= 26) {
    return minor === 0 ? `${major}` : `${major}.${minor}`;
  }

  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

function parseForgeVersion(full: string): { mcVer: string; build: string } | null {
  const lastDash = full.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const mcVer = full.substring(0, lastDash);
  const build = full.substring(lastDash + 1);
  if (!mcVer || !build) return null;
  return { mcVer, build };
}

function extractForgeBuilds(
  allForgeVersions: string[],
  mcVer: string,
): string[] {
  const builds: string[] = [];
  for (const full of allForgeVersions) {
    const parsed = parseForgeVersion(full);
    if (parsed && parsed.mcVer === mcVer) {
      builds.push(parsed.build);
    }
  }
  // Alphabetisch sortiert stand "9" über "47"; die Zahlenfolge entscheidet.
  return [...new Set(builds)].sort(compareLoaderVersions);
}

export async function fetchVersionMap(): Promise<VersionMap> {
  const manifest = await fetchJson<MojangManifest>("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");

  const releases: string[] = manifest.versions
    .filter((v) => v.type === "release")
    .sort((a, b) => new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime())
    .map((v) => v.id);

  const releaseSet = new Set(releases);

  const fabric: Record<string, string[]> = {};
  try {
    const [fabricGameJson, fabricLoaderJson] = await Promise.all([
      fetchJson<FabricGameVersion[]>("https://meta.fabricmc.net/v2/versions/game"),
      fetchJson<FabricLoaderVersion[]>("https://meta.fabricmc.net/v2/versions/loader"),
    ]);
    const supported = new Set(fabricGameJson.map((v) => v.version));
    const allLoaderVers = fabricLoaderJson.map((l) => l.version).sort(compareLoaderVersions);
    for (const mcVer of releases) {
      if (supported.has(mcVer)) {
        fabric[mcVer] = allLoaderVers;
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch Fabric versions'); }

  const quilt: Record<string, string[]> = {};
  try {
    const [quiltGameJson, quiltLoaderJson] = await Promise.all([
      fetchJson<FabricGameVersion[]>("https://meta.quiltmc.org/v3/versions/game"),
      fetchJson<FabricLoaderVersion[]>("https://meta.quiltmc.org/v3/versions/loader"),
    ]);
    const supported = new Set(quiltGameJson.map((v) => v.version));
    const allLoaderVersions = quiltLoaderJson
      .map((l) => l.version)
      .sort(compareLoaderVersions);
    for (const mcVer of releases) {
      if (supported.has(mcVer)) {
        quilt[mcVer] = allLoaderVersions;
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch Quilt versions'); }

  const neoforge: Record<string, string[]> = {};
  try {
    const nfVersions = await fetchLoaderVersions("neoforge");
    for (const full of nfVersions) {
      const parts = full.split(".");
      const mcVer = nfVersionToMc(parts);
      if (mcVer && releaseSet.has(mcVer)) {
        if (!neoforge[mcVer]) neoforge[mcVer] = [];
        neoforge[mcVer].push(full);
      }
    }
    for (const versions of Object.values(neoforge)) versions.sort(compareLoaderVersions);
  } catch { console.warn('[VersionAPI] Failed to fetch NeoForge versions'); }

  const forge: Record<string, string[]> = {};
  try {
    const allForgeVersions = await fetchLoaderVersions("forge");
    for (const mcVer of releases) {
      const builds = extractForgeBuilds(allForgeVersions, mcVer);
      if (builds.length > 0) {
        forge[mcVer] = builds;
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch Forge versions'); }

  return { minecraftVersions: releases, fabric, quilt, neoforge, forge };
}
