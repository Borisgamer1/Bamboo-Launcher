/**
 * A renderer-provided folder name must never leave the profiles folder: the
 * delete handler removes its target recursively, so ".." would empty the game
 * root. The guard lives in electron/legacy/instance-files and is checked here
 * on its own.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const rootPath = path.join(ROOT, 'fake-game-root')
const profileSource = () => fs.readFileSync(path.join(ROOT, 'electron', 'legacy', 'profile-ipc.ts'), 'utf8')

function loadGuard() {
  const { createInstanceFiles } = require(path.join(
    ROOT,
    'dist-electron',
    'legacy',
    'instance-files.js',
  ))
  const silent = { debug() {}, info() {}, warn() {}, error() {} }
  const { profileDirOrNull } = createInstanceFiles({
    logger: silent,
    resolveGameRoot: async () => rootPath,
    getCore: async () => null,
  })
  assert.ok(profileDirOrNull, 'folder guard must exist in the instance-file owner')
  return profileDirOrNull
}

test('a plain instance folder resolves inside profiles', () => {
  const guard = loadGuard()
  assert.equal(guard(rootPath, 'bamboo-1'), path.join(rootPath, 'profiles', 'bamboo-1'))
  // Imported folders may keep characters a slug would drop; only the path matters.
  assert.equal(guard(rootPath, 'old.pack'), path.join(rootPath, 'profiles', 'old.pack'))
})

test('traversal and absolute paths are refused', () => {
  const guard = loadGuard()
  for (const name of ['..', '../..', '../screenshots', 'a/../../..', '', null, undefined, 42]) {
    assert.equal(guard(rootPath, name), null, `refused: ${String(name)}`)
  }
  assert.equal(guard(rootPath, path.join(rootPath, 'profiles', 'x', '..', '..')), null)
})

test('the delete handler refuses an invalid name before touching anything', () => {
  const source = profileSource()
  const start = source.indexOf("ipc.handle('delete-profile-files'")
  const end = source.indexOf("ipc.handle('get-profiles'", start)
  assert.ok(start > 0 && end > start, 'delete-profile-files handler must exist')
  const handler = source.slice(start, end)
  const guardAt = handler.indexOf('profileDirOrNull(rootPath, folderName)')
  const removeAt = handler.indexOf('rmSync(')
  assert.ok(guardAt > 0, 'handler must resolve through the guard')
  assert.ok(removeAt > guardAt, 'the guard must run before the recursive delete')
  assert.match(handler, /success: false/)
  assert.match(handler, /return \{ success: true, deleted, screenshots \}/)
})

// Every handler that touches an instance directory reaches it through the same
// guard. A raw path.join(rootPath, 'profiles', folderName) let ".." through in
// seven of them before this test existed.
// save-profiles builds no path at all since sizes moved off the save path; its
// folder names are only written into profiles.json.
const GUARDED_HANDLERS = [
  'open-profile-folder',
  'open-instance-folder',
  'export-profile',
  'launch-game',
  'upload-local-mod',
]

test('instance handlers resolve the renderer folder name through the guard', () => {
  // Screenshot handlers moved to their own module; both surfaces use the guard.
  const source = [
    'main.js',
    'electron/legacy/profile-ipc.ts',
    'electron/legacy/screenshot-ipc.ts',
    'electron/legacy/profile-archive.ts',
    'electron/legacy/content-ipc.ts',
    'electron/legacy/launch-ipc.ts',
  ]
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
    .join('\n')
  // rename-instance delegates to one function that owns list, folder and core
  // register; the guard lives there.
  const delegated = {
    'rename-instance': [
      'async function commitInstanceRename(',
      "ipc.handle('clone-instance'",
    ],
  }
  for (const channel of GUARDED_HANDLERS) {
    const start = Math.max(
      source.indexOf(`ipc.handle('${channel}'`),
      source.indexOf(`ipc.on('${channel}'`),
    )
    assert.ok(start > 0, `${channel} handler must exist`)
    const nextHandle = source.slice(start + 1).search(/\n\s*ipc\.(?:handle|on)\('/)
    const end = nextHandle < 0 ? source.length : start + 1 + nextHandle
    const handler = source.slice(start, end)
    assert.match(handler, /profileDirOrNull\(/, `${channel} must use profileDirOrNull`)
  }
  for (const [channel, [from, to]] of Object.entries(delegated)) {
    const start = source.indexOf(from)
    const end = source.indexOf(to, start)
    assert.ok(start > 0 && end > start, `${channel} delegate must exist`)
    assert.match(source.slice(start, end), /profileDirOrNull\(/, `${channel} must use profileDirOrNull`)
  }
})

test('no handler joins a raw renderer folder name onto profiles', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const offenders = source.match(
    /path\.join\([^)\n]*'profiles',\s*(folderName|oldFolderName|newFolderName|currentFolder)\b/g,
  )
  assert.equal(offenders, null, `raw joins left: ${(offenders || []).join(', ')}`)
})

test('download-mod writes no file of its own and owns no API-supplied name', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf("ipc.handle('download-mod'")
  const end = source.indexOf('\n});', start)
  assert.ok(start > 0 && end > start, 'download-mod handler must exist')
  const code = source.slice(start, end).replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /writeFileSync|path\.join|filename/, 'the core bridge owns the download path')
  assert.match(code, /installLegacyMod/)
})
