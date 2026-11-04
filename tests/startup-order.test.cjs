/**
 * Startup contract for the auth IPC surface.
 *
 * `main.js` must finish core initialization - which is what registers
 * `bamboo:auth:*` - before it creates the window. Otherwise a renderer that is
 * already live can invoke `authLogin` on a missing handler, which is exactly
 * the broken "click sign in right after launch" outcome. A failed core must
 * still open the window; the await must not turn a core error into "no UI".
 *
 * The tests boot the real `main.js` with a fake `electron` module, record the
 * order of handler registration and window creation, and fail if the window
 * ever appears before the handlers.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const AUTH_CHANNELS = [
  'bamboo:auth:status',
  'bamboo:auth:login',
  'bamboo:auth:cancel',
  'bamboo:auth:refresh',
  'bamboo:auth:sign-out',
]

function createElectron(appData, timeline, { isPackaged = false } = {}) {
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super()
      timeline.push({ type: 'window' })
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.send = () => {}
      this.webContents.toggleDevTools = () => {}
      this.webContents.isDestroyed = () => false
    }
    loadURL(url) { timeline.push({ type: 'loadURL', url }); return Promise.resolve() }
    loadFile(file) { timeline.push({ type: 'loadFile', file }); return Promise.resolve() }
    setMenuBarVisibility() {}
    show() {}
    maximize() {}
    isMaximized() { return false }
    isMinimized() { return false }
    restore() {}
    focus() {}
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 } }
    isDestroyed() { return false }
    close() {}
    static getAllWindows() { return [] }
  }

  return {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      getPath: () => appData,
      setAsDefaultProtocolClient: () => true,
      on: () => {},
      quit: () => {},
      isPackaged,
      getName: () => 'bamboo-launcher',
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, listener) => {
        timeline.handlers.set(channel, listener)
        if (AUTH_CHANNELS.includes(channel)) timeline.push({ type: 'auth', channel })
      },
      on: (channel, listener) => {
        timeline.listeners.set(channel, listener)
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    },
    shell: { openExternal: async () => true, openPath: async () => '' },
    clipboard: { writeText: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    net: { fetch: async () => new Response('') },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  }
}

class FakeRpcClient {
  constructor() {
    this.user = { setActivity: () => Promise.resolve(), clearActivity: () => Promise.resolve() }
  }
  on() {}
  login() { return Promise.resolve() }
}

/**
 * Boots the real main.js once. `coreModule` replaces `dist-electron/index.js`
 * when the failure branch is under test.
 */
async function boot({ coreModule, isPackaged = false } = {}) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-startup-'))
  const gameRoot = path.join(appData, 'game')
  fs.mkdirSync(gameRoot, { recursive: true })
  const timeline = []
  timeline.handlers = new Map()
  timeline.listeners = new Map()
  const fakeElectron = createElectron(appData, timeline, { isPackaged })

  const originalLoad = Module._load
  const previousSkip = process.env.BAMBOO_SKIP_BOOTSTRAP
  const previousRoot = process.env.BAMBOO_GAME_ROOT
  process.env.BAMBOO_SKIP_BOOTSTRAP = '1'
  process.env.BAMBOO_GAME_ROOT = gameRoot
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron
    if (request === '@xhayper/discord-rpc') return { Client: FakeRpcClient }
    if (coreModule && request === './dist-electron/index.js') return coreModule
    return originalLoad.call(this, request, ...rest)
  }

  try {
    delete require.cache[require.resolve('../main.js')]
    require('../main.js')

    // Core initialization is asynchronous: wait (bounded) for the window.
    const deadline = Date.now() + 15_000
    while (!timeline.some((entry) => entry.type === 'window') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  } finally {
    Module._load = originalLoad
    if (previousSkip === undefined) delete process.env.BAMBOO_SKIP_BOOTSTRAP
    else process.env.BAMBOO_SKIP_BOOTSTRAP = previousSkip
    if (previousRoot === undefined) delete process.env.BAMBOO_GAME_ROOT
    else process.env.BAMBOO_GAME_ROOT = previousRoot
    fs.rmSync(appData, { recursive: true, force: true })
  }

  return timeline
}

test('auth IPC handlers exist before the window is created', async () => {
  const timeline = await boot()

  const windowIndex = timeline.findIndex((entry) => entry.type === 'window')
  assert.notEqual(windowIndex, -1, 'main.js must create the window after startup')

  const registered = timeline.filter((entry) => entry.type === 'auth').map((entry) => entry.channel)
  assert.deepEqual(
    [...registered].sort(),
    [...AUTH_CHANNELS].sort(),
    'the core must register the auth IPC handlers before the window exists',
  )
  for (const entry of timeline.filter((item) => item.type === 'auth')) {
    assert.ok(
      timeline.indexOf(entry) < windowIndex,
      `${entry.channel} was registered after the window was created`,
    )
  }
})

test('a packaged start loads the bundled renderer and never the dev server', async () => {
  const timeline = await boot({ isPackaged: true })
  const loads = timeline.filter((entry) => entry.type === 'loadURL' || entry.type === 'loadFile')
  assert.equal(loads.some((entry) => entry.type === 'loadURL'), false, 'a packaged app must not probe localhost')
  const file = loads.find((entry) => entry.type === 'loadFile')
  assert.ok(file, 'the bundled index.html must be loaded')
  assert.ok(file.file.endsWith(path.join('dist', 'index.html')))
})

test('an unpackaged start still uses the Vite dev server', async () => {
  const timeline = await boot()
  const load = timeline.find((entry) => entry.type === 'loadURL')
  assert.equal(load?.url, 'http://localhost:5173')
})

test('a failing core still opens the window', async () => {
  const timeline = await boot({
    coreModule: {
      initializeCore: async () => {
        throw new Error('core unavailable')
      },
    },
  })

  assert.ok(
    timeline.some((entry) => entry.type === 'window'),
    'a core failure must not leave the user without a window',
  )
  assert.equal(
    timeline.filter((entry) => entry.type === 'auth').length,
    0,
    'a failed core has no auth handlers; the window must survive that',
  )
})

test('the legacy IPC owner answers real channels and rejects foreign frames', async () => {
  const timeline = await boot()
  const trusted = { senderFrame: { url: 'file:///app/index.html' } }
  const untrusted = { senderFrame: { url: 'https://evil.example/' } }

  const activeLaunches = timeline.handlers.get('get-active-launches')
  assert.equal(typeof activeLaunches, 'function', 'a real main.js handler was registered')
  assert.deepEqual(await activeLaunches(trusted), [])
  await assert.rejects(() => activeLaunches(untrusted), /untrusted frame/)

  const openDialog = timeline.handlers.get('show-open-dialog')
  assert.equal(typeof openDialog, 'function', 'a validated argument channel was registered')
  assert.deepEqual(await openDialog(trusted, { properties: ['openFile'] }), {
    canceled: true,
    filePaths: [],
  })

  const focus = timeline.listeners.get('window-focus')
  assert.equal(typeof focus, 'function', 'a real main.js event channel was registered')
  assert.doesNotThrow(() => focus(untrusted))
})
