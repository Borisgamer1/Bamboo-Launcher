/** Tokens are never logged, never returned to the renderer and never written to JSON; they go into the OS secret store. */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { FetchLike } from '../download/http'
import { describeError, getDefaultLogger, type Logger } from '../logger'

export const REDIRECT_PORT = 3377
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
export const MICROSOFT_SCOPE = 'XboxLive.signin XboxLive.offline_access offline_access openid profile'
export const XBOX_LOGIN_URL = 'https://user.auth.xboxlive.com/user/authenticate'
export const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
export const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
export const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

export const DEFAULT_CLIENT_ID =
  (process.env.BAMBOO_MS_CLIENT_ID ?? '').trim() || 'ccbe9e09-6163-4b79-99b1-03ba9be2e5ea'

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000

export type AuthErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'pending'
  | 'no-browser'
  | 'port-busy'
  | 'network'
  | 'http'
  | 'invalid-grant'
  | 'redirect-mismatch'
  | 'xsts-no-account'
  | 'xsts-region'
  | 'xsts-child'
  | 'xsts-failed'
  | 'no-profile'
  | 'not-signed-in'

const REDIRECT_MISMATCH_MESSAGE =
  `Microsoft lehnt die Redirect-URI ab (AADSTS50011). Die Azure-App-Registrierung hinter der Client-ID muss ${REDIRECT_URI} exakt als Redirect für öffentliche Clients (Public Client, ohne Secret) erlauben.`

function isRedirectMismatch(...values: Array<string | undefined>): boolean {
  return values.some(
    (value) => value !== undefined && /AADSTS50011|redirect_uri_mismatch|redirect_uri/i.test(value),
  )
}

export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AuthError'
    this.code = code
  }
}

export interface MicrosoftTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export interface MinecraftCredentials {
  accessToken: string
  expiresAt: number
  profile: { name: string; uuid: string }
}

interface JsonResult {
  status: number
  body: Record<string, unknown>
}

function doFetch(fetchImpl: FetchLike | undefined): FetchLike {
  return fetchImpl ?? ((url, init) => fetch(url, init))
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json()
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  } catch (error) {
    getDefaultLogger().child('auth').debug('OAuth response body was not JSON', { status: res.status, error: describeError(error) })
    return {}
  }
}

async function send(
  fetchImpl: FetchLike | undefined,
  url: string,
  init: RequestInit,
): Promise<JsonResult> {
  let res: Response
  try {
    res = await doFetch(fetchImpl)(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new AuthError('network', 'Microsoft/Xbox ist nicht erreichbar. Prüfe deine Verbindung.', error)
  }
  return { status: res.status, body: await readJson(res) }
}

function postJson(
  fetchImpl: FetchLike | undefined,
  url: string,
  payload: unknown,
): Promise<JsonResult> {
  return send(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
}

function postForm(
  fetchImpl: FetchLike | undefined,
  url: string,
  payload: URLSearchParams,
): Promise<JsonResult> {
  return send(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: payload.toString(),
  })
}

function getJson(
  fetchImpl: FetchLike | undefined,
  url: string,
  headers: Record<string, string>,
): Promise<JsonResult> {
  return send(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json', ...headers } })
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(16).toString('hex')
}

export function buildAuthorizeUrl(options: {
  clientId?: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(`${MICROSOFT_AUTHORITY}/authorize`)
  url.searchParams.set('client_id', options.clientId ?? DEFAULT_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', MICROSOFT_SCOPE)
  url.searchParams.set('state', options.state)
  url.searchParams.set('code_challenge', options.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

function tokenFailure(body: Record<string, unknown>, status: number): AuthError {
  const error = text(body.error)
  if (isRedirectMismatch(text(body.error_description))) {
    return new AuthError('redirect-mismatch', REDIRECT_MISMATCH_MESSAGE)
  }
  if (!error) {
    return new AuthError('http', `Microsoft-Anmeldung fehlgeschlagen (HTTP ${status}).`)
  }
  if (error === 'invalid_grant' || error === 'interaction_required' || error === 'consent_required') {
    return new AuthError(
      'invalid-grant',
      'Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich erneut an.',
    )
  }
  if (error === 'authorization_declined' || error === 'access_denied') {
    return new AuthError('cancelled', 'Die Anmeldung wurde abgebrochen.')
  }
  return new AuthError('http', `Microsoft-Anmeldung fehlgeschlagen (${error}).`)
}

function tokenResult(result: JsonResult, now: number): MicrosoftTokens {
  const accessToken = text(result.body.access_token)
  if (!accessToken) throw tokenFailure(result.body, result.status)
  const expiresIn = integer(result.body.expires_in) ?? 3600
  const refreshToken = text(result.body.refresh_token)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + expiresIn * 1000,
  }
}

export async function exchangeAuthorizationCode(options: {
  code: string
  codeVerifier: string
  redirectUri: string
  clientId?: string
  fetchImpl?: FetchLike
  now?: () => number
}): Promise<MicrosoftTokens> {
  const payload = new URLSearchParams({
    client_id: options.clientId ?? DEFAULT_CLIENT_ID,
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    scope: MICROSOFT_SCOPE,
  })
  const result = await postForm(options.fetchImpl, `${MICROSOFT_AUTHORITY}/token`, payload)
  return tokenResult(result, (options.now ?? Date.now)())
}

export async function refreshMicrosoftTokens(options: {
  refreshToken: string
  clientId?: string
  fetchImpl?: FetchLike
  now?: () => number
}): Promise<MicrosoftTokens> {
  const payload = new URLSearchParams({
    client_id: options.clientId ?? DEFAULT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    scope: MICROSOFT_SCOPE,
  })
  const result = await postForm(options.fetchImpl, `${MICROSOFT_AUTHORITY}/token`, payload)
  return tokenResult(result, (options.now ?? Date.now)())
}

const XSTS_ERRORS: Record<number, { code: AuthErrorCode; message: string }> = {
  2148916227: { code: 'xsts-failed', message: 'Dieses Xbox-Konto wurde gesperrt.' },
  2148916233: {
    code: 'xsts-no-account',
    message: 'Dieses Microsoft-Konto hat kein Xbox-Profil. Erstelle zuerst auf xbox.com ein Konto.',
  },
  2148916235: {
    code: 'xsts-region',
    message: 'Xbox Live ist in der Region dieses Kontos nicht verfügbar.',
  },
  2148916236: {
    code: 'xsts-child',
    message: 'Dieses Konto benötigt eine Bestätigung durch einen Erwachsenen.',
  },
  2148916237: {
    code: 'xsts-child',
    message: 'Dieses Konto benötigt eine Bestätigung durch einen Erwachsenen.',
  },
  2148916238: {
    code: 'xsts-child',
    message: 'Dieses Konto ist ein Kinderkonto und muss einer Xbox-Familie hinzugefügt werden.',
  },
}

function userHash(body: Record<string, unknown>): string | undefined {
  const claims = body.DisplayClaims
  if (typeof claims !== 'object' || claims === null) return undefined
  const xui = (claims as Record<string, unknown>).xui
  if (!Array.isArray(xui) || xui.length === 0) return undefined
  const first: unknown = xui[0]
  if (typeof first !== 'object' || first === null) return undefined
  return text((first as Record<string, unknown>).uhs)
}

export async function completeTokenChain(
  microsoftAccessToken: string,
  options: { fetchImpl?: FetchLike; now?: () => number } = {},
): Promise<MinecraftCredentials> {
  const fetchImpl = options.fetchImpl
  const now = (options.now ?? Date.now)()

  const xbl = await postJson(fetchImpl, XBOX_LOGIN_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${microsoftAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })
  const xblToken = text(xbl.body.Token)
  const uhs = userHash(xbl.body)
  if (!xblToken || !uhs) {
    throw new AuthError('http', 'Xbox Live hat kein gültiges Token geliefert.')
  }

  const xsts = await postJson(fetchImpl, XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })
  const xstsToken = text(xsts.body.Token)
  if (!xstsToken) {
    const xerr = integer(xsts.body.XErr)
    const mapped = xerr === undefined ? undefined : XSTS_ERRORS[xerr]
    throw new AuthError(
      mapped?.code ?? 'xsts-failed',
      mapped?.message ?? 'Xbox Live hat die Anmeldung abgelehnt.',
    )
  }

  const mc = await postJson(fetchImpl, MINECRAFT_LOGIN_URL, {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  })
  const minecraftToken = text(mc.body.access_token)
  if (!minecraftToken) {
    if (mc.status === 403) {
      throw new AuthError(
        'http',
        'Minecraft hat die App-Registrierung abgelehnt (HTTP 403). Neue Azure-Apps müssen für die Minecraft-API freigegeben werden: https://aka.ms/mce-reviewappid',
      )
    }
    throw new AuthError('http', `Minecraft hat kein Access-Token geliefert (HTTP ${mc.status}).`)
  }
  const expiresIn = integer(mc.body.expires_in) ?? 86_400

  const profile = await getJson(fetchImpl, MINECRAFT_PROFILE_URL, {
    Authorization: `Bearer ${minecraftToken}`,
  })
  if (profile.status === 404) {
    throw new AuthError('no-profile', 'Dieses Konto besitzt kein Minecraft-Java-Profil.')
  }
  const uuid = text(profile.body.id)
  const name = text(profile.body.name)
  if (!uuid || !name) {
    throw new AuthError('no-profile', 'Das Minecraft-Profil konnte nicht gelesen werden.')
  }

  return {
    accessToken: minecraftToken,
    expiresAt: now + expiresIn * 1000,
    profile: { name, uuid },
  }
}

export interface LoopbackLogin {
  redirectUri: string
  code: Promise<string>
  close: () => Promise<void>
  cancel: (reason?: string) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function page(title: string, message: string, accent: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Bamboo Launcher</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f1411;
         color:#e8efe9; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:min(420px,90vw); padding:28px; border:1px solid #253528; border-radius:16px;
         background:#141b16; text-align:center; }
  .dot { width:44px; height:44px; margin:0 auto 14px; border-radius:12px; display:grid;
         place-items:center; background:${accent}22; border:1px solid ${accent}55; color:${accent};
         font-size:22px; font-weight:700; }
  h1 { margin:0 0 6px; font-size:18px; }
  p { margin:0; font-size:13px; line-height:1.6; color:#a7b6ab; }
  small { display:block; margin-top:18px; font-size:11px; color:#6d7d72; }
</style>
</head>
<body>
<main>
  <div class="dot">&#10003;</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <small>Bamboo Launcher · Microsoft</small>
</main>
</body>
</html>`
}

export async function startLoopbackLogin(options: {
  port?: number
  state: string
  timeoutMs?: number
  logger?: Logger
}): Promise<LoopbackLogin> {
  const requestedPort = options.port ?? REDIRECT_PORT
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const state = options.state

  let settled = false
  let closed = false
  let resolveCode: (code: string) => void = () => undefined
  let rejectCode: (error: AuthError) => void = () => undefined

  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  void code.catch(() => undefined)

  const settle = (action: () => void): void => {
    if (settled) return
    settled = true
    action()
  }

  const fail = (error: AuthError): void => settle(() => rejectCode(error))
  const succeed = (value: string): void => settle(() => resolveCode(value))

  const respond = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    })
    res.end(body)
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      respond(res, 405, page('Nicht unterstützt', 'Diese Adresse nimmt nur Browser-Aufrufe an.', '#c2705c'))
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch (error) {
      getDefaultLogger().child('auth').debug('loopback callback had an invalid URL', { error: describeError(error) })
      respond(res, 400, page('Ungültige Anfrage', 'Die Antwort konnte nicht gelesen werden.', '#c2705c'))
      return
    }
    if (url.pathname !== '/' && url.pathname !== '/callback') {
      respond(res, 404, page('Nicht gefunden', 'Diese Adresse gehört nicht zur Anmeldung.', '#c2705c'))
      return
    }

    const error = url.searchParams.get('error')
    if (error) {
      const errorDescription = url.searchParams.get('error_description') ?? undefined
      if (isRedirectMismatch(error, errorDescription)) {
        respond(
          res,
          400,
          page(
            'Redirect-URI abgelehnt',
            `Die Azure-App-Registrierung muss ${REDIRECT_URI} als Redirect für öffentliche Clients erlauben.`,
            '#c2705c',
          ),
        )
        fail(new AuthError('redirect-mismatch', REDIRECT_MISMATCH_MESSAGE))
        void close()
        return
      }
      const cancelled = error === 'access_denied' || error === 'authorization_declined'
      respond(
        res,
        400,
        page(
          cancelled ? 'Anmeldung abgebrochen' : 'Anmeldung fehlgeschlagen',
          cancelled
            ? 'Du kannst dieses Fenster schließen und es im Launcher erneut versuchen.'
            : 'Microsoft hat die Anmeldung abgelehnt. Bitte versuche es erneut.',
          '#c2705c',
        ),
      )
      fail(
        new AuthError(
          cancelled ? 'cancelled' : 'http',
          cancelled ? 'Die Anmeldung wurde abgebrochen.' : `Microsoft-Anmeldung abgelehnt (${error}).`,
        ),
      )
      void close()
      return
    }

    if (url.searchParams.get('state') !== state) {
      respond(res, 400, page('Sitzung ungültig', 'Die Antwort gehört zu einer anderen Anmeldung.', '#c2705c'))
      fail(new AuthError('http', 'Die Antwort gehört zu einer anderen Anmelde-Sitzung.'))
      return
    }

    const authorizationCode = url.searchParams.get('code')
    if (!authorizationCode) {
      respond(res, 400, page('Kein Code erhalten', 'Microsoft hat keinen Autorisierungscode geliefert.', '#c2705c'))
      fail(new AuthError('http', 'Microsoft hat keinen Autorisierungscode geliefert.'))
      return
    }

    respond(
      res,
      200,
      page(
        'Anmeldung erfolgreich',
        'Du kannst dieses Fenster schließen und zum Launcher zurückkehren.',
        '#6fbf73',
      ),
    )
    succeed(authorizationCode)
    void close()
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE') {
          reject(
            new AuthError(
              'port-busy',
              `Port ${requestedPort} wird bereits von einem anderen Programm benutzt.`,
              error,
            ),
          )
          return
        }
        reject(new AuthError('network', 'Der lokale Anmelde-Listener konnte nicht starten.', error))
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(requestedPort, '127.0.0.1')
    })
  } catch (error) {
    server.close()
    throw error
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort
  const redirectUri = requestedPort === REDIRECT_PORT ? REDIRECT_URI : `http://localhost:${port}`

  const timer = setTimeout(() => {
    fail(new AuthError('timeout', 'Zeitüberschreitung: Die Anmeldung wurde nicht abgeschlossen.'))
    void close()
  }, timeoutMs)
  timer.unref?.()

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections?.()
    })
    options.logger?.debug('Loopback-Listener beendet', { port })
  }

  options.logger?.info('Loopback-Listener gestartet', { port, redirectUri })

  return {
    redirectUri,
    code,
    close,
    cancel: (reason?: string) => {
      fail(new AuthError('cancelled', reason ?? 'Die Anmeldung wurde abgebrochen.'))
      void close()
    },
  }
}
