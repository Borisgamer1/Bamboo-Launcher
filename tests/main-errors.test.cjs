/**
 * English UI never shows a German main-process sentence: a handler that returns
 * a stable code maps to an English line, a German handler keeps its text.
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const { mainErrorText } = require(path.join(ROOT, 'src', 'lib', 'mainErrors.ts'))

test('a coded main-process failure is English in the English UI', () => {
  assert.equal(
    mainErrorText({ error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }, 'en', 'fallback'),
    'Invalid instance folder.',
  )
  assert.equal(
    mainErrorText({ error: 'Import-Kern nicht verfügbar', code: 'import-unavailable' }, 'en', 'fallback'),
    'The import core is not available.',
  )
  assert.equal(
    mainErrorText({ error: 'Loader-Installation fehlgeschlagen: x', code: 'loader-install-failed' }, 'en', 'fallback'),
    'The mod loader could not be installed.',
  )
  assert.equal(
    mainErrorText({ error: 'Ungültige Exportdaten', code: 'export-invalid' }, 'en', 'fallback'),
    'The export data is incomplete.',
  )
})

test('the German UI keeps the handler sentence', () => {
  assert.equal(
    mainErrorText({ error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }, 'de', 'fallback'),
    'Ungültiger Instanzordner.',
  )
})

test('an uncoded failure and an empty result fall back', () => {
  assert.equal(mainErrorText({ error: 'roher Text' }, 'en', 'fallback'), 'roher Text')
  assert.equal(mainErrorText({ code: 'not-in-the-table' }, 'en', 'fallback'), 'fallback')
  assert.equal(mainErrorText(null, 'en', 'fallback'), 'fallback')
})
