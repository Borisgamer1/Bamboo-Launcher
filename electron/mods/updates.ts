import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { stat as statPath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { hashBuffer } from '../download/checksum'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { commitInstalledFile } from './content-state'
import { ModError } from './errors'
import type { ModLedger } from './ledger'
import { resolveFileInside, resolveInside } from './paths'
import type { ModrinthClient } from './modrinth'
import type { OfflineModIndex } from './offline-index'
import {
  lessStableChannel,
  type ModProvider,
  type ProviderUpdate,
  type ProviderVersionTarget,
  type UpdateLookup,
} from './provider'
import type {
  InstalledFileRecord,
  ModLoader,
  ProviderId,
  ProviderVersion,
  UpdateChannel,
} from './types'

const UPDATE_BATCH_SIZE = 100
const DEFAULT_UPDATE_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000
const HASH_CONCURRENCY = 8

export interface ModUpdateCandidate {
  path: string
  sha1: string
  projectId: string
  currentVersionId?: string
  latest: ProviderVersion
}

export interface CheckModUpdatesOptions {
  instanceDir: string
  client: ModrinthClient
  minecraftVersion: string
  loader?: ModLoader
  directories?: string[]
  index?: OfflineModIndex
  signal?: AbortSignal
  logger?: Logger
}

export interface CheckModUpdatesResult {
  checked: number
  updates: ModUpdateCandidate[]
  unresolved: string[]
}

export async function checkModUpdates(options: CheckModUpdatesOptions): Promise<CheckModUpdatesResult> {
  const directories = options.directories ?? ['mods']
  const installed: Array<{ path: string; sha1: string }> = []
  for (const directory of directories) {
    const absolute = join(options.instanceDir, ...directory.split('/'))
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.(jar|zip)$/i.test(entry.name)) continue
      if (entry.name.endsWith('.part') || entry.name.includes('.part-')) continue
      if (options.signal?.aborted) throw new ModError('aborted', 'Update check aborted')
      const file = join(absolute, entry.name)
      const buffer = await readFile(file).catch(() => undefined)
      if (!buffer) continue
      installed.push({
        path: `${directory.replace(/\\/g, '/')}/${entry.name}`,
        sha1: hashBuffer('sha1', buffer),
      })
    }
  }

  const updates: ModUpdateCandidate[] = []
  const resolved = new Set<string>()
  for (let offset = 0; offset < installed.length; offset += UPDATE_BATCH_SIZE) {
    const batch = installed.slice(offset, offset + UPDATE_BATCH_SIZE)
    const latest = await options.client.updateMany(
      batch.map((entry) => entry.sha1),
      {
        minecraftVersion: options.minecraftVersion,
        ...(options.loader ? { loader: options.loader } : {}),
      },
    )
    for (const entry of batch) {
      const version = latest[entry.sha1]
      if (!version) continue
      resolved.add(entry.sha1)
      const primary = version.files.find((file) => file.primary) ?? version.files[0]
      const latestSha1 = primary?.hashes?.sha1?.toLowerCase()
      if (!primary || !latestSha1 || latestSha1 === entry.sha1) continue
      const known = await options.index?.lookup(entry.sha1).catch(() => undefined)
      updates.push({
        path: entry.path,
        sha1: entry.sha1,
        projectId: version.projectId,
        ...(known?.versionId ? { currentVersionId: known.versionId } : {}),
        latest: version,
      })
    }
  }

  options.logger?.info('Mod update check finished', {
    checked: installed.length,
    updates: updates.length,
  })
  return {
    checked: installed.length,
    updates,
    unresolved: installed.filter((entry) => !resolved.has(entry.sha1)).map((entry) => entry.sha1),
  }
}

export interface ApplyModUpdateOptions {
  instanceDir: string
  candidate: ModUpdateCandidate
  client: ModrinthClient
  index?: OfflineModIndex
  signal?: AbortSignal
  logger?: Logger
}

export interface ApplyModUpdateResult {
  installed: string
  removed?: string
}

export type InstalledUpdateStatus =
  | 'update-available'
  | 'up-to-date'
  | 'local-change'
  | 'missing'
  | 'skipped'
  | 'unresolved'

export type InstalledUpdateReason =
  | 'newer-version'
  | 'already-current'
  | 'older-version'
  | 'hash-mismatch'
  | 'file-missing'
  | 'not-on-provider'
  | 'project-mismatch'
  | 'no-project'
  | 'missing-file-id'
  | 'provider-mismatch'
  | 'no-path'
  | 'cached'
  | 'offline'
  | 'stale'

export interface InstalledUpdateEntry {
  sha1: string
  path: string
  fileName: string
  projectId?: string
  versionId?: string
  status: InstalledUpdateStatus
  reason: InstalledUpdateReason
  hashed: boolean
  cached: boolean
  stale: boolean
  candidate?: ProviderUpdate
  checkedAt: number
}

export interface CheckInstalledUpdatesOptions {
  instanceDir: string
  ledger: ModLedger
  provider: ModProvider
  target: ProviderVersionTarget & { minecraftVersion: string }
  channel?: UpdateChannel
  refresh?: boolean
  updateTtlMs?: number
  negativeTtlMs?: number
  now?: () => number
  signal?: AbortSignal
  logger?: Logger
}

export interface CheckInstalledUpdatesResult {
  provider: ProviderId
  checkedAt: number
  checked: number
  hashed: number
  cached: number
  offline: boolean
  /** Why the provider was treated as unreachable, so a bug cannot look like offline. */
  offlineCause?: string
  updates: InstalledUpdateEntry[]
  entries: InstalledUpdateEntry[]
  unresolved: number
}

interface PreparedUpdate {
  record: InstalledFileRecord
  entry: InstalledUpdateEntry
  lookup?: UpdateLookup
  stat?: { size: number; mtimeMs: number }
  checkedProvider: boolean
}

async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function existingFile(
  instanceDir: string,
  record: InstalledFileRecord,
): Promise<{ path: string; absolute: string; stat: { size: number; mtimeMs: number } } | undefined> {
  for (const path of record.paths) {
    try {
      const absolute = resolveInside(instanceDir, path)
      const info = await statPath(absolute)
      if (info.isFile()) {
        return { path, absolute, stat: { size: info.size, mtimeMs: info.mtimeMs } }
      }
    } catch (error) {
      // Unreadable path: try the next recorded location.
      getDefaultLogger().child('mods:updates').debug('update check: recorded path unreadable', {
        path,
        error: describeError(error),
      })
    }
  }
  return undefined
}

async function inspectRecord(
  record: InstalledFileRecord,
  options: CheckInstalledUpdatesOptions,
  checkedAt: number,
): Promise<PreparedUpdate> {
  const entry: InstalledUpdateEntry = {
    sha1: record.sha1,
    path: record.paths[0] ?? '',
    fileName: basename(record.paths[0] ?? ''),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.versionId ? { versionId: record.versionId } : {}),
    status: 'unresolved',
    reason: 'no-path',
    hashed: false,
    cached: false,
    stale: false,
    checkedAt,
  }
  const base = { record, entry, checkedProvider: false }

  if (record.paths.length === 0) return base
  if (record.provider && record.provider !== options.provider.id) {
    // Belongs to the other provider: skipped, not "unknown" — a mixed instance must
    // not be able to fake a lost project out of a foreign record.
    entry.status = 'skipped'
    entry.reason = 'provider-mismatch'
    return base
  }

  const file = await existingFile(options.instanceDir, record)
  if (!file) {
    entry.status = 'missing'
    entry.reason = 'file-missing'
    return base
  }
  entry.path = file.path
  entry.fileName = basename(file.path)

  const channel = lessStableChannel(record.channel ?? 'release', options.channel ?? 'release')
  const unchanged =
    record.stat !== undefined &&
    record.stat.size === file.stat.size &&
    record.stat.mtimeMs === file.stat.mtimeMs

  if (!options.refresh && unchanged && record.checkedAt !== undefined && record.lastCheck) {
    const ttl =
      record.lastCheck.status === 'unresolved'
        ? (options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS)
        : (options.updateTtlMs ?? DEFAULT_UPDATE_TTL_MS)
    if (checkedAt - record.checkedAt < ttl) {
      entry.status = record.lastCheck.status
      entry.reason = 'cached'
      entry.cached = true
      if (record.lastCheck.versionId && record.projectId) {
        entry.candidate = {
          projectId: record.projectId,
          versionId: record.lastCheck.versionId,
          ...(record.lastCheck.fileId ? { fileId: record.lastCheck.fileId } : {}),
          channel,
        }
      }
      return { ...base, stat: file.stat }
    }
  }

  let sha1 = record.sha1
  if (!unchanged) {
    entry.hashed = true
    sha1 = await sha1File(file.absolute)
  }
  if (sha1 !== record.sha1) {
    entry.sha1 = sha1
    entry.status = 'local-change'
    entry.reason = 'hash-mismatch'
    return { ...base, stat: file.stat }
  }

  if (!record.projectId) {
    entry.reason = 'no-project'
    return { ...base, stat: file.stat }
  }
  if (options.provider.id === 'curseforge' && !record.fileId) {
    entry.reason = 'missing-file-id'
    return { ...base, stat: file.stat }
  }

  const lookup: UpdateLookup = {
    key: record.sha1,
    projectId: record.projectId,
    ...(record.versionId ? { versionId: record.versionId } : {}),
    ...(record.fileId ? { fileId: record.fileId } : {}),
    sha1: record.sha1,
    channel,
  }
  entry.reason = 'not-on-provider'
  return { ...base, lookup, stat: file.stat }
}

function decide(
  prepared: PreparedUpdate,
  candidate: ProviderUpdate | undefined,
  checkedAt: number,
): void {
  const { entry, record } = prepared
  entry.checkedAt = checkedAt
  if (!candidate) {
    entry.status = 'unresolved'
    entry.reason = 'not-on-provider'
    return
  }
  if (candidate.projectId !== record.projectId) {
    entry.status = 'unresolved'
    entry.reason = 'project-mismatch'
    return
  }
  if (candidate.versionId === record.versionId) {
    entry.status = 'up-to-date'
    entry.reason = 'already-current'
    return
  }
  if (
    record.publishedAt &&
    candidate.publishedAt &&
    Date.parse(candidate.publishedAt) < Date.parse(record.publishedAt)
  ) {
    entry.status = 'up-to-date'
    entry.reason = 'older-version'
    return
  }
  entry.status = 'update-available'
  entry.reason = 'newer-version'
  entry.candidate = candidate
}

export async function checkInstalledUpdates(
  options: CheckInstalledUpdatesOptions,
): Promise<CheckInstalledUpdatesResult> {
  const checkedAt = (options.now ?? Date.now)()
  const records = await options.ledger.list()
  const prepared: PreparedUpdate[] = []

  for (let offset = 0; offset < records.length; offset += HASH_CONCURRENCY) {
    if (options.signal?.aborted) throw new ModError('aborted', 'Update check aborted')
    const batch = records.slice(offset, offset + HASH_CONCURRENCY)
    prepared.push(
      ...(await Promise.all(batch.map((record) => inspectRecord(record, options, checkedAt)))),
    )
  }

  const lookups = prepared.flatMap((item) => (item.lookup ? [item.lookup] : []))
  let offline = false
  let offlineCause: string | undefined
  if (lookups.length > 0) {
    if (options.signal?.aborted) throw new ModError('aborted', 'Update check aborted')
    try {
      const candidates = await options.provider.checkUpdates(lookups, options.target)
      for (const item of prepared) {
        if (!item.lookup) continue
        item.checkedProvider = true
        decide(item, candidates.get(item.lookup.key), checkedAt)
      }
    } catch (error) {
      if (options.signal?.aborted) throw new ModError('aborted', 'Update check aborted')
      if (error instanceof ModError && error.code !== 'provider-error') throw error
      offline = true
      offlineCause = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      options.logger?.warn('Update check failed; falling back to the stale ledger state', {
        cause: offlineCause,
      })
      for (const item of prepared) {
        if (!item.lookup) continue
        item.checkedProvider = false
        const last = item.record.lastCheck
        if (last) {
          item.entry.status = last.status
          item.entry.reason = 'stale'
          item.entry.stale = true
          if (last.versionId && item.record.projectId) {
            item.entry.candidate = {
              projectId: item.record.projectId,
              versionId: last.versionId,
              ...(last.fileId ? { fileId: last.fileId } : {}),
              channel: item.lookup.channel ?? 'release',
            }
          }
        } else {
          item.entry.status = 'unresolved'
          item.entry.reason = 'offline'
          item.entry.stale = true
        }
      }
    }
  }

  const entries = prepared.map((item) => item.entry)
  const checks = prepared
    .filter(
      (item) =>
        !offline &&
        item.stat !== undefined &&
        item.checkedProvider &&
        !item.entry.cached &&
        item.entry.status !== 'local-change' &&
        item.entry.status !== 'missing',
    )
    .map((item) => ({
      sha1: item.record.sha1,
      stat: item.stat as { size: number; mtimeMs: number },
      checkedAt,
      lastCheck: {
        checkedAt,
        status: item.entry.status as 'update-available' | 'up-to-date' | 'unresolved',
        ...(item.entry.candidate
          ? {
              versionId: item.entry.candidate.versionId,
              ...(item.entry.candidate.fileId ? { fileId: item.entry.candidate.fileId } : {}),
            }
          : {}),
        reason: item.entry.reason,
      },
    }))
  if (checks.length > 0) await options.ledger.recordChecks(checks)

  const updates = entries.filter((entry) => entry.status === 'update-available')
  options.logger?.info('Installed mod update check finished', {
    checked: entries.length,
    hashed: entries.filter((entry) => entry.hashed).length,
    updates: updates.length,
  })
  return {
    provider: options.provider.id,
    checkedAt,
    checked: entries.length,
    hashed: entries.filter((entry) => entry.hashed).length,
    cached: entries.filter((entry) => entry.cached).length,
    offline,
    ...(offlineCause ? { offlineCause } : {}),
    updates,
    entries,
    unresolved: entries.filter((entry) => entry.status === 'unresolved').length,
  }
}

export async function applyModUpdate(options: ApplyModUpdateOptions): Promise<ApplyModUpdateResult> {
  const { candidate, client } = options
  const previous = resolveInside(options.instanceDir, candidate.path)
  const existing = await readFile(previous).catch(() => undefined)
  if (!existing || hashBuffer('sha1', existing) !== candidate.sha1) {
    throw new ModError('stale-update', `Installed file changed since the update check: ${candidate.path}`, {
      path: candidate.path,
    })
  }
  const file = candidate.latest.files.find((entry) => entry.primary) ?? candidate.latest.files[0]
  if (!file) throw new ModError('invalid-manifest', 'Latest version has no downloadable file')
  const directory = candidate.path.includes('/')
    ? candidate.path.slice(0, candidate.path.lastIndexOf('/'))
    : ''
  const destination = resolveFileInside(options.instanceDir, directory, file.filename)
  await mkdir(dirname(destination), { recursive: true })
  await client.downloadVersion(
    {
      ...candidate.latest,
      files: [file],
    },
    destination,
    { ...(options.signal ? { signal: options.signal } : {}) },
  )
  let removed: string | undefined
  if (resolve(previous) !== resolve(destination)) {
    await rm(previous, { force: true })
    removed = candidate.path
  }
  const installed = relative(options.instanceDir, destination).replace(/\\/g, '/')
  await commitInstalledFile({
    instanceDir: options.instanceDir,
    path: installed,
    previousPath: candidate.path,
    previousSha1: candidate.sha1,
    record: {
      projectId: candidate.latest.projectId,
      versionId: candidate.latest.id,
      versionNumber: candidate.latest.versionNumber,
      name: candidate.latest.name,
      source: 'modrinth',
    },
    index: options.index,
    logger: options.logger,
  })
  options.logger?.info('Mod updated', {
    from: candidate.path,
    to: basename(destination),
    version: candidate.latest.versionNumber,
  })
  return {
    installed,
    ...(removed ? { removed } : {}),
  }
}
