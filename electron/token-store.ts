/** Tokens live in the OS secret store, never in JSON; if encryption is unavailable they stay in memory and are reported as degraded. */
import type { Logger } from './logger'
import { readJsonFile, writeJsonFile } from './atomic'

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface AccountTokens {
  accessToken?: string
  refreshToken?: string
}

interface TokenFile {
  v: 1
  entries: Record<string, { a: string; r?: string }>
}

export class TokenStore {
  #file: string
  #box: SecretBox | undefined
  #logger: Logger
  #entries: Record<string, { a: string; r?: string }> = {}
  #memory: Record<string, AccountTokens> = {}
  #loaded: Promise<void> | undefined
  #degraded = false

  constructor(file: string, box: SecretBox | undefined, logger: Logger) {
    this.#file = file
    this.#box = box
    this.#logger = logger
  }

  get degraded(): boolean {
    return this.#degraded
  }

  async load(): Promise<void> {
    if (!this.#loaded) this.#loaded = this.#load()
    return this.#loaded
  }

  async #load(): Promise<void> {
    if (!this.#box?.isEncryptionAvailable()) {
      this.#degraded = true
      if (this.#box === undefined) {
        this.#logger.warn('No secret store available; tokens will not be persisted')
      } else {
        this.#logger.warn('OS encryption unavailable; tokens stay in memory for this session only')
      }
      return
    }
    const file = await readJsonFile<TokenFile>(this.#file, this.#logger)
    if (!file || file.v !== 1 || typeof file.entries !== 'object' || file.entries === null) return
    this.#entries = file.entries
  }

  async get(accountId: string): Promise<AccountTokens | undefined> {
    await this.load()
    if (this.#degraded) return this.#memory[accountId]
    const entry = this.#entries[accountId]
    if (!entry || !this.#box) return undefined
    try {
      return {
        accessToken: this.#box.decryptString(Buffer.from(entry.a, 'base64')),
        refreshToken: entry.r ? this.#box.decryptString(Buffer.from(entry.r, 'base64')) : undefined,
      }
    } catch (error) {
      this.#logger.warn('Stored token could not be decrypted; re-login required', {
        accountId,
        error: (error as Error).message,
      })
      return undefined
    }
  }

  async has(accountId: string): Promise<boolean> {
    const tokens = await this.get(accountId)
    return Boolean(tokens?.accessToken || tokens?.refreshToken)
  }

  async set(accountId: string, tokens: AccountTokens): Promise<void> {
    await this.load()
    if (this.#degraded || !this.#box) {
      this.#memory[accountId] = { ...this.#memory[accountId], ...tokens }
      return
    }
    const entry: { a: string; r?: string } = { a: '' }
    if (tokens.accessToken !== undefined) {
      entry.a = this.#box.encryptString(tokens.accessToken).toString('base64')
    } else if (this.#entries[accountId]?.a) {
      entry.a = this.#entries[accountId].a
    }
    if (tokens.refreshToken !== undefined) {
      entry.r = this.#box.encryptString(tokens.refreshToken).toString('base64')
    } else if (this.#entries[accountId]?.r) {
      entry.r = this.#entries[accountId].r
    }
    if (!entry.a && !entry.r) return
    this.#entries[accountId] = entry
    await this.#persist()
  }

  async update(accountId: string, tokens: AccountTokens): Promise<void> {
    const current = (await this.get(accountId)) ?? {}
    await this.set(accountId, { ...current, ...tokens })
  }

  async remove(accountId: string): Promise<void> {
    await this.load()
    delete this.#memory[accountId]
    if (this.#entries[accountId]) {
      delete this.#entries[accountId]
      if (!this.#degraded) await this.#persist()
    }
  }

  async #persist(): Promise<void> {
    await writeJsonFile(this.#file, { v: 1, entries: this.#entries } satisfies TokenFile, this.#logger)
    this.#logger.debug('Token store persisted', { accounts: Object.keys(this.#entries).length })
  }
}
