/**
 * A renderer-provided folder name must never leave the profiles folder: the
 * delete handler removes its target recursively, so ".." would empty the game
 * root. The guard lives in main.js and is checked here on its own.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const rootPath = path.join(ROOT, 'fake-game-root')

function loadGuard() {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf('function profileDirOrNull(rootPath, folderName) {')
  const end = source.indexOf('function uniqueProfileFolder(', start)
  assert.ok(start > 0 && end > start, 'folder guard must exist in main.js')
  return new Function('path', `${source.slice(start, end)}; return profileDirOrNull;`)(path)
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
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const start = source.indexOf("ipc.handle('delete-profile-files'")
  const end = source.indexOf("ipc.handle('repair-profile'", start)
  assert.ok(start > 0 && end > start, 'delete-profile-files handler must exist')
  const handler = source.slice(start, end)
  const guardAt = handler.indexOf('profileDirOrNull(rootPath, folderName)')
  const removeAt = handler.indexOf('fs.rmSync(')
  assert.ok(guardAt > 0, 'handler must resolve through the guard')
  assert.ok(removeAt > guardAt, 'the guard must run before the recursive delete')
  assert.match(handler, /success: false/)
  assert.match(handler, /return \{ success: true, deleted, screenshots \}/)
})
