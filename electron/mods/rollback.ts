/**
 * Field rollback switches (roadmap phase 6) for the two engines this pipeline
 * added. Both are read from the environment so an install that misbehaves can be
 * made conservative without shipping new code:
 *
 *  - `BAMBOO_MODS_RESOLVER=legacy` — the resolver refuses to plan and reports
 *    `resolver-disabled`, so the caller uses the older walk instead of acting on
 *    a plan the field found faulty. Refusing loudly is the point: a silently
 *    smaller plan would install an incomplete mod set.
 *  - `BAMBOO_MODS_STORE=legacy` — the content store keeps storing and serving
 *    objects, but hands them to an instance by copy instead of sharing inodes.
 *
 * Only the switch's off-values change behaviour; unset, empty and unknown values
 * keep the new engines, so a typo can never quietly disable them.
 */
export const MODS_ROLLBACK_ENV = {
  resolver: 'BAMBOO_MODS_RESOLVER',
  store: 'BAMBOO_MODS_STORE',
} as const

export interface ModsRollback {
  resolver: boolean
  store: boolean
}

const OFF_VALUES = new Set(['legacy', 'off', '0', 'false', 'disabled'])

function isOff(value: string | undefined): boolean {
  return value !== undefined && OFF_VALUES.has(value.trim().toLowerCase())
}

export function modsRollback(
  env: Record<string, string | undefined> = process.env,
): ModsRollback {
  return {
    resolver: isOff(env[MODS_ROLLBACK_ENV.resolver]),
    store: isOff(env[MODS_ROLLBACK_ENV.store]),
  }
}
