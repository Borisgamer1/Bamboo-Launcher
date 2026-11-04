/**
 * Global statistics ledger: a launch start/end cycle appends exactly one
 * session, the ledger lives outside the instance folders, and the enable flag
 * is honoured immediately.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { createNullLogger, createFileLogger } = require('../dist-electron/logger.js')
const { createCore } = require('../dist-electron/core.js')
const { LaunchTracker } = require('../dist-electron/launch-tracker.js')
const { StatisticsService, StatisticsStore } = require('../dist-electron/statistics.js')
const { collectInstanceGameStats } = require('../dist-electron/instances/worlds.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bamboo-${prefix}-`))
}

function createService(file, enabled) {
  const logger = createNullLogger()
  const store = new StatisticsStore(file, logger)
  return new StatisticsService(store, enabled, logger)
}

function writeWorldStats(worldDir, custom, mined = {}, used = {}, killed = {}) {
  const statsDir = path.join(worldDir, 'players', 'stats')
  fs.mkdirSync(statsDir, { recursive: true })
  fs.writeFileSync(
    path.join(statsDir, 'player.json'),
    JSON.stringify({
      stats: {
        'minecraft:custom': custom,
        'minecraft:mined': mined,
        'minecraft:used': used,
        'minecraft:killed': killed,
      },
    }),
    'utf8',
  )
}

function launchCycle(service, overrides = {}) {
  const logger = createNullLogger()
  const tracker = new LaunchTracker(logger, undefined, (session) => service.record(session))
  const handle = tracker.begin({
    version: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.9',
    instancePath: 'C:/BambooLaufwerk/instances/demo',
    instanceId: 'instance-demo',
    instanceName: 'Demo',
    javaPath: 'C:/Java/bin/javaw.exe',
    ...overrides,
  })
  return {
    startedAt: Date.now(),
    finish() {
      handle.finish({ exitCode: 0 })
      return handle
    },
  }
}

test('world statistics keep every distance type, missing keys count as zero and worlds are summed', (context) => {
  const saves = tempDir('world-stats')
  context.after(() => fs.rmSync(saves, { recursive: true, force: true }))

  writeWorldStats(
    path.join(saves, 'world-one'),
    {
      'minecraft:walk_one_cm': 100_000,
      'minecraft:sprint_one_cm': 50_000,
      'minecraft:crouch_one_cm': 1_000,
      'minecraft:swim_one_cm': 500,
      'minecraft:fly_one_cm': 2_000,
      'minecraft:climb_one_cm': 300,
      'minecraft:fall_one_cm': 400,
      'minecraft:walk_on_water_one_cm': 100,
      'minecraft:walk_under_water_one_cm': 200,
      'minecraft:aviate_one_cm': 600,
      'minecraft:minecart_one_cm': 7_000,
      'minecraft:boat_one_cm': 8_000,
      'minecraft:pig_one_cm': 900,
      'minecraft:horse_one_cm': 1_000,
      'minecraft:strider_one_cm': 1_100,
      'minecraft:happy_ghast_one_cm': 1_200,
      'minecraft:deaths': 2,
      'minecraft:jump': 7,
    },
    { 'minecraft:stone': 12, 'minecraft:dirt': 8 },
    { 'minecraft:stone': 5, 'minecraft:dirt': 3 },
    { 'minecraft:zombie': 4, 'minecraft:creeper': 1 },
  )
  writeWorldStats(
    path.join(saves, 'world-two'),
    {
      'minecraft:walk_one_cm': 5_000,
      'minecraft:sprint_one_cm': 1_000,
      'minecraft:deaths': 1,
      'minecraft:jump': 3,
    },
    { 'minecraft:sand': 2 },
    {},
    { 'minecraft:zombie': 1 },
  )

  const stats = collectInstanceGameStats(saves)
  assert.deepEqual(stats.distance, {
    walkCm: 105_000,
    sprintCm: 51_000,
    crouchCm: 1_000,
    swimCm: 500,
    flyCm: 2_000,
    climbCm: 300,
    fallCm: 400,
    walkOnWaterCm: 100,
    walkUnderWaterCm: 200,
    aviateCm: 600,
    minecartCm: 7_000,
    boatCm: 8_000,
    pigCm: 900,
    horseCm: 1_000,
    striderCm: 1_100,
    happyGhastCm: 1_200,
  })
  assert.equal(stats.blocksMined, 22)
  assert.equal(stats.blocksPlaced, 8)
  assert.equal(stats.mobsKilled, 6)
  assert.equal(stats.deaths, 3)
  assert.equal(stats.jumps, 10)
  assert.equal(stats.worlds, 2)
})

test('a finished launch appends one session to the global ledger', async (context) => {
  const dir = tempDir('stats')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'statistics.json')
  const service = createService(file, true)
  await service.load()

  const cycle = launchCycle(service)
  await wait(25)
  cycle.finish()
  await service.flush()

  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(ledger.version, 1)
  assert.equal(ledger.sessions.length, 1)
  assert.equal(ledger.sessions[0].instanceId, 'instance-demo')
  assert.equal(ledger.sessions[0].instanceName, 'Demo')
  assert.equal(ledger.sessions[0].version, '1.21.1')
  assert.equal(ledger.sessions[0].loader, 'fabric')
  assert.ok(ledger.sessions[0].durationMs >= 20, 'playtime must cover the session length')
  assert.equal(ledger.totals.sessions, 1)
  assert.equal(ledger.totals.playTimeMs, ledger.sessions[0].durationMs)
  assert.equal(ledger.totals.firstPlayedAt, ledger.sessions[0].startedAt)
  assert.equal(ledger.totals.lastPlayedAt, ledger.sessions[0].endedAt)

  // A second finish call for the same launch must not duplicate the entry.
  cycle.finish()
  await service.flush()
  const afterSecondFinish = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(afterSecondFinish.sessions.length, 1)
})

test('the settings save path flips the running statistics service immediately', async (context) => {
  const appData = tempDir('stats-core')
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    },
    logger: createFileLogger({ dir: path.join(appData, 'logs') }),
    fetchImpl: async () => {
      throw new Error('offline statistics test')
    },
  })

  assert.equal(core.paths.statisticsFile, path.join(appData, 'statistics.json'))
  assert.equal(core.statistics.enabled, true)
  await core.saveSettingsFromRenderer({ statisticsEnabled: false })
  assert.equal(core.statistics.enabled, false, 'the save path must switch tracking without a restart')
  await core.saveSettingsFromRenderer({ statisticsEnabled: true })
  assert.equal(core.statistics.enabled, true)
})

test('the summary combines ledger playtime with world objects and keeps playtime after deletion', async (context) => {
  const appData = tempDir('stats-summary')
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const gameRoot = path.join(appData, 'game')
  const worldDir = path.join(gameRoot, 'instances', 'demo', 'saves', 'world-one')
  fs.mkdirSync(path.join(worldDir, 'players', 'stats'), { recursive: true })
  fs.writeFileSync(
    path.join(worldDir, 'players', 'stats', 'player.json'),
    JSON.stringify({
      stats: {
        'minecraft:custom': {
          'minecraft:play_time': 2400,
          'minecraft:walk_one_cm': 100000,
          'minecraft:sprint_one_cm': 50000,
          'minecraft:crouch_one_cm': 1000,
          'minecraft:swim_one_cm': 500,
        },
        'minecraft:mined': { 'minecraft:stone': 12, 'minecraft:dirt': 8 },
        'minecraft:used': { 'minecraft:stone': 5, 'minecraft:dirt': 3 },
      },
    }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(appData, 'instances.json'),
    JSON.stringify({
      version: 1,
      selectedInstance: 'demo',
      instances: [
        {
          id: 'demo',
          name: 'Demo',
          folderName: 'demo',
          managed: true,
          version: '1.21.1',
          loader: 'vanilla',
          loaderVersion: '',
          javaPath: '',
          minMemory: 0,
          maxMemory: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    'utf8',
  )

  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    logger: createNullLogger(),
    fetchImpl: async () => {
      throw new Error('offline statistics test')
    },
  })
  await core.statistics.record({
    id: 's-1',
    instanceId: 'demo',
    instanceName: 'Demo',
    version: '1.21.1',
    loader: 'vanilla',
    loaderVersion: '',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    durationMs: 60_000,
  })
  await core.statistics.record({
    id: 's-2',
    instanceId: 'demo',
    instanceName: 'Demo',
    version: '1.21.1',
    loader: 'vanilla',
    loaderVersion: '',
    startedAt: 1_700_000_120_000,
    endedAt: 1_700_000_240_000,
    durationMs: 120_000,
  })
  await core.statistics.flush()

  const before = await core.getStatisticsSummary()
  assert.equal(before.playTimeMs, 180_000, 'playtime comes from the ledger')
  assert.equal(before.sessions, 2)
  assert.equal(before.blocksMined, 20)
  assert.equal(before.blocksPlaced, 8)
  assert.equal(before.distance.walkCm, 100_000)
  assert.equal(before.distance.sprintCm, 50_000)
  assert.equal(before.distance.crouchCm, 1_000)
  assert.equal(before.distance.swimCm, 500)
  assert.equal(before.distance.flyCm, 0, 'missing distance keys must count as zero')
  assert.equal(before.instances, 1)
  assert.equal(before.worlds, 1)

  await core.instanceManager.delete('demo')
  const after = await core.getStatisticsSummary()
  assert.equal(after.playTimeMs, 180_000, 'deleting the instance must not remove ledger playtime')
  assert.equal(after.sessions, 2)
  assert.equal(after.blocksMined, 0, 'world objects come from the instances that still exist')
  assert.equal(after.distance.walkCm, 0)
  assert.equal(after.instances, 0)
})

test('the summary splits world values per instance and uses the ledger for every playtime', async (context) => {
  const appData = tempDir('stats-per-instance')
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const gameRoot = path.join(appData, 'game')

  writeWorldStats(
    path.join(gameRoot, 'instances', 'demo', 'saves', 'world-one'),
    {
      'minecraft:walk_one_cm': 100_000,
      'minecraft:sprint_one_cm': 50_000,
      'minecraft:crouch_one_cm': 1_000,
      'minecraft:swim_one_cm': 500,
      'minecraft:fly_one_cm': 2_000,
      'minecraft:climb_one_cm': 300,
      'minecraft:fall_one_cm': 400,
      'minecraft:walk_on_water_one_cm': 100,
      'minecraft:walk_under_water_one_cm': 200,
      'minecraft:aviate_one_cm': 600,
      'minecraft:minecart_one_cm': 7_000,
      'minecraft:boat_one_cm': 8_000,
      'minecraft:pig_one_cm': 900,
      'minecraft:horse_one_cm': 1_000,
      'minecraft:strider_one_cm': 1_100,
      'minecraft:happy_ghast_one_cm': 1_200,
      'minecraft:deaths': 2,
      'minecraft:jump': 7,
    },
    { 'minecraft:stone': 12, 'minecraft:dirt': 8 },
    { 'minecraft:stone': 5, 'minecraft:dirt': 3 },
    { 'minecraft:zombie': 4, 'minecraft:creeper': 1 },
  )
  writeWorldStats(
    path.join(gameRoot, 'instances', 'demo', 'saves', 'world-two'),
    { 'minecraft:walk_one_cm': 5_000, 'minecraft:sprint_one_cm': 1_000, 'minecraft:deaths': 1, 'minecraft:jump': 3 },
    { 'minecraft:sand': 2 },
    {},
    { 'minecraft:zombie': 1 },
  )
  writeWorldStats(
    path.join(gameRoot, 'instances', 'second', 'saves', 'world-three'),
    {
      'minecraft:walk_one_cm': 3_000,
      'minecraft:fly_one_cm': 1_000,
      'minecraft:boat_one_cm': 400,
      'minecraft:deaths': 0,
      'minecraft:jump': 1,
    },
    { 'minecraft:stone': 2 },
    { 'minecraft:stone': 1 },
    { 'minecraft:skeleton': 2 },
  )

  const instance = (id, name, folderName) => ({
    id,
    name,
    folderName,
    managed: true,
    version: '1.21.1',
    loader: 'vanilla',
    loaderVersion: '',
    javaPath: '',
    minMemory: 0,
    maxMemory: 0,
    createdAt: 1,
    updatedAt: 1,
    playTimeMs: 999_999,
    sessionCount: 99,
  })
  fs.writeFileSync(
    path.join(appData, 'instances.json'),
    JSON.stringify({
      version: 1,
      selectedInstance: 'demo',
      instances: [instance('demo', 'Demo', 'demo'), instance('second', 'Zweite', 'second')],
    }),
    'utf8',
  )

  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    logger: createNullLogger(),
    fetchImpl: async () => {
      throw new Error('offline statistics test')
    },
  })
  for (const session of [
    { id: 'd-1', instanceId: 'demo', durationMs: 60_000, startedAt: 1_700_000_000_000 },
    { id: 'd-2', instanceId: 'demo', durationMs: 120_000, startedAt: 1_700_000_120_000 },
    { id: 's-1', instanceId: 'second', durationMs: 30_000, startedAt: 1_700_000_240_000 },
  ]) {
    await core.statistics.record({
      ...session,
      instanceName: session.instanceId === 'demo' ? 'Demo' : 'Zweite',
      version: '1.21.1',
      loader: 'vanilla',
      loaderVersion: '',
      endedAt: session.startedAt + session.durationMs,
    })
  }
  await core.statistics.flush()

  const summary = await core.getStatisticsSummary()
  assert.equal(summary.playTimeMs, 210_000)
  assert.equal(summary.sessions, 3)
  assert.deepEqual(summary.distance, {
    walkCm: 108_000,
    sprintCm: 51_000,
    crouchCm: 1_000,
    swimCm: 500,
    flyCm: 3_000,
    climbCm: 300,
    fallCm: 400,
    walkOnWaterCm: 100,
    walkUnderWaterCm: 200,
    aviateCm: 600,
    minecartCm: 7_000,
    boatCm: 8_400,
    pigCm: 900,
    horseCm: 1_000,
    striderCm: 1_100,
    happyGhastCm: 1_200,
  })
  assert.equal(summary.blocksMined, 24)
  assert.equal(summary.blocksPlaced, 9)
  assert.equal(summary.mobsKilled, 8)
  assert.equal(summary.deaths, 3)
  assert.equal(summary.jumps, 11)
  assert.equal(summary.instances, 2)
  assert.equal(summary.worlds, 3)

  const demo = summary.perInstance.find((entry) => entry.id === 'demo')
  const second = summary.perInstance.find((entry) => entry.id === 'second')
  assert.ok(demo && second)
  assert.equal(demo.playTimeMs, 180_000, 'per-instance playtime must come from the ledger, not the profile')
  assert.equal(demo.sessions, 2)
  assert.equal(demo.worlds, 2)
  assert.equal(demo.distance.walkCm, 105_000)
  assert.equal(demo.mobsKilled, 6)
  assert.equal(second.playTimeMs, 30_000)
  assert.equal(second.sessions, 1)
  assert.equal(second.worlds, 1)
  assert.equal(second.distance.flyCm, 1_000)
  assert.equal(second.distance.crouchCm, 0)
  assert.equal(second.distance.boatCm, 400)
  assert.equal(second.distance.minecartCm, 0)
})

test('the disabled switch writes nothing and a later enable records immediately', async (context) => {
  const dir = tempDir('stats-off')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'statistics.json')
  const service = createService(file, false)
  await service.load()

  launchCycle(service).finish()
  await service.flush()
  assert.equal(fs.existsSync(file), false, 'disabled tracking must not create the ledger')

  service.setEnabled(true)
  launchCycle(service).finish()
  await service.flush()

  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(ledger.sessions.length, 1, 'enabling must take effect for the next session')
  assert.ok(ledger.totals.playTimeMs >= 0)
})
