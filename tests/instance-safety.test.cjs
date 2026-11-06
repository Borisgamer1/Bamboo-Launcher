/**
 * Instance-list and instance-folder safety.
 *
 * profiles.json has one owner (`electron/instances/profile-registry`), so these
 * probes exercise that module directly: atomic replace, quarantine of an
 * unreadable copy, and the size patch that must never add or drop entries.
 * The remaining assertions are static because the handlers need a live ipcMain.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const mainSource = () => fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const profileSource = () =>
  fs.readFileSync(path.join(ROOT, 'electron', 'legacy', 'profile-ipc.ts'), 'utf8')
const registryModule = () => require(path.join(ROOT, 'dist-electron', 'instances', 'profile-registry.js'))
const instanceFiles = () =>
  require(path.join(ROOT, 'dist-electron', 'legacy', 'instance-files.js')).createInstanceFiles({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resolveGameRoot: async () => '',
    getCore: async () => null,
  })

function tempRoot(name) {
  const dir = path.join(os.tmpdir(), `bamboo-${name}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function handlerOf(channel) {
  for (const file of [
    'main.js',
    path.join('electron', 'legacy', 'profile-ipc.ts'),
    path.join('electron', 'legacy', 'content-ipc.ts'),
    path.join('electron', 'legacy', 'launch-ipc.ts'),
    path.join('electron', 'legacy', 'shortcut-ipc.ts'),
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const start = Math.max(
      source.indexOf(`ipc.handle('${channel}'`),
      source.indexOf(`ipc.on('${channel}'`),
    )
    if (start < 0) continue
    const end = source.indexOf('\n});', start) < 0
      ? source.indexOf('\n  })', start)
      : source.indexOf('\n});', start)
    assert.ok(end > start, `${channel} handler must close`)
    return source.slice(start, end)
  }
  assert.fail(`${channel} handler must exist`)
}

test('profiles.json is replaced through a temp file, never in place', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-atomic')
  const registry = profileRegistry(root)

  registry.write([{ id: 'a', name: 'A', folderName: 'a' }])
  registry.write([{ id: 'b', name: 'B', folderName: 'b' }])

  const written = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'b')
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'no temp file may survive a write')
})

test('a corrupt profiles.json is quarantined before anyone writes an empty list', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-corrupt')
  const target = path.join(root, 'profiles.json')
  const corrupt = '[{"id":"a","name":"A"'
  fs.writeFileSync(target, corrupt)

  const registry = profileRegistry(root)
  assert.deepEqual(registry.read(), [])

  const quarantine = fs.readdirSync(root).filter((name) => name.startsWith('profiles.json.corrupt-'))
  assert.equal(quarantine.length, 1, 'the unreadable file must be kept')
  assert.equal(fs.readFileSync(path.join(root, quarantine[0]), 'utf8'), corrupt)

  registry.write([])
  assert.equal(fs.readFileSync(path.join(root, quarantine[0]), 'utf8'), corrupt)
})

test('legacy list locations are read by the registry, not by the handler', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-fallback')
  const profilesDir = path.join(root, 'profiles')
  fs.mkdirSync(profilesDir)
  fs.writeFileSync(
    path.join(profilesDir, 'profiles.json'),
    JSON.stringify([{ id: 'b', name: 'B', folderName: 'b' }]),
  )
  fs.writeFileSync(
    path.join(profilesDir, 'a.json'),
    JSON.stringify({ id: 'a', name: 'A', folderName: 'a' }),
  )

  assert.deepEqual(
    profileRegistry(root).readWithFallback().map((profile) => profile.folderName),
    ['b'],
    'the nested list wins over single profile files',
  )
  fs.renameSync(path.join(profilesDir, 'profiles.json'), path.join(root, 'moved.json'))
  assert.deepEqual(
    profileRegistry(root).readWithFallback().map((profile) => profile.folderName),
    ['a'],
    'single profile files are still found',
  )
  assert.match(profileSource(), /readWithFallback\(\)/)
})

test('a save that lands during the size measurement survives the patch', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-patch')
  const registry = profileRegistry(root)

  registry.write([{ id: 'a', name: 'A', folderName: 'a', size: '0 B' }])
  // Measured before the concurrent save, patched afterwards.
  const measured = new Map([['a', '2.0 KB']])
  registry.write([
    { id: 'a', name: 'A', folderName: 'a', size: '0 B' },
    { id: 'new', name: 'Neu', folderName: 'new', size: '0 B' },
  ])
  assert.equal(registry.patchSizes(measured), true)

  const ids = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8')).map((p) => p.id)
  assert.deepEqual(ids, ['a', 'new'], 'the patch may not drop the new entry')
})

test('the size patch never adds an entry for a folder that is not listed', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-patch-missing')
  const registry = profileRegistry(root)
  registry.write([{ id: 'a', name: 'A', folderName: 'a', size: '0 B' }])

  registry.patchSizes(new Map([['ghost', '9.9 GB']]))
  const list = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
  assert.deepEqual(list.map((p) => p.id), ['a'])
})

test('containment uses a separator, not a raw prefix', () => {
  const { isInsideDirectory } = instanceFiles()
  const root = path.join(path.sep, 'game')
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles', 'a')), true)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles')), false)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles-x', 'a')), false)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles', '..', 'x')), false)
})

test('main.js owns no profiles.json logic of its own', () => {
  const source = mainSource()
  assert.match(source, /require\('\.\/dist-electron\/instances\/profile-registry\.js'\)/)
  for (const gone of ['JSON.stringify(profiles, null, 2)', 'quarantineProfilesFile', 'profiles.json.corrupt-']) {
    assert.equal(source.includes(gone), false, `${gone} must live in the registry`)
  }
  assert.equal(source.includes('getFolderSize'), false, 'the sync folder walk must stay deleted')
  const sizes = fs.readFileSync(path.join(ROOT, 'electron', 'legacy', 'instance-sizes.ts'), 'utf8')
  assert.match(sizes, /patchSizes\(/, 'sizes are patched onto the current list')
})

test('save-profiles no longer walks instance folders', () => {
  const handler = handlerOf('save-profiles')
  assert.doesNotMatch(handler, /measureFolderBytes\(/, 'the save path must not measure')
  assert.match(profileSource(), /scheduleInstanceSizeRefresh\(rootPath\)/)
})

test('saving the visible list copies name, version and loader into the core', async () => {
  const { createInstanceFiles } = require(path.join(
    ROOT,
    'dist-electron',
    'legacy',
    'instance-files.js',
  ))
  const silent = { debug() {}, info() {}, warn() {}, error() {} }
  const records = [
    { id: 'a', folderName: 'a', name: 'Alt', version: '1.20.1', loader: 'fabric', loaderVersion: '0.1' },
    { id: 'same', folderName: 'same', name: 'Gleich', version: '1.21.1', loader: 'forge', loaderVersion: '' },
    { id: 'keep', folderName: 'keep', name: 'Keep', version: '1.20.1', loader: 'quilt', loaderVersion: '0.24' },
  ]
  const upserts = []
  const files = createInstanceFiles({
    logger: silent,
    resolveGameRoot: async () => path.join(os.tmpdir(), 'bamboo-core-sync'),
    getCore: async () => ({
      instanceManager: {
        findByFolder: async (folder) => {
          const record = records.find((entry) => entry.folderName === folder)
          return record ? { instance: record } : undefined
        },
      },
      instances: {
        list: async () => records,
        upsert: async (record) => { upserts.push(record) },
      },
    }),
  })

  await files.syncCoreInstances([
    { id: 'a', name: 'Neu', folderName: 'a', version: '1.21.1', loader: 'Fabric', loaderVersion: '0.2' },
    { id: 'same', name: 'Gleich', folderName: 'same', version: '1.21.1', loader: 'forge', loaderVersion: '' },
    { id: 'keep', name: 'Keep', folderName: 'keep', version: '1.20.1', loader: 'Quilt' },
    { id: 'b', name: 'Neu B', folderName: 'b', version: '1.21.1', loader: 'vanilla' },
  ])

  assert.equal(upserts.length, 2, 'only the changed and the new instance are written')
  const renamed = upserts.find((record) => record.folderName === 'a')
  assert.equal(renamed.id, 'a', 'the existing core id is kept')
  assert.equal(renamed.name, 'Neu')
  assert.equal(renamed.version, '1.21.1')
  assert.equal(renamed.loader, 'fabric')
  assert.equal(renamed.loaderVersion, '0.2')
  assert.equal(renamed.legacy, true)
  const added = upserts.find((record) => record.folderName === 'b')
  assert.equal(added.id, 'legacy-b')
  assert.equal(upserts.some((record) => record.folderName === 'same'), false)
  assert.equal(
    upserts.some((record) => record.folderName === 'keep'),
    false,
    'a field the renderer never had keeps the core value instead of clearing it',
  )
})

test('a running instance cannot be deleted', () => {
  const handler = handlerOf('delete-profile-files')
  const runningCheck = handler.indexOf('launches.has(')
  const remove = handler.indexOf('rmSync(')
  assert.ok(runningCheck > 0, 'delete must check the launch registry')
  assert.ok(remove > runningCheck, 'the check must run before the recursive delete')
  assert.match(handler, /läuft noch/)
})

test('instance mutations reach the core register', () => {
  const source = profileSource()
  assert.match(handlerOf('create-instance'), /upsertCoreInstance\(/)
  assert.match(handlerOf('delete-profile-files'), /removeCoreInstance\(/)
  assert.match(source, /await options\.upsertCoreInstance\(clone\)/)
  assert.match(source, /syncCoreInstances\(profiles\)/)
  assert.match(handlerOf('save-profiles'), /syncCoreInstances\(enriched\)/)
})

test('profile handlers never write the core register themselves', () => {
  const source = profileSource()
  assert.doesNotMatch(source, /core\.instances\.(?:upsert|remove)/)
  assert.doesNotMatch(source, /getCore\(/)
  const projection = fs.readFileSync(
    path.join(ROOT, 'electron', 'legacy', 'core-projection.js'),
    'utf8',
  )
  assert.match(projection, /core\.instances\.upsert\(/, 'the projection owns the write')
  assert.match(projection, /core\.instances\.remove\(/, 'the projection owns the delete')
})

test('an empty saved list removes every legacy core record', async () => {
  const removed = []
  const records = [
    { id: 'gone-a', folderName: 'gone-a', legacy: true },
    { id: 'typed', folderName: 'typed', legacy: false },
  ]
  const files = require(path.join(ROOT, 'dist-electron', 'legacy', 'instance-files.js')).createInstanceFiles({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resolveGameRoot: async () => path.join(os.tmpdir(), 'bamboo-empty-root'),
    getCore: async () => ({
      instances: {
        list: async () => records,
        remove: async (id) => { removed.push(id) },
        upsert: async () => {},
      },
      instanceManager: { findByFolder: async () => null },
    }),
  })

  await files.syncCoreInstances([])
  assert.deepEqual(removed, ['gone-a'], 'a typed record is not owned by the legacy list')
})

test('a profile dropped from the saved list leaves no core ghost', async () => {
  const removed = []
  const records = [
    { id: 'keep', folderName: 'keep', legacy: true, name: 'Keep', version: '1.21', loader: 'fabric', loaderVersion: '' },
    { id: 'gone', folderName: 'gone', legacy: true, name: 'Gone', version: '1.20', loader: 'forge', loaderVersion: '' },
    { id: 'typed', folderName: 'typed', legacy: false, name: 'Typed', version: '1.21', loader: 'vanilla', loaderVersion: '' },
  ]
  const files = require(path.join(ROOT, 'dist-electron', 'legacy', 'instance-files.js')).createInstanceFiles({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resolveGameRoot: async () => path.join(os.tmpdir(), 'bamboo-ghost-root'),
    getCore: async () => ({
      instances: { list: async () => records, remove: async (id) => { removed.push(id) } },
      instanceManager: { findByFolder: async () => null },
    }),
  })
  await files.syncCoreInstances([
    { folderName: 'keep', name: 'Keep', version: '1.21', loader: 'fabric', loaderVersion: '' },
  ])
  assert.deepEqual(removed, ['gone'], 'only the legacy record missing from the list is removed')
})

test('a slow reconcile cannot overwrite a newer list', async () => {
  const upserts = []
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  let writes = 0
  const files = require(path.join(ROOT, 'dist-electron', 'legacy', 'instance-files.js')).createInstanceFiles({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    resolveGameRoot: async () => path.join(os.tmpdir(), 'bamboo-sync-order'),
    getCore: async () => ({
      instances: {
        list: async () => [],
        upsert: async (record) => {
          const index = writes++
          if (index === 0) await gate
          upserts.push(record.name)
        },
        remove: async () => {},
      },
      instanceManager: { findByFolder: async () => null },
    }),
  })

  // get-profiles starts its reconcile without waiting; a save follows at once.
  const older = files.syncCoreInstances([{ folderName: 'a', name: 'Alt', version: '1.20.1', loader: 'fabric' }])
  const newer = files.syncCoreInstances([{ folderName: 'a', name: 'Neu', version: '1.20.1', loader: 'fabric' }])
  releaseFirst()
  await Promise.all([older, newer])

  assert.deepEqual(upserts, ['Alt', 'Neu'], 'the newest list is written last')
})

// --- audit probes: quarantine is idempotent, read errors are kept, rename rolls back ---

function quarantineFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('profiles.json.corrupt-'))
}

async function loadRename(root, registry, active, mirrored = []) {
  const { registerProfileIpc } = require(path.join(
    ROOT,
    'dist-electron',
    'legacy',
    'profile-ipc.js',
  ))
  const { profileDirOrNull, uniqueProfileFolder, uniqueProfileName } = instanceFiles()
  const handlers = new Map()
  registerProfileIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      gameRoot: () => root,
      resolveGameRoot: async () => root,
      shell: { openPath: async () => '' },
      launches: {
        has: (key) => active.has(key),
        rename: (oldKey, newKey) => {
          const value = active.get(oldKey)
          if (value === undefined) return
          active.delete(oldKey)
          active.set(newKey, value)
        },
      },
      instanceSizeCache: new Map(),
      instanceSizeDirty: new Set(),
      formatSize: () => '0 B',
      scheduleInstanceSizeRefresh: () => {},
      forgetInstanceSize: () => {},
      readProfilesSync: () => registry.read(),
      writeProfilesSync: (rootPath, profiles) => registry.write(profiles),
      profileDirOrNull,
      uniqueProfileFolder,
      uniqueProfileName,
      upsertCoreInstance: async () => {},
      removeCoreInstance: async () => true,
      renameCoreInstance: async (oldFolder, newFolder, newDir) => {
        mirrored.push({ oldFolder, newFolder, newDir })
        return true
      },
      syncCoreInstances: async () => {},
      writeFirstRunOptions: () => ({ path: '', created: false }),
    },
  )
  return handlers.get('rename-instance')
}

test('one corrupt profiles.json yields exactly one backup, however often it is read', async () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-quarantine-once')
  const target = path.join(root, 'profiles.json')
  const corrupt = '[{"id":"a"'
  fs.writeFileSync(target, corrupt)

  const registry = profileRegistry(root)
  assert.deepEqual(registry.read(), [])
  await new Promise((resolve) => setTimeout(resolve, 5))
  registry.read()
  registry.read()
  assert.equal(quarantineFiles(root).length, 1, 'repeated reads must not multiply backups')

  registry.write([])
  assert.equal(quarantineFiles(root).length, 1, 'the write reuses the existing backup')
  assert.equal(fs.readFileSync(path.join(root, quarantineFiles(root)[0]), 'utf8'), corrupt)
})

test('a profiles.json that is not a list is kept before anything replaces it', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-not-a-list')
  const target = path.join(root, 'profiles.json')
  fs.writeFileSync(target, '{"version":1}')

  const registry = profileRegistry(root)
  assert.deepEqual(registry.read(), [])
  const backups = quarantineFiles(root)
  assert.equal(backups.length, 1, 'a non-list file must be kept')
  assert.equal(fs.readFileSync(path.join(root, backups[0]), 'utf8'), '{"version":1}')

  registry.write([])
  assert.equal(quarantineFiles(root).length, 1, 'one backup per unreadable state')
})

test('a directory in place of profiles.json is kept, not silently dropped', () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('profiles-eisdir')
  const target = path.join(root, 'profiles.json')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'world.dat'), 'x')

  const registry = profileRegistry(root)
  assert.deepEqual(registry.read(), [])
  const backups = quarantineFiles(root)
  assert.equal(backups.length, 1, 'an unreadable path must be kept')
  assert.equal(fs.statSync(path.join(root, backups[0])).isDirectory(), true)
  assert.equal(fs.readFileSync(path.join(root, backups[0], 'world.dat'), 'utf8'), 'x')

  assert.deepEqual(registry.read(), [])
  assert.equal(quarantineFiles(root).length, 1, 'one backup per unreadable state')
})

test('a rename whose list write fails leaves folder, list and launch key on the old name', async () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('rename-rollback')
  fs.mkdirSync(path.join(root, 'profiles', 'alt'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'alt', 'marker.txt'), 'x')
  const registry = profileRegistry(root)
  registry.write([{ id: 'a', name: 'Alt', folderName: 'alt' }])
  registry.write = () => {
    throw new Error('disk full')
  }
  const active = new Map([['alt', { pid: 1 }]])

  const rename = await loadRename(root, registry, active)
  const result = await rename({}, { oldFolderName: 'alt', newName: 'Neu' })
  assert.equal(result.success, false)
  assert.match(result.error, /disk full/)

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'alt', 'marker.txt')), true, 'the folder is back')
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'neu')), false)
  const list = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
  assert.equal(list[0].folderName, 'alt', 'the list never named a folder that was rolled back')
  assert.equal(active.has('alt'), true, 'the launch key keeps naming the listed folder')
  assert.equal(active.has('neu'), false)
})

test('a rename that succeeds moves list, folder, launch key and core register together', async () => {
  const { profileRegistry } = registryModule()
  const root = tempRoot('rename-success')
  fs.mkdirSync(path.join(root, 'profiles', 'alt'), { recursive: true })
  const registry = profileRegistry(root)
  registry.write([{ id: 'a', name: 'Alt', folderName: 'alt' }])
  const active = new Map([['alt', { pid: 1 }]])
  const mirrored = []

  const rename = await loadRename(root, registry, active, mirrored)
  const result = await rename({}, { oldFolderName: 'alt', newName: 'Neu' })

  assert.equal(result.success, true)
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'neu')), true)
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'alt')), false)
  const list = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
  assert.equal(list[0].folderName, 'neu')
  assert.equal(list[0].name, 'Neu')
  assert.equal(active.has('neu'), true)
  assert.equal(active.has('alt'), false)
  assert.equal(mirrored.length, 1, 'the core register is updated in the same call')
  assert.equal(mirrored[0].newFolder, 'neu')
  assert.equal(mirrored[0].oldFolder, 'alt')
})

test('a failed launch resets the Discord presence', () => {
  const handler = handlerOf('launch-game')
  const catchBlock = handler.slice(handler.indexOf('} catch (error) {'))
  assert.match(catchBlock, /updatePresence\('back'\)/, 'presence must leave "Starting"')
})

test('rename goes through one function that updates both registers', () => {
  const source = profileSource()
  assert.equal(
    source.match(/async function commitInstanceRename\(/g)?.length,
    1,
    'one function owns the rename',
  )
  assert.equal(source.match(/ipc\.handle\('rename-instance'/g)?.length, 1)
  const handler = handlerOf('rename-instance')
  assert.match(handler, /commitInstanceRename\(/)
  const commit = source.slice(
    source.indexOf('async function commitInstanceRename('),
    source.indexOf('ipc.handle(\'rename-instance\''),
  )
  assert.match(commit, /profileRegistry\(rootPath\)/, 'the list is written by the registry')
  assert.match(commit, /registry\.update\(/, 'the list is written by the registry')
  assert.match(commit, /renameCoreInstance\(/, 'the core register follows in the same function')
})

test('the unreachable content-delete copy is gone', () => {
  const handler = handlerOf('delete-content-file')
  assert.doesNotMatch(handler, /fs\.unlinkSync|startsWith\(/, 'only the core may delete content')
  assert.match(handler, /removeLegacyContent/)
})

test('content hashing resolves paths through the separator check', () => {
  for (const channel of ['hash-content-files', 'identify-content-files']) {
    const handler = handlerOf(channel)
    assert.match(handler, /isInsideDirectory\(/, `${channel} must use the containment helper`)
    assert.doesNotMatch(handler, /\.startsWith\(profileDir\)|\.startsWith\(profilesDir\)/, `${channel} must not use a raw prefix`)
  }
})
