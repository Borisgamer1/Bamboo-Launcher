/**
 * Phase 6 hardening tests: the local counters (requests, cache hits/misses, hash
 * and download bytes, stage durations, error reasons) and the two rollback
 * switches, each in both directions.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, jar, sha1, tempDir } = require('./harness.cjs')

const {
  CurseForgeClient,
  MODS_ROLLBACK_ENV,
  ModContentStore,
  ModError,
  ModMetrics,
  ModrinthClient,
  ModrinthProvider,
  modsMetrics,
  modsMetricsSnapshot,
  modsRollback,
  resetModsMetrics,
  resolveModPlan,
} = require('../dist-electron/mods/index.js')
const { streamToFile } = require('../dist-electron/download/index.js')

const searchHit = (id) => ({
  project_id: `p${id}`,
  slug: `p${id}`,
  title: `P${id}`,
  description: 'a mod',
  project_type: 'mod',
  downloads: 10,
  follows: 2,
  versions: ['v1'],
  icon_url: 'https://example.invalid/icon.png',
})

const version = (id, projectId) => ({
  id,
  project_id: projectId,
  name: id,
  version_number: id,
  game_versions: ['1.20.1'],
  loaders: ['fabric'],
  date_published: '2026-01-01T00:00:00Z',
  version_type: 'release',
  files: [
    {
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      url: `https://example.invalid/${id}.jar`,
      filename: `${id}.jar`,
      primary: true,
      size: 64,
    },
  ],
  dependencies: [],
})

async function withEnv(env, work) {
  const previous = new Map()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await work()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the counters cover requests, cache hits, hash bytes and download bytes', async () => {
  const payload = jar({ 'fabric.mod.json': '{"id":"tele","version":"1"}' })
  const requests = []
  const server = await fixtureServer({
    '/search': (req, res) => {
      requests.push('search')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ hits: [searchHit(1), searchHit(2)], offset: 0, limit: 20, total_hits: 2 }),
      )
    },
    '/project/p1/version': (req, res) => {
      requests.push('versions')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([version('v1', 'p1')]),
      )
    },
    '/files/mod.jar': (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
      }).end(payload)
    },
  })
  const dir = tempDir('telemetry')
  try {
    const metrics = new ModMetrics()
    const provider = new ModrinthProvider(
      new ModrinthClient({ baseUrl: server.base, metrics, retry: { attempts: 1 } }),
      { cache: { metrics } },
    )

    await provider.search({ query: 'tele', projectType: 'mod', limit: 20 })
    const cold = metrics.snapshot()
    assert.equal(cold.requests, 1, 'one API call')
    assert.equal(cold.cacheMisses, 1)
    assert.equal(cold.cacheHits, 0)
    assert.equal(cold.stages['provider-load'].count, 1)

    await provider.search({ query: 'tele', projectType: 'mod', limit: 20 })
    const warm = metrics.snapshot()
    assert.equal(warm.requests, 1, 'the cache answered without a request')
    assert.equal(warm.cacheHits, 1)
    assert.equal(warm.cacheHitRate, 0.5)
    assert.equal(warm.stages['provider-load'].count, 1, 'no second load')

    await provider.search({ query: 'tele', projectType: 'mod', limit: 20 }, { bypassCache: true })
    const bypassed = metrics.snapshot()
    assert.equal(bypassed.requests, 2, 'bypassing the cache costs a request')
    assert.equal(bypassed.stages['provider-load'].count, 2)

    await provider.versions('p1', { minecraftVersion: '1.20.1', loader: 'fabric' })
    await provider.versions('p1', { minecraftVersion: '1.20.1', loader: 'fabric' })
    const versions = metrics.snapshot()
    assert.equal(versions.requests, 3)
    assert.equal(requests.filter((entry) => entry === 'versions').length, 1, 'metadata is cached')

    // Hash bytes: the content store hashes a file once and reports its size.
    const store = new ModContentStore({ root: dir, metrics })
    const source = path.join(dir, 'source.jar')
    fs.writeFileSync(source, payload)
    await store.adopt(source, { sha1: sha1(payload) })
    const adopted = metrics.snapshot()
    assert.equal(adopted.hashBytes, payload.length)
    await store.adopt(source, { sha1: sha1(payload) })
    assert.equal(
      metrics.snapshot().hashBytes,
      payload.length * 2,
      'a second adopt hashes again and is counted again',
    )

    // Download bytes: the streaming pipeline reports every chunk it writes.
    const to = path.join(dir, 'downloaded.jar')
    await streamToFile({
      urls: [`${server.base}/files/mod.jar`],
      destination: to,
      expected: { sha1: sha1(payload), size: payload.length },
      onProgress: (bytes) => metrics.downloadBytes(bytes),
    })
    assert.equal(metrics.snapshot().downloadBytes, payload.length)
    assert.deepEqual(fs.readFileSync(to), payload)

    metrics.reset()
    const cleared = metrics.snapshot()
    assert.equal(cleared.requests, 0)
    assert.equal(cleared.hashBytes, 0)
    assert.deepEqual(cleared.stages, {})
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the process-wide metrics are filled by the real paths without any injection', async () => {
  const payload = jar({ 'fabric.mod.json': '{"id":"default-metrics","version":"1"}' })
  const fileSha1 = sha1(payload)
  const dir = tempDir('default-telemetry')
  let server
  server = await fixtureServer({
    '/search': JSON.stringify({
      hits: [searchHit(1)],
      offset: 0,
      limit: 20,
      total_hits: 1,
    }),
    '/v1/mods/7/files/1001': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: 1001,
            modId: 7,
            displayName: 'tele-1.0.jar',
            fileName: 'tele-1.0.jar',
            fileLength: payload.length,
            // Nothing in the metadata: the client has to ask for a URL.
            downloadUrl: null,
            gameVersions: ['1.20.1', 'Fabric'],
            hashes: [{ algo: 1, value: fileSha1 }],
            dependencies: [],
            releaseType: 1,
            fileDate: '2026-01-01T00:00:00Z',
          },
        }),
      )
    },
    '/v1/mods/7/files/1001/download-url': () =>
      JSON.stringify({ data: `${server.base}/files/tele-1.0.jar` }),
    '/files/tele-1.0.jar': payload,
  })
  try {
    resetModsMetrics()

    // Modrinth: one request, then the same query answered by the cache.
    const provider = new ModrinthProvider(
      new ModrinthClient({ baseUrl: server.base, retry: { attempts: 1 } }),
    )
    await provider.search({ query: 'tele', projectType: 'mod', limit: 20 })
    await provider.search({ query: 'tele', projectType: 'mod', limit: 20 })

    // CurseForge: file metadata, URL resolution and the streaming transfer.
    const client = new CurseForgeClient({ apiKey: 'test-key', baseUrl: `${server.base}/v1` })
    const file = await client.file(7, 1001)
    const destination = path.join(dir, 'tele-1.0.jar')
    const downloaded = await client.download(file, destination)
    assert.equal(downloaded.bytes, payload.length)

    // Store: the downloaded file is hashed once more on its way in.
    const store = new ModContentStore({ root: path.join(dir, 'store') })
    await store.adopt(destination)

    const snapshot = modsMetricsSnapshot()
    const apiCalls = [...server.hits.entries()]
      .filter(([route]) => route === '/search' || route.startsWith('/v1/'))
      .reduce((total, [, count]) => total + count, 0)

    assert.equal(snapshot.requests, apiCalls, 'every API call is counted, and nothing else is')
    assert.equal(snapshot.requests, 3, 'one search, one file lookup, one URL resolution')
    assert.equal(snapshot.cacheHits, 1, 'the repeated search came from the cache')
    assert.equal(snapshot.cacheMisses, 1)
    assert.equal(snapshot.downloadBytes, payload.length, 'the transfer reports what it wrote')
    assert.equal(
      snapshot.hashBytes,
      payload.length * 2,
      'the transfer hashed the body once and the store hashed the file once',
    )
    assert.equal(snapshot.stages['download'].count, 1)
    assert.equal(snapshot.stages['provider-load'].count, 1)
    assert.ok(snapshot.stages['download'].totalMs >= 0)
    assert.ok(snapshot.stages['download'].maxMs >= 0)

    // The accessor reads the same owner the paths wrote into, with no IPC in between.
    assert.deepEqual(snapshot, modsMetrics.snapshot())
  } finally {
    resetModsMetrics()
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stage durations and error reasons are recorded', async () => {
  const server = await fixtureServer({
    '/project/p404/version': (req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"missing"}')
    },
  })
  try {
    const metrics = new ModMetrics()
    const provider = new ModrinthProvider(
      new ModrinthClient({ baseUrl: server.base, metrics, retry: { attempts: 1 } }),
      { cache: { metrics } },
    )
    // A refused request arrives as the download layer's error class; what matters
    // for the counters is that its reason is classified, not the class itself.
    await assert.rejects(
      () => provider.versions('p404', { minecraftVersion: '1.20.1', loader: 'fabric' }),
      (error) => error.code === 'http-error',
    )
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.stages['provider-load'].count, 1)
    assert.ok(snapshot.stages['provider-load'].totalMs >= 0)
    assert.equal(snapshot.byCode['http-error'], 1, 'the failure reason is counted')

    // Measured stages keep their own numbers instead of one aggregate.
    await metrics.measure('bench:noop', async () => undefined)
    assert.equal(metrics.snapshot().stages['bench:noop'].count, 1)
  } finally {
    await server.close()
  }
})

test('the rollback switches only react to their off-values', () => {
  assert.deepEqual(modsRollback({}), { resolver: false, store: false })
  assert.deepEqual(
    modsRollback({ [MODS_ROLLBACK_ENV.resolver]: 'legacy', [MODS_ROLLBACK_ENV.store]: 'LEGACY' }),
    { resolver: true, store: true },
  )
  assert.deepEqual(
    modsRollback({ [MODS_ROLLBACK_ENV.resolver]: '  off  ', [MODS_ROLLBACK_ENV.store]: '0' }),
    { resolver: true, store: true },
  )
  for (const value of ['', 'v2', 'yes', 'nonsense', 'true']) {
    assert.deepEqual(
      modsRollback({ [MODS_ROLLBACK_ENV.resolver]: value }),
      { resolver: false, store: false },
      `${JSON.stringify(value)} must not disable the resolver`,
    )
  }
  assert.equal(MODS_ROLLBACK_ENV.resolver, 'BAMBOO_MODS_RESOLVER')
  assert.equal(MODS_ROLLBACK_ENV.store, 'BAMBOO_MODS_STORE')
})

class FakeProvider {
  id = 'modrinth'

  constructor(projects) {
    this.projects = projects
  }

  async versions(projectId) {
    return this.projects[projectId] ?? []
  }

  async version(_projectId, versionId) {
    return Object.values(this.projects)
      .flat()
      .find((entry) => entry.id === versionId)
  }

  async project(projectId) {
    return { id: projectId, slug: projectId, title: projectId, provider: 'modrinth' }
  }
}

test('the resolver kill switch refuses loudly while the default still plans', async () => {
  const projects = {
    A: [
      {
        id: 'a1',
        projectId: 'A',
        name: 'A',
        versionNumber: 'a1',
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
        files: [{ filename: 'a1.jar', url: 'https://example.invalid/a1.jar' }],
        dependencies: [{ projectId: 'B', type: 'required' }],
        publishedAt: '2026-01-01T00:00:00Z',
        channel: 'release',
      },
    ],
    B: [
      {
        id: 'b1',
        projectId: 'B',
        name: 'B',
        versionNumber: 'b1',
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
        files: [{ filename: 'b1.jar', url: 'https://example.invalid/b1.jar' }],
        dependencies: [],
        publishedAt: '2026-01-01T00:00:00Z',
        channel: 'release',
      },
    ],
  }
  const plan = () =>
    resolveModPlan({
      provider: new FakeProvider(projects),
      projectId: 'A',
      target: { minecraftVersion: '1.20.1', loader: 'fabric' },
      now: () => 1,
    })

  const planned = await plan()
  assert.equal(planned.resolverVersion, 1)
  assert.equal(planned.install.length, 1)

  await withEnv({ [MODS_ROLLBACK_ENV.resolver]: 'legacy' }, async () => {
    await assert.rejects(
      () => plan(),
      (error) => error instanceof ModError && error.code === 'resolver-disabled',
    )
    // The same switch as an explicit option, for a caller that is not the app.
    await assert.rejects(
      () =>
        resolveModPlan({
          provider: new FakeProvider(projects),
          projectId: 'A',
          target: { minecraftVersion: '1.20.1', loader: 'fabric' },
          now: () => 1,
          disabled: true,
        }),
      (error) => error instanceof ModError && error.code === 'resolver-disabled',
    )
  })
  const after = await plan()
  assert.equal(after.install.length, 1, 'the switch is back off after the environment is restored')
})

test('the store rollback serves by copy instead of sharing inodes, without losing objects', async () => {
  const dir = tempDir('rollback-store')
  try {
    const payload = jar({ 'fabric.mod.json': '{"id":"switch","version":"1"}' })
    const source = path.join(dir, 'source.jar')
    fs.writeFileSync(source, payload)
    const instanceDir = path.join(dir, 'instance')
    fs.mkdirSync(instanceDir, { recursive: true })

    const shared = new ModContentStore({ root: path.join(dir, 'shared') })
    const adoptedShared = await shared.adopt(source, { sha1: sha1(payload) })
    const sharedTarget = path.join(instanceDir, 'shared.jar')
    const sharedMode = await shared.materialize(adoptedShared.sha512, sharedTarget)
    assert.notEqual(sharedMode, 'copy', 'the default store shares the inode where it can')
    assert.ok(fs.statSync(sharedTarget).nlink >= 2, 'the placed file is a link, not a copy')
    assert.equal(
      fs.statSync(sharedTarget).ino,
      fs.statSync(shared.objectPath(adoptedShared.sha512)).ino,
      'the instance file and the stored object are the same inode',
    )

    // The environment drives the same switch the option exposes.
    await withEnv({ [MODS_ROLLBACK_ENV.store]: 'legacy' }, async () => {
      const copyOnly = new ModContentStore({ root: path.join(dir, 'copied') })
      const adopted = await copyOnly.adopt(source, { sha1: sha1(payload) })
      assert.equal(adopted.link, 'copy', 'adopt keeps its hands off the inode too')
      const mode = await copyOnly.materialize(adopted.sha512, path.join(instanceDir, 'copied.jar'))
      assert.equal(mode, 'copy')
      assert.equal(fs.statSync(path.join(instanceDir, 'copied.jar')).nlink, 1)
      assert.equal(await copyOnly.has(adopted.sha512), true, 'the object is still stored')
      assert.deepEqual(fs.readFileSync(path.join(instanceDir, 'copied.jar')), payload)
    })
    assert.deepEqual(fs.readFileSync(path.join(instanceDir, 'shared.jar')), payload)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
