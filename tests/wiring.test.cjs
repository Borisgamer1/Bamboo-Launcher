/**
 * Wiring test for the Electron entry that `main.js` loads.
 *
 * `dist-electron/index.js` is the exact module main.js requires. Loading it
 * here with a stubbed `electron` module proves that startup works, the IPC
 * surface is registered, the bootstrap runs and no token reaches a reply.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')

test('electron entry boots, registers IPC and never returns tokens', async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-wiring-'))
  const legacyRoot = path.join(appData, 'missing-legacy')
  const handlers = new Map()
  let dialogCalls = 0

  const fakeElectron = {
    app: { getPath: (name) => (name === 'userData' ? appData : appData) },
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    },
    dialog: {
      showOpenDialog: async () => {
        dialogCalls += 1
        return { canceled: true, filePaths: [] }
      },
    },
  }

  const originalLoad = Module._load
  const previousRoot = process.env.BAMBOO_GAME_ROOT
  process.env.BAMBOO_GAME_ROOT = legacyRoot
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron
    return originalLoad.call(this, request, ...rest)
  }

  try {
    const { initializeCore } = require('../dist-electron/index.js')
    const core = await initializeCore()

    assert.equal(core.rootSource, 'default')
    assert.equal(dialogCalls, 1, 'first boot must offer the game-root dialog')
    assert.ok(handlers.has('bamboo:core:status'))
    assert.ok(handlers.has('bamboo:settings:save'))
    assert.ok(handlers.has('bamboo:accounts:list'))
    assert.ok(handlers.has('bamboo:instances:list'))

    const trusted = { senderFrame: { url: 'file:///app/index.html' } }
    const untrusted = { senderFrame: { url: 'https://evil.example/' } }

    // The account store is the only account writer; tokens go to safeStorage.
    await core.accounts.upsert({
      id: 'wired-1',
      name: 'Alex',
      uuid: 'uuid-1',
      type: 'microsoft',
      active: true,
      accessToken: 'SECRET-ACCESS',
      refreshToken: 'SECRET-REFRESH',
    })

    // A renderer round-trip with an older copy must not rename the account.
    await handlers.get('bamboo:settings:save')(trusted, {
      currentTheme: 'futuristic',
      accounts: [{ id: 'wired-1', name: 'Stale', token: 'SECRET-ACCESS' }],
    })

    const settings = await handlers.get('bamboo:settings:get')(trusted)
    assert.equal(settings.currentTheme, 'futuristic')
    assert.equal(settings.accounts.length, 1)
    assert.equal(settings.accounts[0].name, 'Alex')
    assert.equal(settings.accounts[0].hasToken, true)
    assert.equal(settings.accounts[0].token, undefined)
    assert.equal(settings.accounts[0].accessToken, undefined)

    const status = await handlers.get('bamboo:core:status')(trusted)
    assert.equal(status.gameRoot, path.join(appData, 'game'))
    assert.equal(status.accountCount, 1)
    // The core bootstrap and the legacy handlers share one root resolver.
    assert.equal(require('../dist-electron/paths.js').legacyGameRoot(), legacyRoot)

    await assert.rejects(() => handlers.get('bamboo:settings:get')(untrusted), /untrusted frame/)

    const files = fs.readdirSync(appData)
    assert.ok(files.includes('settings.json'))
    assert.ok(files.includes('accounts.json'))
    assert.ok(!fs.readFileSync(path.join(appData, 'settings.json'), 'utf8').includes('SECRET-ACCESS'))
  } finally {
    Module._load = originalLoad
    if (previousRoot === undefined) delete process.env.BAMBOO_GAME_ROOT
    else process.env.BAMBOO_GAME_ROOT = previousRoot
    fs.rmSync(appData, { recursive: true, force: true })
  }
})
