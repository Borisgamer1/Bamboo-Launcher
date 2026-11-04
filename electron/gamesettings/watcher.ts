import { unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../logger'

export type GameSettingsFileKind = 'options' | 'shader' | 'eula' | 'server'

export interface GameSettingsChange {
  kind: GameSettingsFileKind
  file: string
  eventType: 'rename' | 'change'
}

export type GameSettingsListener = (change: GameSettingsChange) => void

const DEBOUNCE_MS = 120
const POLL_MS = 250

export class GameSettingsWatcher {
  readonly #instanceDir: string
  readonly #listener: GameSettingsListener
  readonly #logger?: Logger
  readonly #files: string[] = []
  readonly #timers = new Map<string, NodeJS.Timeout>()
  #closed = false

  constructor(instanceDir: string, listener: GameSettingsListener, logger?: Logger) {
    this.#instanceDir = instanceDir
    this.#listener = listener
    this.#logger = logger
  }

  start(): this {
    this.#watch('options.txt', 'options')
    this.#watch('optionsshaders.txt', 'shader')
    this.#watch(join('config', 'iris.properties'), 'shader')
    this.#watch(join('config', 'oculus.properties'), 'shader')
    this.#watch('iris.properties', 'shader')
    this.#watch('oculus.properties', 'shader')
    this.#watch(join('server', 'eula.txt'), 'eula')
    this.#watch(join('server', 'server.properties'), 'server')
    return this
  }

  #watch(relative: string, kind: GameSettingsFileKind): void {
    const file = join(this.#instanceDir, relative)
    try {
      watchFile(file, { persistent: false, interval: POLL_MS }, (current, previous) => {
        if (this.#closed) return
        if (
          current.mtimeMs === previous.mtimeMs &&
          current.size === previous.size &&
          current.nlink === previous.nlink
        ) {
          return
        }
        this.#schedule(kind, file)
      })
      this.#files.push(file)
    } catch (error) {
      this.#logger?.warn('Game settings watcher could not watch file', {
        file,
        error: (error as Error).message,
      })
    }
  }

  #schedule(kind: GameSettingsFileKind, file: string): void {
    const previous = this.#timers.get(file)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.#timers.delete(file)
      if (this.#closed) return
      this.#listener({ kind, file, eventType: 'change' })
    }, DEBOUNCE_MS)
    this.#timers.set(file, timer)
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    for (const file of this.#files) unwatchFile(file)
    this.#files.length = 0
  }
}
