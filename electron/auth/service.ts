import type { AccountView, AccountStore } from '../account-store'
import type { FetchLike } from '../download/http'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import type { TokenStore } from '../token-store'
import type { Account } from '../schemas'
import {
  AuthError,
  buildAuthorizeUrl,
  completeTokenChain,
  createPkcePair,
  createState,
  DEFAULT_CLIENT_ID,
  exchangeAuthorizationCode,
  REDIRECT_PORT,
  refreshMicrosoftTokens,
  startLoopbackLogin,
  type LoopbackLogin,
  type MinecraftCredentials,
} from './microsoft'

const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface MicrosoftAccountStatus {
  id: string
  name: string
  uuid: string
  type: string
  active: boolean
  avatar: string
  expiresAt?: number
  expired: boolean
  hasRefreshToken: boolean
}

export interface MicrosoftAuthStatus {
  signedIn: boolean
  pending: boolean
  tokenStoreDegraded: boolean
  account: MicrosoftAccountStatus | null
}

export interface MicrosoftAuthOptions {
  accounts: AccountStore
  tokens: TokenStore
  logger: Logger
  openUrl?: (url: string) => Promise<void>
  fetchImpl?: FetchLike
  clientId?: string
  port?: number
  timeoutMs?: number
  onSessionLost?: (status: MicrosoftAuthStatus) => void
}

function avatarFor(uuid: string): string {
  return `https://mc-heads.net/avatar/${uuid || 'Steve'}/64`
}

function accountExpiry(account: Account): number | undefined {
  return typeof account.expiresAt === 'number' && Number.isFinite(account.expiresAt)
    ? account.expiresAt
    : undefined
}

function isStale(expiresAt: number | undefined, now = Date.now()): boolean {
  return expiresAt === undefined || expiresAt <= now + REFRESH_MARGIN_MS
}

function rejectedGrant(error: unknown): boolean {
  return error instanceof AuthError && error.code === 'invalid-grant'
}

function avatarFrom(stored: unknown, uuid: string): string {
  if (typeof stored === 'string') {
    try {
      const url = new URL(stored)
      if (url.protocol === 'https:' && url.hostname) return stored
    } catch (error) {
      // Invalid stored URL: fall back to the generated avatar below.
      getDefaultLogger().child('auth').debug('stored avatar URL invalid; using generated avatar', { error: describeError(error) })
    }
  }
  return avatarFor(uuid)
}

const SESSION_DROPPED = 'Die Sitzung wurde zwischenzeitlich abgemeldet.'

interface LoginAttempt {
  loopback?: LoopbackLogin
  accountId?: string
  discarded: boolean
  done: Promise<void>
  finish: () => void
}

function createAttempt(): LoginAttempt {
  let finish = (): void => undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { discarded: false, done, finish }
}

export class MicrosoftAuthService {
  #accounts: AccountStore
  #tokens: TokenStore
  #logger: Logger
  #openUrl: ((url: string) => Promise<void>) | undefined
  #fetchImpl: FetchLike | undefined
  #clientId: string
  #port: number
  #timeoutMs: number | undefined
  #onSessionLost: ((status: MicrosoftAuthStatus) => void) | undefined
  #attempt: LoginAttempt | null = null
  #sessionGeneration = 0
  #writes = new Set<Promise<void>>()
  #rotations = new Map<string, Promise<MinecraftCredentials>>()

  constructor(options: MicrosoftAuthOptions) {
    this.#accounts = options.accounts
    this.#tokens = options.tokens
    this.#logger = options.logger
    this.#openUrl = options.openUrl
    this.#fetchImpl = options.fetchImpl
    this.#clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.#port = options.port ?? REDIRECT_PORT
    this.#timeoutMs = options.timeoutMs
    this.#onSessionLost = options.onSessionLost
  }

  get redirectPort(): number {
    return this.#port
  }

  async status(): Promise<MicrosoftAuthStatus> {
    const accounts = await this.#accounts.list()
    const account =
      accounts.find((entry) => entry.type === 'microsoft' && entry.active) ??
      accounts.find((entry) => entry.type === 'microsoft')

    if (!account) {
      return {
        signedIn: false,
        pending: this.#attempt !== null,
        tokenStoreDegraded: this.#tokens.degraded,
        account: null,
      }
    }

    const stored = await this.#accounts.getToken(account.id)
    const expiresAt = accountExpiry(account)
    return {
      signedIn: Boolean(stored?.accessToken || stored?.refreshToken),
      pending: this.#attempt !== null,
      tokenStoreDegraded: this.#tokens.degraded,
      account: {
        id: account.id,
        name: account.name,
        uuid: account.uuid,
        type: account.type,
        active: account.active,
        avatar: avatarFrom(account.avatar, account.uuid),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        expired: isStale(expiresAt),
        hasRefreshToken: Boolean(stored?.refreshToken),
      },
    }
  }

  async login(): Promise<MicrosoftAuthStatus> {
    if (this.#attempt) {
      throw new AuthError('pending', 'Es läuft bereits eine Anmeldung.')
    }
    const openUrl = this.#openUrl
    if (!openUrl) {
      throw new AuthError('no-browser', 'Der Launcher kann keinen Browser öffnen.')
    }

    const attempt = createAttempt()
    this.#attempt = attempt
    const state = createState()
    const pkce = createPkcePair()
    let loopback: LoopbackLogin | undefined

    try {
      loopback = await startLoopbackLogin({
        port: this.#port,
        state,
        ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
        logger: this.#logger.child('loopback'),
      })
      attempt.loopback = loopback

      const authorizeUrl = buildAuthorizeUrl({
        clientId: this.#clientId,
        redirectUri: loopback.redirectUri,
        state,
        codeChallenge: pkce.challenge,
      })

      try {
        await openUrl(authorizeUrl)
      } catch (error) {
        throw new AuthError('no-browser', 'Der Browser konnte nicht geöffnet werden.', error)
      }

      this.#logger.info('Microsoft-Login gestartet', { redirectUri: loopback.redirectUri })

      const code = await loopback.code
      const tokens = await exchangeAuthorizationCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: loopback.redirectUri,
        clientId: this.#clientId,
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      })

      const credentials = await completeTokenChain(tokens.accessToken, {
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      })
      attempt.accountId = credentials.profile.uuid
      this.#assertCurrent(attempt)

      await this.#trackWrite(
        this.#persist(credentials, tokens.refreshToken, {
          accountId: credentials.profile.uuid,
          active: true,
          dedupe: true,
        }),
      )

      this.#logger.info('Microsoft-Login abgeschlossen', {
        accountId: credentials.profile.uuid,
        hasRefreshToken: Boolean(tokens.refreshToken),
      })
      if (this.#attempt === attempt) this.#attempt = null
      return await this.status()
    } catch (error) {
      this.#logger.warn('Microsoft-Login fehlgeschlagen', {
        code: error instanceof AuthError ? error.code : 'unknown',
      })
      throw error
    } finally {
      if (this.#attempt === attempt) this.#attempt = null
      await loopback?.close()
      attempt.finish()
    }
  }

  cancel(): boolean {
    const attempt = this.#attempt
    if (!attempt?.loopback) return false
    attempt.discarded = true
    attempt.loopback.cancel('Die Anmeldung wurde abgebrochen.')
    return true
  }

  async refresh(accountId?: string): Promise<MicrosoftAuthStatus> {
    const account = await this.#requireAccount(accountId)
    try {
      await this.#rotate(account)
    } catch (error) {
      if (!rejectedGrant(error)) throw error
    }
    return this.status()
  }

  async signOut(accountId?: string): Promise<MicrosoftAuthStatus> {
    const attempt = this.#attempt
    if (attempt) {
      attempt.discarded = true
      attempt.loopback?.cancel('Die Anmeldung wurde durch die Abmeldung beendet.')
    }
    this.#sessionGeneration += 1
    await Promise.allSettled([...this.#writes])
    let account: AccountView | undefined
    try {
      account = await this.#requireAccount(accountId)
    } catch (error) {
      if (error instanceof AuthError && error.code === 'not-signed-in') {
        if (attempt?.loopback) await attempt.done
        return this.status()
      }
      throw error
    }
    await this.#accounts.remove(account.id)
    this.#logger.info('Microsoft-Konto abgemeldet', { accountId: account.id })
    if (attempt?.loopback) await attempt.done
    return this.status()
  }

  async restore(): Promise<MicrosoftAuthStatus> {
    const status = await this.status()
    if (!status.account || !status.account.hasRefreshToken) return status
    if (!isStale(status.account.expiresAt)) return status

    try {
      const account = await this.#requireAccount(status.account.id)
      await this.#rotate(account)
      this.#logger.info('Sitzung beim Start erneuert', { accountId: account.id })
    } catch (error) {
      if (!rejectedGrant(error)) {
        this.#logger.warn('Sitzung konnte beim Start nicht erneuert werden', {
          code: error instanceof AuthError ? error.code : 'unknown',
        })
      }
    }
    return this.status()
  }

  async accessTokenFor(account: Account): Promise<string | undefined> {
    const stored = await this.#accounts.getToken(account.id)
    if (!stored) return undefined
    if (account.type !== 'microsoft') return stored.accessToken
    if (!stored.refreshToken || !isStale(accountExpiry(account))) return stored.accessToken

    try {
      const credentials = await this.#rotate(account)
      return credentials.accessToken
    } catch (error) {
      if (rejectedGrant(error)) {
        return (await this.#accounts.getToken(account.id))?.accessToken
      }
      this.#logger.warn('Token-Erneuerung vor dem Start fehlgeschlagen', {
        accountId: account.id,
        code: error instanceof AuthError ? error.code : 'unknown',
      })
      return stored.accessToken
    }
  }

  async #dropExpiredSession(accountId: string): Promise<void> {
    await this.#accounts.remove(accountId)
    this.#logger.info('Microsoft-Sitzung abgelaufen; Konto abgemeldet', { accountId })
    try {
      await this.#onSessionLost?.(await this.status())
    } catch (error) {
      this.#logger.warn('Sitzungsverlust konnte nicht gemeldet werden', {
        error: (error as Error).message,
      })
    }
  }

  #assertCurrent(attempt: LoginAttempt): void {
    if (!attempt.discarded && this.#attempt === attempt) return
    throw new AuthError('cancelled', SESSION_DROPPED)
  }

  async #requireAccount(accountId?: string): Promise<AccountView> {
    const accounts = await this.#accounts.list()
    const account = accountId
      ? accounts.find((entry) => entry.id === accountId)
      : accounts.find((entry) => entry.type === 'microsoft' && entry.active) ??
        accounts.find((entry) => entry.type === 'microsoft')
    if (!account) throw new AuthError('not-signed-in', 'Kein Microsoft-Konto angemeldet.')
    return account
  }

  #rotate(account: Account): Promise<MinecraftCredentials> {
    const running = this.#rotations.get(account.id)
    if (running) return running
    const rotation = this.#rotateOnce(account).finally(() => {
      this.#rotations.delete(account.id)
    })
    this.#rotations.set(account.id, rotation)
    return rotation
  }

  async #rotateOnce(account: Account): Promise<MinecraftCredentials> {
    const stored = await this.#accounts.getToken(account.id)
    const refreshToken = stored?.refreshToken
    if (!refreshToken) {
      throw new AuthError('not-signed-in', 'Die Sitzung ist abgelaufen. Bitte melde dich neu an.')
    }
    try {
      return await this.#refreshAccount(account, refreshToken)
    } catch (error) {
      if (!rejectedGrant(error)) throw error
      const current = await this.#accounts.getToken(account.id)
      const unchanged =
        current?.refreshToken === refreshToken && current?.accessToken === stored?.accessToken
      const loginWriting = this.#attempt?.accountId === account.id
      if (unchanged && !loginWriting) await this.#dropExpiredSession(account.id)
      throw error
    }
  }

  async #refreshAccount(account: Account, refreshToken: string): Promise<MinecraftCredentials> {
    const generation = this.#sessionGeneration

    const tokens = await refreshMicrosoftTokens({
      refreshToken,
      clientId: this.#clientId,
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
    })
    const credentials = await completeTokenChain(tokens.accessToken, {
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
    })
    if (generation !== this.#sessionGeneration) {
      throw new AuthError('cancelled', SESSION_DROPPED)
    }

    await this.#trackWrite(
      this.#persist(credentials, tokens.refreshToken ?? refreshToken, {
        accountId: account.id,
        active: account.active,
        dedupe: false,
      }),
    )
    return credentials
  }

  async #trackWrite(write: Promise<void>): Promise<void> {
    this.#writes.add(write)
    try {
      await write
    } finally {
      this.#writes.delete(write)
    }
  }

  /** Metadata goes to `accounts.json`, tokens to the OS secret store. */
  async #persist(
    credentials: MinecraftCredentials,
    refreshToken: string | undefined,
    options: { accountId: string; active: boolean; dedupe: boolean },
  ): Promise<void> {
    const uuid = credentials.profile.uuid

    if (options.dedupe) {
      const existing = await this.#accounts.list()
      for (const entry of existing) {
        if (entry.type !== 'microsoft' || entry.id === options.accountId) continue
        if (!entry.uuid || entry.uuid.toLowerCase() !== uuid.toLowerCase()) continue
        await this.#accounts.remove(entry.id)
        this.#logger.info('Veralteter Konto-Eintrag ersetzt', { accountId: entry.id })
      }
    }

    await this.#accounts.upsert({
      id: options.accountId,
      name: credentials.profile.name,
      uuid,
      type: 'microsoft',
      active: options.active,
      avatar: avatarFor(uuid),
      provider: 'microsoft-oauth',
      expiresAt: credentials.expiresAt,
      accessToken: credentials.accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    })
  }
}
