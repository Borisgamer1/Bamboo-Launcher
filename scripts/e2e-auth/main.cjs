/**
 * Real-Electron end-to-end harness for the Microsoft login.
 *
 * This file is NOT part of the launcher. It is an out-of-tree test entry that
 * boots the real `main.js` in a real Electron process (real preload, real
 * core, real safeStorage/DPAPI) and doubles only the two things a local run
 * cannot own:
 *
 *   1. `globalThis.fetch` for the five Microsoft/Xbox/Minecraft endpoints -
 *      answered by a deterministic stub identity provider. Every other URL is
 *      forwarded to the genuine fetch.
 *   2. `shell.openExternal` - records the authorize URL instead of opening a
 *      browser, then plays the browser by calling the real loopback listener.
 *
 * Both doubles live only in this process. No production module knows about
 * them, no environment variable in the app enables them, and the shipped
 * launcher has no code path that can reach them.
 *
 * Modes (BAMBOO_E2E_MODE):
 *   login   - full sign-in through the loopback redirect, then on-disk proof
 *   restore - a second process on the same user data dir: silent restore
 *             including an expired access token that must refresh
 */
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { createHash } = require('node:crypto')

const startedAt = Date.now()
const ROOT = path.resolve(__dirname, '..', '..')
const MODE = process.env.BAMBOO_E2E_MODE || 'login'
const RUN = process.env.BAMBOO_E2E_RUN || 'main'
const AUTH_CHANNELS = [
  'bamboo:auth:status',
  'bamboo:auth:login',
  'bamboo:auth:cancel',
  'bamboo:auth:refresh',
  'bamboo:auth:sign-out',
]
const OUT = path.resolve(process.env.BAMBOO_E2E_OUT || path.join(ROOT, '.e2e-auth'))
const USER_DATA = path.resolve(process.env.BAMBOO_E2E_USER_DATA || path.join(OUT, 'userData'))

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)

// Scenario (3) needs the byte-exact token file from before the offline start.
const tokenFileSnapshot =
  MODE === 'offline' && fs.existsSync(path.join(USER_DATA, 'accounts.tokens.json'))
    ? fs.readFileSync(path.join(USER_DATA, 'accounts.tokens.json'), 'utf8')
    : null

// Ordering evidence: when the auth IPC handlers appear relative to the window.
const timeline = { events: [] }
const ipcHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  if (AUTH_CHANNELS.includes(channel)) timeline.events.push({ type: 'auth', channel, at: Date.now() })
  return ipcHandle(channel, listener)
}

const report = {
  mode: MODE,
  startedAt: new Date().toISOString(),
  userData: USER_DATA,
  errors: [],
  checks: {},
  events: [],
}

function record(type, data = {}) {
  const entry = { type, at: new Date().toISOString(), ...data }
  report.events.push(entry)
  return entry
}

function check(name, value, detail) {
  report.checks[name] = { pass: Boolean(value), detail }
  if (!value) report.errors.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  return Boolean(value)
}

function flush() {
  fs.writeFileSync(path.join(OUT, `report-${RUN}-${MODE}.json`), JSON.stringify(report, null, 2))
}

process.on('uncaughtException', (error) => {
  report.errors.push(`uncaught: ${error && error.stack ? error.stack : error}`)
  flush()
  app.exit(1)
})
process.on('unhandledRejection', (error) => {
  report.errors.push(`unhandled: ${error && error.stack ? error.stack : error}`)
  flush()
})

// ─── Stub identity provider ────────────────────────────────────────────────
const ENDPOINTS = {
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  minecraft: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
}

const realFetch = globalThis.fetch.bind(globalThis)
const issued = { msAccess: [], msRefresh: [], mcAccess: [] }
const calls = []
const tokens = { msRefresh: '' }
const PROFILE = { id: 'e2e-uuid-0000-4000-8000-000000000001', name: 'E2EPlayer' }
// Login issues one-second tokens so expiry is real, not simulated.
const SHORT_LIVED = MODE === 'login' || MODE === 'expiry' || MODE === 'rejected'
let midRejectedAt = 0

function next(kind) {
  const bucket = kind === 'ms' ? issued.msAccess : kind === 'msr' ? issued.msRefresh : issued.mcAccess
  const token = `E2E-${kind}-${bucket.length + 1}-${RUN}-${MODE}`
  bucket.push(token)
  return token
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function stubFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url
  const method = (init.method || 'GET').toUpperCase()

  // Scenario (3): Microsoft (and everything else) unreachable. Record the
  // attempt first: the evidence is that exactly one refresh was tried.
  if (MODE === 'offline') {
    const grant = url === ENDPOINTS.token
      ? new URLSearchParams(String(init.body || '')).get('grant_type')
      : undefined
    calls.push({ url, method, ...(grant ? { grant } : {}) })
    throw new TypeError('offline: network unreachable')
  }

  if (url === ENDPOINTS.token) {
    const form = new URLSearchParams(String(init.body || ''))
    const grant = form.get('grant_type')

    // Hold the background restore long enough for the tab to read the stored
    // session, then reject it: main must push the loss to the open tab.
    if (MODE === 'mid-session' && grant === 'refresh_token') {
      calls.push({ url, method, grant, at: Date.now() })
      await sleep(8_000)
      midRejectedAt = Date.now()
      return json(
        { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.' },
        400,
      )
    }

    // Scenario (2): Microsoft rejects the stored refresh token.
    if (MODE === 'rejected' && grant === 'refresh_token') {
      calls.push({ url, method, grant })
      return json(
        { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.' },
        400,
      )
    }
    const call = {
      url,
      method,
      grant,
      clientId: form.get('client_id'),
      redirectUri: form.get('redirect_uri'),
      codeVerifier: form.get('code_verifier'),
      code: form.get('code'),
      refreshToken: form.get('refresh_token'),
      scope: form.get('scope'),
    }
    calls.push(call)
    // Login issues short-lived tokens so expiry is real, not simulated:
    // `restore` must refresh, and `expiry` can wait for the token to die.
    const expiresIn = grant === 'refresh_token' || !SHORT_LIVED ? 3600 : 1
    const refresh = next('msr')
    tokens.msRefresh = refresh
    return json({
      token_type: 'Bearer',
      scope: form.get('scope') || '',
      expires_in: expiresIn,
      access_token: next('ms'),
      refresh_token: refresh,
    })
  }

  if (url === ENDPOINTS.xbl) {
    calls.push({ url, method })
    return json({ Token: `E2E-XBL-${MODE}`, DisplayClaims: { xui: [{ uhs: 'e2e-uhs' }] } })
  }

  if (url === ENDPOINTS.xsts) {
    calls.push({ url, method })
    return json({ Token: `E2E-XSTS-${MODE}`, DisplayClaims: { xui: [{ uhs: 'e2e-uhs' }] } })
  }

  if (url === ENDPOINTS.minecraft) {
    calls.push({ url, method })
    // A chain that follows a successful refresh gets a long-lived token: the
    // point of the scenario is that the *fresh* token is what reaches launch.
    const refreshed = calls.some((call) => call.grant === 'refresh_token')
    return json({ access_token: next('mc'), expires_in: refreshed || !SHORT_LIVED ? 3600 : 1 })
  }

  if (url === ENDPOINTS.profile) {
    calls.push({ url, method, authorization: (init.headers && init.headers.Authorization) || '' })
    return json({ id: PROFILE.id, name: PROFILE.name, skins: [] })
  }

  // Anything else is the genuine network. The auth chain never reaches this.
  return realFetch(input, init)
}

globalThis.fetch = stubFetch

// ─── Browser double ────────────────────────────────────────────────────────
const browser = { opens: [], loopbackStatus: null }

shell.openExternal = async (url) => {
  const parsed = new URL(url)
  const entry = {
    url,
    protocol: parsed.protocol,
    host: parsed.host,
    pathname: parsed.pathname,
    clientId: parsed.searchParams.get('client_id'),
    redirectUri: parsed.searchParams.get('redirect_uri'),
    responseType: parsed.searchParams.get('response_type'),
    state: parsed.searchParams.get('state'),
    codeChallenge: parsed.searchParams.get('code_challenge'),
    codeChallengeMethod: parsed.searchParams.get('code_challenge_method'),
    scope: parsed.searchParams.get('scope'),
  }
  browser.opens.push(entry)
  record('openExternal', entry)
  if (entry.state) {
    // Play the signed-in user: hand Microsoft's answer back to the listener.
    const answer = `${entry.redirectUri}/?code=e2e-authorization-code&state=${encodeURIComponent(entry.state)}`
    setTimeout(() => {
      const attempt = (target) =>
        fetch(target, { method: 'GET' })
          .then((res) => res.text())
          .then((text) => {
            browser.loopbackStatus = { target, ok: true, body: text.slice(0, 80) }
          })
          .catch((error) => {
            if (target !== answer) return attempt(answer.replace('localhost', '127.0.0.1'))
            browser.loopbackStatus = { target, ok: false, error: error.message }
          })
      void attempt(answer)
    }, 80)
  }
  return true
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`)
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 1500)
  })
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function filesUnder(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, acc)
    else if (entry.isFile()) acc.push(full)
  }
  return acc
}

function readTokenFile() {
  const file = path.join(USER_DATA, 'accounts.tokens.json')
  const raw = fs.readFileSync(file, 'utf8')
  return { file, raw, json: JSON.parse(raw) }
}

function anyIssuedToken(text) {
  return [...issued.msAccess, ...issued.msRefresh, ...issued.mcAccess].some((token) =>
    String(text || '').includes(token),
  )
}

function hasTokenKey(value) {
  if (Array.isArray(value)) return value.some(hasTokenKey)
  if (value && typeof value === 'object') {
    return Object.keys(value).some(
      (key) => /token/i.test(key) && !/hasRefreshToken|tokenStoreDegraded/.test(key),
    )
  }
  return false
}

function exec(codes) {
  const win = mainWindow
  if (!win || win.isDestroyed()) throw new Error('no window to evaluate in')
  return win.webContents.executeJavaScript(codes, true)
}

/** The real TopBar chip, i.e. what the user actually sees as signed in. */
function topbarText() {
  return exec(
    `(() => { const header = document.querySelector('header'); return header ? header.innerText.replace(/\\s+/g, ' ').trim() : '' })()`,
  )
}

/**
 * The real Konto tab: open Settings with the accounts section preselected and
 * wait until the panel has rendered. Used by every DOM-evidence scenario.
 */
async function openKontoTab() {
  await exec(`sessionStorage.setItem('bamboo-settings-section', 'accounts')`)
  await exec(`(() => {
    const aside = document.querySelector('aside')
    const buttons = aside ? [...aside.querySelectorAll('button')] : []
    const settings = buttons[buttons.length - 1]
    if (!settings) throw new Error('sidebar settings button not found')
    settings.click()
  })()`)
  await waitFor(
    () =>
      exec(`(() => {
        const text = document.body.innerText
        const panel = /Microsoft-Anmeldung nicht verfügbar|Microsoft sign-in unavailable|Noch kein Konto angemeldet|No account signed in yet|Angemeldet|Signed in/.test(text)
        return panel ? text : false
      })()`),
    { label: 'Konto tab rendered', timeoutMs: 25_000 },
  )
}

async function waitForTopbarAccount() {
  return waitFor(
    async () => {
      const text = await topbarText()
      return text.includes(PROFILE.name) ? text : false
    },
    { label: 'TopBar shows the signed-in account', timeoutMs: 20_000 },
  )
}

async function reloadRenderer() {
  const win = mainWindow
  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.webContents.reload()
  await loaded
  await waitFor(() => exec('typeof window.electronAPI === "object"'), { label: 'bridge after reload' })
}

let mainWindow = null
const windowReady = new Promise((resolve) => {
  app.on('browser-window-created', (_event, win) => {
    mainWindow = win
    timeline.events.push({ type: 'window', at: Date.now() })
    resolve(win)
  })
})

// ─── Scenario ──────────────────────────────────────────────────────────────
async function run() {
  const win = await windowReady
  report.timeToWindowMs = Date.now() - startedAt
  console.log(`[e2e-auth:${MODE}] window created`)
  report.notes = [`window appeared ${report.timeToWindowMs}ms after the harness entry started`]

  // The earliest possible user click: the renderer DOM is ready but React has
  // not necessarily mounted and no other bridge call has happened yet.
  const earliest = new Promise((resolve) => {
    if (MODE !== 'earliest') return resolve(null)
    // main.js first tries the dev server and only then the bundled page. The
    // error page fires its own dom-ready; skip it and click on the real UI.
    const clickOnRealPage = () => {
      win.webContents.once('dom-ready', () => {
        if (!String(win.webContents.getURL()).startsWith('file:')) {
          clickOnRealPage()
          return
        }
        console.log(`[e2e-auth:${MODE}] dom-ready (${win.webContents.getURL()}), clicking sign-in`)
        const clickedAt = Date.now()
        exec('window.electronAPI.auth.login()').then(
          (status) => resolve({ ok: true, status, clickedAt, resolvedAt: Date.now() }),
          (error) => resolve({ ok: false, error: String((error && error.message) || error), clickedAt }),
        )
      })
    }
    clickOnRealPage()
    setTimeout(() => resolve({ ok: false, error: 'dom-ready timeout', clickedAt: Date.now() }), 20_000).unref?.()
  })

  await waitFor(() => (win.webContents.isLoading() ? false : win.webContents.getURL()), {
    label: 'renderer load',
  })
  record('renderer', {
    url: win.webContents.getURL(),
    webPreferences: win.webContents.getLastWebPreferences() && {
      contextIsolation: win.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: win.webContents.getLastWebPreferences().nodeIntegration,
      preload: win.webContents.getLastWebPreferences().preload,
    },
  })

  console.log(`[e2e-auth:${MODE}] renderer load settled`)
  await waitFor(() => exec('typeof window.electronAPI === "object"'), { label: 'preload bridge' })
  console.log(`[e2e-auth:${MODE}] preload bridge present`)

  // Ordering: registration is a precondition of the window, not a race.
  const windowIndex = timeline.events.findIndex((event) => event.type === 'window')
  const authEvents = timeline.events.filter((event) => event.type === 'auth')
  if (MODE === 'unavailable') {
    // A core that failed to initialize registers no auth IPC at all.
    check('a failed core initializes without any auth IPC handler',
      authEvents.length === 0,
      { registered: authEvents.map((event) => event.channel) })
  } else {
    check('all five auth IPC handlers are registered before the window exists',
      authEvents.length === 5 &&
        authEvents.every((event) => timeline.events.indexOf(event) < windowIndex) &&
        windowIndex > 0,
      { registered: authEvents.map((event) => event.channel), windowIndex })
  }

  if (MODE === 'earliest') {
    const first = await earliest
    check('sign-in at dom-ready reaches a registered handler', Boolean(first && first.ok), first && { ok: first.ok, error: first.error })
    check('no unregistered-handler error at first paint',
      !JSON.stringify(first || {}).includes('No handler registered'), first && first.error)
    check('sign-in at dom-ready completes signed in',
      Boolean(first && first.ok && first.status && first.status.signedIn), first && first.status)
    const windowAt = timeline.events.find((event) => event.type === 'window').at
    if (first) {
      report.timing = {
        windowToClickMs: first.clickedAt - windowAt,
        clickToStatusMs: first.resolvedAt - first.clickedAt,
      }
    }
    fs.writeFileSync(path.join(OUT, `secrets-${RUN}.json`), JSON.stringify({
      profile: PROFILE,
      msAccess: issued.msAccess,
      msRefresh: issued.msRefresh,
      mcAccess: issued.mcAccess,
    }, null, 2))
  }

  // (d) bridge surface, before any login.
  const apiKeys = await exec('Object.keys(window.electronAPI)')
  const authKeys = (await exec('Object.keys(window.electronAPI.auth)'))
    .filter((key) => ['cancel', 'login', 'refresh', 'signOut', 'status'].includes(key))
    .sort()
  check(
    'bridge exposes exactly the five auth channels',
    JSON.stringify(authKeys) ===
      JSON.stringify(['cancel', 'login', 'refresh', 'signOut', 'status']),
    authKeys,
  )
  check('bridge exposes no legacy login channel', !apiKeys.some((key) => /MicrosoftLogin|MsDevice|msLogin/.test(key)))
  const isolation = await exec(`(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    contextIsolated: typeof window.electronAPI === 'object' && typeof window.require === 'undefined',
  }))()`)
  check('renderer has context isolation (no require/process/module)', isolation.contextIsolated, isolation)
  const prefs = win.webContents.getLastWebPreferences() || {}
  check('preload runs with contextIsolation and no nodeIntegration',
    prefs.contextIsolation === true && prefs.nodeIntegration === false, prefs)
  // Electron 30 does not expose the resolved preload path on
  // getLastWebPreferences(), so prove the shipped bridge by its own surface:
  // the file exists, main.js wires exactly that file, and a key that only that
  // preload defines (icons) is present in the isolated world.
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  check('preload is the shipped preload.js',
    fs.existsSync(path.join(ROOT, 'preload.js')) &&
      /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainSource) &&
      (await exec('typeof window.electronAPI.icons')),
    { wiredInMain: /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainSource) })

  const safe = { available: safeStorage.isEncryptionAvailable() }
  check('safeStorage reports OS encryption available', safe.available, safe)

  // Scenario: the core failed to initialize. The Konto tab must read as
  // unavailable, not show the handler error or a sign-in that cannot work.
  if (MODE === 'unavailable') {
    const missing = await exec(
      `window.electronAPI.auth.status().then(() => null, (error) => String((error && error.message) || error))`,
    )
    check('the auth endpoint is genuinely absent', /No handler registered/.test(missing || ''), missing)

    await openKontoTab()
    const dom = await exec('({ text: document.body.innerText, html: document.documentElement.outerHTML })')
    report.dom = { state: 'auth-unavailable', text: dom.text }
    check('the Konto tab shows the auth-unavailable card',
      /Microsoft-Anmeldung nicht verfügbar|Microsoft sign-in unavailable/.test(dom.text),
      dom.text.slice(0, 600))
    check('no raw handler error is rendered anywhere in the DOM',
      !/No handler registered|Error invoking remote method|bamboo:auth/i.test(dom.html),
      (dom.html.match(/.{0,60}(No handler registered|bamboo:auth).{0,60}/i) || [''])[0])
    check('the unavailable state offers no sign-in button',
      !/Mit Microsoft anmelden|Sign in with Microsoft/.test(dom.text), dom.text.slice(0, 600))
  }

  // Scenario (1): the stored access token dies while the launcher stays open.
  if (MODE === 'expiry') {
    const login = await exec('window.electronAPI.auth.login()')
    check('expiry: sign-in succeeds', Boolean(login && login.signedIn), login)
    const firstToken = issued.mcAccess[issued.mcAccess.length - 1]
    await sleep(1300) // the issued access token lives one second

    const { initializeCore } = require(path.join(ROOT, 'dist-electron', 'index.js'))
    const core = await initializeCore()
    const identity = await core.getLaunchIdentity()
    const freshToken = issued.mcAccess[issued.mcAccess.length - 1]
    check('expiry: the launch path refreshes before handing out a token',
      Boolean(identity && identity.accessToken === freshToken && freshToken !== firstToken),
      { loginToken: firstToken, handedToLaunch: identity && identity.accessToken })
    check('expiry: exactly one refresh, no retry loop',
      calls.filter((call) => call.grant === 'refresh_token').length === 1,
      calls.map((call) => call.grant || call.url))
    const status = await exec('window.electronAPI.auth.status()')
    check('expiry: the session is fresh after the launch-path refresh',
      Boolean(status && status.account && status.account.expired === false),
      status && status.account)
  }

  // Scenario (2): Microsoft rejects the stored refresh token.
  if (MODE === 'rejected') {
    const login = await exec('window.electronAPI.auth.login()')
    check('rejected: sign-in succeeds before the token is rejected', Boolean(login && login.signedIn), login)
    await sleep(1300)
    const refreshesBefore = calls.filter((call) => call.grant === 'refresh_token').length

    const status = await exec('window.electronAPI.auth.refresh()')
    check('rejected: refresh resolves to a signed-out status',
      Boolean(status && status.signedIn === false && status.account === null), status)
    check('rejected: no pending state is left behind', status && status.pending === false, status && status.pending)
    check('rejected: exactly one refresh attempt, no retry loop',
      calls.filter((call) => call.grant === 'refresh_token').length === refreshesBefore + 1,
      calls.map((call) => call.grant || call.url))

    const accountsFile = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf8'))
    const tokensFile = readTokenFile().json
    check('rejected: account metadata is gone', accountsFile.accounts.length === 0, accountsFile.accounts)
    check('rejected: stored tokens are gone', !tokensFile.entries[PROFILE.id], Object.keys(tokensFile.entries || {}))
    check('rejected: the bridge status is signed out too',
      (await exec('window.electronAPI.auth.status()')).signedIn === false)

    const again = await exec('window.electronAPI.auth.login()')
    check('rejected: a fresh sign-in works after the dead session is cleared',
      Boolean(again && again.signedIn), again && again.account)
    await reloadRenderer()
    const topbar = await waitForTopbarAccount()
    check('rejected: the UI shows the new sign-in, not a zombie session',
      topbar.includes(PROFILE.name), topbar)
  }

  // Scenario (3): cold start with a stored session while Microsoft is unreachable.
  if (MODE === 'offline') {
    const status = await waitFor(async () => {
      const next = await exec('window.electronAPI.auth.status()')
      return next && next.signedIn ? next : false
    }, { label: 'offline status' })

    check('offline: the stored session stays signed in', status.signedIn === true, status)
    check('offline: the account is kept, not silently signed out',
      Boolean(status.account && status.account.name === PROFILE.name), status.account)
    check('offline: the unreachable refresh leaves the token flagged as stale',
      Boolean(status.account && status.account.expired === true), status.account && status.account.expired)
    check('offline: no pending state', status.pending === false, status.pending)
    check('offline: one refresh attempt, no retry loop',
      calls.filter((call) => call.grant === 'refresh_token').length === 1,
      calls.map((call) => call.grant || call.url))

    const accountsFile = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf8'))
    check('offline: account metadata survives', accountsFile.accounts.length === 1, accountsFile.accounts.length)
    check('offline: encrypted tokens are untouched',
      tokenFileSnapshot !== null &&
        fs.readFileSync(path.join(USER_DATA, 'accounts.tokens.json'), 'utf8') === tokenFileSnapshot)
    check('offline: no browser was opened', browser.opens.length === 0, browser.opens.length)

    await reloadRenderer()
    const topbar = await waitForTopbarAccount()
    check('offline: the user still sees the stored account', topbar.includes(PROFILE.name), topbar)

    await openKontoTab()
    const domText = await exec('document.body.innerText')
    report.dom = { state: 'offline-start', text: domText }
    check('offline: the Konto tab renders the stored session as signed in',
      domText.includes(PROFILE.name) && /Angemeldet|Signed in/.test(domText), domText.slice(0, 700))
    check('offline: the Konto tab offers the signed-in actions',
      /Sitzung aktualisieren|Refresh session/.test(domText) && /Abmelden|Sign out/.test(domText),
      domText.slice(0, 700))
  }

  // Defect: main drops the session in the background (restore rejected as
  // invalid_grant) after the tab already read the stored session. The push must
  // flip the open tab; no reload, no contradictory error.
  if (MODE === 'mid-session') {
    await openKontoTab()
    await exec(`window.__kontoMarker = 'kept'`)
    const before = await exec('document.body.innerText')
    const beforeAt = Date.now()
    check('mid-session: the tab starts on the stored session',
      before.includes(PROFILE.name) && /Angemeldet|Signed in/.test(before), before.slice(0, 700))

    const after = await waitFor(
      async () => {
        const text = await exec('document.body.innerText')
        return /Noch kein Konto angemeldet|No account signed in yet/.test(text) ? text : false
      },
      { label: 'Konto tab follows the background sign-out', timeoutMs: 25_000 },
    )
    const marker = await exec('window.__kontoMarker')
    report.dom = { state: 'mid-session', before, after, beforeAt, rejectedAt: midRejectedAt }
    check('mid-session: the signed-in read happened before the rejection',
      beforeAt < midRejectedAt, { beforeAt, midRejectedAt })
    check('mid-session: the tab flipped without a reload', marker === 'kept', marker)
    check('mid-session: the signed-in card is gone', !/Angemeldet|Signed in/.test(after), after.slice(0, 700))
    check('mid-session: no contradictory account error is shown',
      !/Kein Microsoft-Konto angemeldet|No Microsoft account signed in/.test(after), after.slice(0, 700))
  }

  if (MODE === 'login') {
    const before = await exec('window.electronAPI.auth.status()')
    check('fresh user data dir starts signed out', before && before.signedIn === false, before)
    check('auth status carries no token key', !hasTokenKey(before), before)

    const status = await exec('window.electronAPI.auth.login()')

    // (c) authorize URL + PKCE + fixed redirect
    const open = browser.opens[0]
    check('shell.openExternal was invoked exactly once', browser.opens.length === 1, browser.opens.length)
    check('authorize URL targets the consumers authority',
      open && open.protocol === 'https:' && open.host === 'login.microsoftonline.com' &&
        open.pathname === '/consumers/oauth2/v2.0/authorize', open && open.url && open.url.split('?')[0])
    check('authorize URL pins redirect_uri=http://localhost:3377',
      open && open.redirectUri === 'http://localhost:3377', open && open.redirectUri)
    check('authorize URL requests response_type=code', open && open.responseType === 'code', open && open.responseType)
    check('authorize URL carries a PKCE S256 challenge',
      open && /^[A-Za-z0-9_-]{43}$/.test(open.codeChallenge || '') && open.codeChallengeMethod === 'S256',
      open && { challenge: open.codeChallenge, method: open.codeChallengeMethod })
    check('authorize URL carries a state', open && /^[0-9a-f]{32}$/.test(open.state || ''), open && open.state)
    check('authorize URL asks for Xbox Live + offline_access',
      open && /XboxLive\.signin/.test(open.scope) && /offline_access/.test(open.scope), open && open.scope)

    // The token exchange must repeat redirect_uri and the PKCE verifier.
    const exchange = calls.find((call) => call.grant === 'authorization_code')
    check('token endpoint received grant_type=authorization_code', Boolean(exchange), calls.map((c) => c.grant))
    check('token exchange repeats redirect_uri=http://localhost:3377',
      exchange && exchange.redirectUri === 'http://localhost:3377', exchange && exchange.redirectUri)
    check('token exchange sends the PKCE verifier', exchange && /^[A-Za-z0-9_-]{43}$/.test(exchange.codeVerifier || ''),
      exchange && exchange.codeVerifier && exchange.codeVerifier.length)

    check('loopback listener accepted the browser redirect',
      browser.loopbackStatus && browser.loopbackStatus.ok === true, browser.loopbackStatus)

    // (a) at-rest encryption
    const tokenFile = readTokenFile()
    const entry = tokenFile.json.entries[PROFILE.id]
    check('token file holds the account entry', Boolean(entry), Object.keys(tokenFile.json.entries))
    const accessBlob = Buffer.from(entry.a, 'base64')
    const refreshBlob = Buffer.from(entry.r, 'base64')
    const minecraftToken = issued.mcAccess[issued.mcAccess.length - 1]
    const refreshToken = tokens.msRefresh
    check('stored access blob is not the plaintext token', !accessBlob.includes(Buffer.from(minecraftToken)), accessBlob.length)
    check('stored refresh blob is not the plaintext token', !refreshBlob.includes(Buffer.from(refreshToken)), refreshBlob.length)
    check('stored access blob is Electron safeStorage ciphertext (v10 + opaque bytes)',
      accessBlob.subarray(0, 3).toString('latin1') === 'v10' &&
        !/E2E-/.test(accessBlob.toString('latin1')),
      { prefix: accessBlob.subarray(0, 3).toString('latin1') })
    check('stored blobs are DPAPI-wrapped and round-trip through safeStorage',
      safeStorage.decryptString(Buffer.from(accessBlob)) === minecraftToken &&
        safeStorage.decryptString(Buffer.from(refreshBlob)) === refreshToken,
      {
        accessRoundTrip: safeStorage.decryptString(Buffer.from(accessBlob)) === minecraftToken,
        refreshRoundTrip: safeStorage.decryptString(Buffer.from(refreshBlob)) === refreshToken,
      })

    const accountsRaw = fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf8')
    check('accounts.json has no token field',
      !/"(accessToken|refreshToken)"/.test(accountsRaw), accountsRaw.slice(0, 120))
    check('accounts.json contains no token value',
      !accountsRaw.includes(issued.msAccess[0]) && !accountsRaw.includes(tokens.msRefresh))

    // (b) restart setup: the stored access token is already expired.
    check('login persisted a signed-in status', status && status.signedIn === true, status)
    check('persisted account is the Minecraft profile', status && status.account && status.account.name === PROFILE.name,
      status && status.account)
    check('stored access token is reported expired', status && status.account && status.account.expired === true,
      status && status.account)
    check('status carries no token key', !hasTokenKey(status), status)

    // The renderer's own startup path must show the account once it boots.
    await reloadRenderer()
    const topbar = await waitForTopbarAccount()
    check('a fresh renderer load shows the signed-in account in the TopBar',
      topbar.includes(PROFILE.name), topbar)
    check('TopBar carries no token', !anyIssuedToken(topbar), topbar)

    // last login token of this run (the refresh token the restart will use)
    fs.writeFileSync(path.join(OUT, `secrets-${RUN}.json`), JSON.stringify({
      profile: PROFILE,
      msAccess: issued.msAccess,
      msRefresh: issued.msRefresh,
      refreshToken: issued.msRefresh[issued.msRefresh.length - 1],
      mcAccess: issued.mcAccess,
      tokenFileHash: sha256File(tokenFile.file),
      tokenStoreDegraded: status && status.tokenStoreDegraded,
    }, null, 2))
  }

  // The panel's own sign-in button, not a direct bridge call: record what the
  // Konto tab shows from the click to the signed-in card and after it settles.
  if (MODE === 'login-ui') {
    await openKontoTab()
    const before = await exec('document.body.innerText')
    check('login-ui: the panel starts on the signed-out card',
      /Noch kein Konto angemeldet|No account signed in yet/.test(before) &&
        /Mit Microsoft anmelden|Sign in with Microsoft/.test(before),
      before.slice(0, 700))

    await exec(`(() => {
      window.__frames = []
      const started = Date.now()
      window.__frameTimer = setInterval(() => {
        const text = document.body.innerText
        window.__frames.push({
          at: Date.now() - started,
          signedIn: /Angemeldet|Signed in/.test(text),
          signedOut: /Noch kein Konto angemeldet|No account signed in yet/.test(text),
          busy: /Warte auf Bestätigung im Browser|Waiting for confirmation/.test(text),
        })
      }, 16)
    })()`)
    await sleep(50) // idle signed-out frames before the click

    const clickedAt = Date.now()
    await exec(`(() => {
      const button = [...document.querySelectorAll('button')].find((entry) =>
        /Mit Microsoft anmelden|Sign in with Microsoft/.test(entry.innerText),
      )
      if (!button) throw new Error('sign-in button not found')
      button.click()
    })()`)
    const signedIn = await waitFor(
      async () => {
        const text = await exec('document.body.innerText')
        return /Angemeldet|Signed in/.test(text) ? text : false
      },
      { label: 'Konto tab shows the signed-in card' },
    )
    await sleep(400)
    const frames = await exec(
      `(() => { clearInterval(window.__frameTimer); return window.__frames })()`,
    )
    const firstSignedIn = frames.find((frame) => frame.signedIn)
    const reverted = Boolean(firstSignedIn) && frames.some((frame) => frame.signedIn && frame.signedOut)
    report.dom = {
      state: 'login-success',
      clickedAt,
      signedInAt: Date.now() - clickedAt,
      frames,
      text: signedIn,
    }
    check('login-ui: the panel reaches the signed-in card with the account',
      /Angemeldet|Signed in/.test(signedIn) && signedIn.includes(PROFILE.name), signedIn.slice(0, 700))
    check('login-ui: the signed-out card is gone after sign-in',
      !/Noch kein Konto angemeldet|No account signed in yet/.test(signedIn), signedIn.slice(0, 700))
    check('login-ui: no frame flips back to the signed-out card after success',
      !reverted, frames.filter((frame) => frame.signedOut).slice(0, 5))
    check('login-ui: the browser was opened exactly once', browser.opens.length === 1, browser.opens.length)
  }

  if (MODE === 'restore') {
    const previous = JSON.parse(fs.readFileSync(path.join(OUT, `secrets-${RUN}.json`), 'utf8'))
    const restored = await waitFor(async () => {
      const status = await exec('window.electronAPI.auth.status()')
      const refreshed = calls.some((call) => call.grant === 'refresh_token')
      return status && status.signedIn && refreshed ? status : false
    }, { label: 'silent restore + refresh' })

    check('restart restores the session with no login i.e. no browser opened',
      browser.opens.length === 0, browser.opens.length)
    check('restart is signed in without user interaction', restored.signedIn === true, restored)
    check('restored account is the same Minecraft profile',
      restored.account && restored.account.name === PROFILE.name && restored.account.uuid === PROFILE.id,
      restored.account)
    const refreshCall = calls.find((call) => call.grant === 'refresh_token')
    check('restore refreshed instead of reusing the expired token', Boolean(refreshCall), calls.map((c) => c.grant))
    check('restore used the stored refresh token',
      Boolean(refreshCall) && refreshCall.refreshToken === previous.refreshToken,
      { usedStored: refreshCall && refreshCall.refreshToken === previous.refreshToken })
    check('restored access token is fresh (not expired)',
      restored.account && restored.account.expired === false, restored.account && restored.account)

    const tokenFile = readTokenFile()
    const entry = tokenFile.json.entries[PROFILE.id]
    const accessBlob = Buffer.from(entry.a, 'base64')
    const latestAccess = issued.mcAccess[issued.mcAccess.length - 1]
    check('restore rewrote the encrypted token file',
      sha256File(tokenFile.file) !== previous.tokenFileHash,
      { before: previous.tokenFileHash, after: sha256File(tokenFile.file) })
    check('rewritten blob still decrypts to the new token',
      safeStorage.decryptString(accessBlob) === latestAccess, { latestAccessLength: latestAccess.length })
    check('status at the bridge carries no token key', !hasTokenKey(restored), restored)

    const topbar = await waitForTopbarAccount()
    check('the restarted app lands signed in in the TopBar', topbar.includes(PROFILE.name), topbar)
    check('TopBar carries no token', !anyIssuedToken(topbar), topbar)

    fs.writeFileSync(path.join(OUT, `secrets-${RUN}-restored.json`), JSON.stringify({
      msAccess: issued.msAccess,
      msRefresh: issued.msRefresh,
      mcAccess: issued.mcAccess,
      tokenFileHash: sha256File(tokenFile.file),
    }, null, 2))
  }

  // (c) the listener is gone once the flow settled.
  const stillOpen = await portOpen(3377)
  check('loopback listener on 3377 is closed after the attempt', stillOpen === false, stillOpen)

  // Renderer never sees a token, in any state - status, neighbours and DOM.
  if (MODE !== 'unavailable') {
    // null is legitimate once the mid-session sign-out removed the account.
    const identity = await exec('window.electronAPI.auth.identity()')
    check('player identity bridge call stays metadata-only (or null when signed out)',
      identity === null || !hasTokenKey(identity), identity)
  }
  const bodyText = await exec('document.body.innerText')
  const anyToken = [...issued.msAccess, ...issued.msRefresh, ...issued.mcAccess]
  check('renderer DOM contains no issued token',
    !anyToken.some((token) => bodyText.includes(token)), anyToken.length)

  record('calls', { count: calls.length, grants: calls.map((call) => call.grant || call.url) })
  report.finishedAt = new Date().toISOString()
  report.passed = report.errors.length === 0
  flush()
  console.log(`[e2e-auth:${MODE}] ${report.passed ? 'PASS' : 'FAIL'} - ${Object.keys(report.checks).length} checks`)
  for (const error of report.errors) console.error(`  ! ${error}`)
  app.exit(report.passed ? 0 : 1)
}

// The unavailable scenario needs a core that genuinely fails to initialize.
// The real main.js catches that rejection, still opens the window, and
// registers no auth IPC - which is exactly the state under test.
if (MODE === 'unavailable') {
  const coreEntry = require.resolve(path.join(ROOT, 'dist-electron', 'index.js'))
  require.cache[coreEntry] = {
    id: coreEntry,
    filename: coreEntry,
    loaded: true,
    exports: {
      initializeCore: async () => {
        throw new Error('E2E: launcher core failed to initialize')
      },
    },
  }
}

// Boot the real launcher, unchanged.
require(path.join(ROOT, 'main.js'))

app.whenReady().then(() => {
  run().catch((error) => {
    report.errors.push(`scenario: ${error && error.stack ? error.stack : error}`)
    report.finishedAt = new Date().toISOString()
    report.passed = false
    flush()
    console.error(`[e2e-auth:${MODE}] FAIL - ${error && error.message}`)
    app.exit(1)
  })
})
