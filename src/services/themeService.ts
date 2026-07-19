// ============================================================
// Theme Service v2.0.0
// Data-driven theme system — ALL themes come from the backend.
// No hardcoded built-in themes.
// ============================================================

import { getCachedAssetText, getCachedAssetUrl } from "./assetCache";
import { API_BASE, getLauncherHeaders } from "./api";

// ===== Theme Definition Types =====

export interface ThemeDefinition {
  /** Unique theme ID (slug) */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  desc: string;
  /** Verbal accent label e.g. "Grün", "Rot", "Pink" */
  accentLabel: string;
  /** Primary accent color (hex) */
  accent: string;
  /** Background image path */
  bgImage?: string;
}

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

  /** Get all available themes (CDN + backend). Backend overrides CDN by ID. */
  getThemes(): ThemeDefinition[] {
    const cdn = this._cdnThemes || [];
    const backend = this._backendThemes || [];
    const merged: ThemeDefinition[] = [];
    const seen = new Set<string>();

    // CDN first, then backend — backend overrides CDN when IDs match
    for (const t of [...cdn, ...backend]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      } else {
        const idx = merged.findIndex((m) => m.id === t.id);
        if (idx >= 0) merged[idx] = t;
      }
    }
    return merged;
  }

  /** Get a specific theme by ID */
  getTheme(id: string): ThemeDefinition | undefined {
    return this.getThemes().find((t) => t.id === id);
  }

  /** Get the default theme (first available, or a minimal green fallback) */
  getDefaultTheme(): ThemeDefinition {
    const all = this.getThemes();
    if (all.length > 0) return all[0];
    return { id: "default", name: "Default", desc: "", accentLabel: "Grün", accent: "#22c55e" };
  }

  /** Force a fresh fetch from the backend */
  async refreshBackendThemes(): Promise<ThemeDefinition[]> {
    this._backendThemes = null;
    return this.loadBackendThemes();
  }

  async loadBackendThemes(): Promise<ThemeDefinition[]> {
    if (this._backendLoading) {
      return new Promise((resolve) => {
        const check = () => {
          resolve(this._backendThemes || []);
          this._listeners.delete(check);
        };
        this._listeners.add(check);
      });
    }

    this._backendLoading = true;
    const backendThemes: ThemeDefinition[] = [];

    try {
      const res = await fetch(`${API_BASE}/content/theme?limit=250`, {
        headers: { ...getLauncherHeaders(), 'Accept': 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[ThemeService] Backend themes fetch failed: ${res.status}`);
        this._backendThemes = backendThemes;
        this._backendLoading = false;
        this.notify();
        return backendThemes;
      }

      const data = await res.json();
      const items = data.data || data.items || data || [];
      const list = Array.isArray(items) ? items : (Array.isArray(items.data) ? items.data : []);

      for (const item of list) {
        const slug = item.slug || item.id;
        if (!slug) continue;

        const meta = item.metadata || {};

        // Description: prefer metadata desc, then item.description
        let desc = slug + ' theme';
        if (meta.desc && typeof meta.desc === 'string' && meta.desc.trim()) {
          desc = meta.desc;
        } else if (item.description && typeof item.description === 'string' && item.description.trim()) {
          desc = item.description;
        }

        // Accent label (verbal description like "Grün", "Rot")
        const accentLabel = (meta.accentLabel && typeof meta.accentLabel === 'string' && meta.accentLabel.trim())
          ? meta.accentLabel
          : meta.accent || '#22c55e';

        const theme: ThemeDefinition = {
          id: slug,
          name: item.name || slug,
          desc,
          accentLabel,
          accent: meta.accent || '#22c55e',
          bgImage: meta.bgImage || undefined,
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

  /**
   * Load themes from CDN asset cache (themes/{id}/theme.json).
   * This is a secondary source — backend themes take priority.
   */
  async loadCdnThemes(): Promise<ThemeDefinition[]> {
    if (this._cdnThemes !== null) return this._cdnThemes;
    if (this._loading) {
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

      if (themeIds.length === 0) {
        const knownDirs = ["bamboo", "cherry", "frozen", "nether", "end", "warden", "copper", "obsidian"];
        for (const dir of knownDirs) {
          const themeJson = await getCachedAssetText(`themes/${dir}/theme.json`);
          if (themeJson) themeIds.push(dir);
        }
      }

      for (const id of themeIds) {
        try {
          const themeJson = await getCachedAssetText(`themes/${id}/theme.json`);
          if (!themeJson) continue;

          const cdnTheme = JSON.parse(themeJson) as any;

          const theme: ThemeDefinition = {
            id: cdnTheme.id || id,
            name: cdnTheme.name || id,
            desc: cdnTheme.desc || "",
            accentLabel: cdnTheme.accentLabel || cdnTheme.accent || "#22c55e",
            accent: cdnTheme.accent || "#22c55e",
            bgImage: cdnTheme.bgImage,
          };
          cdnThemes.push(theme);
        } catch (err) {
          console.warn(`[ThemeService] Failed to load CDN theme ${id}:`, err);
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

  /** Resolve a theme's background image URL */
  async resolveBgUrl(theme: ThemeDefinition): Promise<string | undefined> {
    if (!theme.bgImage) return undefined;
    const cachedUrl = await getCachedAssetUrl(theme.bgImage);
    return cachedUrl || theme.bgImage;
  }
}

// ===== Singleton Export =====

export const themeService = new ThemeService();
export default themeService;
