/**
 * Microsoft account authentication (mission: login + Konto tab).
 *
 * Exercised end to end without the network: the OAuth token endpoint, Xbox
 * Live, XSTS and Minecraft are an injected `fetch`; the browser is simulated by
 * calling the real loopback listener on the port it actually bound.
 *
 * Covered:
 * 1. protocol shape of the whole token chain,
 * 2. a complete login through the loopback redirect (fixed port contract),
 * 3. encrypted-at-rest storage and no token in accounts.json,
 * 4. session refresh from the stored refresh token,
 * 5. cancel closes the listener immediately,
 * 6. sign-out removes metadata and tokens,
 * 7. a stored session is restored on the next core start.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { AccountStore } = require('../dist-electron/account-store.js')
const { TokenStore } = require('../dist-electron/token-store.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { createCore } = require('../dist-electron/core.js')
const {
  AuthError,
  completeTokenChain,
  exchangeAuthorizationCode,
  LOGIN_TIMEOUT_MS,
  REDIRECT_PORT,
  REDIRECT_URI,
} = require('../dist-electron/auth/microsoft.js')
const { MicrosoftAuthService } = require('../dist-electron/auth/service.js')
const { registerIpc } = require('../dist-electron/ipc.js')

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const UUID = '0123456789abcdef0123456789abcdef'

function makeBox() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  }
}

function makeStores(appData) {
  const logger = createNullLogger()
  const tokens = new TokenStore(path.join(appData, 'accounts.tokens.json'), makeBox(), logger)
  const accounts = new AccountStore(path.join(appData, 'accounts.json'), tokens, logger)
  return { accounts, tokens, logger }
}

/** Minimal fetch double: every call is recorded, unknown URLs fail loudly. */
function fakeFetch(handlers) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({
      url,
      body: init.body === undefined ? '' : String(init.body),
      headers: init.headers ?? {},
    })
    const handler = handlers[url]
    if (!handler) throw new Error(`Unerwarteter Request: ${url}`)
    const { status = 200, body = {} } = await handler(init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

function chainHandlers(profile = { id: UUID, name: 'Alex' }) {
  return {
    [XBL_URL]: () => ({ body: { Token: 'XBL-TOKEN', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } }),
    [XSTS_URL]: () => ({ body: { Token: 'XSTS-TOKEN' } }),
    [MC_LOGIN_URL]: () => ({ body: { access_token: 'MC-ACCESS', expires_in: 86_400 } }),
    [PROFILE_URL]: () => ({ body: profile }),
  }
}

/** Chain whose Minecraft token is distinguishable from the stored one. */
function launchChain(mcToken) {
  return {
    ...chainHandlers(),
    [MC_LOGIN_URL]: () => ({ body: { access_token: mcToken, expires_in: 86_400 } }),
  }
}

/**
 * The real `LauncherCore.launchInstance()` with the spawn swapped out, so the
 * test sees exactly which identity (and token) reaches the launch service.
 */
function stubLaunch(core, captured) {
  core.instanceManager = {
    get: async (id) => ({ instance: { id }, directory: path.join(core.paths.gameRoot, 'instances', 'demo') }),
    readFile: async () => ({ id: 'inst-demo', name: 'Demo', version: '1.20.1', loader: 'vanilla', loaderVersion: '' }),
  }
  core.launch = {
    start: async (request) => {
      captured.push(request.account)
      return {
        pid: 1,
        plan: {},
        exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
        kill: async () => undefined,
        killed: false,
      }
    },
  }
}

function tokenHandler(options) {
  return (init) => {
    const params = new URLSearchParams(String(init.body))
    if (params.get('grant_type') === 'refresh_token') {
      return {
        body: {
          access_token: options.refreshedMicrosoftToken,
          refresh_token: options.refreshedRefreshToken,
          expires_in: 3600,
        },
      }
    }
    return {
      body: {
        access_token: options.microsoftToken,
        refresh_token: options.refreshToken,
        expires_in: 3600,
      },
    }
  }
}

function redirectPort(authorizeUrl) {
  return Number(new URL(new URL(authorizeUrl).searchParams.get('redirect_uri')).port)
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Bedingung nicht erfüllt')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A paused call: `hit` fires when it is reached, `release` lets it continue. */
function gate() {
  let hit
  const reached = new Promise((resolve) => {
    hit = resolve
  })
  let release
  const open = new Promise((resolve) => {
    release = resolve
  })
  return { reached, hit, open, release }
}

test('token chain: Microsoft → Xbox Live → XSTS → Minecraft profile', async () => {
  const fetchImpl = fakeFetch(chainHandlers())
  const credentials = await completeTokenChain('MS-ACCESS', { fetchImpl, now: () => 1000 })

  assert.equal(credentials.accessToken, 'MC-ACCESS')
  assert.deepEqual(credentials.profile, { name: 'Alex', uuid: UUID })
  assert.equal(credentials.expiresAt, 1000 + 86_400_000)

  const xbl = JSON.parse(fetchImpl.calls[0].body)
  assert.equal(xbl.Properties.RpsTicket, 'd=MS-ACCESS')
  assert.equal(xbl.Properties.AuthMethod, 'RPS')
  assert.equal(xbl.RelyingParty, 'http://auth.xboxlive.com')

  const xsts = JSON.parse(fetchImpl.calls[1].body)
  assert.deepEqual(xsts.Properties.UserTokens, ['XBL-TOKEN'])
  assert.equal(xsts.Properties.SandboxId, 'RETAIL')
  assert.equal(xsts.RelyingParty, 'rp://api.minecraftservices.com/')

  const mc = JSON.parse(fetchImpl.calls[2].body)
  assert.equal(mc.identityToken, 'XBL3.0 x=uhs-1;XSTS-TOKEN')

  assert.equal(fetchImpl.calls[3].headers.Authorization, 'Bearer MC-ACCESS')
})

test('token chain: a child account is explained instead of a raw XSTS failure', async () => {
  const fetchImpl = fakeFetch({
    [XBL_URL]: () => ({ body: { Token: 'XBL-TOKEN', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } }),
    [XSTS_URL]: () => ({ status: 401, body: { XErr: 2148916238, Message: '' } }),
  })

  await assert.rejects(
    () => completeTokenChain('MS-ACCESS', { fetchImpl }),
    (error) => error instanceof AuthError && error.code === 'xsts-child' && /Kinderkonto/.test(error.message),
  )
})

test('token chain: an unapproved Azure app points at the Minecraft review form', async () => {
  const fetchImpl = fakeFetch({
    [XBL_URL]: () => ({ body: { Token: 'XBL-TOKEN', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } } }),
    [XSTS_URL]: () => ({ body: { Token: 'XSTS-TOKEN' } }),
    [MC_LOGIN_URL]: () => ({
      status: 403,
      body: { path: '/authentication/login_with_xbox', errorType: 'UNAUTHORIZED', error: 'INVALID_APP_REGISTRATION' },
    }),
  })

  await assert.rejects(
    () => completeTokenChain('MS-ACCESS', { fetchImpl }),
    (error) =>
      error instanceof AuthError &&
      error.code === 'http' &&
      /HTTP 403/.test(error.message) &&
      /mce-reviewappid/.test(error.message),
  )
})

test('redirect mismatch: the Azure registration requirement is named, not hidden', async () => {
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description:
          "AADSTS50011: The redirect URI 'http://localhost:3377' specified in the request does not match the redirect URIs configured for the application.",
      },
    }),
  })

  await assert.rejects(
    () =>
      exchangeAuthorizationCode({
        code: 'AUTH-CODE',
        codeVerifier: 'verifier',
        redirectUri: 'http://localhost:3377',
        clientId: 'client-id',
        fetchImpl,
      }),
    (error) =>
      error instanceof AuthError &&
      error.code === 'redirect-mismatch' &&
      /http:\/\/localhost:3377/.test(error.message) &&
      /öffentliche Clients/.test(error.message),
  )
})

test('redirect mismatch: a browser round-trip error maps to the same message', async () => {
  const appData = tempDir('auth-redirect')
  const { accounts, tokens, logger } = makeStores(appData)

  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl: fakeFetch({}),
    port: 0,
    openUrl: async (url) => {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(
        `${redirect}/?error=redirect_uri_mismatch&error_description=AADSTS50011%3A+bad+redirect&state=${state}`,
      )
      assert.equal(res.status, 400)
    },
  })

  await assert.rejects(
    () => service.login(),
    (error) =>
      error instanceof AuthError &&
      error.code === 'redirect-mismatch' &&
      /http:\/\/localhost:3377/.test(error.message),
  )
})

test('login: loopback redirect, full chain, encrypted storage, listener shuts down', async () => {
  const appData = tempDir('auth-login')
  const { accounts, tokens, logger } = makeStores(appData)
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-ACCESS',
      refreshToken: 'MS-REFRESH',
      refreshedMicrosoftToken: 'MS-ACCESS-2',
      refreshedRefreshToken: 'MS-REFRESH-2',
    }),
    ...chainHandlers(),
  })

  let authorizeUrl = ''
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      authorizeUrl = url
      const parsed = new URL(url)
      const state = parsed.searchParams.get('state')
      const redirect = parsed.searchParams.get('redirect_uri')
      // The browser comes straight back to the local listener.
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      assert.equal(res.status, 200)
      assert.match(await res.text(), /Anmeldung erfolgreich/)
    },
  })

  const status = await service.login()

  assert.equal(status.signedIn, true)
  assert.equal(status.pending, false)
  assert.equal(status.account.name, 'Alex')
  assert.equal(status.account.uuid, UUID)
  assert.equal(status.account.type, 'microsoft')
  assert.equal(status.account.hasRefreshToken, true)
  assert.equal(status.account.expired, false)
  assert.equal(status.account.avatar, `https://mc-heads.net/avatar/${UUID}/64`)

  // The status is sanitized: no token crosses the bridge.
  assert.equal('accessToken' in status.account, false)
  assert.equal('refreshToken' in status.account, false)
  assert.equal(JSON.stringify(status).includes('MC-ACCESS'), false)
  assert.equal(/"(accessToken|refreshToken|access_token|refresh_token|token)"/.test(JSON.stringify(status)), false)

  // The authorize URL is the fixed loopback contract with PKCE.
  const authorize = new URL(authorizeUrl)
  assert.equal(authorize.origin + authorize.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize')
  assert.equal(authorize.searchParams.get('response_type'), 'code')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.match(authorize.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+$/)
  assert.ok(authorize.searchParams.get('scope').includes('XboxLive.signin'))

  // The code exchange carried the verifier and the same redirect.
  const tokenCall = fetchImpl.calls.find((call) => call.url === TOKEN_URL)
  const tokenParams = new URLSearchParams(tokenCall.body)
  assert.equal(tokenParams.get('grant_type'), 'authorization_code')
  assert.equal(tokenParams.get('code'), 'AUTH-CODE')
  assert.equal(tokenParams.get('redirect_uri'), authorize.searchParams.get('redirect_uri'))
  assert.ok((tokenParams.get('code_verifier') ?? '').length > 20)

  // accounts.json: metadata only.
  const stored = JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8'))
  assert.equal(stored.accounts.length, 1)
  assert.equal(stored.accounts[0].name, 'Alex')
  assert.equal(stored.accounts[0].type, 'microsoft')
  assert.equal(stored.accounts[0].provider, 'microsoft-oauth')
  assert.equal(typeof stored.accounts[0].expiresAt, 'number')
  const accountsJson = JSON.stringify(stored)
  assert.equal(accountsJson.includes('MC-ACCESS'), false)
  assert.equal(accountsJson.includes('MS-REFRESH'), false)

  // Tokens are encrypted at rest, never plaintext.
  const tokenFile = fs.readFileSync(path.join(appData, 'accounts.tokens.json'), 'utf8')
  assert.equal(tokenFile.includes('MC-ACCESS'), false)
  assert.equal(tokenFile.includes('MS-REFRESH'), false)
  const decrypted = await tokens.get(stored.accounts[0].id)
  assert.equal(decrypted.accessToken, 'MC-ACCESS')
  assert.equal(decrypted.refreshToken, 'MS-REFRESH')

  // The listener is gone: the port refuses further connections.
  const port = redirectPort(authorizeUrl)
  await assert.rejects(() => fetch(`http://localhost:${port}/?code=x&state=y`))
})

test('refresh: uses the stored refresh token and rewrites the session', async () => {
  const appData = tempDir('auth-refresh')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 1000, // stale
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-NEW',
      refreshToken: 'MS-REFRESH-NEW',
      refreshedMicrosoftToken: 'MS-NEW',
      refreshedRefreshToken: 'MS-REFRESH-NEW',
    }),
    ...chainHandlers(),
    [MC_LOGIN_URL]: () => ({ body: { access_token: 'MC-NEW', expires_in: 86_400 } }),
  })

  const service = new MicrosoftAuthService({ accounts, tokens, logger, fetchImpl, port: 0 })
  const status = await service.refresh()

  assert.equal(status.signedIn, true)
  assert.equal(status.account.expired, false)

  const refreshCall = new URLSearchParams(fetchImpl.calls[0].body)
  assert.equal(refreshCall.get('grant_type'), 'refresh_token')
  assert.equal(refreshCall.get('refresh_token'), 'MS-REFRESH')

  const stored = await tokens.get(UUID)
  assert.equal(stored.accessToken, 'MC-NEW')
  assert.equal(stored.refreshToken, 'MS-REFRESH-NEW')

  // Launch path hands out the refreshed token.
  const account = await accounts.get(UUID)
  assert.equal(await service.accessTokenFor(account), 'MC-NEW')
})

test('cancel: the attempt rejects and the loopback listener stops immediately', async () => {
  const appData = tempDir('auth-cancel')
  const { accounts, tokens, logger } = makeStores(appData)

  let port = 0
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl: fakeFetch({}),
    port: 0,
    openUrl: async (url) => {
      port = redirectPort(url)
    },
  })

  const attempt = service.login()
  await waitFor(() => port !== 0)
  assert.equal(service.cancel(), true)
  await assert.rejects(attempt, (error) => error instanceof AuthError && error.code === 'cancelled')
  await assert.rejects(() => fetch(`http://localhost:${port}/?code=x&state=y`))

  // A second cancel has nothing left to stop.
  assert.equal(service.cancel(), false)
})

test('a second login while one is pending is refused and leaves the first attempt alone', async () => {
  const appData = tempDir('auth-second-login')
  const { accounts, tokens, logger } = makeStores(appData)
  let opens = 0
  let firstRedirect = ''
  let firstState = ''
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl: fakeFetch({}),
    port: 0,
    openUrl: async (url) => {
      opens += 1
      // Only a missing admission guard lets a second flow reach the browser.
      if (opens > 1) throw new Error('a second browser was opened')
      const parsed = new URL(url)
      firstRedirect = parsed.searchParams.get('redirect_uri')
      firstState = parsed.searchParams.get('state')
    },
  })

  const first = service.login()
  first.catch(() => undefined)
  try {
    await waitFor(() => opens === 1)
    await assert.rejects(
      () => service.login(),
      (error) => error instanceof AuthError && error.code === 'pending',
    )
    assert.equal(opens, 1, 'the refused login never reached the browser')
    assert.equal((await service.status()).pending, true)

    // The first attempt still owns its listener and cancels normally.
    assert.equal(service.cancel(), true)
    await assert.rejects(first, (error) => error instanceof AuthError && error.code === 'cancelled')
    assert.equal((await service.status()).pending, false)
  } finally {
    service.cancel()
    // Without the guard the second attempt took the slot, so cancel() cannot
    // reach the first; answer its redirect to settle it either way.
    if (firstRedirect) {
      await fetch(`${firstRedirect}/?error=access_denied&state=${firstState}`).catch(() => undefined)
    }
    await first.catch(() => undefined)
  }
})

test('sign-out: metadata and encrypted tokens are both removed', async () => {
  const appData = tempDir('auth-signout')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    accessToken: 'MC-ACCESS',
    refreshToken: 'MS-REFRESH',
  })
  assert.equal((await tokens.get(UUID)).refreshToken, 'MS-REFRESH')

  const service = new MicrosoftAuthService({ accounts, tokens, logger, port: 0 })
  const status = await service.signOut()

  assert.equal(status.signedIn, false)
  assert.equal(status.account, null)
  assert.equal(await tokens.get(UUID), undefined)
  const stored = JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8'))
  assert.deepEqual(stored.accounts, [])

  // Signing out twice is harmless.
  assert.equal((await service.signOut()).signedIn, false)
})

test('sign-out during a background refresh: neither path writes the account back', async () => {
  // The two calls that answer before the guard: the token endpoint and the
  // Minecraft profile. Signing out there must leave nothing behind.
  for (const origin of ['restore', 'launch']) {
    for (const moment of ['token', 'profile']) {
      const arm = `${origin}@${moment}`
      const appData = tempDir(`auth-race-${origin}-${moment}`)
      const { accounts, tokens, logger } = makeStores(appData)
      await accounts.upsert({
        id: UUID,
        name: 'Alex',
        uuid: UUID,
        type: 'microsoft',
        active: true,
        expiresAt: Date.now() - 60_000,
        accessToken: 'MC-OLD',
        refreshToken: 'MS-REFRESH',
      })

      const at = gate()
      const fetchImpl = fakeFetch({
        [TOKEN_URL]: async () => {
          if (moment === 'token') {
            at.hit()
            await at.open
          }
          return { body: { access_token: 'MS-NEW', refresh_token: 'MS-REFRESH-2', expires_in: 3600 } }
        },
        ...chainHandlers(),
        [PROFILE_URL]: async () => {
          if (moment === 'profile') {
            at.hit()
            await at.open
          }
          return { body: { id: UUID, name: 'Alex' } }
        },
      })

      const service = new MicrosoftAuthService({
        accounts,
        tokens,
        logger,
        fetchImpl,
        port: 0,
        openUrl: async (url) => {
          const parsed = new URL(url)
          const redirect = parsed.searchParams.get('redirect_uri')
          const state = parsed.searchParams.get('state')
          const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
          await res.text()
        },
      })
      const account = await accounts.get(UUID)
      const inFlight = origin === 'restore' ? service.restore() : service.accessTokenFor(account)
      await at.reached

      await service.signOut()
      at.release()
      await inFlight

      assert.deepEqual(await accounts.list(), [], `${arm}: account in memory`)
      assert.equal(await tokens.get(UUID), undefined, `${arm}: tokens in memory`)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8')).accounts,
        [],
        `${arm}: accounts.json`,
      )
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(appData, 'accounts.tokens.json'), 'utf8')).entries[UUID],
        undefined,
        `${arm}: token file`,
      )
      const status = await service.status()
      assert.equal(status.signedIn, false, `${arm}: still signed in`)
      assert.equal(status.account, null, `${arm}: account still reported`)
      assert.equal(status.pending, false, `${arm}: pending attempt`)

      // Nothing from the discarded refresh blocks a fresh sign-in.
      assert.equal((await service.login()).signedIn, true, `${arm}: re-sign-in`)
    }
  }
})

test('sign-out: a session write that already started lands before the removal', async () => {
  const appData = tempDir('auth-signout-write')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  // Hold the store write open: this is the window after the guard has passed.
  const write = gate()
  const upsert = accounts.upsert.bind(accounts)
  accounts.upsert = async (input) => {
    write.hit()
    await write.open
    return upsert(input)
  }

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({
      body: { access_token: 'MS-NEW', refresh_token: 'MS-REFRESH-2', expires_in: 3600 },
    }),
    ...chainHandlers(),
  })
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      await res.text()
    },
  })

  const inFlight = service.restore()
  await write.reached

  let signedOut = false
  const signingOut = service.signOut().then(() => {
    signedOut = true
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  // The write still owns the account: sign-out must not resolve past it.
  assert.equal(signedOut, false, 'sign-out resolved while a session write was in flight')
  write.release()
  await signingOut
  await inFlight

  assert.deepEqual(await accounts.list(), [])
  assert.equal(await tokens.get(UUID), undefined)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8')).accounts,
    [],
  )
  assert.equal((await service.status()).pending, false)

  // Signing in again afterwards is not blocked by the race.
  accounts.upsert = upsert
  const back = await service.login()
  assert.equal(back.signedIn, true)
  assert.equal(back.account.name, 'Alex')
})

test('a refresh that joins an in-flight rotation keeps the renewed session', async () => {
  const appData = tempDir('auth-rotation-shared')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  // Hold the winner's write open: the other callers arrive mid-rotation.
  const write = gate()
  const upsert = accounts.upsert.bind(accounts)
  accounts.upsert = async (input) => {
    write.hit()
    await write.open
    return upsert(input)
  }

  // Microsoft rotates the refresh token: only the first caller may spend it.
  let tokenCalls = 0
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => {
      tokenCalls += 1
      if (tokenCalls > 1) return { status: 400, body: { error: 'invalid_grant' } }
      return {
        body: { access_token: 'MS-NEW', refresh_token: 'MS-REFRESH-2', expires_in: 3600 },
      }
    },
    ...chainHandlers(),
    [MC_LOGIN_URL]: () => ({ body: { access_token: 'MC-NEW', expires_in: 86_400 } }),
  })
  const service = new MicrosoftAuthService({ accounts, tokens, logger, fetchImpl, port: 0 })
  const account = await accounts.get(UUID)

  const restoring = service.restore()
  await write.reached
  // A manual refresh and the launch path arrive while that rotation is writing.
  const manual = service.refresh()
  const launch = service.accessTokenFor(account)
  await new Promise((resolve) => setTimeout(resolve, 25))

  write.release()
  const [restored, refreshed] = await Promise.all([restoring, manual])
  const launchToken = await launch

  assert.equal(tokenCalls, 1, 'the callers shared one rotation')
  assert.equal(restored.signedIn, true)
  assert.equal(refreshed.signedIn, true)
  assert.equal(launchToken, 'MC-NEW')

  const list = await accounts.list()
  assert.equal(list.length, 1, 'account in memory')
  assert.equal(list[0].name, 'Alex')
  const stored = await tokens.get(UUID)
  assert.equal(stored?.accessToken, 'MC-NEW', 'tokens in memory')
  assert.equal(stored?.refreshToken, 'MS-REFRESH-2')
  const file = JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8'))
  assert.equal(file.accounts.length, 1, 'accounts.json')
  assert.equal(file.accounts[0].name, 'Alex')

  const status = await service.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.pending, false)

  // Sign-out still clears the renewed session afterwards.
  assert.equal((await service.signOut()).signedIn, false)
})

test('a stale invalid_grant does not drop a session a login renewed', async () => {
  const appData = tempDir('auth-stale-drop')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  // The rotation is still on the network when the browser sign-in completes.
  const at = gate()
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: (init) => {
      const grant = new URLSearchParams(String(init.body)).get('grant_type')
      if (grant !== 'refresh_token') {
        return { body: { access_token: 'MS-LOGIN', refresh_token: 'MS-LOGIN-R', expires_in: 3600 } }
      }
      at.hit()
      return at.open.then(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    },
    ...chainHandlers(),
    [MC_LOGIN_URL]: () => ({ body: { access_token: 'MC-LOGIN', expires_in: 86_400 } }),
  })
  const pushes = []
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    onSessionLost: (status) => pushes.push(status.signedIn),
    openUrl: async (url) => {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      await res.text()
    },
  })

  const stale = service.refresh()
  await at.reached
  const signedIn = await service.login()
  assert.equal(signedIn.signedIn, true)

  at.release()
  const staleStatus = await stale

  // The failed rotation spent a token the login has already replaced.
  assert.equal(staleStatus.signedIn, true)
  assert.deepEqual(pushes, [])
  const list = await accounts.list()
  assert.equal(list.length, 1, 'account in memory')
  assert.equal(list[0].name, 'Alex')
  const stored = await tokens.get(UUID)
  assert.equal(stored?.accessToken, 'MC-LOGIN', 'tokens in memory')
  assert.equal(stored?.refreshToken, 'MS-LOGIN-R')
  const file = JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8'))
  assert.equal(file.accounts.length, 1, 'accounts.json')
  assert.equal(file.accounts[0].name, 'Alex')

  const status = await service.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.pending, false)
})

test('a stale drop yields to a login writing the same account, not another', async () => {
  const OTHER = 'fedcba9876543210fedcba9876543210'
  const loopback = async (url) => {
    const parsed = new URL(url)
    const redirect = parsed.searchParams.get('redirect_uri')
    const state = parsed.searchParams.get('state')
    const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
    await res.text()
  }
  const loginFetch = (profile, loginToken) =>
    fakeFetch({
      [TOKEN_URL]: (init) => {
        const grant = new URLSearchParams(String(init.body)).get('grant_type')
        if (grant === 'authorization_code') {
          return { body: { access_token: 'MS-LOGIN', refresh_token: 'MS-LOGIN-R', expires_in: 3600 } }
        }
        return { status: 400, body: { error: 'invalid_grant' } }
      },
      ...chainHandlers(profile),
      [MC_LOGIN_URL]: () => ({ body: { access_token: loginToken, expires_in: 86_400 } }),
    })

  // Same account: the login's write is in flight when the stale rotation fails.
  {
    const appData = tempDir('auth-login-write-same')
    const { accounts, tokens, logger } = makeStores(appData)
    await accounts.upsert({
      id: UUID,
      name: 'Alex',
      uuid: UUID,
      type: 'microsoft',
      active: true,
      expiresAt: Date.now() - 60_000,
      accessToken: 'MC-OLD',
      refreshToken: 'MS-REFRESH',
    })
    const write = gate()
    const upsert = accounts.upsert.bind(accounts)
    accounts.upsert = async (input) => {
      write.hit()
      await write.open
      return upsert(input)
    }
    const pushes = []
    const service = new MicrosoftAuthService({
      accounts,
      tokens,
      logger,
      fetchImpl: loginFetch({ id: UUID, name: 'Alex' }, 'MC-LOGIN'),
      port: 0,
      onSessionLost: (status) => pushes.push(status.signedIn),
      openUrl: loopback,
    })

    const login = service.login()
    await write.reached
    const staleStatus = await service.refresh()
    write.release()
    const signedIn = await login

    assert.equal(signedIn.signedIn, true)
    assert.equal(staleStatus.signedIn, true, 'the stale rotation leaves the login alone')
    assert.deepEqual(pushes, [], 'no signed-out push while the login writes')
    const stored = await tokens.get(UUID)
    assert.equal(stored?.accessToken, 'MC-LOGIN')
    assert.equal(stored?.refreshToken, 'MS-LOGIN-R')
    assert.equal((await accounts.list()).length, 1)
    assert.equal((await service.status()).pending, false)
  }

  // Different account: the login must not shield the account whose token died.
  {
    const appData = tempDir('auth-login-write-other')
    const { accounts, tokens, logger } = makeStores(appData)
    await accounts.upsert({
      id: UUID,
      name: 'Alex',
      uuid: UUID,
      type: 'microsoft',
      active: true,
      expiresAt: Date.now() - 60_000,
      accessToken: 'MC-OLD',
      refreshToken: 'MS-REFRESH',
    })
    const write = gate()
    const upsert = accounts.upsert.bind(accounts)
    accounts.upsert = async (input) => {
      write.hit()
      await write.open
      return upsert(input)
    }
    const pushes = []
    const service = new MicrosoftAuthService({
      accounts,
      tokens,
      logger,
      fetchImpl: loginFetch({ id: OTHER, name: 'Bea' }, 'MC-BEA'),
      port: 0,
      onSessionLost: (status) => pushes.push(status.signedIn),
      openUrl: loopback,
    })

    const login = service.login()
    await write.reached
    const staleStatus = await service.refresh()
    write.release()
    const signedIn = await login

    assert.equal(signedIn.signedIn, true)
    assert.equal(staleStatus.signedIn, false, 'the dead session is still dropped')
    assert.deepEqual(pushes, [false])
    const list = await accounts.list()
    assert.deepEqual(list.map((entry) => entry.id), [OTHER])
    assert.equal(list[0].name, 'Bea')
    assert.equal(await tokens.get(UUID), undefined)
  }
})

test('one failed rotation drops once and pushes once for every joined caller', async () => {
  const appData = tempDir('auth-rotation-loss')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const at = gate()
  let tokenCalls = 0
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => {
      tokenCalls += 1
      at.hit()
      return at.open.then(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    },
  })
  const pushes = []
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    onSessionLost: (status) => pushes.push(status.signedIn),
  })
  const account = await accounts.get(UUID)

  const restoring = service.restore()
  const refreshing = service.refresh()
  const launching = service.accessTokenFor(account)
  await at.reached
  await new Promise((resolve) => setTimeout(resolve, 25))
  at.release()
  const [restored, refreshed, launchToken] = await Promise.all([restoring, refreshing, launching])

  assert.equal(tokenCalls, 1, 'the callers shared one rotation')
  assert.deepEqual(pushes, [false], 'one signed-out push for the loss')
  assert.equal(restored.signedIn, false)
  assert.equal(refreshed.signedIn, false)
  assert.equal(launchToken, undefined)
  assert.deepEqual(await accounts.list(), [])
  assert.equal(await tokens.get(UUID), undefined)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8')).accounts,
    [],
  )
  const status = await service.status()
  assert.equal(status.signedIn, false)
  assert.equal(status.pending, false)
})

test('core start: a stored session is restored without user input', async () => {
  const appData = tempDir('auth-restore')
  const box = makeBox()
  const logger = createNullLogger()
  const tokens = new TokenStore(path.join(appData, 'accounts.tokens.json'), box, logger)
  const accounts = new AccountStore(path.join(appData, 'accounts.json'), tokens, logger)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-NEW',
      refreshToken: 'MS-REFRESH',
      refreshedMicrosoftToken: 'MS-NEW',
      refreshedRefreshToken: 'MS-REFRESH-2',
    }),
    ...chainHandlers(),
    [MC_LOGIN_URL]: () => ({ body: { access_token: 'MC-RESTORED', expires_in: 86_400 } }),
  })

  const core = await createCore({
    appDataPath: appData,
    safeStorage: box,
    logger,
    fetchImpl,
    authPort: 0,
  })

  assert.equal(typeof core.auth.login, 'function')
  // Tokens and account metadata are written back to back; wait for both.
  await waitFor(async () => {
    const account = await core.accounts.get(UUID)
    return (
      (await core.tokens.get(UUID))?.accessToken === 'MC-RESTORED' &&
      typeof account?.expiresAt === 'number' &&
      account.expiresAt > Date.now()
    )
  })

  const status = await core.auth.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.account?.expired, false)
  assert.equal((await core.getLaunchIdentity()).accessToken, 'MC-RESTORED')
})

test('refresh: an invalid_grant signs the account out instead of keeping a zombie', async () => {
  const appData = tempDir('auth-invalid-grant')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 1000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  })
  const service = new MicrosoftAuthService({ accounts, tokens, logger, fetchImpl, port: 0 })

  const status = await service.refresh()

  assert.equal(status.signedIn, false)
  assert.equal(status.account, null)
  assert.equal(status.pending, false)
  // One attempt, no retry loop on a final grant rejection.
  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(await accounts.list(), [])
  assert.equal(await tokens.get(UUID), undefined)
  const stored = JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8'))
  assert.deepEqual(stored.accounts, [])
})

test('launch path: a rejected refresh never hands the expired token to the game', async () => {
  const appData = tempDir('auth-invalid-launch')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 1000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  })
  const service = new MicrosoftAuthService({ accounts, tokens, logger, fetchImpl, port: 0 })
  const account = await accounts.get(UUID)

  assert.equal(await service.accessTokenFor(account), undefined)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal((await service.status()).signedIn, false)
})

test('core start: an invalid_grant clears the dead session', async () => {
  const appData = tempDir('auth-restore-invalid')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  })
  const pushed = []
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    onSessionLost: (status) => pushed.push(status),
  })

  const status = await service.restore()

  assert.equal(status.signedIn, false)
  assert.equal(status.account, null)
  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(await accounts.list(), [])
  // The background loss is pushed once, sanitized, so an open tab can follow.
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].signedIn, false)
  assert.equal(pushed[0].account, null)
  assert.equal(pushed[0].pending, false)
  assert.equal(JSON.stringify(pushed[0]).includes('MC-OLD'), false)
  assert.equal(JSON.stringify(pushed[0]).includes('MS-REFRESH'), false)
})

test('core start: an unreachable Microsoft keeps the stored session', async () => {
  const appData = tempDir('auth-restore-offline')
  const { accounts, tokens, logger } = makeStores(appData)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REFRESH',
  })

  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    throw new Error('network unreachable')
  }
  const service = new MicrosoftAuthService({ accounts, tokens, logger, fetchImpl, port: 0 })

  const status = await service.restore()

  assert.equal(status.signedIn, true)
  assert.equal(status.account.name, 'Alex')
  assert.equal(status.account.expired, true)
  assert.equal(status.pending, false)
  assert.equal(attempts, 1)
  // Nothing was removed: the user is not silently signed out while offline.
  assert.equal((await accounts.list()).length, 1)
  assert.equal((await tokens.get(UUID)).refreshToken, 'MS-REFRESH')
})

test('sign-out: a login still waiting for the browser is cancelled', async () => {
  const appData = tempDir('auth-signout-pending')
  const { accounts, tokens, logger } = makeStores(appData)
  let port = 0
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl: fakeFetch({}),
    port: 0,
    openUrl: async (url) => {
      port = redirectPort(url)
    },
  })

  const attempt = service.login()
  await waitFor(() => port !== 0)
  // Attach the rejection expectation before cancelling, otherwise the
  // cancelled attempt is briefly an unhandled rejection.
  const cancelled = assert.rejects(
    attempt,
    (error) => error instanceof AuthError && error.code === 'cancelled',
  )
  const status = await service.signOut()

  assert.equal(status.signedIn, false)
  await cancelled
  assert.equal((await service.status()).pending, false)
  await assert.rejects(() => fetch(`http://localhost:${port}/?code=x&state=y`))
})

test('sign-out then sign-in: a fresh attempt signs in once, through the same port', async () => {
  const appData = tempDir('auth-signout-login')
  const { accounts, tokens, logger } = makeStores(appData)
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-ACCESS',
      refreshToken: 'MS-REFRESH',
      refreshedMicrosoftToken: 'MS-ACCESS-2',
      refreshedRefreshToken: 'MS-REFRESH-2',
    }),
    ...chainHandlers(),
  })
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      assert.equal(res.status, 200)
      await res.text()
    },
  })

  assert.equal((await service.login()).signedIn, true)
  assert.equal((await service.signOut()).signedIn, false)

  const second = await service.login()
  assert.equal(second.signedIn, true)
  assert.equal(second.account.name, 'Alex')
  assert.equal((await accounts.list()).length, 1)
  assert.equal((await tokens.get(UUID)).refreshToken, 'MS-REFRESH')
})

test('status: only https avatars reach the UI', async () => {
  const appData = tempDir('auth-avatar')
  const { accounts, tokens, logger } = makeStores(appData)
  const fallback = `https://mc-heads.net/avatar/${UUID}/64`
  const service = new MicrosoftAuthService({ accounts, tokens, logger, port: 0 })

  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    avatar: 'http://insecure.test/a.png',
    accessToken: 'MC',
    refreshToken: 'MS',
  })
  assert.equal((await service.status()).account.avatar, fallback)

  await accounts.upsert({ id: UUID, avatar: 'https://cdn.test/a.png' })
  assert.equal((await service.status()).account.avatar, 'https://cdn.test/a.png')

  await accounts.upsert({ id: UUID, avatar: 'not a url' })
  assert.equal((await service.status()).account.avatar, fallback)
})

test('scenario 1: a token that expires while the launcher is open is renewed before the launch', async () => {
  const appData = tempDir('scenario-expiry-launch')
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-NEW',
      refreshToken: 'MS-REF-NEW',
      refreshedMicrosoftToken: 'MS-NEW',
      refreshedRefreshToken: 'MS-REF-NEW',
    }),
    ...launchChain('MC-NEW'),
  })
  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger: createNullLogger(),
    authPort: 0,
    fetchImpl,
  })
  // Comfortably outside the 5 minute safety margin; the aging is simulated
  // explicitly below so the test never races a wall-clock window.
  const margin = 5 * 60 * 1000
  await core.accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() + margin + 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REF',
  })

  const captured = []
  stubLaunch(core, captured)

  // Launch while the token is still good: no refresh, stored token is used.
  await core.launchInstance({ instanceId: 'inst-demo' })
  assert.equal(captured[0].accessToken, 'MC-OLD')
  assert.equal(fetchImpl.calls.length, 0)

  // The launcher stays open; move the stored expiry inside the margin.
  await core.accounts.upsert({ id: UUID, expiresAt: Date.now() + margin - 1_000 })
  captured.length = 0
  await core.launchInstance({ instanceId: 'inst-demo' })

  // The launch path got the renewed token, not the stale one.
  assert.equal(captured[0].accessToken, 'MC-NEW')
  assert.equal(fetchImpl.calls.filter((call) => call.url === TOKEN_URL).length, 1)
  const stored = await core.accounts.getToken(UUID)
  assert.equal(stored.accessToken, 'MC-NEW')
  assert.equal(stored.refreshToken, 'MS-REF-NEW')
  assert.ok((await core.accounts.get(UUID)).expiresAt > Date.now())

  // Refresh session from the Konto tab reports a live session afterwards.
  const refreshed = await core.auth.refresh()
  assert.equal(refreshed.signedIn, true)
  assert.equal(refreshed.account.expired, false)

  // accounts.json stays metadata only, with either token.
  const metadata = fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8')
  assert.equal(metadata.includes('MC-OLD'), false)
  assert.equal(metadata.includes('MC-NEW'), false)
  assert.equal(metadata.includes('MS-REF'), false)
})

test('scenario 2: an invalid_grant ends in a signed-out state, without a retry loop', async () => {
  const appData = tempDir('scenario-invalid-grant')
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  })
  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger: createNullLogger(),
    authPort: 0,
    fetchImpl,
  })
  await core.accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 1000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REF',
  })
  const handlers = new Map()
  registerIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, core)
  const trusted = { senderFrame: { url: 'file:///index.html' } }

  // "Sitzung aktualisieren" goes through the same channel the panel uses.
  const status = await handlers.get('bamboo:auth:refresh')(trusted)
  assert.equal(status.signedIn, false)
  assert.equal(status.account, null)
  assert.equal(status.pending, false)
  assert.equal(fetchImpl.calls.length, 1)

  // The next read is a plain status call: no retry, no network.
  assert.equal((await handlers.get('bamboo:auth:status')(trusted)).signedIn, false)
  assert.equal(fetchImpl.calls.length, 1)

  // The dead session is gone from both stores.
  assert.deepEqual(await core.accounts.list(), [])
  assert.equal(await core.accounts.getToken(UUID), undefined)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(appData, 'accounts.json'), 'utf8')).accounts,
    [],
  )

  // And the launch path cannot pick the removed session up again.
  const captured = []
  stubLaunch(core, captured)
  await assert.rejects(() => core.launchInstance({ instanceId: 'inst-demo' }), /Kein Account gewählt/)
  assert.equal(captured.length, 0)
})

test('scenario 2: a launch that hits invalid_grant is refused instead of starting tokenless', async () => {
  const appData = tempDir('scenario-invalid-grant-launch')
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: () => ({ status: 400, body: { error: 'invalid_grant' } }),
  })
  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger: createNullLogger(),
    authPort: 0,
    fetchImpl,
  })
  await core.accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 1000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REF',
  })
  const captured = []
  stubLaunch(core, captured)

  await assert.rejects(
    () => core.launchInstance({ instanceId: 'inst-demo' }),
    /Microsoft-Sitzung ist abgelaufen/,
  )
  // No game process was started, with or without the old token.
  assert.equal(captured.length, 0)
  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(await core.accounts.list(), [])
})

test('scenario 3: a cold start offline keeps the session and shows it as expired', async () => {
  const appData = tempDir('scenario-offline-start')
  const box = makeBox()
  const logger = createNullLogger()
  const tokens = new TokenStore(path.join(appData, 'accounts.tokens.json'), box, logger)
  const accounts = new AccountStore(path.join(appData, 'accounts.json'), tokens, logger)
  await accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() - 60_000,
    accessToken: 'MC-OLD',
    refreshToken: 'MS-REF',
  })

  let attempts = 0
  const fetchImpl = async () => {
    attempts += 1
    throw new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')
  }
  const startedAt = Date.now()
  const core = await createCore({ appDataPath: appData, safeStorage: box, logger, authPort: 0, fetchImpl })
  const startupMs = Date.now() - startedAt
  // The restore runs in the background; it must not hold up the core/window.
  assert.ok(startupMs < 2000, `core startup took ${startupMs} ms`)

  const first = await core.auth.status()
  assert.equal(first.signedIn, true)
  assert.equal(first.account.expired, true)
  assert.equal(first.account.name, 'Alex')

  // Let the failed refresh settle: nothing is removed, nobody is signed out.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const settled = await core.auth.status()
  assert.equal(settled.signedIn, true)
  assert.equal(settled.account.name, 'Alex')
  assert.equal(settled.pending, false)
  assert.equal(attempts, 1)
  assert.equal((await accounts.list()).length, 1)
  assert.equal((await tokens.get(UUID)).refreshToken, 'MS-REF')

  // The stored token still feeds an offline launch instead of blocking it.
  const identity = await core.getLaunchIdentity()
  assert.equal(identity.name, 'Alex')
  assert.equal(identity.accessToken, 'MC-OLD')
})

test('scenario 4: sign out while the browser flow is open, then sign in immediately', async () => {
  const appData = tempDir('scenario-signout-pending')
  const { accounts, tokens, logger } = makeStores(appData)
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: tokenHandler({
      microsoftToken: 'MS-ACCESS',
      refreshToken: 'MS-REFRESH',
      refreshedMicrosoftToken: 'MS-ACCESS',
      refreshedRefreshToken: 'MS-REFRESH',
    }),
    ...chainHandlers(),
  })
  let navigations = 0
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      navigations += 1
      // The first attempt leaves the browser open; the second comes back.
      if (navigations === 1) return
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      await res.text()
    },
  })

  const first = service.login()
  first.catch(() => undefined)
  const cancelled = assert.rejects(first, (error) => error instanceof AuthError && error.code === 'cancelled')
  cancelled.catch(() => undefined)
  await waitFor(() => navigations === 1)

  const signedOut = await service.signOut()
  assert.equal(signedOut.signedIn, false)
  // No zombie attempt: the status is settled when sign-out resolves.
  assert.equal(signedOut.pending, false)
  await cancelled

  // Signing in right afterwards is not rejected as "pending" and reuses the port.
  const second = await service.login()
  assert.equal(second.signedIn, true)
  assert.equal(second.account.name, 'Alex')
  assert.equal(navigations, 2)
  assert.equal((await accounts.list()).length, 1)
  assert.equal((await tokens.get(UUID)).refreshToken, 'MS-REFRESH')
})

test('scenario 4: cancelling after Microsoft returned the code cannot sign in behind it', async () => {
  const appData = tempDir('scenario-cancel-after-code')
  const { accounts, tokens, logger } = makeStores(appData)
  let releaseToken
  const tokenGate = new Promise((resolve) => {
    releaseToken = resolve
  })
  let tokenReached
  const tokenCall = new Promise((resolve) => {
    tokenReached = resolve
  })
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: async () => {
      tokenReached()
      await tokenGate
      return { body: { access_token: 'MS-ACCESS', refresh_token: 'MS-REFRESH', expires_in: 3600 } }
    },
    ...chainHandlers(),
  })
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      const parsed = new URL(url)
      const redirect = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
      await res.text()
    },
  })

  const attempt = service.login()
  attempt.catch(() => undefined)
  const cancelled = assert.rejects(attempt, (error) => error instanceof AuthError && error.code === 'cancelled')
  cancelled.catch(() => undefined)

  // Microsoft already redirected; the token exchange is in flight.
  await tokenCall
  assert.equal(service.cancel(), true)
  releaseToken()
  await cancelled

  assert.equal((await service.status()).signedIn, false)
  assert.equal((await service.status()).pending, false)
  assert.deepEqual(await accounts.list(), [])
  assert.equal(await tokens.get(UUID), undefined)
})

test('scenario 4: signing out during the token exchange does not resurrect the account', async () => {
  const appData = tempDir('scenario-signout-exchange')
  const { accounts, tokens, logger } = makeStores(appData)
  let releaseToken
  const tokenGate = new Promise((resolve) => {
    releaseToken = resolve
  })
  let tokenReached
  const tokenCall = new Promise((resolve) => {
    tokenReached = resolve
  })
  const fetchImpl = fakeFetch({
    [TOKEN_URL]: async () => {
      tokenReached()
      await tokenGate
      return { body: { access_token: 'MS-ACCESS', refresh_token: 'MS-REFRESH', expires_in: 3600 } }
    },
    ...chainHandlers(),
  })
  let navigations = 0
  const service = new MicrosoftAuthService({
    accounts,
    tokens,
    logger,
    fetchImpl,
    port: 0,
    openUrl: async (url) => {
      navigations += 1
      await openLoopback(url)
    },
  })
  async function openLoopback(url) {
    const parsed = new URL(url)
    const redirect = parsed.searchParams.get('redirect_uri')
    const state = parsed.searchParams.get('state')
    const res = await fetch(`${redirect}/?code=AUTH-CODE&state=${state}`)
    await res.text()
  }

  const attempt = service.login()
  attempt.catch(() => undefined)
  const cancelled = assert.rejects(attempt, (error) => error instanceof AuthError && error.code === 'cancelled')
  cancelled.catch(() => undefined)
  await tokenCall

  // Abmelden while the code is already being exchanged.
  const signOut = service.signOut()
  releaseToken()
  const signedOut = await signOut
  assert.equal(signedOut.signedIn, false)
  assert.equal(signedOut.pending, false)
  await cancelled

  // The late exchange did not write the account back.
  assert.deepEqual(await accounts.list(), [])
  assert.equal(await tokens.get(UUID), undefined)

  // And a sign-in started right afterwards works.
  const back = await service.login()
  assert.equal(back.signedIn, true)
  assert.equal((await accounts.list()).length, 1)
})

test('scenario 5: a missing or non-https skin and a 300 char name stay safe', async () => {
  const appData = tempDir('scenario-profile-shape')
  const box = makeBox()
  const logger = createNullLogger()
  const tokens = new TokenStore(path.join(appData, 'accounts.tokens.json'), box, logger)
  const longName = 'A'.repeat(300)
  const fallback = `https://mc-heads.net/avatar/${UUID}/64`

  // A stored account from an older launcher: no avatar key at all.
  fs.writeFileSync(
    path.join(appData, 'accounts.json'),
    JSON.stringify({
      version: 1,
      selectedAccountId: UUID,
      accounts: [
        {
          id: UUID,
          name: longName,
          uuid: UUID,
          type: 'microsoft',
          active: true,
          expiresAt: Date.now() + 86_400_000,
        },
      ],
    }),
    'utf8',
  )
  await tokens.set(UUID, { accessToken: 'MC', refreshToken: 'MS' })

  const core = await createCore({
    appDataPath: appData,
    safeStorage: box,
    logger,
    authPort: 0,
    fetchImpl: fakeFetch({}),
  })
  let status = await core.auth.status()
  assert.equal(status.account.name, longName)
  assert.equal(status.account.avatar, fallback)

  for (const avatar of ['http://insecure.test/skin.png', '', 'javascript:alert(1)', 'data:image/png;base64,AA']) {
    await core.accounts.upsert({ id: UUID, avatar })
    assert.equal((await core.auth.status()).account.avatar, fallback, `avatar ${avatar}`)
  }
  await core.accounts.upsert({ id: UUID, avatar: 'https://cdn.test/skin.png' })
  assert.equal((await core.auth.status()).account.avatar, 'https://cdn.test/skin.png')

  // The name itself is metadata: it survives to the launch arguments unchanged.
  const captured = []
  stubLaunch(core, captured)
  await core.launchInstance({ instanceId: 'inst-demo' })
  assert.equal(captured[0].name, longName)
})

test('settings round-trip: a stale account snapshot cannot overwrite the session', async () => {
  const appData = tempDir('auth-settings-snapshot')
  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger: createNullLogger(),
    authPort: 0,
  })
  await core.accounts.upsert({
    id: UUID,
    name: 'Alex',
    uuid: UUID,
    type: 'microsoft',
    active: true,
    expiresAt: Date.now() + 60_000,
    accessToken: 'MC',
    refreshToken: 'MS',
  })
  const fresh = await core.accounts.get(UUID)

  // The settings blob still offers the account list, but a save must ignore it:
  // the renderer's copy can predate a completed refresh or a sign-out.
  const snapshot = await core.getSettingsForRenderer()
  assert.ok(Array.isArray(snapshot.accounts))
  await core.saveSettingsFromRenderer({
    ...snapshot,
    accounts: [{ ...fresh, name: 'Stale', expiresAt: fresh.expiresAt - 60_000 }],
  })

  const after = await core.accounts.get(UUID)
  assert.equal(after.name, 'Alex')
  assert.equal(after.expiresAt, fresh.expiresAt)
})

test('bridge: preload auth API hits the registered IPC channels', async () => {
  const appData = tempDir('auth-bridge')
  const handlers = new Map()
  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger: createNullLogger(),
    authPort: 0,
  })
  registerIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, core)

  const invoked = []
  const exposed = {}
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, api) => Object.assign(exposed, api) },
    ipcRenderer: {
      sendSync: () => ({}),
      on: () => undefined,
      removeListener: () => undefined,
      invoke: (channel, ...args) => {
        invoked.push({ channel, args })
        return Promise.resolve(undefined)
      },
    },
  }

  const originalLoad = Module._load
  const hadWindow = 'window' in globalThis
  globalThis.window = { addEventListener: () => undefined }
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, ...rest)
  }
  try {
    require('../preload.js')
  } finally {
    Module._load = originalLoad
    if (!hadWindow) delete globalThis.window
  }

  await exposed.auth.status()
  await exposed.auth.login()
  await exposed.auth.cancel()
  await exposed.auth.refresh('acc-1')
  await exposed.auth.signOut('acc-1')

  const channels = invoked.map((entry) => entry.channel)
  assert.deepEqual(channels, [
    'bamboo:auth:status',
    'bamboo:auth:login',
    'bamboo:auth:cancel',
    'bamboo:auth:refresh',
    'bamboo:auth:sign-out',
  ])
  for (const channel of channels) assert.ok(handlers.has(channel), `${channel} must be registered`)

  // Through the real handler: signed out, sanitized, no credentials.
  const status = await handlers.get('bamboo:auth:status')({
    senderFrame: { url: 'file:///app/index.html' },
  })
  assert.equal(status.signedIn, false)
  assert.equal(status.account, null)
  assert.equal(status.pending, false)
})

test('renderer read: a missing core bridge is unavailable, not signed out', async () => {
  const root = path.join(__dirname, '..')
  const { readAuthStatus, AuthUnavailableError } = await import(
    pathToFileURL(path.join(root, 'src/lib/accountSession.ts')).href
  )

  // No preload bridge at all, or a preload without the auth API.
  await assert.rejects(() => readAuthStatus(undefined), AuthUnavailableError)
  await assert.rejects(() => readAuthStatus({}), AuthUnavailableError)
  // The bridge exists but the core never registered the channel.
  await assert.rejects(
    () =>
      readAuthStatus({
        status: () =>
          Promise.reject(
            new Error(
              "Error invoking remote method 'bamboo:auth:status': Error: No handler registered for 'bamboo:auth:status'",
            ),
          ),
      }),
    AuthUnavailableError,
  )

  // A temporary failure keeps the last known status instead of "no auth".
  assert.equal(
    await readAuthStatus({
      status: async () => {
        throw new Error('IPC pipe closed')
      },
    }),
    null,
  )
  const status = {
    signedIn: true,
    pending: false,
    tokenStoreDegraded: false,
    account: { id: 'mc-uuid', name: 'Alex', uuid: 'mc-uuid', type: 'microsoft', active: true, avatar: 'https://x.test/a.png', expired: false, hasRefreshToken: true },
  }
  assert.equal(await readAuthStatus({ status: async () => status }), status)

  // One unavailable state, rendered before the signed-out card (and its raw errors).
  const panel = fs.readFileSync(path.join(root, 'src/components/settings/AccountsPanel.tsx'), 'utf8')
  assert.match(panel, /if \(session\.unavailable\)/)
  assert.match(panel, /Microsoft-Anmeldung nicht verfügbar/)
})

test('single auth implementation: no legacy device-code channel remains', () => {
  const root = path.join(__dirname, '..')
  const files = ['main.js', 'preload.js']
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx|js)$/.test(entry.name)) files.push(path.relative(root, full))
    }
  }
  walk(path.join(root, 'src'))
  walk(path.join(root, 'electron'))

  // The removed device-code flow: main handler, bridge channels and typings.
  const removed = /microsoft-login-device-code|ms-device-code|ms-login-step|ms-login-result|startMicrosoftLogin|onMsDeviceCode|onMsLoginStep|onMsLoginResult/
  const offenders = files.filter((file) => removed.test(fs.readFileSync(path.join(root, file), 'utf8')))

  assert.deepEqual(offenders, [], 'legacy Microsoft login channels must stay removed')
})

test('renderer ownership: one mapping, one status holder, every consumer derives from it', async () => {
  const root = path.join(__dirname, '..')
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(path.join(root, 'src'))

  // Only the session hook may read or hold the auth status. A second copy
  // anywhere is how the panel and the shell used to disagree.
  const readers = files.filter((file) => /readAuthStatus\(/.test(read(file)))
  assert.deepEqual(readers, ['src/lib/accountSession.ts'], 'only the session hook may read the auth status')
  const holders = files.filter((file) => /useState<MicrosoftAuthStatus/.test(read(file)))
  assert.deepEqual(holders, ['src/lib/accountSession.ts'], 'only the session hook may hold the auth status')

  // Exactly one mapping from the sanitized status to the UI account shape, and
  // no second copy of "who is signed in" hiding in the settings blob.
  const mappers = files.filter((file) => /accountFromStatus/.test(read(file)))
  assert.deepEqual(mappers, ['src/lib/accountSession.ts'], 'the account mapping must exist exactly once')
  const blobOwners = files.filter((file) =>
    /settings\.accounts|mapAccountFromSettings|setActiveAccount/.test(read(file)),
  )
  assert.deepEqual(blobOwners, [], 'the settings blob must not own accounts')

  // The shell derives the account once and hands that same value to TopBar,
  // the dashboard and the Konto tab (via the session), so one render moves all.
  const app = read('src/App.tsx')
  assert.equal(app.match(/useAccountSession\(\)/g)?.length, 1, 'App must own exactly one session')
  assert.equal(app.match(/accountSession\.account/g)?.length, 1, 'the account must be derived once')
  assert.ok(!/setAccounts|setActiveAccount|mapAccountFromSettings|settings\.accounts/.test(app))
  assert.match(app, /<TopBar[\s\S]{0,400}activeAccount=\{activeAccount\}/)
  assert.match(app, /<Dashboard[\s\S]{0,400}activeAccount=\{activeAccount\}/)
  assert.match(app, /<SettingsView[\s\S]+accountSession=\{accountSession\}/)

  // The Konto tab renders the shared status and keeps no copy of its own.
  const panel = read('src/components/settings/AccountsPanel.tsx')
  assert.match(panel, /const status = session\.status/)
  assert.ok(!/MicrosoftAuthStatus|setStatus|accountFromStatus/.test(panel))

  // And the mapping is metadata only: no token can ride along with it.
  const { accountFromStatus } = await import(
    pathToFileURL(path.join(root, 'src/lib/accountSession.ts')).href
  )
  const signedIn = accountFromStatus({
    signedIn: true,
    pending: false,
    tokenStoreDegraded: false,
    account: { id: 'mc-uuid', name: 'Alex', uuid: 'mc-uuid', avatar: 'https://example.test/a.png' },
  })
  assert.deepEqual(Object.keys(signedIn).sort(), [
    'active', 'avatar', 'id', 'online', 'type', 'username', 'uuid',
  ])
  assert.equal(signedIn.username, 'Alex')
  assert.equal(accountFromStatus({ signedIn: false, pending: false, tokenStoreDegraded: false, account: null }), null)
  assert.equal(accountFromStatus(null), null)
})

test('fixed defaults: redirect port 3377 and a five minute login budget', () => {
  assert.equal(REDIRECT_PORT, 3377)
  assert.equal(REDIRECT_URI, 'http://localhost:3377')
  assert.equal(REDIRECT_URI.endsWith('/'), false, 'no trailing slash')
  assert.equal(REDIRECT_URI.includes('127.0.0.1'), false, 'the URI is localhost, not 127.0.0.1')
  assert.equal(LOGIN_TIMEOUT_MS, 5 * 60 * 1000)
})

// ---------------------------------------------------------------------------
// No temporary CurseForge sign-in: the Konto tab only offers the ordinary
// Microsoft browser flow, and no hardcoded fake account exists anywhere.
// ---------------------------------------------------------------------------

const pathExists = (relative) => fs.existsSync(path.join(__dirname, '..', relative))

test('curseforge: no temporary CurseForge sign-in survives in UI or bridge', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'AccountsPanel.tsx'), 'utf8')
  assert.ok(
    !/Bei CurseForge anmelden|Temporärer Testzugang|signIn\('curseforge'\)/.test(panel),
    'the temporary CurseForge test access is gone',
  )
  assert.ok(panel.includes('.auth.login'), 'the ordinary Microsoft sign-in is the only path')
  assert.ok(!/authCurseForge|cfEmail|cfToken|passwordless/.test(panel))

  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(!/temporary-login|auth:curseforge/.test(preload), 'no temporary or CurseForge auth channel')
  assert.ok(preload.includes("login: () => invoke('bamboo:auth:login')"))

  // And neither the fake account module nor an own CurseForge auth module exists.
  assert.equal(pathExists('electron/auth/temporary.ts'), false)
  assert.equal(pathExists('electron/auth/curseforge.ts'), false)

  const ipc = fs.readFileSync(path.join(__dirname, '..', 'dist-electron', 'ipc.js'), 'utf8')
  assert.ok(!/temporary-login|auth:curseforge/.test(ipc), 'the core registers no such channel')
  assert.match(ipc, /bamboo:auth:login/)
})

test('curseforge: the hardcoded fake account from older builds is dropped on start', async () => {
  const appData = tempDir('cf-legacy')
  const { accounts, logger } = makeStores(appData)
  await accounts.upsert({
    id: 'temporary-curseforge',
    name: 'CurseForge Test',
    uuid: '8667ba71b85a4004af54457a9734eed7',
    type: 'microsoft',
    active: true,
    provider: 'curseforge-temporary',
    temporary: true,
  })

  const core = await createCore({
    appDataPath: appData,
    safeStorage: makeBox(),
    logger,
    fetchImpl: fakeFetch({}),
    authPort: 0,
  })

  assert.equal(await core.accounts.get('temporary-curseforge'), undefined)
  assert.equal((await core.accounts.list()).length, 0)
})
