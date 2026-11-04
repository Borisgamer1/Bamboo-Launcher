import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { hashBuffer } from '../download/checksum'
import { downloadBuffer, type FetchLike, type RetryOptions } from '../download/http'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { withoutTelemetry, type TelemetryService } from '../telemetry'
import { findMissingRequired } from './dependencies'
import { CurseForgeClient, requiredCurseForgeDependencies, type CurseForgeFile } from './curseforge'
import { ModError } from './errors'
import type { ModrinthClient } from './modrinth'
import { readModMetadataList } from './metadata'
import { resolveInside } from './paths'
import {
  curseForgeProjectTypeFor,
  type CurseForgeProjectType,
} from '../shared/curseforgeClassIds'
import { readModpackLock, writeModpackLock, type ModpackUpstream } from './lock'
import { withZip } from './zip'
import type { OfflineModIndex } from './offline-index'
import type {
  BlockedPackFile,
  MissingDependency,
  ModLoader,
  ModpackFile,
  ModpackInstallResult,
  ModpackLock,
  ModpackLockFile,
  ModpackManifest,
  ParsedMod,
} from './types'

export interface ModpackInstallOptions {
  instanceDir: string
  archivePath: string
  curseforge?: CurseForgeClient
  /** Only used when a CurseForge file forbids third-party distribution. */
  modrinth?: ModrinthClient
  minecraftVersion?: string
  loader?: ModLoader
  fetchImpl?: FetchLike
  retry?: RetryOptions
  signal?: AbortSignal
  logger?: Logger
  upstream?: ModpackUpstream
  previousLock?: ModpackLock
  index?: OfflineModIndex
  onProgress?: (progress: { phase: string; done: number; total: number; file?: string }) => void
  telemetry?: TelemetryService
}

interface RawIndexFile {
  path?: string
  downloads?: string[]
  fileSize?: number
  hashes?: Record<string, string>
  env?: { client?: string; server?: string }
}

async function fileMatches(
  file: string,
  hashes: Record<string, string> | undefined,
  size: number | undefined,
): Promise<boolean> {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) return false
  if (hashes?.sha512) {
    return hashBuffer('sha512', await readFile(file)).toLowerCase() === hashes.sha512.toLowerCase()
  }
  if (hashes?.sha1) {
    return hashBuffer('sha1', await readFile(file)).toLowerCase() === hashes.sha1.toLowerCase()
  }
  return size !== undefined ? info.size === size : false
}

function lockHashes(entry: ModpackLockFile | undefined): Record<string, string> | undefined {
  if (!entry) return undefined
  if (entry.sha512) return { sha512: entry.sha512 }
  if (entry.sha1) return { sha1: entry.sha1 }
  return undefined
}

async function matchesLock(file: string, entry: ModpackLockFile | undefined): Promise<boolean> {
  if (!entry) return false
  return fileMatches(file, lockHashes(entry), entry.size)
}

async function writeBufferAtomic(target: string, buffer: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, buffer)
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function downloadTo(
  target: string,
  urls: string[],
  options: { size?: number; hashes?: Record<string, string>; fetchImpl?: FetchLike; retry?: RetryOptions; signal?: AbortSignal },
): Promise<number> {
  const checksum = options.hashes?.sha512
    ? { algorithm: 'sha512' as const, value: options.hashes.sha512 }
    : options.hashes?.sha1
      ? { algorithm: 'sha1' as const, value: options.hashes.sha1 }
      : undefined
  const downloaded = await downloadBuffer({
    urls,
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(checksum ? { checksum } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  await writeBufferAtomic(target, downloaded.buffer)
  return downloaded.buffer.length
}

async function removeEmptyParents(instanceDir: string, file: string): Promise<void> {
  let current = dirname(file)
  const root = resolve(instanceDir)
  while (resolve(current).startsWith(root) && resolve(current) !== root) {
    const entries = await readdir(current).catch(() => [])
    if (entries.length > 0) break
    await rm(current, { recursive: true, force: true }).catch(() => undefined)
    current = dirname(current)
  }
}

async function removeObsolete(
  instanceDir: string,
  oldFiles: ModpackLockFile[],
  keepPaths: Set<string>,
  logger?: Logger,
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = []
  const kept: string[] = []
  for (const entry of oldFiles) {
    const normalized = entry.path.replace(/\\/g, '/')
    if (keepPaths.has(normalized)) continue
    const target = resolveInside(instanceDir, normalized)
    if (!(await matchesLock(target, entry))) {
      if ((await stat(target).catch(() => undefined))?.isFile()) {
        kept.push(normalized)
        logger?.warn('Obsolete pack file was modified locally; keeping it', { file: normalized })
      }
      continue
    }
    await rm(target, { force: true })
    await removeEmptyParents(instanceDir, target)
    removed.push(normalized)
  }
  return { removed, kept }
}

export async function readMrpackManifest(archivePath: string): Promise<ModpackManifest> {
  let text: string
  try {
    text = await withZip(archivePath, async (zip) => {
      if (!zip.has('modrinth.index.json')) {
        throw new ModError('not-a-modpack', 'modrinth.index.json is missing')
      }
      return (await zip.read('modrinth.index.json')).toString('utf8')
    })
  } catch (error) {
    if (error instanceof ModError) throw error
    throw new ModError('not-a-modpack', `Archive is not readable: ${archivePath}`, {
      cause: (error as Error).message,
    })
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new ModError('invalid-manifest', `modrinth.index.json is invalid: ${(error as Error).message}`)
  }
  if (typeof raw.game === 'string' && raw.game !== 'minecraft') {
    throw new ModError('invalid-manifest', `Unsupported game in modrinth.index.json: ${raw.game}`)
  }
  const filesRaw = Array.isArray(raw.files) ? raw.files : []
  const files: ModpackFile[] = []
  for (const entryRaw of filesRaw) {
    const file = entryRaw as RawIndexFile
    if (!file.path || !Array.isArray(file.downloads) || file.downloads.length === 0) continue
    files.push({
      path: file.path,
      downloads: file.downloads.map(String),
      ...(file.fileSize !== undefined ? { fileSize: file.fileSize } : {}),
      ...(file.hashes ? { hashes: file.hashes } : {}),
      ...(file.env
        ? {
            env: {
              client: file.env.client as NonNullable<ModpackFile['env']>['client'],
              server: file.env.server,
            },
          }
        : {}),
    })
  }
  return {
    name: String(raw.name ?? 'Modpack'),
    ...(typeof raw.versionId === 'string' ? { versionId: raw.versionId } : {}),
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    dependencies: (raw.dependencies ?? {}) as Record<string, string>,
    files,
  }
}

function isBambooProfileManifest(raw: Record<string, unknown>): boolean {
  return (
    raw.formatVersion !== undefined ||
    (raw.profile !== undefined && typeof raw.profile === 'object') ||
    (raw.instance !== undefined && typeof raw.instance === 'object')
  )
}

function isCurseForgeManifest(raw: Record<string, unknown>): boolean {
  // CurseForge does not require `manifestVersion`/`formatVersion`; the
  // authoritative markers are the minecraft block plus the file list.
  return (
    raw.manifestType === 'minecraftModpack' ||
    (raw.minecraft !== undefined &&
      typeof raw.minecraft === 'object' &&
      (Array.isArray(raw.files) || typeof raw.manifestVersion === 'number'))
  )
}

export async function readModpackFormat(archivePath: string): Promise<'mrpack' | 'curseforge'> {
  try {
    return await withZip(archivePath, async (zip) => {
      if (zip.has('modrinth.index.json')) return 'mrpack'
      if (!zip.has('manifest.json')) {
        throw new ModError('not-a-modpack', 'No modrinth.index.json or CurseForge manifest.json found')
      }
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse((await zip.read('manifest.json')).toString('utf8')) as Record<string, unknown>
      } catch (error) {
        throw new ModError('invalid-manifest', `manifest.json is invalid: ${(error as Error).message}`)
      }
      if (isBambooProfileManifest(raw)) {
        throw new ModError('not-a-modpack', 'Archive is a launcher profile export, not a modpack')
      }
      if (isCurseForgeManifest(raw)) return 'curseforge'
      throw new ModError('invalid-manifest', 'manifest.json is not a CurseForge modpack manifest')
    })
  } catch (error) {
    if (error instanceof ModError) throw error
    throw new ModError('not-a-modpack', `Archive is not readable: ${archivePath}`, {
      cause: (error as Error).message,
    })
  }
}

/** Reads the CurseForge manifest, including packs that omit `manifestVersion`. */
export async function readCurseForgeManifest(archivePath: string): Promise<CurseForgeManifest> {
  let text: string
  try {
    text = await withZip(archivePath, async (zip) => {
      if (!zip.has('manifest.json')) {
        throw new ModError('not-a-modpack', 'manifest.json is missing')
      }
      return (await zip.read('manifest.json')).toString('utf8')
    })
  } catch (error) {
    if (error instanceof ModError) throw error
    throw new ModError('not-a-modpack', `Archive is not readable: ${archivePath}`, {
      cause: (error as Error).message,
    })
  }
  try {
    return JSON.parse(text) as CurseForgeManifest
  } catch (error) {
    throw new ModError('invalid-manifest', `manifest.json is invalid: ${(error as Error).message}`)
  }
}

export async function scanMissingDependencies(modsDir: string): Promise<{
  mods: ParsedMod[]
  missing: MissingDependency[]
}> {
  const target = resolve(modsDir)
  const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
  const mods: ParsedMod[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
    mods.push(...(await readModMetadataList(join(target, entry.name))))
  }
  return { mods, missing: findMissingRequired(mods) }
}

function mrpackLockFiles(manifest: ModpackManifest): ModpackLockFile[] {
  return manifest.files
    .filter((file) => file.env?.client !== 'unsupported')
    .map((file) => ({
      path: file.path.replace(/\\/g, '/'),
      ...(file.hashes?.sha1 ? { sha1: file.hashes.sha1 } : {}),
      ...(file.hashes?.sha512 ? { sha512: file.hashes.sha512 } : {}),
      ...(file.fileSize !== undefined ? { size: file.fileSize } : {}),
      source: 'pack',
    }))
}

function buildLock(
  format: 'mrpack' | 'curseforge',
  name: string,
  versionId: string,
  upstream: ModpackUpstream | undefined,
  previous: ModpackLock | undefined,
  dependencies: Record<string, string>,
  files: ModpackLockFile[],
): ModpackLock {
  const identity: ModpackUpstream = upstream ?? previous?.upstream ?? {
    provider: 'local',
    format,
    name,
    ...(versionId ? { versionId } : {}),
  }
  return {
    version: 1,
    format,
    name,
    versionId,
    upstream: {
      provider: identity.provider,
      format: identity.format,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.versionId ? { versionId: identity.versionId } : {}),
      ...(identity.projectId ? { projectId: identity.projectId } : {}),
      ...(identity.file ? { file: identity.file } : {}),
    },
    dependencies,
    files,
    updatedAt: Date.now(),
  }
}

async function installMrpack(options: ModpackInstallOptions): Promise<ModpackInstallResult> {
  const manifest = await readMrpackManifest(options.archivePath)
  const previous = options.previousLock?.format === 'mrpack' ? options.previousLock : undefined
  const oldByPath = new Map((previous?.files ?? []).map((entry) => [entry.path, entry]))
  const installed: string[] = []
  const skipped: string[] = []
  const updated: string[] = []
  let downloadedBytes = 0
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index]
    options.onProgress?.({ phase: 'files', done: index, total: manifest.files.length, file: file.path })
    if (file.env?.client === 'unsupported') {
      skipped.push(file.path)
      continue
    }
    const target = resolveInside(options.instanceDir, file.path)
    if (await fileMatches(target, file.hashes, file.fileSize)) {
      skipped.push(file.path)
      continue
    }
    if (oldByPath.has(file.path)) updated.push(file.path)
    downloadedBytes += await downloadTo(target, file.downloads, {
      ...(file.fileSize !== undefined ? { size: file.fileSize } : {}),
      ...(file.hashes ? { hashes: file.hashes } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    installed.push(file.path)
  }

  const keepPaths = new Set(manifest.files.map((file) => file.path.replace(/\\/g, '/')))
  const obsolete = previous
    ? await removeObsolete(options.instanceDir, previous.files, keepPaths, options.logger)
    : { removed: [], kept: [] }

  const extraction = await withZip(options.archivePath, (zip) =>
    zip.extract(['overrides', 'client-overrides'], options.instanceDir, (relative, done, total) => {
      options.onProgress?.({ phase: 'overrides', done, total, file: relative })
    }),
  )
  const overrides = extraction.written
  await mkdir(options.instanceDir, { recursive: true })
  await writeFile(
    join(options.instanceDir, 'modrinth.index.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  const scan = await scanMissingDependencies(join(options.instanceDir, 'mods'))
  await writeModpackLock(
    options.instanceDir,
    buildLock(
      'mrpack',
      manifest.name,
      manifest.versionId ?? '',
      options.upstream,
      previous,
      manifest.dependencies,
      mrpackLockFiles(manifest),
    ),
    options.logger,
  )
  options.onProgress?.({ phase: 'done', done: manifest.files.length, total: manifest.files.length })
  options.logger?.info('mrpack installed', {
    instanceDir: options.instanceDir,
    installed: installed.length,
    skipped: skipped.length,
    updated: updated.length,
    removed: obsolete.removed.length,
    kept: obsolete.kept.length,
    overrides,
    overridePaths: extraction.paths.size,
    downloadedBytes,
  })
  return {
    format: 'mrpack',
    installed,
    skipped,
    overrides,
    missingDependencies: scan.missing,
    installedDependencies: [],
    downloadedBytes,
    updated,
    removed: obsolete.removed,
    kept: obsolete.kept,
    blocked: [],
  }
}

export interface CurseForgeManifest {
  name?: string
  /** CurseForge writes the pack version to `version`; `versionId` is a Bamboo export alias. */
  version?: string
  versionId?: string
  author?: string
  manifestType?: string
  manifestVersion?: number
  minecraft?: { version?: string; modLoaders?: Array<{ id?: string; primary?: boolean }> }
  files?: Array<{ projectID?: number; fileID?: number; required?: boolean }>
  overrides?: string
}

export function loaderFromCurseForgeId(id: string | undefined): ModLoader {
  const value = String(id ?? '').toLowerCase()
  if (value.startsWith('neoforge')) return 'neoforge'
  if (value.startsWith('fabric')) return 'fabric'
  if (value.startsWith('quilt')) return 'quilt'
  if (value.startsWith('forge')) return 'forge'
  return 'unknown'
}

function curseForgeLockEntry(
  path: string,
  file: { id: number; modId: number; fileName: string; fileLength: number; hashes: Array<{ algo: number; value: string }> },
  source: string,
): ModpackLockFile {
  const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value
  return {
    path: path.replace(/\\/g, '/'),
    ...(sha1 ? { sha1 } : {}),
    ...(file.fileLength > 0 ? { size: file.fileLength } : {}),
    projectId: file.modId,
    fileId: file.id,
    source,
  }
}

export interface CurseForgePlannedFile {
  file: CurseForgeFile
  path: string
  source: 'pack' | 'dependency'
}

export interface CurseForgeMissingDependency {
  modId: number
  requiredBy: string[]
}

export interface CurseForgeContentPlan {
  files: CurseForgePlannedFile[]
  missingDependencies: CurseForgeMissingDependency[]
}

/** One predicate for every CurseForge content path: preview and install both use it. */
function isInstallableCurseForgeFile(
  file: NonNullable<CurseForgeManifest['files']>[number],
): file is { projectID: number; fileID: number; required?: boolean } {
  return (
    Number.isInteger(file.projectID) &&
    Number(file.projectID) > 0 &&
    Number.isInteger(file.fileID) &&
    Number(file.fileID) > 0
  )
}

/** The file folder each CurseForge project type loads from in a Minecraft instance. */
function curseForgeContentFolder(type: CurseForgeProjectType | undefined): string {
  if (type === 'resourcepack') return 'resourcepacks'
  if (type === 'shader') return 'shaderpacks'
  if (type === 'datapack') return 'datapacks'
  return 'mods'
}

/**
 * Resolves the exact file set an install will write, without downloading it.
 * The preview counts this plan; the installer downloads this plan, so a
 * manifest entry the installer skips can never be counted by the preview.
 * The project type decides the target folder for both sides.
 */
export async function planCurseForgeContent(
  manifest: CurseForgeManifest,
  client: CurseForgeClient | undefined,
  options: { minecraftVersion?: string; loader?: ModLoader } = {},
): Promise<CurseForgeContentPlan> {
  const requestedFiles = (manifest.files ?? []).filter(isInstallableCurseForgeFile)
  if (requestedFiles.length > 0 && !client) {
    throw new ModError('missing-api-key', 'CurseForge packs require an API client')
  }

  const knownProjects = new Set<number>()
  const requiredDependencies = new Map<number, string[]>()
  const planned: CurseForgePlannedFile[] = []
  const projectTypes = new Map<number, CurseForgeProjectType>()
  if (client) {
    try {
      const projects = await client.mods([...new Set(requestedFiles.map((entry) => entry.projectID))])
      for (const project of projects) {
        const type = curseForgeProjectTypeFor(project.classId)
        if (type) projectTypes.set(project.id, type)
      }
    } catch {
      // Older/private projects may not expose metadata; keep the historical mods/ layout.
    }
  }

  for (const requested of requestedFiles) {
    if (!client) throw new ModError('missing-api-key', 'CurseForge packs require an API client')
    knownProjects.add(requested.projectID)
    const file = await client.file(requested.projectID, requested.fileID)
    for (const dependency of requiredCurseForgeDependencies(file)) {
      if (knownProjects.has(dependency)) continue
      const requiredBy = requiredDependencies.get(dependency) ?? []
      requiredBy.push(file.fileName)
      requiredDependencies.set(dependency, requiredBy)
    }
    planned.push({
      file,
      path: join(curseForgeContentFolder(projectTypes.get(requested.projectID)), file.fileName).replace(/\\/g, '/'),
      source: 'pack',
    })
  }

  const missingDependencies: CurseForgeMissingDependency[] = []
  for (const [modId, requiredBy] of requiredDependencies) {
    if (knownProjects.has(modId)) continue
    if (!client) throw new ModError('missing-api-key', 'CurseForge packs require an API client')
    const candidates = await client.files(modId, {
      ...(options.minecraftVersion ? { gameVersion: options.minecraftVersion } : {}),
      ...(options.loader ? { loader: options.loader } : {}),
    })
    const chosen = candidates[0]
    if (!chosen) {
      missingDependencies.push({ modId, requiredBy })
      continue
    }
    planned.push({
      file: chosen,
      path: join('mods', chosen.fileName).replace(/\\/g, '/'),
      source: 'dependency',
    })
    knownProjects.add(modId)
  }

  return { files: planned, missingDependencies }
}

async function installCurseForgePack(options: ModpackInstallOptions): Promise<ModpackInstallResult> {
  const client = options.curseforge
  const manifest = await readCurseForgeManifest(options.archivePath)
  const minecraftVersion =
    options.minecraftVersion ?? String(manifest.minecraft?.version ?? '')
  const primary = manifest.minecraft?.modLoaders?.find((loader) => loader.primary) ??
    manifest.minecraft?.modLoaders?.[0]
  const loader = options.loader ?? loaderFromCurseForgeId(primary?.id)
  const previous = options.previousLock?.format === 'curseforge' ? options.previousLock : undefined
  const oldByProject = new Map<string, ModpackLockFile>()
  for (const old of previous?.files ?? []) {
    if (old.projectId !== undefined) oldByProject.set(String(old.projectId), old)
  }

  const installed: string[] = []
  const skipped: string[] = []
  const updated: string[] = []
  const replaced: string[] = []
  const preserved: string[] = []
  const blocked: BlockedPackFile[] = []
  const downloaded: Array<{ path: string; file: Awaited<ReturnType<CurseForgeClient['file']>>; source: string }> = []
  let downloadedBytes = 0
  const plan = await planCurseForgeContent(manifest, client, { minecraftVersion, loader })
  const installedDependencies: string[] = []
  for (let index = 0; index < plan.files.length; index += 1) {
    const { file, path: relativePath, source } = plan.files[index]
    if (!client) throw new ModError('missing-api-key', 'CurseForge packs require an API client')
    options.onProgress?.({ phase: 'files', done: index, total: plan.files.length })
    const target = resolveInside(options.instanceDir, relativePath)
    const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value
    const old = oldByProject.get(String(file.modId))
    const oldPath =
      source === 'pack' && old && old.fileId !== undefined && old.fileId !== file.id && old.path !== relativePath
        ? old
        : undefined
    const dropOld = async (): Promise<void> => {
      if (!oldPath) return
      const oldTarget = resolveInside(options.instanceDir, oldPath.path)
      if (await matchesLock(oldTarget, oldPath)) {
        await rm(oldTarget, { force: true })
        replaced.push(oldPath.path)
      }
    }
    if (await fileMatches(target, { sha1: sha1 ?? '' }, file.fileLength)) {
      if (source === 'pack') {
        skipped.push(file.fileName)
        await dropOld()
      }
      downloaded.push({ path: relativePath, file, source })
      continue
    }
    const wasUpdate =
      source === 'pack' ? old !== undefined : Boolean(old && old.fileId !== file.id)
    let result: { bytes: number; skipped: boolean }
    try {
      result = await client.download(file, target, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      const modrinth = options.modrinth
      if (!(error instanceof ModError) || error.code !== 'distribution-blocked' || !modrinth) {
        throw error
      }
      let fallback: { bytes: number; skipped: boolean } | undefined
      try {
        fallback = sha1
          ? await modrinth.downloadFileByHash(sha1, target, {
              ...(options.signal ? { signal: options.signal } : {}),
            })
          : undefined
      } catch (fallbackError) {
        throw new ModError(
          'distribution-blocked',
          `CurseForge project ${file.modId} blocks third-party distribution and the Modrinth fallback for ${file.fileName} failed: ${describeError(fallbackError)}`,
          { projectId: String(file.modId), fileId: String(file.id), fileName: file.fileName },
        )
      }
      if (!fallback) {
        // No sanctioned route offers this file: the author forbids third-party
        // distribution and Modrinth has no copy. One unreachable file must not
        // abort the whole pack import — it is reported and skipped instead.
        const message = `CurseForge project ${file.modId} blocks third-party distribution and ${file.fileName} has no matching Modrinth file${sha1 ? '' : ' (no SHA-1 in the manifest)'}`
        blocked.push({ fileName: file.fileName, message })
        options.logger?.warn('CurseForge pack file skipped: distribution blocked', {
          modId: file.modId,
          fileId: file.id,
          file: file.fileName,
          sha1: sha1 ?? null,
        })
        // On an update the previous version stays on disk; removing it would
        // leave the pack worse off than before.
        if (old) preserved.push(old.path)
        continue
      }
      options.logger?.info('CurseForge file resolved from Modrinth by SHA-1', {
        modId: file.modId,
        fileId: file.id,
        file: file.fileName,
        sha1,
      })
      result = fallback
    }
    if (wasUpdate) updated.push(file.fileName)
    downloadedBytes += result.bytes
    if (source === 'pack') {
      if (result.skipped) skipped.push(file.fileName)
      else installed.push(file.fileName)
      await dropOld()
    } else if (!result.skipped) {
      installedDependencies.push(file.fileName)
    }
    await options.index
      ?.recordFile(target, {
        projectId: String(file.modId),
        versionId: String(file.id),
        versionNumber: file.displayName,
        name: file.fileName,
        source: 'curseforge',
      })
      .catch((error: Error) =>
        options.logger?.warn('Could not update offline mod index', { error: error.message }),
      )
    downloaded.push({ path: relativePath, file, source })
  }

  for (const missing of plan.missingDependencies) {
    const previousDependency = oldByProject.get(String(missing.modId))
    if (previousDependency) preserved.push(previousDependency.path)
    options.logger?.warn('Required CurseForge dependency has no matching file', {
      modId: missing.modId,
      minecraftVersion,
      loader,
      requiredBy: missing.requiredBy,
    })
  }

  const overridesPrefix = manifest.overrides ?? 'overrides'
  const keepPaths = new Set([...downloaded.map((entry) => entry.path), ...preserved])
  const obsolete = previous
    ? await removeObsolete(options.instanceDir, previous.files, keepPaths, options.logger)
    : { removed: [], kept: [] }
  const extraction = await withZip(options.archivePath, (zip) =>
    zip.extract(overridesPrefix, options.instanceDir, (relative, done, total) => {
      options.onProgress?.({ phase: 'overrides', done, total, file: relative })
    }),
  )
  const overrides = extraction.written
  await mkdir(options.instanceDir, { recursive: true })
  await writeFile(join(options.instanceDir, 'curseforge.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const scan = await scanMissingDependencies(join(options.instanceDir, 'mods'))

  const lockFiles = downloaded.map((entry) => curseForgeLockEntry(entry.path, entry.file, entry.source))
  const managed = lockFiles.filter((entry) => !extraction.paths.has(entry.path))
  await writeModpackLock(
    options.instanceDir,
    buildLock(
      'curseforge',
      manifest.name ?? 'CurseForge Pack',
      manifest.version ?? manifest.versionId ?? '',
      options.upstream,
      previous,
      {
        ...(minecraftVersion ? { minecraft: minecraftVersion } : {}),
        ...(primary?.id ? { loader: primary.id } : {}),
      },
      managed,
    ),
    options.logger,
  )
  options.onProgress?.({ phase: 'done', done: plan.files.length, total: plan.files.length })
  options.logger?.info('CurseForge pack installed', {
    instanceDir: options.instanceDir,
    installed: installed.length,
    skipped: skipped.length,
    updated: updated.length,
    removed: obsolete.removed.length,
    kept: obsolete.kept.length,
    dependencies: installedDependencies.length,
    overrides,
    downloadedBytes,
  })
  return {
    format: 'curseforge',
    installed,
    skipped,
    overrides,
    missingDependencies: scan.missing,
    installedDependencies,
    downloadedBytes,
    updated,
    removed: [...replaced, ...obsolete.removed],
    kept: obsolete.kept,
    blocked,
  }
}

async function installModpackInternal(options: ModpackInstallOptions): Promise<ModpackInstallResult> {
  const format = await readModpackFormat(options.archivePath)
  const previous = options.previousLock ?? (await readModpackLock(options.instanceDir, options.logger))
  const effective: ModpackInstallOptions = {
    ...options,
    ...(previous && previous.format === format ? { previousLock: previous } : {}),
  }
  return format === 'mrpack' ? installMrpack(effective) : installCurseForgePack(effective)
}

function measureModpack(
  options: ModpackInstallOptions,
  operation: (nested: ModpackInstallOptions) => Promise<ModpackInstallResult>,
): Promise<ModpackInstallResult> {
  if (!options.telemetry) return operation(options)
  return options.telemetry.measure('modpack', () => operation(withoutTelemetry(options)))
}

export async function installModpack(options: ModpackInstallOptions): Promise<ModpackInstallResult> {
  return measureModpack(options, installModpackInternal)
}

async function readCurseForgeDependencies(archivePath: string): Promise<Record<string, string>> {
  try {
    const manifest = await readCurseForgeManifest(archivePath)
    const primary = manifest.minecraft?.modLoaders?.find((loader) => loader.primary) ??
      manifest.minecraft?.modLoaders?.[0]
    return {
      ...(manifest.minecraft?.version ? { minecraft: String(manifest.minecraft.version) } : {}),
      ...(primary?.id ? { loader: String(primary.id) } : {}),
    }
  } catch (error) {
    getDefaultLogger().child('mods:modpack').warn(
      'CurseForge manifest is unreadable; dependencies cannot be read',
      { archivePath, error: describeError(error) },
    )
    return {}
  }
}

async function readArchiveDependencies(
  archivePath: string,
  format: 'mrpack' | 'curseforge',
): Promise<Record<string, string>> {
  return format === 'mrpack'
    ? (await readMrpackManifest(archivePath)).dependencies
    : readCurseForgeDependencies(archivePath)
}

const LOADER_DEPENDENCY_KEYS = [
  ['fabric-loader', 'fabric'],
  ['quilt-loader', 'quilt'],
  ['neoforge', 'neoforge'],
  ['forge', 'forge'],
  ['loader', 'loader'],
] as const

interface LoaderIdentity {
  kind: string
  version: string
}

function loaderIdentity(dependencies: Record<string, string>): LoaderIdentity | undefined {
  for (const [key, kind] of LOADER_DEPENDENCY_KEYS) {
    const version = dependencies[key]
    if (typeof version === 'string' && version.length > 0) return { kind, version }
  }
  return undefined
}

export async function updateModpack(options: ModpackInstallOptions): Promise<ModpackInstallResult> {
  const lock = await readModpackLock(options.instanceDir, options.logger)
  if (!lock) {
    throw new ModError('no-lock', `No modpack lock in ${options.instanceDir}`, {
      instanceDir: options.instanceDir,
    })
  }
  const format = await readModpackFormat(options.archivePath)
  if (format !== lock.format) {
    throw new ModError('format-mismatch', `Lock is ${lock.format}, archive is ${format}`, {
      expected: lock.format,
      actual: format,
    })
  }
  const nextDependencies = await readArchiveDependencies(options.archivePath, format)
  const beforeMinecraft = lock.dependencies.minecraft
  const afterMinecraft = nextDependencies.minecraft
  if (beforeMinecraft && afterMinecraft && beforeMinecraft !== afterMinecraft) {
    throw new ModError(
      'loader-mismatch',
      `Pack minecraft changed from ${beforeMinecraft} to ${afterMinecraft}; reinstall the instance or migrate the loader`,
      { key: 'minecraft', before: beforeMinecraft, after: afterMinecraft },
    )
  }
  const beforeLoader = loaderIdentity(lock.dependencies)
  const afterLoader = loaderIdentity(nextDependencies)
  if (
    (beforeLoader || afterLoader) &&
    (beforeLoader?.kind !== afterLoader?.kind || beforeLoader?.version !== afterLoader?.version)
  ) {
    const label = (value: LoaderIdentity | undefined): string =>
      value ? `${value.kind} ${value.version}` : 'none'
    throw new ModError(
      'loader-mismatch',
      `Pack loader changed from ${label(beforeLoader)} to ${label(afterLoader)}; reinstall the instance or migrate the loader`,
      { key: 'loader', before: label(beforeLoader), after: label(afterLoader) },
    )
  }
  return measureModpack(options, (nested) =>
    installModpackInternal({ ...nested, previousLock: lock }),
  )
}
