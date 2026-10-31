/** Metadata only; access and refresh tokens are pushed into the OS secret store. The renderer never receives tokens. */
import { createHash } from 'node:crypto'
import type { Logger } from './logger'
import { readJsonFile, writeJsonFile } from './atomic'
import { Account, AccountFileSchema, parseWithDefaults, stripTokenFields } from './schemas'
import type { TokenStore } from './token-store'

export interface AccountView extends Account {
  hasToken: boolean
}

const EMPTY: { version: 1; selectedAccountId: string; accounts: Account[] } = {
  version: 1,
  selectedAccountId: '',
  accounts: [],
}

function fallbackId(input: Record<string, unknown>): string {
  const name = typeof input.name === 'string' ? input.name : ''
  const uuid = typeof input.uuid === 'string' ? input.uuid : ''
  const seed = `${name}|${uuid}`
  return `local-${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`
}

export class AccountStore {
  #file: string
  #tokens: TokenStore
  #logger: Logger
  #accounts: Account[] = []
  #selected = ''
  #loaded: Promise<void> | undefined

  constructor(file: string, tokens: TokenStore, logger: Logger) {
    this.#file = file
    this.#tokens = tokens
    this.#logger = logger
  }

  async load(): Promise<void> {
    if (!this.#loaded) this.#loaded = this.#load()
    return this.#loaded
  }

  async #load(): Promise<void> {
    const raw = await readJsonFile<Record<string, unknown>>(this.#file, this.#logger)
    if (raw === undefined) return
    const parsed = parseWithDefaults(AccountFileSchema, raw, EMPTY, (issues) =>
      this.#logger.warn('accounts.json failed validation; invalid entries were dropped', { issues }),
    )
    this.#accounts = parsed.accounts
    this.#selected = parsed.selectedAccountId
  }

  async list(): Promise<AccountView[]> {
    await this.load()
    const result: AccountView[] = []
    for (const account of this.#accounts) {
      result.push({ ...account, hasToken: await this.#tokens.has(account.id) })
    }
    return result
  }

  async get(id: string): Promise<Account | undefined> {
    await this.load()
    return this.#accounts.find((account) => account.id === id)
  }

  async getSelected(): Promise<Account | undefined> {
    await this.load()
    return (
      this.#accounts.find((account) => account.id === this.#selected) ??
      this.#accounts.find((account) => account.active) ??
      this.#accounts[0]
    )
  }

  async getToken(id: string) {
    return this.#tokens.get(id)
  }

  async upsert(input: Record<string, unknown>): Promise<Account> {
    await this.load()
    const { rest, tokens } = stripTokenFields(input)
    const id = typeof rest.id === 'string' && rest.id.length > 0 ? rest.id : fallbackId(rest)
    const existing = this.#accounts.find((account) => account.id === id)
    const merged: Account = {
      ...(existing ?? { id, name: '', uuid: '', type: 'offline', active: false }),
      ...rest,
      id,
    }

    if (tokens.accessToken !== undefined || tokens.refreshToken !== undefined) {
      await this.#tokens.set(id, tokens)
    }

    if (merged.active) {
      for (const account of this.#accounts) account.active = account.id === id
      this.#selected = id
    } else if (this.#accounts.length === 0) {
      merged.active = true
      this.#selected = id
    }

    const index = this.#accounts.findIndex((account) => account.id === id)
    if (index === -1) this.#accounts.push(merged)
    else this.#accounts[index] = merged

    await this.#persist()
    return merged
  }

  async setActive(id: string): Promise<void> {
    await this.load()
    let found = false
    for (const account of this.#accounts) {
      const active = account.id === id
      account.active = active
      if (active) found = true
    }
    if (!found) throw new Error(`Unknown account: ${id}`)
    this.#selected = id
    await this.#persist()
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.#accounts = this.#accounts.filter((account) => account.id !== id)
    await this.#tokens.remove(id)
    if (this.#selected === id) {
      this.#selected = this.#accounts.find((account) => account.active)?.id ?? this.#accounts[0]?.id ?? ''
    }
    await this.#persist()
  }

  async importLegacy(list: unknown[]): Promise<number> {
    let imported = 0
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue
      await this.upsert(entry as Record<string, unknown>)
      imported += 1
    }
    return imported
  }

  async #persist(): Promise<void> {
    await writeJsonFile(
      this.#file,
      { version: 1, selectedAccountId: this.#selected, accounts: this.#accounts },
      this.#logger,
    )
  }
}
