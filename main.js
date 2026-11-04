const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, net, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createIpcRegistrar } = require('./dist-electron/ipc-registry.js');
const { deleteScreenshotFile } = require('./dist-electron/screenshots.js');
// Single owner for "which folder does this content type go into".
const { downloadFolder } = require('./dist-electron/mods/legacy/shared.js');
// Shared with the renderer and the CurseForge provider; compiled from electron/shared.
const { CURSEFORGE_CLASS_IDS: CF_CLASS_IDS } = require('./dist-electron/shared/curseforgeClassIds.js');
const {
  shortcutCoverPlan,
  shortcutIconFileName,
  pngToIco,
} = require('./dist-electron/shared/shortcutIcon.js');

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

const ACTIVE_LAUNCHES = new Map();
// Every channel below goes through this one registration path. It applies the
// sender check and the argument schemas before the legacy handler runs.
const ipc = createIpcRegistrar(ipcMain);

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

// ---------------------------------------------------------------------------
// Instance folders
//
// Legacy profiles live in <gameRoot>/profiles/<folderName>. Before 0.2.0 the
// folder was always derived from the display name, so two installs of the same
// modpack (or two versions of it) silently shared one directory. Every writer
// now reserves a free folder first, and existing collisions are repaired once
// at startup.
// ---------------------------------------------------------------------------
function profileFolderSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'instance';
}

function profileFolderOf(profile) {
  const stored = typeof profile?.folderName === 'string' ? profile.folderName.trim() : '';
  if (stored && stored !== '.' && stored !== '..') return path.basename(stored);
  return profileFolderSlug(profile?.name || profile?.id || 'instance');
}

function readProfilesSync(rootPath) {
  const profilesPath = path.join(rootPath, 'profiles.json');
  if (!fs.existsSync(profilesPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    shellLog.warn('profiles.json is unreadable', { path: profilesPath, error: error.message });
    return [];
  }
}

function writeProfilesSync(rootPath, profiles) {
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'profiles.json'), JSON.stringify(profiles, null, 2));
}

function nextFreeProfileFolder(rootPath, base, used) {
  const slug = profileFolderSlug(base);
  let candidate = slug;
  let index = 2;
  while (
    used.has(candidate.toLowerCase()) ||
    fs.existsSync(path.join(rootPath, 'profiles', candidate))
  ) {
    candidate = `${slug}-${index}`;
    index += 1;
  }
  return candidate;
}

// Every instance folder is a direct child of profiles/. ".." or a nested path
// from the renderer would let a delete or write leave that folder.
function profileDirOrNull(rootPath, folderName) {
  if (!folderName || typeof folderName !== 'string') return null;
  const profiles = path.join(rootPath, 'profiles');
  const target = path.resolve(profiles, folderName);
  return path.dirname(target) === profiles ? target : null;
}

function uniqueProfileFolder(rootPath, desiredBase, profiles, excludeFolder) {
  const base = profileFolderSlug(desiredBase);
  const excluded = String(excludeFolder || '').toLowerCase();
  const used = new Set(
    profiles
      .map(profileFolderOf)
      .map((folder) => folder.toLowerCase())
      .filter((folder) => folder && folder !== excluded),
  );
  let candidate = base;
  let index = 2;
  while (
    candidate.toLowerCase() !== excluded &&
    (used.has(candidate.toLowerCase()) || fs.existsSync(path.join(rootPath, 'profiles', candidate)))
  ) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

function uniqueProfileName(profiles, baseName) {
  const base = String(baseName || '').trim() || 'Instanz';
  const used = new Set(
    profiles.map((profile) => String(profile?.name || '').toLowerCase()).filter(Boolean),
  );
  if (!used.has(base.toLowerCase())) return base;
  let index = 2;
  while (used.has(`${base} (${index})`.toLowerCase())) index += 1;
  return `${base} (${index})`;
}

/**
 * Gives every profile that shared a folder with another profile its own copy.
 * The first owner keeps the original directory; later profiles are copied so
 * worlds/config are not lost. Returns the changes so the core register can be
 * updated too: otherwise its stale folderName would overwrite the repair as
 * soon as the renderer saves the profile list again.
 */
function repairProfileFolderCollisions(rootPath) {
  const profiles = readProfilesSync(rootPath);
  if (profiles.length === 0) return { repaired: 0, changes: [] };
  const used = new Set();
  const changes = [];
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    const folder = profileFolderOf(profile);
    const key = folder.toLowerCase();
    if (profile.folderName !== folder) {
      profile.folderName = folder;
      changes.push({ id: profile.id, folderName: folder });
    }
    if (!used.has(key)) {
      used.add(key);
      continue;
    }
    const source = path.join(rootPath, 'profiles', folder);
    const targetFolder = nextFreeProfileFolder(rootPath, profile.name || folder, used);
    const target = path.join(rootPath, 'profiles', targetFolder);
    try {
      if (fs.existsSync(source)) {
        fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
      profile.folderName = targetFolder;
      used.add(targetFolder.toLowerCase());
      changes.push({ id: profile.id, folderName: targetFolder });
      shellLog.info('instance folder collision repaired', {
        instance: profile.name,
        from: folder,
        to: targetFolder,
      });
    } catch (error) {
      shellLog.warn('instance folder collision could not be repaired', {
        instance: profile.name,
        from: folder,
        target: targetFolder,
        error: error.message,
      });
    }
  }
  if (changes.length > 0) writeProfilesSync(rootPath, profiles);
  return { repaired: changes.length, changes };
}

// Never print credentials: the launch core masks --accessToken before logging.
const SECRET_LOG_KEY = /(token|secret|password|api[_-]?key|authorization)/i;
function redactForLog(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, entry) => (SECRET_LOG_KEY.test(key) ? '[redacted]' : entry)));
  } catch {
    // Serialising the log payload must not throw; the placeholder is the record.
    return '[unserializable]';
  }
}

const DISCORD_PRESENCE_DEFAULTS = {
  largeImageKey: 'bamboo',
  largeImageText: 'Bamboo Launcher',
};

let _lastRpcStatus = '';
let _lastRpcDetails = '';

function updateDiscordPresence(status, profileName, extraText) {
  const now = new Date();

  let details = '';
  let state = '';
  let smallImageKey;
  let smallImageText;

  switch (status) {
    case 'launcher':
      details = 'In Bamboo Launcher';
      state = extraText || 'Browsing profiles & mods';
      break;

    case 'starting':
      details = `Starting ${profileName || 'Minecraft'}`;
      state = 'Launching...';
      smallImageKey = 'minecraft';
      smallImageText = profileName || '';
      break;

    case 'inGame':
      details = `Playing ${profileName || 'Minecraft'}`;
      state = extraText || '';
      smallImageKey = 'minecraft';
      smallImageText = profileName || '';
      break;

    case 'browsing':
      details = 'Browsing mods';
      state = extraText || 'Mod Browser';
      smallImageKey = 'minecraft';
      smallImageText = 'Mod Browser';
      break;

    case 'back':
      details = 'In Bamboo Launcher';
      state = 'Main menu';
      break;

    default:
      details = 'In Bamboo Launcher';
      state = '';
      break;
  }

  if (details === _lastRpcDetails && state === _lastRpcStatus) return;
  _lastRpcDetails = details;
  _lastRpcStatus = state;

  const activity = {
    details,
    state,
    startTimestamp: ['launcher', 'back'].includes(status) ? undefined : now,
  };

  if (smallImageKey) activity.smallImageKey = smallImageKey;
  if (smallImageText) activity.smallImageText = smallImageText;

  setDiscordActivity({ ...DISCORD_PRESENCE_DEFAULTS, ...activity });
}

const MAX_CONCURRENT_LAUNCHES = 4;
let launchCounter = 0;

function mcVersionNum(ver) {
  const parts = String(ver || '').split('.').map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

const FRONTEND_KEY_TO_MINECRAFT = {
  'A':'key.keyboard.a','B':'key.keyboard.b','C':'key.keyboard.c','D':'key.keyboard.d',
  'E':'key.keyboard.e','F':'key.keyboard.f','G':'key.keyboard.g','H':'key.keyboard.h',
  'I':'key.keyboard.i','J':'key.keyboard.j','K':'key.keyboard.k','L':'key.keyboard.l',
  'M':'key.keyboard.m','N':'key.keyboard.n','O':'key.keyboard.o','P':'key.keyboard.p',
  'Q':'key.keyboard.q','R':'key.keyboard.r','S':'key.keyboard.s','T':'key.keyboard.t',
  'U':'key.keyboard.u','V':'key.keyboard.v','W':'key.keyboard.w','X':'key.keyboard.x',
  'Y':'key.keyboard.y','Z':'key.keyboard.z',
  '0':'key.keyboard.0','1':'key.keyboard.1','2':'key.keyboard.2','3':'key.keyboard.3',
  '4':'key.keyboard.4','5':'key.keyboard.5','6':'key.keyboard.6','7':'key.keyboard.7',
  '8':'key.keyboard.8','9':'key.keyboard.9',
  'SPACE':'key.keyboard.space','TAB':'key.keyboard.tab','ESCAPE':'key.keyboard.escape',
  'ENTER':'key.keyboard.enter','DELETE':'key.keyboard.delete','BACK_SPACE':'key.keyboard.backspace',
  'LEFT_SHIFT':'key.keyboard.left.shift','LEFT_CONTROL':'key.keyboard.left.control','LEFT_ALT':'key.keyboard.left.alt',
  'RIGHT_SHIFT':'key.keyboard.right.shift','RIGHT_CONTROL':'key.keyboard.right.control','RIGHT_ALT':'key.keyboard.right.alt',
  'UP':'key.keyboard.up','DOWN':'key.keyboard.down','LEFT':'key.keyboard.left','RIGHT':'key.keyboard.right',
  'F1':'key.keyboard.f1','F2':'key.keyboard.f2','F3':'key.keyboard.f3','F4':'key.keyboard.f4',
  'F5':'key.keyboard.f5','F6':'key.keyboard.f6','F7':'key.keyboard.f7','F8':'key.keyboard.f8',
  'F9':'key.keyboard.f9','F10':'key.keyboard.f10','F11':'key.keyboard.f11','F12':'key.keyboard.f12',
  'F13':'key.keyboard.f13','F14':'key.keyboard.f14','F15':'key.keyboard.f15',
  'CAPS_LOCK':'key.keyboard.caps.lock','PAGE_UP':'key.keyboard.page.up','PAGE_DOWN':'key.keyboard.page.down',
  'HOME':'key.keyboard.home','END':'key.keyboard.end','INSERT':'key.keyboard.insert',
  'PRINT_SCREEN':'key.keyboard.print.screen','PAUSE':'key.keyboard.pause',
  'NUMPAD0':'key.keyboard.numpad.0','NUMPAD1':'key.keyboard.numpad.1','NUMPAD2':'key.keyboard.numpad.2',
  'NUMPAD3':'key.keyboard.numpad.3','NUMPAD4':'key.keyboard.numpad.4','NUMPAD5':'key.keyboard.numpad.5',
  'NUMPAD6':'key.keyboard.numpad.6','NUMPAD7':'key.keyboard.numpad.7','NUMPAD8':'key.keyboard.numpad.8',
  'NUMPAD9':'key.keyboard.numpad.9',
  'SLASH':'key.keyboard.slash','BACKSLASH':'key.keyboard.backslash','PERIOD':'key.keyboard.period',
  'COMMA':'key.keyboard.comma','SEMICOLON':'key.keyboard.semicolon','APOSTROPHE':'key.keyboard.apostrophe',
  'LEFT_BRACKET':'key.keyboard.left.bracket','RIGHT_BRACKET':'key.keyboard.right.bracket',
  'MINUS':'key.keyboard.minus','EQUALS':'key.keyboard.equals','GRAVE':'key.keyboard.grave',
  'MOUSE_BUTTON_1':'key.mouse.left','MOUSE_BUTTON_2':'key.mouse.right','MOUSE_BUTTON_3':'key.mouse.middle',
};

function convertKeyCode(code) {
  return FRONTEND_KEY_TO_MINECRAFT[code] || code;
}

function getDataVersion(ver) {
  const parts = String(ver || '').split('.').map(Number);
  const major = parts[0] || 0, minor = parts[1] || 0, patch = parts[2] || 0;
  if (major === 26) {
    if (minor >= 2) return 5200;
    if (minor >= 1) {
      if (patch >= 2) return 5100; if (patch >= 1) return 5050;
      return 5000;
    }
  }
  if (major === 1) {
    if (minor >= 21) {
      if (patch >= 11) return 4903; if (patch >= 10) return 4902;
      if (patch >= 9) return 4901; if (patch >= 8) return 4200;
      if (patch >= 7) return 4190; if (patch >= 6) return 4189;
      if (patch >= 5) return 4189; if (patch >= 4) return 4189;
      if (patch >= 3) return 4086; if (patch >= 2) return 4080;
      if (patch >= 1) return 3955;
      return 3955;
    }
    if (minor >= 20) {
      if (patch >= 6) return 4086; if (patch >= 5) return 4080; if (patch >= 4) return 3837;
      return 3708;
    }
    if (minor >= 19) { if (patch >= 4) return 3425; return 3117; }
    if (minor >= 18) { if (patch >= 2) return 2976; return 2865; }
    if (minor >= 17) return 2730;
    if (minor >= 16) { if (patch >= 5) return 2586; return 2566; }
    if (minor >= 15) return 2230;
    if (minor >= 14) return 1976;
    if (minor >= 13) return 1631;
    if (minor >= 12) return 1343;
    if (minor >= 11) return 1022;
    if (minor >= 10) return 818;
  }
  return 0;
}

// Only `key.*` ids with `key.*` token values belong in options.txt; anything
// else is dropped so a malformed profile can never corrupt the file.
function normalizeKeyBindings(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return undefined;
  const normalized = {};
  for (const [id, token] of Object.entries(bindings)) {
    if (id.startsWith('key.') && typeof token === 'string' && token.startsWith('key.')) normalized[id] = token;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// The launcher remembers the values it wrote. Minecraft rewrites options.txt on
// exit, so a whole-file hash would block every later launch and a launcher
// setting would only ever land once. Per value instead: the launcher rewrites a
// line only while it still holds the launcher's own value, so an in-game edit the
// user made is never reset.
const OPTIONS_SYNC_FILE = '.bamboo-options-sync.json';

function optionsFileHash(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function readOptionsSyncState(gameDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(gameDir, OPTIONS_SYNC_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      hash: typeof parsed.hash === 'string' ? parsed.hash : null,
      values: parsed.values && typeof parsed.values === 'object' ? parsed.values : {},
    };
  } catch {
    return null;
  }
}

function writeOptionsSyncState(gameDir, text, values) {
  try {
    fs.writeFileSync(
      path.join(gameDir, OPTIONS_SYNC_FILE),
      JSON.stringify({ hash: optionsFileHash(text), values: values || {}, updatedAt: Date.now() }, null, 2),
      'utf8',
    );
  } catch (error) {
    shellLog.warn('options sync marker could not be written', { gameDir, error: error.message });
  }
}

function writeFirstRunOptions(gameDir, options) {
  const optionsPath = path.join(gameDir, 'options.txt');
  if (!options || typeof options !== 'object') return { created: false, path: optionsPath, reason: 'no-options' };
  if (fs.existsSync(optionsPath)) return { created: false, path: optionsPath, reason: 'exists' };
  fs.mkdirSync(gameDir, { recursive: true });
  const keyBindings = normalizeKeyBindings(options.keyBindings);
  const text = buildOptionsTxt({ ...options, keyBindings });
  fs.writeFileSync(optionsPath, text, 'utf8');
  writeOptionsSyncState(gameDir, text);
  return { created: true, path: optionsPath, keybindCount: keyBindings ? Object.keys(keyBindings).length : 0 };
}

function buildOptionsTxt(options) {
  const lines = [];
  const mcVer = mcVersionNum(options._mcVersion || '1.21');

  function safeNum(val, fallback) {
    const n = Number(val);
    return isNaN(n) ? fallback : n;
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
  function str(v, fallback) { return (v !== undefined && v !== null && v !== '') ? String(v).trim() : fallback; }
  function pctToFloat(v, fallback) { return (clamp(safeNum(v, fallback * 100), 0, 100) / 100).toFixed(1); }
  function enumValue(v) { return mcVer >= 26000 ? '"' + v + '"' : v; }

  const dataVersion = getDataVersion(options._mcVersion || '1.21');
  if (dataVersion > 0) lines.push('version:' + dataVersion);
  if (mcVer >= 26000) lines.push('graphicsPreset:"custom"');

  const fovDeg = clamp(safeNum(options.fov, 70), 30, 110);
  lines.push('fov:' + ((fovDeg - 70) / 40).toFixed(6));

  lines.push('renderDistance:' + clamp(safeNum(options.renderDistance, 12), 2, 32));

  if (mcVer >= 11800) {
    lines.push('simulationDistance:' + clamp(safeNum(options.simulationDistance || options.renderDistance, 12), 5, 32));
  }

  lines.push('guiScale:' + clamp(safeNum(options.guiScale, 0), 0, 4));
  lines.push('fullscreen:' + (bool(options.fullscreen) ? 'true' : 'false'));
  lines.push('enableVsync:' + (options.vsync !== false ? 'true' : 'false'));

  const maxFps = clamp(safeNum(options.maxFramerate, 120), 10, 260);
  lines.push('maxFps:' + (maxFps >= 260 ? 260 : maxFps));

  if (mcVer >= 11602) {
    const eds = clamp(safeNum(options.entityDistanceScaling, 100), 50, 500) / 100;
    lines.push('entityDistanceScaling:' + eds.toFixed(1));
  }

  lines.push('gamma:' + (clamp(safeNum(options.gamma, 50), 0, 100) / 100).toFixed(1));

  lines.push('ao:' + (bool(options.ao) ? 'true' : 'false'));

  lines.push('particles:' + clamp(safeNum(options.particles, 0), 0, 2));

  lines.push('mipmapLevels:' + clamp(safeNum(options.mipmapLevels, 4), 0, 4));

  if (mcVer >= 11300) lines.push('biomeBlendRadius:' + clamp(safeNum(options.biomeBlendRadius, 2), 0, 7));

  lines.push('entityShadows:' + (bool(options.entityShadows !== false) ? 'true' : 'false'));

  const fovScale = clamp(safeNum(options.fovEffectScale, 100), 0, 100);
  lines.push('fovEffectScale:' + (fovScale / 100).toFixed(2));

  const darkScale = clamp(safeNum(options.darknessEffectScale, 100), 0, 100);
  lines.push('darknessEffectScale:' + (darkScale / 100).toFixed(2));

  const glintSpd = clamp(safeNum(options.glintSpeed, 50), 0, 100);
  lines.push('glintSpeed:' + (glintSpd / 100).toFixed(2));

  const glintStr = clamp(safeNum(options.glintStrength, 75), 0, 100);
  lines.push('glintStrength:' + (glintStr / 100).toFixed(2));

  const gfx = str(options.graphicsMode, 'fancy').toLowerCase();
  lines.push('graphics:' + (gfx === 'fast' ? 'fast' : (gfx === 'fabulous' ? 'fabulous' : 'fancy')));
  if (mcVer >= 26000) lines.push('graphicsMode:' + (gfx === 'fast' ? 0 : (gfx === 'fabulous' ? 2 : 1)));

  if (mcVer >= 11800) {
    lines.push('prioritizeChunkUpdates:' + clamp(safeNum(options.prioritizeChunkUpdates, 0), 0, 2));
  }

  if (mcVer >= 11700) {
    lines.push('improvedTransparency:' + (bool(options.improvedTransparency) ? 'true' : 'false'));
  }

  const fpsLim = str(options.inactivityFpsLimit, 'minimized');
  lines.push('inactivityFpsLimit:' + enumValue(fpsLim));

  lines.push('renderClouds:' + enumValue(bool(options.renderClouds !== false) ? 'true' : 'false'));
  lines.push('cloudRange:' + clamp(safeNum(options.cloudRange, 128), 32, 256));

  const scrEff = clamp(safeNum(options.screenEffectScale, 100), 0, 100);
  lines.push('screenEffectScale:' + (scrEff / 100).toFixed(2));

  lines.push('vignette:' + (bool(options.vignette !== false) ? 'true' : 'false'));

  lines.push('weatherRadius:' + clamp(safeNum(options.weatherRadius, 10), 5, 25));

  const soundKeys = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'];
  for (const key of soundKeys) {
    const val = options['soundCategory_' + key];
    lines.push('soundCategory_' + key + ':' + ((val !== undefined ? clamp(safeNum(val, 100), 0, 100) : 100) / 100).toFixed(1));
  }

  lines.push('showSubtitles:' + (bool(options.showSubtitles) ? 'true' : 'false'));

  if (mcVer >= 11900) lines.push('directionalAudio:' + (bool(options.directionalAudio !== false) ? 'true' : 'false'));

  if (mcVer >= 12000) {
    lines.push('musicToast:' + enumValue(bool(options.showMusicToast) ? 'pause_and_toast' : 'never'));
  }

  if (mcVer >= 12000) {
    const freqMap = { standard: 'DEFAULT', haeufig: 'FREQUENT', konstant: 'CONSTANT' };
    lines.push('musicFrequency:' + enumValue(freqMap[options.musicFrequency] || 'DEFAULT'));
  }

  const lang = (options.lang && String(options.lang).trim()) || 'en_us';
  lines.push('lang:' + lang);

  if (mcVer >= 11300) {
    lines.push('forceUnicodeFont:' + (bool(options.forceUnicodeFont) ? 'true' : 'false'));
  }

  lines.push('narrator:' + clamp(safeNum(options.narrator, 0), 0, 3));
  lines.push('narratorHotKey:' + (bool(options.narratorHotKey !== false) ? 'true' : 'false'));
  lines.push('onboardAccessibility:' + (bool(options.onboardAccessibility) ? 'true' : 'false'));

  lines.push('highContrast:' + (bool(options.highContrast) ? 'true' : 'false'));
  lines.push('highContrastBlockOutline:' + (bool(options.highContrastBlockOutline) ? 'true' : 'false'));

  const dmgTilt = clamp(safeNum(options.damageTiltStrength, 100), 0, 100);
  lines.push('damageTiltStrength:' + (dmgTilt / 100).toFixed(2));

  if (mcVer >= 12000) {
    lines.push('menuBackgroundBlurriness:' + clamp(safeNum(options.menuBackgroundBlurriness, 0), 0, 10));
  }

  lines.push('autoJump:' + (bool(options.autoJump) ? 'true' : 'false'));

  const ms = clamp(safeNum(options.mouseSensitivity, 50), 0, 100);
  lines.push('mouseSensitivity:' + (ms / 100).toFixed(2));

  lines.push('invertYMouse:' + (bool(options.invertYMouse) ? 'true' : 'false'));
  lines.push('invertXMouse:' + (bool(options.invertXMouse) ? 'true' : 'false'));
  lines.push('toggleCrouch:' + (bool(options.toggleCrouch) ? 'true' : 'false'));
  lines.push('toggleSprint:' + (bool(options.toggleSprint) ? 'true' : 'false'));

  if (mcVer >= 11900) {
    lines.push('toggleAttack:' + (bool(options.toggleAttack) ? 'true' : 'false'));
    lines.push('toggleUse:' + (bool(options.toggleUse) ? 'true' : 'false'));
  }

  lines.push('mouseWheelSensitivity:' + clamp(safeNum(options.mouseWheelSensitivity, 100), 1, 100));
  lines.push('discreteMouseScroll:' + (bool(options.discreteMouseScroll) ? 'true' : 'false'));
  lines.push('rawMouseInput:' + (bool(options.rawMouseInput !== false) ? 'true' : 'false'));
  lines.push('bobView:' + (bool(options.bobView !== false) ? 'true' : 'false'));
  lines.push('rotateWithMinecart:' + (bool(options.rotateWithMinecart) ? 'true' : 'false'));

  const hand = str(options.mainHand, 'right').toLowerCase();
  lines.push('mainHand:' + enumValue(hand === 'left' ? 'left' : 'right'));

  if (mcVer >= 12000) {
    lines.push('sprintWindow:' + clamp(safeNum(options.sprintWindow, 7), 0, 20));
  }

  lines.push('attackIndicator:' + clamp(safeNum(options.attackIndicator, 1), 0, 2));

  lines.push('chatVisibility:' + clamp(safeNum(options.chatVisibility, 0), 0, 2));

  const chatOp = clamp(safeNum(options.chatOpacity, 100), 0, 100);
  lines.push('chatOpacity:' + (chatOp / 100).toFixed(2));

  lines.push('chatLineSpacing:' + clamp(safeNum(options.chatLineSpacing, 0), 0, 20));

  const txtBg = clamp(safeNum(options.textBackgroundOpacity, 50), 0, 100);
  lines.push('textBackgroundOpacity:' + (txtBg / 100).toFixed(2));

  lines.push('backgroundForChatOnly:' + (bool(options.backgroundForChatOnly !== false) ? 'true' : 'false'));

  const chFoc = clamp(safeNum(options.chatHeightFocused, 100), 20, 200);
  lines.push('chatHeightFocused:' + (chFoc / 100).toFixed(2));

  const chUnf = clamp(safeNum(options.chatHeightUnfocused, 44), 5, 100);
  lines.push('chatHeightUnfocused:' + (chUnf / 100).toFixed(2));

  const chScale = clamp(safeNum(options.chatScale, 100), 0, 100);
  lines.push('chatScale:' + (chScale / 100).toFixed(2));

  const chWidth = clamp(safeNum(options.chatWidth, 100), 20, 200);
  lines.push('chatWidth:' + (chWidth / 100).toFixed(2));

  lines.push('chatDelay:' + clamp(safeNum(options.chatDelay, 0), 0, 60));

  const notif = clamp(safeNum(options.notificationDisplayTime, 100), 10, 200);
  lines.push('notificationDisplayTime:' + (notif / 100).toFixed(2));

  lines.push('chatColors:' + (bool(options.chatColors !== false) ? 'true' : 'false'));
  lines.push('chatLinks:' + (bool(options.chatLinks !== false) ? 'true' : 'false'));
  lines.push('chatLinksPrompt:' + (bool(options.chatLinksPrompt !== false) ? 'true' : 'false'));

  lines.push('autoSuggestions:' + (bool(options.autoSuggestions !== false) ? 'true' : 'false'));

  lines.push('hideMatchedNames:' + (bool(options.hideMatchedNames !== false) ? 'true' : 'false'));
  lines.push('hideSplashTexts:' + (bool(options.hideSplashTexts) ? 'true' : 'false'));

  lines.push('pauseOnLostFocus:' + (bool(options.pauseOnLostFocus !== false) ? 'true' : 'false'));
  lines.push('advancedItemTooltips:' + (bool(options.advancedItemTooltips) ? 'true' : 'false'));
  lines.push('realmsNotifications:' + (bool(options.realmsNotifications !== false) ? 'true' : 'false'));
  lines.push('skipMultiplayerWarning:' + (bool(options.skipMultiplayerWarning) ? 'true' : 'false'));
  lines.push('allowServerListing:' + (bool(options.allowServerListing !== false) ? 'true' : 'false'));

  if (mcVer >= 11900) {
    lines.push('onlyShowSecureChat:' + (bool(options.onlyShowSecureChat) ? 'true' : 'false'));
    lines.push('saveChatDrafts:' + (bool(options.saveChatDrafts) ? 'true' : 'false'));
  }

  if (mcVer >= 11800) {
    lines.push('telemetryOptInExtra:' + (bool(options.telemetryOptInExtra) ? 'true' : 'false'));
  }

  if (mcVer >= 12000) {
    lines.push('showAutosaveIndicator:' + (bool(options.showAutosaveIndicator !== false) ? 'true' : 'false'));
  }

  lines.push('useNativeTransport:' + (bool(options.useNativeTransport !== false) ? 'true' : 'false'));

  const pano = clamp(safeNum(options.panoramaScrollSpeed, 100), 0, 200);
  lines.push('panoramaScrollSpeed:' + (pano / 100).toFixed(2));

  const keyBindings = normalizeKeyBindings(options.keyBindings);
  if (keyBindings) {
    for (const [keyName, keyCode] of Object.entries(keyBindings)) {
      lines.push('key_' + keyName + ':' + convertKeyCode(keyCode));
    }
  }

  return lines.join('\r\n') + '\r\n';
}

ipc.handle('create-instance', async (_event, { folderName, options } = {}) => {
  try {
    if (!folderName || typeof folderName !== 'string' || folderName.includes('..')) {
      return { success: false, error: 'Ungültiger Instanzordner.' };
    }
    const rootPath = await resolveGameRoot();
    const profileFolder = uniqueProfileFolder(rootPath, folderName, readProfilesSync(rootPath));
    const gameDir = path.join(rootPath, 'profiles', profileFolder);
    fs.mkdirSync(gameDir, { recursive: true });
    const result = writeFirstRunOptions(gameDir, options);
    shellLog.debug('create-instance: options.txt ready', {
      path: result.path,
      created: result.created,
      keybinds: result.keybindCount ?? 0,
      requestedFolder: folderName,
      folder: profileFolder,
    });
    return {
      success: true,
      folderName: profileFolder,
      path: result.path,
      created: result.created,
      reason: result.reason,
      keybindCount: result.keybindCount ?? 0,
    };
  } catch (error) {
    shellLog.error('create-instance failed', { error: error.message });
    return { success: false, error: error.message };
  }
});

function applyLauncherGameOptions(gameDir, options) {
  if (!options || typeof options !== 'object') return [];
  const optionsPath = path.join(gameDir, 'options.txt');
  if (!fs.existsSync(optionsPath)) return [];

  const original = fs.readFileSync(optionsPath, 'utf8');
  // An older profile has no marker; its values are simply applied once.
  const written = readOptionsSyncState(gameDir)?.values ?? {};
  const wrote = {};
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const mcVer = mcVersionNum(options._mcVersion || '1.21');
  const fresh = parseOptionsText(buildOptionsTxt({ ...options, keyBindings: undefined }));
  const applied = [];
  let changed = false;

  const setOption = (key, value, reportKey) => {
    const desired = String(value);
    const line = key + ':' + desired;
    const index = lines.findIndex((entry) => entry.startsWith(key + ':'));
    const current = index >= 0 ? lines[index].slice(key.length + 1) : undefined;
    // The launcher rewrote this value last time and the file no longer has it:
    // the player changed it in game, so it stays theirs.
    if (index >= 0 && current !== desired && written[key] === desired) return;
    wrote[key] = desired;
    if (index >= 0) {
      if (current === desired) return;
      lines[index] = line;
    } else {
      lines.push(line);
    }
    changed = true;
    if (reportKey && !applied.includes(reportKey)) applied.push(reportKey);
  };

  const customised = Object.keys(OPTION_MERGE_DEFAULTS).filter((key) => {
    if (!(key in options)) return false;
    return String(options[key]) !== String(OPTION_MERGE_DEFAULTS[key]);
  });

  for (const key of customised) {
    if (key === 'graphicsMode') {
      const mode = String(options.graphicsMode).toLowerCase();
      if (!GRAPHICS_BUNDLES[mode]) continue;
      if (fresh.graphics) setOption('graphics', fresh.graphics, key);
      if (fresh.graphicsMode) setOption('graphicsMode', fresh.graphicsMode, key);
      for (const [bundleKey, bundleValue] of Object.entries(GRAPHICS_BUNDLES[mode])) setOption(bundleKey, bundleValue, key);
      continue;
    }
    const lineKey = OPTION_MERGE_KEYS[key] || key;
    if (!(lineKey in fresh)) continue;
    setOption(lineKey, fresh[lineKey], key);
  }

  if (typeof options.lang === 'string' && options.lang.trim()) {
    setOption('lang', options.lang.trim(), 'lang');
  }

  // Fullscreen is a launcher switch, so both directions must reach options.txt.
  // The default (false) would otherwise be filtered out and leave a stale true.
  if (typeof options.fullscreen === 'boolean') {
    setOption('fullscreen', options.fullscreen ? 'true' : 'false', 'fullscreen');
  }

  if (mcVer >= 26000) {
    const distances = customised.includes('renderDistance') || customised.includes('simulationDistance');
    const mode = String(options.graphicsMode || '').toLowerCase();
    const hasPreset = lines.some((entry) => entry.startsWith('graphicsPreset:'));
    const preset = distances ? 'custom' : customised.includes('graphicsMode') && GRAPHICS_BUNDLES[mode] ? mode : hasPreset ? '' : 'custom';
    if (preset) setOption('graphicsPreset', '"' + preset + '"', 'graphicsPreset');
  }

  if (!changed) return [];
  const next = lines.join(eol) + eol;
  fs.writeFileSync(optionsPath, next, 'utf8');
  writeOptionsSyncState(gameDir, next, { ...written, ...wrote });
  return applied;
}

const OPTION_MERGE_DEFAULTS = {
  renderDistance: 12, simulationDistance: 12, fov: 70, guiScale: 0, maxFramerate: 120,
  vsync: true, graphicsMode: 'fancy', particles: 0, mipmapLevels: 4, gamma: 50,
  entityDistanceScaling: 100, biomeBlendRadius: 2, entityShadows: true,
  fovEffectScale: 100, screenEffectScale: 100, vignette: true, renderClouds: true,
  directionalAudio: true, showSubtitles: false, mouseSensitivity: 50, invertYMouse: false,
  autoJump: false, rawMouseInput: true, bobView: true, toggleCrouch: false, toggleSprint: false,
  mainHand: 'right', attackIndicator: 1, chatVisibility: 0, chatOpacity: 100, chatScale: 100,
  chatWidth: 100, chatLineSpacing: 0, textBackgroundOpacity: 50, chatColors: true, chatLinks: true,
  autoSuggestions: true, narrator: 0, highContrast: false, highContrastBlockOutline: false,
  damageTiltStrength: 100, menuBackgroundBlurriness: 0, forceUnicodeFont: false,
  notificationDisplayTime: 100, fullscreen: false,
};
for (const channel of ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui']) {
  OPTION_MERGE_DEFAULTS['soundCategory_' + channel] = 100;
}

const OPTION_MERGE_KEYS = { maxFramerate: 'maxFps', vsync: 'enableVsync' };

const GRAPHICS_BUNDLES = {
  fast: { improvedTransparency: 'false', cloudRange: '64' },
  fancy: { improvedTransparency: 'false', cloudRange: '128' },
  fabulous: { improvedTransparency: 'true', cloudRange: '128' },
};

function parseOptionsText(text) {
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) map[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return map;
}

ipc.handle('apply-options-patch', async (_event, { folderName, patch }) => {
  try {
    if (!folderName || typeof folderName !== 'string') {
      return { success: false, error: 'Ungültiger Instanzordner.' };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { success: false, error: 'Ungültige options.txt-Werte.' };
    }
    const rootPath = await resolveGameRoot();
    const gameDir = profileDirOrNull(rootPath, folderName);
    if (!gameDir) return { success: false, error: 'Ungültiger Instanzordner.' };
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
    const { GameSettingsService } = require('./dist-electron/gamesettings/service.js');
    const service = new GameSettingsService();
    const result = await service.editOptions(gameDir, patch);
    shellLog.debug('apply-options-patch: options updated', { file: result.file, changed: Object.keys(result.diff) });
    return { success: true, changed: Object.keys(result.diff), path: result.file };
  } catch (error) {
    shellLog.error('apply-options-patch failed', { error: error.message });
    return { success: false, error: error.message };
  }
});

ipc.on('window-minimize', () => mainWindow?.minimize());
ipc.on('window-focus', () => { mainWindow?.show(); mainWindow?.focus(); });
ipc.on('window-close', () => mainWindow?.close());
ipc.on('window-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipc.handle('window-is-maximized', () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));

ipc.handle('open-profile-folder', async (_event, folderName) => {
  const rootPath = gameRoot();
  const gameDir = path.join(rootPath, 'profiles', folderName, 'saves');
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }
  shell.openPath(gameDir);
});

ipc.handle('open-instance-folder', async (_event, folderName) => {
  const rootPath = gameRoot();
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }
  shell.openPath(gameDir);
});

ipc.handle('delete-profile-files', async (_event, folderName) => {
  const rootPath = gameRoot();
  const gameDir = profileDirOrNull(rootPath, folderName);
  if (!gameDir) {
    shellLog.warn('delete-profile-files: rejected folder name', { folderName });
    return { success: false, error: 'Ungültiger Instanzordner.' };
  }
  let deleted = false;
  try {
    if (fs.existsSync(gameDir)) {
      fs.rmSync(gameDir, { recursive: true, force: true });
      deleted = true;
      shellLog.info('profile folder deleted', { gameDir });
    }
  } catch (error) {
    shellLog.error('profile folder could not be deleted', { gameDir, error: error.message });
    return { success: false, error: error.message };
  }
  const screenshotsDir = path.join(rootPath, 'screenshots');
  let screenshots = 0;
  if (fs.existsSync(screenshotsDir)) {
    const prefix = folderName + '__';
    const files = fs.readdirSync(screenshotsDir);
    for (const file of files) {
      if (file.startsWith(prefix)) {
        try {
          fs.unlinkSync(path.join(screenshotsDir, file));
          screenshots++;
        } catch (e) {
          shellLog.debug('profile screenshot could not be deleted', { file, error: e.message });
        }
      }
    }
    if (screenshots > 0) {
      shellLog.debug('profile screenshots deleted', { folderName, screenshots });
    }
  }
  return { success: true, deleted, screenshots };
});

ipc.handle('repair-profile', async (event, { loader, loaderVersion, mcVersion, folderName }) => {
  const normalizedLoader = String(loader || '').toLowerCase();
  const taskId = folderName ? `repair:${folderName}` : '';

  function sendProgress(msg, percent) {
    try {
      event.sender.send('repair-progress', msg);
      if (taskId) {
        event.sender.send('background-task-progress', {
          id: taskId,
          percent: typeof percent === 'number' ? percent : null,
          label: String(msg || ''),
        });
      }
    } catch (error) {
      shellLog.debug('repair-profile: progress could not be sent', { error: error.message });
    }
  }

  if (!mcVersion) throw new Error('Minecraft-Version fehlt');
  sendProgress('Starte Reparatur...', 2);

  if (normalizedLoader === 'vanilla') {
    const { installVersion } = require('./dist-electron/install/version.js');
    const rootPath = await resolveGameRoot();
    await installVersion(rootPath, mcVersion, { cacheDir: path.join(rootPath, 'cache'), withAssets: true });
  } else {
    await installLoaderViaCore(normalizedLoader, mcVersion, loaderVersion, (progress) => {
      if (progress && progress.message) sendProgress(progress.message);
    });
  }

  sendProgress('Reparatur abgeschlossen!', 100);
  shellLog.info('profile repaired', { loader: normalizedLoader, loaderVersion: loaderVersion || '', mcVersion });
  return true;
});

function loaderDisplayName(loader) {
  const map = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'Neoforge' };
  return map[String(loader || '').toLowerCase()] || 'Vanilla';
}

/**
 * `modrinth.index.json` is the launch-time source of truth for modpacks: the
 * launch handler prefers its dependencies over the renderer's labels. A version
 * switch that only rewrites profiles.json would therefore keep starting the old
 * pack version.
 */
function updateModpackIndexDependencies(instanceDir, mcVersion, loader, loaderVersion) {
  const indexFile = path.join(instanceDir, 'modrinth.index.json');
  if (!fs.existsSync(indexFile)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!index || typeof index !== 'object' || Array.isArray(index)) return false;
    const dependencies = index.dependencies && typeof index.dependencies === 'object'
      ? { ...index.dependencies }
      : {};
    delete dependencies['fabric-loader'];
    delete dependencies['quilt-loader'];
    delete dependencies.forge;
    delete dependencies.neoforge;
    dependencies.minecraft = String(mcVersion);
    if (loader !== 'vanilla' && loaderVersion) {
      const key = loader === 'fabric' ? 'fabric-loader' : loader === 'quilt' ? 'quilt-loader' : loader;
      dependencies[key] = String(loaderVersion);
    }
    index.dependencies = dependencies;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    return true;
  } catch (error) {
    shellLog.warn('change-instance-version: modpack index not updated', {
      indexFile,
      error: error.message,
    });
    return false;
  }
}

/**
 * Copied legacy profiles carry the source instance's `instance.json`, which can
 * still name the old Minecraft version and loader profile. The core store entry
 * for such a folder is only created on first launch, so a version switch must
 * also rewrite the file directly when no store record exists yet.
 */
function updateLegacyInstanceMetadata(instanceDir, values) {
  const file = path.join(instanceDir, 'instance.json');
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    parsed.version = String(values.mcVersion || '');
    parsed.versionId = String(values.versionId || '');
    parsed.loader = String(values.loader || 'vanilla');
    parsed.loaderVersion = String(values.loaderVersion || '');
    parsed.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    return true;
  } catch (error) {
    shellLog.warn('change-instance-version: legacy instance file not updated', {
      instanceDir,
      error: error.message,
    });
    return false;
  }
}

ipc.handle('change-instance-version', async (event, { folderName, mcVersion, loader, loaderVersion }) => {
  const requestedFolder = path.basename(String(folderName || ''));
  if (!requestedFolder || requestedFolder !== String(folderName) || requestedFolder === '.' || requestedFolder === '..') {
    return { success: false, error: 'Ungültiger Instanzordner' };
  }
  const normalizedLoader = String(loader || 'vanilla').toLowerCase();
  if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(normalizedLoader)) {
    return { success: false, error: 'Unbekannter Modloader' };
  }
  const targetMc = String(mcVersion || '');
  if (!targetMc) return { success: false, error: 'Minecraft-Version fehlt' };

  const taskId = `version-switch:${requestedFolder}`;
  const emitProgress = (percent, label) => {
    try {
      event.sender.send('background-task-progress', {
        id: taskId,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        label: String(label || ''),
      });
    } catch (error) {
      shellLog.debug('change-instance-version: progress could not be sent', { error: error.message });
    }
  };

  emitProgress(2, 'Zielversion wird vorbereitet…');
  let versionId = targetMc;
  let installedLoaderVersion = '';

  try {
    const rootPath = await resolveGameRoot();
    if (normalizedLoader === 'vanilla') {
      const { installVersion } = require('./dist-electron/install/version.js');
      await installVersion(rootPath, targetMc, {
        cacheDir: path.join(rootPath, 'cache'),
        withAssets: true,
      });
    } else {
      const result = await installLoaderViaCore(
        normalizedLoader,
        targetMc,
        loaderVersion || '',
        (progress) => {
          const percentMap = {
            metadata: 8,
            base: 18,
            installer: 28,
            profile: 36,
            inputs: 40,
            processors: 44,
            done: 48,
          };
          emitProgress(percentMap[progress?.phase] || 24, progress?.message || 'Loader wird installiert…');
        },
      );
      versionId = result.versionId || versionId;
      installedLoaderVersion = result.loaderVersion || String(loaderVersion || '');
    }

    emitProgress(54, 'Instanzdaten werden aktualisiert…');

    const profiles = readProfilesSync(rootPath);
    let profileUpdated = false;
    const nextProfiles = profiles.map((profile) => {
      if (!profile || typeof profile !== 'object') return profile;
      if (profileFolderOf(profile) !== requestedFolder) return profile;
      profileUpdated = true;
      return {
        ...profile,
        version: targetMc,
        loader: loaderDisplayName(normalizedLoader),
        loaderVersion: installedLoaderVersion,
      };
    });
    if (profileUpdated) {
      writeProfilesSync(rootPath, nextProfiles);
    } else {
      shellLog.warn('change-instance-version: profile not found in profiles.json', {
        folderName: requestedFolder,
      });
    }

    // Keep the core instance file/index in sync even when the visible instance
    // list lives in the legacy profiles.json.
    const instanceDir = path.join(rootPath, 'profiles', requestedFolder);
    try {
      const core = await getBambooCore();
      const found = core ? await core.instanceManager.findByFolder(requestedFolder) : undefined;
      if (found) {
        await core.instanceManager.updateFile(found.instance.id, {
          version: targetMc,
          versionId,
          loader: normalizedLoader,
          loaderVersion: installedLoaderVersion,
        });
      } else {
        updateLegacyInstanceMetadata(instanceDir, {
          mcVersion: targetMc,
          versionId,
          loader: normalizedLoader,
          loaderVersion: installedLoaderVersion,
        });
      }
    } catch (error) {
      shellLog.warn('change-instance-version: core instance file not updated', {
        folderName: requestedFolder,
        error: error.message,
      });
    }

    updateModpackIndexDependencies(
      instanceDir,
      targetMc,
      normalizedLoader,
      installedLoaderVersion,
    );

    emitProgress(100, 'Version gewechselt');
    shellLog.info('instance version changed', {
      folderName: requestedFolder,
      mcVersion: targetMc,
      loader: normalizedLoader,
      loaderVersion: installedLoaderVersion,
      versionId,
    });
    return {
      success: true,
      mcVersion: targetMc,
      loader: normalizedLoader,
      loaderVersion: installedLoaderVersion,
      versionId,
    };
  } catch (error) {
    shellLog.error('change-instance-version failed', {
      folderName: requestedFolder,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
});

ipc.handle('get-settings', async () => {
  const core = await getBambooCore();
  if (core) {
    try { return await core.getSettingsForRenderer(); } catch (e) { shellLog.error('get-settings failed', { error: e.message }); }
  }
  return null;
});

ipc.handle('get-player-identity', async () => {
  const core = await getBambooCore();
  if (!core) return null;
  try { return await core.getPlayerIdentity(); } catch (e) { shellLog.error('get-player-identity failed', { error: e.message }); return null; }
});

ipc.handle('save-settings', async (_event, settings) => {
  const core = await getBambooCore();
  if (!core) throw new Error('Launcher core unavailable');
  return core.saveSettingsFromRenderer(settings);
});

function readCurseForgeApiKey() {
  try {
    return fs.readFileSync(path.join(__dirname, 'resources', 'curseforge-key.txt'), 'utf8').trim();
  } catch {
    // No bundled key is a supported state; the UI reports missing-key explicitly.
    return '';
  }
}

function curseForgeHeaders() {
  const apiKey = readCurseForgeApiKey();
  return apiKey ? { 'Accept': 'application/json', 'x-api-key': apiKey } : null;
}

const CURSEFORGE_RETRY_STATUS = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function curseForgeFetch(url, options, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!CURSEFORGE_RETRY_STATUS.has(response.status) || attempt === attempts - 1) return response;
      // The retry path already has a response to discard; a failed cancel is harmless.
      try { await response.body?.cancel(); } catch (_) { /* body already consumed */ }
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) throw err;
    }
    await sleepMs(250 * (attempt + 1));
  }
  throw lastError || new Error('CurseForge request failed');
}

const CURSEFORGE_KEY_MISSING = {
  error: 'Kein CurseForge API-Key gesetzt',
  code: 'missing-key',
};

// Documented search bounds: pageSize <= 50 and index + pageSize <= 10,000.
const CURSEFORGE_MAX_PAGE_SIZE = 50;
const CURSEFORGE_SEARCH_LIMIT = 10000;

function clampCurseForgeSearchPage(pageSize, index) {
  const requestedPageSize = Number(pageSize);
  const safePageSize = Math.min(
    CURSEFORGE_MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedPageSize) ? Math.trunc(requestedPageSize) : 20),
  );
  const requestedIndex = Number(index);
  const safeIndex = Math.min(
    CURSEFORGE_SEARCH_LIMIT - safePageSize,
    Math.max(0, Number.isFinite(requestedIndex) ? Math.trunc(requestedIndex) : 0),
  );
  return { pageSize: safePageSize, index: safeIndex };
}

async function curseForgeFailure(res) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 300).trim(); } catch (_) { /* body is optional */ }
  const code = res.status === 401 || res.status === 403 ? 'invalid-key'
    : res.status === 429 ? 'rate-limited'
      : 'http';
  return {
    error: `CurseForge API-Fehler: ${res.status}${detail ? ` — ${detail}` : ''}`,
    code,
    status: res.status,
    detail,
  };
}

function cfLoaderTypeToNum(loader) {
  const map = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
  return map[String(loader).toLowerCase()] ?? undefined;
}

function createCurseForgeSearchHandler({ curseForgeHeaders, curseForgeFetch, curseForgeFailure, shellLog }) {
  return async (_event, { query, sortBy = '6', modFilter, gameVersion, modLoaderType, index = 0, pageSize = 20 }) => {
    const headers = curseForgeHeaders();
    if (!headers) return { ...CURSEFORGE_KEY_MISSING };
    const gameId = 432;
    // The renderer sends the numeric class id (6, 12, 17, ...), older callers
    // send the project-type name. Without accepting both, every numeric filter
    // fell through to classId 6 and every tab showed the same mods.
    const numericClassId = typeof modFilter === 'string' && /^\d+$/.test(modFilter)
      ? Number(modFilter)
      : undefined;
    const classId = CF_CLASS_IDS[modFilter] || numericClassId || (modFilter ? 6 : undefined);
    const page = clampCurseForgeSearchPage(pageSize, index);
    const params = new URLSearchParams({ gameId, pageSize: String(page.pageSize) });
    if (classId) params.set('classId', String(classId));
    if (query) params.set('searchFilter', query);
    if (sortBy) params.set('sortField', sortBy);
    params.set('sortOrder', 'desc');
    if (page.index > 0) params.set('index', String(page.index));
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (modLoaderType !== undefined && modLoaderType !== null) params.set('modLoaderType', String(modLoaderType));
    try {
      const res = await curseForgeFetch(`https://api.curseforge.com/v1/mods/search?${params.toString()}`, { headers });
      if (!res.ok) {
        const failure = await curseForgeFailure(res);
        shellLog.warn('curseforge: search failed', { status: res.status, code: failure.code });
        return failure;
      }
      const data = await res.json();
      return { data: data.data || [], pagination: data.pagination || { totalCount: 0 } };
    } catch (err) {
      return { error: `CurseForge nicht erreichbar: ${err.message}`, code: 'network', detail: err.message };
    }
  };
}

ipc.handle('curseforge-search', createCurseForgeSearchHandler({
  curseForgeHeaders,
  curseForgeFetch,
  curseForgeFailure,
  shellLog,
}));

ipc.handle('curseforge-project', async (_event, modId) => {
  const headers = curseForgeHeaders();
  if (!headers) return { ...CURSEFORGE_KEY_MISSING };
  try {
    const [modRes, descRes] = await Promise.all([
      curseForgeFetch(`https://api.curseforge.com/v1/mods/${modId}`, { headers }),
      curseForgeFetch(`https://api.curseforge.com/v1/mods/${modId}/description`, { headers }),
    ]);
    if (!modRes.ok) {
      const failure = await curseForgeFailure(modRes);
      shellLog.warn('curseforge: project lookup failed', { modId, status: modRes.status, code: failure.code });
      return failure;
    }
    const modData = (await modRes.json()).data;
    let fullDescription = '';
    if (descRes.ok) {
      try {
        const descData = await descRes.json();
        fullDescription = descData?.data?.body || descData?.body || '';
        shellLog.debug('curseforge: description loaded', { modId, length: fullDescription.length });
      } catch (e) {
        shellLog.warn('curseforge: description parse failed', { modId, error: e.message });
      }
    } else {
      shellLog.warn('curseforge: description unavailable', { modId, status: descRes.status });
    }
    if (!fullDescription && modData.summary) {
      fullDescription = '<p>' + String(modData.summary).replace(/\n/g, '<br>') + '</p>';
    }
    return { ...modData, fullDescription: fullDescription, description: fullDescription || modData.summary || '' };
  } catch (err) {
    return { error: `CurseForge nicht erreichbar: ${err.message}`, code: 'network', detail: err.message };
  }
});

ipc.handle('curseforge-files', async (_event, modId, gameVersion, modLoaderType) => {
  const headers = curseForgeHeaders();
  if (!headers) return { ...CURSEFORGE_KEY_MISSING };
  try {
    let url = `https://api.curseforge.com/v1/mods/${modId}/files?pageSize=100&sortField=2&sortOrder=desc`;
    if (gameVersion) url += `&gameVersion=${encodeURIComponent(gameVersion)}`;
    if (modLoaderType !== undefined && modLoaderType !== null) url += `&modLoaderType=${modLoaderType}`;
    const res = await curseForgeFetch(url, { headers });
    if (!res.ok) {
      const failure = await curseForgeFailure(res);
      shellLog.warn('curseforge: file list failed', { modId, status: res.status, code: failure.code });
      return failure;
    }
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    return { error: `CurseForge nicht erreichbar: ${err.message}`, code: 'network', detail: err.message };
  }
});

let forgeVersionsCache = null;
let neoforgeVersionsCache = null;

ipc.handle('get-forge-versions', async () => {
  if (forgeVersionsCache) return forgeVersionsCache;
  try {
    const res = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const versions = [];
    const regex = /<version>([^<]+)<\/version>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      versions.push(match[1]);
    }
    forgeVersionsCache = versions;
    return versions;
  } catch (err) {
    shellLog.error('forge versions could not be loaded', { error: err.message });
    return null;
  }
});

ipc.handle('get-neoforge-versions', async () => {
  if (neoforgeVersionsCache) return neoforgeVersionsCache;
  try {
    const res = await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const versions = [];
    const regex = /<version>([^<]+)<\/version>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      versions.push(match[1]);
    }
    neoforgeVersionsCache = versions;
    return versions;
  } catch (err) {
    shellLog.error('neoforge versions could not be loaded', { error: err.message });
    return null;
  }
});

async function withStableInstanceFolders(profiles) {
  if (!Array.isArray(profiles)) return profiles;
  try {
    const core = await getBambooCore();
    if (!core) return profiles;
    const records = await core.instances.list();
    const folders = new Map(records.map((record) => [record.id, record.folderName]));
    return profiles.map((profile) => {
      if (!profile || typeof profile !== 'object') return profile;
      const folderName = folders.get(profile.id);
      return folderName ? { ...profile, folderName } : profile;
    });
  } catch (error) {
    shellLog.warn('get-profiles: stable folder lookup failed', { error: error.message });
    return profiles;
  }
}

ipc.handle('get-profiles', async () => {
  const rootPath = gameRoot();
  let profiles = null;

  const profilesPath = path.join(rootPath, 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (error) {
      // Keep looking in the legacy locations instead of showing an empty list.
      shellLog.warn('get-profiles: profiles.json is unreadable', { path: profilesPath, error: error.message });
      profiles = null;
    }
  }

  if (profiles === null) {
    const profilesSubPath = path.join(rootPath, 'profiles', 'profiles.json');
    if (fs.existsSync(profilesSubPath)) {
      try { profiles = JSON.parse(fs.readFileSync(profilesSubPath, 'utf8')); } catch (error) {
        shellLog.warn('get-profiles: profiles/profiles.json is unreadable', { path: profilesSubPath, error: error.message });
        profiles = null;
      }
    }
  }

  if (profiles === null) {
    const profilesDir = path.join(rootPath, 'profiles');
    if (fs.existsSync(profilesDir) && fs.statSync(profilesDir).isDirectory()) {
      const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && f !== 'profiles.json');
      if (files.length > 0) {
        const result = [];
        for (const f of files) {
          try { result.push(JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'))); } catch (error) {
            shellLog.debug('get-profiles: skipping unreadable profile file', { file: f, error: error.message });
          }
        }
        if (result.length > 0) profiles = result;
      }
    }
  }

  return withStableInstanceFolders(profiles ?? []);
});

function getFolderSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getFolderSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

ipc.handle('save-profiles', async (_event, profiles) => {
  const rootPath = gameRoot();
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  const enriched = profiles.map(p => {
    const folderName = profileFolderOf(p);
    const dirPath = path.join(rootPath, 'profiles', folderName);
    const bytes = getFolderSize(dirPath);
    return { ...p, folderName, size: formatSize(bytes) || '0 B' };
  });
  fs.writeFileSync(path.join(rootPath, 'profiles.json'), JSON.stringify(enriched, null, 2));
  return true;
});

ipc.handle('get-collections', async () => {
  const rootPath = gameRoot();
  const collectionsPath = path.join(rootPath, 'collections.json');
  if (fs.existsSync(collectionsPath)) {
    try { return JSON.parse(fs.readFileSync(collectionsPath, 'utf8')); } catch (error) {
      shellLog.warn('get-collections: collections.json is unreadable', { path: collectionsPath, error: error.message });
      return [];
    }
  }
  return [];
});

ipc.handle('save-collections', async (_event, collections) => {
  const rootPath = gameRoot();
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'collections.json'), JSON.stringify(collections, null, 2));
  return true;
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

ipc.on('renderer-log', (_event, { level, message, data }) => {
  const write = shellLog[level] || shellLog.warn;
  write(`renderer: ${message}`, data);
});

ipc.handle('show-open-dialog', async (_event, options) => {
  return dialog.showOpenDialog(options);
});

ipc.handle('show-save-dialog', async (_event, options) => {
  return dialog.showSaveDialog(options);
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

ipc.handle('read-file-as-base64', async (_event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return data.toString('base64');
  } catch (e) {
    shellLog.error('read-file-as-base64 failed', { error: e.message });
    return null;
  }
});

ipc.handle('save-temp-file', async (_event, { data, fileName }) => {
  try {
    const rootPath = gameRoot();
    const tempDir = path.join(rootPath, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const safeName = (fileName || 'temp.zip').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tempDir, `${Date.now()}-${safeName}`);
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    shellLog.debug('save-temp-file: saved', { filePath });
    return filePath;
  } catch (e) {
    shellLog.error('save-temp-file failed', { error: e.message });
    return null;
  }
});

ipc.handle('show-item-in-folder', async (_event, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  } catch (e) {
    shellLog.error('show-item-in-folder failed', { error: e.message });
  }
});

ipc.handle('read-image-file', async (_event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mime[ext] || 'image/png';
    const base64 = data.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (e) {
    shellLog.error('read-image-file failed', { error: e.message });
    return null;
  }
});

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

ipc.handle('export-profile', async (_event, payload) => {
  const rootPath = gameRoot();
  const { format, instanceName, folderName, manifest, options, suggestedFileName, savePath } = payload || {};

  if (format === 'mrpack') {
    const bridge = getLegacyModsBridge();
    if (bridge && typeof bridge.exportLegacyProfile === 'function') {
      return bridge.exportLegacyProfile(payload);
    }
  }

  if (!manifest || !folderName) {
    return { success: false, error: 'Ungültige Exportdaten: Manifest oder Ordnername fehlt' };
  }

  const tmpDir = path.join(rootPath, 'cache', `export-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    if (format === 'zip') {
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    const gameDir = path.join(rootPath, 'profiles', folderName);
    const selectedContent = options || {};
    
    const gameDirExists = fs.existsSync(gameDir);
    shellLog.debug('export-profile: collecting', { gameDir, gameDirExists, format, folderName });

    let collectedAnything = false;
    const collectedTypes = [];

    function collectDir(srcSubDir, destSubDir) {
      const src = path.join(gameDir, srcSubDir);
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return false;
      const entries = fs.readdirSync(src);
      if (entries.length === 0) return false;
      // Configs and worlds are trees, not flat folders. Copying only the files
      // directly below the source silently dropped every world and nested config.
      const d = path.join(tmpDir, destSubDir || srcSubDir);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.cpSync(src, d, { recursive: true, force: true });
      return true;
    }

    if (selectedContent.includeMods !== false && collectDir('mods', 'mods')) { collectedAnything = true; collectedTypes.push('mods'); }
    if (selectedContent.includeResourcepacks !== false && collectDir('resourcepacks', 'resourcepacks')) { collectedAnything = true; collectedTypes.push('resourcepacks'); }
    if (selectedContent.includeShaderpacks !== false && collectDir('shaderpacks', 'shaderpacks')) { collectedAnything = true; collectedTypes.push('shaderpacks'); }
    if (selectedContent.includeDatapacks !== false && collectDir('datapacks', 'datapacks')) { collectedAnything = true; collectedTypes.push('datapacks'); }
    if (selectedContent.includeConfig !== false && collectDir('config', 'config')) { collectedAnything = true; collectedTypes.push('config'); }
    if (selectedContent.includeScreenshots !== false && collectDir('screenshots', 'screenshots')) { collectedAnything = true; collectedTypes.push('screenshots'); }
    if (selectedContent.includeWorlds !== false && collectDir('saves', 'worlds')) { collectedAnything = true; collectedTypes.push('worlds'); }
    
    shellLog.debug('export-profile: content collected', { types: collectedTypes, total: collectedTypes.length });

    if (!collectedAnything && gameDirExists) {
      shellLog.warn('export-profile: profile folder has no content directories', { gameDir });
    }
    if (!gameDirExists) {
      shellLog.warn('export-profile: profile folder missing; creating it', { gameDir });
      fs.mkdirSync(gameDir, { recursive: true });
    }

    if (manifest.contents?.icon && typeof manifest.contents.icon === 'string') {
      const iconData = manifest.contents.icon;
      try {
        if (iconData.startsWith('data:image/')) {
          const b64 = iconData.split(',')[1];
          if (b64) fs.writeFileSync(path.join(tmpDir, 'icon.png'), Buffer.from(b64, 'base64'));
        }
      } catch (error) {
        shellLog.debug('export-profile: icon could not be written', { error: error.message });
      }
    }

    const zip = new AdmZip();

    if (format === 'zip') {
      zip.addLocalFolder(tmpDir);
    } else if (format === 'mrpack') {
      
      const overridesDir = path.join(tmpDir, 'overrides');
      fs.mkdirSync(overridesDir, { recursive: true });
      
      function collectToOverrides(srcSubDir, destSubDir) {
        const src = path.join(gameDir, srcSubDir);
        if (fs.existsSync(src)) {
          const files = fs.readdirSync(src).filter(f => {
            const fullPath = path.join(src, f);
            return fs.statSync(fullPath).isFile();
          });
          if (files.length === 0) return;
          const d = path.join(overridesDir, destSubDir || srcSubDir);
          fs.mkdirSync(d, { recursive: true });
          for (const entry of files) {
            fs.copyFileSync(path.join(src, entry), path.join(d, entry));
          }
        }
      }
      
      if (selectedContent.includeMods !== false) collectToOverrides('mods', 'mods');
      if (selectedContent.includeResourcepacks !== false) collectToOverrides('resourcepacks', 'resourcepacks');
      if (selectedContent.includeShaderpacks !== false) collectToOverrides('shaderpacks', 'shaderpacks');
      if (selectedContent.includeConfig !== false) collectToOverrides('config', 'config');
      if (selectedContent.includeWorlds !== false) collectToOverrides('saves', 'worlds');
      
      const mrpackIndex = payload.mrpackIndex || {
        formatVersion: 1,
        game: 'minecraft',
        versionId: `${manifest.instance?.minecraftVersion || '1.21'}-${manifest.instance?.modloader || 'vanilla'}-${Date.now()}`,
        name: manifest.instance?.name || instanceName,
        summary: manifest.instance?.description || '',
        files: [],
        dependencies: {
          minecraft: manifest.instance?.minecraftVersion || '1.21',
          ...(manifest.instance?.modloader === 'Fabric' || manifest.instance?.modloader === 'fabric'
            ? { 'fabric-loader': manifest.instance?.modloaderVersion || '0.16.10' } : {}),
          ...(manifest.instance?.modloader === 'Forge' || manifest.instance?.modloader === 'forge'
            ? { forge: manifest.instance?.modloaderVersion || '' } : {}),
          ...(manifest.instance?.modloader === 'Neoforge' || manifest.instance?.modloader === 'neoforge'
            ? { neoforge: manifest.instance?.modloaderVersion || '' } : {}),
        },
      };
      
      fs.writeFileSync(path.join(tmpDir, 'modrinth.index.json'), JSON.stringify(mrpackIndex, null, 2));
      
      zip.addLocalFolder(tmpDir);
    }

    const buf = zip.toBuffer();
    const fileName = suggestedFileName || `${(instanceName || 'export').replace(/[^a-zA-Z0-9_-]/g, '_')}.${format === 'mrpack' ? 'mrpack' : 'zip'}`;
  const exportPath = savePath || path.join(rootPath, 'cache', fileName);
  fs.writeFileSync(exportPath, buf);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    const stats = fs.statSync(exportPath);

    return {
      success: true,
      filePath: exportPath,
      fileName,
      fileSize: stats.size,
    };
  } catch (err) {
    shellLog.error('export-profile failed', { folderName, format, error: err.message });
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
});

ipc.handle('export-profile-legacy', async (_event, { profileId, mode, options }) => {
  const rootPath = gameRoot();
  let profiles = [];
  const profilesPath = path.join(rootPath, 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (error) {
      shellLog.warn('export-profile-legacy: profiles.json is unreadable', { path: profilesPath, error: error.message });
    }
  }
  const p = profiles.find(x => x.id === profileId);
  if (!p) return { success: false, error: 'Profil nicht gefunden' };

  const tmpDir = path.join(rootPath, 'cache', `export-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    function toExportItems(items) {
      return (items || []).map(i => ({
        projectId: i.id, name: i.name, slug: i.slug, icon: i.icon, source: 'modrinth', filename: null,
      }));
    }

    const manifest = {
      formatVersion: 1,
      exportedAt: Date.now(),
      launcherVersion: '1.0.0',
      exportMode: mode,
      profile: {
        name: p.name, icon: p.icon || '', minecraftVersion: p.version,
        modLoader: p.loader, loaderVersion: p.loaderVersion || '', javaPath: p.javaPath || '',
      },
      mods: toExportItems(p.installedMods),
      resourcepacks: toExportItems(p.installedResourcePacks),
      shaders: toExportItems(p.installedShaders),
      settings: { ram: p.ram || 4096, javaArgs: '', optionsSync: false },
      meta: { author: '', description: '', hasWorlds: false, hasScreenshots: false, hasConfig: false },
    };

    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const iconStr = p.icon || '';
    if (iconStr.startsWith('<img')) {
      const m = iconStr.match(/src="([^"]+)"/);
      if (m && m[1].startsWith('data:image/')) {
        const b64 = m[1].split(',')[1];
        if (b64) fs.writeFileSync(path.join(tmpDir, 'icon.png'), Buffer.from(b64, 'base64'));
      }
    }

    if (mode === 'full') {
      const gameDir = path.join(rootPath, 'profiles', p.folderName);
      for (const sub of ['mods', 'resourcepacks', 'shaderpacks']) {
        const src = path.join(gameDir, sub);
        if (fs.existsSync(src)) {
          const d = path.join(tmpDir, sub);
          fs.mkdirSync(d, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            const s = path.join(src, entry);
            if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(d, entry));
          }
        }
      }
      if (options?.worlds) {
        const ws = path.join(gameDir, 'saves');
        if (fs.existsSync(ws)) { copyRecursive(ws, path.join(tmpDir, 'worlds')); manifest.meta.hasWorlds = true; }
      }
      if (options?.screenshots) {
        const ss = path.join(gameDir, 'screenshots');
        if (fs.existsSync(ss)) { copyRecursive(ss, path.join(tmpDir, 'screenshots')); manifest.meta.hasScreenshots = true; }
      }
      if (options?.config) {
        const cfg = path.join(gameDir, 'config');
        if (fs.existsSync(cfg)) { copyRecursive(cfg, path.join(tmpDir, 'config')); manifest.meta.hasConfig = true; }
      }
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    const zip = new AdmZip();
    zip.addLocalFolder(tmpDir);
    const buf = zip.toBuffer();

    const saveResult = await dialog.showSaveDialog({
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      defaultPath: p.name + '.zip',
    });
    if (saveResult.canceled || !saveResult.filePath) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { success: false, error: 'Abgebrochen' };
    }

    fs.writeFileSync(saveResult.filePath, buf);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: true, path: saveResult.filePath, size: buf.length };
  } catch (err) {
    shellLog.error('export-profile-legacy failed', { profileId, mode, error: err.message });
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
});

ipc.handle('import-preview', async (_event, filePath) => {
  const bridge = getLegacyModsBridge();
  if (!bridge || typeof bridge.previewLegacyProfile !== 'function') {
    return { error: 'Import-Kern nicht verfügbar' };
  }
  try {
    return await bridge.previewLegacyProfile(filePath, {
      curseforgeApiKey: readCurseForgeApiKey(),
    });
  } catch (error) {
    shellLog.error('profile archive could not be read', { error: error.message });
    return { error: `Fehler beim Lesen der Datei: ${error.message}` };
  }
});

ipc.handle('import-profile', async (event, payload) => {
  const bridge = getLegacyModsBridge();
  if (!bridge || typeof bridge.importLegacyProfile !== 'function') {
    return { success: false, error: 'Import-Kern nicht verfügbar' };
  }
  try {
    return await bridge.importLegacyProfile(payload, {
      curseforgeApiKey: readCurseForgeApiKey(),
      onBackgroundTask: (progress) => {
        try {
          event.sender.send('background-task-progress', progress);
        } catch (error) {
          shellLog.debug('import-profile: progress could not be sent', { error: error.message });
        }
      },
    });
  } catch (error) {
    shellLog.error('import-profile failed', { error: error.message });
    return { success: false, error: error.message };
  }
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'bamboo-file', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;

function windowStatePath() {
  return path.join(gameRoot(), 'window-state.json');
}

function loadWindowState() {
  try {
    const statePath = windowStatePath();
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (error) {
    shellLog.debug('window state unreadable; using defaults', { error: error.message });
  }
  return {};
}

function saveWindowState(state) {
  try {
    const statePath = windowStatePath();
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch (error) {
    shellLog.debug('window state could not be saved', { error: error.message });
  }
}

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

function createWindow() {
  protocol.handle('bamboo-file', (request) => {
    const urlPath = request.url.replace('bamboo-file://', '');
    const decodedPath = decodeURIComponent(urlPath);
    return net.fetch(path.pathToFileURL(decodedPath).toString());
  });

  Menu.setApplicationMenu(null);

  const saved = loadWindowState();

  mainWindow = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    x: saved.x,
    y: saved.y,
    minWidth: 1024, minHeight: 700,
    frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#121212', show: false,
    icon: path.join(__dirname, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i') || (input.meta && input.alt && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // A packaged build must never depend on (or trust) a local dev server.
  const rendererEntry = path.join(__dirname, 'dist', 'index.html');
  if (app.isPackaged) {
    void mainWindow.loadFile(rendererEntry);
  } else {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173').catch(() => {
      void mainWindow.loadFile(rendererEntry);
    });
  }

  if (saved.isMaximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Test hook: launch a known instance without clicking through the UI. It is
  // inert unless the local test process opts in.
  if (process.env.BAMBOO_AUTOPLAY) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const payload = JSON.stringify({
          folderName: process.env.BAMBOO_AUTOPLAY_FOLDER || 'furry-smp',
          profileName: process.env.BAMBOO_AUTOPLAY_NAME || 'Furry SMP',
          version: process.env.BAMBOO_AUTOPLAY_VERSION || '26.3',
          modLoader: 'fabric',
          loaderVersion: '0.20.1',
        });
        mainWindow.webContents.executeJavaScript(
          `window.electronAPI.launch.start(${payload})`,
        ).catch((error) => console.error('autoplay failed', error));
      }, 2500);
    });
  }

  const saveBounds = () => {
    if (!mainWindow.isMaximized()) {
      saveWindowState(mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', () => {
    saveWindowState({ isMaximized: true });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximized-change', true);
  });
  mainWindow.on('unmaximize', () => {
    saveWindowState(mainWindow.getBounds());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximized-change', false);
  });

  let allowClose = false;
  let closeTimer = null;
  const finishClose = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    ipc.removeListener('app:flush-before-close-done', finishClose);
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  };
  mainWindow.on('close', (event) => {
    const state = mainWindow.isMaximized()
      ? { isMaximized: true }
      : mainWindow.getBounds();
    saveWindowState(state);

    if (allowClose) return;
    event.preventDefault();
    if (closeTimer) return;

    ipc.once('app:flush-before-close-done', finishClose);
    closeTimer = setTimeout(finishClose, 2500);
    try {
      mainWindow.webContents.send('app:flush-before-close');
    } catch (_) {
      finishClose();
    }
  });
  mainWindow.on('closed', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    ipc.removeListener('app:flush-before-close-done', finishClose);
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
  const core = await getBambooCore();
  try {
    const { repaired, changes } = repairProfileFolderCollisions(gameRoot());
    if (repaired > 0) shellLog.info('instance folder collisions repaired at startup', { repaired });
    if (core && changes.length > 0) {
      const rootPath = gameRoot();
      for (const change of changes) {
        if (!change || typeof change.id !== 'string' || !change.id) continue;
        await core.instances.upsert({
          id: change.id,
          folderName: change.folderName,
          path: path.join(rootPath, 'profiles', change.folderName),
          legacy: true,
        });
      }
    }
  } catch (error) {
    shellLog.warn('instance folder collision migration failed', { error: error.message });
  }
  try {
    const { setupAutoUpdater } = require('./dist-electron/updater.js');
    setupAutoUpdater({ logger: shellLog });
  } catch (error) {
    // A missing updater module must never prevent the launcher from starting.
    shellLog.warn('auto-updater unavailable', { error: error.message });
  }
  createWindow();
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

async function installLoaderViaCore(loader, minecraftVersion, loaderVersion, onProgress) {
  const kind = String(loader || '').toLowerCase();
  const version = String(minecraftVersion || '');
  if (!kind || kind === 'vanilla') return { versionId: version, loaderVersion: '' };
  const core = await getBambooCore();
  if (!core) throw new Error('Launcher-Core (dist-electron) nicht verfügbar');
  const result = await core.loaders.install(kind, {
    minecraftVersion: version,
    ...(loaderVersion ? { loaderVersion: String(loaderVersion) } : {}),
    installBaseVersion: true,
    ...(onProgress ? { onProgress: (progress) => { if (progress) onProgress(progress); } } : {}),
  });
  return {
    versionId: result.versionId || version,
    loaderVersion: result.loaderVersion || String(loaderVersion || ''),
  };
}

/** Every `overrides/` + `client-overrides/` file must exist after install. */
function verifyOverrideFiles(archivePath, instanceDir) {
  const zip = new AdmZip(archivePath);
  const prefixes = ['overrides/', 'client-overrides/'];
  const root = path.resolve(instanceDir);
  const missing = [];
  const present = [];
  let checked = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const normalized = String(entry.entryName || '').replace(/\\/g, '/');
    const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
    if (!prefix) continue;
    const relative = normalized.slice(prefix.length);
    if (!relative) continue;
    checked += 1;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) missing.push(relative);
    else present.push(relative);
  }
  return { checked, missing, present };
}

ipc.handle('install-modpack-mrpack', async (event, { folderName, mcVersion, loader, mrpackUrl, mode = 'install' }) => {
  const emitProgress = (percent, label) => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const message = String(label || '');
    try {
      event.sender.send('modpack-install-progress', {
        folderName,
        percent: clamped,
        label: message,
      });
      // Same operation, second consumer: the footer bar is mounted in App and
      // therefore keeps its progress when the mod browser is left behind.
      event.sender.send('background-task-progress', {
        id: `modpack:${folderName}`,
        percent: clamped,
        label: message,
      });
    } catch (error) {
      shellLog.debug('install-modpack: progress could not be sent', { error: error.message });
    }
  };
  const rootPath = gameRoot();
  const requestedFolder = path.basename(String(folderName || ''));
  if (!requestedFolder || requestedFolder !== String(folderName) || requestedFolder === '.' || requestedFolder === '..') {
    return { success: false, error: 'Ungültiger Instanzordner' };
  }
  // `update` targets the existing folder; `install` must never reuse another
  // instance's directory even when the display name is identical.
  const profileFolder = mode === 'update'
    ? requestedFolder
    : uniqueProfileFolder(rootPath, requestedFolder, readProfilesSync(rootPath));
  const gameDir = path.join(rootPath, 'profiles', profileFolder);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  const tempDir = path.join(rootPath, 'cache', 'mrpack-tmp-' + Date.now());
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  let usedTar = false;
  try {
    emitProgress(2, 'Modpack wird vorbereitet…');
    const mrpackPath = path.join(tempDir, 'modpack.mrpack');
    shellLog.debug('install-modpack: downloading mrpack', { folderName, mcVersion, loader });
    const res = await fetch(mrpackUrl);
    if (!res.ok) throw new Error('mrpack download fehlgeschlagen ' + res.status);
    const buf = await res.arrayBuffer();
    fs.writeFileSync(mrpackPath, Buffer.from(buf));
    emitProgress(8, 'Modpack wird entpackt…');
    const extractDir = path.join(tempDir, 'extracted');
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
    try {
      const zip = new AdmZip(mrpackPath);
      zip.extractAllTo(extractDir, true);
    } catch (admError) {
      try {
        const { extractMrpackWithTar } = require('./dist-electron/mods/tar.js');
        await extractMrpackWithTar(mrpackPath, extractDir);
        usedTar = true;
        shellLog.debug('install-modpack: used tar fallback', { error: admError.message });
      } catch (tarError) {
        shellLog.error('install-modpack: extraction failed', { admError: admError.message, tarError: tarError.message });
        throw new Error(`mrpack konnte nicht entpackt werden: ${tarError.message}`);
      }
    }
    const indexJson = path.join(extractDir, 'modrinth.index.json');
    if (!fs.existsSync(indexJson)) throw new Error('modrinth.index.json nicht gefunden');
    const index = JSON.parse(fs.readFileSync(indexJson, 'utf8'));
    const files = Array.isArray(index.files) ? index.files : [];
    const dependencies = index.dependencies || {};
    const loaderDependencies = [
      ['fabric-loader', 'fabric'],
      ['quilt-loader', 'quilt'],
      ['neoforge', 'neoforge'],
      ['forge', 'forge'],
    ];
    const dependencyEntry = loaderDependencies.find(([key]) => typeof dependencies[key] === 'string' && dependencies[key]);
    const packLoader = dependencyEntry
      ? dependencyEntry[1]
      : String(loader || '').toLowerCase();
    const normLoader = ['fabric', 'quilt', 'forge', 'neoforge'].includes(packLoader) ? packLoader : 'vanilla';
    const packMcVersion = String(dependencies.minecraft || mcVersion || '');
    const requestedLoaderVersion = dependencyEntry ? String(dependencies[dependencyEntry[0]] || '') : '';
    const downloadable = files.filter((file) => {
      const envClient = file.env?.client || 'required';
      return envClient !== 'unsupported' && Boolean(file.downloads?.[0]);
    });
    emitProgress(13, 'Modpack-Dateien werden übernommen…');

    let archiveForInstall = mrpackPath;
    if (usedTar) {
      const repacked = path.join(tempDir, 'repacked.mrpack');
      const repack = new AdmZip();
      repack.addLocalFolder(extractDir);
      repack.writeZip(repacked);
      archiveForInstall = repacked;
    }

    // The core installer is the single owner of hash checks, override order,
    // stale-file cleanup and the modpack lock. The legacy handler used to
    // reimplement all four and could leave a pack that installs but cannot run.
    const { installModpack } = require('./dist-electron/mods/index.js');
    const installResult = await installModpack({
      instanceDir: gameDir,
      archivePath: archiveForInstall,
      ...(packMcVersion ? { minecraftVersion: packMcVersion } : {}),
      onProgress: (progress) => {
        const total = Math.max(1, Number(progress.total) || downloadable.length || 1);
        const done = Math.min(Number(progress.done) || 0, total);
        if (progress.phase === 'files') {
          emitProgress(
            16 + Math.round((done / total) * 54),
            `Lade ${Math.min(done + 1, total)}/${total}: ${String(progress.file || '').split('/').pop()}`,
          );
        } else if (progress.phase === 'overrides') {
          emitProgress(
            70 + Math.round((done / total) * 8),
            `Override ${Math.min(done + 1, total)}/${total}: ${String(progress.file || '').split('/').pop()}`,
          );
        }
      },
    });

    // Overrides are the pack author's own files (configs, resource packs, UI
    // data). Verify each one actually landed instead of trusting the archive.
    const overrideCheck = verifyOverrideFiles(archiveForInstall, gameDir);
    if (overrideCheck.missing.length > 0) {
      throw new Error(
        `${overrideCheck.missing.length} von ${overrideCheck.checked} Override-Dateien fehlen nach der Installation ` +
        `(z. B. ${overrideCheck.missing.slice(0, 3).join(', ')})`,
      );
    }
    shellLog.info('install-modpack: overrides verified', {
      folderName,
      profileFolder,
      checked: overrideCheck.checked,
    });
    emitProgress(78, 'Loader wird eingerichtet…');
    const modCount = installResult.installed.length + installResult.updated.length;

  let loaderInstalled = false;
  let loaderError = '';
  let installedLoaderVersion = '';
  let installedVersionId = '';
  try {
    if (normLoader !== 'vanilla' && packMcVersion) {
      emitProgress(82, `Lade ${normLoader} ${requestedLoaderVersion || ''}…`);
      const loaderPercent = { metadata: 84, base: 86, installer: 88, profile: 90, inputs: 92, processors: 94, done: 96 };
      shellLog.info('install-modpack: installing loader', { loader: normLoader, mcVersion: packMcVersion, requestedLoaderVersion });
      const loaderResult = await installLoaderViaCore(
        normLoader,
        packMcVersion,
        requestedLoaderVersion,
        (progress) => emitProgress(loaderPercent[progress.phase] || 88, progress.message),
      );
      installedLoaderVersion = loaderResult.loaderVersion;
      installedVersionId = loaderResult.versionId;
      loaderInstalled = true;
      shellLog.info('install-modpack: loader installed', { loader: normLoader, mcVersion: packMcVersion, installedLoaderVersion, installedVersionId });
    }
  } catch (e) {
    loaderError = e.message;
    shellLog.warn('install-modpack: loader installation failed', { error: e.message });
  }
  if (loaderError) {
    return { success: false, error: `Loader-Installation fehlgeschlagen: ${loaderError}`, modCount, index, loaderInstalled };
  }
  emitProgress(100, 'Modpack fertig');
  return {
    success: true,
    modCount,
    index,
    loaderInstalled,
    loader: normLoader,
    mcVersion: packMcVersion,
    loaderVersion: installedLoaderVersion,
    versionId: installedVersionId,
    folderName: profileFolder,
    overrideFiles: overrideCheck.present,
  };
  } catch (err) {
    shellLog.error('install-modpack failed', { error: err.message });
    return { success: false, error: err.message };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) { shellLog.debug('install-modpack: temp cleanup failed', { error: error.message }); }
  }
});

ipc.handle('download-mod', async (event, payload) => {
  const modsBridge = getLegacyModsBridge();
  if (modsBridge && typeof modsBridge.installLegacyMod === 'function') {
    return modsBridge.installLegacyMod(payload, {
      curseforgeApiKey: readCurseForgeApiKey(),
      onBackgroundTask: (progress) => {
        try {
          event.sender.send('background-task-progress', progress);
        } catch (error) {
          shellLog.debug('download-mod: progress could not be sent', { error: error.message });
        }
      },
    });
  }
  const { folderName, versionId, downloadUrl, filename, itemType } = payload || {};
  if (itemType === 'world' || itemType === 'worlds') {
    // Without the core there is no way to extract a world into saves/, and placing
    // the archive in a content folder is exactly the misrouting this must not do.
    throw new Error('Welten können nur über den Launcher-Core installiert werden');
  }
  const rootPath = gameRoot();
  const gameDir = path.join(rootPath, 'profiles', folderName);
  const subDir = downloadFolder(itemType);
  const destDir = path.join(gameDir, subDir);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);
  
  if (fs.existsSync(destPath)) {
    try {
      fs.unlinkSync(destPath);
    } catch (e) {
      shellLog.debug('download-mod: existing file could not be removed', { path: destPath, error: e.message });
    }
  }
  
  const res = await fetch(downloadUrl);
  if (!res.ok || res.status !== 200) throw new Error(`Download fehlgeschlagen (${res.status})`);
  
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) throw new Error('Ungültiger Download-Link (HTML-Seite statt Datei)');
  
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error('Leere Datei heruntergeladen');
  
  fs.writeFileSync(destPath, Buffer.from(buf));
  
  const stats = fs.statSync(destPath);
  if (stats.size === 0) {
    fs.unlinkSync(destPath);
    throw new Error('Datei wurde leer gespeichert');
  }
  
  return { success: true, path: destPath, size: stats.size };
});

ipc.handle('get-screenshots', async (_event, folderName) => {
  const ssPath = path.join(gameRoot(), 'profiles', folderName, 'screenshots');
  if (!fs.existsSync(ssPath)) return [];
  return fs.readdirSync(ssPath).filter(f => f.endsWith('.png')).map(f => path.join(ssPath, f));
});

ipc.handle('collect-all-screenshots', async () => {
  const rootPath = gameRoot();
  const profilesDir = path.join(rootPath, 'profiles');
  const globalDir = path.join(rootPath, 'screenshots');
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
  const list = [];
  if (!fs.existsSync(profilesDir)) return list;

  const safeSeg = (s) => {
    const cleaned = String(s || '_').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return cleaned || '_';
  };

  const copyAndRegister = (src, instanceName, worldName) => {
    try {
      const stat = fs.statSync(src);
      const origExt = (path.extname(src).toLowerCase().replace(/^\./, '') || 'png');
      const origBase = path.basename(src, path.extname(src));
      const prefixedBase = safeSeg(instanceName) + '__' + safeSeg(worldName) + '__' + safeSeg(origBase) + '__' + stat.mtimeMs;
      const dest = path.join(globalDir, prefixedBase + '.' + origExt);
      if (!fs.existsSync(dest) || fs.statSync(dest).size !== stat.size) {
        fs.copyFileSync(src, dest);
      }
      let w = 0, h = 0;
      if (origExt === 'png' && stat.size >= 24) {
        const fd = fs.openSync(dest, 'r');
        const buf = Buffer.alloc(24);
        try { fs.readSync(fd, buf, 0, 24, 0); } catch (error) {
          shellLog.debug('screenshot: header could not be read', { dest, error: error.message });
        }
        fs.closeSync(fd);
        if (buf[0] === 0x89 && buf[1] === 0x50) {
          try { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } catch (error) {
            shellLog.debug('screenshot: dimensions could not be parsed', { dest, error: error.message });
          }
        }
      }
      list.push({
        id: prefixedBase,
        title: origBase,
        fileName: path.basename(src),
        source: worldName ? (instanceName + ' / ' + worldName) : instanceName,
        instance: instanceName,
        world: worldName || null,
        date: stat.mtimeMs,
        sizeBytes: stat.size,
        sizeStr: stat.size > 1024 * 1024 ? (stat.size / 1024 / 1024).toFixed(1) + ' MB' : (stat.size / 1024).toFixed(0) + ' KB',
        dimensions: w && h ? (w + '\u00d7' + h) : '?',
        url: 'bamboo-file://' + encodeURIComponent(dest),
        absolutePath: dest,
        sourceAbsolutePath: src,
      });
    } catch (error) {
      shellLog.debug('screenshot: file could not be collected', { src, error: error.message });
    }
  };

  const scanDir = (folder, instanceName, worldName) => {
    if (!fs.existsSync(folder)) return;
    let entries;
    try { entries = fs.readdirSync(folder); } catch (_) { return; }
    for (const f of entries) {
      if (!/\.(png|jpg|jpeg)$/i.test(f)) continue;
      try {
        const src = path.join(folder, f);
        if (!fs.statSync(src).isFile()) continue;
        copyAndRegister(src, instanceName, worldName);
      } catch (error) {
        shellLog.debug('screenshot: folder entry skipped', { folder, error: error.message });
      }
    }
  };

  let profileEntries;
  try { profileEntries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch (_) { return list; }
  for (const e of profileEntries) {
    if (!e.isDirectory()) continue;
    const instName = e.name;
    const instDir = path.join(profilesDir, instName);
    scanDir(path.join(instDir, 'screenshots'), instName, null);
    const saves = path.join(instDir, 'saves');
    if (fs.existsSync(saves)) {
      let worldEntries;
      try { worldEntries = fs.readdirSync(saves, { withFileTypes: true }); } catch (_) { continue; }
      for (const w of worldEntries) {
        if (!w.isDirectory()) continue;
        scanDir(path.join(saves, w.name, 'screenshots'), instName, w.name);
      }
    }
  }
  list.sort((a, b) => b.date - a.date);
  return list;
});

ipc.handle('delete-screenshot-file', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { absolutePath, sourceAbsolutePath } = payload;
  if (!absolutePath || typeof absolutePath !== 'string') return false;
  return deleteScreenshotFile(
    {
      rootPath: gameRoot(),
      absolutePath,
      ...(typeof sourceAbsolutePath === 'string' ? { sourceAbsolutePath } : {}),
    },
    shellLog,
  );
});

ipc.handle('open-screenshots-folder', async () => {
  const rootPath = gameRoot();
  const ssDir = path.join(rootPath, 'screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
  shell.openPath(ssDir);
});

ipc.on('copy-to-clipboard', (_e, text) => clipboard.writeText(text));
ipc.on('open-external-url', (_e, url) => shell.openExternal(url));

ipc.on('launch-game', async (event, args) => {
  const { folderName, profileName, version, modLoader, loaderVersion: rawLoaderVersion, javaPath: profileJavaPath, gameOptions } = args;
  let normalizedLoader = String(modLoader || 'vanilla').toLowerCase();
  let loaderVersion = String(rawLoaderVersion || '');
  const emitLaunchFailed = (message) => event.reply('launch-failed', { folderName, profileName, message });
  // One timestamp per launch: a remounted card resumes the same curve instead
  // of starting over, and the synthetic display never runs backwards.
  const launchStartedAt = Date.now();
  const emitLaunchProgress = (percent, label) => {
    try {
      event.reply('launch-progress', {
        folderName,
        profileName,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        label: String(label || ''),
        startedAt: launchStartedAt,
      });
    } catch (error) {
      shellLog.debug('launch-game: progress could not be sent', { error: error.message });
    }
  };

  if (ACTIVE_LAUNCHES.size >= MAX_CONCURRENT_LAUNCHES) {
    event.reply('launch-status', 'Es läuft bereits die maximale Anzahl an Minecraft-Instanzen (4).');
    emitLaunchFailed('Es läuft bereits die maximale Anzahl an Minecraft-Instanzen (4).');
    return;
  }
  if (ACTIVE_LAUNCHES.has(folderName)) {
    event.reply('launch-status', `"${profileName}" wird bereits gestartet oder läuft bereits.`);
    emitLaunchFailed(`"${profileName}" wird bereits gestartet oder läuft bereits.`);
    return;
  }
  launchCounter++;
  const launchId = profileName + '-' + Date.now() + '-' + launchCounter;
  ACTIVE_LAUNCHES.set(folderName, launchId);

  shellLog.info('launch-game: starting', { profileName, folderName, loader: normalizedLoader, version });
  const rootPath = await resolveGameRoot();
  const legacyDirectory = path.join(rootPath, 'profiles', folderName);
  const packDependencies = (() => {
    try {
      const indexFile = path.join(legacyDirectory, 'modrinth.index.json');
      if (!fs.existsSync(indexFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return parsed && typeof parsed.dependencies === 'object' && parsed.dependencies ? parsed.dependencies : {};
    } catch (error) {
      shellLog.debug('launch-game: modpack index unreadable', { folderName, error: error.message });
      return {};
    }
  })();
  const packLoader = [
    ['fabric-loader', 'fabric'],
    ['quilt-loader', 'quilt'],
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
  ].find(([key]) => typeof packDependencies[key] === 'string' && packDependencies[key]);
  if (packLoader) {
    // The installed .mrpack is the source of truth. This also repairs profiles
    // whose visible loader label was wrong (e.g. a Quilt pack saved as Fabric).
    normalizedLoader = packLoader[1];
    loaderVersion = String(packDependencies[packLoader[0]] || '');
  }
  const launchVersion = String(packDependencies.minecraft || version || '');
  shellLog.info('launch-game: resolved pack', {
    folderName,
    loader: normalizedLoader,
    loaderVersion,
    version: launchVersion,
  });
  emitLaunchProgress(3, 'Start wird vorbereitet…');

  const prepareLaunchTarget = async ({ directory }) => {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });

    // Cosmetics live in `<instance>/bamboo/cosmetics`; the game reads that
    // folder itself, so the launch path has nothing to rewrite.
    const seeded = writeFirstRunOptions(directory, gameOptions);
    if (seeded.created) {
      shellLog.debug('launch-game: options.txt seeded', { path: seeded.path });
    } else {
      const applied = applyLauncherGameOptions(directory, gameOptions);
      if (applied.length > 0) shellLog.debug('launch-game: options.txt merged', { applied });
    }
  };

  event.reply('launch-status', 'Starte Minecraft...');
  setImmediate(async () => {
    let finalVersionId = launchVersion;
    let activeHandle = null;
    let gameReadySent = false;

    try {
      event.reply('launch-status', 'Profil wird vorbereitet...');
    emitLaunchProgress(8, 'Profil wird vorbereitet…');

    if (normalizedLoader !== 'vanilla') {
      const loaderLabel = loaderVersion ? `${normalizedLoader} ${loaderVersion}` : `Neueste ${normalizedLoader}-Version`;
      event.reply('launch-status', `${loaderLabel} wird vorbereitet...`);
      emitLaunchProgress(15, `${loaderLabel} wird vorbereitet…`);
      const loaderPercent = { metadata: 20, base: 28, installer: 38, profile: 46, inputs: 52, processors: 58, done: 62 };
      const loaderResult = await installLoaderViaCore(
        normalizedLoader,
        launchVersion,
        loaderVersion,
        (progress) => {
          event.reply('launch-status', progress.message);
          emitLaunchProgress(loaderPercent[progress.phase] || 30, progress.message);
        },
      );
      finalVersionId = loaderResult.versionId;
      if (loaderResult.loaderVersion) loaderVersion = loaderResult.loaderVersion;
    }

    const core = await getBambooCore();
    if (!core) throw new Error('Launcher-Core (dist-electron) nicht verfügbar');
    emitLaunchProgress(66, 'Startdateien werden geprüft…');

    const { launchLegacyInstance } = require('./dist-electron/launch/legacy.js');
    const server = gameOptions && gameOptions.joinServer
      ? { host: gameOptions.joinServer, port: Number(gameOptions.joinPort) || 25565 }
      : undefined;

    updateDiscordPresence('starting', profileName);
    event.reply('launch-status', 'Minecraft wird gestartet...');
    emitLaunchProgress(80, 'Minecraft wird gestartet…');
    activeHandle = await launchLegacyInstance(core, {
      folderName,
      directory: legacyDirectory,
      name: profileName,
      minecraftVersion: launchVersion,
      versionId: finalVersionId,
      loader: normalizedLoader,
      loaderVersion: String(loaderVersion || ''),
      // Always send the choice: an empty string means automatic and must be
      // able to replace a stale migrated javaPath.
      javaPath: String(profileJavaPath || ''),
      ...(server ? { server } : {}),
    }, (ev) => {
        if (ev.type === 'status') {
          event.reply('launch-status', ev.message);
          emitLaunchProgress(88, ev.message);
        } else if (ev.type === 'ready') {
          if (!gameReadySent) {
            gameReadySent = true;
            emitLaunchProgress(100, 'Minecraft ist bereit');
            event.reply('game-ready', profileName);
            const inGameText = `${launchVersion}${normalizedLoader !== 'vanilla' ? ` - ${normalizedLoader}` : ''}`;
            updateDiscordPresence('inGame', profileName, inGameText);
          }
        } else if (ev.type === 'crash-report') {
          event.reply('launch-status', `Crash-Report: ${ev.path}`);
        } else if (ev.type === 'exit') {
          ACTIVE_LAUNCHES.delete(folderName);
          updateDiscordPresence('back');
          event.reply('game-closed', { code: ev.code, profileName, folderName });
        }
    }, { beforeLaunch: prepareLaunchTarget });
    ACTIVE_LAUNCHES.set(folderName, { launchId: activeHandle.launchId, handle: activeHandle });
    emitLaunchProgress(94, 'Minecraft lädt…');
    shellLog.debug('launch-game: start command', { command: activeHandle.plan.displayCommand.join(' ') });
  } catch (error) {
    ACTIVE_LAUNCHES.delete(folderName);
    shellLog.error('launch-game failed', { profileName, folderName, error: error.message });
    event.reply('launch-status', `Fehler: ${error.message}`);
    emitLaunchFailed(error.message);
  }
  });
});

ipc.handle('get-active-launches', async () => {
  return Array.from(ACTIVE_LAUNCHES.keys());
});

ipc.handle('kill-game', async (_event, folderName) => {
  const entry = ACTIVE_LAUNCHES.get(folderName);
  if (!entry || !entry.handle || entry.handle.killed) return false;
  await entry.handle.kill();
  return true;
});

ipc.handle('delete-content-file', async (_event, payload) => {
  const modsBridge = getLegacyModsBridge();
  if (modsBridge && typeof modsBridge.removeLegacyContent === 'function') {
    return modsBridge.removeLegacyContent(payload);
  }
  const { folderName, fileName, type } = payload || {};
  const rootPath = gameRoot();
  const profilesDir = path.join(rootPath, 'profiles');
  
  if (!folderName || !fileName) {
    shellLog.warn('delete-content-file: missing folderName or fileName');
    return false;
  }
  
  const typeDir = downloadFolder(type);

  const target = path.join(profilesDir, folderName, typeDir, fileName);
  
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(profilesDir))) {
    shellLog.warn('delete-content-file: path escapes profiles directory', { resolved });
    return false;
  }

  if (!fs.existsSync(resolved)) {
    shellLog.debug('delete-content-file: file already absent', { resolved });
    return true;
  }

  try {
    fs.unlinkSync(resolved);
    shellLog.debug('delete-content-file: deleted', { resolved });

    const parentDir = path.dirname(resolved);
    if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
      try {
        fs.rmdirSync(parentDir);
        shellLog.debug('delete-content-file: empty folder removed', { parentDir });
      } catch (e) {
        shellLog.debug('delete-content-file: empty folder could not be removed', { parentDir, error: e.message });
      }
    }

    return true;
  } catch (e) {
    shellLog.error('delete-content-file failed', { resolved, error: e.message });
    return false;
  }
});

function hashFileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

ipc.handle('hash-content-files', async (_event, payload = {}) => {
  const { folderName, files } = payload || {};
  const profilesDir = path.resolve(gameRoot(), 'profiles');
  const profileDir = path.resolve(profilesDir, String(folderName || ''));
  if (!folderName || !profileDir.startsWith(profilesDir) || !Array.isArray(files)) return {};
  const result = {};
  const entries = files
    .filter((file) => file && typeof file.fileName === 'string' && file.fileName.length > 0)
    .slice(0, 500);
  for (let index = 0; index < entries.length; index += 4) {
    const batch = entries.slice(index, index + 4);
    await Promise.all(batch.map(async (file) => {
      try {
        const dir = path.resolve(profileDir, downloadFolder(file.type));
        if (!dir.startsWith(profileDir)) return;
        const filePath = path.resolve(dir, path.basename(file.fileName));
        if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) return;
        result[file.fileName] = await hashFileSha1(filePath);
      } catch (error) {
        shellLog.debug('hash-content-files: file could not be hashed', { file: file.fileName, error: error.message });
      }
    }));
  }
  return result;
});

// Identify locally added files through their content, not their file name:
// Modrinth matches the SHA-1 of the exact released file, CurseForge matches its
// Murmur2 fingerprint. Only an exact file match is accepted, so a mod that was
// repacked or edited stays local instead of being labelled with a wrong project.
ipc.handle('identify-content-files', async (_event, payload = {}) => {
  const { folderName, files } = payload || {};
  const profilesDir = path.resolve(gameRoot(), 'profiles');
  const profileDir = path.resolve(profilesDir, String(folderName || ''));
  if (!folderName || !profileDir.startsWith(profilesDir) || !Array.isArray(files)) return {};
  const { curseForgeFingerprint } = require('./dist-electron/mods/fingerprint.js');
  const entries = files
    .filter((file) => file && typeof file.fileName === 'string' && file.fileName.length > 0)
    .slice(0, 100);

  const sha1ByFile = new Map();
  const fingerprintByFile = new Map();
  for (const entry of entries) {
    try {
      const dir = path.resolve(profileDir, downloadFolder(entry.type));
      if (!dir.startsWith(profileDir)) continue;
      const filePath = path.resolve(dir, path.basename(entry.fileName));
      if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) continue;
      const buffer = fs.readFileSync(filePath);
      sha1ByFile.set(entry.fileName, crypto.createHash('sha1').update(buffer).digest('hex'));
      fingerprintByFile.set(entry.fileName, curseForgeFingerprint(buffer) >>> 0);
    } catch (error) {
      shellLog.debug('identify-content-files: unreadable', { file: entry.fileName, error: error.message });
    }
  }

  const result = {};
  const userAgent = `BambooLauncher/${app.getVersion()}`;
  const hashes = [...new Set(sha1ByFile.values())];
  const versionsByHash = new Map();
  for (let index = 0; index < hashes.length; index += 100) {
    try {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
        body: JSON.stringify({ hashes: hashes.slice(index, index + 100), algorithm: 'sha1' }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const [hash, version] of Object.entries(data || {})) {
        if (version && typeof version === 'object') versionsByHash.set(hash, version);
      }
    } catch (error) {
      shellLog.debug('identify-content-files: Modrinth hashes failed', { error: error.message });
    }
  }

  const projectIds = [...new Set(
    [...versionsByHash.values()].map((version) => version.project_id).filter(Boolean),
  )];
  const projectsById = new Map();
  for (let index = 0; index < projectIds.length; index += 50) {
    try {
      const res = await fetch(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds.slice(index, index + 50)))}`,
        { headers: { 'User-Agent': userAgent } },
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const project of Array.isArray(data) ? data : []) {
        if (project && project.id) projectsById.set(project.id, project);
      }
    } catch (error) {
      shellLog.debug('identify-content-files: Modrinth projects failed', { error: error.message });
    }
  }

  for (const [fileName, hash] of sha1ByFile) {
    const version = versionsByHash.get(hash);
    const project = version && projectsById.get(version.project_id);
    if (!project || !project.slug) continue;
    result[fileName] = {
      source: 'modrinth',
      projectId: project.slug,
      name: project.title || '',
      iconUrl: project.icon_url || '',
      versionNumber: version.version_number || '',
    };
  }

  const cfHeaders = curseForgeHeaders();
  const unmatched = entries.filter((entry) => !result[entry.fileName] && fingerprintByFile.has(entry.fileName));
  if (cfHeaders && unmatched.length > 0) {
    try {
      const fingerprints = [...new Set(unmatched.map((entry) => fingerprintByFile.get(entry.fileName)))];
      const res = await curseForgeFetch('https://api.curseforge.com/v1/fingerprints', {
        method: 'POST',
        headers: { ...cfHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprints }),
      });
      if (res.ok) {
        const data = (await res.json()).data || {};
        const matches = Array.isArray(data.exactMatches) ? data.exactMatches : [];
        const modIds = [...new Set(
          matches.map((match) => Number(match && match.file && match.file.modId)).filter((id) => id > 0),
        )].slice(0, 50);
        const modsById = new Map();
        if (modIds.length > 0) {
          const modsRes = await curseForgeFetch('https://api.curseforge.com/v1/mods', {
            method: 'POST',
            headers: { ...cfHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ modIds }),
          });
          if (modsRes.ok) {
            const mods = (await modsRes.json()).data || [];
            for (const mod of Array.isArray(mods) ? mods : []) {
              if (mod && mod.id) modsById.set(Number(mod.id), mod);
            }
          }
        }
        for (const match of matches) {
          const file = match && match.file;
          const mod = file ? modsById.get(Number(file.modId)) : undefined;
          if (!file || !mod) continue;
          const fileName = String(file.fileName || '');
          if (!fileName || result[fileName]) continue;
          const logo = mod.logo && (mod.logo.thumbnailUrl || mod.logo.url);
          result[fileName] = {
            source: 'curseforge',
            projectId: String(mod.id),
            name: mod.name || '',
            iconUrl: logo || '',
            versionNumber: String(file.displayName || file.fileName || ''),
          };
        }
      }
    } catch (error) {
      shellLog.debug('identify-content-files: CurseForge fingerprints failed', { error: error.message });
    }
  }
  return result;
});

ipc.handle('list-content-files', async (_event, { folderName, type }) => {
  const rootPath = gameRoot();
  const profilesDir = path.join(rootPath, 'profiles');
  if (!folderName) {
    shellLog.warn('list-content-files: missing folderName');
    return [];
  }
  const typeDir = downloadFolder(type);
  const dir = path.resolve(profilesDir, folderName, typeDir);
  
  if (!dir.startsWith(path.resolve(profilesDir))) {
    shellLog.warn('list-content-files: path escapes profiles directory', { dir });
    return [];
  }
  
  if (!fs.existsSync(dir)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name);
    shellLog.debug('list-content-files: listed', { dir, count: files.length });
    return files;
  } catch (e) {
    shellLog.error('list-content-files failed', { dir, error: e.message });
    return [];
  }
});

ipc.handle('list-instance-worlds', async (_event, folderName) => {
  const rootPath = gameRoot();
  const profilesDir = path.resolve(rootPath, 'profiles');
  if (!folderName) {
    shellLog.warn('list-instance-worlds: missing folderName');
    return [];
  }
  const savesDir = path.resolve(profilesDir, String(folderName), 'saves');
  if (!savesDir.startsWith(profilesDir)) {
    shellLog.warn('list-instance-worlds: path escapes profiles directory', { savesDir });
    return [];
  }
  try {
    const { listInstanceWorlds } = require('./dist-electron/instances/worlds.js');
    const worlds = listInstanceWorlds(savesDir);
    shellLog.debug('list-instance-worlds: listed', { folderName, count: worlds.length, savesDir });
    return worlds;
  } catch (e) {
    shellLog.error('list-instance-worlds failed', { folderName, error: e.message });
    return [];
  }
});

function parseJarMetadata(jarPath) {
  const result = { modName: null, modVersion: null, modLoader: null, mcVersion: null, iconBase64: null, description: '', authors: '' };
  try {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();
    const fabricEntry = entries.find(function(e) { return e.entryName === 'fabric.mod.json'; });
    if (fabricEntry) {
      try {
        const meta = JSON.parse(fabricEntry.getData().toString('utf8'));
        if (meta.name) result.modName = meta.name;
        if (meta.version) result.modVersion = meta.version;
        if (meta.description) result.description = meta.description;
        if (meta.authors) result.authors = Array.isArray(meta.authors) ? meta.authors.join(', ') : String(meta.authors);
        if (meta.icon) {
          const iconEntry = entries.find(function(e) { return e.entryName === meta.icon; });
          if (iconEntry) result.iconBase64 = 'data:image/png;base64,' + iconEntry.getData().toString('base64');
        }
      } catch (e) {
        shellLog.debug('jar metadata: Fabric manifest unreadable', { jarPath, error: e.message });
      }
    }
    if (!fabricEntry) {
      const forgeEntry = entries.find(function(e) { return e.entryName === 'META-INF/mods.toml'; });
      if (forgeEntry) {
        const raw = forgeEntry.getData().toString('utf8');
        const dm = raw.match(/^\s*displayName\s*=\s*"([^"]+)"/m);
        const vm = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
        const desc = raw.match(/^\s*description\s*=\s*"([^"]+)"/m);
        const nm = raw.match(/^\s*modId\s*=\s*"([^"]+)"/m);
        if (dm) result.modName = dm[1]; else if (nm) result.modName = nm[1];
        if (vm) result.modVersion = vm[1];
        if (desc) result.description = desc[1];
        result.modLoader = 'forge';
        const logoEntry = entries.find(function(e) { return e.entryName === 'logo.png'; });
        if (logoEntry) result.iconBase64 = 'data:image/png;base64,' + logoEntry.getData().toString('base64');
      }
      const neoEntry = entries.find(function(e) { return e.entryName === 'META-INF/neoforge.mods.toml'; });
      if (neoEntry) {
        const raw = neoEntry.getData().toString('utf8');
        const dm = raw.match(/^\s*displayName\s*=\s*"([^"]+)"/m);
        const vm = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
        const nm = raw.match(/^\s*modId\s*=\s*"([^"]+)"/m);
        if (dm) result.modName = dm[1]; else if (nm) result.modName = nm[1];
        if (vm) result.modVersion = vm[1];
        result.modLoader = 'neoforge';
        const logoEntry = entries.find(function(e) { return e.entryName === 'logo.png'; });
        if (logoEntry) result.iconBase64 = 'data:image/png;base64,' + logoEntry.getData().toString('base64');
      }
    }
    if (!result.iconBase64) {
      var iconPaths = ['icon.png', 'assets/icon.png', 'logo.png', 'pack.png'];
      for (var pi = 0; pi < iconPaths.length; pi++) {
        const ie = entries.find(function(e) { return e.entryName === iconPaths[pi]; });
        if (ie) { result.iconBase64 = 'data:image/png;base64,' + ie.getData().toString('base64'); break; }
      }
    }
  } catch (e) {
    shellLog.debug('jar metadata: archive unreadable', { jarPath, error: e.message });
  }
  return result;
}

ipc.handle('upload-local-mod', async (event, { folderName, filePath, itemType, taskId }) => {
  const rootPath = gameRoot();
  const instanceDir = path.join(rootPath, 'profiles', folderName);
  const emitTaskProgress = (percent, label) => {
    if (!taskId) return;
    try {
      event.sender.send('background-task-progress', {
        id: taskId,
        percent: typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : null,
        label: String(label || ''),
      });
    } catch (error) {
      shellLog.debug('upload-local-mod: progress could not be sent', { error: error.message });
    }
  };
  // A world archive is not content: it is extracted into saves/<world>, which is
  // exactly where the game reads it and where the Worlds tab detects it.
  if (itemType === 'world' || itemType === 'worlds') {
    try {
      const { installWorldArchive } = require('./dist-electron/instances/world-install.js');
      const fileName = path.basename(filePath);
      const preferredName = fileName.replace(/\.(zip|mcworld)$/i, '');
      emitTaskProgress(2, `Welt wird entpackt: ${fileName}`);
      const result = await installWorldArchive({
        instanceDir,
        archivePath: filePath,
        preferredName,
        onProgress: ({ done, total }) => {
          emitTaskProgress(
            total > 0 ? 4 + (done / total) * 92 : null,
            `Welt wird installiert: ${done}/${total || '?'} Dateien`,
          );
        },
      });
      const worlds = result.worlds.map((world) => ({
        folderName: world.folderName,
        path: world.path,
        renamed: world.renamed,
        files: world.files,
      }));
      emitTaskProgress(100, `Welt installiert: ${worlds[0]?.folderName || fileName}`);
      shellLog.info('upload-local-mod: world installed', { folderName, worlds });
      return {
        success: true,
        fileName,
        destPath: worlds[0] ? worlds[0].path : instanceDir,
        itemType: 'saves',
        worlds,
      };
    } catch (e) {
      shellLog.error('upload-local-mod failed', { folderName, itemType, error: e.message });
      return { success: false, fileName: filePath ? path.basename(filePath) : '', error: e.message };
    }
  }
  // Every pack type uses the shared mapping, so "shader"/"resourcepack"/
  // "datapack" never become literal folder names.
  const subDir = downloadFolder(itemType);
  try {
    const fileName = path.basename(filePath);
    const destDir = path.join(instanceDir, subDir);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, fileName);
    fs.copyFileSync(filePath, destPath);
    let modName = fileName.replace(/\.(jar|zip|disabled)$/i, '').replace(/-\d+\.\d+[^\/]*$/i, '');
    let modVersion = (fileName.match(/-([\d.]+)/) || [])[1] || 'unknown';
    let modLoader = 'unknown';
    let mcVersion = null;
    let iconBase64 = null;
    if (fileName.endsWith('.jar')) {
      try {
        const meta = parseJarMetadata(filePath);
        if (meta.modName) modName = meta.modName;
        if (meta.modVersion) modVersion = meta.modVersion;
        if (meta.modLoader) modLoader = meta.modLoader;
        if (meta.iconBase64) iconBase64 = meta.iconBase64;
      } catch (e) {
        shellLog.debug('upload-local-mod: metadata unreadable', { destPath, error: e.message });
      }
    }
    if (modLoader === 'unknown') {
      if (fileName.includes('-fabric')) modLoader = 'fabric';
      else if (fileName.includes('-forge')) modLoader = 'forge';
      else if (fileName.includes('-neoforge')) modLoader = 'neoforge';
    }
    emitTaskProgress(100, `Datei installiert: ${fileName}`);
    return { success: true, fileName: fileName, destPath: destPath, modName: modName, modVersion: modVersion, modLoader: modLoader, mcVersion: mcVersion, iconBase64: iconBase64, itemType: subDir };
  } catch (e) {
    return { success: false, fileName: filePath ? path.basename(filePath) : '', error: e.message };
  }
});

ipc.handle('rename-instance', async (_event, { oldFolderName, newName }) => {
  const rootPath = gameRoot();
  try {
    const profilesPath = path.join(rootPath, 'profiles.json');
    if (!fs.existsSync(profilesPath)) return { success: false, error: 'Profiles file not found' };
    const profiles = readProfilesSync(rootPath);
    const idx = profiles.findIndex(function(p) { return profileFolderOf(p).toLowerCase() === String(oldFolderName || '').toLowerCase(); });
    if (idx === -1) return { success: false, error: 'Instance not found' };
    const currentFolder = profileFolderOf(profiles[idx]);
    const safeName = profileFolderSlug(newName);
    // Never fail on a name that already exists: reserve the next free folder.
    const folderName = uniqueProfileFolder(rootPath, safeName, profiles, currentFolder);
    const oldDir = path.join(rootPath, 'profiles', currentFolder);
    const newDir = path.join(rootPath, 'profiles', folderName);
    if (folderName !== currentFolder && fs.existsSync(oldDir)) {
      if (fs.existsSync(newDir)) return { success: false, error: 'Folder name already exists' };
      fs.renameSync(oldDir, newDir);
    }
    profiles[idx].name = newName;
    profiles[idx].folderName = folderName;
    writeProfilesSync(rootPath, profiles);
    return { success: true, newFolderName: folderName, profiles: profiles };
  } catch (e) {
    shellLog.error('rename-instance failed', { oldFolderName, error: e.message });
    return { success: false, error: e.message };
  }
});

ipc.handle('clone-instance', async (_event, { folderName, newName }) => {
  const rootPath = gameRoot();
  try {
    const profiles = readProfilesSync(rootPath);
    const sourceIndex = profiles.findIndex(function(p) {
      return profileFolderOf(p).toLowerCase() === String(folderName || '').toLowerCase();
    });
    if (sourceIndex === -1) return { success: false, error: 'Instance not found' };
    const sourceProfile = profiles[sourceIndex];
    const name = uniqueProfileName(profiles, newName || `${sourceProfile.name || 'Instanz'} (Kopie)`);
    const cloneFolder = uniqueProfileFolder(rootPath, profileFolderSlug(name), profiles);
    const sourceDir = path.join(rootPath, 'profiles', profileFolderOf(sourceProfile));
    const targetDir = path.join(rootPath, 'profiles', cloneFolder);
    if (fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
    } else {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const clone = {
      ...sourceProfile,
      id: require('crypto').randomUUID(),
      name,
      folderName: cloneFolder,
      playTimeMs: 0,
      sessionCount: 0,
      lastPlayedAt: 0,
      lastPlayed: '',
      createdAt: Date.now(),
    };
    profiles.push(clone);
    writeProfilesSync(rootPath, profiles);
    shellLog.info('instance cloned', { from: sourceProfile.name, to: name, folderName: cloneFolder });
    return { success: true, profile: clone };
  } catch (e) {
    shellLog.error('clone-instance failed', { folderName, error: e.message });
    return { success: false, error: e.message };
  }
});

function resolveBundledInstanceCover(file) {
  const roots = [
    path.join(app.getAppPath(), 'dist'),
    path.join(app.getAppPath(), 'public'),
    path.join(__dirname, 'dist'),
    path.join(__dirname, 'public'),
  ];
  for (const root of roots) {
    const candidate = path.join(root, 'instance-covers', file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function shortcutCoverImage(profile) {
  const source = shortcutCoverPlan(profile?.thumbnail || profile?.icon || '');
  try {
    if (source.kind === 'data-url') return nativeImage.createFromDataURL(source.value);
    if (source.kind === 'bundled') {
      const file = resolveBundledInstanceCover(source.file);
      // Read through fs so the image also loads when the app runs from an asar.
      return file ? nativeImage.createFromBuffer(fs.readFileSync(file)) : nativeImage.createEmpty();
    }
    if (source.kind === 'file') {
      return fs.existsSync(source.path) ? nativeImage.createFromPath(source.path) : nativeImage.createEmpty();
    }
  } catch (error) {
    shellLog.debug('shortcut icon cover unreadable', { kind: source.kind, error: error.message });
  }
  return nativeImage.createEmpty();
}

/** Windows shortcuts need an .ico; the instance cover becomes a 256 px PNG icon. */
function createShortcutIcon(profile, folderName) {
  let image = shortcutCoverImage(profile);
  // A broken cover still gets an instance image (the bundled default), never the logo.
  if (image.isEmpty()) image = shortcutCoverImage({});
  if (image.isEmpty()) return '';
  // Crop the cover to a centred square before scaling, so the shortcut icon is
  // never squashed when the source image has a 16:9 or 4:3 aspect ratio.
  const size = image.getSize();
  const side = Math.min(size.width, size.height);
  if (side > 0 && size.width !== size.height) {
    image = image.crop({
      x: Math.max(0, Math.round((size.width - side) / 2)),
      y: Math.max(0, Math.round((size.height - side) / 2)),
      width: side,
      height: side,
    });
  }
  const png = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  if (!png || png.length === 0) return '';
  const directory = path.join(app.getPath('userData'), 'shortcut-icons');
  fs.mkdirSync(directory, { recursive: true });
  // Content-addressed name: changing the cover changes the path, so Windows
  // cannot keep showing the cached old icon on the shortcut.
  const base = shortcutIconFileName(folderName).replace(/\.ico$/, '');
  const digest = crypto.createHash('sha1').update(png).digest('hex').slice(0, 10);
  const iconPath = path.join(directory, `${base}-${digest}.ico`);
  fs.writeFileSync(iconPath, pngToIco(png));
  return iconPath;
}

ipc.handle('create-desktop-shortcut', async (_event, { folderName, instanceName }) => {
  try {
    if (process.platform !== 'win32') {
      return { success: false, error: 'Desktop-Verknüpfungen werden derzeit nur unter Windows erstellt.' };
    }
    const rootPath = gameRoot();
    const profiles = readProfilesSync(rootPath);
    const profile = profiles.find(function(p) {
      return profileFolderOf(p).toLowerCase() === String(folderName || '').toLowerCase();
    });
    if (!profile) return { success: false, error: 'Instanz nicht gefunden' };
    const safeLabel = String(instanceName || profile.name || 'Minecraft')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 60) || 'Minecraft';
    // Two instances may share a display name. Include the unique folder in the
    // shortcut name then, so creating the second shortcut cannot overwrite the first.
    const sharedName = profiles.some(function(p) {
      return profileFolderOf(p) !== profileFolderOf(profile) &&
        String(p.name || '').trim().toLowerCase() === String(profile.name || '').trim().toLowerCase();
    });
    const shortcutLabel = sharedName ? `${safeLabel} (${profileFolderOf(profile)})` : safeLabel;
    const shortcutPath = path.join(app.getPath('desktop'), `${shortcutLabel} - Bamboo Launcher.lnk`);
    const launchArgs = `--bamboo-instance="${profileFolderOf(profile)}"`;
    const args = app.isPackaged ? launchArgs : `"${app.getAppPath()}" ${launchArgs}`;
    const iconPath = createShortcutIcon(profile, profileFolderOf(profile));
    if (!iconPath) {
      return { success: false, error: 'Das Instanzbild konnte nicht als Verknüpfungs-Icon gespeichert werden.' };
    }
    const operation = fs.existsSync(shortcutPath) ? 'update' : 'create';
    const created = shell.writeShortcutLink(shortcutPath, operation, {
      target: process.execPath,
      args,
      description: `${safeLabel} mit Bamboo Launcher starten`,
      icon: iconPath,
      iconIndex: 0,
    });
    if (!created) return { success: false, error: 'Verknüpfung konnte nicht erstellt werden.' };
    shellLog.info('desktop shortcut created', { shortcutPath, folderName, icon: path.basename(iconPath) });
    return { success: true, path: shortcutPath };
  } catch (e) {
    shellLog.error('create-desktop-shortcut failed', { folderName, error: e.message });
    return { success: false, error: e.message };
  }
});

ipc.handle('scan-local-mods', async (_event, { folderName }) => {
  const rootPath = gameRoot();
  const modsDir = path.join(rootPath, 'profiles', folderName, 'mods');
  if (!fs.existsSync(modsDir)) return [];
  const files = fs.readdirSync(modsDir).filter(function(f) { return f.endsWith('.jar') && !f.endsWith('.disabled'); });
  const results = [];
  for (var fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const fullPath = path.join(modsDir, f);
    const stat = fs.statSync(fullPath);
    let modName = f.replace(/\.jar$/i, '').replace(/-\d+\.\d+[^\/]*$/i, '');
    let modVersion = (f.match(/-([\d.]+)/) || [])[1] || 'unknown';
    let loader = 'unknown';
    let mcVersion = null;
    let iconBase64 = null;
    let description = '';
    let authors = '';
    try {
      const meta = parseJarMetadata(fullPath);
      if (meta.modName) modName = meta.modName;
      if (meta.modVersion) modVersion = meta.modVersion;
      if (meta.modLoader) loader = meta.modLoader;
      if (meta.iconBase64) iconBase64 = meta.iconBase64;
      if (meta.description) description = meta.description;
      if (meta.authors) authors = meta.authors;
    } catch (e) {
      shellLog.debug('list-local-mods: metadata unreadable', { fullPath, error: e.message });
    }
    if (loader === 'unknown') {
      if (f.includes('-fabric')) loader = 'fabric';
      else if (f.includes('-forge')) loader = 'forge';
      else if (f.includes('-neoforge')) loader = 'neoforge';
    }
    results.push({ fileName: f, fullPath: fullPath, size: stat.size, lastModified: stat.mtimeMs, name: modName, version: modVersion, loader: loader, mcVersion: mcVersion, iconBase64: iconBase64, description: description, authors: authors, source: 'local' });
  }
  return results;
});

ipc.handle('match-local-mod', async (_event, { modName, projectId, source }) => {
  const results = { curseforge: null, modrinth: null };
  const cfHeaders = curseForgeHeaders();
  if (projectId) {
    if (source === 'curseforge') {
      if (!cfHeaders) return { ...results, error: 'Kein CurseForge API-Key gesetzt' };
      try {
        var url1 = 'https://api.curseforge.com/v1/mods/' + projectId;
        const res = await curseForgeFetch(url1, { headers: cfHeaders });
        if (res.ok) results.curseforge = (await res.json()).data;
      } catch (e) {
        shellLog.warn('match-local-mod: CurseForge lookup failed', { projectId, error: e.message });
      }
      return results;
    }
    if (source === 'modrinth') {
      try {
        var url2 = 'https://api.modrinth.com/v2/project/' + projectId;
        const res = await fetch(url2, { headers: { 'User-Agent': `BambooLauncher/${app.getVersion()}` } });
        if (res.ok) results.modrinth = await res.json();
      } catch (e) {
        shellLog.warn('match-local-mod: Modrinth lookup failed', { projectId, error: e.message });
      }
      return results;
    }
  }
  if (modName) {
    const searchName = modName.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    if (searchName.length >= 2) {
      if (cfHeaders) {
        try {
          var params = new URLSearchParams({ gameId: '432', searchFilter: searchName, pageSize: '5' });
          var url3 = 'https://api.curseforge.com/v1/mods/search?' + params.toString();
          const res = await curseForgeFetch(url3, { headers: cfHeaders });
          if (res.ok) {
            const data = await res.json();
            const items = data.data || [];
            const exact = items.find(function(m) { return m.name === modName; });
            results.curseforge = exact || items[0] || null;
          }
        } catch (e) {
          shellLog.warn('match-local-mod: CurseForge search failed', { modName, error: e.message });
        }
      }
      try {
        var encoded = encodeURIComponent(searchName);
        var url4 = 'https://api.modrinth.com/v2/search?query=' + encoded + '&limit=5&index=relevance';
        const res = await fetch(url4, { headers: { 'User-Agent': `BambooLauncher/${app.getVersion()}` } });
        if (res.ok) {
          const data = await res.json();
          const hits = data.hits || [];
          const exact = hits.find(function(h) { return h.title === modName || h.slug === modName.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
          results.modrinth = exact || hits[0] || null;
        }
      } catch (e) {
        shellLog.warn('match-local-mod: Modrinth search failed', { modName, error: e.message });
      }
    }
  }
  return results;
});
