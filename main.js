const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, net, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');
const AdmZip = require('adm-zip');

const { startRPC, setActivity: setDiscordActivity } = require('./src/discordRPC');

const INVITE_PROTOCOL = 'bamboo-launcher';
let pendingDeepLink = null;
const ACTIVE_LAUNCHES = new Map();

const DISCORD_PRESENCE_DEFAULTS = {
  largeImageKey: 'bamboo',
  largeImageText: 'Bamboo Launcher',
};

/** Last activity JSON sent — prevents pointless duplicate RPC calls */
let _lastRpcStatus = '';
let _lastRpcDetails = '';

function updateDiscordPresence(status, profileName, extraText) {
  const now = new Date();

  // Build the activity text based on status
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

  // Deduplicate by checking if either field changed
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

async function scanJavaCandidates() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push({ path: path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), source: 'JAVA_HOME' });
  }
  if (process.platform === 'win32') {
    const winDirs = ['C:\\Program Files\\Java','C:\\Program Files\\Eclipse Adoptium','C:\\Program Files\\Microsoft','C:\\Program Files\\BellSoft','C:\\Program Files\\Azul Systems','C:\\Program Files\\Amazon Corretto','C:\\Program Files\\Semeru','C:\\Program Files\\Liberica','C:\\Program Files\\ojdkbuild','C:\\Program Files\\Zulu','C:\\Program Files\\OpenJDK'];
    for (const dir of winDirs) {
      if (fs.existsSync(dir)) {
        const subs = fs.readdirSync(dir);
        for (const sub of subs) {
          const javaExe = path.join(dir, sub, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) candidates.push({ path: javaExe, source: dir });
        }
      }
    }
    try {
      const result = execSync('where java', { encoding: 'utf8', timeout: 3000 }).trim();
      result.split('\n').forEach(p => candidates.push({ path: p.trim(), source: 'PATH' }));
    } catch (_) {}
  } else {
    const unixPaths = ['/usr/bin/java','/usr/lib/jvm/java-21-openjdk-amd64/bin/java','/usr/lib/jvm/java-17-openjdk-amd64/bin/java','/opt/homebrew/bin/java'];
    unixPaths.forEach(p => candidates.push({ path: p, source: 'default' }));
    try {
      const result = execSync('which java', { encoding: 'utf8', timeout: 3000 }).trim();
      if (result) candidates.push({ path: result, source: 'PATH' });
    } catch (_) {}
  }
  const withVersion = [];
  for (const c of candidates) {
    if (c.path && fs.existsSync(c.path)) {
      try {
        const verOut = execSync(`"${c.path}" -version 2>&1`, { encoding: 'utf8', timeout: 3000 });
        const m = verOut.match(/(?:openjdk|java|hotspot|jre)\s+version\s+"([^"]+)"/i) || verOut.match(/"(\d+)\.\d+\.\d+"/);
        const verStr = m ? m[1] : '';
        const major = parseInt(verStr.split('.')[0]) || 0;
        withVersion.push({ path: c.path, version: major, verStr });
      } catch (_) { withVersion.push({ path: c.path, version: 0, verStr: '' }); }
    }
  }
  withVersion.sort((a, b) => b.version - a.version);
  return withVersion;
}

async function findAllJavaVersions() {
  const versions = await scanJavaCandidates();
  if (versions.length === 0) return null;
  console.log('Gefundene Java-Versionen:', versions.map(v => `${v.verStr || '?'} at ${v.path}`).join(' | '));
  return versions;
}

// ===== Verbesserte Java-Verwaltung =====
// Mapping von Minecraft-Versionen zu optimalen Java-Versionen
const JAVA_VERSION_MAPPING = {
  // Minecraft 1.8 - 1.12.2 → Java 8
  '1.8': 8, '1.9': 8, '1.10': 8, '1.11': 8, '1.12': 8,
  // Minecraft 1.13 - 1.16 → Java 11 (teilweise kompatibel mit 8, aber besser 11)
  '1.13': 11, '1.14': 11, '1.15': 11, '1.16': 11,
  // Minecraft 1.17 - 1.20 → Java 17
  '1.17': 17, '1.18': 17, '1.19': 17, '1.20': 17,
  // Minecraft 1.21+ → Java 21
  '1.21': 21,
  // Minecraft 26.x (Snapshot) → Java 25
  '26': 25, '26.1': 25, '26.2': 25, '26.3': 25, '26.4': 25, '26.5': 25,
};

// Finde die beste Java-Version für eine Minecraft-Version
function getRecommendedJavaVersionForMc(mcVersion) {
  if (!mcVersion) return 21; // Default: Java 21

  const verStr = String(mcVersion).trim();
  
  // Direkte Übereinstimmung
  if (JAVA_VERSION_MAPPING[verStr]) {
    return JAVA_VERSION_MAPPING[verStr];
  }

  // Versuche Major.Minor zu matchen
  const parts = verStr.split('.');
  if (parts.length >= 2) {
    const majorMinor = `${parts[0]}.${parts[1]}`;
    if (JAVA_VERSION_MAPPING[majorMinor]) {
      return JAVA_VERSION_MAPPING[majorMinor];
    }
  }

  // Fallback: Basierend auf Major-Version
  const major = parseInt(verStr.split('.')[0], 10);
  if (major >= 26) return 25; // Snapshots → Java 25
  if (major === 1) {
    const minor = parseInt(verStr.split('.')[1], 10) || 0;
    if (minor >= 21) return 21;
    if (minor >= 17) return 17;
    if (minor >= 13) return 11;
    return 8;
  }
  
  return 21; // Default
}

// Finde beste Java-Version basierend auf Minecraft-Version
async function selectBestJavaForMcVersion(mcVersion) {
  const recommendedVersion = getRecommendedJavaVersionForMc(mcVersion);
  const availableVersions = await scanJavaCandidates();

  if (availableVersions.length === 0) return null;

  // Suche exakte Übereinstimmung
  let exactMatch = availableVersions.find(v => v.version === recommendedVersion);
  if (exactMatch) {
    console.log(`[Java] MC ${mcVersion} → Java ${recommendedVersion} (exakt) gefunden: ${exactMatch.path}`);
    return exactMatch;
  }

  // Suche kompatible höhere Version
  let higherMatch = availableVersions.find(v => v.version > recommendedVersion && v.version < 100);
  if (higherMatch) {
    console.log(`[Java] MC ${mcVersion} → Java ${recommendedVersion} nicht gefunden, verwende Java ${higherMatch.version}: ${higherMatch.path}`);
    return higherMatch;
  }

  // Fallback: Beste verfügbare
  console.log(`[Java] MC ${mcVersion} → Keine kompatible Java gefunden, verwende beste verfügbare: ${availableVersions[0].path}`);
  return availableVersions[0];
}

async function findJavaPath() {
  const versions = await scanJavaCandidates();
  if (versions.length === 0) return null;
  console.log('Gefundene Java-Versionen:', versions.map(v => `${v.verStr || '?'} at ${v.path}`).join(' | '));
  return versions[0].path;
}

async function findInstallerJavaPath() {
  const candidates = [];
  // Before any scanning: hardcoded paths known to work
  const knownJava21Paths = [
    'C:\\Program Files\\Java\\jdk-21.0.11\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.11-hotspot\\bin\\java.exe',
  ];
  for (const p of knownJava21Paths) {
    if (fs.existsSync(p)) candidates.push({ path: p, source: 'fallback' });
  }
  if (process.env.JAVA_HOME) {
    candidates.push({ path: path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), source: 'JAVA_HOME' });
  }
  if (process.platform === 'win32') {
    const winDirs = ['C:\\Program Files\\Java','C:\\Program Files\\Eclipse Adoptium','C:\\Program Files\\Microsoft','C:\\Program Files\\BellSoft','C:\\Program Files\\Azul Systems','C:\\Program Files\\Amazon Corretto','C:\\Program Files\\Semeru','C:\\Program Files\\Liberica','C:\\Program Files\\ojdkbuild','C:\\Program Files\\Zulu','C:\\Program Files\\OpenJDK'];
    for (const dir of winDirs) {
      if (fs.existsSync(dir)) {
        const subs = fs.readdirSync(dir);
        for (const sub of subs) {
          const javaExe = path.join(dir, sub, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) candidates.push({ path: javaExe, source: dir });
        }
      }
    }
    try {
      const result = execSync('where java', { encoding: 'utf8', timeout: 3000 }).trim();
      result.split('\n').forEach(p => candidates.push({ path: p.trim(), source: 'PATH' }));
    } catch (_) {}
  } else {
    const unixPaths = ['/usr/bin/java','/usr/lib/jvm/java-21-openjdk-amd64/bin/java','/usr/lib/jvm/java-17-openjdk-amd64/bin/java','/opt/homebrew/bin/java'];
    unixPaths.forEach(p => candidates.push({ path: p, source: 'default' }));
    try {
      const result = execSync('which java', { encoding: 'utf8', timeout: 3000 }).trim();
      if (result) candidates.push({ path: result, source: 'PATH' });
    } catch (_) {}
  }
  const withVersion = [];
  for (const c of candidates) {
    if (c.path && fs.existsSync(c.path)) {
      try {
        const verOut = execSync(`"${c.path}" -version 2>&1`, { encoding: 'utf8', timeout: 3000 });
        const m = verOut.match(/(?:openjdk|java|hotspot|jre)\s+version\s+"([^"]+)"/i) || verOut.match(/"(\d+)\.\d+\.\d+"/);
        const verStr = m ? m[1] : '';
        const major = parseInt(verStr.split('.')[0]) || 0;
        withVersion.push({ path: c.path, version: major, verStr });
      } catch (_) { withVersion.push({ path: c.path, version: 0, verStr: '' }); }
    }
  }
  // Prefer Java 17-21 for installer compatibility, avoid Java 25+
  withVersion.sort((a, b) => {
    const aScore = (a.version >= 17 && a.version < 25) ? a.version + 100 : (a.version >= 25 ? 0 : a.version);
    const bScore = (b.version >= 17 && b.version < 25) ? b.version + 100 : (b.version >= 25 ? 0 : b.version);
    return bScore - aScore;
  });
  console.log('Installer Java-Auswahl:', withVersion.map(v => `${v.verStr || '?'} (Score: ${v.version >= 17 && v.version < 25 ? v.version + 100 : v.version >= 25 ? 0 : v.version}) at ${v.path}`).join(' | '));
  return withVersion.length > 0 ? withVersion[0].path : null;
}

function mcVersionNum(ver) {
  const parts = String(ver || '').split('.').map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

// Minecraft key code → Minecraft options.txt format
// Frontend liefert: W, A, SPACE, LEFT_SHIFT, MOUSE_BUTTON_1, F5 usw.
// options.txt erwartet: key.keyboard.w, key.keyboard.space, key.keyboard.left.shift, key.mouse.left, key.keyboard.f5
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

// Approximative Data Version für MC-Version
// Siehe https://minecraft.wiki/w/Data_version
function getDataVersion(ver) {
  const parts = String(ver || '').split('.').map(Number);
  const major = parts[0] || 0, minor = parts[1] || 0, patch = parts[2] || 0;
  // 26.x series
  if (major === 26) {
    if (minor >= 2) return 5200;
    if (minor >= 1) {
      if (patch >= 2) return 5100; if (patch >= 1) return 5050;
      return 5000;
    }
  }
  if (major === 1) {
    // 1.21.x series
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

  // === VERSION (CRITICAL) ===
  // "If this field is missing, the file is discarded and replaced with the defaults."
  const dataVersion = getDataVersion(options._mcVersion || '1.21');
  if (dataVersion > 0) lines.push('version:' + dataVersion);

  // ===================== VIDEO =====================
  // FOV: degrees = 40 * value + 70 → value = (degrees - 70) / 40
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

  // Gamma: 0-100 → 0.0-1.0
  lines.push('gamma:' + (clamp(safeNum(options.gamma, 50), 0, 100) / 100).toFixed(1));

  // ao: boolean or string
  lines.push('ao:' + (bool(options.ao) ? 'true' : 'false'));

  // particles: 0=All, 1=Decreased, 2=Minimal
  lines.push('particles:' + clamp(safeNum(options.particles, 0), 0, 2));

  lines.push('mipmapLevels:' + clamp(safeNum(options.mipmapLevels, 4), 0, 4));

  if (mcVer >= 11300) lines.push('biomeBlendRadius:' + clamp(safeNum(options.biomeBlendRadius, 2), 0, 7));

  // entityShadows
  lines.push('entityShadows:' + (bool(options.entityShadows !== false) ? 'true' : 'false'));

  // fovEffectScale
  const fovScale = clamp(safeNum(options.fovEffectScale, 100), 0, 100);
  lines.push('fovEffectScale:' + (fovScale / 100).toFixed(2));

  // darknessEffectScale
  const darkScale = clamp(safeNum(options.darknessEffectScale, 100), 0, 100);
  lines.push('darknessEffectScale:' + (darkScale / 100).toFixed(2));

  // glintSpeed
  const glintSpd = clamp(safeNum(options.glintSpeed, 50), 0, 100);
  lines.push('glintSpeed:' + (glintSpd / 100).toFixed(2));

  // glintStrength
  const glintStr = clamp(safeNum(options.glintStrength, 75), 0, 100);
  lines.push('glintStrength:' + (glintStr / 100).toFixed(2));

  // graphicsMode → "graphics" key in options.txt (fancy/fast/fabulous)
  const gfx = str(options.graphicsMode, 'fancy').toLowerCase();
  lines.push('graphics:' + (gfx === 'fast' ? 'fast' : (gfx === 'fabulous' ? 'fabulous' : 'fancy')));

  // prioritizeChunkUpdates: 0=default, 1=player, 2=near
  if (mcVer >= 11800) {
    lines.push('prioritizeChunkUpdates:' + clamp(safeNum(options.prioritizeChunkUpdates, 0), 0, 2));
  }

  // improvedTransparency
  if (mcVer >= 11700) {
    lines.push('improvedTransparency:' + (bool(options.improvedTransparency) ? 'true' : 'false'));
  }

  // inactivityFpsLimit
  const fpsLim = str(options.inactivityFpsLimit, 'minimized');
  lines.push('inactivityFpsLimit:' + fpsLim);

  // renderClouds / cloudRange
  lines.push('renderClouds:' + (bool(options.renderClouds !== false) ? 'true' : 'false'));
  lines.push('cloudRange:' + clamp(safeNum(options.cloudRange, 128), 32, 256));

  // screenEffectScale
  const scrEff = clamp(safeNum(options.screenEffectScale, 100), 0, 100);
  lines.push('screenEffectScale:' + (scrEff / 100).toFixed(2));

  // vignette
  lines.push('vignette:' + (bool(options.vignette !== false) ? 'true' : 'false'));

  // weatherRadius
  lines.push('weatherRadius:' + clamp(safeNum(options.weatherRadius, 10), 5, 25));

  // ===================== SOUND =====================
  const soundKeys = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'];
  for (const key of soundKeys) {
    const val = options['soundCategory_' + key];
    lines.push('soundCategory_' + key + ':' + ((val !== undefined ? clamp(safeNum(val, 100), 0, 100) : 100) / 100).toFixed(1));
  }

  lines.push('showSubtitles:' + (bool(options.showSubtitles) ? 'true' : 'false'));

  if (mcVer >= 11900) lines.push('directionalAudio:' + (bool(options.directionalAudio !== false) ? 'true' : 'false'));

  // musicToast: String (never/pause/pause_and_toast), kein Boolean!
  if (mcVer >= 12000) {
    // Wenn showMusicToast true = Toasts anzeigen → pause_and_toast
    lines.push('musicToast:' + (bool(options.showMusicToast) ? 'pause_and_toast' : 'never'));
  }

  // musicFrequency: String (DEFAULT/FREQUENT/CONSTANT), kein Float!
  if (mcVer >= 12000) {
    const freqMap = { standard: 'DEFAULT', haeufig: 'FREQUENT', konstant: 'CONSTANT' };
    lines.push('musicFrequency:' + (freqMap[options.musicFrequency] || 'DEFAULT'));
  }

  // ===================== LANGUAGE =====================
  const lang = (options.lang && String(options.lang).trim()) || 'en_us';
  lines.push('lang:' + lang);

  // forceUnicodeFont
  if (mcVer >= 11300) {
    lines.push('forceUnicodeFont:' + (bool(options.forceUnicodeFont) ? 'true' : 'false'));
  }

  // ===================== ACCESSIBILITY =====================
  lines.push('narrator:' + clamp(safeNum(options.narrator, 0), 0, 3));
  lines.push('narratorHotKey:' + (bool(options.narratorHotKey !== false) ? 'true' : 'false'));
  lines.push('onboardAccessibility:' + (bool(options.onboardAccessibility) ? 'true' : 'false'));

  // highContrast / highContrastBlockOutline
  lines.push('highContrast:' + (bool(options.highContrast) ? 'true' : 'false'));
  lines.push('highContrastBlockOutline:' + (bool(options.highContrastBlockOutline) ? 'true' : 'false'));

  // damageTiltStrength: 0-100 → 0.0-1.0
  const dmgTilt = clamp(safeNum(options.damageTiltStrength, 100), 0, 100);
  lines.push('damageTiltStrength:' + (dmgTilt / 100).toFixed(2));

  // menuBackgroundBlurriness: 0-10
  if (mcVer >= 12000) {
    lines.push('menuBackgroundBlurriness:' + clamp(safeNum(options.menuBackgroundBlurriness, 0), 0, 10));
  }

  // ===================== CONTROLS =====================
  lines.push('autoJump:' + (bool(options.autoJump) ? 'true' : 'false'));

  // mouseSensitivity: 0-100 → 0.0-1.0
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

  // mouseWheelSensitivity
  lines.push('mouseWheelSensitivity:' + clamp(safeNum(options.mouseWheelSensitivity, 100), 1, 100));
  lines.push('discreteMouseScroll:' + (bool(options.discreteMouseScroll) ? 'true' : 'false'));
  lines.push('rawMouseInput:' + (bool(options.rawMouseInput !== false) ? 'true' : 'false'));
  lines.push('bobView:' + (bool(options.bobView !== false) ? 'true' : 'false'));
  lines.push('rotateWithMinecart:' + (bool(options.rotateWithMinecart) ? 'true' : 'false'));

  // mainHand
  const hand = str(options.mainHand, 'right').toLowerCase();
  lines.push('mainHand:' + (hand === 'left' ? 'left' : 'right'));

  // sprintWindow (1.20+)
  if (mcVer >= 12000) {
    lines.push('sprintWindow:' + clamp(safeNum(options.sprintWindow, 7), 0, 20));
  }

  // attackIndicator: 0=off, 1=crosshair, 2=hotbar
  lines.push('attackIndicator:' + clamp(safeNum(options.attackIndicator, 1), 0, 2));

  // ===================== CHAT =====================
  // chatVisibility: 0=shown, 1=commands only, 2=hidden
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

  // ===================== MISC =====================
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

  // ===================== KEY BINDINGS =====================
  if (options.keyBindings && typeof options.keyBindings === 'object') {
    for (const [keyName, keyCode] of Object.entries(options.keyBindings)) {
      if (keyCode) lines.push('key_' + keyName + ':' + convertKeyCode(keyCode));
    }
  }

  const result = lines.join('\r\n') + '\r\n';
  console.log('[buildOptionsTxt] options.txt für ' + (options._mcVersion || '?') + ' (dataVersion=' + dataVersion + '):');
  console.log('[buildOptionsTxt] ---BEGIN---');
  console.log(result);
  console.log('[buildOptionsTxt] ---END---');
  return result;
}

ipcMain.handle('write-options-txt', async (_event, { folderName, options }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  const optionsPath = path.join(gameDir, 'options.txt');
  const content = buildOptionsTxt(options);
  fs.writeFileSync(optionsPath, content, 'utf8');
  console.log('[write-options-txt] Geschrieben nach: ' + optionsPath);
});

// --- Window Controls ---
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('find-java', async () => {
  return await findJavaPath();
});

let javaCache = null;
ipcMain.handle('get-java-versions', async (_event, forceRescan) => {
  if (forceRescan || !javaCache) {
    javaCache = await findAllJavaVersions();
  }
  return javaCache;
});

// Neue IPC-Handler für verbesserte Java-Verwaltung
ipcMain.handle('get-recommended-java-for-mc', async (_event, mcVersion) => {
  const javaVersion = getRecommendedJavaVersionForMc(mcVersion);
  const candidates = await scanJavaCandidates();
  const selected = await selectBestJavaForMcVersion(mcVersion);
  return {
    recommended: javaVersion,
    selected: selected,
    available: candidates,
  };
});

ipcMain.handle('find-best-java-for-mc', async (_event, mcVersion) => {
  const result = await selectBestJavaForMcVersion(mcVersion);
  return result;
});

// --- Profile Ordner öffnen (Welten: saves Unterordner) ---
ipcMain.handle('open-profile-folder', async (_event, folderName) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName, 'saves');
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }
  shell.openPath(gameDir);
});

// --- Instanzordner öffnen (Root des Profils) ---
ipcMain.handle('open-instance-folder', async (_event, folderName) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }
  shell.openPath(gameDir);
});

ipcMain.handle('delete-profile-files', async (_event, folderName) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (fs.existsSync(gameDir)) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    console.log(`Profil-Ordner gelöscht: ${gameDir}`);
  }
  // Also delete associated screenshots (named with instance prefix)
  const screenshotsDir = path.join(rootPath, 'screenshots');
  if (fs.existsSync(screenshotsDir)) {
    const prefix = folderName + '__';
    const files = fs.readdirSync(screenshotsDir);
    let deletedCount = 0;
    for (const file of files) {
      if (file.startsWith(prefix)) {
        try {
          fs.unlinkSync(path.join(screenshotsDir, file));
          deletedCount++;
        } catch (e) {
          console.warn(`[delete-profile-files] Could not delete screenshot ${file}: ${e.message}`);
        }
      }
    }
    if (deletedCount > 0) {
      console.log(`[delete-profile-files] ${deletedCount} Screenshots für '${folderName}' gelöscht`);
    }
  }
});

async function downloadVanillaJar(rootPath, mcVersion) {
  const verDir = path.join(rootPath, 'versions', mcVersion);
  const jarFile = path.join(verDir, `${mcVersion}.jar`);
  const verFile = path.join(verDir, `${mcVersion}.json`);
  if (!fs.existsSync(verFile)) throw new Error(`Version-JSON für ${mcVersion} fehlt`);
  if (fs.existsSync(jarFile)) return;
  console.log(`Lade Vanilla-JAR ${mcVersion} von Mojang herunter...`);
  const verMeta = JSON.parse(fs.readFileSync(verFile, 'utf8'));
  const jarUrl = verMeta.downloads?.client?.url;
  if (!jarUrl) throw new Error(`Kein client-JAR in Version ${mcVersion} gefunden`);
  const res = await fetch(jarUrl);
  if (!res.ok) throw new Error(`JAR-Download fehlgeschlagen (${res.status})`);
  fs.writeFileSync(jarFile, Buffer.from(await res.arrayBuffer()));
  console.log(`Vanilla-JAR ${mcVersion} heruntergeladen (${(fs.statSync(jarFile).size / 1024 / 1024).toFixed(1)} MB)`);
}

async function downloadLibraryByPath(rootPath, libPath, directUrl, expectedSize) {
  const targetFile = path.join(rootPath, 'libraries', libPath);
  // Prüfe ob Datei bereits existiert und korrekt ist
  if (fs.existsSync(targetFile)) {
    if (expectedSize > 0) {
      const actualSize = fs.statSync(targetFile).size;
      if (actualSize === expectedSize) return;
      console.warn(`Library ${libPath} hat falsche Grösse (${actualSize} statt ${expectedSize}), lade neu...`);
    } else {
      return; // Keine Grössenangabe -> existierende Datei akzeptieren
    }
  }
  const targetDir = path.dirname(targetFile);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  // Direkte URL bevorzugen (aus version.json)
  if (directUrl) {
    try {
      const res = await fetch(directUrl);
      if (res.ok) {
        fs.writeFileSync(targetFile, Buffer.from(await res.arrayBuffer()));
        console.log(`Library geladen (direkt): ${libPath}`);
        return;
      }
      console.warn(`Direkter Download fehlgeschlagen für ${directUrl}, versuche Maven...`);
    } catch (e) {
      console.warn(`Direkter Download-Fehler: ${e.message}`);
    }
  }
  // Fallback: Maven-URL aus Pfad konstruieren
  const parts = libPath.replace(/\\/g, '/').split('/');
  const archiveName = parts.pop();
  const versionDir = parts.pop();
  const artifactDir = parts.pop();
  const groupPath = parts.join('.');
  const archiveParts = archiveName.split('@');
  const jarName = archiveParts[0];
  const ext = archiveParts[1] || 'jar';
  const mavenUrls = [
    `https://maven.neoforged.net/releases/${groupPath.replace(/\./g, '/')}/${artifactDir}/${versionDir}/${jarName}.${ext}`,
    `https://repo1.maven.org/maven2/${groupPath.replace(/\./g, '/')}/${artifactDir}/${versionDir}/${jarName}.${ext}`,
    `https://files.minecraftforge.net/maven/${groupPath.replace(/\./g, '/')}/${artifactDir}/${versionDir}/${jarName}.${ext}`,
  ];
  for (const url of mavenUrls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        fs.writeFileSync(targetFile, Buffer.from(await res.arrayBuffer()));
        console.log(`Library geladen (Maven): ${libPath}`);
        return;
      }
    } catch (_) {}
  }
  console.warn(`Library nicht gefunden: ${libPath}`);
}

async function downloadProfileLibraries(rootPath, versionId, sendProgress) {
  const verFile = path.join(rootPath, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(verFile)) return;
  const data = JSON.parse(fs.readFileSync(verFile, 'utf8'));
  const libs = data.libraries || [];
  for (let i = 0; i < libs.length; i++) {
    const lib = libs[i];
    if (lib.rule && lib.rule.os && lib.rule.os.name === 'osx') continue;
    const artifact = lib.downloads?.artifact;
    const libPath = artifact?.path || (() => {
      const parts = lib.name.split(':');
      const group = parts[0].replace(/\./g, '/');
      const artifactName = parts[1];
      const ver = parts[2] || '';
      const ext = parts[3] || 'jar';
      return `${group}/${artifactName}/${ver}/${artifactName}-${ver}.${ext}`;
    })();
    if (libPath) {
      await downloadLibraryByPath(rootPath, libPath, artifact?.url, artifact?.size || 0);
    }
    if (i % 10 === 0 && sendProgress) {
      sendProgress(`Bibliotheken: ${i + 1}/${libs.length}`);
    }
  }
}

ipcMain.handle('repair-profile', async (event, { loader, loaderVersion, mcVersion, folderName }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const normalizedLoader = String(loader || '').toLowerCase();
  const gameDir = path.join(rootPath, 'profiles', folderName || 'default');

  function sendProgress(msg) {
    event.sender.send('repair-progress', msg);
  }

  sendProgress('Starte Reparatur...');

  // 1. Loader-Version-ID bestimmen
  let loaderVersionId = '';
  let libDir = '';
  if (normalizedLoader === 'forge') {
    loaderVersionId = `${mcVersion}-forge-${loaderVersion}`;
    libDir = 'net/minecraftforge';
  } else if (normalizedLoader === 'neoforge') {
    loaderVersionId = `neoforge-${loaderVersion}`;
    libDir = 'net/neoforged';
  } else if (normalizedLoader === 'fabric') {
    loaderVersionId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  }

  // 2. Vanilla-Version + JAR löschen und neu laden
  sendProgress('Lösche alte Vanilla-Dateien...');
  const vanillaVerDir = path.join(rootPath, 'versions', mcVersion);
  if (fs.existsSync(vanillaVerDir)) {
    fs.rmSync(vanillaVerDir, { recursive: true, force: true });
    console.log(`Vanilla-Version gelöscht: ${vanillaVerDir}`);
  }

  sendProgress('Lade Vanilla-Version von Mojang herunter...');
  await ensureVanillaVersion(rootPath, mcVersion);
  await downloadVanillaJar(rootPath, mcVersion);

  // 3. Loader-Version + Libraries löschen
  if (loaderVersionId) {
    sendProgress(`Lösche ${normalizedLoader}-Version...`);
    const verDir = path.join(rootPath, 'versions', loaderVersionId);
    if (fs.existsSync(verDir)) {
      fs.rmSync(verDir, { recursive: true, force: true });
      console.log(`Loader-Version gelöscht: ${verDir}`);
    }
  }
  if (libDir) {
    sendProgress(`Lösche ${normalizedLoader}-Libraries...`);
    const libPath = path.join(rootPath, 'libraries', libDir);
    if (fs.existsSync(libPath)) {
      fs.rmSync(libPath, { recursive: true, force: true });
      console.log(`Loader-Libraries gelöscht: ${libPath}`);
    }
  }

  // 4. Loader neu installieren (via JAR-Extraktion, kein --installClient)
  if (normalizedLoader !== 'vanilla' && loaderVersion) {
    sendProgress(`Installiere ${normalizedLoader} ${loaderVersion} neu...`);
    if (normalizedLoader === 'forge') {
      await installForgeLoaderClean(rootPath, null, mcVersion, loaderVersion, sendProgress);
    } else if (normalizedLoader === 'neoforge') {
      await installNeoforgeLoaderClean(rootPath, null, mcVersion, loaderVersion, sendProgress);
    } else if (normalizedLoader === 'fabric') {
      await installModloader(rootPath, mcVersion, normalizedLoader, loaderVersion);
    }
  }

  // 5. Loader-Libraries von Servern herunterladen (falls im version JSON referenziert)
  if (loaderVersionId) {
    sendProgress('Lade Loader-Bibliotheken von Maven...');
    await downloadProfileLibraries(rootPath, loaderVersionId, sendProgress);
  }

  sendProgress('Reparatur abgeschlossen!');
  console.log(`Reparatur abgeschlossen für ${normalizedLoader} ${loaderVersion} (${mcVersion})`);
  return true;
});

ipcMain.handle('complete-reinstall', async (event, { profiles }) => {
  const rootPath = 'C:\\BambooLaufwerk';

  function sendProgress(msg) {
    event.sender.send('reinstall-progress', msg);
  }

  // 1. ALLE Versionen, Libraries, Assets, Natives löschen
  sendProgress('Lösche alle Versionen...');
  const versionsDir = path.join(rootPath, 'versions');
  if (fs.existsSync(versionsDir)) fs.rmSync(versionsDir, { recursive: true, force: true });

  sendProgress('Lösche alle Libraries...');
  const libsDir = path.join(rootPath, 'libraries');
  if (fs.existsSync(libsDir)) fs.rmSync(libsDir, { recursive: true, force: true });

  sendProgress('Lösche Assets...');
  const assetsDir = path.join(rootPath, 'assets');
  if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true });

  sendProgress('Lösche Natives...');
  const nativesDir = path.join(rootPath, 'natives');
  if (fs.existsSync(nativesDir)) fs.rmSync(nativesDir, { recursive: true, force: true });

  // 2. Für jedes Profil neu aufbauen
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (!p || !p.version) continue;
    sendProgress(`[${i + 1}/${profiles.length}] ${p.name}: Vanilla-Version...`);
    await ensureVanillaVersion(rootPath, p.version);
    await downloadVanillaJar(rootPath, p.version);

    if (p.loader && p.loader !== 'Vanilla' && p.loaderVersion) {
      const normLoader = String(p.loader).toLowerCase();
      sendProgress(`[${i + 1}/${profiles.length}] ${p.name}: Installiere ${normLoader} ${p.loaderVersion}...`);
      try {
        if (normLoader === 'forge') {
          const finalId = await installForgeLoaderClean(rootPath, null, p.version, p.loaderVersion, sendProgress);
          await downloadProfileLibraries(rootPath, finalId, sendProgress);
        } else if (normLoader === 'neoforge') {
          const finalId = await installNeoforgeLoaderClean(rootPath, null, p.version, p.loaderVersion, sendProgress);
          await downloadProfileLibraries(rootPath, finalId, sendProgress);
        } else if (normLoader === 'fabric') {
          await installModloader(rootPath, p.version, normLoader, p.loaderVersion);
        }
      } catch (e) {
        console.warn(`Loader-Installation fehlgeschlagen für ${p.name}:`, e.message);
        sendProgress(`[${i + 1}/${profiles.length}] ${p.name}: Fehler bei ${normLoader} - ${e.message}`);
      }
    }
  }

  sendProgress('Neuinstallation abgeschlossen!');
  return true;
});

// --- Settings Persistenz ---
ipcMain.handle('get-settings', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
  const settingsPath = path.join(rootPath, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) { return null; }
  }
  return null;
});


// ===== Player Identity (for Cosmetics / Skin Viewer) =====
ipcMain.handle('get-player-identity', async () => {
  const rootPath = 'C:BambooLaufwerk';
  const settingsPath = path.join(rootPath, 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const accounts = settings.accounts || [];
    const active = accounts.find(a => a.active) || accounts[0];
    if (!active) return null;
    return {
      uuid: active.uuid || null,
      username: active.name || active.username || null,
      type: active.type || 'offline',
    };
  } catch (_) {
    return null;
  }
});

ipcMain.handle('save-settings', async (_event, settings) => {
  const rootPath = 'C:\\BambooLaufwerk';
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'settings.json'), JSON.stringify(settings, null, 2));
  return true;
});

// ===== CURSEFORGE API (Backend, kein CORS/Rate-Limit) =====
// API-Key hier eintragen: https://console.curseforge.com/
const CURSEFORGE_API_KEY = '$2a$10$s45iJ2QFz7VP7Ri35ZTjo.fdwq4QVHTD/RYmbf00SNIhHrP2OZjJm';

const CF_HEADERS = {
  'Accept': 'application/json',
  'x-api-key': CURSEFORGE_API_KEY,
};

const CF_CLASS_IDS = {
  mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, datapack: 6945, worlds: 17,
};

function cfLoaderTypeToNum(loader) {
  const map = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
  return map[String(loader).toLowerCase()] ?? undefined;
}

ipcMain.handle('curseforge-search', async (_event, { query, sortBy = '6', modFilter, gameVersion, modLoaderType, index = 0, pageSize = 20 }) => {
  if (!CURSEFORGE_API_KEY) return { error: 'Kein CurseForge API-Key gesetzt' };
  const gameId = 432;
  const classId = CF_CLASS_IDS[modFilter] || (modFilter ? 6 : undefined);
  const params = new URLSearchParams({ gameId, pageSize: String(pageSize) });
  if (classId) params.set('classId', String(classId));
  if (query) params.set('searchFilter', query);
  if (sortBy) params.set('sortField', sortBy);
  params.set('sortOrder', 'desc');
  if (index > 0) params.set('index', String(index));
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (modLoaderType !== undefined && modLoaderType !== null) params.set('modLoaderType', String(modLoaderType));
  try {
    const res = await fetch(`https://api.curseforge.com/v1/mods/search?${params.toString()}`, { headers: CF_HEADERS });
    if (!res.ok) return { error: `CurseForge API-Fehler: ${res.status}` };
    const data = await res.json();
    return { data: data.data || [], pagination: data.pagination || { totalCount: 0 } };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('curseforge-project', async (_event, modId) => {
  if (!CURSEFORGE_API_KEY) return { error: 'Kein CurseForge API-Key gesetzt' };
  try {
    const [modRes, descRes] = await Promise.all([
      fetch(`https://api.curseforge.com/v1/mods/${modId}`, { headers: CF_HEADERS }),
      fetch(`https://api.curseforge.com/v1/mods/${modId}/description`, { headers: CF_HEADERS }),
    ]);
    if (!modRes.ok) return { error: `Modul ${modRes.status}` };
    const modData = (await modRes.json()).data;
    let description = '';
    if (descRes.ok) {
      const descData = await descRes.json();
      description = descData.data?.body || '';
    }
    return { ...modData, description };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('curseforge-files', async (_event, modId, gameVersion, modLoaderType) => {
  if (!CURSEFORGE_API_KEY) return { error: 'Kein CurseForge API-Key gesetzt' };
  try {
    let url = `https://api.curseforge.com/v1/mods/${modId}/files?pageSize=50&sortField=2&sortOrder=desc`;
    if (gameVersion) url += `&gameVersion=${encodeURIComponent(gameVersion)}`;
    if (modLoaderType !== undefined && modLoaderType !== null) url += `&modLoaderType=${modLoaderType}`;
    const res = await fetch(url, { headers: CF_HEADERS });
    if (!res.ok) return { error: `Files ${res.status}` };
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    return { error: err.message };
  }
});

// — Dynamische Loader-Versionen von Maven-Metadaten —
let forgeVersionsCache = null;
let neoforgeVersionsCache = null;

ipcMain.handle('get-forge-versions', async () => {
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
    console.error('Forge-Versionen konnten nicht geladen werden:', err.message);
    return null;
  }
});

ipcMain.handle('get-neoforge-versions', async () => {
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
    console.error('NeoForge-Versionen konnten nicht geladen werden:', err.message);
    return null;
  }
});

ipcMain.handle('get-profiles', async () => {
  const rootPath = 'C:\\BambooLaufwerk';

  // Versuche profiles.json im Hauptordner
  const profilesPath = path.join(rootPath, 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    try { return JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (_) { return []; }
  }

  // Versuche profiles.json im profiles/ Unterordner
  const profilesSubPath = path.join(rootPath, 'profiles', 'profiles.json');
  if (fs.existsSync(profilesSubPath)) {
    try { return JSON.parse(fs.readFileSync(profilesSubPath, 'utf8')); } catch (_) { return []; }
  }

  // Versuche einzelne .json-Dateien pro Profil im profiles/-Ordner
  const profilesDir = path.join(rootPath, 'profiles');
  if (fs.existsSync(profilesDir) && fs.statSync(profilesDir).isDirectory()) {
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && f !== 'profiles.json');
    if (files.length > 0) {
      const result = [];
      for (const f of files) {
        try { result.push(JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf8'))); } catch (_) {}
      }
      if (result.length > 0) return result;
    }
  }

  return null;
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

ipcMain.handle('save-profiles', async (_event, profiles) => {
  const rootPath = 'C:\\BambooLaufwerk';
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  const enriched = profiles.map(p => {
    const folderName = String(p.name || p.id || '').toLowerCase().replace(/\s+/g, '-');
    const dirPath = path.join(rootPath, 'profiles', folderName);
    const bytes = getFolderSize(dirPath);
    return { ...p, size: formatSize(bytes) || '0 B' };
  });
  fs.writeFileSync(path.join(rootPath, 'profiles.json'), JSON.stringify(enriched, null, 2));
  return true;
});

ipcMain.handle('get-collections', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
  const collectionsPath = path.join(rootPath, 'collections.json');
  if (fs.existsSync(collectionsPath)) {
    try { return JSON.parse(fs.readFileSync(collectionsPath, 'utf8')); } catch (_) { return []; }
  }
  return [];
});

ipcMain.handle('save-collections', async (_event, collections) => {
  const rootPath = 'C:\\BambooLaufwerk';
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'collections.json'), JSON.stringify(collections, null, 2));
  return true;
});

// Lese SystemIcons als base64 — fürs Preload (sync IPC)
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
    console.log(`[main] SystemIcons geladen (${Object.keys(__sysIcons).length}):`, Object.keys(__sysIcons).join(', '));
  } else {
    console.warn('[main] SystemIcons-Verzeichnis nicht gefunden');
  }
} catch (e) {
  console.error('[main] SystemIcons-Fehler:', e);
}

ipcMain.on('get-icons', (event) => {
  event.returnValue = __sysIcons;
});

// ===== Dialog-Handler für Export/Import =====
ipcMain.handle('show-open-dialog', async (_event, options) => {
  return dialog.showOpenDialog(options);
});

ipcMain.handle('show-save-dialog', async (_event, options) => {
  return dialog.showSaveDialog(options);
});

// ===== Server Ping (Backend, kein CORS) =====
ipcMain.handle('ping-server', async (_event, serverIp) => {
  const startTime = Date.now();
  try {
    const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(serverIp)}`;
    const res = await net.fetch(url);
    const duration = Date.now() - startTime;
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
  } catch (e) {
    return { online: false, ping: 999, error: e.message };
  }
});

// ===== Image File Reader (gibt Data-URL zurück, um file:// Block zu umgehen) =====
// ===== Neue IPC-Handler für Profile Export/Import (Phase 11) =====
ipcMain.handle('read-file-as-base64', async (_event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return data.toString('base64');
  } catch (e) {
    console.error('[read-file-as-base64] Fehler:', e.message);
    return null;
  }
});


// ===== Save cosmetic files to disk (BambooLaufwerk/cosmetics/{slug}/) =====
ipcMain.handle('save-cosmetic-files', async (_event, { slug, files }) => {
  try {
    var rootPath = 'C:\\BambooLaufwerk';
    var cosmeticDir = path.join(rootPath, 'cosmetics', slug);
    console.log('[cosmetics] save-cosmetic-files: target dir =', cosmeticDir);
    console.log('[cosmetics] save-cosmetic-files: slug =', slug, ', files count =', (files || []).length);
    if (!fs.existsSync(cosmeticDir)) fs.mkdirSync(cosmeticDir, { recursive: true });
    var savedFiles = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f.fileName || !f.data) continue;
      var filePath = path.join(cosmeticDir, f.fileName);
      // Ensure subdirectories exist (e.g. textures/subfolder/)
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(f.data));
      savedFiles.push(f.fileName);
      console.log('[cosmetics] Saved:', filePath);
    }
    // Write enhanced manifest with model/texture file info
    var modelFile = null;
    var textureFiles = [];
    for (var fi = 0; fi < files.length; fi++) {
      var ftype = files[fi].fileType || "other";
      if (ftype === "model" && !modelFile) modelFile = files[fi].fileName;
      if (ftype === "texture" || ftype === "icon") textureFiles.push(files[fi].fileName);
    }
    // Fallback: if no model file detected by type, use first .json that isnt manifest.json
    if (!modelFile) {
      for (var sj = 0; sj < savedFiles.length; sj++) {
        if (savedFiles[sj].toLowerCase().endsWith(".json") && savedFiles[sj] !== "manifest.json") {
          modelFile = savedFiles[sj]; break;
        }
      }
    }
    // Fallback for textures: any .png files not already in textureFiles
    if (textureFiles.length === 0) {
      for (var sk = 0; sk < savedFiles.length; sk++) {
        if (savedFiles[sk].toLowerCase().endsWith(".png")) textureFiles.push(savedFiles[sk]);
      }
    }
    var manifest = {
      slug: slug,
      installedAt: Date.now(),
      fileCount: savedFiles.length,
      files: savedFiles,
      modelFile: modelFile,
      textureFiles: textureFiles,
    };
    fs.writeFileSync(path.join(cosmeticDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('[cosmetics] Manifest written for:', slug);
    console.log('[cosmetics] Manifest — modelFile:', modelFile, ', textureFiles:', JSON.stringify(textureFiles));
    console.log('[cosmetics] save-cosmetic-files: SUCCESS — saved', savedFiles.length, 'files to', cosmeticDir);
    // Verify files actually exist on disk
    if (fs.existsSync(cosmeticDir)) {
      var diskFiles = fs.readdirSync(cosmeticDir);
      console.log("[cosmetics] save-cosmetic-files: VERIFY — disk contents:", JSON.stringify(diskFiles));
      for (var vi = 0; vi < savedFiles.length; vi++) {
        var vf = path.join(cosmeticDir, savedFiles[vi]);
        console.log("[cosmetics] save-cosmetic-files: " + (fs.existsSync(vf) ? "✔" : "✖") + " " + savedFiles[vi]);
      }
    } else {
      console.log("[cosmetics] save-cosmetic-files: ✖ VERIFY FAILED — directory does not exist");
    }
    return { success: true, path: cosmeticDir, fileCount: savedFiles.length };
  } catch (e) {
    console.error('[cosmetics] Save error:', e.message);
    return { success: false, error: e.message };
  }
});
// ===== Read cosmetic files from disk (BambooLaufwerk/cosmetics/{slug}/) =====
ipcMain.handle('read-cosmetic-file', async (_event, filePath) => {
  var rootPath = 'C:\\BambooLaufwerk';
  try {
    if (!filePath) return { success: false, error: 'No file path provided' };
    var fullPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
    console.log('[cosmetics] read-cosmetic-file: requested =', filePath, ', resolved =', fullPath);
    if (!fs.existsSync(fullPath)) {
      console.log('[cosmetics] read-cosmetic-file: FILE NOT FOUND —', fullPath);
      return { success: false, error: 'File not found: ' + fullPath };
    }
    console.log('[cosmetics] read-cosmetic-file: FILE FOUND —', fullPath);
    var ext = path.extname(fullPath).toLowerCase();
    if (ext === '.json') {
      var content = fs.readFileSync(fullPath, 'utf-8');
      return { success: true, data: content, type: 'json' };
    }
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
      var raw = fs.readFileSync(fullPath);
      var mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      var mimeType = mime[ext] || 'image/png';
      var base64 = raw.toString('base64');
      return { success: true, data: 'data:' + mimeType + ';base64,' + base64, type: 'image' };
    }
    // Default: read as text
    var content = fs.readFileSync(fullPath, 'utf-8');
    return { success: true, data: content, type: 'text' };
  } catch (e) {
    console.error('[cosmetics] Read error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-temp-file', async (_event, { data, fileName }) => {
  try {
    const rootPath = 'C:\\BambooLaufwerk';
    const tempDir = path.join(rootPath, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const safeName = (fileName || 'temp.zip').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tempDir, `${Date.now()}-${safeName}`);
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
    console.log('[save-temp-file] Saved:', filePath);
    return filePath;
  } catch (e) {
    console.error('[save-temp-file] Fehler:', e.message);
    return null;
  }
});

ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  } catch (e) {
    console.error('[show-item-in-folder] Fehler:', e.message);
  }
});

// ===== Existing image reader =====
ipcMain.handle('read-image-file', async (_event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mime[ext] || 'image/png';
    const base64 = data.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (e) {
    console.error('[read-image-file] Fehler:', e);
    return null;
  }
});

// ===== Rekursive Kopierhilfe =====
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

// ===== PROFIL EXPORT =====
ipcMain.handle('export-profile', async (_event, payload) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const { format, instanceName, folderName, manifest, options, suggestedFileName, savePath } = payload || {};

  if (!manifest || !folderName) {
    return { success: false, error: 'Ungültige Exportdaten: Manifest oder Ordnername fehlt' };
  }

  const tmpDir = path.join(rootPath, 'cache', `export-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // --- Write manifest.json (for .zip) ---
    if (format === 'zip') {
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    // --- Collect content files from the instance folder ---
    const gameDir = path.join(rootPath, 'profiles', folderName);
    const selectedContent = options || {};
    
    // Diagnostics: check if gameDir exists
    const gameDirExists = fs.existsSync(gameDir);
    console.log(`[export-profile] gameDir=${gameDir}, exists=${gameDirExists}, format=${format}, folderName=${folderName}`);
    
    let collectedAnything = false;
    const collectedTypes = [];

    // Helper to collect files from a subdirectory
    function collectDir(srcSubDir, destSubDir) {
      const src = path.join(gameDir, srcSubDir);
      if (fs.existsSync(src)) {
        const files = fs.readdirSync(src).filter(f => {
          const fullPath = path.join(src, f);
          return fs.statSync(fullPath).isFile();
        });
        if (files.length === 0) {
          console.log(`[export-profile] collectDir(${srcSubDir}): directory exists but empty`);
          return false;
        }
        const d = path.join(tmpDir, destSubDir || srcSubDir);
        fs.mkdirSync(d, { recursive: true });
        for (const entry of files) {
          const s = path.join(src, entry);
          fs.copyFileSync(s, path.join(d, entry));
        }
        console.log(`[export-profile] collectDir(${srcSubDir}): ${files.length} files copied`);
        return true;
      }
      console.log(`[export-profile] collectDir(${srcSubDir}): directory NOT found`);
      return false;
    }

    // Collect selected content based on manifest contents
    if (selectedContent.includeMods !== false && collectDir('mods', 'mods')) { collectedAnything = true; collectedTypes.push('mods'); }
    if (selectedContent.includeResourcepacks !== false && collectDir('resourcepacks', 'resourcepacks')) { collectedAnything = true; collectedTypes.push('resourcepacks'); }
    if (selectedContent.includeShaderpacks !== false && collectDir('shaderpacks', 'shaderpacks')) { collectedAnything = true; collectedTypes.push('shaderpacks'); }
    if (selectedContent.includeDatapacks !== false && collectDir('datapacks', 'datapacks')) { collectedAnything = true; collectedTypes.push('datapacks'); }
    if (selectedContent.includeConfig !== false && collectDir('config', 'config')) { collectedAnything = true; collectedTypes.push('config'); }
    if (selectedContent.includeScreenshots !== false && collectDir('screenshots', 'screenshots')) { collectedAnything = true; collectedTypes.push('screenshots'); }
    if (selectedContent.includeWorlds !== false && collectDir('saves', 'worlds')) { collectedAnything = true; collectedTypes.push('worlds'); }
    
    console.log(`[export-profile] Collected types: [${collectedTypes.join(', ')}], total: ${collectedTypes.length}`);
    
    if (!collectedAnything && gameDirExists) {
      console.warn(`[export-profile] WARNING: gameDir exists but no content directories found. Contents may be empty.`);
    }
    if (!gameDirExists) {
      console.warn(`[export-profile] WARNING: gameDir does NOT exist at ${gameDir}. Creating empty profile folder for future use.`);
      fs.mkdirSync(gameDir, { recursive: true });
    }

    // Save icon from manifest
    if (manifest.contents?.icon && typeof manifest.contents.icon === 'string') {
      const iconData = manifest.contents.icon;
      try {
        if (iconData.startsWith('data:image/')) {
          const b64 = iconData.split(',')[1];
          if (b64) fs.writeFileSync(path.join(tmpDir, 'icon.png'), Buffer.from(b64, 'base64'));
        }
      } catch (_) {}
    }

    // --- Build archive based on format ---
    const zip = new AdmZip();

    if (format === 'zip') {
      // Add all collected files
      zip.addLocalFolder(tmpDir);
    } else if (format === 'mrpack') {
      // For .mrpack: build modrinth.index.json and use overrides/ folder structure
      // Proper .mrpack spec: mods go in overrides/, NOT in root
      
      // Collect all content files into overrides/ folder
      const overridesDir = path.join(tmpDir, 'overrides');
      fs.mkdirSync(overridesDir, { recursive: true });
      
      // Helper to collect into overrides/
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
      
      // Collect content based on user selection (mods go into overrides/mods/ for mrpack)
      if (selectedContent.includeMods !== false) collectToOverrides('mods', 'mods');
      if (selectedContent.includeResourcepacks !== false) collectToOverrides('resourcepacks', 'resourcepacks');
      if (selectedContent.includeShaderpacks !== false) collectToOverrides('shaderpacks', 'shaderpacks');
      if (selectedContent.includeConfig !== false) collectToOverrides('config', 'config');
      if (selectedContent.includeWorlds !== false) collectToOverrides('saves', 'worlds');
      
      // Per .mrpack spec: alle Dateien sind in overrides/ gebündelt
      // Das files-Array bleibt leer (nur für Dateien mit download-URLs gedacht)
      // Launcher kopieren overrides/ direkt ins Instance-Verzeichnis
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
      
      // Write modrinth.index.json at ROOT of archive
      fs.writeFileSync(path.join(tmpDir, 'modrinth.index.json'), JSON.stringify(mrpackIndex, null, 2));
      
      // Add ALL tmpDir contents to zip (overrides/ + modrinth.index.json)
      zip.addLocalFolder(tmpDir);
    }

    const buf = zip.toBuffer();
    const fileName = suggestedFileName || `${(instanceName || 'export').replace(/[^a-zA-Z0-9_-]/g, '_')}.${format === 'mrpack' ? 'mrpack' : 'zip'}`;
  // Use savePath if provided (user chose a location via save dialog)
  // otherwise save to cache folder
  const exportPath = savePath || path.join(rootPath, 'cache', fileName);
  fs.writeFileSync(exportPath, buf);

    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const stats = fs.statSync(exportPath);

    return {
      success: true,
      filePath: exportPath,
      fileName,
      fileSize: stats.size,
    };
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
});

// Keep the old save-dialog-based export handler as fallback
ipcMain.handle('export-profile-legacy', async (_event, { profileId, mode, options }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  let profiles = [];
  const profilesPath = path.join(rootPath, 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (_) {}
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

    // Icon aus data-URI extrahieren
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

    // ZIP erstellen
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
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
});

// ===== PROFIL IMPORT VORSCHAU =====
ipcMain.handle('import-preview', async (_event, filePath) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) return { error: 'Datei nicht gefunden' };

  const tmpDir = path.join(rootPath, 'cache', `import-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(tmpDir, true);

    // --- .mrpack ---
    if (ext === '.mrpack') {
      const indexPath = path.join(tmpDir, 'modrinth.index.json');
      if (!fs.existsSync(indexPath)) return { error: 'Ungültiges .mrpack: modrinth.index.json fehlt' };
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const loaderKey = Object.keys(index.dependencies || {}).find(k =>
        ['fabric-loader', 'forge', 'neoforge', 'quilt'].includes(k));
      const loaderName = loaderKey ? loaderKey.replace('-loader', '') : '';
      const mcVer = index.dependencies?.minecraft || '';

      // Count from files array if present, otherwise scan overrides/ on disk
      let modCount = 0, rpCount = 0, shaderCount = 0, datapackCount = 0, worldCount = 0;
      let hasConfig = false, hasScreenshots = false;
      
      if ((index.files || []).length > 0) {
        // Count from files array
        for (const f of index.files) {
          const fp = f.path;
          if (fp.startsWith('overrides/mods/') || fp.startsWith('mods/')) modCount++;
          else if (fp.startsWith('overrides/resourcepacks/') || fp.startsWith('resourcepacks/')) rpCount++;
          else if (fp.startsWith('overrides/shaderpacks/') || fp.startsWith('shaderpacks/')) shaderCount++;
          else if (fp.startsWith('overrides/datapacks/') || fp.startsWith('datapacks/')) datapackCount++;
          else if (fp.startsWith('overrides/saves/') || fp.startsWith('overrides/worlds/') || fp.startsWith('saves/') || fp.startsWith('worlds/')) worldCount++;
        }
      } else {
        // files array empty - scan overrides/ directory directly
        const overridesDir = path.join(tmpDir, 'overrides');
        if (fs.existsSync(overridesDir)) {
          function countDirFiles(subDir) {
            const p = path.join(overridesDir, subDir);
            if (!fs.existsSync(p)) return 0;
            return fs.readdirSync(p).filter(f => fs.statSync(path.join(p, f)).isFile()).length;
          }
          modCount = countDirFiles('mods');
          rpCount = countDirFiles('resourcepacks');
          shaderCount = countDirFiles('shaderpacks');
          datapackCount = countDirFiles('datapacks');
          worldCount = countDirFiles('saves') + countDirFiles('worlds');
          hasConfig = fs.existsSync(path.join(overridesDir, 'config'));
          hasScreenshots = fs.existsSync(path.join(overridesDir, 'screenshots'));
        }
      }

      const preview = {
        format: 'mrpack',
        title: index.name || path.basename(filePath, '.mrpack'),
        minecraftVersion: mcVer,
        modloader: loaderName || 'Vanilla',
        modloaderVersion: index.dependencies?.[loaderKey] || '',
        description: index.summary || '',
        author: index.author || '',
        fileSize: fs.statSync(filePath).size,
        totalFiles: modCount + rpCount + shaderCount + datapackCount + worldCount,
        modCount,
        resourcepackCount: rpCount,
        shaderCount,
        datapackCount,
        worldCount,
        hasIcon: fs.existsSync(path.join(tmpDir, 'overrides', 'icon.png')),
        hasBanner: false,
        hasConfig,
        hasScreenshots,
        isModpack: true,
      };
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return preview;
    }

    // --- .zip mit manifest.json ---
    const manifestPath = path.join(tmpDir, 'manifest.json');
    if (ext === '.zip' && fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.formatVersion) return { error: 'Ungültiges Format (formatVersion fehlt)' };

      // Support both old (manifest.profile) and new (manifest.instance) formats
      const profile = manifest.profile || manifest.instance || {};
      if (!profile.name && !manifest.instance?.name) return { error: 'Kein Profilname in manifest.json' };

      let iconBase64 = null;
      const iconPath = path.join(tmpDir, 'icon.png');
      if (fs.existsSync(iconPath)) {
        const data = fs.readFileSync(iconPath);
        iconBase64 = `data:image/png;base64,${data.toString('base64')}`;
      }

      const mcVer = profile.minecraftVersion || manifest.instance?.minecraftVersion || '';

      // Count files in the extracted archive
      function countDir(dir) {
        const p = path.join(tmpDir, dir);
        if (!fs.existsSync(p)) return 0;
        return fs.readdirSync(p).filter(f => fs.statSync(path.join(p, f)).isFile()).length;
      }

      const modCount = countDir('mods');
      const rpCount = countDir('resourcepacks');
      const shaderCount = countDir('shaderpacks');
      const dpCount = countDir('datapacks');
      const worldCount = countDir('saves') + countDir('worlds');

      const contents = manifest.contents || {};
      const preview = {
        format: 'zip',
        title: profile.name || manifest.instance?.name || path.basename(filePath, ext),
        minecraftVersion: mcVer,
        modloader: (profile.modLoader || manifest.instance?.modloader || 'Vanilla').replace(/^./, c => c.toUpperCase()),
        modloaderVersion: profile.loaderVersion || manifest.instance?.modloaderVersion || '',
        description: profile.description || manifest.instance?.description || manifest.meta?.description || '',
        author: manifest.meta?.author || manifest.instance?.author || '',
        fileSize: fs.statSync(filePath).size,
        totalFiles: modCount + rpCount + shaderCount + dpCount + worldCount + countDir('screenshots') + countDir('config'),
        modCount,
        resourcepackCount: rpCount,
        shaderCount,
        datapackCount: dpCount,
        worldCount,
        hasIcon: !!iconBase64 || !!(contents.icon),
        hasBanner: !!(contents.banner),
        hasConfig: countDir('config') > 0 || !!(contents.config?.count && contents.config.count > 0),
        hasScreenshots: countDir('screenshots') > 0 || !!(contents.screenshots?.count && contents.screenshots.count > 0),
        worlds: fs.existsSync(path.join(tmpDir, 'saves')) ? fs.readdirSync(path.join(tmpDir, 'saves')).filter(f => fs.statSync(path.join(tmpDir, 'saves', f)).isDirectory()) :
                 fs.existsSync(path.join(tmpDir, 'worlds')) ? fs.readdirSync(path.join(tmpDir, 'worlds')).filter(f => fs.statSync(path.join(tmpDir, 'worlds', f)).isDirectory()) : undefined,
        isModpack: manifest.instance?.isModpack || manifest.meta?.isModpack || false,
      };

      fs.rmSync(tmpDir, { recursive: true, force: true });
      return preview;
    }

    // --- Generisches .zip ---
    if (ext === '.zip') {
      const hasMods = fs.existsSync(path.join(tmpDir, 'mods'));
      const hasRP = fs.existsSync(path.join(tmpDir, 'resourcepacks'));
      const hasShader = fs.existsSync(path.join(tmpDir, 'shaderpacks'));
      const hasSaves = fs.existsSync(path.join(tmpDir, 'saves')) || fs.existsSync(path.join(tmpDir, 'worlds'));
      if (!hasMods && !hasRP && !hasShader) {
        return { error: 'Unbekanntes ZIP-Format. Keine mods/, resourcepacks/ oder shaderpacks/ gefunden.' };
      }
      const name = path.basename(filePath, '.zip');

      function countDir(dir) {
        const p = path.join(tmpDir, dir);
        if (!fs.existsSync(p)) return 0;
        return fs.readdirSync(p).filter(f => fs.statSync(path.join(p, f)).isFile()).length;
      }

      const preview = {
        format: 'zip',
        title: name,
        minecraftVersion: '',
        modloader: 'Vanilla',
        modloaderVersion: '',
        description: '',
        author: '',
        fileSize: fs.statSync(filePath).size,
        totalFiles: countDir('mods') + countDir('resourcepacks') + countDir('shaderpacks') + countDir('datapacks'),
        modCount: countDir('mods'),
        resourcepackCount: countDir('resourcepacks'),
        shaderCount: countDir('shaderpacks'),
        datapackCount: countDir('datapacks'),
        worldCount: countDir('saves') + countDir('worlds'),
        hasIcon: false,
        hasBanner: false,
        hasConfig: countDir('config') > 0,
        hasScreenshots: countDir('screenshots') > 0,
        worlds: fs.existsSync(path.join(tmpDir, 'saves')) ? fs.readdirSync(path.join(tmpDir, 'saves')).filter(f => fs.statSync(path.join(tmpDir, 'saves', f)).isDirectory()) : undefined,
        isModpack: false,
      };

      fs.rmSync(tmpDir, { recursive: true, force: true });
      return preview;
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: `Nicht unterstütztes Format: ${ext}` };
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { error: `Fehler beim Lesen der Datei: ${err.message}` };
  }
});

// ===== PROFIL IMPORT DURCHFÜHREN =====
ipcMain.handle('import-profile', async (_event, payload) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const {
    filePath,
    format,
    targetInstanceName,
    installMods = true,
    installResourcepacks = true,
    installShaderpacks = true,
    installDatapacks = true,
    installWorlds = true,
    installConfig = true,
    installScreenshots = true,
  } = payload || {};

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Datei nicht gefunden' };
  }

  const tmpDir = path.join(rootPath, 'cache', `import-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(tmpDir, true);

    // Load existing profiles
    let profiles = [];
    const profilesPath = path.join(rootPath, 'profiles.json');
    if (fs.existsSync(profilesPath)) {
      try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (_) {}
    }

    // Read manifest if present (support both old and new format)
    let manifest = null;
    const manifestPath = path.join(tmpDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (_) {}
    }

    // For .mrpack files: read modrinth.index.json for metadata
    let mrpackIndex = null;
    const mrpackIndexPath = path.join(tmpDir, 'modrinth.index.json');
    if (fs.existsSync(mrpackIndexPath) && !manifest) {
      try {
        mrpackIndex = JSON.parse(fs.readFileSync(mrpackIndexPath, 'utf8'));
      } catch (_) {}
    }

    // Determine instance name and metadata (support .mrpack)
    const profileInfo = manifest?.profile || manifest?.instance || {};
    const mrpackInfo = mrpackIndex ? {
      name: mrpackIndex.name,
      minecraftVersion: mrpackIndex.dependencies?.minecraft || '',
      modloader: Object.keys(mrpackIndex.dependencies || {}).find(k =>
        ['forge', 'neoforge', 'fabric-loader', 'quilt-loader'].includes(k))?.replace('-loader', '') || 'Vanilla',
      modloaderVersion: (() => {
        const key = Object.keys(mrpackIndex.dependencies || {}).find(k =>
          ['forge', 'neoforge', 'fabric-loader', 'quilt-loader'].includes(k));
        return key ? mrpackIndex.dependencies[key] : '';
      })(),
      description: mrpackIndex.summary || '',
    } : null;
    
    const meta = mrpackInfo || profileInfo;
    const baseName = targetInstanceName || mrpackInfo?.name || profileInfo.name || path.basename(filePath, path.extname(filePath));
    let finalName = baseName;
    const existingNames = profiles.map(p => p.name.toLowerCase());

    // Handle naming conflicts: append number if name exists
    if (existingNames.includes(finalName.toLowerCase())) {
      let cnt = 1;
      while (existingNames.includes(`${finalName} (${cnt})`.toLowerCase())) cnt++;
      finalName = `${finalName} (${cnt})`;
    }

    const folderName = finalName.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const gameDir = path.join(rootPath, 'profiles', folderName);
    fs.mkdirSync(gameDir, { recursive: true });

    // Stats counters
    let modsInstalled = 0;
    let rpInstalled = 0;
    let shadersInstalled = 0;
    let dpInstalled = 0;
    let worldsImported = 0;

    // Install selected content types
    const contentDirs = [
      { src: 'mods', enabled: installMods, countRef: () => modsInstalled },
      { src: 'resourcepacks', enabled: installResourcepacks, countRef: () => rpInstalled },
      { src: 'shaderpacks', enabled: installShaderpacks, countRef: () => shadersInstalled },
      { src: 'datapacks', enabled: installDatapacks, countRef: () => dpInstalled },
    ];

    for (const item of contentDirs) {
      // Check both root and overrides/ (for .mrpack compatibility)
      const srcDir = path.join(tmpDir, item.src);
      const srcOverride = path.join(tmpDir, 'overrides', item.src);
      const src = fs.existsSync(srcDir) ? srcDir : (fs.existsSync(srcOverride) ? srcOverride : null);
      if (item.enabled && src) {
        const dest = path.join(gameDir, item.src);
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const s = path.join(src, entry.name);
          const d = path.join(dest, entry.name);
          if (entry.isDirectory()) copyRecursive(s, d);
          else fs.copyFileSync(s, d);
        }
        // Count installed files
        const fileCount = fs.readdirSync(dest).filter(f => fs.statSync(path.join(dest, f)).isFile()).length;
        if (item.src === 'mods') modsInstalled = fileCount;
        else if (item.src === 'resourcepacks') rpInstalled = fileCount;
        else if (item.src === 'shaderpacks') shadersInstalled = fileCount;
        else if (item.src === 'datapacks') dpInstalled = fileCount;
      }
    }

    // Helper to find content in tmpDir (checks both root and overrides/ for .mrpack compatibility)
    function findContent(subDir) {
      const direct = path.join(tmpDir, subDir);
      if (fs.existsSync(direct)) return direct;
      const overridden = path.join(tmpDir, 'overrides', subDir);
      if (fs.existsSync(overridden)) return overridden;
      return null;
    }

    // Install worlds (saves folder in tmp -> saves folder in game dir)
    if (installWorlds) {
      for (const srcSub of ['saves', 'worlds']) {
        const src = findContent(srcSub);
        if (src) {
          const dest = path.join(gameDir, 'saves');
          fs.mkdirSync(dest, { recursive: true });
          copyRecursive(src, dest);
          // Count world directories (each world is a subfolder in saves)
          worldsImported += fs.readdirSync(dest).filter(f => fs.statSync(path.join(dest, f)).isDirectory()).length;
        }
      }
    }

    // Install config
    if (installConfig) {
      const src = findContent('config');
      if (src) {
        const dest = path.join(gameDir, 'config');
        fs.mkdirSync(dest, { recursive: true });
        copyRecursive(src, dest);
      }
    }

    // Install screenshots
    if (installScreenshots) {
      const src = findContent('screenshots');
      if (src) {
        const dest = path.join(gameDir, 'screenshots');
        fs.mkdirSync(dest, { recursive: true });
        copyRecursive(src, dest);
      }
    }

    // Create profile entry
    const mcVersion = mrpackInfo?.minecraftVersion || profileInfo.minecraftVersion || manifest?.instance?.minecraftVersion || '';
    const modloaderRaw = mrpackInfo?.modloader || profileInfo.modLoader || manifest?.instance?.modloader || 'Vanilla';
    const modloader = modloaderRaw.replace(/^./, c => c.toUpperCase());
    const modloaderVersion = mrpackInfo?.modloaderVersion || profileInfo.loaderVersion || manifest?.instance?.modloaderVersion || '';

    let iconHtml = '📦';
    const iconPath = path.join(tmpDir, 'icon.png');
    if (fs.existsSync(iconPath)) {
      const d = fs.readFileSync(iconPath);
      iconHtml = `<img src="data:image/png;base64,${d.toString('base64')}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"/>`;
    }
    
    // Also check overrides/ for icon (mrpack)
    const iconOverridePath = path.join(tmpDir, 'overrides', 'icon.png');
    if (!fs.existsSync(iconPath) && fs.existsSync(iconOverridePath)) {
      const d = fs.readFileSync(iconOverridePath);
      iconHtml = `<img src="data:image/png;base64,${d.toString('base64')}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"/>`;
    }

    const newProfile = {
      id: require('crypto').randomUUID(),
      name: finalName,
      folderName,
      icon: iconHtml,
      color: '#4CAF50',
      version: mcVersion || '1.21',
      loader: modloader,
      loaderVersion: modloaderVersion,
      playtime: 0,
      lastPlayed: '',
      ram: manifest?.settings?.ram || 4096,
      javaPath: meta.javaPath || '',
      installedMods: modsInstalled > 0 ? [{ id: 'imported', name: `${modsInstalled} Mods`, icon: '', version: '', enabled: true, locked: false }] : [],
      installedResourcePacks: rpInstalled > 0 ? [{ id: 'imported-rp', name: `${rpInstalled} Packs`, icon: '', version: '', enabled: true, locked: false }] : [],
      installedShaders: shadersInstalled > 0 ? [{ id: 'imported-sh', name: `${shadersInstalled} Packs`, icon: '', version: '', enabled: true, locked: false }] : [],
    };
    newProfile.mods = modsInstalled;
    newProfile.resourcePacks = rpInstalled;
    newProfile.shaderPacks = shadersInstalled;
    newProfile.desc = meta.description || manifest?.meta?.description || manifest?.instance?.description || '';
    newProfile.minecraftVersion = mcVersion;
    newProfile.modloader = modloader;
    newProfile.modloaderVersion = modloaderVersion;

    // Save profile
    profiles.push(newProfile);
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return {
      success: true,
      instanceId: newProfile.id,
      instanceName: finalName,
      modsInstalled,
      resourcepacksInstalled: rpInstalled,
      shaderpacksInstalled: shadersInstalled,
      datapacksInstalled: dpInstalled,
      worldsImported,
    };
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: err.message };
  }
});

// Registriere das eigene Protokoll für lokale Bilder VOR dem App-Start
protocol.registerSchemesAsPrivileged([
  { scheme: 'bamboo-file', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;

// ===== Window State Persistenz =====
const STATE_PATH = path.join('C:\\BambooLaufwerk', 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveWindowState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (_) {}
}

// ===== Single Instance Lock =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const deepLinkArg = (commandLine || []).find(arg => typeof arg === 'string' && arg.startsWith(`${INVITE_PROTOCOL}://`));
    if (deepLinkArg) {
      handleDeepLinkUrl(deepLinkArg);
    }
  });
}

function createWindow() {
  // Protokoll-Handler einrichten, um Sicherheits-Blockaden bei lokalen Bildern zu umgehen
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

  mainWindow.loadURL('http://localhost:5173').catch(() => {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  });

  if (saved.isMaximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Window-State speichern
  const saveBounds = () => {
    if (!mainWindow.isMaximized()) {
      saveWindowState(mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', () => saveWindowState({ isMaximized: true }));
  mainWindow.on('unmaximize', () => saveWindowState(mainWindow.getBounds()));
  mainWindow.on('close', () => {
    const state = mainWindow.isMaximized()
      ? { isMaximized: true }
      : mainWindow.getBounds();
    saveWindowState(state);
  });
}

function buildInviteUrl(payload) {
  return `${INVITE_PROTOCOL}://invite?data=${encodeURIComponent(JSON.stringify(payload))}`;
}

function handleDeepLinkUrl(url) {
  if (!url || typeof url !== 'string') return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${INVITE_PROTOCOL}:`) return;
    if (parsed.hostname !== 'invite') return;
    const data = parsed.searchParams.get('data');
    if (!data) return;
    const payload = JSON.parse(decodeURIComponent(data));
    pendingDeepLink = payload;
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('deep-link-invite', payload);
      pendingDeepLink = null;
    }
  } catch (e) {
    console.error('[deep-link] failed to parse invite URL:', e);
  }
}

app.whenReady().then(async () => {
  app.setAsDefaultProtocolClient(INVITE_PROTOCOL);
  createWindow();
  if (process.platform === 'win32') {
    const deepLinkArg = (process.argv || []).find(arg => typeof arg === 'string' && arg.startsWith(`${INVITE_PROTOCOL}://`));
    if (deepLinkArg) handleDeepLinkUrl(deepLinkArg);
  }
  await startRPC();
  updateDiscordPresence('launcher');
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===== FRIENDS IPC HANDLERS =====
const FRIENDS_PATH = path.join('C:\\BambooLaufwerk', 'friends');
if (!fs.existsSync(FRIENDS_PATH)) fs.mkdirSync(FRIENDS_PATH, { recursive: true });
const FRIENDS_STORE_PATH = path.join(FRIENDS_PATH, 'store.json');

function readFriendsStore() {
  try {
    if (fs.existsSync(FRIENDS_STORE_PATH)) return JSON.parse(fs.readFileSync(FRIENDS_STORE_PATH, 'utf-8'));
  } catch (e) { console.error('[friends] read error:', e); }
  return null;
}

function writeFriendsStore(data) {
  try { fs.writeFileSync(FRIENDS_STORE_PATH, JSON.stringify(data, null, 2), 'utf-8'); return true; }
  catch (e) { console.error('[friends] write error:', e); return false; }
}

ipcMain.handle('get-friends-store', () => readFriendsStore());
ipcMain.handle('save-friends-store', (_event, data) => writeFriendsStore(data));

ipcMain.handle('search-users', async (_event, query) => {
  // Placeholder: Lokale Suche oder API-Abfrage
  try {
    const store = readFriendsStore();
    if (!store) return [];
    const friends = Object.values(store.friends || {});
    return friends.filter(f =>
      f.username?.toLowerCase().includes(query.toLowerCase()) ||
      f.displayName?.toLowerCase().includes(query.toLowerCase()) ||
      f.id?.toLowerCase().includes(query.toLowerCase())
    );
  } catch { return []; }
});

ipcMain.handle('send-friend-request', async (_event, userId) => {
  const store = readFriendsStore() || { friends: {}, relations: {}, friendRequests: [], blockedUsers: [] };
  store.friendRequests = store.friendRequests || [];
  store.friendRequests.push({ from: store.myProfile?.id || 'local', to: userId, timestamp: Date.now() });
  return writeFriendsStore(store);
});

ipcMain.handle('accept-friend-request', async (_event, userId) => {
  const store = readFriendsStore() || { friends: {}, relations: {}, friendRequests: [], blockedUsers: [] };
  store.friendRequests = (store.friendRequests || []).filter(r => r.from !== userId);
  if (store.friends && !store.friends[userId]) {
    store.friends[userId] = {
      id: userId, username: userId, displayName: userId, avatar: '👤', banner: '', bio: '',
      accentColor: '#4CAF50', createdAt: Date.now(), status: 'offline',
      activity: { type: 'offline' }, friendCount: 0, lastOnline: Date.now(), launcherVersion: '0.1.0'
    };
  }
  store.relations = store.relations || {};
  store.relations[userId] = { userId, since: Date.now(), direction: 'accepted' };
  return writeFriendsStore(store);
});

ipcMain.handle('decline-friend-request', async (_event, userId) => {
  const store = readFriendsStore();
  if (!store) return false;
  store.friendRequests = (store.friendRequests || []).filter(r => r.from !== userId);
  return writeFriendsStore(store);
});

ipcMain.handle('block-user', async (_event, userId) => {
  const store = readFriendsStore() || { friends: {}, relations: {}, friendRequests: [], blockedUsers: [] };
  store.blockedUsers = store.blockedUsers || [];
  if (!store.blockedUsers.includes(userId)) store.blockedUsers.push(userId);
  delete (store.friends || {})[userId];
  delete (store.relations || {})[userId];
  return writeFriendsStore(store);
});

ipcMain.handle('remove-friend', async (_event, userId) => {
  const store = readFriendsStore();
  if (!store) return false;
  delete (store.friends || {})[userId];
  delete (store.relations || {})[userId];
  return writeFriendsStore(store);
});

ipcMain.handle('update-friend-status', async (_event, status) => {
  const store = readFriendsStore();
  if (!store) return false;
  if (store.myProfile) store.myProfile.status = status;
  return writeFriendsStore(store);
});

ipcMain.handle('update-friend-activity', async (_event, activity) => {
  const store = readFriendsStore();
  if (!store) return false;
  if (store.myProfile) store.myProfile.activity = activity;
  return writeFriendsStore(store);
});

ipcMain.handle('build-invite-link', async (_event, payload) => buildInviteUrl(payload));

ipcMain.handle('send-friend-invitation', async (_event, data) => {
  try {
    const store = readFriendsStore() || { friends: {}, relations: {}, friendRequests: [], blockedUsers: [], activities: [], notifications: [], privacySettings: { statusVisible: 'everyone', profileVisible: 'friends', whoCanAdd: 'everyone', activitiesVisible: 'friends', invitationsAllowed: 'friends', currentProfileVisible: 'friends' }, myProfile: { id: 'local', username: 'BambooPlayer', displayName: 'BambooPlayer', avatar: '🎋', banner: '', bio: 'Bamboo Launcher Nutzer', accentColor: '#4CAF50', createdAt: Date.now(), status: 'online', activity: { type: 'in_launcher' }, friendCount: 0, lastOnline: Date.now(), launcherVersion: '0.1.0' } };
    if (data && data.toUserId && data.invitationData) {
      store.notifications = store.notifications || [];
      store.notifications.unshift({
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        type: 'invitation',
        fromUserId: store.myProfile?.id || 'local',
        fromUserName: store.myProfile?.displayName || store.myProfile?.username || 'BambooPlayer',
        fromUserAvatar: store.myProfile?.avatar || '🎋',
        message: `${store.myProfile?.displayName || 'Jemand'} hat dir eine Einladung gesendet.`,
        timestamp: Date.now(),
        read: false,
        invitationData: data.invitationData,
      });
      writeFriendsStore(store);
    }
    return true;
  } catch (e) {
    console.error('[friends] send invitation error:', e);
    return false;
  }
});
ipcMain.handle('accept-friend-invitation', async (_event, notificationId) => {
  const store = readFriendsStore();
  if (!store || !store.notifications) return false;
  const index = store.notifications.findIndex(n => n.id === notificationId);
  if (index === -1) return false;
  const notification = store.notifications[index];
  if (notification.type !== 'invitation') return false;
  store.notifications[index].read = true;

  const fromId = notification.fromUserId;
  if (fromId && !store.blockedUsers?.includes(fromId)) {
    store.friends = store.friends || {};
    if (!store.friends[fromId]) {
      store.friends[fromId] = {
        id: fromId,
        username: notification.fromUserName || fromId,
        displayName: notification.fromUserName || fromId,
        avatar: notification.fromUserAvatar || '👤',
        banner: '',
        bio: '',
        accentColor: '#4CAF50',
        createdAt: Date.now(),
        status: 'offline',
        activity: { type: 'offline' },
        friendCount: 0,
        lastOnline: Date.now(),
        launcherVersion: '0.1.0',
      };
      store.relations = store.relations || {};
      store.relations[fromId] = { userId: fromId, since: Date.now(), direction: 'accepted' };
    }
  }

  return writeFriendsStore(store);
});
ipcMain.handle('decline-friend-invitation', async (_event, notificationId) => {
  const store = readFriendsStore();
  if (!store || !store.notifications) return false;
  const index = store.notifications.findIndex(n => n.id === notificationId);
  if (index === -1) return false;
  store.notifications[index].read = true;
  return writeFriendsStore(store);
});

const FRIEND_AVATARS_PATH = path.join(FRIENDS_PATH, 'avatars');
if (!fs.existsSync(FRIEND_AVATARS_PATH)) fs.mkdirSync(FRIEND_AVATARS_PATH, { recursive: true });

ipcMain.handle('save-friend-avatar', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return null;
    const ext = path.extname(filePath).toLowerCase();
    const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!allowedExts.includes(ext)) { console.warn('[friends] invalid avatar type:', ext); return null; }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const maxSize = 5 * 1024 * 1024;
    if (stat.size > maxSize) { console.warn('[friends] avatar too large:', stat.size); return null; }
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) { console.warn('[friends] avatar image is empty/invalid'); return null; }
    const size = Math.min(img.getSize().width, img.getSize().height);
    const cropped = img.crop({
      x: Math.floor((img.getSize().width - size) / 2),
      y: Math.floor((img.getSize().height - size) / 2),
      width: size, height: size,
    });
    const resized = cropped.resize({ width: 256, height: 256 });
    const destName = 'avatar.png';
    const destPath = path.join(FRIEND_AVATARS_PATH, destName);
    fs.writeFileSync(destPath, resized.toPNG());
    return toBambooFileUrl(destPath);
  } catch (e) { console.error('[friends] avatar save error:', e); return null; }
});

function toBambooFileUrl(localPath) {
  return `bamboo-file://${encodeURIComponent(localPath)}`;
}

ipcMain.handle('save-friend-banner', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return null;
    const ext = path.extname(filePath).toLowerCase();
    const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!allowedExts.includes(ext)) { console.warn('[friends] invalid banner type:', ext); return null; }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const maxSize = 10 * 1024 * 1024;
    if (stat.size > maxSize) { console.warn('[friends] banner too large:', stat.size); return null; }
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) { console.warn('[friends] banner image is empty/invalid'); return null; }
    const resized = img.resize({ width: 1200, height: 400 });
    const destName = 'banner.png';
    const destPath = path.join(FRIEND_AVATARS_PATH, destName);
    fs.writeFileSync(destPath, resized.toPNG());
    return toBambooFileUrl(destPath);
  } catch (e) { console.error('[friends] banner save error:', e); return null; }
});

function getSafeProfileFolderName(name) { return name.replace(/[^a-zA-Z0-9_-]/g, '_'); }

// Automatische Fabric-Installation
async function installModloader(rootPath, mcVersion, loaderType, loaderVersion) {
  const typeLower = loaderType.toLowerCase();
  const customId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const versionFolder = path.join(rootPath, 'versions', customId);
  const versionFile = path.join(versionFolder, `${customId}.json`);

  if (fs.existsSync(versionFile)) {
    console.log(`Fabric ${customId} bereits vorhanden.`);
    return customId;
  }
  console.log(`Installiere Fabric: ${customId}...`);
  if (!fs.existsSync(versionFolder)) fs.mkdirSync(versionFolder, { recursive: true });

  const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fabric JSON nicht gefunden für Version ${mcVersion}`);
  
  const jsonData = await response.json();
  fs.writeFileSync(versionFile, JSON.stringify(jsonData, null, 2));
  return customId;
}

async function ensureVanillaVersion(rootPath, mcVersion) {
  const verDir = path.join(rootPath, 'versions', mcVersion);
  const verFile = path.join(verDir, `${mcVersion}.json`);
  if (fs.existsSync(verFile)) return;
  if (!fs.existsSync(verDir)) fs.mkdirSync(verDir, { recursive: true });
  const manifestRes = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  if (!manifestRes.ok) throw new Error('Version-Manifest nicht ladbar');
  const manifest = await manifestRes.json();
  const verEntry = manifest.versions.find(v => v.id === mcVersion);
  if (!verEntry) throw new Error(`Minecraft ${mcVersion} nicht im Manifest`);
  const verMetaRes = await fetch(verEntry.url);
  if (!verMetaRes.ok) throw new Error('Version-Metadaten nicht ladbar');
  const verMeta = await verMetaRes.json();
  fs.writeFileSync(verFile, JSON.stringify(verMeta, null, 2));
  console.log(`Vanilla ${mcVersion} heruntergeladen`);
}

function patchLoaderVersion(rootPath, finalId) {
  const verFile = path.join(rootPath, 'versions', finalId, `${finalId}.json`);
  if (!fs.existsSync(verFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(verFile, 'utf8'));
    const libDir = path.join(rootPath, 'libraries');
    const props = [
      `-Dnet.neoforged.loader.libraryDirectory=${libDir}`,
      `-DlibraryDirectory=${libDir}`,
      `-Dfml.libraryDirectory=${libDir}`,
    ];
    if (!data.arguments) data.arguments = {};
    if (!Array.isArray(data.arguments.jvm)) data.arguments.jvm = [];
    for (const prop of props) {
      const exists = data.arguments.jvm.some(a => typeof a === 'string' && a.includes(prop.split('=')[0]));
      if (!exists) {
        data.arguments.jvm.push(prop);
        console.log(`Patch: ${prop} in ${finalId}`);
      }
    }
    fs.writeFileSync(verFile, JSON.stringify(data, null, 2));
  } catch (e) { console.warn(`Patch fehlgeschlagen für ${finalId}:`, e.message); }
}

// ===== Bamboo Client MOD für Fabric 26.2 =====
// Prüft vor dem Start, ob die Bamboo-Client-JAR existiert und lädt sie herunter, falls nötig
async function ensureBambooClientMod(gameDir, mcVersion) {
  // Nur für Fabric 26.2 + Versionen
  if (!mcVersion || !String(mcVersion).startsWith('26')) {
    console.log('[Bamboo-Client] Nicht für MC-Version relevant:', mcVersion);
    return;
  }

  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) {
    fs.mkdirSync(modsDir, { recursive: true });
    console.log(`[Bamboo-Client] Mods-Ordner erstellt: ${modsDir}`);
  }

  const files = [
    { name: 'bamboo-client-1.0.0.jar', url: 'https://cdn.discordapp.com/attachments/1520745540239753216/1520754748385656942/bamboo-client-1.0.0.jar?ex=6a4258ba&is=6a41073a&hm=fcbf53ccbb22e182470273cbdb05e601e3fcc14955b00d1c68d4e4477efab375&' },
    { name: 'fabric-api-0.153.026.2.jar', url: 'https://cdn.discordapp.com/attachments/1520745540239753216/1520745581117440090/fabric-api-0.153.026.2.jar?ex=6a425030&is=6a40feb0&hm=84ee852622bf3ba5e6a4b265a743876b82b80ab85ec07c703f7e7fbd92464b7e&' },
    { name: 'fabric-language-kotlin-1.13.12kotlin.2.4.0.jar', url: 'https://cdn.discordapp.com/attachments/1520745540239753216/1520751705468305438/fabric-language-kotlin-1.13.12kotlin.2.4.0.jar?ex=6a4255e4&is=6a410464&hm=07ef782295cb5f5ef3cdf7935cd806a9c3b7d97f149a397bb429d3988da210c0&' },
  ];

  for (const file of files) {
    const dest = path.join(modsDir, file.name);
    if (fs.existsSync(dest)) {
      console.log(`[Bamboo-Client] Datei bereits vorhanden: ${file.name}`);
      continue;
    }
    console.log(`[Bamboo-Client] Starte Download: ${file.name}`);
    downloadBambooClientFile(file.url, dest);
  }
}

async function downloadBambooClientFile(url, dest) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Bamboo-Client] Download fehlgeschlagen (${response.status}): ${url}`);
      return;
    }
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(buffer));
    console.log(`[Bamboo-Client] Erfolgreich gespeichert: ${dest}`);
  } catch (error) {
    console.error(`[Bamboo-Client] Fehler beim Download: ${error.message}`);
  }
}

function ensureClientJarForNeoForge(rootPath, mcVersion) {
  // NeoForge >1.20.6 erwartet die Vanilla-Client-JAR unter libraries/net/minecraft/client/<version>/client-<version>.jar
  // MCLC legt sie aber in versions/<version>/<version>.jar ab. Kopiere sie an den erwarteten Pfad.
  const srcJar = path.join(rootPath, 'versions', mcVersion, `${mcVersion}.jar`);
  if (!fs.existsSync(srcJar)) {
    console.warn(`Client-JAR nicht gefunden: ${srcJar}`);
    return;
  }
  const dstDir = path.join(rootPath, 'libraries', 'net', 'minecraft', 'client', mcVersion);
  const dstJar = path.join(dstDir, `client-${mcVersion}.jar`);
  if (fs.existsSync(dstJar)) {
    // Prüfe ob vorhandene Datei gleich gross ist
    if (fs.statSync(dstJar).size === fs.statSync(srcJar).size) return;
  }
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(srcJar, dstJar);
  console.log(`Client-JAR kopiert: ${srcJar} -> ${dstJar}`);
  // Auch srg-Variante für NeoForge >1.21 erstellen falls benötigt
  const dstJarSrg = path.join(dstDir, `client-${mcVersion}-srg.jar`);
  if (!fs.existsSync(dstJarSrg)) {
    try { fs.copyFileSync(srcJar, dstJarSrg); console.log(`Client-JAR (srg) kopiert: ${dstJarSrg}`); } catch (_) {}
  }
}

async function extractLoaderFromInstallerJar(rootPath, installerPath, finalId, versionIdInJar) {
  // Installer-JAR (ein ZIP) öffnen und version.json + Libraries extrahieren
  const verDir = path.join(rootPath, 'versions', finalId);
  if (!fs.existsSync(verDir)) fs.mkdirSync(verDir, { recursive: true });
  const targetVerFile = path.join(verDir, `${finalId}.json`);

  const zip = new AdmZip(installerPath);
  const entries = zip.getEntries();

  // 1. version.json aus dem JAR extrahieren
  const verEntryName = versionIdInJar ? `${versionIdInJar}.json` : 'version.json';
  let foundVer = false;
  for (const entry of entries) {
    if (entry.entryName === verEntryName || entry.entryName.endsWith(`/${verEntryName}`) || entry.entryName === 'version.json') {
      let jsonStr = entry.getData().toString('utf8');
      // Im JAR heisst die version-ID oft anders -> umschreiben auf finalId
      let verData = JSON.parse(jsonStr);
      verData.id = finalId;
      // InheritsFrom setzen falls nicht vorhanden
      if (!verData.inheritsFrom && finalId.includes('-')) {
        const parts = finalId.split('-');
        if (finalId.startsWith('neoforge')) {
          // NeoForge: neoforge-21.0.0 -> erbt von MC-Version, die schauen wir aus dem JAR
        }
      }
      fs.writeFileSync(targetVerFile, JSON.stringify(verData, null, 2));
      foundVer = true;
      console.log(`version.json extrahiert: ${targetVerFile}`);
      break;
    }
  }
  if (!foundVer) {
    throw new Error(`Keine version.json in ${installerPath} gefunden`);
  }

  // 2. Libraries aus maven/-Verzeichnis im JAR extrahieren
  const libBase = path.join(rootPath, 'libraries');
  let libCount = 0;
  for (const entry of entries) {
    if (entry.entryName.startsWith('maven/') && !entry.isDirectory) {
      const relPath = entry.entryName.slice('maven/'.length);
      const targetPath = path.join(libBase, relPath);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, entry.getData());
      libCount++;
    }
  }
  console.log(`${libCount} Libraries aus ${installerPath} extrahiert`);

  // 3. version.json patchen (libraryDirectory setzen)
  patchLoaderVersion(rootPath, finalId);
  return finalId;
}

async function installForgeLoader(rootPath, javaPath, mcVersion, loaderVersion, sendProgress) {
  return installForgeLoaderClean(rootPath, javaPath, mcVersion, loaderVersion, sendProgress);
}

async function installForgeLoaderClean(rootPath, javaPath, mcVersion, loaderVersion, sendProgress) {
  const finalId = `${mcVersion}-forge-${loaderVersion}`;
  const localFile = path.join(rootPath, 'versions', finalId, `${finalId}.json`);
  if (fs.existsSync(localFile)) { patchLoaderVersion(rootPath, finalId); console.log(`Forge ${finalId} bereits vorhanden.`); return finalId; }
  if (sendProgress) sendProgress(`Lade Forge-Installer ${loaderVersion} von Maven...`);
  await ensureVanillaVersion(rootPath, mcVersion);
  await downloadVanillaJar(rootPath, mcVersion);
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar`;
  const installerDir = path.join(rootPath, 'versions', `${mcVersion}-${loaderVersion}`);
  const installerPath = path.join(installerDir, `forge-${mcVersion}-${loaderVersion}-installer.jar`);
  if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
  console.log(`Lade Forge-Installer: ${installerUrl}`);
  const res = await fetch(installerUrl);
  if (!res.ok) throw new Error(`Forge-Installer nicht gefunden (${res.status})`);
  fs.writeFileSync(installerPath, Buffer.from(await res.arrayBuffer()));
  if (sendProgress) sendProgress('Extrahiere Forge-Dateien aus Installer...');
  await extractLoaderFromInstallerJar(rootPath, installerPath, finalId, finalId);
  console.log(`Forge ${finalId} installiert.`);
  return finalId;
}

async function installNeoforgeLoader(rootPath, javaPath, mcVersion, loaderVersion, sendProgress) {
  return installNeoforgeLoaderClean(rootPath, javaPath, mcVersion, loaderVersion, sendProgress);
}

async function installNeoforgeLoaderClean(rootPath, javaPath, mcVersion, loaderVersion, sendProgress) {
  const finalId = `neoforge-${loaderVersion}`;
  const localFile = path.join(rootPath, 'versions', finalId, `${finalId}.json`);
  if (fs.existsSync(localFile)) { patchLoaderVersion(rootPath, finalId); console.log(`NeoForge ${finalId} bereits vorhanden.`); return finalId; }
  if (sendProgress) sendProgress(`Lade NeoForge-Installer ${loaderVersion} von Maven...`);
  await ensureVanillaVersion(rootPath, mcVersion);
  await downloadVanillaJar(rootPath, mcVersion);
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const installerDir = path.join(rootPath, 'versions', `neoforge-${loaderVersion}`);
  const installerPath = path.join(installerDir, `neoforge-${loaderVersion}-installer.jar`);
  if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
  console.log(`Lade NeoForge-Installer: ${installerUrl}`);
  const res = await fetch(installerUrl);
  if (!res.ok) throw new Error(`NeoForge-Installer nicht gefunden (${res.status})`);
  fs.writeFileSync(installerPath, Buffer.from(await res.arrayBuffer()));
  if (sendProgress) sendProgress('Extrahiere NeoForge-Dateien aus Installer...');
  await extractLoaderFromInstallerJar(rootPath, installerPath, finalId, finalId);
  console.log(`NeoForge ${finalId} installiert.`);
  return finalId;
}

// Fabric API automatisch von Modrinth herunterladen
async function installFabricApi(gameDir, mcVersion) {
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

  const url = `https://api.modrinth.com/v2/project/P7dR8mSH/version?loaders=["fabric"]&game_versions=["${mcVersion}"]&featured=true`;
  const response = await fetch(url, { headers: { 'User-Agent': 'BambooLauncher/0.1.0' } });
  if (!response.ok) {
    console.warn(`Fabric API versions nicht abrufbar (${response.status}) – überspringe`);
    return;
  }
  const versions = await response.json();
  if (!versions || versions.length === 0) {
    console.warn('Keine Fabric API Version für ' + mcVersion + ' gefunden – überspringe');
    return;
  }

  const primaryFile = versions[0].files?.find(f => f.primary) || versions[0].files?.[0];
  if (!primaryFile) {
    console.warn('Kein Download-File für Fabric API – überspringe');
    return;
  }

  const dest = path.join(modsDir, primaryFile.filename);
  if (fs.existsSync(dest)) {
    console.log(`Fabric API ${primaryFile.filename} bereits vorhanden`);
    return;
  }

  console.log(`Lade Fabric API herunter: ${primaryFile.filename}`);
  const fileRes = await fetch(primaryFile.url);
  if (!fileRes.ok) throw new Error(`Fabric API Download fehlgeschlagen (${fileRes.status})`);
  const arrayBuffer = await fileRes.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  console.log(`Fabric API gespeichert: ${dest}`);
}

// Content-Download von Modrinth
// Modpack (mrpack) Installation
ipcMain.handle('install-modpack-mrpack', async (_event, { folderName, mcVersion, loader, mrpackUrl }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const tempDir = path.join(rootPath, 'cache', 'mrpack-tmp-' + Date.now());
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  try {
    const mrpackPath = path.join(tempDir, 'modpack.mrpack');
    console.log('Lade mrpack:', mrpackUrl);
    const res = await fetch(mrpackUrl);
    if (!res.ok) throw new Error('mrpack download fehlgeschlagen ' + res.status);
    const buf = await res.arrayBuffer();
    fs.writeFileSync(mrpackPath, Buffer.from(buf));
    // ZIP mit AdmZip extrahieren (unterstützt .mrpack nativ, kein Expand-Archive nötig)
    const extractDir = path.join(tempDir, 'extracted');
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
    try {
      const zip = new AdmZip(mrpackPath);
      zip.extractAllTo(extractDir, true);
      console.log('[install-modpack-mrpack] Extraktion erfolgreich mit AdmZip');
    } catch (_) {
      // Fallback: tar (falls verfügbar)
      try { execSync(`tar -xf "${mrpackPath}" -C "${extractDir}"`, { encoding: 'utf8', timeout: 60000 }); } catch (_2) { throw new Error('mrpack konnte nicht entpackt werden'); }
    }
    const indexJson = path.join(extractDir, 'modrinth.index.json');
    if (!fs.existsSync(indexJson)) throw new Error('modrinth.index.json nicht gefunden');
    const index = JSON.parse(fs.readFileSync(indexJson, 'utf8'));
    const files = index.files || [];
    // overrides KOPIEREN (Überschreiben: alte Dateien werden ersetzt)
    for (const sub of ['overrides', 'client-overrides']) {
      const src = path.join(extractDir, sub);
      if (fs.existsSync(src)) {
        copyRecursiveOverwriteSync(src, gameDir);
      }
    }
    // Alle vorhandenen Mod-Verzeichnisse INHALTLICH bereinigen (alte Mod-JARs, die nicht mehr im Index sind, werden gelöscht)
    const knownPaths = new Set(files.map(f => f.path.replace(/\\/g, '/')));
    for (const contentSubDir of ['mods', 'resourcepacks', 'shaderpacks', 'datapacks']) {
      const dir = path.join(gameDir, contentSubDir);
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const entryPath = (contentSubDir + '/' + entry).replace(/\\/g, '/');
          if (!knownPaths.has(entryPath) && !knownPaths.has('overrides/' + entryPath)) {
            try {
              fs.unlinkSync(path.join(dir, entry));
              console.log('[install-modpack-mrpack] Alte nicht mehr benötigte Datei gelöscht:', entryPath);
            } catch (e) {
              console.warn('[install-modpack-mrpack] Konnte alte Datei nicht löschen:', entryPath, e.message);
            }
          }
        }
      }
    }
    // Mods herunterladen (alte Versionen werden überschrieben)
    let modCount = 0;
    for (const file of files) {
      try {
        const envClient = file.env?.client || 'required';
        if (envClient === 'unsupported') continue;
        const downloadUrl = file.downloads?.[0];
        if (!downloadUrl) continue;
        const destPath = path.join(gameDir, file.path);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        // Alte Datei löschen falls vorhanden (für Update)
        if (fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch (e) { console.warn('[Modpack] Konnte alte Datei nicht löschen:', file.path, e.message); }
        }
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) continue;
        const fileBuf = await fileRes.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(fileBuf));
        modCount++;
        console.log(`[Modpack] ${file.path} heruntergeladen`);
      } catch (e) { console.warn('[Modpack] Download-Fehler:', file.path, e.message); }
    }
    return { success: true, modCount, index };
  } catch (err) {
    console.error('[Modpack] Fehler:', err.message);
    return { success: false, error: err.message };
  } finally {
    // Temp-Verzeichnis löschen
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

function copyRecursiveSync(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
      copyRecursiveSync(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Overwrite-variant: ersetzt IMMER existierende Dateien (wichtig für Modpack-Updates)
function copyRecursiveOverwriteSync(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
      copyRecursiveOverwriteSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

ipcMain.handle('download-mod', async (_event, { folderName, versionId, downloadUrl, filename, itemType }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  const subDir = itemType === 'resourcepack' ? 'resourcepacks' : itemType === 'shader' ? 'shaderpacks' : 'mods';
  const destDir = path.join(gameDir, subDir);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);
  
  // Always delete existing file first so the update flow works correctly
  if (fs.existsSync(destPath)) {
    try {
      fs.unlinkSync(destPath);
      console.log('[download-mod] Vorhandene Datei gelöscht vor Download:', destPath);
    } catch (e) {
      console.warn('[download-mod] Konnte vorhandene Datei nicht löschen:', e.message);
    }
  }
  
  const res = await fetch(downloadUrl);
  if (!res.ok || res.status !== 200) throw new Error(`Download fehlgeschlagen (${res.status})`);
  
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) throw new Error('Ungültiger Download-Link (HTML-Seite statt Datei)');
  
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error('Leere Datei heruntergeladen');
  
  fs.writeFileSync(destPath, Buffer.from(buf));
  
  // Verify file was written correctly
  const stats = fs.statSync(destPath);
  if (stats.size === 0) {
    fs.unlinkSync(destPath);
    throw new Error('Datei wurde leer gespeichert');
  }
  
  return { success: true, path: destPath, size: stats.size };
});

ipcMain.handle('read-latest-log', async (_event, folderName) => {
  const logPath = path.join('C:\\BambooLaufwerk', 'profiles', folderName, 'logs', 'latest.log');
  if (fs.existsSync(logPath)) return fs.readFileSync(logPath, 'utf8');
  return "Keine latest.log gefunden.";
});

ipcMain.handle('get-screenshots', async (_event, folderName) => {
  const ssPath = path.join('C:\\BambooLaufwerk', 'profiles', folderName, 'screenshots');
  if (!fs.existsSync(ssPath)) return [];
  return fs.readdirSync(ssPath).filter(f => f.endsWith('.png')).map(f => path.join(ssPath, f));
});

// ===== Unified Screenshots Collection =====
// Scans ALL instances + ALL worlds/saves and consolidates screenshots into a single
// global folder (C:\BambooLaufwerk\screenshots\). Returns lightweight metadata;
// images are loaded via the existing bamboo-file:// protocol to avoid base64 bloat.
ipcMain.handle('collect-all-screenshots', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
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
        try { fs.readSync(fd, buf, 0, 24, 0); } catch (_) {}
        fs.closeSync(fd);
        if (buf[0] === 0x89 && buf[1] === 0x50) {
          try { w = buf.readUInt32BE(16); h = buf.readUInt32BE(20); } catch (_) {}
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
    } catch (_) {}
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
      } catch (_) {}
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

ipcMain.handle('delete-screenshot-file', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { absolutePath, sourceAbsolutePath } = payload;
  if (!absolutePath || typeof absolutePath !== 'string') return false;
  const rootPath = 'C:\\BambooLaufwerk';
  const profilesDir = path.resolve(rootPath, 'profiles');
  const globalDir = path.resolve(rootPath, 'screenshots');
  const isUnder = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  const target = path.resolve(absolutePath);
  if (!isUnder(globalDir, target)) return false;
  let deleted = false;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    try { fs.unlinkSync(target); deleted = true; } catch (_) {}
  }
  // Also remove the original source file so it doesn't reappear on the next refresh.
  if (sourceAbsolutePath && typeof sourceAbsolutePath === 'string' && sourceAbsolutePath !== absolutePath) {
    const srcResolved = path.resolve(sourceAbsolutePath);
    if (isUnder(profilesDir, srcResolved) && fs.existsSync(srcResolved) && fs.statSync(srcResolved).isFile()) {
      try { fs.unlinkSync(srcResolved); } catch (_) {}
    }
  }
  return deleted;
});

ipcMain.handle('open-screenshots-folder', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
  const ssDir = path.join(rootPath, 'screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
  shell.openPath(ssDir);
});

// --- Microsoft Auth Flow ---
ipcMain.on('microsoft-login-device-code', async (event) => {
  try {
    const clientId = 'd5b2e079-2c2c-4ade-9dab-1c1eb204162a';
    const deviceRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: 'XboxLive.signin XboxLive.offline_access openid' })
    });
    const deviceData = await deviceRes.json();
    if (!deviceData.user_code) throw new Error("Konnte Device-Code nicht abrufen.");

    event.reply('ms-device-code', { userCode: deviceData.user_code, verificationUri: deviceData.verification_uri });

    let tokenData = null;
    const interval = (deviceData.interval || 5) * 1000;
    const expiresAt = Date.now() + (deviceData.expires_in * 1000);

    while (Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, interval));
      const pollRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: deviceData.device_code })
      });
      const pollJson = await pollRes.json();
      if (pollJson.access_token) { tokenData = pollJson; break; }
      else if (pollJson.error !== 'authorization_pending') throw new Error(`Auth-Fehler: ${pollJson.error}`);
    }
    if (!tokenData) throw new Error("Zeitüberschreitung.");

    event.reply('ms-login-step', 'Xbox Live wird authentifiziert...');
    const xblRes = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${tokenData.access_token}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' })
    });
    const xblData = await xblRes.json();
    const uhs = xblData.DisplayClaims.xui[0].uhs;

    event.reply('ms-login-step', 'XSTS Token wird generiert...');
    const xstsRes = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xblData.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' })
    });
    const xstsData = await xstsRes.json();

    event.reply('ms-login-step', 'Minecraft API wird verbunden...');
    const mcLoginRes = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsData.Token}` })
    });
    const mcLoginData = await mcLoginRes.json();

    const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { 'Authorization': `Bearer ${mcLoginData.access_token}` }
    });
    const profileData = await profileRes.json();

    if (profileData.id) {
      event.reply('ms-login-result', { success: true, name: profileData.name, uuid: profileData.id, token: mcLoginData.access_token, refreshToken: tokenData.refresh_token });
    } else throw new Error("Kein Minecraft Java-Profil gefunden.");
  } catch (err) { event.reply('ms-login-result', { success: false, error: err.message }); }
});

ipcMain.on('copy-to-clipboard', (_e, text) => clipboard.writeText(text));
ipcMain.on('open-external-url', (_e, url) => shell.openExternal(url));

// --- Launch Game ---
ipcMain.on('launch-game', async (event, args) => {
  const { folderName, profileName, version, ram, modLoader, loaderVersion, javaPath: profileJavaPath, authData, gameOptions } = args;
  const normalizedLoader = String(modLoader || 'vanilla').toLowerCase();

  if (ACTIVE_LAUNCHES.size >= MAX_CONCURRENT_LAUNCHES) {
    event.reply('launch-status', 'Es läuft bereits die maximale Anzahl an Minecraft-Instanzen (4).');
    return;
  }
  if (ACTIVE_LAUNCHES.has(folderName)) {
    event.reply('launch-status', `"${profileName}" wird bereits gestartet oder läuft bereits.`);
    return;
  }
  launchCounter++;
  const launchId = profileName + '-' + Date.now() + '-' + launchCounter;
  ACTIVE_LAUNCHES.set(folderName, launchId);

  console.log("[launch-game] Starte Launch-Vorgang für Profil:", profileName, "folder:", folderName);
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });

  // options.txt NUR beim ersten Start schreiben (wenn sie noch nicht existiert)
  // Danach übernimmt Minecraft die Verwaltung, damit In-Game-Änderungen erhalten bleiben
  const optionsTxtPath = path.join(gameDir, 'options.txt');
  if (gameOptions && !fs.existsSync(optionsTxtPath)) {
    const content = buildOptionsTxt(gameOptions);
    fs.writeFileSync(optionsTxtPath, content, 'utf8');
    console.log("[launch-game] options.txt (erster Start) geschrieben nach:", optionsTxtPath);
  }

  const javaPath = profileJavaPath || await findJavaPath();
  if (!javaPath) {
    event.reply('launch-status', 'Fehler: Java nicht gefunden. Bitte installiere Java 17 oder höher.');
    return;
  }

  // Issue 14: Defer heavy launch to prevent main process blocking during MCLC init
  event.reply('launch-status', 'Starte Minecraft...');
  setImmediate(async () => {
    let finalVersionId = version;

    try {
      event.reply('launch-status', 'Profil wird vorbereitet...');

    if (normalizedLoader !== 'vanilla' && loaderVersion) {
      event.reply('launch-status', `${modLoader} ${loaderVersion} wird vorbereitet...`);
      if (normalizedLoader === 'forge') {
        finalVersionId = await installForgeLoader(rootPath, javaPath, version, loaderVersion);
      } else if (normalizedLoader === 'neoforge') {
        finalVersionId = await installNeoforgeLoader(rootPath, javaPath, version, loaderVersion);
      } else if (normalizedLoader === 'fabric') {
        await installModloader(rootPath, version, normalizedLoader, loaderVersion);
        finalVersionId = `fabric-loader-${loaderVersion}-${version}`;
      }
    }

    let userAuth = authData && authData.type === 'microsoft' 
      ? { access_token: authData.token, client_token: 'client_token', uuid: authData.uuid, name: authData.name, user_properties: '{}' }
      : Authenticator.getAuth(authData?.name || "BambooPlayer");

    // LÖSUNG FÜR 26er VERSIONEN: Automatische Erkennung ob Snapshot
    const isSnapshot = version.includes('w') || version.toLowerCase().includes('pre') || version.toLowerCase().includes('rc');

    let opts = {
      clientPackage: null, authorization: userAuth, root: rootPath,
      version: { 
        number: version, 
        type: isSnapshot ? "snapshot" : "release"
      },
      memory: { max: `${ram}G`, min: "2G" },
      overrides: { gameDirectory: gameDir, windowsHide: false },
      javaPath: javaPath,
    };

    // ===== VERBESSERTE Java-Auswahl basierend auf Minecraft-Version =====
    if (!profileJavaPath) {
      // Wenn kein profil-spezifischer Pfad gesetzt, automatisch beste Java-Version auswählen
      const bestJava = await selectBestJavaForMcVersion(version);
      if (bestJava) {
        opts.javaPath = bestJava.path;
        const recVersion = getRecommendedJavaVersionForMc(version);
        console.log(`[Java-Auto] MC ${version} → Java ${recVersion} empfohlen. Verwende: Java ${bestJava.version} von ${bestJava.path}`);
      } else {
        console.warn(`[Java-Auto] Keine kompatible Java für MC ${version} gefunden, verwende fallback`);
      }
    } else {
      console.log(`[Java-Auto] Profil-spezifische Java-Einstellung verwendet: ${profileJavaPath}`);
    }

    if (normalizedLoader !== 'vanilla' && finalVersionId !== version) {
      opts.version.custom = finalVersionId;
    }

    // JVM Flags für Forge/NeoForge: --add-opens öffnet Java-Module für Reflection
    const jvmFlags = [];
    if (normalizedLoader === 'forge' || normalizedLoader === 'neoforge') {
      jvmFlags.push(
        '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED',
        '--add-opens', 'java.base/java.util=ALL-UNNAMED',
        '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
        '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED',
        '--add-opens', 'java.base/java.io=ALL-UNNAMED',
        '--add-opens', 'java.base/java.util.stream=ALL-UNNAMED',
        '--add-opens', 'java.base/java.net=ALL-UNNAMED',
        '--add-exports', 'java.base/sun.security.util=ALL-UNNAMED',
        '--add-exports', 'jdk.naming.dns/com.sun.jndi.dns=java.naming',
      );
    }
    if (jvmFlags.length > 0) {
      opts.customArgs = jvmFlags;
      console.log('MCLC customArgs vorbereitet:', jvmFlags.join(' '));
    }

    // Server auto-connect: Nutze quickPlay (modern MCLC API)
    if (gameOptions && gameOptions.joinServer) {
      opts.quickPlay = {
        type: 'multiplayer',
        identifier: `${gameOptions.joinServer}:${gameOptions.joinPort || 25565}`
      };
      console.log(`[launch-game] Auto-Connect via quickPlay: ${opts.quickPlay.identifier}`);
    }

    if (normalizedLoader === 'neoforge') ensureClientJarForNeoForge(rootPath, version);

    // Bamboo-Client-Mod für Fabric 26.2+ prüfen und ggf. herunterladen
    if (normalizedLoader === 'fabric' && version.startsWith('26')) {
      await ensureBambooClientMod(gameDir, version);
    }

    console.log("Starte Launcher mit Optionen:", JSON.stringify(opts, null, 2));
    const launcher = new Client();
    let gameReadySent = false;

    launcher.on('debug', (e) => console.log('DEBUG:', e));
    launcher.on('data', (e) => console.log('DATA:', e));
    launcher.on('error', (e) => {
      console.log('LAUNCHER ERROR:', e);
      ACTIVE_LAUNCHES.delete(folderName);
      updateDiscordPresence('back');
      event.reply('launch-status', `Fehler: ${e.message || e}`);
      event.reply('game-closed', { code: -1, profileName, folderName });
    });
    
    launcher.on('progress', e => {
        const pct = e.total > 0 ? Math.round((e.task / e.total) * 100) : 100;
        event.reply('launch-status', `Download: ${e.type} (${pct}%)`);
        if (!gameReadySent && e.task >= e.total) {
          gameReadySent = true;
          event.reply('game-ready', profileName);
          const inGameText = `${version}${normalizedLoader !== 'vanilla' ? ` - ${normalizedLoader}` : ''}`;
          updateDiscordPresence('inGame', profileName, inGameText);
        }
    });
    launcher.on('close', code => {
      ACTIVE_LAUNCHES.delete(folderName);
      updateDiscordPresence('back');
      if (!gameReadySent) {
        event.reply('game-ready', profileName);
      }
      event.reply('game-closed', { code, profileName, folderName });
    });
    updateDiscordPresence('starting', profileName);
    event.reply('launch-status', 'Minecraft wird gestartet...');

    // --- HOLZHAMMER-FIX START ---
    if (normalizedLoader === 'neoforge') {
      const libDir = path.join(opts.root, 'libraries');
      opts.customArgs.push(`-DlibraryDirectory=${libDir}`);
      opts.customArgs.push(`-Dfml.libraryDirectory=${libDir}`);
      opts.customArgs.push(`-Dnet.neoforged.loader.libraryDirectory=${libDir}`);
      console.log("[launch-game] HOLZHAMMER-ARGS:", opts.customArgs);
    }
    // --- HOLZHAMMER-FIX ENDE ---

    console.log("[launch-game] Finale MCLC opts.customArgs:", opts.customArgs);
    launcher.launch(opts);
    startProgressTracking(folderName, gameDir, event);
  } catch (error) {
    ACTIVE_LAUNCHES.delete(folderName);
    console.error("FATALER FEHLER BEIM LAUNCH:", error);
    event.reply('launch-status', `Fehler: ${error.message}`);
  }
  });
});

// ===== Cosmetics Progress Tracking (live from Minecraft stats) =====
const PROGRESS_INTERVALS = new Map();

function readMinecraftStats(gameDir) {
  try {
    var statsDir = gameDir + '/stats';
    if (!fs.existsSync(statsDir)) return null;
    var files = fs.readdirSync(statsDir).filter(function(f) { return f.endsWith('.json'); });
    if (files.length === 0) return null;
    var raw = JSON.parse(fs.readFileSync(statsDir + '/' + files[0], 'utf8'));
    var s = raw.stats || {};
    function sum(obj) { if (!obj) return 0; return Object.values(obj).reduce(function(a,b){return a+b;}, 0); }
    return {
      playtimeHours: Math.round(((s['minecraft:play_time'] || 0) / 72000) * 10) / 10,
      blocksMined: sum(s['minecraft:mined']),
      mobsKilled: sum(s['minecraft:killed']),
      playerKills: sum(s['minecraft:killed_by']),
      distanceTraveled: Math.round(((s['minecraft:walk_one_cm'] || 0) + (s['minecraft:sprint_one_cm'] || 0)) / 100),
      achievements: Object.keys(s['minecraft:achievement'] || {}),
    };
  } catch (e) {
    console.log('[cosmetic-progress] Stats not available yet:', e.message);
    return null;
  }
}

function startProgressTracking(folderName, gameDir, event) {
  if (PROGRESS_INTERVALS.has(folderName)) return;
  var data = readMinecraftStats(gameDir);
  if (data) try { event.sender.send('cosmetic-progress', data); } catch(e){}
  var intervalId = setInterval(function() {
    var d = readMinecraftStats(gameDir);
    if (d) try { event.sender.send('cosmetic-progress', d); } catch(e){}
  }, 30000);
  PROGRESS_INTERVALS.set(folderName, intervalId);
  console.log('[cosmetic-progress] Tracking started for:', folderName);
}

function stopProgressTracking(folderName) {
  if (PROGRESS_INTERVALS.has(folderName)) {
    clearInterval(PROGRESS_INTERVALS.get(folderName));
    PROGRESS_INTERVALS.delete(folderName);
    console.log('[cosmetic-progress] Tracking stopped for:', folderName);
  }
}

// --- Server Hosting ---
const HOSTED_SERVERS = new Map();

ipcMain.handle('get-active-launches', async () => {
  return Array.from(ACTIVE_LAUNCHES.keys());
});

ipcMain.handle('detect-lan-server', async (_event, folderName) => {
  try {
    const logPath = path.join('C:\\BambooLaufwerk', 'profiles', folderName, 'logs', 'latest.log');
    if (!fs.existsSync(logPath)) return null;
    const log = fs.readFileSync(logPath, 'utf8');
    const lines = log.split('\n').reverse();
    for (const line of lines) {
      const match = line.match(/Published (?:a )?LAN server on port (\d+)/i);
      if (match) {
        const port = parseInt(match[1], 10);
        HOSTED_SERVERS.set(folderName, { port, address: `0.0.0.0:${port}`, discoveredAt: Date.now() });
        return { port, address: `0.0.0.0:${port}` };
      }
    }
    return null;
  } catch { return null; }
});

// ===== Delete individual content files (mods, resourcepacks, shaderpacks) =====
ipcMain.handle('delete-content-file', async (_event, { folderName, fileName, type }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const profilesDir = path.join(rootPath, 'profiles');
  
  if (!folderName || !fileName) {
    console.warn('[delete-content-file] folderName oder fileName fehlt');
    return false;
  }
  
  const typeDir = type === 'resourcepacks' ? 'resourcepacks'
    : type === 'shaderpacks' ? 'shaderpacks'
    : type === 'datapacks' ? 'datapacks'
    : 'mods';
  
  const target = path.join(profilesDir, folderName, typeDir, fileName);
  
  // Security check: ensure target is within profiles directory
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(profilesDir))) {
    console.warn('[delete-content-file] Sicherheitsverletzung: Pfad ausserhalb profiles:', resolved);
    return false;
  }
  
  if (!fs.existsSync(resolved)) {
    // Don't throw if file doesn't exist - the update flow may have already deleted it
    console.log('[delete-content-file] Datei nicht gefunden (bereits gelöscht?):', resolved);
    return true;
  }
  
  try {
    fs.unlinkSync(resolved);
    console.log('[delete-content-file] Erfolgreich gelöscht:', resolved);
    
    // Auch die übergeordneten Ordner aufräumen, falls leer
    const parentDir = path.dirname(resolved);
    if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
      fs.rmdirSync(parentDir);
      console.log('[delete-content-file] Leeren Ordner entfernt:', parentDir);
    }
    
    return true;
  } catch (e) {
    console.error('[delete-content-file] Fehler beim Löschen:', e.message);
    return false;
  }
});

// List all content files in a profile subdirectory (for full package reload and robust delete)
ipcMain.handle('list-content-files', async (_event, { folderName, type }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const profilesDir = path.join(rootPath, 'profiles');
  if (!folderName) {
    console.warn('[list-content-files] folderName fehlt');
    return [];
  }
  const typeDir = type === 'resourcepacks' ? 'resourcepacks'
    : type === 'shaderpacks' ? 'shaderpacks'
    : type === 'datapacks' ? 'datapacks'
    : 'mods';
  const dir = path.resolve(profilesDir, folderName, typeDir);
  
  // Sicherheitscheck: Pfad muss innerhalb profiles/ bleiben
  if (!dir.startsWith(path.resolve(profilesDir))) {
    console.warn('[list-content-files] Sicherheitsverletzung: Pfad ausserhalb profiles:', dir);
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
    console.log('[list-content-files] Found in', dir, ':', files);
    return files;
  } catch (e) {
    console.error('[list-content-files] Error:', e.message);
    return [];
  }
});

ipcMain.handle('get-hosted-servers', async () => {
  const result = {};
  for (const [folderName, info] of HOSTED_SERVERS) {
    result[folderName] = info;
  }
  return result;
});