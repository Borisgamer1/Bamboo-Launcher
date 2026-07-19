// ============================================================
// Theme Service v1.0.0
// Data-driven theme system that loads themes from the
// CDN asset cache, with built-in fallback themes.
// ============================================================

import { getCachedAssetText, getCachedAssetUrl } from "./assetCache";
import type { ThemeType } from "../components/ParticleBackground";
import { API_BASE, getLauncherHeaders } from "./api";

// ===== Theme Definition Types =====

export interface ThemeDefinition {
  /** Unique theme ID */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  desc: string;
  /** Category for grouping in settings */
  category: "new" | "classic" | "community" | "cdn";
  /** Particle background type */
  themeType: ThemeType;
  /** Background image path (relative to CDN) */
  bgImage?: string;
  /** Primary accent color (hex) */
  accent: string;
  /** Light variant of accent */
  accentLight: string;
  /** Dark variant of accent */
  accentDark: string;
  /** Glow/shadow color (rgba) */
  glowColor: string;
  /** Optional custom font family */
  fontFamily?: string;
  /** Whether this theme comes from CDN */
  fromCdn: boolean;
}

// ===== Built-in Fallback Themes =====

const BUILTIN_THEMES: ThemeDefinition[] = [
  {
    id: "bamboo",
    name: "Bamboo",
    desc: "Bambus & Grün",
    category: "new",
    themeType: "bamboo",
    bgImage: "/images/bamboo_forest.png",
    accent: "#22c55e",
    accentLight: "#34d399",
    accentDark: "#16a34a",
    glowColor: "rgba(52,211,153,0.5)",
    fromCdn: false,
  },
  {
    id: "cherry",
    name: "Cherry",
    desc: "Kirschblüte & Pink",
    category: "new",
    themeType: "cherry",
    bgImage: "/images/cherry_blossom.png",
    accent: "#f43f5e",
    accentLight: "#fb7185",
    accentDark: "#e11d48",
    glowColor: "rgba(244,63,94,0.5)",
    fromCdn: false,
  },
  {
    id: "frozen",
    name: "Icy Blue",
    desc: "Eis & Blau",
    category: "new",
    themeType: "frozen",
    bgImage: "/images/frozen_ice.png",
    accent: "#0ea5e9",
    accentLight: "#38bdf8",
    accentDark: "#0284c7",
    glowColor: "rgba(14,165,233,0.5)",
    fromCdn: false,
  },
  {
    id: "nether",
    name: "Nether Red",
    desc: "Nether & Rot",
    category: "new",
    themeType: "nether",
    bgImage: "/images/nether_amber.png",
    accent: "#ef4444",
    accentLight: "#f87171",
    accentDark: "#dc2626",
    glowColor: "rgba(239,68,68,0.5)",
    fromCdn: false,
  },
  {
    id: "end",
    name: "End Purple",
    desc: "Purpur & Mystisch",
    category: "classic",
    themeType: "end",
    bgImage: "/images/nether_amber.png",
    accent: "#a855f7",
    accentLight: "#c084fc",
    accentDark: "#7c3aed",
    glowColor: "rgba(168,85,247,0.5)",
    fromCdn: false,
  },
  {
    id: "warden",
    name: "Warden Cyan",
    desc: "Türkis & Modern",
    category: "classic",
    themeType: "warden",
    bgImage: "/images/frozen_ice.png",
    accent: "#14b8a6",
    accentLight: "#2dd4bf",
    accentDark: "#0d9488",
    glowColor: "rgba(20,184,166,0.5)",
    fromCdn: false,
  },
  {
    id: "copper",
    name: "Copper Orange",
    desc: "Kupfer & Orange",
    category: "classic",
    themeType: "copper",
    bgImage: "/images/nether_amber.png",
    accent: "#d97706",
    accentLight: "#f59e0b",
    accentDark: "#b45309",
    glowColor: "rgba(217,119,6,0.5)",
    fromCdn: false,
  },
  {
    id: "obsidian",
    name: "Obsidian Black",
    desc: "Obsidian & Violett",
    category: "classic",
    themeType: "obsidian",
    bgImage: "/images/bamboo_forest.png",
    accent: "#a78bfa",
    accentLight: "#c4b5fd",
    accentDark: "#8b5cf6",
    glowColor: "rgba(167,139,250,0.5)",
    fromCdn: false,
  },
];

// ===== Theme Service =====

class ThemeService {
  private _cdnThemes: ThemeDefinition[] | null = null;
  private _backendThemes: ThemeDefinition[] | null = null;
  private _loading = false;
  private _backendLoading = false;
  private _listeners: Set<() => void> = new Set();

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  /** Get all available themes (built-in + CDN + backend) */
  getThemes(): ThemeDefinition[] {
    const cdn = this._cdnThemes || [];
    const backend = this._backendThemes || [];
    // Merge: built-in first, then CDN overrides, then backend overrides
    const merged = [...BUILTIN_THEMES];
    for (const cdnTheme of cdn) {
      const existingIdx = merged.findIndex((t) => t.id === cdnTheme.id);
      if (existingIdx >= 0) {
        merged[existingIdx] = cdnTheme;
      } else {
        merged.push(cdnTheme);
      }
    }
    const builtinIds = new Set(BUILTIN_THEMES.map(t => t.id));
    for (const backendTheme of backend) {
      const existingIdx = merged.findIndex((t) => t.id === backendTheme.id);
      if (existingIdx >= 0) {
        // Only override built-in themes if backend item has real metadata
        // (accent differs from the bamboo default, or name differs from id)
        const isBuiltin = builtinIds.has(backendTheme.id);
        if (isBuiltin && backendTheme.accent === '#22c55e' && backendTheme.name === backendTheme.id) {
          continue; // skip — no real metadata, keep the built-in version
        }
        merged[existingIdx] = backendTheme;
      } else {
        merged.push(backendTheme);
      }
    }
    return merged;
  }

  /** Get a specific theme by ID */
  getTheme(id: string): ThemeDefinition | undefined {
    return this.getThemes().find((t) => t.id === id);
  }

  /** Get the default theme (first built-in) */
  getDefaultTheme(): ThemeDefinition {
    return BUILTIN_THEMES[0];
  }

  /** Check if CDN themes are loaded */
  get cdnThemesLoaded(): boolean {
    return this._cdnThemes !== null;
  }

  get isLoading(): boolean {
    return this._loading;
  }

  /**
   * Load themes from CDN asset cache.
   * Themes are stored as `themes/{id}/theme.json` in the CDN.
   */
  async loadCdnThemes(): Promise<ThemeDefinition[]> {
    if (this._cdnThemes !== null) return this._cdnThemes;
    if (this._loading) {
      // Wait for current load
      return new Promise((resolve) => {
        const check = () => {
          if (this._cdnThemes !== null) {
            resolve(this._cdnThemes);
            this._listeners.delete(check);
          }
        };
        this._listeners.add(check);
      });
    }

    this._loading = true;
    this.notify();

    const cdnThemes: ThemeDefinition[] = [];

    try {
      // Try to load theme index from cache
      const indexJson = await getCachedAssetText("themes/index.json");
      let themeIds: string[] = [];

      if (indexJson) {
        try {
          const index = JSON.parse(indexJson);
          themeIds = index.themes || [];
        } catch {
          console.warn("[ThemeService] Failed to parse themes/index.json");
        }
      }

      // If no index, try common theme directories
      if (themeIds.length === 0) {
        // Try each known theme directory
        const knownDirs = ["bamboo", "cherry", "frozen", "nether", "end", "warden", "copper", "obsidian"];
        for (const dir of knownDirs) {
          const themeJson = await getCachedAssetText(`themes/${dir}/theme.json`);
          if (themeJson) {
            themeIds.push(dir);
          }
        }
      }

      // Load each theme definition
      for (const id of themeIds) {
        try {
          const themeJson = await getCachedAssetText(`themes/${id}/theme.json`);
          if (!themeJson) continue;

          const cdnTheme = JSON.parse(themeJson) as Partial<ThemeDefinition>;

          // Build full theme definition
          const theme: ThemeDefinition = {
            id: cdnTheme.id || id,
            name: cdnTheme.name || id,
            desc: cdnTheme.desc || "",
            category: "cdn",
            themeType: (cdnTheme.themeType as ThemeType) || "bamboo",
            bgImage: cdnTheme.bgImage,
            accent: cdnTheme.accent || "#22c55e",
            accentLight: cdnTheme.accentLight || "#34d399",
            accentDark: cdnTheme.accentDark || "#16a34a",
            glowColor: cdnTheme.glowColor || "rgba(52,211,153,0.5)",
            fontFamily: cdnTheme.fontFamily,
            fromCdn: true,
          };

          cdnThemes.push(theme);
        } catch (err) {
          console.warn(`[ThemeService] Failed to load theme ${id}:`, err);
        }
      }

      if (cdnThemes.length > 0) {
        console.log(`[ThemeService] Loaded ${cdnThemes.length} CDN themes`);
      }
    } catch (err) {
      console.warn("[ThemeService] Failed to load CDN themes:", err);
    }

    this._cdnThemes = cdnThemes;
    this._loading = false;
    this.notify();
    return cdnThemes;
  }

  /**
   * Load themes from the backend API (unified content manager).
   * Fetches published themes from /api/content/theme and parses metadata.
   */
  async loadBackendThemes(): Promise<ThemeDefinition[]> {
    if (this._backendThemes !== null) return this._backendThemes;
    if (this._backendLoading) {
      return new Promise((resolve) => {
        const check = () => {
          if (this._backendThemes !== null) {
            resolve(this._backendThemes);
            this._listeners.delete(check);
          }
        };
        this._listeners.add(check);
      });
    }

    this._backendLoading = true;

    const backendThemes: ThemeDefinition[] = [];

    try {
      const res = await fetch(`${API_BASE}/content/theme?status=published&limit=100`, {
        headers: { ...getLauncherHeaders(), 'Accept': 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[ThemeService] Backend themes fetch failed: ${res.status}`);
        this._backendLoading = false;
        return [];
      }

      const data = await res.json();
      const items = data.data || data.items || data || [];
      const list = Array.isArray(items) ? items : (Array.isArray(items.data) ? items.data : []);

      for (const item of list) {
        const slug = item.slug || item.id;
        if (!slug) continue;

        const meta = item.metadata || {};
        const theme: ThemeDefinition = {
          id: slug,
          name: item.name || slug,
          desc: meta.desc || item.description || slug + ' theme',
          category: 'cdn',
          themeType: (meta.themeType as ThemeType) || 'bamboo',
          bgImage: meta.bgImage || undefined,
          accent: meta.accent || '#22c55e',
          accentLight: meta.accentLight || '#34d399',
          accentDark: meta.accentDark || '#16a34a',
          glowColor: meta.glowColor || 'rgba(52,211,153,0.5)',
          fontFamily: meta.fontFamily,
          fromCdn: false, // comes from backend, not CDN cache
        };
        backendThemes.push(theme);
      }

      if (backendThemes.length > 0) {
        console.log(`[ThemeService] Loaded ${backendThemes.length} themes from backend`);
      }
    } catch (err) {
      console.warn('[ThemeService] Failed to load backend themes:', err);
    }

    this._backendThemes = backendThemes;
    this._backendLoading = false;
    this.notify();
    return backendThemes;
  }

  /** Check if backend themes have been loaded */
  get backendThemesLoaded(): boolean {
    return this._backendThemes !== null;
  }

  /**
   * Resolve a theme's background image URL.
   * For CDN themes, tries the local cache first, falls back to built-in path.
   */
  async resolveBgUrl(theme: ThemeDefinition): Promise<string | undefined> {
    if (!theme.bgImage) return undefined;

    // For CDN themes, try to get from cache
    if (theme.fromCdn) {
      const cachedUrl = await getCachedAssetUrl(theme.bgImage);
      if (cachedUrl) return cachedUrl;
    }

    // Fall back to the path as-is (could be a local /images/ path or CDN URL)
    return theme.bgImage;
  }
}

// ===== Singleton Export =====

export const themeService = new ThemeService();
export { BUILTIN_THEMES };
export default themeService;
