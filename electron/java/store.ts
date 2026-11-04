import { readJsonFile, writeJsonFile } from '../atomic'
import type { Logger } from '../logger'
import { JavaIndex, JavaIndexSchema, JavaRecord, parseWithDefaults } from '../schemas'

const EMPTY: JavaIndex = { version: 1, records: [] }

export class JavaStore {
  #file: string
  #logger: Logger
  #data: JavaIndex = { version: 1, records: [] }
  #loaded: Promise<void> | undefined

  constructor(file: string, logger: Logger) {
    this.#file = file
    this.#logger = logger
  }

  async load(): Promise<void> {
    if (!this.#loaded) this.#loaded = this.#load()
    return this.#loaded
  }

  async #load(): Promise<void> {
    const raw = await readJsonFile<Record<string, unknown>>(this.#file, this.#logger)
    if (raw === undefined) return
    this.#data = parseWithDefaults(JavaIndexSchema, raw, EMPTY, (issues) =>
      this.#logger.warn('java.json failed validation; invalid entries were dropped', { issues }),
    ) as JavaIndex
  }

  async list(): Promise<JavaRecord[]> {
    await this.load()
    return this.#data.records.map((record) => ({ ...record }))
  }

  async upsert(record: JavaRecord): Promise<JavaRecord> {
    await this.load()
    const index = this.#data.records.findIndex((entry) => samePath(entry.path, record.path))
    const existing = index === -1 ? undefined : this.#data.records[index]
    const next: JavaRecord = {
      ...record,
      addedAt: existing?.addedAt ?? record.addedAt,
      validatedAt: record.validatedAt,
    }
    if (index === -1) this.#data.records.push(next)
    else this.#data.records[index] = next
    await this.#persist()
    return next
  }

  async setValid(path: string, valid: boolean): Promise<void> {
    await this.load()
    const record = this.#data.records.find((entry) => samePath(entry.path, path))
    if (!record || record.valid === valid) return
    record.valid = valid
    await this.#persist()
  }

  async remove(path: string): Promise<void> {
    await this.load()
    const next = this.#data.records.filter((entry) => !samePath(entry.path, path))
    if (next.length === this.#data.records.length) return
    this.#data.records = next
    await this.#persist()
  }

  async replaceAll(records: JavaRecord[]): Promise<void> {
    await this.load()
    this.#data.records = records.map((record) => ({ ...record }))
    await this.#persist()
  }

  async #persist(): Promise<void> {
    await writeJsonFile(this.#file, this.#data, this.#logger)
  }
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
