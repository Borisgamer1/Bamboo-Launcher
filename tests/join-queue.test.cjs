/**
 * P12 cold-start queue + hash-to-launch handoff (spec §4.4/§4.10).
 *
 * The queue is versioned, persists before delivery, flushes exactly once after
 * `uiReady`, and keeps only the newest link per target. A pack is hashed before
 * an offer exists; a mismatch never reaches the launch path.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, tempDir } = require('./harness.cjs')
const { createCore } = require('../dist-electron/core.js')
const { createNullLogger } = require('../dist-electron/logger.js')

const {
  JoinQueue,
  JoinService,
  PENDING_JOIN_FILE,
  PENDING_JOIN_TTL_MS,
  buildJoinUrl,
  parseJoinUrl,
} = require('../dist-electron/join/index.js')

function payload(overrides = {}) {
  const parsed = parseJoinUrl(
    buildJoinUrl({
      v: 1,
      host: 'play.example.com',
      profile: 'inst-1',
      ...overrides,
    }),
  )
  assert.equal(parsed.ok, true)
  return parsed.payload
}

function runtime(launchCalls, instance = { id: 'inst-1', name: 'Demo' }) {
  return {
    instances: {
      get: async (id) => {
        if (id !== instance.id) throw new Error('not found')
        return { instance, directory: path.join('game', 'instances', id) }
      },
      readFile: async (id) => ({
        id,
        name: instance.name,
        version: '1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.0',
        javaMode: 'pinned',
        javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
        minMemory: 1024,
        maxMemory: 6144,
        memoryMode: 'explicit',
      }),
    },
    launch: async (request) => {
      launchCalls.push(request)
      return { launchId: 'launch-join', pid: 4242 }
    },
  }
}

test('P12 queue: a cold-start link survives a restart and flushes once', async () => {
  const root = tempDir('p12-cold-start')
  try {
    const firstDelivered = []
    const first = new JoinService({
      appDataPath: root,
      deliver: (entry) => firstDelivered.push(entry),
      runtime: async () => runtime([]),
    })
    const link = buildJoinUrl({ v: 1, host: 'play.example.com', profile: 'inst-1', name: 'Cold Start' })
    const received = await first.receive(link)
    assert.deepEqual(received, {
      ok: true,
      payload: {
        v: 1,
        host: 'play.example.com',
        port: 25565,
        profile: 'inst-1',
        name: 'Cold Start',
      },
      queued: true,
    })
    assert.equal(firstDelivered.length, 0)
    assert.ok(fs.existsSync(path.join(root, PENDING_JOIN_FILE)))

    const delivered = []
    const second = new JoinService({
      appDataPath: root,
      deliver: (entry) => delivered.push(entry),
      runtime: async () => runtime([]),
    })
    const ready = await second.uiReady()
    assert.deepEqual(ready, { delivered: 1 })
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].name, 'Cold Start')
    assert.deepEqual((await second.uiReady()), { delivered: 0, already: true })
    assert.equal(delivered.length, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PENDING_JOIN_FILE), 'utf8')), {
      version: 1,
      entries: [],
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P12 queue: same target keeps only the newest link; another target survives', async () => {
  const root = tempDir('p12-supersede')
  try {
    let now = 1_000
    const queue = new JoinQueue({ file: path.join(root, PENDING_JOIN_FILE), now: () => now })
    await queue.enqueue(payload({ name: 'old' }), 1_000)
    await queue.enqueue(payload({ name: 'new' }), 2_000)
    now = 3_000
    await queue.enqueue(payload({ host: 'other.example.com', profile: 'inst-2', name: 'other' }), 3_000)
    const flushed = await queue.flush()
    assert.equal(flushed.rejected, undefined)
    assert.deepEqual(flushed.entries.map((entry) => entry.payload.name), ['new', 'other'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P12 queue: TTL expires old entries and a queue file caps at five', async () => {
  const root = tempDir('p12-ttl-cap')
  try {
    let now = 5_000
    const queue = new JoinQueue({ file: path.join(root, PENDING_JOIN_FILE), now: () => now })
    await queue.enqueue(payload({ name: 'expired' }), 5_000)
    now = 5_000 + PENDING_JOIN_TTL_MS + 1
    await queue.enqueue(payload({ host: 'fresh.example.com', name: 'fresh' }), now)
    const first = await queue.flush()
    assert.deepEqual(first.entries.map((entry) => entry.payload.name), ['fresh'])

    for (let index = 0; index < 6; index += 1) {
      await queue.enqueue(
        payload({ host: `server-${index}.example.com`, profile: `inst-${index}`, name: `n${index}` }),
        now + index,
      )
    }
    const second = await queue.flush()
    assert.deepEqual(
      second.entries.map((entry) => entry.payload.name),
      ['n1', 'n2', 'n3', 'n4', 'n5'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P12 queue: version 2 is discarded with join.rejected-grammar, never migrated', async () => {
  const root = tempDir('p12-superseded')
  try {
    const file = path.join(root, PENDING_JOIN_FILE)
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        entries: [{ payload: payload({ name: 'old-format' }), receivedAt: 1 }],
      }),
      'utf8',
    )
    const queue = new JoinQueue({ file })
    const flushed = await queue.flush()
    assert.equal(flushed.rejected, 'join.rejected-grammar')
    assert.deepEqual(flushed.entries, [])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, entries: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P12 hash: matching pack reaches LauncherCore.launchInstance; a replaced pack does not', async () => {
  const root = tempDir('p12-hash')
  const bytes = Buffer.from('pack-manifest-bytes')
  const server = await fixtureServer({ '/pack': bytes })
  try {
    const sha1 = require('node:crypto').createHash('sha1').update(bytes).digest('hex')
    const packUrl = 'https://cdn.modrinth.com/data/demo/versions/1/pack.mrpack'
    const link = buildJoinUrl({
      v: 1,
      host: 'play.example.com',
      profile: 'inst-1',
      pack: packUrl,
      sha1,
    })
    const parsed = parseJoinUrl(link)
    assert.equal(parsed.ok, true)

    const core = await createCore({
      appDataPath: path.join(root, 'app'),
      legacyGameRoot: path.join(root, 'missing'),
      logger: createNullLogger(),
    })
    let launched
    core.instanceManager = {
      get: async (id) => ({ instance: { id }, directory: path.join(root, 'instances', id) }),
      readFile: async (id) => ({
        id,
        name: 'Demo',
        version: '1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.0',
        javaMode: 'pinned',
        javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
        minMemory: 1024,
        maxMemory: 6144,
        memoryMode: 'explicit',
      }),
      updateFile: async () => ({}),
    }
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async (request) => {
        launched = request
        return {
          pid: 4242,
          plan: {},
          exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          launchId: 'launch-join',
        }
      },
    }

    const service = new JoinService({
      appDataPath: root,
      deliver: () => undefined,
      runtime: async () => ({
        instances: core.instanceManager,
        launch: (request, onEvent) => core.launchInstance(request, onEvent),
      }),
      fetchImpl: async (url, init) => fetch(`${server.base}/pack`, init),
    })
    const prepared = await service.prepare(parsed.payload)
    assert.equal(prepared.ok, true)
    assert.equal(prepared.offer.kind, 'launch')
    assert.equal(prepared.offer.instance.id, 'inst-1')
    assert.deepEqual(prepared.offer.pack, { url: packUrl, sha1, size: bytes.length })
    assert.equal(launched, undefined, 'prepare must not launch')

    const confirmed = await service.confirm(prepared.offer.id)
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.launchId, 'launch-join')
    assert.equal(launched.gameDirectory, path.join(root, 'instances', 'inst-1'))
    assert.deepEqual(launched.server, { host: 'play.example.com', port: 25565 })
    assert.equal(launched.maxMemoryMb, 6144)
    assert.equal(launched.javaPath, 'C:\\Java\\jdk-17\\bin\\java.exe')
    assert.equal(launched.loader, 'fabric')
    assert.equal((await service.confirm(prepared.offer.id)).code, 'join.offer-expired')

    server.routes['/pack'] = Buffer.from('replaced-manifest')
    const replaced = new JoinService({
      appDataPath: root,
      deliver: () => undefined,
      runtime: async () => ({
        instances: core.instanceManager,
        launch: (request, onEvent) => core.launchInstance(request, onEvent),
      }),
      fetchImpl: async (url, init) => fetch(`${server.base}/pack`, init),
    })
    const rejected = await replaced.prepare(parsed.payload)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'join.rejected-hash')
    assert.deepEqual(launched.server, { host: 'play.example.com', port: 25565 }, 'a hash rejection never replaces the launch request')
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P12 profile: a missing profile becomes a create offer and never auto-launches', async () => {
  const root = tempDir('p12-create-offer')
  try {
    const launchCalls = []
    const service = new JoinService({
      appDataPath: root,
      deliver: () => undefined,
      runtime: async () => runtime(launchCalls),
    })
    const prepared = await service.prepare(payload({ profile: 'deleted-instance' }))
    assert.equal(prepared.ok, true)
    assert.equal(prepared.offer.kind, 'create-vanilla')
    assert.equal(prepared.offer.reason, 'join.profile-create-offer')
    const confirmed = await service.confirm(prepared.offer.id)
    assert.equal(confirmed.ok, false)
    assert.equal(confirmed.code, 'join.profile-create-offer')
    assert.deepEqual(launchCalls, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
