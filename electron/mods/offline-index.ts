import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import type { Logger } from '../logger'
import { describeError, getDefaultLogger } from '../logger'
import { readModMetadataList } from './metadata'
import type { ParsedMod } from './types'

export const MOD_INDEX_VERSION = 1

export const MOD_INDEX_FILE = 'mods.index.json'

export interface ModIndexEntry {
  sha1: string
  projectId?: string
  slug?: string
  name?: string
  versionId?: string
  versionNumber?: string
  modId?: string
  file?: string
  source?: string
  updatedAt: number
}

export interface ModIndexFile {
  version: 1
  entries: Record<string, ModIndexEntry>
}

export interface RecordModOptions {
  projectId?: string
  slug?: string
  name?: string
  versionId?: string
  versionNumber?: string
  modId?: string
  file?: string
  source?: string
}

function normalizeSha1(value: string): string {
  return value.trim().toLowerCase()
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex')
}

export class OfflineModIndex {
  readonly file: string
  readonly #logger?: Logger
  readonly #entries = new Map<string, ModIndexEntry>()
  #loaded = false
  #writeChain: Promise<void> = Promise.resolve()

  constructor(file: string, logger?: Logger) {
    this.file = file
    this.#logger = logger
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    const raw = await readJsonFile<ModIndexFile>(this.file, this.#logger)
    if (raw && raw.version === MOD_INDEX_VERSION && raw.entries && typeof raw.entries === 'object') {
      for (const [sha1, entry] of Object.entries(raw.entries)) {
        if (!entry || typeof entry !== 'object') continue
        const key = normalizeSha1(sha1)
        if (!/^[a-f0-9]{40}$/.test(key)) continue
        this.#entries.set(key, { ...entry, sha1: key, updatedAt: entry.updatedAt ?? 0 })
      }
    }
    this.#loaded = true
  }

  get size(): number {
    return this.#entries.size
  }

  async lookup(sha1: string): Promise<ModIndexEntry | undefined> {
    await this.load()
    return this.#entries.get(normalizeSha1(sha1))
  }

  async lookupFile(file: string): Promise<ModIndexEntry | undefined> {
    try {
      return await this.lookup(hashBuffer(await readFile(file)))
    } catch (error) {
      const log = this.#logger ?? getDefaultLogger().child('mods:index')
      log.debug('offline index: file could not be hashed', {
        file,
        error: describeError(error),
      })
      return undefined
    }
  }

  async list(): Promise<ModIndexEntry[]> {
    await this.load()
    return [...this.#entries.values()].sort((a, b) => a.sha1.localeCompare(b.sha1))
  }

  async forget(sha1: string): Promise<void> {
    await this.load()
    if (this.#entries.delete(normalizeSha1(sha1))) await this.save()
  }

  async forgetFile(fileName: string): Promise<number> {
    await this.load()
    const target = fileName.toLowerCase()
    let removed = 0
    for (const [sha1, entry] of this.#entries) {
      if (entry.file?.toLowerCase() !== target) continue
      this.#entries.delete(sha1)
      removed += 1
    }
    if (removed > 0) await this.save()
    return removed
  }

  async record(sha1: string, options: RecordModOptions): Promise<ModIndexEntry> {
    await this.load()
    const key = normalizeSha1(sha1)
    if (!/^[a-f0-9]{40}$/.test(key)) throw new Error(`Invalid SHA-1: ${sha1}`)
    const previous = this.#entries.get(key)
    const entry: ModIndexEntry = {
      sha1: key,
      ...(options.projectId ?? previous?.projectId
        ? { projectId: options.projectId ?? previous?.projectId }
        : {}),
      ...(options.slug ?? previous?.slug ? { slug: options.slug ?? previous?.slug } : {}),
      ...(options.name ?? previous?.name ? { name: options.name ?? previous?.name } : {}),
      ...(options.versionId ?? previous?.versionId
        ? { versionId: options.versionId ?? previous?.versionId }
        : {}),
      ...(options.versionNumber ?? previous?.versionNumber
        ? { versionNumber: options.versionNumber ?? previous?.versionNumber }
        : {}),
      ...(options.modId ?? previous?.modId ? { modId: options.modId ?? previous?.modId } : {}),
      ...(options.file ?? previous?.file ? { file: options.file ?? previous?.file } : {}),
      ...(options.source ?? previous?.source ? { source: options.source ?? previous?.source } : {}),
      updatedAt: Date.now(),
    }
    this.#entries.set(key, entry)
    await this.save()
    return entry
  }

  async recordFile(file: string, options: RecordModOptions): Promise<ModIndexEntry> {
    const buffer = await readFile(file)
    return this.record(hashBuffer(buffer), { ...options, file: basename(file) })
  }

  async recordParsed(file: string, mods: ParsedMod[]): Promise<ModIndexEntry[]> {
    const primary = mods[0]
    const buffer = await readFile(file)
    const entry = await this.record(hashBuffer(buffer), {
      ...(primary ? { modId: primary.id, name: primary.name, versionNumber: primary.version } : {}),
      source: 'local-jar',
    })
    return [entry]
  }

  async scanDirectory(modsDir: string): Promise<ModIndexEntry[]> {
    await this.load()
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => [])
    const result: ModIndexEntry[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
      const file = join(modsDir, entry.name)
      const buffer = await readFile(file).catch(() => undefined)
      if (!buffer) continue
      const key = hashBuffer(buffer)
      const existing = this.#entries.get(key)
      if (existing) {
        result.push(existing)
        continue
      }
      const parsed = await readModMetadataList(file).catch(() => [])
      const primary = parsed[0]
      const recorded = await this.record(key, {
        ...(primary ? { modId: primary.id, name: primary.name, versionNumber: primary.version } : {}),
        source: 'local-jar',
      })
      result.push(recorded)
    }
    return result
  }

  save(): Promise<void> {
    const snapshot: ModIndexFile = {
      version: MOD_INDEX_VERSION,
      entries: Object.fromEntries(this.#entries),
    }
    this.#writeChain = this.#writeChain
      .catch(() => undefined)
      .then(() => writeJsonFile(this.file, snapshot, this.#logger))
    return this.#writeChain
  }
}
