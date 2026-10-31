const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')

function loadBackgroundTasks() {
  const filename = path.join(__dirname, '..', 'src', 'lib', 'backgroundTasks.ts')
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(output, filename)
  return loaded.exports
}

test('a finished import expires after its visible window; errors and normal tasks do not', () => {
  const React = require('react')
  const original = React.useSyncExternalStore
  React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
  try {
    const {
      beginBackgroundTask,
      completeBackgroundTask,
      failBackgroundTask,
      dismissExpiredBackgroundTasks,
      useBackgroundTasks,
    } = loadBackgroundTasks()
    const snapshot = () => useBackgroundTasks()
    const importId = 'import:expiring'
    const errorId = 'import:failed'
    const normalId = 'world:normal'

    beginBackgroundTask({ id: importId, title: 'Import', percent: 0 })
    completeBackgroundTask(importId, 'Import abgeschlossen', 8000)
    const finishedAt = snapshot().find((task) => task.id === importId).finishedAt
    assert.equal(typeof finishedAt, 'number')

    dismissExpiredBackgroundTasks(finishedAt + 7999)
    assert.ok(snapshot().some((task) => task.id === importId), 'still visible before the window ends')

    dismissExpiredBackgroundTasks(finishedAt + 8000)
    assert.equal(snapshot().some((task) => task.id === importId), false, 'expired import leaves the bar')

    beginBackgroundTask({ id: errorId, title: 'Import', percent: 0 })
    failBackgroundTask(errorId, 'kaputt')
    beginBackgroundTask({ id: normalId, title: 'Welt', percent: 0 })
    completeBackgroundTask(normalId, 'fertig')
    dismissExpiredBackgroundTasks(finishedAt + 60_000)
    assert.ok(snapshot().some((task) => task.id === errorId), 'failures stay for the user')
    assert.ok(snapshot().some((task) => task.id === normalId), 'unrelated completed work stays')
  } finally {
    React.useSyncExternalStore = original
  }
})
