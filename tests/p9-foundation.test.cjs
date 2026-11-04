/**
 * P9 foundation: instance-file ownership and the single launch facade.
 *
 * The tests use the compiled dist-electron surface, never Electron itself.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createCore } = require('../dist-electron/core.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { InstanceStore, normalizeJavaPath } = require('../dist-electron/instance-store.js')
const { InstanceManager } = require('../dist-electron/instances/index.js')
const { LaunchInstanceRequestSchema } = require('../dist-electron/schemas.js')
const { launchLegacyInstance } = require('../dist-electron/launch/legacy.js')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

test('P9: the automatic Java label is never treated as a Java executable', async () => {
  assert.equal(normalizeJavaPath('Automatisch'), '')
  assert.equal(normalizeJavaPath(' automatic '), '')
  assert.equal(normalizeJavaPath('C:\\Java\\bin\\java.exe'), 'C:\\Java\\bin\\java.exe')

  const base = tempDir('p9-java-label')
  try {
    const { store } = await managerFor(base)
    const imported = await store.importLegacyProfiles([{
      id: 'legacy-modpack',
      name: 'Legacy Modpack',
      folderName: 'legacy-modpack',
      version: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      javaPath: 'Automatisch',
    }], path.join(base, 'game'))
    assert.equal(imported, 1)
    const migrated = await store.get('legacy-modpack')
    assert.equal(migrated.javaPath, '')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('P9: a legacy launch repairs an instance that was migrated with the Java label', async () => {
  const patches = []
  const core = {
    instanceManager: {
      findByFolder: async () => ({ instance: { id: 'inst-legacy' } }),
      readFile: async () => ({
        id: 'inst-legacy',
        version: '1.20.1',
        versionId: 'fabric-loader-0.15.11-1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.11',
        javaPath: 'Automatisch',
        javaMode: 'pinned',
      }),
      updateFile: async (id, patch) => {
        patches.push({ id, patch })
        return { id, ...patch }
      },
    },
    instances: { upsert: async () => { throw new Error('unexpected adoption') } },
    launchInstance: async () => ({
      pid: 1,
      plan: {},
      exit: new Promise(() => undefined),
      kill: async () => undefined,
      killed: false,
      launchId: 'launch-java-label',
    }),
  }

  await launchLegacyInstance(core, {
    folderName: 'legacy',
    directory: 'C:\\game\\profiles\\legacy',
    name: 'Legacy',
    minecraftVersion: '1.20.1',
    versionId: 'fabric-loader-0.15.11-1.20.1',
    loader: 'fabric',
    loaderVersion: '0.15.11',
    javaPath: '',
  })

  assert.deepEqual(patches, [{
    id: 'inst-legacy',
    patch: { javaPath: '', javaMode: 'auto' },
  }])
})

test('P9: a copied legacy folder cannot launch the source version from its stale instance.json', async () => {
  const base = tempDir('p9-stale-copy')
  try {
    const { gameRoot, store, manager } = await managerFor(base)
    const directory = path.join(gameRoot, 'profiles', 'furry_smp_kopie')
    writeJson(path.join(directory, 'instance.json'), {
      id: 'legacy-furry-smp',
      name: 'Furry SMP',
      version: '26.3',
      versionId: 'fabric-loader-0.20.1-26.3',
      loader: 'fabric',
      loaderVersion: '0.20.1',
      javaPath: '',
      javaMode: 'auto',
      minMemory: 0,
      maxMemory: 8192,
      memoryMode: 'explicit',
      icon: '',
      group: '',
      lastPlayedAt: 0,
      playTimeMs: 0,
      createdAt: 1,
      updatedAt: 1,
    })

    let launchedRequest
    const handle = {
      pid: 1,
      plan: {},
      exit: new Promise(() => undefined),
      kill: async () => undefined,
      killed: false,
      launchId: 'launch-stale-copy',
    }
    await launchLegacyInstance({
      instanceManager: manager,
      instances: store,
      launchInstance: async (request) => {
        launchedRequest = request
        return handle
      },
    }, {
      folderName: 'furry_smp_kopie',
      directory,
      name: 'Furry SMP (Kopie)',
      minecraftVersion: '1.21.11',
      versionId: 'fabric-loader-0.20.1-1.21.11',
      loader: 'fabric',
      loaderVersion: '0.20.1',
      javaPath: '',
    })

    assert.equal(launchedRequest.instanceId, 'legacy-furry-smp-kopie')
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'instance.json'), 'utf8'))
    assert.equal(persisted.id, 'legacy-furry-smp-kopie')
    assert.equal(persisted.version, '1.21.11')
    assert.equal(persisted.versionId, 'fabric-loader-0.20.1-1.21.11')
    const record = await store.get('legacy-furry-smp-kopie')
    assert.equal(record.version, '1.21.11')
    assert.equal(record.versionId, 'fabric-loader-0.20.1-1.21.11')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

async function managerFor(base) {
  const gameRoot = path.join(base, 'game')
  const appData = path.join(base, 'appData')
  fs.mkdirSync(gameRoot, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  const store = new InstanceStore(path.join(appData, 'instances.json'), createNullLogger())
  await store.load()
  const manager = new InstanceManager({ gameRoot: () => gameRoot, store, logger: createNullLogger() })
  return { gameRoot, appData, store, manager }
}

test('P9: readFile normalizes legacy launch fields once and persists them', async () => {
  const base = tempDir('p9-file')
  try {
    const { gameRoot, store, manager } = await managerFor(base)
    const directory = path.join(gameRoot, 'instances', 'legacy')
    writeJson(path.join(directory, 'instance.json'), {
      id: 'inst-legacy',
      name: 'Legacy',
      version: '1.20.1',
      loader: 'vanilla',
      loaderVersion: '',
      javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
      minMemory: 1024,
      maxMemory: 4096,
      icon: '',
      group: '',
      lastPlayedAt: 0,
      playTimeMs: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.upsert({
      id: 'inst-legacy',
      name: 'Legacy',
      folderName: 'legacy',
      managed: true,
      path: 'instances/legacy',
      version: '1.20.1',
      loader: 'vanilla',
      loaderVersion: '',
      javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
      minMemory: 1024,
      maxMemory: 4096,
    })

    const file = await manager.readFile('inst-legacy')
    assert.equal(file.javaMode, 'pinned')
    assert.equal(file.memoryMode, 'explicit')
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'instance.json'), 'utf8'))
    assert.equal(persisted.javaMode, 'pinned')
    assert.equal(persisted.memoryMode, 'explicit')

    const updated = await manager.updateFile('inst-legacy', { maxMemory: 6144, javaMode: 'auto' })
    assert.equal(updated.maxMemory, 6144)
    assert.equal(updated.javaMode, 'auto')
    assert.equal((await store.get('inst-legacy')).maxMemory, 6144)
    assert.equal((await manager.findByFolder('legacy')).instance.id, 'inst-legacy')
    assert.equal(await manager.findByFolder('not-there'), undefined)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('P9: readFile clears a migrated automatic Java label instead of pinning it', async () => {
  const base = tempDir('p9-auto-java')
  try {
    const { gameRoot, store, manager } = await managerFor(base)
    const directory = path.join(gameRoot, 'instances', 'legacy-auto')
    writeJson(path.join(directory, 'instance.json'), {
      id: 'inst-auto',
      name: 'Legacy Auto',
      version: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      javaPath: 'Automatisch',
      javaMode: 'pinned',
      minMemory: 0,
      maxMemory: 0,
      icon: '',
      group: '',
      lastPlayedAt: 0,
      playTimeMs: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.upsert({
      id: 'inst-auto',
      name: 'Legacy Auto',
      folderName: 'legacy-auto',
      path: directory,
      version: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
    })

    const file = await manager.readFile('inst-auto')
    assert.equal(file.javaPath, '')
    assert.equal(file.javaMode, 'auto')
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'instance.json'), 'utf8'))
    assert.equal(persisted.javaPath, '')
    assert.equal(persisted.javaMode, 'auto')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('P9: legacy launch-game stores the loader profile id without overwriting the Minecraft version', async () => {
  const patches = []
  let launched
  const core = {
    instanceManager: {
      findByFolder: async () => ({ instance: { id: 'inst-legacy' } }),
      readFile: async () => ({
        id: 'inst-legacy',
        version: '1.20.1',
        loader: 'vanilla',
        loaderVersion: '',
      }),
      updateFile: async (id, patch) => {
        patches.push({ id, patch })
        return { id, ...patch }
      },
    },
    instances: {
      upsert: async () => {
        throw new Error('an indexed profile must not be adopted again')
      },
    },
    launchInstance: async (request, onEvent) => {
      launched = { request, onEvent }
      return { pid: 1, plan: {}, exit: new Promise(() => undefined), kill: async () => undefined, killed: false, launchId: 'launch-legacy' }
    },
  }
  const onEvent = () => undefined
  const handle = await launchLegacyInstance(
    core,
    {
      folderName: 'legacy',
      directory: 'C:\\game\\profiles\\legacy',
      name: 'Legacy',
      minecraftVersion: '1.20.1',
      versionId: 'fabric-loader-0.15.0-1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.0',
      server: { host: 'mc.example.net', port: 25566 },
    },
    onEvent,
  )

  assert.deepEqual(patches, [
    {
      id: 'inst-legacy',
      patch: {
        version: '1.20.1',
        versionId: 'fabric-loader-0.15.0-1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.0',
      },
    },
  ])
  assert.deepEqual(launched.request, {
    instanceId: 'inst-legacy',
    server: { host: 'mc.example.net', port: 25566 },
  })
  assert.equal(launched.onEvent, onEvent)
  assert.equal(handle.launchId, 'launch-legacy')
})

test('P9: launchInstance maps instance.json and keeps the facade typed', async () => {
  const base = tempDir('p9-core')
  try {
    const core = await createCore({
      appDataPath: base,
      legacyGameRoot: path.join(base, 'missing'),
      logger: createNullLogger(),
    })
    assert.equal(typeof core.launchInstance, 'function')
    assert.equal(typeof core.analyze, 'function')
    assert.equal(typeof core.applyFix, 'function')
    assert.equal(typeof core.undoFix, 'function')

    let captured
    core.instanceManager = {
      get: async (id) => ({ instance: { id }, directory: path.join(base, 'game', 'instances', 'demo') }),
      readFile: async () => ({
        id: 'inst-demo',
        name: 'Demo',
        version: '1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.0',
        javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
        javaMode: 'pinned',
        minMemory: 1024,
        maxMemory: 4096,
        memoryMode: 'explicit',
      }),
    }
    core.getLaunchIdentity = async () => ({
      name: 'Steve',
      uuid: '11112222333344445555666677778888',
      type: 'offline',
      accessToken: 'secret',
    })
    core.launch = {
      start: async (request) => {
        captured = request
        return {
          pid: 1234,
          plan: {},
          exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          launchId: 'launch-1',
        }
      },
    }

    const handle = await core.launchInstance(
      { instanceId: 'inst-demo', server: { host: 'mc.example.net', port: 25566 } },
      () => undefined,
    )
    assert.equal(handle.launchId, 'launch-1')
    assert.equal(captured.versionId, '1.20.1')
    assert.equal(captured.gameDirectory, path.join(base, 'game', 'instances', 'demo'))
    assert.equal(captured.javaPath, 'C:\\Java\\jdk-17\\bin\\java.exe')
    assert.equal(captured.minMemoryMb, 1024)
    assert.equal(captured.maxMemoryMb, 4096)
    assert.equal(captured.loader, 'fabric')
    assert.deepEqual(captured.server, { host: 'mc.example.net', port: 25566 })
    assert.equal(typeof captured.onEvent, 'function')

    const analysis = await core.analyze('inst-demo')
    assert.equal(analysis.instanceId, 'inst-demo')
    assert.deepEqual(analysis.findings, [])
    assert.equal((await core.applyFix('analysis-1', 'action-1')).code, 'INVALID')
    assert.equal((await core.undoFix('undo-1')).code, 'INVALID')

    assert.deepEqual(
      LaunchInstanceRequestSchema.parse({ instanceId: 'inst-demo' }),
      { instanceId: 'inst-demo' },
    )
    assert.throws(() =>
      LaunchInstanceRequestSchema.parse({
        instanceId: 'inst-demo',
        server: { host: 'mc.example.net', port: 65536 },
      }),
    )
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('P9: adopting a legacy loader profile stores both facts separately', async () => {
  let adopted
  let launched
  const core = {
    instanceManager: {
      findByFolder: async () => undefined,
      // The real manager falls back to the store record when the folder has no
      // instance.json yet. The adopted values therefore need no patch.
      readFile: async () => ({
        id: 'legacy-adopted',
        name: 'Adopted Fabric',
        version: '1.20.1',
        versionId: 'fabric-loader-0.15.0-1.20.1',
        loader: 'fabric',
        loaderVersion: '0.15.0',
        javaPath: '',
      }),
      updateFile: async () => {
        throw new Error('a matching new instance must not be patched')
      },
    },
    instances: {
      upsert: async (input) => {
        adopted = input
        return { id: 'legacy-adopted' }
      },
    },
    launchInstance: async (request) => {
      launched = request
      return {
        pid: 1,
        plan: {},
        exit: new Promise(() => undefined),
        kill: async () => undefined,
        killed: false,
        launchId: 'launch-adopted',
      }
    },
  }

  await launchLegacyInstance(core, {
    folderName: 'adopted',
    directory: 'C:\game\profiles\adopted',
    name: 'Adopted Fabric',
    minecraftVersion: '1.20.1',
    versionId: 'fabric-loader-0.15.0-1.20.1',
    loader: 'fabric',
    loaderVersion: '0.15.0',
  })

  assert.equal(adopted.version, '1.20.1')
  assert.equal(adopted.versionId, 'fabric-loader-0.15.0-1.20.1')
  assert.equal(adopted.loader, 'fabric')
  assert.equal(adopted.loaderVersion, '0.15.0')
  assert.equal(launched.instanceId, 'legacy-adopted')
})
