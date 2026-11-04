/**
 * Secret hygiene regression guard (blueprint phase 10 §4).
 *
 * Two guarantees, both offline and deterministic:
 * 1. No CurseForge API-key literal (bcrypt `$2a...` shape, 20+ payload chars)
 *    exists anywhere in the source tree; the key must come from the environment
 *    or settings.
 * 2. A configured key never reaches a support bundle, neither through settings
 *    nor through a log line that contains it.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const AdmZip = require('adm-zip')
const { createCore } = require('../dist-electron/core.js')
const { registerIpc } = require('../dist-electron/ipc.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { createSupportBundle } = require('../dist-electron/support-bundle.js')

const ROOT = path.join(__dirname, '..')
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.rea-extract',
  '.freebuff',
  'dist',
  'dist-electron',
  'release',
  'coverage',
])
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.yml', '.yaml'])
const KEY_LITERAL = /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{20,}/

/** CurseForge keys are bcrypt strings; build one without writing a literal. */
function fixtureKey() {
  // Split the cost prefix so this fixture is not itself a scannable literal.
  return ['$2a', '10', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'].join('$')
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files)
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
    if (entry.name === 'package-lock.json') continue
    files.push(path.join(dir, entry.name))
  }
  return files
}

test('no CurseForge API-key literal exists in source files', () => {
  const offenders = []
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8')
    if (KEY_LITERAL.test(text)) offenders.push(path.relative(ROOT, file))
  }
  assert.deepEqual(offenders, [], `hardcoded CurseForge key in: ${offenders.join(', ')}`)
})

test('a configured CurseForge key reaches neither logs nor the support bundle', async (context) => {
  const key = fixtureKey()
  const previous = process.env.CURSEFORGE_API_KEY
  process.env.CURSEFORGE_API_KEY = key
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-secret-bundle-'))
  const appData = path.join(root, 'appData')
  const gameRoot = path.join(root, 'game')
  fs.mkdirSync(path.join(appData, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(gameRoot, 'versions'), { recursive: true })
  context.after(() => {
    if (previous === undefined) delete process.env.CURSEFORGE_API_KEY
    else process.env.CURSEFORGE_API_KEY = previous
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({ currentTheme: 'dark', lang: 'de', telemetryEnabled: false, curseForgeApiKey: key }),
  )
  fs.writeFileSync(
    path.join(appData, 'logs', 'main.log'),
    [
      `x-api-key: ${key}`,
      `CURSEFORGE_API_KEY=${key}`,
      JSON.stringify({ apiKey: key, note: 'curseforge search' }),
      'request finished',
      '',
    ].join('\n'),
  )

  const result = await createSupportBundle({ appData, gameRoot, destination: root })
  const zip = new AdmZip(result.file)
  const texts = {}
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) texts[entry.entryName] = entry.getData().toString('utf8')
  }
  const combined = Object.values(texts).join('\n')
  assert.equal(combined.includes(key), false, 'the key must not appear in any bundle entry')
  assert.equal(combined.includes('[redacted]'), true, 'secret-like log values must be redacted')
  assert.equal(texts['summary.json'].includes('CURSEFORGE_API_KEY'), false)

  const settings = JSON.parse(texts['settings.json'])
  assert.deepEqual(Object.keys(settings).sort(), ['currentTheme', 'lang', 'telemetryEnabled'])
})

test('main.js resolves the bundled CurseForge key at runtime', (context) => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf('function readCurseForgeApiKey()')
  const end = source.indexOf('function cfLoaderTypeToNum')
  assert.ok(start > 0 && end > start, 'key resolver block must exist in main.js')
  assert.match(source, /const CURSEFORGE_KEY_MISSING = \{\s*error: 'Kein CurseForge API-Key gesetzt',\s*code: 'missing-key'/,)
  assert.equal(
    source.split('if (!headers) return { ...CURSEFORGE_KEY_MISSING };').length - 1,
    3,
    'every CurseForge handler must fail with a clear error before fetching',
  )
  // Evaluate the shipped resolver against stubs instead of launching Electron.
  const factory = new Function(
    'path',
    'fs',
    '__dirname',
    `${source.slice(start, end)}; return { readCurseForgeApiKey, curseForgeHeaders };`,
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-key-resolver-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const resolver = factory(path, fs, dir)

  // Without the bundled file the launcher fails closed. A legacy per-user key
  // in settings.json must not resurrect a path the UI no longer offers.
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ curseForgeApiKey: 'stale-user-key' }))
  assert.equal(resolver.readCurseForgeApiKey(), '')
  assert.equal(resolver.curseForgeHeaders(), null, 'missing key must not produce headers')

  // The key that ships with the launcher is the only source for every user.
  const key = fixtureKey()
  fs.mkdirSync(path.join(dir, 'resources'))
  fs.writeFileSync(path.join(dir, 'resources', 'curseforge-key.txt'), `${key}\n`)
  assert.equal(resolver.readCurseForgeApiKey(), key)
  assert.equal(resolver.curseForgeHeaders()['x-api-key'], key)

  // The environment is not a second owner of the credential.
  process.env.CURSEFORGE_API_KEY = 'env-key-must-not-win'
  assert.equal(resolver.readCurseForgeApiKey(), key)
  delete process.env.CURSEFORGE_API_KEY
})

test('main.js classifies CurseForge failures so the UI never shows an empty list', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf('const CURSEFORGE_KEY_MISSING')
  const end = source.indexOf('function cfLoaderTypeToNum')
  assert.ok(start > 0 && end > start, 'CurseForge failure block must exist in main.js')
  const { curseForgeFailure, CURSEFORGE_KEY_MISSING } = new Function(
    `${source.slice(start, end)}; return { curseForgeFailure, CURSEFORGE_KEY_MISSING };`,
  )()

  assert.equal(CURSEFORGE_KEY_MISSING.code, 'missing-key')
  assert.deepEqual(Object.keys(CURSEFORGE_KEY_MISSING).sort(), ['code', 'error'])

  const response = (status, body) => ({ status, text: async () => body })
  const invalid = await curseForgeFailure(response(403, 'Forbidden: API Key missing or invalid'))
  assert.equal(invalid.code, 'invalid-key')
  assert.equal(invalid.status, 403)
  assert.match(invalid.error, /403/)
  assert.match(invalid.detail, /Forbidden/)

  assert.equal((await curseForgeFailure(response(401, ''))).code, 'invalid-key')
  assert.equal((await curseForgeFailure(response(429, 'slow down'))).code, 'rate-limited')
  const server = await curseForgeFailure(response(500, 'boom'))
  assert.equal(server.code, 'http')
  assert.equal(server.status, 500)
  assert.equal((await curseForgeFailure(response(403, 'x'.repeat(900)))).detail.length, 300)
  assert.equal((await curseForgeFailure(response(403, ''))).detail, '')
})

test('the renderer never receives the CurseForge key and cannot overwrite it', async (context) => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-renderer-key-'))
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    logger: createNullLogger(),
  })
  try {
    const key = fixtureKey()
    await core.settings.save({ curseForgeApiKey: key })

    const payload = await core.getSettingsForRenderer()
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'curseForgeApiKey'), false)
    assert.equal(JSON.stringify(payload).includes(key), false, 'the key must not reach the renderer')

    // A normal settings round-trip (the blob no longer contains the key) must
    // leave the stored key untouched.
    await core.saveSettingsFromRenderer({ currentTheme: 'futuristic' })
    assert.equal((await core.settings.get()).curseForgeApiKey, key)

    // Even a forged patch cannot overwrite or delete it.
    await core.saveSettingsFromRenderer({ curseForgeApiKey: 'renderer-attempt', lang: 'en' })
    let saved = await core.settings.get()
    assert.equal(saved.curseForgeApiKey, key)
    assert.equal(saved.currentTheme, 'futuristic')
    assert.equal(saved.lang, 'en')

    // An empty field (the usual "clear" action in a settings dialog) must not
    // delete the key either.
    await core.saveSettingsFromRenderer({ curseForgeApiKey: '' })
    saved = await core.settings.get()
    assert.equal(saved.curseForgeApiKey, key)
    assert.equal(saved.lang, 'en')
  } finally {
    await core.settings.save({})
  }
})

test('the real IPC settings surface hides and preserves the CurseForge key', async (context) => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-ipc-key-'))
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    logger: createNullLogger(),
  })
  const handlers = new Map()
  registerIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, core)
  const trusted = { senderFrame: { url: 'file:///app/index.html' } }
  try {
    const key = fixtureKey()
    await core.settings.save({ curseForgeApiKey: key, currentTheme: 'dark' })

    // The renderer reads the sanitized blob through the real handler.
    const payload = await handlers.get('bamboo:settings:get')(trusted)
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'curseForgeApiKey'), false)
    assert.equal(JSON.stringify(payload).includes(key), false)

    // A normal save round-trip keeps the key; a clear attempt cannot remove it.
    await handlers.get('bamboo:settings:save')(trusted, { currentTheme: 'futuristic' })
    await handlers.get('bamboo:settings:save')(trusted, { curseForgeApiKey: '', lang: 'en' })
    const saved = await core.settings.get()
    assert.equal(saved.curseForgeApiKey, key)
    assert.equal(saved.currentTheme, 'futuristic')
    assert.equal(saved.lang, 'en')

    // The persisted state must match what the next launch resolves.
    const onDisk = JSON.parse(fs.readFileSync(path.join(appData, 'settings.json'), 'utf8'))
    assert.equal(onDisk.curseForgeApiKey, key)
    assert.equal(onDisk.lang, 'en')

    const status = await handlers.get('bamboo:core:status')(trusted)
    assert.equal(status.telemetryEnabled, false)
  } finally {
    await core.settings.save({})
  }
})
