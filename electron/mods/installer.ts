import { dirname, join, resolve } from 'node:path'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { hashBuffer } from '../download/checksum'
import type { Logger } from '../logger'
import { commitInstalledFile, commitRemovedFile } from './content-state'
import { ModError } from './errors'
import { resolveFileInside, resolveInside } from './paths'
import { scanMissingDependencies } from './modpack'
import type { ModrinthClient } from './modrinth'
import type { OfflineModIndex } from './offline-index'
import type { MissingDependency, ModLoader, ProviderVersion } from './types'

export type ContentFolder = 'mods' | 'resourcepacks' | 'shaderpacks' | 'datapacks'

export interface InstallModOptions {
  instanceDir: string
  projectId: string
  minecraftVersion: string
  loader?: ModLoader
  client: ModrinthClient
  folder?: ContentFolder
  signal?: AbortSignal
  logger?: Logger
  withDependencies?: boolean
  index?: OfflineModIndex
  version?: ProviderVersion
}

export interface InstallModResult {
  installed: string[]
  skipped: string[]
  dependencies: string[]
  missingDependencies: MissingDependency[]
  downloadedBytes: number
}

export interface RemoveContentOptions {
  instanceDir: string
  path: string
  expectedSha1?: string
  index?: OfflineModIndex
  logger?: Logger
}

export interface RemoveContentResult {
  removed: string
  sha1: string
}

async function pruneEmptyParents(root: string, file: string): Promise<void> {
  let current = dirname(file)
  while (resolve(current) !== resolve(root) && resolve(current).startsWith(resolve(root))) {
    const entries = await readdir(current).catch(() => [])
    if (entries.length > 0) break
    await rm(current, { recursive: true, force: true }).catch(() => undefined)
    current = dirname(current)
  }
}

export const REMOVABLE_CONTENT_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks'] as const

export async function removeInstalledContent(
  options: RemoveContentOptions,
): Promise<RemoveContentResult> {
  const normalized = options.path.replace(/\\/g, '/')
  const folder = normalized.split('/')[0]
  if (!(REMOVABLE_CONTENT_FOLDERS as readonly string[]).includes(folder)) {
    throw new ModError('unsafe-path', `Not a removable content folder: ${folder}`, {
      path: normalized,
    })
  }
  const root = resolve(options.instanceDir)
  const target = resolveInside(root, normalized)
  const info = await stat(target).catch(() => undefined)
  if (!info?.isFile()) {
    throw new ModError('not-a-modpack', `Content file does not exist: ${normalized}`, {
      path: normalized,
    })
  }
  const sha1 = hashBuffer('sha1', await readFile(target))
  if (options.expectedSha1 && options.expectedSha1.toLowerCase() !== sha1) {
    throw new ModError('content-changed', `Content changed since it was listed: ${normalized}`, {
      path: normalized,
    })
  }
  await rm(target, { force: true })
  await pruneEmptyParents(root, target)
  await commitRemovedFile({
    instanceDir: root,
    path: normalized,
    index: options.index,
    logger: options.logger,
  })
  options.logger?.info('Content removed', { path: normalized, sha1 })
  return { removed: normalized, sha1 }
}

export async function installModrinthProject(options: InstallModOptions): Promise<InstallModResult> {
  const { client, instanceDir } = options
  const folder = options.folder ?? 'mods'
  if (!(REMOVABLE_CONTENT_FOLDERS as readonly string[]).includes(folder)) {
    throw new Error(`Unsupported content folder: ${folder}`)
  }
  const target = { minecraftVersion: options.minecraftVersion, ...(options.loader ? { loader: options.loader } : {}) }
  const installed: string[] = []
  const skipped: string[] = []
  const dependencies: string[] = []
  let downloadedBytes = 0
  const seen = new Set<string>()

  const installVersion = async (version: ProviderVersion, required: boolean): Promise<void> => {
    if (seen.has(version.projectId)) return
    seen.add(version.projectId)
    const file = version.files.find((entry) => entry.primary) ?? version.files[0]
    if (!file) return
    const destination = resolveFileInside(instanceDir, folder, file.filename)
    const result = await client.downloadVersion(version, destination, {
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await commitInstalledFile({
      instanceDir,
      path: `${folder}/${file.filename}`,
      record: {
        projectId: version.projectId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        name: version.name,
        source: 'modrinth',
      },
      index: options.index,
      logger: options.logger,
    })
    downloadedBytes += result.bytes
    if (result.skipped) skipped.push(file.filename)
    else if (required) dependencies.push(file.filename)
    else installed.push(file.filename)
    if (options.withDependencies === false) return
    for (const dependency of version.dependencies) {
      if (dependency.type !== 'required') continue
      const pinned = dependency.versionId
        ? await client.version(dependency.versionId).catch(() => undefined)
        : undefined
      if (pinned) {
        await installVersion(pinned, true)
      } else if (dependency.projectId) {
        await installVersion(await client.resolveVersion(dependency.projectId, target), true)
      }
    }
  }

  const root = options.version ?? (await client.resolveVersion(options.projectId, target))
  await installVersion(root, false)
  const scan = await scanMissingDependencies(join(instanceDir, 'mods'))
  options.logger?.info('Modrinth project installed', {
    projectId: options.projectId,
    installed,
    skipped,
    dependencies,
    downloadedBytes,
  })
  return {
    installed,
    skipped,
    dependencies,
    missingDependencies: scan.missing,
    downloadedBytes,
  }
}
