/**
 * One predicate for "may this store version be used on this instance".
 *
 * The install/update UI (`src/lib/modVersions.ts`), the dependency resolver
 * (`resolver.ts`) and the Modrinth client (`modrinth.ts`) all call it, so a
 * version accepted by one path can never be rejected by another.
 *
 * Plain data in, boolean out: no provider or renderer types, no dependencies.
 */

export interface VersionTraits {
  gameVersions: string[]
  loaders: string[]
}

export interface LoaderRule {
  /** Loader names that are accepted. Empty/undefined accepts every loader. */
  acceptedLoaders?: string[] | null
  /** Whether a version that declares no loaders at all is acceptable. */
  acceptUndeclaredLoaders?: boolean
}

export interface MinecraftRule {
  /** Required Minecraft version. Empty/undefined disables the check by default. */
  minecraftVersion?: string | null
  /** A world carries its own data and may declare no game version. */
  acceptUndeclared?: boolean
  /** An empty target fails instead of being ignored (resolver targets are exact). */
  requireVersion?: boolean
}

export type CompatibilityTarget = LoaderRule & MinecraftRule

export function matchesMinecraftVersion(
  gameVersions: string[],
  rule: MinecraftRule = {},
): boolean {
  const wanted = (rule.minecraftVersion || '').trim()
  if (!wanted) return rule.requireVersion !== true
  if (rule.acceptUndeclared && gameVersions.length === 0) return true
  return gameVersions.includes(wanted)
}

export function matchesLoader(loaders: string[], rule: LoaderRule = {}): boolean {
  const accepted = rule.acceptedLoaders
  if (!accepted || accepted.length === 0) return true
  if (loaders.length === 0) return rule.acceptUndeclaredLoaders === true
  const names = accepted.map((loader) => loader.toLowerCase())
  return loaders.some((loader) => names.includes(loader.toLowerCase()))
}

/** True when the version passes both the Minecraft and the loader rule. */
export function isVersionCompatible(version: VersionTraits, target: CompatibilityTarget): boolean {
  return (
    matchesMinecraftVersion(version.gameVersions, {
      minecraftVersion: target.minecraftVersion,
      acceptUndeclared: target.acceptUndeclared === true,
      requireVersion: target.requireVersion === true,
    }) && matchesLoader(version.loaders, target)
  )
}
