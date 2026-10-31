import type { Logger } from './logger'
import { readJsonFile, writeJsonFile } from './atomic'
import { Settings, SettingsSchema, parseWithDefaults } from './schemas'

const DEFAULTS: Settings = SettingsSchema.parse({}) as Settings

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class SettingsStore {
  #file: string
  #logger: Logger
  #data: Settings | undefined
  #loading: Promise<void> | undefined

  constructor(file: string, logger: Logger) {
    this.#file = file
    this.#logger = logger
  }

  async load(): Promise<Settings> {
    if (!this.#loading) this.#loading = this.#load()
    await this.#loading
    return clone(this.#data ?? DEFAULTS)
  }

  async #load(): Promise<void> {
    const raw = await readJsonFile<Record<string, unknown>>(this.#file, this.#logger)
    if (raw === undefined) {
      this.#data = clone(DEFAULTS)
      return
    }
    const data = parseWithDefaults(SettingsSchema, raw, DEFAULTS, (message) =>
      this.#logger.warn('Settings failed validation; invalid values were replaced by defaults', { issues: message }),
    ) as Settings
    this.#data = data
  }

  async get(): Promise<Settings> {
    const data = await this.load()
    return clone(data)
  }

  async save(patch: Record<string, unknown>): Promise<Settings> {
    const current = await this.load()
    const next: Record<string, unknown> = { ...current, ...patch }
    delete next.accounts
    const merged = parseWithDefaults(SettingsSchema, next, DEFAULTS, (message) =>
      this.#logger.warn('Rejected settings patch contained invalid values', { issues: message }),
    ) as Settings
    this.#data = merged
    await writeJsonFile(this.#file, merged, this.#logger)
    return clone(merged)
  }

  async replace(next: Record<string, unknown>): Promise<Settings> {
    const sanitized: Record<string, unknown> = { ...next }
    delete sanitized.accounts
    const parsed = parseWithDefaults(SettingsSchema, sanitized, DEFAULTS) as Settings
    this.#data = parsed
    await writeJsonFile(this.#file, parsed, this.#logger)
    return clone(parsed)
  }
}
