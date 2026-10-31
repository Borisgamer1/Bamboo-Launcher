import type { MissingDependency, ParsedMod } from './types'

const PLATFORM_IDS = [
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fabricloader',
  'fabric-loader',
  'quilt_loader',
  'quiltloader',
  'javafml',
  'lowcodefml',
  'fml',
]

export function providedIds(mods: ParsedMod[]): Set<string> {
  const provided = new Set<string>(PLATFORM_IDS)
  for (const mod of mods) {
    if (mod.id) provided.add(mod.id.toLowerCase())
    for (const id of mod.provides) provided.add(id.toLowerCase())
  }
  return provided
}

export function findMissingRequired(
  mods: ParsedMod[],
  options: { ignore?: string[] } = {},
): MissingDependency[] {
  const provided = providedIds(mods)
  for (const id of options.ignore ?? []) provided.add(id.toLowerCase())
  const missing = new Map<string, MissingDependency>()
  for (const mod of mods) {
    for (const dependency of mod.dependencies) {
      if (!dependency.mandatory || dependency.reason !== 'depends') continue
      const key = dependency.id.toLowerCase()
      if (provided.has(key)) continue
      const existing = missing.get(key)
      if (existing) {
        if (!existing.requiredBy.includes(mod.id)) existing.requiredBy.push(mod.id)
        if (!existing.versionRange && dependency.versionRange) {
          existing.versionRange = dependency.versionRange
        }
      } else {
        missing.set(key, {
          id: dependency.id,
          requiredBy: [mod.id],
          ...(dependency.versionRange ? { versionRange: dependency.versionRange } : {}),
        })
      }
    }
  }
  return [...missing.values()]
}
