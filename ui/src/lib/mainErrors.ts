import type { LanguageType } from './translations'

/**
 * User-visible validation errors from the main process. The handler keeps its
 * German text (logs and German UI use it unchanged); English UI maps the stable
 * code instead of showing a German sentence.
 */
const EN: Record<string, string> = {
  'invalid-folder': 'Invalid instance folder.',
  'already-running': 'This instance is already starting or running.',
  'max-launches': 'The maximum of 4 running Minecraft instances is reached.',
  'instance-running': 'The instance is still running. Quit the game, then delete it.',
  'unknown-loader': 'Unknown mod loader.',
  'missing-version': 'Minecraft version is missing.',
  'not-found': 'Instance not found.',
  'folder-exists': 'Folder name already exists.',
  'shortcut-win-only': 'Desktop shortcuts are currently only created on Windows.',
  'shortcut-icon-failed': 'The instance image could not be saved as the shortcut icon.',
  'shortcut-failed': 'The shortcut could not be created.',
  'import-unavailable': 'The import core is not available.',
  'import-read-failed': 'The profile archive could not be read.',
  'import-failed': 'The profile could not be imported.',
  'modpack-failed': 'The modpack could not be installed.',
  'loader-install-failed': 'The mod loader could not be installed.',
  'mod-install-unavailable': 'Mod installation is not available.',
  'upload-failed': 'The file could not be added.',
  'export-unavailable': 'Modpack export is not available.',
  'export-invalid': 'The export data is incomplete.',
}

export function mainErrorText(
  result: { error?: string; code?: string } | null | undefined,
  lang: LanguageType,
  fallback: string,
): string {
  if (lang === 'en' && result?.code && EN[result.code]) return EN[result.code]
  return result?.error || fallback
}
