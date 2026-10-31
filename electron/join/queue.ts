import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import type { Logger } from '../logger'
import { validateJoinPayload } from './grammar'
import type { JoinPayload, JoinQueueEntry, JoinQueueFile, JoinQueueRead } from './types'

export const PENDING_JOIN_FILE = 'pending-join.json'
export const PENDING_JOIN_VERSION = 1
export const MAX_PENDING_JOINS = 5
export const PENDING_JOIN_TTL_MS = 24 * 60 * 60 * 1000

export interface JoinQueueOptions {
  file: string
  logger?: Logger
  now?: () => number
  maxEntries?: number
  ttlMs?: number
}

export interface JoinQueueFlush extends JoinQueueRead {
  rejected?: 'join.rejected-grammar'
}

export function joinTarget(payload: JoinPayload): string {
  return `${payload.host}:${payload.port}:${payload.profile ?? ''}`
}

function entryTime(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = (raw as { receivedAt?: unknown }).receivedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class JoinQueue {
  readonly file: string
  readonly #logger?: Logger
  readonly #now: () => number
  readonly #maxEntries: number
  readonly #ttlMs: number

  constructor(options: JoinQueueOptions) {
    this.file = options.file
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
    this.#maxEntries = Math.max(1, options.maxEntries ?? MAX_PENDING_JOINS)
    this.#ttlMs = Math.max(0, options.ttlMs ?? PENDING_JOIN_TTL_MS)
  }

  static at(appDataPath: string, options: Omit<JoinQueueOptions, 'file'> = {}): JoinQueue {
    return new JoinQueue({ ...options, file: join(appDataPath, PENDING_JOIN_FILE) })
  }

  async read(): Promise<JoinQueueRead> {
    const raw = await readJsonFile<Record<string, unknown>>(this.file, this.#logger)
    if (!raw) return { entries: [], superseded: false }
    if (raw.version !== PENDING_JOIN_VERSION) {
      return { entries: [], superseded: true }
    }
    const entries: JoinQueueEntry[] = []
    if (Array.isArray(raw.entries)) {
      for (const value of raw.entries) {
        const receivedAt = entryTime(value)
        const payload = value && typeof value === 'object'
          ? validateJoinPayload((value as { payload?: unknown }).payload)
          : undefined
        if (receivedAt === undefined || !payload?.ok) continue
        entries.push({ payload: payload.payload, receivedAt })
      }
    }
    return { entries, superseded: false }
  }

  async enqueue(payload: JoinPayload, receivedAt = this.#now()): Promise<void> {
    const current = await this.read()
    if (current.superseded) {
      this.#logger?.warn('Discarding superseded pending-join queue', {
        version: PENDING_JOIN_VERSION,
        file: this.file,
      })
    }
    const fresh = (current.superseded ? [] : current.entries)
      .filter((entry) => this.#alive(entry))
      .filter((entry) => joinTarget(entry.payload) !== joinTarget(payload))
    fresh.push({ payload, receivedAt })
    fresh.sort((left, right) => left.receivedAt - right.receivedAt)
    if (fresh.length > this.#maxEntries) fresh.splice(0, fresh.length - this.#maxEntries)
    await this.#write(fresh)
  }

  async flush(): Promise<JoinQueueFlush> {
    const current = await this.read()
    if (current.superseded) {
      await this.#write([])
      this.#logger?.warn('Discarded pending-join queue with a superseded version', {
        version: PENDING_JOIN_VERSION,
        file: this.file,
      })
      return { entries: [], superseded: true, rejected: 'join.rejected-grammar' }
    }

    const fresh = current.entries.filter((entry) => this.#alive(entry))
    const newest = new Map<string, JoinQueueEntry>()
    for (const entry of fresh.sort((left, right) => left.receivedAt - right.receivedAt)) {
      newest.set(joinTarget(entry.payload), entry)
    }
    const entries = [...newest.values()]
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .slice(-this.#maxEntries)
    await this.#write([])
    return { entries, superseded: false }
  }

  async clear(): Promise<void> {
    await this.#write([])
  }

  #alive(entry: JoinQueueEntry): boolean {
    return entry.receivedAt + this.#ttlMs > this.#now()
  }

  async #write(entries: JoinQueueEntry[]): Promise<void> {
    const file: JoinQueueFile = {
      version: PENDING_JOIN_VERSION,
      entries: entries.slice(-this.#maxEntries),
    }
    await writeJsonFile(this.file, file, this.#logger)
  }
}
