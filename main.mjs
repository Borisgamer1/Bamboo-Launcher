import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, net } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client, Authenticator } = require('minecraft-launcher-core');

// ── Root-Pfad-Konfiguration (persistiert) ──
const ROOT_PATH_CONFIG_FILE = path.join(process.env.APPDATA || 'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Roaming', 'BambooLauncher', 'rootpath.json');
let launcherRootPath = 'C:\\BambooLaufwerk';
try {
  if (fs.existsSync(ROOT_PATH_CONFIG_FILE)) {
    const d = JSON.parse(fs.readFileSync(ROOT_PATH_CONFIG_FILE, 'utf8'));
    if (d.rootPath) launcherRootPath = d.rootPath;
  }
} catch (_) {}
function saveRootPath(newPath) {
  launcherRootPath = newPath;
  const dir = path.dirname(ROOT_PATH_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROOT_PATH_CONFIG_FILE, JSON.stringify({ rootPath: newPath }, null, 2));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ACTIVE_LAUNCHES = new Map();
const MAX_CONCURRENT_LAUNCHES = 4;
let launchCounter = 0;

const isDev =
    process.env.NODE_ENV === 'development' ||
    process.env.ELECTRON_DEV === 'true' ||
    process.defaultApp ||
    /electron/i.test(path.basename(process.execPath));
const DEV_SERVER_URL = 'http://localhost:5173';

async function findJavaPath() {
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
  // Java-Version ermitteln und nach Version sortieren (höhere bevorzugen)
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
  if (withVersion.length === 0) return null;
  // Nach Java-Version absteigend sortieren (neueste zuerst)
  withVersion.sort((a, b) => b.version - a.version);
  console.log('Gefundene Java-Versionen:', withVersion.map(v => `${v.verStr || '?'} at ${v.path}`).join(' | '));
  return withVersion[0].path;
}

async function findInstallerJavaPath() {
  const candidates = [];
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

// ===== IPC HANDLERS =====

ipcMain.handle('find-java', async () => findJavaPath());

ipcMain.handle('write-options-txt', async (_event, { folderName, options }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  const optionsPath = path.join(gameDir, 'options.txt');
  const content = buildOptionsTxt(options);
  fs.writeFileSync(optionsPath, content, 'utf8');
  console.log('[write-options-txt] Geschrieben nach: ' + optionsPath);
});

ipcMain.handle('open-profile-folder', async (_event, folderName) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
  shell.openPath(gameDir);
});

ipcMain.handle('delete-profile-files', async (_event, folderName) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  if (fs.existsSync(gameDir)) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    console.log(`Profil-Ordner gelöscht: ${gameDir}`);
  }
});

ipcMain.handle('repair-profile', async (_event, { loader, loaderVersion, mcVersion }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const normalizedLoader = String(loader || '').toLowerCase();
  let versionId = '';
  let libDir = '';
  if (normalizedLoader === 'forge') {
    versionId = `${mcVersion}-forge-${loaderVersion}`;
    libDir = 'net/minecraftforge';
  } else if (normalizedLoader === 'neoforge') {
    versionId = `neoforge-${loaderVersion}`;
    libDir = 'net/neoforged';
  } else if (normalizedLoader === 'fabric') {
    versionId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  }
  if (versionId) {
    const verDir = path.join(rootPath, 'versions', versionId);
    if (fs.existsSync(verDir)) { fs.rmSync(verDir, { recursive: true, force: true }); console.log(`Loader-Version gelöscht: ${verDir}`); }
  }
  if (libDir) {
    const libPath = path.join(rootPath, 'libraries', libDir);
    if (fs.existsSync(libPath)) { fs.rmSync(libPath, { recursive: true, force: true }); console.log(`Loader-Libraries gelöscht: ${libPath}`); }
  }
  console.log(`Reparatur abgeschlossen für ${normalizedLoader} ${loaderVersion}`);
  return true;
});

// Settings Persistenz
ipcMain.handle('get-settings', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
  const settingsPath = path.join(rootPath, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) { return null; }
  }
  return null;
});

ipcMain.handle('save-settings', async (_event, settings) => {
  const rootPath = 'C:\\BambooLaufwerk';
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'settings.json'), JSON.stringify(settings, null, 2));
  return true;
});

// ===== CURSEFORGE API (Backend) =====
// API-Key hier eintragen: https://console.curseforge.com/
const CURSEFORGE_API_KEY = '$2a$10$s45iJ2QFz7VP7Ri35ZTjo.fdwq4QVHTD/RYmbf00SNIhHrP2OZjJm';

const CF_HEADERS = {
  'Accept': 'application/json',
  'x-api-key': CURSEFORGE_API_KEY,
};

ipcMain.handle('curseforge-search', async (_event, { query, sortBy = '6' }) => {
  if (!CURSEFORGE_API_KEY) return { error: 'Kein CurseForge API-Key gesetzt' };
  const gameId = 432;
  const searchParams = query
    ? `searchFilter=${encodeURIComponent(query)}&sortField=${sortBy}&sortOrder=desc`
    : `classId=6&sortField=${sortBy}&sortOrder=desc`;
  try {
    const res = await fetch(`https://api.curseforge.com/v1/mods/search?gameId=${gameId}&${searchParams}&pageSize=20`, { headers: CF_HEADERS });
    if (!res.ok) return { error: `CurseForge API-Fehler: ${res.status}` };
    const data = await res.json();
    return data.data || [];
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
    if (!modRes.ok) return { error: `HTTP ${modRes.status}` };
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
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    return { error: err.message };
  }
});

// Modloader-Versionen
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
    while ((match = regex.exec(xml)) !== null) versions.push(match[1]);
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
    while ((match = regex.exec(xml)) !== null) versions.push(match[1]);
    neoforgeVersionsCache = versions;
    return versions;
  } catch (err) {
    console.error('NeoForge-Versionen konnten nicht geladen werden:', err.message);
    return null;
  }
});

// Profile Persistenz
ipcMain.handle('get-profiles', async () => {
  const rootPath = 'C:\\BambooLaufwerk';
  const profilesPath = path.join(rootPath, 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    try { return JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (_) { return []; }
  }
  const profilesSubPath = path.join(rootPath, 'profiles', 'profiles.json');
  if (fs.existsSync(profilesSubPath)) {
    try { return JSON.parse(fs.readFileSync(profilesSubPath, 'utf8')); } catch (_) { return []; }
  }
  return [];
});

ipcMain.handle('save-profiles', async (_event, profiles) => {
  const rootPath = 'C:\\BambooLaufwerk';
  if (!fs.existsSync(rootPath)) fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'profiles.json'), JSON.stringify(profiles, null, 2));
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

// Fabric Installation
async function installModloader(rootPath, mcVersion, loaderType, loaderVersion) {
  const customId = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const versionFolder = path.join(rootPath, 'versions', customId);
  const versionFile = path.join(versionFolder, `${customId}.json`);
  if (fs.existsSync(versionFile)) { console.log(`Fabric ${customId} bereits vorhanden.`); return customId; }
  console.log(`Installiere Fabric: ${customId}...`);
  if (!fs.existsSync(versionFolder)) fs.mkdirSync(versionFolder, { recursive: true });
  const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fabric JSON nicht gefunden für Version ${mcVersion}`);
  const jsonData = await response.json();
  fs.writeFileSync(versionFile, JSON.stringify(jsonData, null, 2));
  return customId;
}

// Forge/NeoForge Installation (installer.jar download + --installClient)
const MC_DIR = path.join(process.env.APPDATA, '.minecraft');

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { copyRecursive(s, d); }
    else { fs.copyFileSync(s, d); }
  }
}

function copyVersionFromMc(rootPath, versionId) {
  const src = path.join(MC_DIR, 'versions', versionId);
  const srcFile = path.join(src, `${versionId}.json`);
  if (!fs.existsSync(srcFile)) return null;
  const dst = path.join(rootPath, 'versions', versionId);
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return versionId;
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
    const libDir = path.join(rootPath, 'libraries').replace(/\\/g, '/');
    // HIER GEÄNDERT: Anführungszeichen um den Pfad
    const prop = `-Dnet.neoforged.loader.libraryDirectory="${libDir}"`;
    let changed = false;
    if (Array.isArray(data.arguments?.jvm)) {
      for (let i = 0; i < data.arguments.jvm.length; i++) {
        const arg = data.arguments.jvm[i];
        if (typeof arg === 'string' && arg.includes('libraryDirectory')) {
          data.arguments.jvm[i] = prop;
          changed = true;
          break;
        }
      }
      if (!changed) {
        data.arguments.jvm.push(prop);
        changed = true;
      }
    } else {
      if (!data.arguments) data.arguments = {};
      if (!Array.isArray(data.arguments.jvm)) data.arguments.jvm = [];
      data.arguments.jvm.push(prop);
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(verFile, JSON.stringify(data, null, 2));
      console.log(`Patch: ${prop} in ${finalId}`);
    }
  } catch (e) { console.warn(`Patch fehlgeschlagen für ${finalId}:`, e.message); }
}

async function installForgeLoader(rootPath, javaPath, mcVersion, loaderVersion) {
  const finalId = `${mcVersion}-forge-${loaderVersion}`;
  const localFile = path.join(rootPath, 'versions', finalId, `${finalId}.json`);
  if (fs.existsSync(localFile)) { patchLoaderVersion(rootPath, finalId); console.log(`Forge ${finalId} bereits vorhanden.`); return finalId; }
  const fromMc = copyVersionFromMc(rootPath, finalId);
  if (fromMc) { console.log(`Forge ${finalId} von .minecraft kopiert.`); copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'minecraftforge'), path.join(rootPath, 'libraries', 'net', 'minecraftforge')); patchLoaderVersion(rootPath, finalId); return fromMc; }
  console.log(`Installiere Forge: ${finalId}...`);
  await ensureVanillaVersion(rootPath, mcVersion);
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar`;
  const installerDir = path.join(rootPath, 'versions', `${mcVersion}-${loaderVersion}`);
  const installerPath = path.join(installerDir, `forge-${mcVersion}-${loaderVersion}-installer.jar`);
  if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
  console.log(`Lade Forge-Installer herunter: ${installerUrl}`);
  const res = await fetch(installerUrl);
  if (!res.ok) throw new Error(`Forge-Installer nicht gefunden (${res.status})`);
  fs.writeFileSync(installerPath, Buffer.from(await res.arrayBuffer()));
  const java21Path = 'C:\\Program Files\\Java\\jdk-21.0.11\\bin\\java.exe';
  const installerJava = await findInstallerJavaPath();
  const useJava = (fs.existsSync(java21Path) ? java21Path : (installerJava || javaPath || 'java'));
  console.log(`Nutze Java für Installer: ${useJava} (found21=${fs.existsSync(java21Path)}, installerJava=${installerJava})`);
  console.log(`Führe Forge-Installer aus: ${installerPath}`);
  try {
    const result = execSync(`"${useJava}" -jar "${installerPath}" --installClient "${rootPath}"`, { encoding: 'utf8', timeout: 120000 });
    console.log(`Forge-Installer Ausgabe: ${result}`);
  } catch (e) {
    console.warn('Forge-Installer fehlgeschlagen:', e.message);
    if (e.stderr) console.error('Forge-Installer stderr:', e.stderr.slice(0, 2000));
    if (e.stdout) console.log('Forge-Installer stdout:', e.stdout.slice(0, 2000));
  }
  const installed = copyVersionFromMc(rootPath, finalId);
  if (installed) { copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'minecraftforge'), path.join(rootPath, 'libraries', 'net', 'minecraftforge')); patchLoaderVersion(rootPath, finalId); return installed; }
  console.warn('Forge-Installer hat keine version.json erstellt – versuche erneut mit MC_DIR');
  try {
    const result = execSync(`"${useJava}" -jar "${installerPath}" --installClient "${MC_DIR}"`, { encoding: 'utf8', timeout: 120000 });
    console.log(`Forge-Installer Ausgabe (MC_DIR): ${result}`);
  } catch (e) {
    console.warn('Forge-Installer (MC_DIR) fehlgeschlagen:', e.message);
    if (e.stderr) console.error('Forge-Installer stderr:', e.stderr.slice(0, 2000));
    if (e.stdout) console.log('Forge-Installer stdout:', e.stdout.slice(0, 2000));
  }
  const installed2 = copyVersionFromMc(rootPath, finalId);
  if (installed2) { copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'minecraftforge'), path.join(rootPath, 'libraries', 'net', 'minecraftforge')); patchLoaderVersion(rootPath, finalId); return installed2; }
  console.warn('Forge-Installer hat keine version.json erstellt – fallback');
  if (!fs.existsSync(path.dirname(localFile))) fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify({ id: finalId, inheritsFrom: mcVersion, jar: finalId, time: new Date().toISOString(), releaseTime: new Date().toISOString(), type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: [], jvm: [] } }, null, 2));
  return finalId;
}

async function installNeoforgeLoader(rootPath, javaPath, mcVersion, loaderVersion) {
  const finalId = `neoforge-${loaderVersion}`;
  const localFile = path.join(rootPath, 'versions', finalId, `${finalId}.json`);
  if (fs.existsSync(localFile)) { patchLoaderVersion(rootPath, finalId); console.log(`NeoForge ${finalId} bereits vorhanden.`); return finalId; }
  const fromMc = copyVersionFromMc(rootPath, finalId);
  if (fromMc) { console.log(`NeoForge ${finalId} von .minecraft kopiert.`); copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'neoforged'), path.join(rootPath, 'libraries', 'net', 'neoforged')); patchLoaderVersion(rootPath, finalId); return fromMc; }
  console.log(`Installiere NeoForge: ${finalId}...`);
  await ensureVanillaVersion(rootPath, mcVersion);
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const installerDir = path.join(rootPath, 'versions', `neoforge-${loaderVersion}`);
  const installerPath = path.join(installerDir, `neoforge-${loaderVersion}-installer.jar`);
  if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
  console.log(`Lade NeoForge-Installer herunter: ${installerUrl}`);
  const res = await fetch(installerUrl);
  if (!res.ok) throw new Error(`NeoForge-Installer nicht gefunden (${res.status})`);
  fs.writeFileSync(installerPath, Buffer.from(await res.arrayBuffer()));
  const java21Path = 'C:\\Program Files\\Java\\jdk-21.0.11\\bin\\java.exe';
  const installerJava = await findInstallerJavaPath();
  const useJava = (fs.existsSync(java21Path) ? java21Path : (installerJava || javaPath || 'java'));
  console.log(`Nutze Java für Installer: ${useJava} (found21=${fs.existsSync(java21Path)}, installerJava=${installerJava})`);
  console.log(`Führe NeoForge-Installer aus: ${installerPath}`);
  try {
    const result = execSync(`"${useJava}" -jar "${installerPath}" --installClient "${rootPath}"`, { encoding: 'utf8', timeout: 120000 });
    console.log(`NeoForge-Installer Ausgabe: ${result}`);
  } catch (e) {
    console.warn('NeoForge-Installer fehlgeschlagen:', e.message);
    if (e.stderr) console.error('NeoForge-Installer stderr:', e.stderr.slice(0, 2000));
    if (e.stdout) console.log('NeoForge-Installer stdout:', e.stdout.slice(0, 2000));
  }
  const installed = copyVersionFromMc(rootPath, finalId);
  if (installed) { copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'neoforged'), path.join(rootPath, 'libraries', 'net', 'neoforged')); patchLoaderVersion(rootPath, finalId); return installed; }
  console.warn('NeoForge-Installer hat keine version.json erstellt – versuche erneut mit MC_DIR');
  try {
    const result = execSync(`"${useJava}" -jar "${installerPath}" --installClient "${MC_DIR}"`, { encoding: 'utf8', timeout: 120000 });
    console.log(`NeoForge-Installer Ausgabe (MC_DIR): ${result}`);
  } catch (e) {
    console.warn('NeoForge-Installer (MC_DIR) fehlgeschlagen:', e.message);
    if (e.stderr) console.error('NeoForge-Installer stderr:', e.stderr.slice(0, 2000));
    if (e.stdout) console.log('NeoForge-Installer stdout:', e.stdout.slice(0, 2000));
  }
  const installed2 = copyVersionFromMc(rootPath, finalId);
  if (installed2) { copyRecursive(path.join(MC_DIR, 'libraries', 'net', 'neoforged'), path.join(rootPath, 'libraries', 'net', 'neoforged')); patchLoaderVersion(rootPath, finalId); return installed2; }
  console.warn('NeoForge-Installer hat keine version.json erstellt – fallback');
  if (!fs.existsSync(path.dirname(localFile))) fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify({ id: finalId, inheritsFrom: mcVersion, jar: finalId, time: new Date().toISOString(), releaseTime: new Date().toISOString(), type: 'release', mainClass: 'net.minecraft.client.main.Main', libraries: [], arguments: { game: [], jvm: [] } }, null, 2));
  return finalId;
}

// Fabric API download
async function installFabricApi(gameDir, mcVersion) {
  const modsDir = path.join(gameDir, 'mods');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const url = `https://api.modrinth.com/v2/project/P7dR8mSH/version?loaders=["fabric"]&game_versions=["${mcVersion}"]&featured=true`;
  const response = await fetch(url, { headers: { 'User-Agent': 'BambooLauncher/0.1.0' } });
  if (!response.ok) { console.warn(`Fabric API nicht abrufbar (${response.status})`); return; }
  const versions = await response.json();
  if (!versions || versions.length === 0) { console.warn('Keine Fabric API Version für ' + mcVersion); return; }
  const primaryFile = versions[0].files?.find(f => f.primary) || versions[0].files?.[0];
  if (!primaryFile) { console.warn('Kein Download-File für Fabric API'); return; }
  const dest = path.join(modsDir, primaryFile.filename);
  if (fs.existsSync(dest)) { console.log(`Fabric API ${primaryFile.filename} bereits vorhanden`); return; }
  console.log(`Lade Fabric API herunter: ${primaryFile.filename}`);
  const fileRes = await fetch(primaryFile.url);
  if (!fileRes.ok) throw new Error(`Fabric API Download fehlgeschlagen (${fileRes.status})`);
  const arrayBuffer = await fileRes.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  console.log(`Fabric API gespeichert: ${dest}`);
}

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
    const extractDir = path.join(tempDir, 'extracted');
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
    try {
      execSync(`powershell -c "Expand-Archive -Path '${mrpackPath}' -DestinationPath '${extractDir}' -Force"`, { encoding: 'utf8', timeout: 60000 });
    } catch (_) {
      try { execSync(`tar -xf "${mrpackPath}" -C "${extractDir}"`, { encoding: 'utf8', timeout: 60000 }); } catch (_2) { throw new Error('mrpack konnte nicht entpackt werden'); }
    }
    const indexJson = path.join(extractDir, 'modrinth.index.json');
    if (!fs.existsSync(indexJson)) throw new Error('modrinth.index.json nicht gefunden');
    const index = JSON.parse(fs.readFileSync(indexJson, 'utf8'));
    const files = index.files || [];
    for (const sub of ['overrides', 'client-overrides']) {
      const src = path.join(extractDir, sub);
      if (fs.existsSync(src)) { copyRecursiveSync(src, gameDir); }
    }
    let modCount = 0;
    for (const file of files) {
      try {
        const envClient = file.env?.client || 'required';
        if (envClient === 'unsupported') continue;
        const downloadUrl = file.downloads?.[0];
        if (!downloadUrl) continue;
        const destPath = path.join(gameDir, file.path);
        const destDirPath = path.dirname(destPath);
        if (!fs.existsSync(destDirPath)) fs.mkdirSync(destDirPath, { recursive: true });
        if (fs.existsSync(destPath)) { modCount++; continue; }
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

// Content-Download
ipcMain.handle('download-mod', async (_event, { folderName, versionId, downloadUrl, filename, itemType }) => {
  const rootPath = 'C:\\BambooLaufwerk';
  const gameDir = path.join(rootPath, 'profiles', folderName);
  const subDir = itemType === 'resourcepack' ? 'resourcepacks' : itemType === 'shader' ? 'shaderpacks' : 'mods';
  const destDir = path.join(gameDir, subDir);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, filename);
  if (fs.existsSync(destPath)) return { success: true, path: destPath };
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buf));
  return { success: true, path: destPath };
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
      const prefixedBase = `${safeSeg(instanceName)}__${safeSeg(worldName)}__${safeSeg(origBase)}__${stat.mtimeMs}`;
      const dest = path.join(globalDir, `${prefixedBase}.${origExt}`);
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
        source: worldName ? `${instanceName} / ${worldName}` : instanceName,
        instance: instanceName,
        world: worldName || null,
        date: stat.mtimeMs,
        sizeBytes: stat.size,
        sizeStr: stat.size > 1024 * 1024
          ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
          : `${(stat.size / 1024).toFixed(0)} KB`,
        dimensions: w && h ? `${w}×${h}` : '?',
        url: `bamboo-file://${encodeURIComponent(dest)}`,
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

// Microsoft Auth
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
  const { folderName, profileName, version, ram, modLoader, loaderVersion, authData, gameOptions } = args;
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
  if (gameOptions) {
    const content = buildOptionsTxt(gameOptions);
    fs.writeFileSync(path.join(gameDir, 'options.txt'), content, 'utf8');
    console.log("[launch-game] options.txt geschrieben nach:", path.join(gameDir, 'options.txt'));
  } else {
    console.log("[launch-game] WARNUNG: gameOptions ist falsy – options.txt NICHT geschrieben! gameOptions =", gameOptions);
  }
  const javaPath = await findJavaPath();
  if (!javaPath) {
    event.reply('launch-status', 'Fehler: Java nicht gefunden. Bitte installiere Java 17 oder höher.');
    return;
  }
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
    const isSnapshot = version.includes('w') || version.toLowerCase().includes('pre') || version.toLowerCase().includes('rc');
    let opts = {
      clientPackage: null, authorization: userAuth, root: rootPath,
      version: { number: version, type: isSnapshot ? "snapshot" : "release" },
      memory: { max: `${ram}G`, min: "2G" },
      overrides: { gameDirectory: gameDir, windowsHide: false },
      javaPath: javaPath,
    };
    if (normalizedLoader !== 'vanilla' && finalVersionId !== version) {
      opts.version.custom = finalVersionId;
    }


    if (normalizedLoader === 'neoforge' || normalizedLoader === 'forge') {
  try {
    const verFile = path.join(rootPath, 'versions', finalVersionId, `${finalVersionId}.json`);
    if (fs.existsSync(verFile)) {
      const verData = JSON.parse(fs.readFileSync(verFile, 'utf8'));
      const libDir = path.join(rootPath, 'libraries').replace(/\\/g, '/');
      // HIER GEÄNDERT: Anführungszeichen um den Pfad
      const prop = `-Dnet.neoforged.loader.libraryDirectory="${libDir}"`;
      let patched = false;
      if (Array.isArray(verData.arguments?.jvm)) {
        for (let i = 0; i < verData.arguments.jvm.length; i++) {
          if (typeof verData.arguments.jvm[i] === 'string' && verData.arguments.jvm[i].includes('libraryDirectory')) {
            verData.arguments.jvm[i] = prop;
            patched = true;
            break;
          }
        }
        if (!patched) { verData.arguments.jvm.push(prop); patched = true; }
      } else {
        if (!verData.arguments) verData.arguments = {};
        if (!Array.isArray(verData.arguments.jvm)) verData.arguments.jvm = [];
        verData.arguments.jvm.push(prop);
        patched = true;
      }
      if (patched) {
        fs.writeFileSync(verFile, JSON.stringify(verData, null, 2));
        console.log(`Pre-launch Patch: ${prop} in ${finalVersionId}`);
      }
    }
  } catch (e) { console.warn('Pre-launch Patch fehlgeschlagen:', e.message); }
}

    console.log("Starte Launcher mit Optionen:", JSON.stringify(opts, null, 2));
    const launcher = new Client();
    let gameReadySent = false;
    launcher.on('debug', (e) => console.log('DEBUG:', e));
    launcher.on('data', (e) => console.log('DATA:', e));
    launcher.on('error', (e) => { console.log('LAUNCHER ERROR:', e); ACTIVE_LAUNCHES.delete(folderName); event.reply('launch-status', `Fehler: ${e.message || e}`); event.reply('game-closed', { code: -1, profileName, folderName }); });
    launcher.on('progress', e => {
        const pct = e.total > 0 ? Math.round((e.task / e.total) * 100) : 100;
        event.reply('launch-status', `Download: ${e.type} (${pct}%)`);
        if (!gameReadySent && e.task >= e.total) {
            gameReadySent = true;
            event.reply('game-ready', profileName);
        }
    });
    launcher.on('close', code => {
        ACTIVE_LAUNCHES.delete(folderName);
        if (!gameReadySent) event.reply('game-ready', profileName);
        event.reply('game-closed', { code, profileName, folderName });
    });
    event.reply('launch-status', 'Minecraft wird gestartet...');
    launcher.launch(opts);
  } catch (error) {
    ACTIVE_LAUNCHES.delete(folderName);
    console.error("FATALER FEHLER BEIM LAUNCH:", error);
    event.reply('launch-status', `Fehler: ${error.message}`);
  }
});

// ===== WINDOW CREATION =====
function attachLoadErrorListener(mainWindow) {
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        console.error('Electron did-fail-load:', { errorCode, errorDescription, validatedURL, isMainFrame });
        if (isDev && isMainFrame && validatedURL === DEV_SERVER_URL) {
            console.warn('Dev-Server konnte nicht geladen werden. Versuche Fallback auf dist/index.html.');
            mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
        }
    });
}

async function loadApp(mainWindow) {
    attachLoadErrorListener(mainWindow);
    if (isDev) {
        try {
            await mainWindow.loadURL(DEV_SERVER_URL);
            console.log('✓ Dev-Server geladen:', DEV_SERVER_URL);
        } catch (err) {
            console.warn('✗ Dev-Server nicht erreichbar, verwende Production-Build:', err.message);
            await mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
        }
    } else {
        await mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
        console.log('✓ Production-Build geladen:', path.join(__dirname, 'dist', 'index.html'));
    }
}

function createWindow() {
    const preloadPath = isDev
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, 'preload.js');
    console.log('main: preload path =', preloadPath);
    const mainWindow = new BrowserWindow({
        width: 1280, height: 720, title: "Bamboo Launcher",
        webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    mainWindow.webContents.on('dom-ready', () => console.log('main: BrowserWindow dom-ready, preload should be active'));
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript('console.log("main-check: window.electronAPI=", typeof window.electronAPI, window.electronAPI)');
    });
    mainWindow.webContents.openDevTools();
    loadApp(mainWindow);
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
