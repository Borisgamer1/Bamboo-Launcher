/**
 * The one Supabase project every player uses.
 *
 * <p>The pair ships inside the launcher build. There is no field, no per-player
 * file and no per-instance choice: the project belongs to the build, the anon
 * key is public by design, and RLS on `player_cosmetics` decides what a client
 * may write. A service-role key never appears here.
 *
 * <p>The env overrides exist for development and tests only: a probe can point
 * at a throwaway project without editing the shipped pair.
 */

export interface CosmeticSyncConfig {
  supabaseUrl: string
  anonKey: string
}

/** The Bamboo project (Project Settings -> API). Public pair, RLS enforces writes. */
export const SHARED_SUPABASE_URL = 'https://jabdyoykswnlqtcskvps.supabase.co'
export const SHARED_SUPABASE_KEY = 'sb_publishable_InRxrZkKL34yqQol4vWSMA_sxw48ycv'

const PROJECT_URL = /^https?:\/\/[^\s/]+(?::\d+)?\/?$/i

export function normalizeProjectUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return PROJECT_URL.test(raw) ? raw.replace(/\/+$/, '') : null
}

export function normalizeProjectKey(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return raw.length >= 20 && raw.length <= 4096 && !/\s/.test(raw) ? raw : null
}

/** The shipped pair, or null while the build has none or it is malformed. */
export function projectConfig(): CosmeticSyncConfig | null {
  const supabaseUrl = normalizeProjectUrl(process.env.BAMBOO_SUPABASE_URL ?? SHARED_SUPABASE_URL)
  const anonKey = normalizeProjectKey(process.env.BAMBOO_SUPABASE_KEY ?? SHARED_SUPABASE_KEY)
  return supabaseUrl && anonKey ? { supabaseUrl, anonKey } : null
}
