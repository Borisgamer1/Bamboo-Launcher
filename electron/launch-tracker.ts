import type { Logger } from './logger'
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

export class LaunchTracker {
  #logger: Logger
  #telemetry?: TelemetryService
  #counter = 0
  #active = new Map<string, { info: LaunchStartInfo; startedAt: number }>()

  constructor(logger: Logger, telemetry?: TelemetryService) {
    this.#logger = logger
    this.#telemetry = telemetry
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
          durationMs: Date.now() - startedAt,
          error: outcome.error ?? '',
        }
        if (outcome.error) this.#logger.error('Launch failed', payload)
        else this.#logger.info('Launch finished', payload)
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
