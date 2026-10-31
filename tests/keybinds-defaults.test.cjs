/**
 * Regression guard for the options.txt seed and the launch-time merge.
 *
 * A freshly created instance must get the launcher's keybind defaults written
 * into its own options.txt, and the first writer must own the file: a later
 * creation call never replaces it. On top of that the launcher re-applies the
 * values the user actually customised (render distance, language, ...) to an
 * existing options.txt, while untouched defaults and in-game edits survive.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')

function loadOptionsWriter() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf('function mcVersionNum(ver)')
  const end = source.indexOf("ipc.handle('create-instance'")
  assert.ok(start > 0 && end > start, 'options.txt writer block must exist in main.js')
  const factory = new Function(
    'fs',
    'path',
    'console',
    `${source.slice(start, end)}; return { buildOptionsTxt, writeFirstRunOptions, normalizeKeyBindings };`,
  )
  const silent = { log() {}, warn() {}, error() {} }
  return factory(fs, path, silent)
}

const DEFAULTS = {
  'key.forward': 'key.keyboard.w',
  'key.attack': 'key.mouse.left',
  'key.sneak': 'key.keyboard.left.shift',
  'key.sprint': 'key.keyboard.left.control',
}

function loadOptionsApplier() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const writerStart = source.indexOf('function mcVersionNum(ver)')
  const writerEnd = source.indexOf("ipc.handle('create-instance'")
  const start = source.indexOf('function applyLauncherGameOptions(gameDir, options) {')
  const end = source.indexOf("ipc.handle('apply-options-patch'", start)
  assert.ok(writerStart > 0 && writerEnd > writerStart, 'options.txt writer block must exist in main.js')
  assert.ok(start > 0 && end > start, 'options.txt merge helper must exist in main.js')
  const factory = new Function(
    'fs',
    'path',
    'console',
    'require',
    `${source.slice(writerStart, writerEnd)}\n${source.slice(start, end)};\n` +
      'return { buildOptionsTxt, writeFirstRunOptions, applyLauncherGameOptions };',
  )
  const silent = { log() {}, warn() {}, error() {} }
  const shim = (id) => require(id.startsWith('./') ? path.join(ROOT, id.slice(2)) : id)
  return factory(fs, path, silent, shim)
}

test('a new instance gets the launcher keybind defaults in its options.txt', (context) => {
  const { writeFirstRunOptions } = loadOptionsWriter()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-keybinds-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const instanceDir = path.join(dir, 'profiles', 'fresh-instance')

  const result = writeFirstRunOptions(instanceDir, {
    _mcVersion: '1.21.1',
    lang: 'de_de',
    keyBindings: DEFAULTS,
  })

  assert.equal(result.created, true)
  assert.equal(result.keybindCount, 4)
  const text = fs.readFileSync(path.join(instanceDir, 'options.txt'), 'utf8')
  assert.match(text, /^key_key\.forward:key\.keyboard\.w$/m)
  assert.match(text, /^key_key\.attack:key\.mouse\.left$/m)
  assert.match(text, /^key_key\.sneak:key\.keyboard\.left\.shift$/m)
  assert.match(text, /^key_key\.sprint:key\.keyboard\.left\.control$/m)
  assert.match(text, /^version:\d+$/m, 'the file carries a data version so Minecraft keeps it')
})

test('an existing options.txt is never overwritten, by creation or by launch', (context) => {
  const { writeFirstRunOptions } = loadOptionsWriter()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-keybinds-keep-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const instanceDir = path.join(dir, 'profiles', 'played-instance')
  fs.mkdirSync(instanceDir, { recursive: true })
  const file = path.join(instanceDir, 'options.txt')
  const userOptions = 'version:3955\r\nkey_key.forward:key.keyboard.up\r\n'
  fs.writeFileSync(file, userOptions, 'utf8')

  const created = writeFirstRunOptions(instanceDir, {
    _mcVersion: '1.21.1',
    keyBindings: DEFAULTS,
  })
  assert.equal(created.created, false)
  assert.equal(created.reason, 'exists')
  assert.equal(fs.readFileSync(file, 'utf8'), userOptions, 'the user binding survives untouched')

  const launch = writeFirstRunOptions(instanceDir, { _mcVersion: '1.21.1', keyBindings: {} })
  assert.equal(launch.created, false)
  assert.equal(fs.readFileSync(file, 'utf8'), userOptions)
})

test('only well-formed key tokens reach options.txt', () => {
  const { normalizeKeyBindings, buildOptionsTxt } = loadOptionsWriter()
  assert.deepEqual(
    normalizeKeyBindings({
      'key.forward': 'key.keyboard.w',
      'not-a-key': 'key.keyboard.x',
      'key.left': 42,
      'key.right': 'nonsense',
      'key.back': '',
    }),
    { 'key.forward': 'key.keyboard.w' },
  )
  assert.equal(normalizeKeyBindings(null), undefined)
  assert.equal(normalizeKeyBindings([]), undefined)

  const text = buildOptionsTxt({
    _mcVersion: '1.21.1',
    keyBindings: { 'key.forward': 'key.keyboard.w', 'key.left': 'bad-token' },
  })
  assert.match(text, /^key_key\.forward:key\.keyboard\.w$/m)
  assert.equal(text.includes('key_key.left'), false)
})

test('customised launcher values reach an options.txt Minecraft already wrote', (context) => {
  const { applyLauncherGameOptions } = loadOptionsApplier()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-options-merge-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.writeFileSync(
    path.join(dir, 'options.txt'),
    [
      'version:3955',
      'renderDistance:12',
      'simulationDistance:12',
      'guiScale:3',
      'resourcePacks:["vanilla"]',
      'lang:en_us',
    ].join('\r\n') + '\r\n',
    'utf8',
  )

  const applied = applyLauncherGameOptions(dir, {
    _mcVersion: '26.3',
    renderDistance: 24,
    simulationDistance: 10,
    graphicsMode: 'fast',
    lang: 'de_de',
    fullscreen: true,
    keyBindings: DEFAULTS,
  })
  const text = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')

  assert.match(text, /^renderDistance:24$/m, 'the render distance the user set lands')
  assert.match(text, /^simulationDistance:10$/m, 'the simulation distance the user set lands')
  assert.match(text, /^lang:de_de$/m, 'the language is synced')
  assert.match(text, /^graphics:fast$/m, 'legacy graphics key stays')
  assert.match(text, /^graphicsMode:0$/m, 'modern graphicsMode key is numeric (wiki: 0-2)')
  assert.match(text, /^fullscreen:true$/m, 'a set fullscreen preference is applied')

  assert.match(text, /^guiScale:3$/m, 'an in-game edit of a default-valued option survives')
  assert.match(text, /^resourcePacks:\["vanilla"\]$/m, 'unknown keys stay untouched')
  assert.match(text, /^version:3955$/m, 'the data version is left to Minecraft')
  assert.equal(text.includes('key_key.forward'), false, 'keybinds are creation-time only')
  assert.ok(applied.includes('renderDistance'))
  assert.equal(applied.includes('guiScale'), false)
})

test('26.x first-run files pin graphicsPreset to custom and quote string enums', (context) => {
  const { writeFirstRunOptions } = loadOptionsWriter()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-preset-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const modern = path.join(dir, 'modern')
  writeFirstRunOptions(modern, {
    _mcVersion: '26.3',
    renderDistance: 30,
    lang: 'de_de',
    keyBindings: DEFAULTS,
  })
  const text = fs.readFileSync(path.join(modern, 'options.txt'), 'utf8')
  assert.match(text, /^graphicsPreset:"custom"$/m, 'only custom lets individual values survive startup')
  assert.match(text, /^renderDistance:30$/m)
  assert.match(text, /^renderClouds:"true"$/m, '26.x stores string enums quoted')
  assert.match(text, /^mainHand:"right"$/m)
  assert.match(text, /^inactivityFpsLimit:"minimized"$/m)

  const legacy = path.join(dir, 'legacy')
  writeFirstRunOptions(legacy, { _mcVersion: '1.20.1', lang: 'de_de', keyBindings: DEFAULTS })
  const legacyText = fs.readFileSync(path.join(legacy, 'options.txt'), 'utf8')
  assert.equal(legacyText.includes('graphicsPreset'), false, 'older versions do not know the key')
  assert.match(legacyText, /^renderClouds:true$/m, 'older versions keep the unquoted form')
})

test('customised distances flip a Minecraft-written preset to custom', (context) => {
  const { applyLauncherGameOptions } = loadOptionsApplier()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-preset-merge-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Zustand nach einem echten 26.3-Start mit Preset "fabulous"
  fs.writeFileSync(
    path.join(dir, 'options.txt'),
    [
      'version:5023',
      'graphicsPreset:"fabulous"',
      'renderDistance:32',
      'simulationDistance:12',
      'entityDistanceScaling:1.25',
      'improvedTransparency:true',
      'renderClouds:"true"',
      'fov:0.000000',
      'lang:en_us',
    ].join('\r\n') + '\r\n',
    'utf8',
  )

  applyLauncherGameOptions(dir, {
    _mcVersion: '26.3',
    renderDistance: 30,
    simulationDistance: 30,
    entityDistanceScaling: 500,
    graphicsMode: 'fabulous',
    lang: 'de_de',
  })
  const text = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')

  assert.match(text, /^graphicsPreset:"custom"$/m, 'otherwise Minecraft resets the distances on startup')
  assert.match(text, /^renderDistance:30$/m)
  assert.match(text, /^simulationDistance:30$/m)
  assert.match(text, /^entityDistanceScaling:5(\.0)?$/m, 'the file value is normalised to its number (5.0 -> 5)')
  assert.match(text, /^improvedTransparency:true$/m, 'the fabulous quality bundle is applied on top')
  assert.match(text, /^cloudRange:128$/m, 'quality keys missing from the file are added')
  assert.match(text, /^fov:0\.000000$/m, 'an untouched value is left alone')
  assert.match(text, /^lang:de_de$/m)
  assert.match(text, /^version:5023$/m, 'the data version stays Minecraft\'s')
})

test('a quality-only change writes the real preset so Minecraft applies the bundle', (context) => {
  const { applyLauncherGameOptions } = loadOptionsApplier()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-preset-mode-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.writeFileSync(path.join(dir, 'options.txt'), 'version:5023\r\nrenderDistance:32\r\n', 'utf8')
  const applied = applyLauncherGameOptions(dir, {
    _mcVersion: '26.3',
    graphicsMode: 'fast',
  })
  const text = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')

  assert.match(text, /^graphicsPreset:"fast"$/m, 'untouched distances follow the chosen preset')
  assert.equal(text.includes('graphicsPreset:"custom"'), false)
  assert.ok(applied.includes('graphicsPreset'))
})

test('an existing options.txt without customised values stays byte-identical', (context) => {
  const { applyLauncherGameOptions } = loadOptionsApplier()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-options-keep-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const original = 'graphicsPreset:"custom"\r\nrenderDistance:16\r\nguiScale:2\r\n'
  fs.writeFileSync(path.join(dir, 'options.txt'), original, 'utf8')

  const applied = applyLauncherGameOptions(dir, { _mcVersion: '26.3' })
  assert.deepEqual(applied, [])
  assert.equal(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), original)

  assert.deepEqual(applyLauncherGameOptions(path.join(dir, 'missing'), { _mcVersion: '26.3' }), [])
})

test('a 26.x file without graphicsPreset gains the quoted custom seed', (context) => {
  const { applyLauncherGameOptions } = loadOptionsApplier()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-preset-seed-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'options.txt'), 'renderDistance:16\r\n', 'utf8')

  const applied = applyLauncherGameOptions(dir, { _mcVersion: '26.3' })
  const text = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')

  assert.match(text, /^graphicsPreset:"custom"$/m, 'quoted, so Minecraft does not fall back to the fancy bundle')
  assert.match(text, /^renderDistance:16$/m, 'the existing line keeps its value and position')
  assert.ok(applied.includes('graphicsPreset'))
})
