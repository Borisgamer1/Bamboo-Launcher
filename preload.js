const { contextBridge, ipcRenderer } = require('electron')

// Icons werden synchron aus main.js geladen (kein require('fs') nötig!)
let iconCache = {};
try {
  iconCache = ipcRenderer.sendSync('get-icons');
} catch (e) {
  console.error('[preload] icon-fehler (nicht kritisch):', e);
}

contextBridge.exposeInMainWorld('electronAPI', {
  iconCache,
  launchGame: (payload) => {
    ipcRenderer.send('launch-game', payload)
  },
  onLaunchStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('launch-status', listener)
    return () => ipcRenderer.removeListener('launch-status', listener)
  },
  onGameClosed: (callback) => {
    const listener = (_event, code) => callback(code)
    ipcRenderer.on('game-closed', listener)
    return () => ipcRenderer.removeListener('game-closed', listener)
  },
  onGameReady: (callback) => {
    const listener = (_event, profileName) => callback(profileName)
    ipcRenderer.on('game-ready', listener)
    return () => ipcRenderer.removeListener('game-ready', listener)
  },
  startMicrosoftLogin: () => {
    ipcRenderer.send('microsoft-login-device-code')
  },
  onMsDeviceCode: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('ms-device-code', listener)
    return () => ipcRenderer.removeListener('ms-device-code', listener)
  },
  onMsLoginStep: (callback) => {
    const listener = (_event, step) => callback(step)
    ipcRenderer.on('ms-login-step', listener)
    return () => ipcRenderer.removeListener('ms-login-step', listener)
  },
  onMsLoginResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('ms-login-result', listener)
    return () => ipcRenderer.removeListener('ms-login-result', listener)
  },
  copyToClipboard: (text) => {
    ipcRenderer.send('copy-to-clipboard', text)
  },
  openExternal: (url) => {
    ipcRenderer.send('open-external-url', url)
  },
  writeOptionsTxt: (data) => ipcRenderer.invoke('write-options-txt', data),
  findJava: () => ipcRenderer.invoke('find-java'),
  getJavaVersions: (forceRescan) => ipcRenderer.invoke('get-java-versions', forceRescan),
  // Unified screenshots collection
  collectAllScreenshots: () => ipcRenderer.invoke('collect-all-screenshots'),
  deleteScreenshotFile: (absolutePath) => ipcRenderer.invoke('delete-screenshot-file', absolutePath),
  openScreenshotsFolder: () => ipcRenderer.invoke('open-screenshots-folder'),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  saveProfiles: (profiles) => ipcRenderer.invoke('save-profiles', profiles),
  getCollections: () => ipcRenderer.invoke('get-collections'),
  saveCollections: (collections) => ipcRenderer.invoke('save-collections', collections),
  openProfileFolder: (name) => ipcRenderer.invoke('open-profile-folder', name),
  openInstanceFolder: (folderName) => ipcRenderer.invoke('open-instance-folder', folderName),
  downloadMod: (data) => ipcRenderer.invoke('download-mod', data),
  installModpackMrpack: (data) => ipcRenderer.invoke('install-modpack-mrpack', data),
  getForgeVersions: () => ipcRenderer.invoke('get-forge-versions'),
  getNeoforgeVersions: () => ipcRenderer.invoke('get-neoforge-versions'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getPlayerIdentity: () => ipcRenderer.invoke('get-player-identity'),
  curseforgeSearch: (data) => ipcRenderer.invoke('curseforge-search', data),
  curseforgeProject: (modId) => ipcRenderer.invoke('curseforge-project', modId),
  curseforgeFiles: (modId, gameVersion, modLoaderType) => ipcRenderer.invoke('curseforge-files', modId, gameVersion, modLoaderType),
  deleteProfileFiles: (folderName) => ipcRenderer.invoke('delete-profile-files', folderName),
  deleteContentFile: (data) => ipcRenderer.invoke('delete-content-file', data),
  listContentFiles: (data) => ipcRenderer.invoke('list-content-files', data),
  repairProfile: (data) => ipcRenderer.invoke('repair-profile', data),
  onRepairProgress: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('repair-progress', listener)
    return () => ipcRenderer.removeListener('repair-progress', listener)
  },
  completeReinstall: (profiles) => ipcRenderer.invoke('complete-reinstall', profiles),
  onReinstallProgress: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('reinstall-progress', listener)
    return () => ipcRenderer.removeListener('reinstall-progress', listener)
  },
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  pingServer: (serverIp) => ipcRenderer.invoke('ping-server', serverIp),
  readImageFile: (filePath) => ipcRenderer.invoke('read-image-file', filePath),
  exportProfile: (data) => ipcRenderer.invoke('export-profile', data),
  importPreview: (data) => ipcRenderer.invoke('import-preview', data),
  importProfile: (data) => ipcRenderer.invoke('import-profile', data),
  readFileAsBase64: (filePath) => ipcRenderer.invoke('read-file-as-base64', filePath),
  saveTempFile: (data) => ipcRenderer.invoke('save-temp-file', data),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),
  // ===== Cosmetics Filesystem Operations =====
  saveCosmeticFiles: (data) => ipcRenderer.invoke('save-cosmetic-files', data),
  readCosmeticFile: (filePath) => ipcRenderer.invoke('read-cosmetic-file', filePath),
  // ===== Cosmetics Progress (live from Minecraft client) =====
  onCosmeticProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('cosmetic-progress', listener);
    return () => ipcRenderer.removeListener('cosmetic-progress', listener);
  },
  // Friends API
  getFriendsStore: () => ipcRenderer.invoke('get-friends-store'),
  saveFriendsStore: (data) => ipcRenderer.invoke('save-friends-store', data),
  searchUsers: (query) => ipcRenderer.invoke('search-users', query),
  sendFriendRequest: (userId) => ipcRenderer.invoke('send-friend-request', userId),
  acceptFriendRequest: (userId) => ipcRenderer.invoke('accept-friend-request', userId),
  declineFriendRequest: (userId) => ipcRenderer.invoke('decline-friend-request', userId),
  blockUser: (userId) => ipcRenderer.invoke('block-user', userId),
  removeFriend: (userId) => ipcRenderer.invoke('remove-friend', userId),
  updateFriendStatus: (status) => ipcRenderer.invoke('update-friend-status', status),
  updateFriendActivity: (activity) => ipcRenderer.invoke('update-friend-activity', activity),
  buildInviteLink: (payload) => ipcRenderer.invoke('build-invite-link', payload),
  sendFriendInvitation: (data) => ipcRenderer.invoke('send-friend-invitation', data),
  acceptFriendInvitation: (notificationId) => ipcRenderer.invoke('accept-friend-invitation', notificationId),
  declineFriendInvitation: (notificationId) => ipcRenderer.invoke('decline-friend-invitation', notificationId),
  saveFriendAvatar: (filePath) => ipcRenderer.invoke('save-friend-avatar', filePath),
  saveFriendBanner: (filePath) => ipcRenderer.invoke('save-friend-banner', filePath),
  onDeepLinkInvite: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deep-link-invite', listener);
    return () => ipcRenderer.removeListener('deep-link-invite', listener);
  },
  getActiveLaunches: () => ipcRenderer.invoke('get-active-launches'),
  detectLanServer: (folderName) => ipcRenderer.invoke('detect-lan-server', folderName),
  getHostedServers: () => ipcRenderer.invoke('get-hosted-servers'),
  // Issue 24: Custom version upload
  uploadLocalMod: (data) => ipcRenderer.invoke('upload-local-mod', data),
  onUploadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('upload-progress', listener);
    return () => ipcRenderer.removeListener('upload-progress', listener);
  },
})
