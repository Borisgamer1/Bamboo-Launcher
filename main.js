const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, net, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createIpcRegistrar } = require('./dist-electron/ipc-registry.js');
const { sendBackgroundTaskProgress } = require('./dist-electron/ipc-progress.js');
// Single owner of profiles.json and the instance-folder naming rules.
const {
  profileRegistry,
  profileFolderOf,
} = require('./dist-electron/instances/profile-registry.js');
const { createInstanceFiles } = require('./dist-electron/legacy/instance-files.js');
const { registerSettingsIpc } = require('./dist-electron/legacy/settings-ipc.js');
const { registerInstanceVersionIpc } = require('./dist-electron/legacy/instance-version-ipc.js');
const { registerProfileArchiveIpc } = require('./dist-electron/legacy/profile-archive.js');
const { registerModpackIpc } = require('./dist-electron/legacy/modpack-ipc.js');
const { createInstanceSizes } = require('./dist-electron/legacy/instance-sizes.js');
const { createLegacyCurseForge } = require('./dist-electron/legacy/curseforge.js');
const { createInstanceOptions } = require('./dist-electron/legacy/instance-options.js');
const { registerScreenshotIpc } = require('./dist-electron/legacy/screenshot-ipc.js');
const { registerShellIpc } = require('./dist-electron/legacy/shell-ipc.js');
const { registerContentIpc } = require('./dist-electron/legacy/content-ipc.js');
const { createMainWindow } = require('./dist-electron/legacy/window.js');
const { registerLaunchIpc } = require('./dist-electron/legacy/launch-ipc.js');
const { registerShortcutIpc } = require('./dist-electron/legacy/shortcut-ipc.js');
const { registerProfileIpc } = require('./dist-electron/legacy/profile-ipc.js');
const { createDiscordPresence } = require('./dist-electron/legacy/discord-presence.js');
const { installLoaderViaCore } = require('./dist-electron/legacy/loader-install.js');
// Single owner for "which folder does this content type go into".
const { downloadFolder } = require('./dist-electron/mods/legacy/shared.js');
const { inspectJarMetadata } = require('./dist-electron/mods/jar-inspect.js');
const { startRPC, setActivity: setDiscordActivity } = require('./src/discordRPC');

// The core creates the file logger; shell code shares it once the core is ready.
// Before that, warnings and errors still reach the console so a failed boot is visible.
let shellLogger = null;
function attachShellLogger(core) {
  if (core?.logger) shellLogger = core.logger.child('shell');
}
const shellLog = {
  debug(message, data) {
    if (shellLogger) shellLogger.debug(message, data);
  },
  info(message, data) {
    if (shellLogger) shellLogger.info(message, data);
  },
  warn(message, data) {
    if (shellLogger) shellLogger.warn(message, data);
    else console.warn(`[shell] ${message}`, data ?? '');
  },
  error(message, data) {
    if (shellLogger) shellLogger.error(message, data);
    else console.error(`[shell] ${message}`, data ?? '');
  },
};

const { writeFirstRunOptions, applyLauncherGameOptions } = createInstanceOptions(shellLog);

// One owner for profile folders and for the core instance register.
const {
  readProfilesSync,
  writeProfilesSync,
  upsertCoreInstance,
  removeCoreInstance,
  renameCoreInstance,
  syncCoreInstances,
  isInsideDirectory,
  profileDirOrNull,
  uniqueProfileFolder,
  uniqueProfileName,
  repairProfileFolderCollisions,
} = createInstanceFiles({
  logger: shellLog,
  resolveGameRoot,
  getCore: getBambooCore,
});
const legacyCurseForge = createLegacyCurseForge({
  keyPath: path.join(__dirname, 'resources', 'curseforge-key.txt'),
  logger: shellLog,
});
const {
  readApiKey: readCurseForgeApiKey,
  headers: curseForgeHeaders,
  request: curseForgeFetch,
} = legacyCurseForge;

// Instance sizes are measured off the save path; the cache and the background
// pass live in one module so main only reads a number and queues a folder.
const {
  cache: instanceSizeCache,
  dirty: instanceSizeDirty,
  markDirty: markInstanceSizeDirty,
  forget: forgetInstanceSize,
  format: formatSize,
  scheduleRefresh: scheduleInstanceSizeRefresh,
} = createInstanceSizes({
  logger: shellLog,
  readProfiles: readProfilesSync,
  profileFolderOf,
  profileDirOrNull,
  registry: profileRegistry,
});

// Every channel below goes through this one registration path. It applies the
// sender check and the argument schemas before the legacy handler runs.
const ipc = createIpcRegistrar(ipcMain);
legacyCurseForge.register(ipc);

let bambooCorePromise = null;
function broadcastLogAnalysis(result) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('bamboo:logs:analysis', result);
  }
}

function broadcastAuthStatus(status) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('bamboo:auth:changed', status);
  }
}

function getBambooCore() {
  if (!bambooCorePromise) {
    bambooCorePromise = require('./dist-electron/index.js').initializeCore({
      onAnalysis: broadcastLogAnalysis,
      onSessionLost: broadcastAuthStatus,
    }).then((core) => {
      bambooGameRoot = core.paths.gameRoot;
      attachShellLogger(core);
      return core;
    }).catch((err) => {
      shellLog.error('core initialization failed', { error: err instanceof Error ? err.message : String(err) });
      bambooCorePromise = null;
      return null;
    });
  }
  return bambooCorePromise;
}

function getLegacyModsBridge() {
  try {
    return require('./dist-electron/mods/legacy-bridge.js');
  } catch (error) {
    shellLog.warn('mods bridge unavailable', { error: error.message });
    return null;
  }
}

let bambooGameRoot = null;
function legacyGameRoot() {
  try {
    return require('./dist-electron/paths.js').legacyGameRoot();
  } catch (error) {
    // A missing core build must not break the legacy window.
    shellLog.debug('legacy game root fallback used', { error: error instanceof Error ? error.message : String(error) });
    return process.platform === 'win32' ? path.join(process.env.SystemDrive || 'C:', 'BambooLaufwerk') : path.join(require('os').homedir(), 'BambooLaufwerk');
  }
}
function gameRoot() {
  return bambooGameRoot ?? legacyGameRoot();
}
async function resolveGameRoot() {
  const core = await getBambooCore();
  if (core) bambooGameRoot = core.paths.gameRoot;
  return gameRoot();
}

// Window chrome, dialogs, clipboard and file helpers live in their own module.
registerShellIpc(ipc, {
  getWindow: () => mainWindow,
  gameRoot,
  dialog,
  shell,
  clipboard,
  logger: shellLog,
});
registerScreenshotIpc(ipc, {
  gameRoot,
  profileDirOrNull,
  openPath: (target) => shell.openPath(target),
  logger: shellLog,
});
// Content files: hashing, identification, listing, upload and delete.
registerContentIpc(ipc, {
  gameRoot,
  profileDirOrNull,
  isInsideDirectory,
  downloadFolder,
  logger: shellLog,
  markInstanceSizeDirty,
  inspectJarMetadata,
  getBridge: getLegacyModsBridge,
  appVersion: () => app.getVersion(),
  curseForge: legacyCurseForge,
});
const installLoader = (loader, minecraftVersion, loaderVersion, onProgress) =>
  installLoaderViaCore(getBambooCore, loader, minecraftVersion, loaderVersion, onProgress);
const updateDiscordPresence = createDiscordPresence(setDiscordActivity);
const launches = registerLaunchIpc(ipc, {
  logger: shellLog,
  resolveGameRoot,
  profileDirOrNull,
  getCore: getBambooCore,
  writeFirstRunOptions,
  applyLauncherGameOptions,
  updatePresence: updateDiscordPresence,
});
registerShortcutIpc(ipc, {
  gameRoot,
  readProfiles: readProfilesSync,
  profileFolderOf,
  logger: shellLog,
  shell,
  nativeImage,
  app,
  platform: process.platform,
});

registerProfileIpc(ipc, {
  logger: shellLog,
  gameRoot,
  resolveGameRoot,
  shell,
  launches,
  instanceSizeCache,
  instanceSizeDirty,
  formatSize,
  scheduleInstanceSizeRefresh,
  forgetInstanceSize,
  readProfilesSync,
  writeProfilesSync,
  profileDirOrNull,
  uniqueProfileFolder,
  uniqueProfileName,
  upsertCoreInstance,
  removeCoreInstance,
  renameCoreInstance,
  syncCoreInstances,
  writeFirstRunOptions,
});
registerSettingsIpc(ipc, { getCore: getBambooCore, logger: shellLog });
registerInstanceVersionIpc(ipc, {
  logger: shellLog,
  resolveGameRoot,
  getCore: getBambooCore,
  installLoader,
});
registerProfileArchiveIpc(ipc, {
  logger: shellLog,
  gameRoot,
  profileDirOrNull,
  readApiKey: readCurseForgeApiKey,
  getBridge: getLegacyModsBridge,
});
registerModpackIpc(ipc, {
  logger: shellLog,
  gameRoot,
  readProfiles: readProfilesSync,
  uniqueProfileFolder,
  installLoader,
  markInstanceSizeDirty,
});

const __sysIcons = {};
try {
  const iconPaths = [
    path.join(__dirname, 'resources', 'SystemIcons'),
    path.join(typeof process !== 'undefined' && process.resourcesPath ? process.resourcesPath : '', 'SystemIcons'),
    path.join(__dirname, '..', 'resources', 'SystemIcons'),
    'C:\\Bamboo Launcher\\resources\\SystemIcons',
  ];
  let foundDir = null;
  for (const p of iconPaths) {
    if (fs.existsSync(p)) { foundDir = p; break; }
  }
  if (foundDir) {
    const files = fs.readdirSync(foundDir).filter(f => f.endsWith('.png'));
    for (const f of files) {
      const name = path.basename(f, '.png');
      const data = fs.readFileSync(path.join(foundDir, f));
      __sysIcons[name] = `data:image/png;base64,${data.toString('base64')}`;
    }
    shellLog.debug('system icons loaded', { count: Object.keys(__sysIcons).length });
  } else {
    shellLog.warn('system icons directory not found');
  }
} catch (e) {
  shellLog.error('system icons failed to load', { error: e.message });
}

ipc.on('get-icons', (event) => {
  event.returnValue = __sysIcons;
});

// Server status responses are cached briefly and identical in-flight requests
// are shared, so refreshing the list or watching a typed address costs one
// upstream call instead of one per render. api.mcsrvstat.us is free and needs
// no key.
const SERVER_STATUS_TTL_MS = 60 * 1000;
const serverStatusCache = new Map();
const serverStatusInFlight = new Map();

function normalizeServerAddress(value) {
  return String(value || '')
    .trim()
    .replace(/^minecraft:\/\//i, '')
    .replace(/\/+$/, '') || '';
}

async function fetchServerStatus(address) {
  const startedAt = Date.now();
  const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(address)}`;
  const res = await net.fetch(url, { signal: AbortSignal.timeout(4000) });
  const duration = Date.now() - startedAt;
  if (!res.ok) return { online: false, ping: 999, error: `HTTP ${res.status}` };
  const data = await res.json();
  return {
    online: data.online ?? false,
    playersOnline: data.players?.online ?? 0,
    playersMax: data.players?.max ?? 0,
    motd: data.motd?.clean?.join("\n") || "",
    ping: duration,
    version: data.version || "Unknown",
    icon: data.icon || null,
  };
}

ipc.handle('ping-server', async (_event, serverIp) => {
  const address = normalizeServerAddress(serverIp);
  if (!address) return { online: false, ping: 999, error: 'Leere Serveradresse' };
  const cached = serverStatusCache.get(address);
  if (cached && Date.now() - cached.at < SERVER_STATUS_TTL_MS) return cached.value;
  const pending = serverStatusInFlight.get(address);
  if (pending) return pending;
  const request = fetchServerStatus(address)
    .catch((error) => ({ online: false, ping: 999, error: error.message }))
    .then((value) => {
      serverStatusCache.set(address, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      serverStatusInFlight.delete(address);
    });
  serverStatusInFlight.set(address, request);
  return request;
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'bamboo-file', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const instanceArg = readInstanceLaunchArg(commandLine);
    if (instanceArg) queueInstanceLaunch(instanceArg);
  });
}

// Desktop shortcuts pass --bamboo-instance=<folder>; the renderer starts the
// profile once it has loaded, so the shortcut behaves like pressing Play.
let rendererReady = false;
let pendingInstanceLaunch = '';

function readInstanceLaunchArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--bamboo-instance=')) {
      return arg.slice('--bamboo-instance='.length).replace(/^"|"$/g, '').trim();
    }
    if (arg === '--bamboo-instance' && typeof args[index + 1] === 'string') {
      return args[index + 1].replace(/^"|"$/g, '').trim();
    }
  }
  return '';
}

function sendInstanceLaunchRequest(folderName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingInstanceLaunch = folderName;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('bamboo:launch-instance-request', folderName);
}

function flushPendingInstanceLaunch() {
  if (!pendingInstanceLaunch || !rendererReady) return;
  const folderName = pendingInstanceLaunch;
  pendingInstanceLaunch = '';
  sendInstanceLaunchRequest(folderName);
}

function queueInstanceLaunch(folderName) {
  const clean = String(folderName || '').trim();
  if (!clean) return;
  pendingInstanceLaunch = clean;
  flushPendingInstanceLaunch();
}

app.whenReady().then(async () => {
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    app.setAppUserModelId('de.bamboo.launcher.app');
  }
  await getBambooCore();
  try {
    const { repaired } = repairProfileFolderCollisions(gameRoot());
    if (repaired > 0) {
      shellLog.info('instance folder collisions repaired at startup', { repaired });
      // The same projection that follows a save writes the repaired folders
      // into the core register; no handler writes it on its own.
      await syncCoreInstances(readProfilesSync(gameRoot()));
    }
  } catch (error) {
    shellLog.warn('instance folder collision migration failed', { error: error.message });
  }
  try {
    const { setupAutoUpdater } = require('./dist-electron/updater.js');
    setupAutoUpdater({ logger: shellLog, ipc });
  } catch (error) {
    // A missing updater module must never prevent the launcher from starting.
    shellLog.warn('auto-updater unavailable', { error: error.message });
  }
  mainWindow = createMainWindow({
    app,
    BrowserWindow,
    protocol,
    net,
    Menu,
    shell,
    ipc,
    logger: shellLog,
    statePath: () => path.join(gameRoot(), 'window-state.json'),
    preloadPath: path.join(__dirname, 'preload.js'),
    iconPath: path.join(__dirname, 'resources', 'icon.png'),
    rendererEntry: path.join(__dirname, 'dist', 'index.html'),
    devServerUrl: process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173',
  });
  const startupInstance = readInstanceLaunchArg(process.argv);
  if (startupInstance) queueInstanceLaunch(startupInstance);
  await startRPC();
  updateDiscordPresence('launcher');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipc.handle('bamboo:ui:ready', async () => {
  rendererReady = true;
  setTimeout(flushPendingInstanceLaunch, 200);
  return true;
});

ipc.handle('download-mod', async (event, payload) => {
  const modsBridge = getLegacyModsBridge();
  if (modsBridge && typeof modsBridge.installLegacyMod === 'function') {
    const result = await modsBridge.installLegacyMod(payload, {
      curseforgeApiKey: readCurseForgeApiKey(),
      onBackgroundTask: (progress) => sendBackgroundTaskProgress(event, progress, shellLog, 'download-mod'),
    });
    if (result && result.success !== false) markInstanceSizeDirty(payload?.folderName);
    return result;
  }
  // The core bridge owns the download and its path validation. A second copy
  // here wrote path.join(destDir, filename) with an API-supplied name.
  return { success: false, error: 'Mod-Installation nicht verfügbar (Core fehlt).', code: 'mod-install-unavailable' };
});
