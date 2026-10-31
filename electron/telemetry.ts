import { rm } from 'node:fs/promises'
import { readJsonFile, writeJsonFile } from './atomic'
import type { Logger } from './logger'

export const TELEMETRY_PHASES = [
  'download',
  'install',
  'loader',
  'launch',
  'modpack',
  'support',
] as const

export type TelemetryPhase = (typeof TELEMETRY_PHASES)[number]

export interface TelemetryJvmBucket {
  attempts: number
  successes: number
  failures: number
  heapMb: number
  downgrades: string[]
}

export interface TelemetryBucket {
  attempts: number
  successes: number
  failures: number
  durationMs: number
  byCode: Record<string, number>
  jvm?: Record<string, TelemetryJvmBucket>
}

export interface TelemetrySnapshot {
  enabled: boolean
  since: number
  updatedAt: number
  phases: Partial<Record<TelemetryPhase, TelemetryBucket & { successRate: number }>>
}

interface TelemetryFile {
  version: 1
  enabled: boolean
  since: number
  updatedAt: number
  phases: Partial<Record<TelemetryPhase, TelemetryBucket>>
}

export interface TelemetryOptions {
  enabled?: boolean
  logger?: Logger
  now?: () => number
}

export interface TelemetryRecord {
  ok: boolean
  code?: string
  durationMs?: number
  presetId?: string
  heapMb?: number
  downgrades?: readonly string[]
}

const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

export function withoutTelemetry<T extends { telemetry?: TelemetryService }>(options: T): T {
  if (!('telemetry' in options)) return options
  const nested = { ...options }
  delete nested.telemetry
  return nested
}

export function telemetryErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const raw = (error as { code?: unknown }).code
  if (typeof raw === 'string' && CODE_PATTERN.test(raw)) return raw
  const name = (error as { name?: unknown }).name
  if (typeof name === 'string' && CODE_PATTERN.test(name) && name !== 'Error') return name
  return 'unknown'
}

function emptyBucket(): TelemetryBucket {
  return { attempts: 0, successes: 0, failures: 0, durationMs: 0, byCode: {} }
}

function isJvmBucket(value: unknown): value is TelemetryJvmBucket {
  if (!value || typeof value !== 'object') return false
  const bucket = value as TelemetryJvmBucket
  return (
    typeof bucket.attempts === 'number' &&
    typeof bucket.successes === 'number' &&
    typeof bucket.failures === 'number' &&
    typeof bucket.heapMb === 'number' &&
    Array.isArray(bucket.downgrades)
  )
}

function isBucket(value: unknown): value is TelemetryBucket {
  if (!value || typeof value !== 'object') return false
  const bucket = value as TelemetryBucket
  const base =
    typeof bucket.attempts === 'number' &&
    typeof bucket.successes === 'number' &&
    typeof bucket.failures === 'number' &&
    typeof bucket.durationMs === 'number' &&
    Boolean(bucket.byCode) &&
    typeof bucket.byCode === 'object'
  if (!base) return false
  if (bucket.jvm === undefined) return true
  if (!bucket.jvm || typeof bucket.jvm !== 'object') return false
  return Object.values(bucket.jvm).every(isJvmBucket)
}

function phaseAllowed(phase: string): phase is TelemetryPhase {
  return (TELEMETRY_PHASES as readonly string[]).includes(phase)
}

function sanitizeCode(code: string | undefined): string {
  return code && CODE_PATTERN.test(code) ? code : 'unknown'
}

export class TelemetryService {
  readonly file: string
  readonly #logger?: Logger
  readonly #now: () => number
  #enabled: boolean
  #loaded = false
  #since = 0
  #updatedAt = 0
  #phases: Partial<Record<TelemetryPhase, TelemetryBucket>> = {}
  #writeChain: Promise<void> = Promise.resolve()

  constructor(file: string, options: TelemetryOptions = {}) {
    this.file = file
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
    this.#enabled = options.enabled === true
  }

  get enabled(): boolean {
    return this.#enabled
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (!this.#enabled) return
    const raw = await readJsonFile<TelemetryFile>(this.file, this.#logger)
    if (!raw || raw.version !== 1 || raw.enabled !== true) return
    this.#since = typeof raw.since === 'number' ? raw.since : this.#now()
    this.#updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : this.#since
    if (raw.phases && typeof raw.phases === 'object') {
      for (const [phase, bucket] of Object.entries(raw.phases)) {
        if (phaseAllowed(phase) && isBucket(bucket)) this.#phases[phase] = bucket
      }
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.#enabled) {
      if (!enabled) await this.#removeFile()
      return
    }
    this.#enabled = enabled
    if (!enabled) {
      this.#phases = {}
      this.#since = 0
      this.#updatedAt = 0
      await this.#removeFile()
      return
    }
    this.#loaded = true
    this.#since = this.#now()
    this.#updatedAt = this.#since
    await this.save()
  }

  record(phase: TelemetryPhase, record: TelemetryRecord): void {
    if (!this.#enabled || !phaseAllowed(phase)) return
    const bucket = this.#phases[phase] ?? emptyBucket()
    bucket.attempts += 1
    if (record.ok) bucket.successes += 1
    else bucket.failures += 1
    if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      bucket.durationMs += Math.round(record.durationMs)
    }
    if (!record.ok) {
      const code = sanitizeCode(record.code)
      bucket.byCode[code] = (bucket.byCode[code] ?? 0) + 1
    }
    if (record.presetId && CODE_PATTERN.test(record.presetId)) {
      const jvm = bucket.jvm ?? (bucket.jvm = {})
      const sample =
        jvm[record.presetId] ??
        (jvm[record.presetId] = { attempts: 0, successes: 0, failures: 0, heapMb: 0, downgrades: [] })
      sample.attempts += 1
      if (record.ok) sample.successes += 1
      else sample.failures += 1
      if (
        typeof record.heapMb === 'number' &&
        Number.isFinite(record.heapMb) &&
        record.heapMb >= 0
      ) {
        sample.heapMb = Math.round(record.heapMb)
      }
      if (Array.isArray(record.downgrades)) {
        const codes = record.downgrades.filter(
          (code): code is string => typeof code === 'string' && CODE_PATTERN.test(code),
        )
        sample.downgrades = [...new Set([...sample.downgrades, ...codes])].sort()
      }
    }
    this.#phases[phase] = bucket
    this.#updatedAt = this.#now()
    if (this.#since === 0) this.#since = this.#updatedAt
    void this.save()
  }

  async measure<T>(phase: TelemetryPhase, operation: () => Promise<T>): Promise<T> {
    const started = this.#now()
    try {
      const value = await operation()
      this.record(phase, { ok: true, durationMs: this.#now() - started })
      return value
    } catch (error) {
      this.record(phase, {
        ok: false,
        code: telemetryErrorCode(error),
        durationMs: this.#now() - started,
      })
      throw error
    }
  }

  async snapshot(): Promise<TelemetrySnapshot> {
    await this.load()
    if (!this.#enabled) {
      return { enabled: false, since: 0, updatedAt: 0, phases: {} }
    }
    const phases: TelemetrySnapshot['phases'] = {}
    for (const phase of TELEMETRY_PHASES) {
      const bucket = this.#phases[phase]
      if (!bucket) continue
      phases[phase] = {
        ...bucket,
        byCode: { ...bucket.byCode },
        ...(bucket.jvm
          ? {
              jvm: Object.fromEntries(
                Object.entries(bucket.jvm).map(([presetId, sample]) => [
                  presetId,
                  { ...sample, downgrades: [...sample.downgrades] },
                ]),
              ),
            }
          : {}),
        successRate: bucket.attempts === 0 ? 0 : bucket.successes / bucket.attempts,
      }
    }
    return { enabled: true, since: this.#since, updatedAt: this.#updatedAt, phases }
  }

  save(): Promise<void> {
    if (!this.#enabled) return Promise.resolve()
    const snapshot: TelemetryFile = {
      version: 1,
      enabled: true,
      since: this.#since || this.#now(),
      updatedAt: this.#updatedAt || this.#now(),
      phases: Object.fromEntries(
        Object.entries(this.#phases).map(([phase, bucket]) => [
          phase,
          {
            ...bucket,
            byCode: { ...bucket.byCode },
            ...(bucket.jvm
              ? {
                  jvm: Object.fromEntries(
                    Object.entries(bucket.jvm).map(([presetId, sample]) => [
                      presetId,
                      { ...sample, downgrades: [...sample.downgrades] },
                    ]),
                  ),
                }
              : {}),
          },
        ]),
      ),
    }
    this.#writeChain = this.#writeChain
      .catch(() => undefined)
      .then(() => writeJsonFile(this.file, snapshot, this.#logger))
      .catch((error: Error) => {
        this.#logger?.debug('Telemetry write failed', { error: error.message })
      })
    return this.#writeChain
  }

  async #removeFile(): Promise<void> {
    await rm(this.file, { force: true }).catch((error: Error) => {
      this.#logger?.debug('Telemetry cleanup failed', { error: error.message })
    })
  }
}
