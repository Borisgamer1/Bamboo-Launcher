/**
 * Local mod-pipeline telemetry (roadmap phase 6): request count, cache hits and
 * misses, hashed and downloaded bytes, stage durations and error reasons.
 *
 * Nothing leaves the process — there is no IPC and no file. Every pipeline path
 * books into one process-wide instance by default, so the numbers exist without
 * a consumer having to inject anything: read them with `modsMetricsSnapshot()`.
 * A caller that needs isolated numbers (a test, the bench driver) passes its own
 * `ModMetrics` instead. `requests` counts API calls, so a call's internal retries
 * are not counted separately; `hashBytes` counts bytes actually fed to a hasher,
 * so content hashed twice is counted twice.
 */
import { telemetryErrorCode } from '../telemetry'

export interface ModStageStat {
  count: number
  totalMs: number
  maxMs: number
}

export interface ModMetricsSnapshot {
  requests: number
  cacheHits: number
  cacheMisses: number
  hashBytes: number
  downloadBytes: number
  cacheHitRate: number
  byCode: Record<string, number>
  stages: Record<string, ModStageStat>
}

export interface ModMetricsOptions {
  now?: () => number
}

export class ModMetrics {
  readonly #now: () => number
  #requests = 0
  #cacheHits = 0
  #cacheMisses = 0
  #hashBytes = 0
  #downloadBytes = 0
  #byCode: Record<string, number> = {}
  #stages = new Map<string, ModStageStat>()

  constructor(options: ModMetricsOptions = {}) {
    this.#now = options.now ?? Date.now
  }

  /** One call that actually reached the provider API; a cached answer is not one. */
  request(): void {
    this.#requests += 1
  }

  cacheHit(): void {
    this.#cacheHits += 1
  }

  cacheMiss(): void {
    this.#cacheMisses += 1
  }

  hashBytes(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.#hashBytes += bytes
  }

  downloadBytes(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.#downloadBytes += bytes
  }

  recordError(code: string): void {
    this.#byCode[code] = (this.#byCode[code] ?? 0) + 1
  }

  /** Runs one stage and books its duration and, on failure, the error's reason. */
  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = this.#now()
    try {
      const value = await work()
      this.#book(stage, this.#now() - started)
      return value
    } catch (error) {
      this.#book(stage, this.#now() - started)
      this.recordError(telemetryErrorCode(error))
      throw error
    }
  }

  snapshot(): ModMetricsSnapshot {
    const loads = this.#cacheHits + this.#cacheMisses
    return {
      requests: this.#requests,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      hashBytes: this.#hashBytes,
      downloadBytes: this.#downloadBytes,
      cacheHitRate: loads === 0 ? 0 : this.#cacheHits / loads,
      byCode: { ...this.#byCode },
      stages: Object.fromEntries(
        [...this.#stages].sort(([a], [b]) => a.localeCompare(b)).map(([stage, stat]) => [
          stage,
          { ...stat },
        ]),
      ),
    }
  }

  reset(): void {
    this.#requests = 0
    this.#cacheHits = 0
    this.#cacheMisses = 0
    this.#hashBytes = 0
    this.#downloadBytes = 0
    this.#byCode = {}
    this.#stages = new Map()
  }

  #book(stage: string, durationMs: number): void {
    const bounded = Math.max(0, Math.round(durationMs))
    const stat = this.#stages.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0 }
    stat.count += 1
    stat.totalMs += bounded
    stat.maxMs = Math.max(stat.maxMs, bounded)
    this.#stages.set(stage, stat)
  }
}

/**
 * The instance every pipeline path books into when the caller passes none, so a
 * running launcher produces numbers without any wiring. It is the one owner of
 * those counters; `modsMetricsSnapshot()` reads it without IPC.
 */
export const modsMetrics = new ModMetrics()

export function modsMetricsSnapshot(): ModMetricsSnapshot {
  return modsMetrics.snapshot()
}

export function resetModsMetrics(): void {
  modsMetrics.reset()
}
