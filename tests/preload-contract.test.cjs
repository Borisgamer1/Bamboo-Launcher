/**
 * The namespaced preload contract: one typed surface, no flat legacy methods,
 * and every namespace method still maps to the same IPC channel and payload.
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')

function loadBridge() {
  const calls = []
  const listeners = new Map()
  const exposed = {}

  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => Object.assign(exposed, api),
    },
    ipcRenderer: {
      sendSync: (channel) => {
        calls.push({ mode: 'sync', channel, args: [] })
        return { grass: 'icon-data' }
      },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      invoke: (channel, ...args) => {
        calls.push({ mode: 'invoke', channel, args })
        return Promise.resolve(null)
      },
      send: (channel, ...args) => {
        calls.push({ mode: 'send', channel, args })
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
    delete require.cache[require.resolve('../preload.js')]
    require('../preload.js')
  } finally {
    Module._load = originalLoad
    if (!hadWindow) delete globalThis.window
  }

  const emit = (channel, ...args) => {
    const listener = listeners.get(channel)
    if (listener) listener({}, ...args)
  }

  return { api: exposed, calls, listeners, emit }
}

test('the preload surface is namespaced and keeps the exact channel mapping', async () => {
  const { api, calls } = loadBridge()

  assert.deepEqual(Object.keys(api).sort(), [
    'auth',
    'cosmetics',
    'dialogs',
    'icons',
    'instances',
    'java',
    'launch',
    'loaders',
    'logs',
    'mods',
    'profiles',
    'screenshots',
    'servers',
    'settings',
    'skins',
    'statistics',
    'system',
    'tasks',
    'updates',
    'window',
  ])
  assert.deepEqual(api.icons, { grass: 'icon-data' })

  await api.settings.get()
  await api.settings.save({ currentTheme: 'bamboo', lang: 'en' })
  await api.statistics.summary()
  await api.instances.list()
  await api.instances.deleteFiles('demo')
  await api.instances.create({ folderName: 'demo', options: {} })
  await api.instances.updateLaunchSettings('demo', { maxMemory: 4096 })
  await api.mods.curseforgeSearch({ query: 'sodium', sortBy: '0' })
  await api.mods.download({
    folderName: 'demo',
    profileName: 'Demo',
    versionId: '1.21',
    downloadUrl: 'https://example.test/mod.jar',
    filename: 'mod.jar',
    itemType: 'mods',
  })
  api.launch.start({
    folderName: 'demo',
    profileName: 'Demo',
    version: '1.21',
    ram: 4096,
    modLoader: 'fabric',
  })
  await api.launch.stop({ folderName: 'demo', profileName: 'Demo' })
  await api.dialogs.open({ properties: ['openFile'] })
  api.window.minimize()
  await api.auth.status()
  await api.skins.snapshot()
  await api.cosmetics.list()
  await api.cosmetics.shop()
  api.system.copy('hello')
  await api.screenshots.collect()
  await api.screenshots.delete({
    absolutePath: '/tmp/shot.png',
    sourceAbsolutePath: '/tmp/source.png',
  })
  await api.profiles.importPreview('/tmp/pack.zip')
  await api.java.versions(true)
  await api.loaders.forgeVersions()
  await api.servers.ping('127.0.0.1')
  await api.updates.state()
  await api.updates.check()
  await api.updates.install()
  api.system.openExternal('https://example.test')

  assert.deepEqual(calls, [
    { mode: 'sync', channel: 'get-icons', args: [] },
    { mode: 'invoke', channel: 'get-settings', args: [] },
    { mode: 'invoke', channel: 'save-settings', args: [{ currentTheme: 'bamboo', lang: 'en' }] },
    { mode: 'invoke', channel: 'bamboo:statistics:summary', args: [] },
    { mode: 'invoke', channel: 'bamboo:instances:list', args: [] },
    { mode: 'invoke', channel: 'delete-profile-files', args: ['demo'] },
    { mode: 'invoke', channel: 'create-instance', args: [{ folderName: 'demo', options: {} }] },
    {
      mode: 'invoke',
      channel: 'bamboo:instances:update-launch',
      args: ['demo', { maxMemory: 4096 }],
    },
    {
      mode: 'invoke',
      channel: 'curseforge-search',
      args: [{ query: 'sodium', sortBy: '0' }],
    },
    {
      mode: 'invoke',
      channel: 'download-mod',
      args: [{
        folderName: 'demo',
        profileName: 'Demo',
        versionId: '1.21',
        downloadUrl: 'https://example.test/mod.jar',
        filename: 'mod.jar',
        itemType: 'mods',
      }],
    },
    {
      mode: 'send',
      channel: 'launch-game',
      args: [{
        folderName: 'demo',
        profileName: 'Demo',
        version: '1.21',
        ram: 4096,
        modLoader: 'fabric',
      }],
    },
    { mode: 'invoke', channel: 'kill-game', args: ['demo'] },
    { mode: 'invoke', channel: 'show-open-dialog', args: [{ properties: ['openFile'] }] },
    { mode: 'send', channel: 'window-minimize', args: [] },
    { mode: 'invoke', channel: 'bamboo:auth:status', args: [] },
    { mode: 'invoke', channel: 'bamboo:skins:snapshot', args: [] },
    { mode: 'invoke', channel: 'bamboo:cosmetics:list', args: [] },
    { mode: 'invoke', channel: 'bamboo:cosmetics:shop', args: [] },
    { mode: 'send', channel: 'copy-to-clipboard', args: ['hello'] },
    { mode: 'invoke', channel: 'collect-all-screenshots', args: [] },
    {
      mode: 'invoke',
      channel: 'delete-screenshot-file',
      args: [{ absolutePath: '/tmp/shot.png', sourceAbsolutePath: '/tmp/source.png' }],
    },
    { mode: 'invoke', channel: 'import-preview', args: ['/tmp/pack.zip'] },
    { mode: 'invoke', channel: 'get-java-versions', args: [true] },
    { mode: 'invoke', channel: 'get-forge-versions', args: [] },
    { mode: 'invoke', channel: 'ping-server', args: ['127.0.0.1'] },
    { mode: 'invoke', channel: 'bamboo:updates:state', args: [] },
    { mode: 'invoke', channel: 'bamboo:updates:check', args: [] },
    { mode: 'invoke', channel: 'bamboo:updates:install', args: [] },
    { mode: 'send', channel: 'open-external-url', args: ['https://example.test'] },
  ])
})

test('the preload surface has no flat legacy methods and no deleted methods', () => {
  const { api } = loadBridge()
  const removed = [
    'applyOptionsPatch',
    'findJava',
    'getRecommendedJavaForMc',
    'findBestJavaForMc',
    'getCollections',
    'saveCollections',
    'onRepairProgress',
    'completeReinstall',
    'onReinstallProgress',
    'readFileAsBase64',
    'saveTempFile',
    'uiReady',
    'getActiveLaunches',
    'detectLanServer',
    'getHostedServers',
    'scanLocalMods',
    'matchLocalMod',
    'launchGame',
    'stopGame',
    'getSettings',
    'saveSettings',
    'getProfiles',
    'authStatus',
    'authLogin',
    'downloadMod',
    'showOpenDialog',
    'exportProfile',
    'windowMinimize',
  ]
  for (const name of removed) assert.equal(api[name], undefined, `${name} must not exist on the bridge`)
})

test('listeners flow through the namespaced surface', () => {
  const { api, emit } = loadBridge()
  const closed = []

  const unsubscribe = api.launch.onClosed((data) => closed.push(data))
  emit('game-closed', { code: 0, profileName: 'Demo', folderName: 'demo' })
  assert.deepEqual(closed, [{ code: 0, profileName: 'Demo', folderName: 'demo' }])
  unsubscribe()
})
