const { contextBridge, ipcRenderer } = require('electron')

const report = (level, message, data) => {
  try {
    ipcRenderer.send('renderer-log', { level, message, data })
  } catch {
    // Logging is best effort while the preload bridge is still booting.
  }
};

let iconCache = {};
try {
  iconCache = ipcRenderer.sendSync('get-icons');
} catch (error) {
  report('warn', 'preload: icon cache unavailable', { error: error.message });
}

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
const send = (channel, ...args) => ipcRenderer.send(channel, ...args)
const subscribe = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('electronAPI', {
  icons: iconCache,

  launch: {
    start: (payload) => send('launch-game', payload),
    stop: (data) => invoke('kill-game', data.folderName),
    onStatus: (callback) => subscribe('launch-status', callback),
    onClosed: (callback) => subscribe('game-closed', callback),
    onReady: (callback) => subscribe('game-ready', callback),
    onFailed: (callback) => subscribe('launch-failed', callback),
    onProgress: (callback) => subscribe('launch-progress', callback),
  },

  logs: {
    onAnalysis: (callback) => subscribe('bamboo:logs:analysis', callback),
    analyze: (instanceId, launchId) =>
      invoke('bamboo:logs:analyze', instanceId, launchId),
    applyFix: (analysisId, actionId) =>
      invoke('bamboo:logs:apply-fix', analysisId, actionId),
    undoFix: (undoToken) => invoke('bamboo:logs:undo', undoToken),
    readLatest: (folderName) => invoke('read-latest-log', folderName),
    createSupportBundle: (destination) => invoke('bamboo:support:bundle', destination),
  },

  settings: {
    get: () => invoke('get-settings'),
    save: (settings) => invoke('save-settings', settings),
    // Main asks for a final settings flush before it lets the window close.
    onFlushBeforeClose: (callback) => subscribe('app:flush-before-close', callback),
    flushBeforeCloseComplete: () => send('app:flush-before-close-done'),
  },

  statistics: {
    summary: () => invoke('bamboo:statistics:summary'),
  },

  instances: {
    list: () => invoke('bamboo:instances:list'),
    create: (data) => invoke('create-instance', data),
    rename: (data) => invoke('rename-instance', data),
    clone: (data) => invoke('clone-instance', data),
    createShortcut: (data) => invoke('create-desktop-shortcut', data),
    deleteFiles: (folderName) => invoke('delete-profile-files', folderName),
    openFolder: (folderName) => invoke('open-instance-folder', folderName),
    openProfileFolder: (name) => invoke('open-profile-folder', name),
    listWorlds: (folderName) => invoke('list-instance-worlds', folderName),
    repair: (data) => invoke('repair-profile', data),
    changeVersion: (data) => invoke('change-instance-version', data),
    updateLaunchSettings: (folderName, patch) =>
      invoke('bamboo:instances:update-launch', folderName, patch),
    getProfiles: () => invoke('get-profiles'),
    saveProfiles: (profiles) => invoke('save-profiles', profiles),
    onLaunchRequest: (callback) => subscribe('bamboo:launch-instance-request', callback),
  },

  mods: {
    curseforgeSearch: (data) => invoke('curseforge-search', data),
    curseforgeProject: (modId) => invoke('curseforge-project', modId),
    curseforgeFiles: (modId, gameVersion, modLoaderType) =>
      invoke('curseforge-files', modId, gameVersion, modLoaderType),
    download: (data) => invoke('download-mod', data),
    installModpack: (data) => invoke('install-modpack-mrpack', data),
    uploadLocal: (data) => invoke('upload-local-mod', data),
    listContentFiles: (data) => invoke('list-content-files', data),
    hashContentFiles: (data) => invoke('hash-content-files', data),
    identifyContentFiles: (data) => invoke('identify-content-files', data),
    deleteContentFile: (data) => invoke('delete-content-file', data),
    onUploadProgress: (callback) => subscribe('upload-progress', callback),
    onModpackProgress: (callback) => subscribe('modpack-install-progress', callback),
  },

  dialogs: {
    open: (options) => invoke('show-open-dialog', options),
    save: (options) => invoke('show-save-dialog', options),
    showItem: (filePath) => invoke('show-item-in-folder', filePath),
    readImage: (filePath) => invoke('read-image-file', filePath),
  },

  profiles: {
    export: (data) => invoke('export-profile', data),
    importPreview: (filePath) => invoke('import-preview', filePath),
    import: (data) => invoke('import-profile', data),
  },

  auth: {
    // Microsoft account auth (OAuth loopback flow). Replies carry account
    // metadata only - tokens stay in the OS secret store of the main process.
    status: () => invoke('bamboo:auth:status'),
    login: () => invoke('bamboo:auth:login'),
    cancel: () => invoke('bamboo:auth:cancel'),
    refresh: (accountId) => invoke('bamboo:auth:refresh', accountId),
    signOut: (accountId) => invoke('bamboo:auth:sign-out', accountId),
    identity: () => invoke('get-player-identity'),
    // Push from main when it dropped a session in the background (restore or a
    // launch-path refresh). Sanitized status only - never a token.
    onStatus: (callback) => subscribe('bamboo:auth:changed', callback),
  },

  skins: {
    snapshot: () => invoke('bamboo:skins:snapshot'),
    saveSkin: (payload) => invoke('bamboo:skins:save-skin', payload),
    setSkinVariant: (variant) => invoke('bamboo:skins:set-skin-variant', variant),
    resetSkin: () => invoke('bamboo:skins:reset-skin'),
    applySkin: () => invoke('bamboo:skins:apply-skin'),
    refresh: () => invoke('bamboo:skins:refresh'),
  },

  cosmetics: {
    selection: () => invoke('bamboo:cosmetics:selection'),
    saveSelection: (payload) => invoke('bamboo:cosmetics:save-selection', payload),
    saveTransform: (payload) => invoke('bamboo:cosmetics:save-transform', payload),
  },

  window: {
    minimize: () => send('window-minimize'),
    maximize: () => send('window-maximize'),
    isMaximized: () => invoke('window-is-maximized'),
    onMaximizedChange: (callback) => subscribe('window-maximized-change', callback),
    focus: () => send('window-focus'),
    close: () => send('window-close'),
  },

  java: {
    versions: (forceRescan) => invoke('get-java-versions', forceRescan),
  },

  loaders: {
    forgeVersions: () => invoke('get-forge-versions'),
    neoforgeVersions: () => invoke('get-neoforge-versions'),
  },

  servers: {
    ping: (serverIp) => invoke('ping-server', serverIp),
  },

  screenshots: {
    collect: () => invoke('collect-all-screenshots'),
    delete: (payload) => invoke('delete-screenshot-file', payload),
    openFolder: () => invoke('open-screenshots-folder'),
  },

  // Long-running work reports here so the footer bar survives navigation.
  tasks: {
    onProgress: (callback) => subscribe('background-task-progress', callback),
  },

  updates: {
    state: () => invoke('bamboo:updates:state'),
    check: () => invoke('bamboo:updates:check'),
    install: () => invoke('bamboo:updates:install'),
    onStatus: (callback) => subscribe('bamboo:updates:status', callback),
  },

  system: {
    copy: (text) => send('copy-to-clipboard', text),
    openExternal: (url) => send('open-external-url', url),
  },
})

window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    ipcRenderer.invoke('bamboo:ui:ready').catch(() => {})
  })
}, { once: true })
