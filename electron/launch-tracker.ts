import { describeError, type Logger } from './logger'
import type { TelemetryService } from './telemetry'

export interface LaunchJvmInfo {
  presetId: string
  heapMb: number
  downgrades: string[]
}

export interface LaunchStartInfo {
  version: string
  loader?: string
  loaderVersion?: string
  instancePath: string
  instanceId?: string
  instanceName?: string
  javaPath: string
  account?: string
  gameRoot?: string
  jvm?: LaunchJvmInfo
}

export interface LaunchOutcome {
  exitCode?: number | null
  error?: string
}

export interface LaunchHandle {
  readonly launchId: string
  finish(outcome?: LaunchOutcome): void
}

/** A finished launch that can be written to the global statistics ledger. */
export interface LaunchSession {
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

export type LaunchSessionListener = (session: LaunchSession) => void | Promise<void>

export class LaunchTracker {
  #logger: Logger
  #telemetry?: TelemetryService
  #onSession?: LaunchSessionListener
  #counter = 0
  #active = new Map<string, { info: LaunchStartInfo; startedAt: number }>()

  constructor(logger: Logger, telemetry?: TelemetryService, onSession?: LaunchSessionListener) {
    this.#logger = logger
    this.#telemetry = telemetry
    this.#onSession = onSession
  }

  get activeCount(): number {
    return this.#active.size
  }

  begin(info: LaunchStartInfo): LaunchHandle {
    this.#counter += 1
    const startedAt = Date.now()
    const launchId = `L-${startedAt.toString(36)}-${this.#counter.toString(36)}`
    this.#active.set(launchId, { info, startedAt })
    this.#logger.info('Launch started', {
      launchId,
      version: info.version,
      loader: info.loader ?? 'vanilla',
      loaderVersion: info.loaderVersion ?? '',
      instancePath: info.instancePath,
      instanceId: info.instanceId ?? '',
      instanceName: info.instanceName ?? '',
      javaPath: info.javaPath,
      gameRoot: info.gameRoot ?? '',
      account: info.account ?? '',
      startedAt: new Date(startedAt).toISOString(),
    })

    let finished = false
    return {
      launchId,
      finish: (outcome: LaunchOutcome = {}) => {
        if (finished) return
        finished = true
        this.#active.delete(launchId)
        const endedAt = Date.now()
        const durationMs = endedAt - startedAt
        const payload = {
          launchId,
          version: info.version,
          loader: info.loader ?? 'vanilla',
          loaderVersion: info.loaderVersion ?? '',
          instancePath: info.instancePath,
          javaPath: info.javaPath,
          ...(info.jvm
            ? {
                presetId: info.jvm.presetId,
                heapMb: info.jvm.heapMb,
                downgrades: [...info.jvm.downgrades],
              }
            : {}),
          exitCode: outcome.exitCode ?? null,
          durationMs,
          error: outcome.error ?? '',
        }
        if (outcome.error) this.#logger.error('Launch failed', payload)
        else this.#logger.info('Launch finished', payload)
        if (!outcome.error && this.#onSession) {
          const session: LaunchSession = {
            id: launchId,
            instanceId: info.instanceId ?? '',
            instanceName: info.instanceName ?? '',
            version: info.version,
            loader: info.loader ?? 'vanilla',
            loaderVersion: info.loaderVersion ?? '',
            startedAt,
            endedAt,
            durationMs,
          }
          try {
            void Promise.resolve(this.#onSession(session)).catch((error) => {
              this.#logger.warn('Launch session listener failed', {
                launchId,
                error: describeError(error),
              })
            })
          } catch (error) {
            this.#logger.warn('Launch session listener failed', {
              launchId,
              error: describeError(error),
            })
          }
        }
        if (this.#telemetry?.enabled) {
          const ok = !outcome.error && outcome.exitCode === 0
          const code = outcome.error
            ? 'launch-error'
            : ok
              ? undefined
              : typeof outcome.exitCode === 'number'
                ? `launch-exit-${outcome.exitCode}`
                : 'launch-exit-unknown'
          this.#telemetry.record('launch', {
            ok,
            ...(code ? { code } : {}),
            durationMs: payload.durationMs,
            ...(info.jvm
              ? {
                  presetId: info.jvm.presetId,
                  heapMb: info.jvm.heapMb,
                  downgrades: [...info.jvm.downgrades],
                }
              : {}),
          })
        }
      },
    }
  }
}
