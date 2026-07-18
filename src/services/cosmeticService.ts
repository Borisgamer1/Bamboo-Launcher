// ============================================================
// Cosmetic Service v1.0.0
// Loads cosmetic metadata from CDN cache and provides
// the file structure for 3D renderers.
// ============================================================

import { getCachedAssetText, getCachedAssetUrl } from "./assetCache";

// ===== Cosmetic File Structure Types =====

/**
 * A cosmetic item's structure on the CDN:
 * cosmetics/{slug}/
 *   ├── cosmetic.json     ← metadata (required)
 *   ├── preview.png       ← preview image (required)
 *   ├── model.glb         ← 3D model (optional, for 3D preview)
 *   ├── model.json        ← alternative: JSON model format
 *   └── textures/         ← texture files (optional)
 *       ├── diffuse.png
 *       ├── normal.png (optional)
 *       └── emissive.png (optional)
 */

export interface CosmeticTextureLayer {
  /** Type: diffuse, normal, emissive, specular, etc. */
  type: "diffuse" | "normal" | "emissive" | "specular" | "custom";
  /** Texture file path relative to cosmetic directory, e.g. "textures/diffuse.png" */
  path: string;
  /** Optional display name */
  label?: string;
}

export interface CosmeticModelInfo {
  /** Model format */
  format: "glb" | "gltf" | "json" | "bbmodel";
  /** Model file path relative to cosmetic directory */
  path: string;
}

export interface CosmeticFileStructure {
  /** Unique slug (also the directory name) */
  slug: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Cosmetic type: cape, aura, hat, ear, wings, rank, other */
  type: string;
  /** Rarity: common, rare, epic, legendary, mythic */
  rarity: string;
  /** Preview image path relative to cosmetic directory */
  previewImage: string;
  /** Accent color for UI rendering (hex) */
  accentColor: string;
  /** Whether this cosmetic is active/enabled */
  isActive: boolean;
  /** Sort order */
  sortOrder: number;
  /** 3D model info (optional) */
  model?: CosmeticModelInfo;
  /** Texture layers */
  textures: CosmeticTextureLayer[];
  /** Arbitrary metadata for future extensions */
  metadata: Record<string, unknown>;
}

// ===== Default / Empty =====

export const EMPTY_COSMETIC: CosmeticFileStructure = {
  slug: "",
  name: "",
  description: "",
  type: "other",
  rarity: "common",
  previewImage: "",
  accentColor: "",
  isActive: true,
  sortOrder: 0,
  textures: [],
  metadata: {},
};

// ===== Known Cosmetic Directories (from the content repo) =====

const KNOWN_COSMETIC_DIRS = [
  "Duck Crown",
  "Vogel Cape",
];

// ===== Cosmetic Service =====

class CosmeticService {
  private _cosmetics: CosmeticFileStructure[] | null = null;
  private _loading = false;
  private _listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  get isLoading(): boolean {
    return this._loading;
  }

  get cosmeticsLoaded(): boolean {
    return this._cosmetics !== null;
  }

  /** Get all loaded cosmetics */
  getCosmetics(): CosmeticFileStructure[] {
    return this._cosmetics || [];
  }

  /** Get a specific cosmetic by slug */
  getCosmetic(slug: string): CosmeticFileStructure | undefined {
    return (this._cosmetics || []).find((c) => c.slug === slug);
  }

  /** Get cosmetics filtered by type */
  getCosmeticsByType(type: string): CosmeticFileStructure[] {
    return (this._cosmetics || []).filter((c) => c.type === type);
  }

  /**
   * Load cosmetics from CDN asset cache.
   */
  async loadCosmetics(): Promise<CosmeticFileStructure[]> {
    if (this._cosmetics !== null) return this._cosmetics;
    if (this._loading) {
      return new Promise((resolve) => {
        const check = () => {
          if (this._cosmetics !== null) {
            resolve(this._cosmetics);
            this._listeners.delete(check);
          }
        };
        this._listeners.add(check);
      });
    }

    this._loading = true;
    this.notify();

    const cosmetics: CosmeticFileStructure[] = [];

    try {
      // Try to load cosmetics manifest
      const manifestJson = await getCachedAssetText("cosmetics/manifest.json");
      let cosmeticDirs: string[] = [];

      if (manifestJson) {
        try {
          const manifest = JSON.parse(manifestJson);
          cosmeticDirs = manifest.cosmetics || manifest.directories || [];
        } catch {
          console.warn("[CosmeticService] Failed to parse cosmetics/manifest.json");
        }
      }

      // Fall back to known directories
      if (cosmeticDirs.length === 0) {
        cosmeticDirs = KNOWN_COSMETIC_DIRS;
      }

      // Load each cosmetic
      for (const dir of cosmeticDirs) {
        try {
          const cosmeticJson = await getCachedAssetText(`cosmetics/${dir}/cosmetic.json`);
          if (!cosmeticJson) {
            // Try without directory nesting (existing repo structure)
            const flatJson = await getCachedAssetText(`cosmetic_models/${dir}/${dir}.json`);
            if (flatJson) {
              const parsed = JSON.parse(flatJson);
              const cosmetic = this.parseCosmeticDefinition(dir, parsed);
              cosmetics.push(cosmetic);
            }
            continue;
          }

          const parsed = JSON.parse(cosmeticJson);
          const cosmetic = this.parseCosmeticDefinition(dir, parsed);
          cosmetics.push(cosmetic);
        } catch (err) {
          console.warn(`[CosmeticService] Failed to load cosmetic ${dir}:`, err);
        }
      }

      // Also try the existing repo structure (cosmetic_models/)
      if (cosmetics.length === 0) {
        for (const dir of KNOWN_COSMETIC_DIRS) {
          try {
            const jsonPath = `cosmetic_models/${dir}/${dir}.json`;
            const modelJson = await getCachedAssetText(jsonPath);
            if (modelJson) {
              const parsed = JSON.parse(modelJson);
              const cosmetic = this.parseExistingModel(dir, parsed);
              cosmetics.push(cosmetic);
            }
          } catch {
            // Skip
          }
        }
      }

      if (cosmetics.length > 0) {
        console.log(`[CosmeticService] Loaded ${cosmetics.length} cosmetics`);
      } else {
        console.log("[CosmeticService] No CDN cosmetics found - will use API fallback");
      }
    } catch (err) {
      console.warn("[CosmeticService] Failed to load cosmetics:", err);
    }

    this._cosmetics = cosmetics;
    this._loading = false;
    this.notify();
    return cosmetics;
  }

  /**
   * Get the local cached URL for a cosmetic's preview image
   */
  async getPreviewUrl(slug: string): Promise<string | null> {
    // Try new structure first: cosmetics/{slug}/preview.png
    const newPath = `cosmetics/${slug}/preview.png`;
    let url = await getCachedAssetUrl(newPath);
    if (url) return url;

    // Try old structure: cosmetic_models/{slug}/textures/{slug}.png
    const oldPath = `cosmetic_models/${slug}/textures/${slug.toLowerCase().replace(/ /g, "_")}.png`;
    url = await getCachedAssetUrl(oldPath);
    if (url) return url;

    // Try the textures directory
    const texPath = `textures/${slug}/crown_high.png`;
    url = await getCachedAssetUrl(texPath);
    return url;
  }

  /**
   * Get the local cached URL for a cosmetic's 3D model
   */
  async getModelUrl(slug: string): Promise<string | null> {
    const newPath = `cosmetics/${slug}/model.glb`;
    const url = await getCachedAssetUrl(newPath);
    if (url) return url;

    // Try JSON model from existing repo
    const jsonPath = `cosmetic_models/${slug}/${slug}.json`;
    return getCachedAssetUrl(jsonPath);
  }

  /** Parse a cosmetic.json definition */
  private parseCosmeticDefinition(dir: string, json: Record<string, unknown>): CosmeticFileStructure {
    return {
      slug: (json.slug as string) || dir,
      name: (json.name as string) || dir,
      description: (json.description as string) || "",
      type: (json.type as string) || "other",
      rarity: (json.rarity as string) || "common",
      previewImage: (json.previewImage as string) || `cosmetics/${dir}/preview.png`,
      accentColor: (json.accentColor as string) || "",
      isActive: json.isActive !== undefined ? (json.isActive as boolean) : true,
      sortOrder: (json.sortOrder as number) || 0,
      model: json.model
        ? {
            format: ((json.model as Record<string, unknown>).format as CosmeticModelInfo["format"]) || "glb",
            path: ((json.model as Record<string, unknown>).path as string) || `cosmetics/${dir}/model.glb`,
          }
        : undefined,
      textures: Array.isArray(json.textures)
        ? (json.textures as CosmeticTextureLayer[])
        : [],
      metadata: (json.metadata as Record<string, unknown>) || {},
    };
  }

  /** Parse from existing repo structure (cosmetic_models/{name}/{name}.json) */
  private parseExistingModel(dir: string, _json: Record<string, unknown>): CosmeticFileStructure {
    // Derive type and name from directory name
    const lower = dir.toLowerCase();
    let type = "other";
    if (lower.includes("cape")) type = "cape";
    else if (lower.includes("crown") || lower.includes("hat")) type = "hat";
    else if (lower.includes("wing")) type = "wings";
    else if (lower.includes("ear")) type = "ear";

    return {
      slug: dir,
      name: dir,
      description: "",
      type,
      rarity: "common",
      previewImage: `textures/${dir}/crown_high.png`,
      accentColor: "",
      isActive: true,
      sortOrder: 0,
      model: {
        format: "json",
        path: `cosmetic_models/${dir}/${dir}.json`,
      },
      textures: [],
      metadata: {},
    };
  }
}

// ===== Singleton Export =====

export const cosmeticService = new CosmeticService();
export default cosmeticService;
