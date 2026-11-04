import { readJsonFile, writeJsonFile } from './atomic'
import type { DistanceStats } from './instances/worlds'
import { describeError, type Logger } from './logger'

/**
 * Global playtime statistics live in appData, not in an instance folder, so
 * deleting an instance never removes the time already played in it. The ledger
 * is append-only per launch; totals are derived from the sessions on load so a
 * hand-edited or partially written file cannot leave stale totals behind.
 */

export interface StatisticsSession {
  id: string
  instanceId: string
  instanceName: string
  version: string
  loader: string
  loaderVersion: string
  startedAt: number
  endedAt: number
  durationMs: number
}

export interface StatisticsTotals {
  playTimeMs: number
  sessions: number
  firstPlayedAt: number
  lastPlayedAt: number
}

export interface StatisticsLedger {
  version: 1
  totals: StatisticsTotals
  sessions: StatisticsSession[]
}

/** World values for one existing instance; playtime comes from the ledger. */
export interface StatisticsInstanceSummary {
  id: string
  name: string
  version: string
  loader: string
  playTimeMs: number
  sessions: number
  worlds: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
}

/** One central aggregate used by the Statistics settings tab. */
export interface StatisticsSummary {
  enabled: boolean
  playTimeMs: number
  sessions: number
  firstPlayedAt: number
  lastPlayedAt: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
  instances: number
  worlds: number
  perInstance: StatisticsInstanceSummary[]
  generatedAt: number
}

export function emptyStatistics(): StatisticsLedger {
  return {
    version: 1,
    totals: { playTimeMs: 0, sessions: 0, firstPlayedAt: 0, lastPlayedAt: 0 },
    sessions: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function normalizeSession(value: unknown): StatisticsSession | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id)
  const startedAt = timestamp(value.startedAt)
  if (!id || startedAt === 0) return undefined
  const durationMs = Math.max(0, Math.round(Number(value.durationMs) || 0))
  const endedAt = timestamp(value.endedAt) || startedAt + durationMs
  return {
    id,
    instanceId: text(value.instanceId),
    instanceName: text(value.instanceName),
    version: text(value.version),
    loader: text(value.loader),
    loaderVersion: text(value.loaderVersion),
    startedAt,
    endedAt,
    durationMs,
  }
}

function deriveTotals(sessions: StatisticsSession[]): StatisticsTotals {
  let playTimeMs = 0
  let firstPlayedAt = 0
  let lastPlayedAt = 0
  for (const session of sessions) {
    playTimeMs += session.durationMs
    if (firstPlayedAt === 0 || session.startedAt < firstPlayedAt) firstPlayedAt = session.startedAt
    if (session.endedAt > lastPlayedAt) lastPlayedAt = session.endedAt
  }
  return { playTimeMs, sessions: sessions.length, firstPlayedAt, lastPlayedAt }
}

function normalizeLedger(raw: unknown): StatisticsLedger {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) return emptyStatistics()
  const seen = new Set<string>()
  const sessions: StatisticsSession[] = []
  for (const entry of raw.sessions) {
    const session = normalizeSession(entry)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt)
  return { version: 1, totals: deriveTotals(sessions), sessions }
}

export class StatisticsStore {
  readonly #file: string
  readonly #logger: Logger
  #data: StatisticsLedger | undefined
  #loading: Promise<StatisticsLedger> | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(file: string, logger: Logger) {
    this.#file = file
    this.#logger = logger
  }

  async load(): Promise<StatisticsLedger> {
    if (!this.#loading) this.#loading = this.#load()
    return this.#loading
  }

  async #load(): Promise<StatisticsLedger> {
    const raw = await readJsonFile<unknown>(this.#file, this.#logger)
    this.#data = normalizeLedger(raw)
    return this.#data
  }

  async snapshot(): Promise<StatisticsLedger> {
    await this.#queue
    const data = await this.load()
    return JSON.parse(JSON.stringify(data)) as StatisticsLedger
  }

  async record(session: StatisticsSession): Promise<void> {
    const run = async () => {
      const data = await this.load()
      if (data.sessions.some((entry) => entry.id === session.id)) return
      data.sessions.push(session)
      data.totals = deriveTotals(data.sessions)
      await writeJsonFile(this.#file, data, this.#logger)
      this.#logger.info('Statistics session recorded', {
        sessionId: session.id,
        instanceId: session.instanceId,
        durationMs: session.durationMs,
        totalPlayTimeMs: data.totals.playTimeMs,
        sessions: data.totals.sessions,
      })
    }
    const task = this.#queue.then(run, run)
    this.#queue = task.catch((error) => {
      this.#logger.warn('Statistics ledger could not be written', {
        file: this.#file,
        error: describeError(error),
      })
    })
    return task
  }

  async flush(): Promise<void> {
    await this.#queue
  }
}

export class StatisticsService {
  readonly #store: StatisticsStore
  readonly #logger: Logger
  #enabled: boolean

  constructor(store: StatisticsStore, enabled: boolean, logger: Logger) {
    this.#store = store
    this.#logger = logger
    this.#enabled = enabled
  }

  get enabled(): boolean {
    return this.#enabled
  }

  async load(): Promise<void> {
    await this.#store.load()
  }

  /** The UI save path calls this synchronously, so the next session end sees it. */
  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return
    this.#enabled = enabled
    this.#logger.info('Statistics tracking changed', { enabled })
  }

  async record(session: StatisticsSession): Promise<boolean> {
    if (!this.#enabled) return false
    await this.#store.record(session)
    return true
  }

  async flush(): Promise<void> {
    await this.#store.flush()
  }

  async snapshot(): Promise<StatisticsLedger> {
    return this.#store.snapshot()
  }
}
