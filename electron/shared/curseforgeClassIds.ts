/**
 * The one owner of the CurseForge project-type <-> class-id mapping.
 *
 * The legacy CurseForge bridge uses the compiled copy, the renderer imports
 * this module through `src/lib/contentCategories.ts`, and the CurseForge
 * provider imports it directly. A new type or a changed id belongs here and
 * nowhere else.
 */
export const CURSEFORGE_CLASS_IDS = {
  mod: 6,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  worlds: 17,
  plugin: 5,
} as const

export type CurseForgeProjectType = keyof typeof CURSEFORGE_CLASS_IDS

/** The reverse direction, used to label search hits with their real type. */
export const CURSEFORGE_CLASS_ID_TO_TYPE: Partial<Record<number, CurseForgeProjectType>> =
  Object.fromEntries(
    Object.entries(CURSEFORGE_CLASS_IDS).map(([type, classId]) => [classId, type]),
  ) as Partial<Record<number, CurseForgeProjectType>>

/** CurseForge class id of a project type; `all` and unknown names have none. */
export function curseForgeClassIdFor(projectType: string): number | undefined {
  if (projectType === 'all') return undefined
  return CURSEFORGE_CLASS_IDS[projectType as CurseForgeProjectType]
}

/** Real project type of a CurseForge class id, or undefined when it is unknown. */
export function curseForgeProjectTypeFor(
  classId: number | string | undefined,
): CurseForgeProjectType | undefined {
  const numeric = typeof classId === 'string' ? Number(classId) : classId
  return typeof numeric === 'number' && Number.isFinite(numeric)
    ? CURSEFORGE_CLASS_ID_TO_TYPE[numeric]
    : undefined
}
