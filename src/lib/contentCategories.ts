/**
 * One owner for the question "which content category belongs where".
 *
 * A project type comes from a store (Modrinth / CurseForge), a category is what
 * an instance shows in its tabs, and the folder is where the game reads it from.
 * Every surface (browser, tabs, install, upload, update, delete) must go through
 * these helpers instead of repeating its own ternaries.
 */

import {
  curseForgeProjectTypeFor,
  type CurseForgeProjectType,
} from '../../electron/shared/curseforgeClassIds.ts'

export type ContentCategory = 'mods' | 'resourcepacks' | 'shaderpacks' | 'datapacks' | 'worlds'

/** Store-side project types (§ Modrinth `project_type`, CurseForge class ids). */
export type ProjectType = CurseForgeProjectType

/** `itemType` values the main process understands for downloads/uploads. */
export type InstallItemType = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'world'

const PROJECT_TYPE_TO_CATEGORY: Record<ProjectType, ContentCategory | null> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
  worlds: 'worlds',
  // A modpack is a whole instance, not instance content; a plugin belongs on a server.
  modpack: null,
  plugin: null,
}

const CATEGORY_TO_PROJECT_TYPE: Record<ContentCategory, ProjectType> = {
  mods: 'mod',
  resourcepacks: 'resourcepack',
  shaderpacks: 'shader',
  datapacks: 'datapack',
  worlds: 'worlds',
}

const CATEGORY_TO_INSTALL_ITEM: Record<ContentCategory, InstallItemType> = {
  mods: 'mod',
  resourcepacks: 'resourcepack',
  shaderpacks: 'shader',
  datapacks: 'datapack',
  worlds: 'world',
}

/** Categories an instance can actually own; everything else is not instance content. */
export const INSTANCE_CATEGORIES: ContentCategory[] = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks', 'worlds']

/** Project types offered when browsing FOR an instance (no modpacks: those become instances). */
export const INSTANCE_BROWSER_PROJECT_TYPES: ProjectType[] = ['mod', 'resourcepack', 'shader', 'datapack', 'worlds']

/** Project types offered in the global browser, where a modpack install creates an instance. */
export const GLOBAL_BROWSER_PROJECT_TYPES: ProjectType[] = [
  'mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'worlds', 'plugin',
]

/** CurseForge's class id for a project type, for the search request. */
export { curseForgeClassIdFor } from '../../electron/shared/curseforgeClassIds.ts'

/**
 * Real project type of a CurseForge search result. Without this every result
 * except worlds/datapacks was flattened to `mod`, so resource packs and
 * datapacks were listed - and installed - as mods.
 */
export function curseForgeProjectType(classId: number | string | undefined, fallback: ProjectType): ProjectType {
  return curseForgeProjectTypeFor(classId) ?? fallback
}

export function projectTypeToCategory(projectType: string | undefined): ContentCategory | null {
  if (!projectType) return null
  const key = projectType === 'shaderpacks' ? 'shader' : projectType
  return PROJECT_TYPE_TO_CATEGORY[key as ProjectType] ?? null
}

export function categoryToProjectType(category: ContentCategory): ProjectType {
  return CATEGORY_TO_PROJECT_TYPE[category]
}

/**
 * Category behind an instance tab id. The shader tab is called `shader` while
 * the category (and its folder) is `shaderpacks`; everything else maps 1:1.
 */
export function categoryForTab(tab: string | undefined): ContentCategory {
  switch (tab) {
    case 'resourcepacks':
      return 'resourcepacks'
    case 'shader':
    case 'shaderpacks':
      return 'shaderpacks'
    case 'datapacks':
      return 'datapacks'
    case 'worlds':
      return 'worlds'
    default:
      return 'mods'
  }
}

/** Tab id an instance shows a category in. */
export function tabForCategory(category: ContentCategory): string {
  return category === 'shaderpacks' ? 'shader' : category
}

export function installItemTypeFor(category: ContentCategory): InstallItemType {
  return CATEGORY_TO_INSTALL_ITEM[category]
}

/** Category of a project type, or null when it is not instance content (modpack, plugin). */
export function isInstanceCategory(projectType: string | undefined): boolean {
  return projectTypeToCategory(projectType) !== null
}

/**
 * Loader that a Modrinth/CurseForge version has to provide for this instance.
 * A loader-less (Vanilla) instance must not be matched against a loader name:
 * "vanilla" never appears in version metadata, which used to silently fall back
 * to an arbitrary file of any loader and Minecraft version.
 */
export function loaderFilterForInstance(modloader: string | undefined | null): string | undefined {
  const normalized = (modloader || '').toLowerCase()
  if (!normalized || normalized === 'vanilla') return undefined
  return normalized
}

/** Whether Minecraft itself can load mods in this instance (needs a real loader). */
export function instanceLoadsMods(modloader: string | undefined | null): boolean {
  return loaderFilterForInstance(modloader) !== undefined
}

/**
 * Whether shader packs can take effect: they need a mod loader plus Iris/OptiFine,
 * so a loader-less instance can never load them.
 */
export function instanceLoadsShaders(modloader: string | undefined | null): boolean {
  return loaderFilterForInstance(modloader) !== undefined
}
