'use strict'
// Owner of the instance options.txt: first-run seed, sync marker and the
// launch-time merge of the values the user actually customised.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function createInstanceOptions(log) {
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
    log.warn('options sync marker could not be written', { gameDir, error: error.message });
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


  return {
    buildOptionsTxt,
    writeFirstRunOptions,
    applyLauncherGameOptions,
    normalizeKeyBindings,
    parseOptionsText,
  }
}

module.exports = { createInstanceOptions }
