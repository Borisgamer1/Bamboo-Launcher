export interface McVersion {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
}

export interface VersionMap {
  minecraftVersions: string[];
  fabric: Record<string, string[]>;
  neoforge: Record<string, string[]>;
  forge: Record<string, string[]>;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const nfMajorToMc: Record<string, string> = {
  "21.5": "1.21.5", "21.4": "1.21.4", "21.3": "1.21.3",
  "21.1": "1.21.1", "21.0": "1.21",
  "20.6": "1.20.6", "20.4": "1.20.4", "20.1": "1.20.1",
};

export async function fetchVersionMap(): Promise<VersionMap> {
  const manifest = await fetchJson("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");

  const releases: string[] = manifest.versions
    .filter((v: any) => v.type === "release")
    .sort((a: any, b: any) => new Date(b.releaseTime).getTime() - new Date(a.releaseTime).getTime())
    .map((v: any) => v.id);

  // Fabric
  const fabric: Record<string, string[]> = {};
  try {
    const [fabricGameJson, fabricLoaderJson] = await Promise.all([
      fetchJson("https://meta.fabricmc.net/v2/versions/game"),
      fetchJson("https://meta.fabricmc.net/v2/versions/loader"),
    ]);
    const supported = new Set(fabricGameJson.map((v: any) => v.version));
    const allLoaderVers = fabricLoaderJson.map((l: any) => l.version);
    for (const mcVer of releases) {
      if (supported.has(mcVer)) {
        fabric[mcVer] = allLoaderVers;
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch Fabric versions'); }

  // NeoForge
  const neoforge: Record<string, string[]> = {};
  try {
    const nfXml = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
    const nfVersions: string[] = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(nfXml)) !== null) nfVersions.push(m[1]);
    for (const full of nfVersions) {
      const parts = full.split(".");
      const key = `${parts[0]}.${parts[1]}`;
      const mcVer = nfMajorToMc[key];
      if (mcVer && releases.includes(mcVer)) {
        if (!neoforge[mcVer]) neoforge[mcVer] = [];
        neoforge[mcVer].push(full);
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch NeoForge versions'); }

  // Forge (promotions_slim.json)
  const forge: Record<string, string[]> = {};
  try {
    const forgeJson = await fetchJson("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
    if (forgeJson.promos) {
      const promos = forgeJson.promos as Record<string, string>;
      const seen = new Set<string>();
      for (const key of Object.keys(promos)) {
        const dashIdx = key.indexOf("-");
        if (dashIdx === -1) continue;
        const mcVer = key.substring(0, dashIdx);
        const build = promos[key];
        if (mcVer && build && releases.includes(mcVer)) {
          if (!forge[mcVer]) forge[mcVer] = [];
          if (!seen.has(`${mcVer}-${build}`)) {
            seen.add(`${mcVer}-${build}`);
            forge[mcVer].push(build);
          }
        }
      }
    }
  } catch { console.warn('[VersionAPI] Failed to fetch Forge versions'); }

  return { minecraftVersions: releases, fabric, neoforge, forge };
}