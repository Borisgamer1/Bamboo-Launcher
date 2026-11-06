import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../logger'

interface ProfileRegistryLike {
  patchSizes(sizes: Map<string, string>): void
}

export interface InstanceSizesOptions {
  logger: Logger
  readProfiles(rootPath: string): Array<Record<string, unknown>>
  profileFolderOf(profile: Record<string, unknown>): string
  profileDirOrNull(rootPath: string, folderName: string): string | null
  registry(rootPath: string): ProfileRegistryLike
}

/**
 * Instance sizes are measured off the save path: writing the instance list must
 * not walk every folder (a modpack has tens of thousands of files). The cache is
 * filled by a background pass that rewrites the list only when a size moved.
 */
export function createInstanceSizes(options: InstanceSizesOptions) {
  const cache = new Map<string, number>()
  const dirty = new Set<string>()
  let refresh: Promise<void> | null = null

  function markDirty(folderName: string): void {
    const key = String(folderName || '').toLowerCase()
    if (key) dirty.add(key)
  }

  function forget(folderName: string): void {
    const key = String(folderName || '').toLowerCase()
    cache.delete(key)
    dirty.delete(key)
  }

  function move(oldFolder: string, newFolder: string): void {
    const oldKey = oldFolder.toLowerCase()
    const newKey = newFolder.toLowerCase()
    const cached = cache.get(oldKey)
    if (cached !== undefined) cache.set(newKey, cached)
    cache.delete(oldKey)
    dirty.delete(oldKey)
  }

  function format(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    const size = bytes / Math.pow(1024, i)
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  }

  async function measure(dirPath: string): Promise<number> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => null)
    if (!entries) return 0
    let total = 0
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) total += await measure(fullPath)
      else total += (await fs.stat(fullPath).catch(() => ({ size: 0 }))).size
    }
    return total
  }

  async function refreshSizes(rootPath: string): Promise<void> {
    const profiles = options.readProfiles(rootPath)
    if (profiles.length === 0) return
    const measured = new Map<string, string>()
    for (const profile of profiles) {
      if (!profile || typeof profile !== 'object') continue
      const folderName = options.profileFolderOf(profile)
      const key = folderName.toLowerCase()
      if (!dirty.has(key)) continue
      const dirPath = options.profileDirOrNull(rootPath, folderName)
      if (!dirPath) continue
      const bytes = await measure(dirPath)
      cache.set(key, bytes)
      dirty.delete(key)
      measured.set(key, format(bytes) || '0 B')
    }
    // Patch, do not replace: a save during the measurement window must survive.
    options.registry(rootPath).patchSizes(measured)
  }

  function scheduleRefresh(rootPath: string): void {
    if (refresh) return
    refresh = new Promise((resolve) => setTimeout(resolve, 250))
      .then(() => refreshSizes(rootPath))
      .catch((error) => options.logger.debug('instance size refresh failed', { error: (error as Error).message }))
      .finally(() => {
        refresh = null
        if (dirty.size > 0) scheduleRefresh(rootPath)
      })
  }

  return { cache, dirty, markDirty, forget, move, format, scheduleRefresh }
}
