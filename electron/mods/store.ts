/**
 * Mod content store (roadmap phase 4): content-addressed objects plus the atomic
 * instance commit.
 *
 * Layout: `<root>/objects/<sha512[:2]>/<sha512>` — the object file is the only
 * truth, so `catalog()` scans it instead of keeping a second copy of the state.
 * `adopt()` brings existing instance files in without a single request, and
 * `materialize()` hands an object back to an instance via reflink → hardlink →
 * copy. `commit()` is the transaction point: the file is placed first and the
 * ledger is written afterwards; if the ledger write fails the placed file is
 * removed again, so an instance never holds content the ledger does not know.
 *
 * This store is SHA-512 keyed and owns dedupe, GC and migration. The older
 * `instances/content-store.ts` stays what it always was — a SHA-1 keyed helper
 * that links an instance file to the game root — and both share the placement
 * policy in `electron/link.ts`.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashFileDual, type DualHash } from '../download/checksum'
import { FileLock } from '../file-lock'
import { copyInto, linkInto, linkOrCopy, replaceFile, type DirectPlacement } from '../link'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { ModError } from './errors'
import type { ModLedger } from './ledger'
import { modsMetrics, type ModMetrics } from './metrics'
import { resolveFileInside, resolveInside } from './paths'
import { modsRollback } from './rollback'
import type { InstalledFileRecord } from './types'

export const STORE_DIRECTORY = 'objects'
const SHA1_PATTERN = /^[a-f0-9]{40}$/
const SHA512_PATTERN = /^[a-f0-9]{128}$/
const CONTENT_FILE_PATTERN = /\.(jar|zip)$/i

export interface StoreObject {
  sha512: string
  size: number
  path: string
}

export type MaterializeMode = 'reflink' | 'hardlink' | 'copy'

export interface ModContentStoreOptions {
  root: string
  logger?: Logger
  /** How long to wait for another process' object lock. */
  lockTimeoutMs?: number
  /** A lock file older than this is treated as abandoned. */
  staleLockMs?: number
  sleep?: (ms: number) => Promise<void>
  metrics?: ModMetrics
  /** Defaults to the `BAMBOO_MODS_STORE` switch; copy avoids sharing inodes. */
  copyOnly?: boolean
}

export interface AdoptResult extends DualHash {
  path: string
  created: boolean
  /** How new content entered the store; absent when it was already stored. */
  link?: DirectPlacement
}

export interface CommitObjectOptions {
  instanceDir: string
  folder: string
  filename: string
  sha512: string
  sha1: string
  size?: number
  ledger?: ModLedger
  /** Provider metadata for the ledger record (projectId, versionId, channel, …). */
  record?: Partial<InstalledFileRecord>
  logger?: Logger
}

export interface CommitObjectResult {
  path: string
  sha1: string
  sha512: string
  size: number
  link: MaterializeMode
  recorded: boolean
}

export interface MigrateStoreOptions {
  instanceDir: string
  directories?: string[]
  ledger?: ModLedger
  signal?: AbortSignal
  logger?: Logger
}

export interface MigrateStoreResult {
  scanned: number
  adopted: number
  deduped: number
  recorded: number
  objects: number
  bytes: number
}

export interface GcResult {
  removed: number
  bytes: number
}

function normalizeHash(value: string, pattern: RegExp, label: string): string {
  const hash = value.trim().toLowerCase()
  if (!pattern.test(hash)) {
    throw new ModError('content-changed', `Invalid ${label}: ${value}`)
  }
  return hash
}

export class ModContentStore {
  readonly root: string
  readonly #logger?: Logger
  readonly #metrics?: ModMetrics
  readonly #copyOnly: boolean
  /** One object, one lock: in-process FIFO plus the lock file for other processes. */
  readonly #locks: FileLock

  constructor(options: ModContentStoreOptions) {
    this.root = options.root
    this.#logger = options.logger
    this.#metrics = options.metrics ?? modsMetrics
    this.#copyOnly = options.copyOnly ?? modsRollback().store
    this.#locks = new FileLock({
      logger: options.logger,
      busy: (target) =>
        new ModError('store-locked', `Content store object is locked: ${target}`, { target }),
      ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}),
      ...(options.staleLockMs !== undefined ? { staleMs: options.staleLockMs } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    })
  }

  objectPath(sha512: string): string {
    const hash = normalizeHash(sha512, SHA512_PATTERN, 'sha512')
    return join(this.root, STORE_DIRECTORY, hash.slice(0, 2), hash)
  }

  async has(sha512: string): Promise<boolean> {
    try {
      return (await stat(this.objectPath(sha512))).isFile()
    } catch (error) {
      const log = this.#logger ?? getDefaultLogger().child('mods:store')
      log.debug('content store: object is absent or unreadable', {
        sha512,
        error: describeError(error),
      })
      return false
    }
  }

  /** Scanned view of every stored object; the files themselves are the state. */
  async catalog(): Promise<StoreObject[]> {
    const directory = join(this.root, STORE_DIRECTORY)
    const shards = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const objects: StoreObject[] = []
    for (const shard of shards) {
      if (!shard.isDirectory()) continue
      const entries = await readdir(join(directory, shard.name), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !SHA512_PATTERN.test(entry.name)) continue
        const path = join(directory, shard.name, entry.name)
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile()) objects.push({ sha512: entry.name, size: info.size, path })
      }
    }
    return objects.sort((a, b) => a.sha512.localeCompare(b.sha512))
  }

  /**
   * Brings an existing file into the store without downloading anything: the
   * content is hashed once and hardlinked (or copied) in. Content that is already
   * stored is left alone, which is what makes two instances share one object.
   */
  async adopt(source: string, expected: Partial<DualHash> = {}): Promise<AdoptResult> {
    const info = await stat(source).catch(() => undefined)
    if (!info?.isFile()) throw new ModError('content-changed', `Not a readable file: ${source}`)
    const hash = await hashFileDual(source)
    this.#metrics?.hashBytes(hash.bytes)
    if (expected.bytes !== undefined && expected.bytes !== hash.bytes) {
      throw new ModError('content-changed', `Size mismatch for ${source}`, { source })
    }
    if (expected.sha1 && expected.sha1.toLowerCase() !== hash.sha1) {
      throw new ModError('content-changed', `SHA-1 mismatch for ${source}`, { source })
    }
    if (expected.sha512 && expected.sha512.toLowerCase() !== hash.sha512) {
      throw new ModError('content-changed', `SHA-512 mismatch for ${source}`, { source })
    }

    const target = this.objectPath(hash.sha512)
    return this.#withLock(hash.sha512, async () => {
      if (await this.has(hash.sha512)) {
        return { ...hash, path: target, created: false }
      }
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.bamboo-${randomBytes(6).toString('hex')}.part`
      let mode: DirectPlacement
      try {
        mode = this.#copyOnly ? await copyInto(source, temp) : await linkOrCopy(source, temp)
        await replaceFile(temp, target)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
      this.#logger?.info('Content stored', { sha512: hash.sha512, bytes: hash.bytes, mode })
      return { ...hash, path: target, created: true, link: mode }
    })
  }

  /** Places a stored object into an instance: reflink, then hardlink, then copy. */
  async materialize(sha512: string, destination: string): Promise<MaterializeMode> {
    const hash = normalizeHash(sha512, SHA512_PATTERN, 'sha512')
    const source = this.objectPath(hash)
    // The look-up belongs inside the lock: GC deletes under the same lock, so a
    // check before it could pass and still lose the object to the link call.
    return this.#withLock(hash, async () => {
      if (!(await this.has(hash))) {
        throw new ModError('store-missing', `Content store has no object ${hash}`, { sha512: hash })
      }
      await mkdir(dirname(destination), { recursive: true })
      const temp = `${destination}.bamboo-${randomBytes(6).toString('hex')}.part`
      try {
        const mode = this.#copyOnly ? await copyInto(source, temp) : await linkInto(source, temp)
        await replaceFile(temp, destination)
        return mode
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        // The object can only vanish under us between lock and link; report it in
        // the store's own error class instead of leaking a raw ENOENT.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ModError('store-missing', `Content store has no object ${hash}`, {
            sha512: hash,
          })
        }
        throw error
      }
    })
  }

  /**
   * The commit point: materialize the object, then write the ledger. A failing
   * ledger write removes the placed file again, so a crash or a rejection can
   * never leave content that the ledger does not list.
   */
  async commit(options: CommitObjectOptions): Promise<CommitObjectResult> {
    const sha1 = normalizeHash(options.sha1, SHA1_PATTERN, 'sha1')
    const sha512 = normalizeHash(options.sha512, SHA512_PATTERN, 'sha512')
    const objectInfo = await stat(this.objectPath(sha512)).catch(() => undefined)
    if (!objectInfo?.isFile()) {
      throw new ModError('store-missing', `Content store has no object ${sha512}`, { sha512 })
    }
    if (options.size !== undefined && options.size !== objectInfo.size) {
      throw new ModError('content-changed', `Stored object size ${objectInfo.size} != ${options.size}`, {
        sha512,
      })
    }

    const destination = resolveFileInside(options.instanceDir, options.folder, options.filename)
    const link = await this.materialize(sha512, destination)
    const placed = await stat(destination)
    const path = `${options.folder}/${options.filename}`
    const result: CommitObjectResult = {
      path,
      sha1,
      sha512,
      size: placed.size,
      link,
      recorded: false,
    }
    if (!options.ledger) return result

    try {
      await options.ledger.upsert({
        ...options.record,
        sha1,
        sha512,
        size: placed.size,
        paths: [path],
        stat: { size: placed.size, mtimeMs: placed.mtimeMs },
        installedAt: options.record?.installedAt ?? Date.now(),
      })
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined)
      options.logger?.warn('Commit rolled back: the ledger could not be written', {
        path,
        error: (error as Error).message,
      })
      throw error
    }
    return { ...result, recorded: true }
  }

  /**
   * Migration: adopt the instance's existing files into the store and record
   * them, with no network access and no re-download.
   */
  async migrateInstance(options: MigrateStoreOptions): Promise<MigrateStoreResult> {
    const directories = options.directories ?? ['mods']
    const result: MigrateStoreResult = {
      scanned: 0,
      adopted: 0,
      deduped: 0,
      recorded: 0,
      objects: 0,
      bytes: 0,
    }
    for (const directory of directories) {
      const absolute = resolveInside(options.instanceDir, directory)
      const entries = await readdir(absolute, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (options.signal?.aborted) throw new ModError('aborted', 'Migration aborted')
        if (!entry.isFile() || !CONTENT_FILE_PATTERN.test(entry.name)) continue
        const path = `${directory}/${entry.name}`
        const file = resolveInside(options.instanceDir, path)
        result.scanned += 1
        const adopted = await this.adopt(file)
        if (adopted.created) result.adopted += 1
        else result.deduped += 1
        if (!options.ledger) continue
        const known = await options.ledger.get(adopted.sha1)
        const info = await stat(file)
        await options.ledger.upsert({
          sha1: adopted.sha1,
          sha512: adopted.sha512,
          size: adopted.bytes,
          paths: [path],
          stat: { size: info.size, mtimeMs: info.mtimeMs },
          installedAt: known?.installedAt ?? info.mtimeMs ?? Date.now(),
        })
        result.recorded += 1
      }
    }
    const objects = await this.catalog()
    result.objects = objects.length
    result.bytes = objects.reduce((total, object) => total + object.size, 0)
    return result
  }

  /** Removes every object that is not in `keep` (the callers' ledger contents). */
  async gc(keep: Iterable<string>): Promise<GcResult> {
    const retained = new Set([...keep].map((hash) => hash.trim().toLowerCase()))
    const result: GcResult = { removed: 0, bytes: 0 }
    for (const object of await this.catalog()) {
      if (retained.has(object.sha512)) continue
      const shard = await this.#withLock(object.sha512, async () => {
        const info = await stat(object.path).catch(() => undefined)
        if (!info?.isFile()) return undefined
        await rm(object.path, { force: true })
        result.removed += 1
        result.bytes += info.size
        return dirname(object.path)
      })
      // Only once the lock file is gone can the shard directory look empty.
      if (shard) await rmdirIfEmpty(shard)
    }
    return result
  }

  #withLock<T>(sha512: string, task: () => Promise<T>): Promise<T> {
    return this.#locks.with(this.objectPath(sha512), task)
  }
}

async function rmdirIfEmpty(directory: string): Promise<void> {
  const remaining = await readdir(directory).catch(() => [])
  if (remaining.length === 0) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}
