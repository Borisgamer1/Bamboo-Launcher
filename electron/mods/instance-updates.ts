import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashBuffer } from '../download/checksum'
import type { ModrinthClient } from './modrinth'
import { chunked } from './provider'
import type { ModLoader } from './types'

export interface InstanceModUpdateResult {
  /** Jars Modrinth knows, whether or not a newer build exists. */
  resolved: string[]
  /** Jars with a newer build, already shaped for the update run. */
  updates: InstanceModUpdate[]
}

/** One jar Modrinth knows a newer build for, already shaped for the update run. */
export interface InstanceModUpdate {
  /** Installed file name, the key the renderer knows the row by. */
  file: string
  projectId: string
  versionId: string
  versionNumber: string
  /** File of the newer version that has to be downloaded. */
  fileName: string
  url: string
}

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
      updates.push({
        file: file.name,
        projectId: version.projectId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        fileName: primary.filename,
        url: primary.url,
      })
    }
  }
  return { resolved, updates }
}
