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
const registryModule = () => require(path.join(ROOT, 'dist-electron', 'instances', 'profile-registry.js'))

function tempRoot(name) {
  const dir = path.join(os.tmpdir(), `bamboo-${name}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function handlerOf(channel) {
  const source = mainSource()
  const start = Math.max(
    source.indexOf(`ipc.handle('${channel}'`),
    source.indexOf(`ipc.on('${channel}'`),
  )
  assert.ok(start > 0, `${channel} handler must exist`)
  const end = source.indexOf('\n});', start)
  assert.ok(end > start, `${channel} handler must close`)
  return source.slice(start, end)
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
  const source = mainSource()
  const start = source.indexOf('function isInsideDirectory(')
  const end = source.indexOf('function nextFreeProfileFolder(', start)
  assert.ok(start > 0 && end > start, 'isInsideDirectory must exist in main.js')
  const isInsideDirectory = new Function(
    'path',
    `${source.slice(start, end)}; return isInsideDirectory;`,
  )(path)
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
  assert.match(source, /patchSizes\(/, 'sizes are patched onto the current list')
})

test('save-profiles no longer walks instance folders', () => {
  const handler = handlerOf('save-profiles')
  assert.doesNotMatch(handler, /measureFolderBytes\(/, 'the save path must not measure')
  assert.match(mainSource(), /scheduleInstanceSizeRefresh\(rootPath\)/)
})

test('a running instance cannot be deleted', () => {
  const handler = handlerOf('delete-profile-files')
  const runningCheck = handler.indexOf('ACTIVE_LAUNCHES.has(folderName)')
  const remove = handler.indexOf('fs.rmSync(')
  assert.ok(runningCheck > 0, 'delete must check the launch registry')
  assert.ok(remove > runningCheck, 'the check must run before the recursive delete')
  assert.match(handler, /läuft noch/)
})

// --- audit probes: quarantine is idempotent, read errors are kept, rename rolls back ---

function quarantineFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('profiles.json.corrupt-'))
}

async function loadRename(root, registry, active, mirror = async () => undefined) {
  const source = mainSource()
  const guard = source.slice(
    source.indexOf('function profileDirOrNull(rootPath, folderName) {'),
    source.indexOf('function uniqueProfileFolder('),
  )
  const unique = source.slice(
    source.indexOf('function uniqueProfileFolder('),
    source.indexOf('function uniqueProfileName('),
  )
  const commit = source.slice(
    source.indexOf('async function commitInstanceRename('),
    source.indexOf('async function mirrorInstanceRename('),
  )
  const { profileFolderOf, profileFolderSlug } = registryModule()
  const build = new Function(
    'path',
    'fs',
    'profileRegistry',
    'profileFolderOf',
    'profileFolderSlug',
    'ACTIVE_LAUNCHES',
    'instanceSizeCache',
    'instanceSizeDirty',
    'gameRoot',
    'mirrorInstanceRename',
    'shellLog',
    `${guard}\n${unique}\n${commit}\nreturn commitInstanceRename;`,
  )
  return build(
    path,
    fs,
    () => registry,
    profileFolderOf,
    profileFolderSlug,
    active,
    new Map(),
    new Set(),
    () => root,
    mirror,
    { info() {}, warn() {}, error() {}, debug() {} },
  )
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
  await assert.rejects(() => rename({ oldFolderName: 'alt', newName: 'Neu' }), /disk full/)

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

  const rename = await loadRename(root, registry, active, async (...args) => mirrored.push(args))
  const result = await rename({ oldFolderName: 'alt', newName: 'Neu' })

  assert.equal(result.success, true)
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'neu')), true)
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'alt')), false)
  const list = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
  assert.equal(list[0].folderName, 'neu')
  assert.equal(list[0].name, 'Neu')
  assert.equal(active.has('neu'), true)
  assert.equal(active.has('alt'), false)
  assert.equal(mirrored.length, 1, 'the core register is updated in the same call')
  assert.equal(mirrored[0][0], 'neu')
  assert.equal(mirrored[0][2], 'alt')
})

test('a failed launch resets the Discord presence', () => {
  const handler = handlerOf('launch-game')
  const catchBlock = handler.slice(handler.indexOf('} catch (error) {'))
  assert.match(catchBlock, /updateDiscordPresence\('back'\)/, 'presence must leave "Starting"')
})

test('rename goes through one function that updates both registers', () => {
  const source = mainSource()
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
  assert.match(commit, /mirrorInstanceRename\(/, 'the core register follows in the same function')
  assert.equal(
    commit.match(/core\.instances\.upsert\(/g)?.length,
    1,
    'one place in the rename path may update the core register',
  )
  assert.equal(
    source.match(/mirrorInstanceRename\(/g)?.length,
    2,
    'the core mirror is defined once and called once',
  )
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
