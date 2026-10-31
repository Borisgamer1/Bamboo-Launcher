/**
 * Smoke tests for the launcher core (blueprint phases 0 + 1).
 *
 * These exercise the real compiled core (`dist-electron`) without Electron:
 * schema defaults, corrupt-file quarantine, two data roots, token isolation,
 * migration idempotency and launch telemetry.
 *
 * Run with: npm run test:core
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createCore } = require('../dist-electron/core.js')
const { createFileLogger } = require('../dist-electron/logger.js')

function makeBox() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  }
}

function readLog(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function createTestCore(appData, legacyGameRoot) {
  const logger = createFileLogger({ dir: path.join(appData, 'logs'), level: 'debug' })
  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot,
    safeStorage: makeBox(),
    logger,
    // Startup restores a migrated Microsoft session in the background. Tests
    // must never reach Microsoft (a real invalid_grant would write back after
    // the temp dir is gone), so the network is offline here.
    fetchImpl: async () => {
      throw new Error('offline test core')
    },
  })
  return { core, logger, logFile: path.join(appData, 'logs', 'main.log') }
}

test('phase 1: corrupt settings.json falls back to defaults and is quarantined', async () => {
  const appData = tempDir('corrupt')
  fs.writeFileSync(path.join(appData, 'settings.json'), '{ "currentTheme": "dark", ', 'utf8')

  const { core } = await createTestCore(appData, path.join(appData, 'does-not-exist'))

  const settings = await core.settings.get()
  assert.equal(settings.currentTheme, 'dark')
  assert.equal(settings.lang, 'de')

  const quarantined = fs.readdirSync(appData).filter((name) => name.startsWith('settings.json.corrupt-'))
  assert.equal(quarantined.length, 1, 'corrupt file must be kept for diagnosis')
})

test('phase 1: missing root pointer bootstraps a game root and persists it', async () => {
  const appData = tempDir('root')
  const { core } = await createTestCore(appData, path.join(appData, 'missing-legacy'))

  assert.equal(core.rootSource, 'default')
  assert.equal(core.paths.gameRoot, path.join(appData, 'game'))
  assert.equal(fs.readFileSync(path.join(appData, 'root'), 'utf8').trim(), core.paths.gameRoot)
  assert.ok(fs.statSync(core.paths.gameRoot).isDirectory())
})

test('phase 1: accounts and tokens never land in settings.json', async () => {
  const appData = tempDir('tokens')
  const { core } = await createTestCore(appData, path.join(appData, 'missing-legacy'))

  await core.saveSettingsFromRenderer({
    currentTheme: 'bamboo',
    accounts: [
      {
        id: 'acc-1',
        name: 'Alex',
        uuid: '00000000-0000-0000-0000-000000000001',
        type: 'microsoft',
        active: true,
        token: 'SECRET-ACCESS',
        refreshToken: 'SECRET-REFRESH',
      },
    ],
  })

  const settingsFile = fs.readFileSync(path.join(appData, 'settings.json'), 'utf8')
  assert.ok(!settingsFile.includes('SECRET-ACCESS'), 'access token must not be persisted in settings.json')
  assert.ok(!settingsFile.includes('SECRET-REFRESH'), 'refresh token must not be persisted in settings.json')
  assert.ok(!settingsFile.includes('accounts'), 'accounts are owned by accounts.json')

  // A settings round-trip is not an account writer: only the auth service and
  // the one-time legacy migration may create accounts, so a stale snapshot in
  // the renderer cannot overwrite or resurrect a session.
  assert.equal(await core.accounts.get('acc-1'), undefined)
  assert.equal(await core.accounts.getToken('acc-1'), undefined)
  assert.deepEqual(await core.accounts.list(), [])

  const rendererView = await core.getSettingsForRenderer()
  assert.equal(rendererView.currentTheme, 'bamboo')
  assert.deepEqual(rendererView.accounts, [])

  // Atomic writer keeps the previous revision as `.bak`.
  const before = JSON.parse(fs.readFileSync(path.join(appData, 'settings.json'), 'utf8'))
  await core.settings.save({ lang: 'en' })
  const backup = JSON.parse(fs.readFileSync(path.join(appData, 'settings.json.bak'), 'utf8'))
  assert.equal(backup.currentTheme, before.currentTheme)
})

test('phase 1: legacy Bamboo data is migrated once, sanitized and idempotent', async () => {
  const appData = tempDir('migrate')
  const gameRoot = tempDir('legacy-root')
  fs.writeFileSync(
    path.join(gameRoot, 'settings.json'),
    JSON.stringify({
      currentTheme: 'light',
      lang: 'de',
      accounts: [
        {
          id: 'legacy-acc',
          name: 'Steve',
          uuid: '00000000-0000-0000-0000-000000000002',
          type: 'microsoft',
          active: true,
          token: 'SECRET-ACCESS',
          refreshToken: 'SECRET-REFRESH',
        },
      ],
    }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(gameRoot, 'profiles.json'),
    JSON.stringify([{ name: 'Main', version: '1.20.1', ram: 4096, loader: 'fabric', loaderVersion: '0.15.0' }]),
    'utf8',
  )

  const first = await createTestCore(appData, gameRoot)
  assert.equal(first.core.rootSource, 'legacy')
  assert.equal(first.core.migration.migrated, true)
  assert.equal(first.core.migration.accounts, 1)
  assert.equal(first.core.migration.instances, 1)
  assert.equal((await first.core.settings.get()).currentTheme, 'light')

  const accounts = await first.core.accounts.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].id, 'legacy-acc')
  assert.equal(accounts[0].hasToken, true)
  assert.equal((await first.core.accounts.getToken('legacy-acc')).accessToken, 'SECRET-ACCESS')

  const instances = await first.core.instances.list()
  assert.equal(instances.length, 1)
  assert.equal(instances[0].loader, 'fabric')
  assert.equal(instances[0].maxMemory, 4096)

  const legacySettings = fs.readFileSync(path.join(gameRoot, 'settings.json'), 'utf8')
  assert.ok(!legacySettings.includes('SECRET-ACCESS'), 'legacy settings must be sanitized')
  assert.ok(!legacySettings.includes('SECRET-REFRESH'), 'legacy settings must be sanitized')
  assert.ok(legacySettings.includes('legacy-acc'), 'account metadata stays in the legacy file')
  assert.ok(fs.existsSync(path.join(gameRoot, 'settings.json.pre-migration.bak')))

  const second = await createTestCore(appData, gameRoot)
  assert.equal(second.core.migration.migrated, false)
  assert.equal((await second.core.accounts.list()).length, 1)
  assert.equal((await second.core.instances.list()).length, 1)
})

test('phase 0: every launch attempt is logged with id, config, exit code and duration', async () => {
  const appData = tempDir('launch')
  const { core, logger, logFile } = await createTestCore(appData, path.join(appData, 'missing-legacy'))

  const handle = core.beginLaunch({
    version: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.2.0',
    instancePath: path.join(core.paths.gameRoot, 'profiles', 'main'),
    javaPath: 'C:\\Java\\jdk-17\\bin\\javaw.exe',
    account: 'Alex',
    gameRoot: core.paths.gameRoot,
  })
  handle.finish({ exitCode: 0 })
  handle.finish({ exitCode: 1 }) // must not duplicate the record

  logger.error('auth failure', { accessToken: 'SECRET-ACCESS', authorization: { access_token: 'SECRET-ACCESS' } })

  const records = readLog(logFile)
  const started = records.filter((record) => record.msg === 'Launch started')
  const finished = records.filter((record) => record.msg === 'Launch finished')
  assert.equal(started.length, 1)
  assert.equal(finished.length, 1)
  assert.equal(started[0].data.launchId, handle.launchId)
  assert.equal(finished[0].data.launchId, handle.launchId)
  assert.equal(finished[0].data.version, '1.20.1')
  assert.equal(finished[0].data.loader, 'forge')
  assert.equal(finished[0].data.javaPath, 'C:\\Java\\jdk-17\\bin\\javaw.exe')
  assert.equal(finished[0].data.exitCode, 0)
  assert.equal(typeof finished[0].data.durationMs, 'number')
  assert.equal((await core.status()).launchCoreMode, 'legacy')

  const raw = fs.readFileSync(logFile, 'utf8')
  assert.ok(!raw.includes('SECRET-ACCESS'), 'log records must be redacted')
  assert.ok(raw.includes('[redacted]'))
})

test('phase 0: LAUNCH_CORE=v2 is surfaced as a feature flag', async () => {
  const appData = tempDir('flag')
  const previous = process.env.LAUNCH_CORE
  process.env.LAUNCH_CORE = 'v2'
  try {
    const { core } = await createTestCore(appData, path.join(appData, 'missing-legacy'))
    assert.equal((await core.status()).launchCoreMode, 'v2')
  } finally {
    if (previous === undefined) delete process.env.LAUNCH_CORE
    else process.env.LAUNCH_CORE = previous
  }
})

test('phase 9: an old instance.json with the loader profile id in version still launches and is healed', async () => {
  const appData = tempDir('legacy-instance-version')
  const { core } = await createTestCore(appData, path.join(appData, 'missing-legacy'))
  try {
    const gameRoot = core.paths.gameRoot
    const profileId = 'fabric-loader-0.15.11-1.20.1'
    const writeVersion = (id, json) => {
      const file = path.join(gameRoot, 'versions', id, `${id}.json`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ id, ...json }), 'utf8')
    }
    writeVersion('1.20.1', { type: 'release', mainClass: 'net.minecraft.client.main.Main' })
    writeVersion(profileId, {
      inheritsFrom: '1.20.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    })

    const directory = path.join(gameRoot, 'profiles', 'old-fabric')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, 'instance.json'),
      JSON.stringify({
        id: 'legacy-old',
        name: 'Old Fabric',
        version: profileId,
        loader: 'fabric',
        loaderVersion: '0.15.11',
        javaPath: '',
        minMemory: 0,
        maxMemory: 2048,
      }),
      'utf8',
    )
    await core.instances.upsert({
      id: 'legacy-old',
      name: 'Old Fabric',
      folderName: 'old-fabric',
      path: directory,
      managed: false,
      legacy: true,
      version: profileId,
      loader: 'fabric',
      loaderVersion: '0.15.11',
    })

    const launches = []
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async (request) => {
        launches.push(request)
        return {
          pid: 1,
          plan: {},
          exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          stderrLines: [],
          launchId: `launch-old-${launches.length}`,
        }
      },
    }

    await core.launchInstance({ instanceId: 'legacy-old' })

    assert.equal(launches.length, 1)
    assert.equal(launches[0].versionId, profileId, 'the installed loader profile must still be launched')
    assert.equal(launches[0].loader, 'fabric')

    const healed = JSON.parse(fs.readFileSync(path.join(directory, 'instance.json'), 'utf8'))
    assert.equal(healed.version, '1.20.1', 'version is the Minecraft version after migration')
    assert.equal(healed.versionId, profileId, 'the loader profile id moved to versionId')

    const indexed = (await core.instances.list()).find((entry) => entry.id === 'legacy-old')
    assert.equal(indexed.version, '1.20.1')
    assert.equal(indexed.versionId, profileId)

    await core.launchInstance({ instanceId: 'legacy-old' })
    assert.equal(launches[1].versionId, profileId)
    const stable = JSON.parse(fs.readFileSync(path.join(directory, 'instance.json'), 'utf8'))
    assert.equal(stable.version, '1.20.1')
    assert.equal(stable.versionId, profileId)
  } finally {
    fs.rmSync(appData, { recursive: true, force: true })
  }
})
