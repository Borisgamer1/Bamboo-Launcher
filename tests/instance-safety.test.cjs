/**
 * Instance-list and instance-folder safety.
 *
 * The probes below run the real helpers from `main.js`: an unreadable
 * profiles.json must survive as a quarantine copy instead of being replaced by
 * an empty list, and writes must go through a temp file so a crash cannot leave
 * a truncated list. The remaining assertions are static because the handlers
 * need a live Electron ipcMain.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const mainSource = () => fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')

function tempRoot(name) {
  const dir = path.join(os.tmpdir(), `bamboo-${name}-${process.pid}-${Date.now()}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** profileDirOrNull sits between the two functions the probe does not need. */
function loadProfileHelpers() {
  const source = mainSource()
  const start = source.indexOf('function quarantineProfilesFile(')
  const end = source.indexOf('function nextFreeProfileFolder(', start)
  assert.ok(start > 0 && end > start, 'profile helpers must exist in main.js')
  const shellLog = { debug() {}, info() {}, warn() {}, error() {} }
  return new Function(
    'fs',
    'path',
    'process',
    'shellLog',
    `${source.slice(start, end)}; return { readProfilesSync, writeProfilesSync, isInsideDirectory };`,
  )(fs, path, process, shellLog)
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
  const { writeProfilesSync } = loadProfileHelpers()
  const root = tempRoot('profiles-atomic')
  const target = path.join(root, 'profiles.json')

  writeProfilesSync(root, [{ id: 'a', name: 'A', folderName: 'a' }])
  writeProfilesSync(root, [{ id: 'b', name: 'B', folderName: 'b' }])

  const written = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'b')
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'no temp file may survive a write')
})

test('a corrupt profiles.json is quarantined before anyone writes an empty list', () => {
  const { readProfilesSync, writeProfilesSync } = loadProfileHelpers()
  const root = tempRoot('profiles-corrupt')
  const target = path.join(root, 'profiles.json')
  const corrupt = '[{"id":"a","name":"A"'
  fs.writeFileSync(target, corrupt)

  assert.deepEqual(readProfilesSync(root), [])

  const quarantine = fs.readdirSync(root).filter((name) => name.startsWith('profiles.json.corrupt-'))
  assert.equal(quarantine.length, 1, 'the unreadable file must be kept')
  assert.equal(fs.readFileSync(path.join(root, quarantine[0]), 'utf8'), corrupt)

  // The save that follows must not destroy the quarantined copy.
  writeProfilesSync(root, [])
  assert.equal(fs.readFileSync(path.join(root, quarantine[0]), 'utf8'), corrupt)
})

test('containment uses a separator, not a raw prefix', () => {
  const { isInsideDirectory } = loadProfileHelpers()
  const root = path.join(path.sep, 'game')
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles', 'a')), true)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles')), false)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles-x', 'a')), false)
  assert.equal(isInsideDirectory(path.join(root, 'profiles'), path.join(root, 'profiles', '..', 'x')), false)
})

test('save-profiles no longer walks instance folders', () => {
  const source = mainSource()
  assert.equal(source.includes('getFolderSize'), false, 'the sync folder walk must stay deleted')
  assert.doesNotMatch(handlerOf('save-profiles'), /measureFolderBytes\(/, 'the save path must not measure')
  assert.match(source, /scheduleInstanceSizeRefresh\(rootPath\)/, 'sizes are refreshed in the background')
  assert.match(source, /markInstanceSizeDirty\(/, 'content changes queue a size refresh')
})

test('a running instance cannot be deleted', () => {
  const handler = handlerOf('delete-profile-files')
  const runningCheck = handler.indexOf('ACTIVE_LAUNCHES.has(folderName)')
  const remove = handler.indexOf('fs.rmSync(')
  assert.ok(runningCheck > 0, 'delete must check the launch registry')
  assert.ok(remove > runningCheck, 'the check must run before the recursive delete')
  assert.match(handler, /läuft noch/)
})

test('a failed launch resets the Discord presence', () => {
  const handler = handlerOf('launch-game')
  const catchBlock = handler.slice(handler.indexOf('} catch (error) {'))
  assert.match(catchBlock, /updateDiscordPresence\('back'\)/, 'presence must leave "Starting"')
})

test('renaming moves the launch key and the core register entry', () => {
  const handler = handlerOf('rename-instance')
  assert.match(handler, /ACTIVE_LAUNCHES\.delete\(currentFolder\)/)
  assert.match(handler, /ACTIVE_LAUNCHES\.set\(folderName, activeLaunch\)/)
  assert.match(handler, /core\.instances\.upsert\(/, 'the core register must follow the folder')
  assert.ok(
    handler.indexOf('core.instances.upsert(') > handler.indexOf('fs.renameSync('),
    'the register follows the rename',
  )
})

test('the unreachable content-delete copy is gone', () => {
  const handler = handlerOf('delete-content-file')
  assert.doesNotMatch(handler, /fs\.unlinkSync|startsWith\(/, 'only the core may delete content')
  assert.match(handler, /removeLegacyContent/)
})

test('content hashing resolves paths through the separator check', () => {
  const source = mainSource()
  for (const channel of ['hash-content-files', 'identify-content-files']) {
    const handler = handlerOf(channel)
    assert.match(handler, /isInsideDirectory\(/, `${channel} must use the containment helper`)
    assert.doesNotMatch(handler, /\.startsWith\(profileDir\)|\.startsWith\(profilesDir\)/, `${channel} must not use a raw prefix`)
  }
})
