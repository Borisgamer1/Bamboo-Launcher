import { join } from 'node:path'
import type { FetchLike } from '../../download/http'
import type { Logger } from '../../logger'
import type { ContentFolder } from '../installer'
import { MOD_INDEX_FILE, OfflineModIndex } from '../offline-index'

export interface LegacyBackgroundTaskProgress {
  id: string
  percent: number | null
  label: string
}

export interface LegacyBridgeOptions {
  rootPath?: string
  modrinthBaseUrl?: string
  curseforgeApiKey?: string
  curseforgeBaseUrl?: string
  fetchImpl?: FetchLike
  logger?: Logger
  /** Sends long-install progress to the renderer's footer task bar. */
  onBackgroundTask?: (progress: LegacyBackgroundTaskProgress) => void
}

export type LegacyPayload = Record<string, unknown>

export function asRecord(value: unknown): LegacyPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as LegacyPayload)
    : {}
}

export function isEnabled(value: unknown): boolean {
  return value !== false
}

export function legacyInstanceDir(rootPath: string, folderName: string): string {
  return join(rootPath, 'profiles', folderName)
}

export function profileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'imported'
  )
}

export function instanceIndex(instanceDir: string, logger?: Logger): OfflineModIndex {
  return new OfflineModIndex(join(instanceDir, MOD_INDEX_FILE), logger)
}

/**
 * The single destination decision for instance content. Download, upload and
 * removal all use it, so `itemType` values like `resourcepack`/`datapack` can
 * never end up as literal folder names and a removal always targets the folder
 * the install wrote to.
 */
export function downloadFolder(itemType: unknown): ContentFolder {
  if (itemType === 'resourcepack' || itemType === 'resourcepacks') return 'resourcepacks'
  if (itemType === 'shader' || itemType === 'shaderpacks') return 'shaderpacks'
  if (itemType === 'datapack' || itemType === 'datapacks') return 'datapacks'
  return 'mods'
}
