import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextFileAtomic } from '../atomic'
import {
  normalizeProjectKey,
  normalizeProjectUrl,
  projectConfig,
  type CosmeticSyncConfig,
} from './project'

/**
 * Owner of the Supabase cosmetics sync.
 *
 * The mod reads `<instance>/bamboo/sync.json` with the project URL and the
 * anon key. Both come from the build ([project.ts](./project.ts)), so every
 * player joins the same project and nobody edits JSON or types a key.
 *
 * A status is only "ready" when the file is readable and the mod jar is in the
 * instance; it says nothing about whether other players see the cosmetic.
 */

export type { CosmeticSyncConfig } from './project'

export interface CosmeticSyncStatus {
  configured: boolean
  instances: {
    total: number
    /** Mod jar present and sync.json readable with both values. */
    ready: number
    /** sync.json readable, but the mod jar is missing. */
    missingMod: number
  }
}

const INSTANCE_DIRECTORY = 'bamboo'
const INSTANCE_FILE = 'sync.json'
const MOD_PREFIX = 'bamboo-cosmetics-'

export function syncFile(instanceDirectory: string): string {
  return join(instanceDirectory, INSTANCE_DIRECTORY, INSTANCE_FILE)
}

/** The project pair this build ships; null when it ships none. */
export async function readConfig(): Promise<CosmeticSyncConfig | null> {
  return projectConfig()
}

/** The exact document the mod parses; `enabled` matches its template. */
export async function writeInstanceSync(
  instanceDirectory: string,
  config: CosmeticSyncConfig | null,
): Promise<boolean> {
  if (!config) return false
  const document = { enabled: true, supabaseUrl: config.supabaseUrl, anonKey: config.anonKey }
  await writeTextFileAtomic(syncFile(instanceDirectory), `${JSON.stringify(document, null, 2)}\n`)
  return true
}

async function instanceState(instanceDirectory: string): Promise<{ config: boolean; mod: boolean }> {
  let config: boolean
  try {
    const text = await readFile(syncFile(instanceDirectory), 'utf8')
    const stored = JSON.parse(text) as Partial<CosmeticSyncConfig> & { enabled?: unknown }
    // A hand-disabled file must not count as ready.
    config =
      stored.enabled !== false &&
      Boolean(normalizeProjectUrl(stored.supabaseUrl) && normalizeProjectKey(stored.anonKey))
  } catch {
    config = false
  }
  let mod: boolean
  try {
    mod = (await readdir(join(instanceDirectory, 'mods'))).some(
      (name) => name.startsWith(MOD_PREFIX) && name.toLowerCase().endsWith('.jar'),
    )
  } catch {
    mod = false
  }
  return { config, mod }
}

export async function syncStatus(instanceDirectories: string[]): Promise<CosmeticSyncStatus> {
  let ready = 0
  let missingMod = 0
  for (const directory of instanceDirectories) {
    const state = await instanceState(directory)
    if (state.config && state.mod) ready += 1
    else if (state.config) missingMod += 1
  }
  return {
    configured: projectConfig() !== null,
    instances: { total: instanceDirectories.length, ready, missingMod },
  }
}
