import { basename, join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import { FileLock } from '../file-lock'
import type { Logger } from '../logger'
import { ModError } from './errors'
import { readModpackLock } from './lock'
import { MOD_INDEX_FILE, MOD_INDEX_VERSION, type ModIndexFile } from './offline-index'
import type { InstalledFileRecord, ProviderId, UpdateChannel } from './types'

export const MOD_LEDGER_FILE = 'mods.ledger.json'
export const LEDGER_VERSION = 1

interface LedgerFile {
  version: 1
  updatedAt: number
  entries: Record<string, InstalledFileRecord>
}

export interface LedgerMigration {
  lockFiles: number
  lockFilesWithoutSha1: number
  indexEntries: number
  indexEntriesWithoutPath: number
}

function normalizeSha1(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const sha1 = value.trim().toLowerCase()
  return /^[a-f0-9]{40}$/.test(sha1) ? sha1 : undefined
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  return path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..') ? path : undefined
}

function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    result.push(normalized)
  }
  return result.sort((a, b) => a.localeCompare(b))
}

function providerFrom(value: unknown): ProviderId | undefined {
  return value === 'modrinth' || value === 'curseforge' ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function channelField(value: unknown): UpdateChannel | undefined {
  return value === 'release' || value === 'beta' || value === 'alpha' ? value : undefined
}

function statField(value: unknown): InstalledFileRecord['stat'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const stat = value as Record<string, unknown>
  const size = numberField(stat.size)
  const mtimeMs = numberField(stat.mtimeMs)
  return size !== undefined && mtimeMs !== undefined ? { size, mtimeMs } : undefined
}

function lastCheckField(value: unknown): InstalledFileRecord['lastCheck'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const check = value as Record<string, unknown>
  const checkedAt = numberField(check.checkedAt)
  const status = check.status
  if (checkedAt === undefined) return undefined
  if (status !== 'update-available' && status !== 'up-to-date' && status !== 'unresolved') {
    return undefined
  }
  const versionId = stringField(check.versionId)
  const fileId = stringField(check.fileId)
  const reason = stringField(check.reason)
  return {
    checkedAt,
    status,
    ...(versionId ? { versionId } : {}),
    ...(fileId ? { fileId } : {}),
    ...(reason ? { reason } : {}),
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

function normalizeRecord(raw: unknown, sha1: string): InstalledFileRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const paths = Array.isArray(value.paths)
    ? uniquePaths(value.paths.filter((entry): entry is string => typeof entry === 'string'))
    : []
  const provider = providerFrom(value.provider)
  const projectId = stringField(value.projectId)
  const versionId = stringField(value.versionId)
  const fileId = stringField(value.fileId)
  const name = stringField(value.name)
  const versionNumber = stringField(value.versionNumber)
  const source = stringField(value.source)
  const sha512 = stringField(value.sha512)?.toLowerCase()
  const size = numberField(value.size)
  const channel = channelField(value.channel)
  const publishedAt = stringField(value.publishedAt)
  const stat = statField(value.stat)
  const checkedAt = numberField(value.checkedAt)
  const lastCheck = lastCheckField(value.lastCheck)
  return {
    sha1,
    paths,
    ...(sha512 && /^[a-f0-9]{128}$/.test(sha512) ? { sha512 } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(provider ? { provider } : {}),
    ...(projectId ? { projectId } : {}),
    ...(versionId ? { versionId } : {}),
    ...(fileId ? { fileId } : {}),
    ...(name ? { name } : {}),
    ...(versionNumber ? { versionNumber } : {}),
    ...(source ? { source } : {}),
    ...(channel ? { channel } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(stat ? { stat } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(lastCheck ? { lastCheck } : {}),
    installedAt: numberField(value.installedAt) ?? 0,
  }
}

export class ModLedger {
  readonly file: string
  readonly #instanceDir: string
  readonly #logger?: Logger
  readonly #entries = new Map<string, InstalledFileRecord>()
  /** Serialises writers of this ledger file, in and across processes. */
  readonly #locks: FileLock
  #loaded = false
  #writeChain: Promise<void> = Promise.resolve()
  #migration?: LedgerMigration

  constructor(instanceDir: string, logger?: Logger) {
    this.#instanceDir = instanceDir
    this.file = join(instanceDir, MOD_LEDGER_FILE)
    this.#logger = logger
    this.#locks = new FileLock({
      logger,
      busy: (target) =>
        new ModError('ledger-locked', `Ledger is written by another process: ${target}`, {
          target,
        }),
    })
  }

  get migration(): LedgerMigration | undefined {
    return this.#migration
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    await this.#reload()
  }

  /**
   * Re-reads the ledger file, so a writer never saves a snapshot another process
   * has already moved past. The file stays the only truth; this only refreshes
   * the in-memory view of it.
   */
  async #reload(): Promise<void> {
    const raw = await readJsonFile<Partial<LedgerFile>>(this.file, this.#logger)
    if (raw?.version === LEDGER_VERSION && raw.entries && typeof raw.entries === 'object') {
      this.#entries.clear()
      for (const [key, entry] of Object.entries(raw.entries)) {
        const sha1 = normalizeSha1(key)
        const record = sha1 ? normalizeRecord(entry, sha1) : undefined
        if (record) this.#entries.set(sha1 as string, record)
      }
      this.#loaded = true
      return
    }
    // No ledger yet: the first writer adopts the legacy lock/index state, once.
    if (!this.#loaded) await this.#migrate()
    this.#loaded = true
  }

  /**
   * Every mutation runs here: the lock serialises writers inside this process and
   * against other processes, and the reload inside it keeps two commits into one
   * instance from overwriting each other's entry.
   */
  async #mutate<T>(task: () => Promise<T>): Promise<T> {
    return this.#locks.with(this.file, async () => {
      await this.#reload()
      return task()
    })
  }

  async list(): Promise<InstalledFileRecord[]> {
    await this.load()
    return [...this.#entries.values()].sort((a, b) => a.sha1.localeCompare(b.sha1))
  }

  async get(sha1: string): Promise<InstalledFileRecord | undefined> {
    await this.load()
    const key = normalizeSha1(sha1)
    return key ? this.#entries.get(key) : undefined
  }

  async byPath(path: string): Promise<InstalledFileRecord | undefined> {
    await this.load()
    const target = normalizePath(path)?.toLowerCase()
    if (!target) return undefined
    for (const record of this.#entries.values()) {
      if (record.paths.some((entry) => entry.toLowerCase() === target)) return record
    }
    return undefined
  }

  async upsert(record: InstalledFileRecord): Promise<InstalledFileRecord> {
    const sha1 = normalizeSha1(record.sha1)
    if (!sha1) throw new Error(`Invalid SHA-1: ${record.sha1}`)
    return this.#mutate(async () => {
      const existing = this.#entries.get(sha1)
      const merged: InstalledFileRecord = {
        ...(existing ?? {}),
        ...definedOnly(record),
        sha1,
        paths: uniquePaths([...(existing?.paths ?? []), ...record.paths]),
        installedAt: existing?.installedAt || record.installedAt || Date.now(),
      }
      this.#entries.set(sha1, merged)
      await this.save()
      return merged
    })
  }

  async recordChecks(
    checks: Array<{
      sha1: string
      stat: NonNullable<InstalledFileRecord['stat']>
      checkedAt: number
      lastCheck: NonNullable<InstalledFileRecord['lastCheck']>
    }>,
  ): Promise<void> {
    await this.#mutate(async () => {
      let changed = false
      for (const check of checks) {
        const key = normalizeSha1(check.sha1)
        const record = key ? this.#entries.get(key) : undefined
        if (!key || !record) continue
        this.#entries.set(key, {
          ...record,
          stat: check.stat,
          checkedAt: check.checkedAt,
          lastCheck: check.lastCheck,
        })
        changed = true
      }
      if (changed) await this.save()
    })
  }

  async removePath(path: string): Promise<string | undefined> {
    return this.#mutate(async () => {
      const target = normalizePath(path)?.toLowerCase()
      if (!target) return undefined
      for (const [sha1, record] of this.#entries) {
        const remaining = record.paths.filter((entry) => entry.toLowerCase() !== target)
        if (remaining.length === record.paths.length) continue
        if (remaining.length === 0) this.#entries.delete(sha1)
        else this.#entries.set(sha1, { ...record, paths: remaining })
        await this.save()
        return sha1
      }
      return undefined
    })
  }

  save(): Promise<void> {
    const entries = Object.fromEntries(
      [...this.#entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
    )
    const snapshot: LedgerFile = { version: LEDGER_VERSION, updatedAt: Date.now(), entries }
    this.#writeChain = this.#writeChain
      .catch(() => undefined)
      .then(() => writeJsonFile(this.file, snapshot, this.#logger))
    return this.#writeChain
  }

  async #migrate(): Promise<void> {
    const lock = await readModpackLock(this.#instanceDir, this.#logger)
    const index = await readJsonFile<ModIndexFile>(
      join(this.#instanceDir, MOD_INDEX_FILE),
      this.#logger,
    )
    const migration: LedgerMigration = {
      lockFiles: 0,
      lockFilesWithoutSha1: 0,
      indexEntries: 0,
      indexEntriesWithoutPath: 0,
    }
    const pathsByBasename = new Map<string, string[]>()

    for (const file of lock?.files ?? []) {
      const path = normalizePath(file.path)
      const sha1 = normalizeSha1(file.sha1)
      if (!path) continue
      migration.lockFiles += 1
      const names = pathsByBasename.get(basename(path).toLowerCase()) ?? []
      names.push(path)
      pathsByBasename.set(basename(path).toLowerCase(), names)
      if (!sha1) {
        migration.lockFilesWithoutSha1 += 1
        continue
      }
      const existing = this.#entries.get(sha1)
      this.#entries.set(sha1, {
        ...(existing ?? { sha1, paths: [], installedAt: lock?.updatedAt ?? 0 }),
        paths: uniquePaths([...(existing?.paths ?? []), path]),
        ...(file.sha512 ? { sha512: file.sha512.toLowerCase() } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.projectId !== undefined ? { projectId: String(file.projectId) } : {}),
        ...(file.fileId !== undefined ? { fileId: String(file.fileId) } : {}),
        ...(file.fileId !== undefined
          ? { provider: 'curseforge' as const }
          : providerFrom(lock?.upstream.provider)
            ? { provider: providerFrom(lock?.upstream.provider) as ProviderId }
            : {}),
      })
    }

    if (index?.version === MOD_INDEX_VERSION && index.entries && typeof index.entries === 'object') {
      for (const [key, entry] of Object.entries(index.entries)) {
        const sha1 = normalizeSha1(key)
        if (!sha1 || !entry || typeof entry !== 'object') continue
        migration.indexEntries += 1
        const raw = entry as unknown as Record<string, unknown>
        const existing = this.#entries.get(sha1)
        const record: InstalledFileRecord = existing ?? { sha1, paths: [], installedAt: 0 }
        const paths = [...record.paths]
        if (paths.length === 0 && typeof raw.file === 'string') {
          const matches = pathsByBasename.get(raw.file.toLowerCase())
          if (matches?.length === 1) paths.push(matches[0])
        }
        if (paths.length === 0) migration.indexEntriesWithoutPath += 1
        const provider = providerFrom(raw.source)
        this.#entries.set(sha1, {
          ...record,
          paths: uniquePaths(paths),
          installedAt: record.installedAt || (numberField(raw.updatedAt) ?? 0),
          ...(provider ? { provider } : {}),
          ...(stringField(raw.projectId) ? { projectId: stringField(raw.projectId) } : {}),
          ...(stringField(raw.versionId) ? { versionId: stringField(raw.versionId) } : {}),
          ...(stringField(raw.name) ? { name: stringField(raw.name) } : {}),
          ...(stringField(raw.versionNumber)
            ? { versionNumber: stringField(raw.versionNumber) }
            : {}),
          ...(stringField(raw.source) ? { source: stringField(raw.source) } : {}),
        })
      }
    }

    this.#migration = migration
    this.#logger?.info('Legacy mod state migrated into the ledger', { ...migration })
  }
}

