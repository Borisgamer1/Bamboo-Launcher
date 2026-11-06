import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashBuffer } from '../download/checksum'
import { isVersionCompatible } from './compatibility'
import { MODRINTH_LOADER_NAMES } from './loaders'
import type { ModrinthClient } from './modrinth'
import { chunked } from './provider'
import type {
  InstanceModUpdate,
  InstanceModUpdateResult,
  ModLoader,
} from './types'

export type { InstanceModUpdate, InstanceModUpdateResult }

interface HashEntry {
  size: number
  mtimeMs: number
  sha1: string
}

/** Modrinth takes 64 hashes per request; above that the call is split. */
const BATCH_SIZE = 64
const HASHES = new Map<string, HashEntry>()

async function sha1Of(path: string, size: number, mtimeMs: number): Promise<string> {
  const cached = HASHES.get(path)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha1
  const sha1 = hashBuffer('sha1', await readFile(path))
  HASHES.set(path, { size, mtimeMs, sha1 })
  return sha1
}

/** Only for tests and for callers that moved files behind our back. */
export function clearModHashCache(): void {
  HASHES.clear()
}

/**
 * Every update the instance's mods folder has, in one request per 64 jars.
 *
 * Shortcut: Modrinth only resolves files it hosts, so CurseForge content stays
 * unresolved here and keeps the per-item lookup in the renderer.
 */
export async function checkInstanceModUpdates(options: {
  instanceDir: string
  minecraftVersion: string
  loader?: ModLoader
  client: ModrinthClient
}): Promise<InstanceModUpdateResult> {
  const mods = join(options.instanceDir, 'mods')
  const entries = await readdir(mods, { withFileTypes: true }).catch(() => [])
  const files: Array<{ name: string; sha1: string }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue
    const path = join(mods, entry.name)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) continue
    files.push({ name: entry.name, sha1: await sha1Of(path, info.size, info.mtimeMs) })
  }

  const updates: InstanceModUpdate[] = []
  const resolved: string[] = []
  const loaderName = options.loader ? MODRINTH_LOADER_NAMES[options.loader] : undefined
  for (const batch of chunked(files, BATCH_SIZE)) {
    const latest = await options.client.updateMany(
      batch.map((file) => file.sha1),
      {
        minecraftVersion: options.minecraftVersion,
        ...(options.loader ? { loader: options.loader } : {}),
      },
    )
    for (const file of batch) {
      const version = latest[file.sha1]
      if (!version) continue
      resolved.push(file.name)
      const primary = version.files.find((entry) => entry.primary) ?? version.files[0]
      if (!primary?.url) continue
      if (primary.hashes?.sha1?.toLowerCase() === file.sha1) continue
      // The provider filters too, but a build for another loader or game version
      // must never reach the instance: it is installed over the working jar.
      if (
        !isVersionCompatible(version, {
          minecraftVersion: options.minecraftVersion,
          ...(loaderName ? { acceptedLoaders: [loaderName] } : {}),
          acceptUndeclaredLoaders: true,
        })
      ) {
        continue
      }
      updates.push({
        file: file.name,
        projectId: version.projectId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        fileName: primary.filename,
        url: primary.url,
        loaders: version.loaders,
        gameVersions: version.gameVersions,
      })
    }
  }
  return { resolved, updates }
}
