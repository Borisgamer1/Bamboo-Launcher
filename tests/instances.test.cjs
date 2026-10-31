/**
 * Phase 8 tests: instance lifecycle.
 *
 * All tests are offline: a temp game root with a minimal version JSON stands in
 * for an installed Minecraft version, and loader installation is injected.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createNullLogger } = require('../dist-electron/logger.js')
const { InstanceStore } = require('../dist-electron/instance-store.js')
const { InstanceManager, InstanceError, InstanceLocks, INSTANCE_LOCK_FILE } = require('../dist-electron/instances/index.js')

function seedVersion(gameRoot, versionId) {
  const dir = path.join(gameRoot, 'versions', versionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${versionId}.json`),
    JSON.stringify({ id: versionId, type: 'release', mainClass: 'net.minecraft.client.main.Main' }),
    'utf8',
  )
}

async function setup(label) {
  const base = tempDir(label)
  const gameRoot = path.join(base, 'game')
  const appData = path.join(base, 'appData')
  fs.mkdirSync(gameRoot, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  seedVersion(gameRoot, '1.20.1')
  const logger = createNullLogger()
  const store = new InstanceStore(path.join(appData, 'instances.json'), logger)
  await store.load()
  const manager = new InstanceManager({
    gameRoot: () => gameRoot,
    store,
    logger,
  })
  return { base, gameRoot, appData, store, manager }
}

test('create writes the layout, a relative index path and selects the first instance', async () => {
  const { base, gameRoot, manager } = await setup('create')
  try {
    const first = await manager.create({ name: 'My World', versionId: '1.20.1' })
    assert.equal(first.instance.managed, true)
    assert.equal(first.instance.path, path.join('instances', 'my-world'))
    assert.equal(first.directory, path.join(gameRoot, 'instances', 'my-world'))
    assert.equal(fs.existsSync(path.join(first.directory, 'instance.json')), true)
    for (const sub of ['mods', 'saves', 'config', 'resourcepacks', 'shaderpacks']) {
      assert.equal(fs.existsSync(path.join(first.directory, sub)), true, `${sub} folder`)
    }
    const file = JSON.parse(fs.readFileSync(path.join(first.directory, 'instance.json'), 'utf8'))
    assert.equal(file.name, 'My World')
    assert.equal(file.version, '1.20.1')
    assert.equal((await manager.list()).length, 1)
    assert.equal((await manager.get(first.instance.id)).instance.name, 'My World')

    // Same name twice must not collide on disk or in the index.
    const second = await manager.create({ name: 'My World', versionId: '1.20.1' })
    assert.notEqual(second.instance.id, first.instance.id)
    assert.equal(second.instance.folderName, 'my-world-2')
    assert.equal((await manager.list()).length, 2)
    const selected = await manager.list()
    assert.equal(selected.filter((entry) => entry.instance.id === first.instance.id).length, 1)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('duplicate hardlinks immutable mods and copies saves without touching the source', async () => {
  const { base, manager } = await setup('duplicate')
  try {
    const source = await manager.create({ name: 'Source', versionId: '1.20.1' })
    fs.mkdirSync(path.join(source.directory, 'mods'), { recursive: true })
    fs.writeFileSync(path.join(source.directory, 'mods', 'example.jar'), 'mod-bytes', 'utf8')
    fs.mkdirSync(path.join(source.directory, 'saves', 'world'), { recursive: true })
    fs.writeFileSync(path.join(source.directory, 'saves', 'world', 'level.dat'), 'level-1', 'utf8')
    fs.writeFileSync(path.join(source.directory, 'options.txt'), 'fov:0.5\n', 'utf8')

    const copy = await manager.duplicate(source.instance.id, { name: 'Copy' })
    const sourceMod = fs.statSync(path.join(source.directory, 'mods', 'example.jar'))
    const copyMod = fs.statSync(path.join(copy.directory, 'mods', 'example.jar'))
    assert.equal(copyMod.ino, sourceMod.ino, 'mod jar must share the inode')
    assert.ok(copyMod.nlink >= 2, 'hardlinked mod jar has at least two links')
    assert.equal(fs.readFileSync(path.join(copy.directory, 'mods', 'example.jar'), 'utf8'), 'mod-bytes')

    const sourceSave = fs.statSync(path.join(source.directory, 'saves', 'world', 'level.dat'))
    const copySave = fs.statSync(path.join(copy.directory, 'saves', 'world', 'level.dat'))
    assert.notEqual(copySave.ino, sourceSave.ino, 'saves must be independent')
    fs.writeFileSync(path.join(copy.directory, 'saves', 'world', 'level.dat'), 'level-2', 'utf8')
    assert.equal(
      fs.readFileSync(path.join(source.directory, 'saves', 'world', 'level.dat'), 'utf8'),
      'level-1',
      'editing the duplicate save must not change the source',
    )
    assert.equal(fs.readFileSync(path.join(copy.directory, 'options.txt'), 'utf8'), 'fov:0.5\n')

    const copyFile = JSON.parse(fs.readFileSync(path.join(copy.directory, 'instance.json'), 'utf8'))
    assert.equal(copyFile.name, 'Copy')
    assert.notEqual(copyFile.id, source.instance.id)
    assert.equal((await manager.list()).length, 2)
    assert.equal(fs.existsSync(path.join(copy.directory, INSTANCE_LOCK_FILE)), false)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('rename moves the managed folder and keeps the id stable', async () => {
  const { base, manager } = await setup('rename')
  try {
    const created = await manager.create({ name: 'Alpha', versionId: '1.20.1' })
    const renamed = await manager.rename(created.instance.id, 'Beta')
    assert.equal(renamed.instance.id, created.instance.id)
    assert.equal(renamed.instance.name, 'Beta')
    assert.equal(renamed.instance.folderName, 'beta')
    assert.equal(renamed.directory, path.join(base, 'game', 'instances', 'beta'))
    assert.equal(fs.existsSync(created.directory), false)
    assert.equal(fs.existsSync(path.join(renamed.directory, 'instance.json')), true)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(renamed.directory, 'instance.json'), 'utf8')).name,
      'Beta',
    )
    const stored = await manager.get(created.instance.id)
    assert.equal(stored.directory, renamed.directory)
    assert.equal(fs.existsSync(path.join(renamed.directory, INSTANCE_LOCK_FILE)), false)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('delete while an install holds the lock aborts cleanly and keeps every file', async () => {
  const { base, manager } = await setup('locked')
  try {
    const created = await manager.create({ name: 'Busy', versionId: '1.20.1' })
    const locks = new InstanceLocks(createNullLogger())
    const held = await locks.acquire(created.directory, {
      operation: 'install',
      instanceId: created.instance.id,
      pid: process.pid,
    })

    await assert.rejects(
      () => manager.delete(created.instance.id),
      (error) => error instanceof InstanceError && error.code === 'locked',
    )
    assert.equal(fs.existsSync(created.directory), true, 'folder must survive a blocked delete')
    assert.equal(fs.existsSync(path.join(created.directory, 'instance.json')), true)
    assert.equal((await manager.list()).length, 1)

    await locks.release(held)
    await manager.delete(created.instance.id)
    assert.equal(fs.existsSync(created.directory), false)
    assert.equal((await manager.list()).length, 0)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a stale lock (dead pid) is taken over instead of blocking delete', async () => {
  const { base, manager } = await setup('stale')
  try {
    const created = await manager.create({ name: 'Stale', versionId: '1.20.1' })
    fs.writeFileSync(
      path.join(created.directory, INSTANCE_LOCK_FILE),
      JSON.stringify({
        version: 1,
        owner: 'dead',
        pid: 999_999,
        operation: 'install',
        instanceId: created.instance.id,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
      }),
      'utf8',
    )
    await manager.delete(created.instance.id)
    assert.equal(fs.existsSync(created.directory), false)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('create resolves a loader through the injected installer and records loader metadata', async () => {
  const { base, gameRoot, manager } = await setup('loader')
  try {
    const calls = []
    const custom = await setup('loader-custom')
    const customManager = new InstanceManager({
      gameRoot: () => custom.gameRoot,
      store: custom.store,
      logger: createNullLogger(),
      loaderInstaller: async (kind, request) => {
        calls.push({ kind, request })
        seedVersion(custom.gameRoot, '1.20.1-fabric-0.15.11')
        return { versionId: '1.20.1-fabric-0.15.11' }
      },
    })
    const created = await customManager.create({
      name: 'Fabric World',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      minecraftVersion: '1.20.1',
    })
    assert.equal(created.instance.version, '1.20.1', 'version must stay the Minecraft version')
    assert.equal(created.instance.versionId, '1.20.1-fabric-0.15.11')
    const file = JSON.parse(fs.readFileSync(path.join(created.directory, 'instance.json'), 'utf8'))
    assert.equal(file.version, '1.20.1')
    assert.equal(file.versionId, '1.20.1-fabric-0.15.11')
    assert.equal(created.instance.loader, 'fabric')
    assert.equal(created.instance.loaderVersion, '0.15.11')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      kind: 'fabric',
      request: { minecraftVersion: '1.20.1', loaderVersion: '0.15.11' },
    })
    fs.rmSync(custom.base, { recursive: true, force: true })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('relocate rewrites absolute paths inside the old root and leaves managed records alone', async () => {
  const { base, gameRoot, store, manager } = await setup('relocate')
  try {
    const managed = await manager.create({ name: 'Managed', versionId: '1.20.1' })
    await store.upsert({
      id: 'external',
      name: 'External',
      folderName: 'external',
      managed: false,
      path: path.join(gameRoot, 'profiles', 'external'),
      version: '1.20.1',
      loader: 'vanilla',
      loaderVersion: '',
    })
    const nextRoot = path.join(base, 'moved-game')
    const changed = await manager.relocate(gameRoot, nextRoot)
    assert.equal(changed, 1)
    assert.equal((await manager.get('external')).directory, path.join(nextRoot, 'profiles', 'external'))
    assert.equal((await manager.get(managed.instance.id)).directory, managed.directory)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('create rejects invalid names and unknown versions', async () => {
  const { base, manager } = await setup('invalid')
  try {
    await assert.rejects(
      () => manager.create({ name: '   ', versionId: '1.20.1' }),
      (error) => error instanceof InstanceError && error.code === 'invalid-name',
    )
    await assert.rejects(
      () => manager.create({ name: 'Ghost', versionId: '9.9.9' }),
      (error) => error instanceof InstanceError && error.code === 'invalid-request',
    )
    await assert.rejects(
      () => manager.rename('missing-id', 'Nope'),
      (error) => error instanceof InstanceError && error.code === 'not-found',
    )
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
