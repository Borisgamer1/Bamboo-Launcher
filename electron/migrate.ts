import { join } from 'node:path'
import type { Logger } from './logger'
import { pathExists, readJsonFile, writeJsonFile } from './atomic'
import { CURRENT_MIGRATION_VERSION, MigrationMeta, MigrationMetaSchema, TOKEN_KEYS, parseWithDefaults, stripTokenFields } from './schemas'
import type { AccountStore } from './account-store'
import type { InstanceStore } from './instance-store'
import type { SettingsStore } from './settings-store'
import type { CorePaths } from './paths'

export interface MigrationResult {
  migrated: boolean
  accounts: number
  instances: number
  legacySettingsSanitized: boolean
  skippedReason?: string
  warnings: string[]
}

export interface MigrationDeps {
  paths: CorePaths
  settings: SettingsStore
  accounts: AccountStore
  instances: InstanceStore
  logger: Logger
}

function sanitizeAccount(entry: Record<string, unknown>): Record<string, unknown> {
  return stripTokenFields(entry).rest
}

export async function runMigrations(deps: MigrationDeps): Promise<MigrationResult> {
  const { paths, settings, accounts, instances, logger } = deps
  const warnings: string[] = []

  const metaRaw = await readJsonFile<Record<string, unknown>>(paths.metaFile, logger)
  const meta = parseWithDefaults(MigrationMetaSchema, metaRaw ?? {}, {
    schemaVersion: 1,
    migrationVersion: 0,
    migratedAt: 0,
    counts: { accounts: 0, instances: 0 },
  } as MigrationMeta)

  if (meta.migrationVersion >= CURRENT_MIGRATION_VERSION) {
    return { migrated: false, accounts: 0, instances: 0, legacySettingsSanitized: false, skippedReason: 'up-to-date', warnings }
  }

  const legacySettingsPath = join(paths.gameRoot, 'settings.json')
  const legacyProfilesPath = join(paths.gameRoot, 'profiles.json')
  const newSettingsExists = await pathExists(paths.settingsFile)

  let importedAccounts = 0
  let importedInstances = 0
  let sanitized = false

  if (await pathExists(legacySettingsPath)) {
    const legacy = await readJsonFile<Record<string, unknown>>(legacySettingsPath, logger)
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const { accounts: legacyAccounts, ...rest } = legacy as Record<string, unknown> & { accounts?: unknown }

      if (Array.isArray(legacyAccounts) && legacyAccounts.length > 0) {
        importedAccounts = await accounts.importLegacy(legacyAccounts)
      }

      const cleanRest: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(rest)) cleanRest[key] = value

      if (!newSettingsExists) {
        await settings.replace(cleanRest)
      } else {
        const current = await settings.get()
        const patch: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(cleanRest)) {
          if (!(key in current)) patch[key] = value
        }
        if (Object.keys(patch).length > 0) await settings.save(patch)
      }

      const legacyAccountEntries = Array.isArray(legacyAccounts)
        ? legacyAccounts.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        : []
      const hadPlaintextTokens =
        TOKEN_KEYS.some((key) => key in cleanRest) ||
        legacyAccountEntries.some((entry) => TOKEN_KEYS.some((key) => key in entry))

      if (hadPlaintextTokens) {
        const sanitizedLegacy = {
          ...cleanRest,
          ...(legacyAccountEntries.length > 0 ? { accounts: legacyAccountEntries.map(sanitizeAccount) } : {}),
        }
        try {
          await writeJsonFile(`${legacySettingsPath}.pre-migration.bak`, sanitizedLegacy, logger)
          await writeJsonFile(legacySettingsPath, sanitizedLegacy, logger)
          sanitized = true
        } catch (error) {
          warnings.push(`Could not sanitize legacy settings.json: ${(error as Error).message}`)
          logger.warn('Could not sanitize legacy settings.json', { error: (error as Error).message })
        }
      }
    } else if (legacy !== undefined) {
      warnings.push('legacy settings.json was not a JSON object and was ignored')
    }
  }

  if (await pathExists(legacyProfilesPath)) {
    const legacyProfiles = await readJsonFile<unknown>(legacyProfilesPath, logger)
    if (Array.isArray(legacyProfiles)) {
      importedInstances = await instances.importLegacyProfiles(legacyProfiles, paths.gameRoot)
    } else {
      warnings.push('legacy profiles.json was not an array and was ignored')
    }
  }

  const nextMeta: MigrationMeta = {
    schemaVersion: 1,
    migrationVersion: CURRENT_MIGRATION_VERSION,
    migratedAt: Date.now(),
    counts: { accounts: importedAccounts, instances: importedInstances },
  }
  await writeJsonFile(paths.metaFile, nextMeta, logger)

  logger.info('Migration finished', {
    accounts: importedAccounts,
    instances: importedInstances,
    legacySettingsSanitized: sanitized,
    warnings,
  })

  return {
    migrated: true,
    accounts: importedAccounts,
    instances: importedInstances,
    legacySettingsSanitized: sanitized,
    warnings,
  }
}
