/**
 * The launcher typeface is a local UI preference, not a game option. It is read
 * synchronously before the first render so a saved choice never flashes the
 * default face, and it is applied on <html> so every view inherits it.
 *
 * The pixel option uses the bundled Monocraft face (SIL OFL 1.1), a fan
 * interpretation of the Minecraft UI typeface; no Mojang font assets are
 * bundled. See public/fonts/README.md for the source and license.
 */
export type LauncherFont = 'normal' | 'minecraft'

export const LAUNCHER_FONT_STORAGE_KEY = 'bamboo-launcher-font'
export const LAUNCHER_FONT_ATTRIBUTE = 'data-launcher-font'
export const DEFAULT_LAUNCHER_FONT: LauncherFont = 'normal'

interface FontStorage {
  getItem(key: string): string | null
  setItem?(key: string, value: string): void
}

/** Unknown, empty or corrupt values must leave the launcher on the default. */
export function normalizeLauncherFont(value: unknown): LauncherFont {
  return value === 'minecraft' ? 'minecraft' : DEFAULT_LAUNCHER_FONT
}

export function readLauncherFont(storage?: FontStorage | null): LauncherFont {
  try {
    return normalizeLauncherFont(storage?.getItem(LAUNCHER_FONT_STORAGE_KEY))
  } catch {
    return DEFAULT_LAUNCHER_FONT
  }
}

export function saveLauncherFont(font: LauncherFont, storage?: FontStorage | null): void {
  try {
    storage?.setItem?.(LAUNCHER_FONT_STORAGE_KEY, normalizeLauncherFont(font))
  } catch {
    // A blocked storage keeps the choice for this session only.
  }
}

export function applyLauncherFont(font: LauncherFont): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(LAUNCHER_FONT_ATTRIBUTE, normalizeLauncherFont(font))
}
