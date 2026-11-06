/**
 * Regression guard for the legacy `curseforge-search` handler the renderer
 * actually calls. Two failures must stay fixed:
 *
 * 1. The renderer sends numeric class ids. If the handler treats them as
 *    unknown names, every type tab falls back to Mods and shows the same list.
 * 2. The renderer offers pageSize 500 and unbounded scroll. CurseForge accepts
 *    at most pageSize 50 and index + pageSize <= 10,000, so those requests must
 *    be clamped before they leave the main process.
 *
 * The handler factory comes from the legacy bridge module and gets a fake HTTP
 * layer; no Electron process or live CurseForge key is involved.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
// The compiled copy main.js requires; `test:core` builds it before this runs.
const { createCurseForgeSearchHandler } = require('../dist-electron/legacy/curseforge.js')

function loadHandlerFactory() {
  return createCurseForgeSearchHandler
}

/** Drive the real handler with a captured request instead of the network. */
function harness() {
  const requests = []
  const handler = loadHandlerFactory()({
    curseForgeHeaders: () => ({ Accept: 'application/json', 'x-api-key': 'unit-test-key' }),
    curseForgeFetch: async (url, options) => {
      requests.push({ url, headers: options?.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [], pagination: { totalCount: 0 } }),
        text: async () => '',
      }
    },
    curseForgeFailure: async () => ({ error: 'unexpected response', code: 'http' }),
    shellLog: { warn() {} },
  })
  return { handler, requests }
}

test('every CurseForge type tab sends its own distinct classId', async () => {
  const { curseForgeClassIdFor } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'lib', 'contentCategories.ts')).href
  )
  const tabs = [
    { label: 'Mods', type: 'mod', classId: 6 },
    { label: 'Plugins', type: 'plugin', classId: 5 },
    { label: 'Resource Packs', type: 'resourcepack', classId: 12 },
    { label: 'Shaders', type: 'shader', classId: 6552 },
    { label: 'Data Packs', type: 'datapack', classId: 6945 },
    { label: 'Worlds', type: 'worlds', classId: 17 },
    { label: 'Modpacks', type: 'modpack', classId: 4471 },
  ]
  assert.equal(
    new Set(tabs.map((tab) => tab.classId)).size,
    tabs.length,
    'the seven tabs must not share a class id',
  )

  const { handler, requests } = harness()
  for (const tab of tabs) {
    assert.equal(curseForgeClassIdFor(tab.type), tab.classId, `${tab.label} renderer mapping`)

    const result = await handler(null, {
      query: 'test',
      modFilter: String(tab.classId),
      index: 0,
      pageSize: 20,
    })
    assert.deepEqual(result, { data: [], pagination: { totalCount: 0 } })

    const request = new URL(requests.at(-1).url)
    assert.equal(`${request.origin}${request.pathname}`, 'https://api.curseforge.com/v1/mods/search')
    assert.equal(
      request.searchParams.get('classId'),
      String(tab.classId),
      `${tab.label} must request its own class id`,
    )
    assert.equal(request.searchParams.get('gameId'), '432')
  }
})

test('the renderer starts a new paging sequence when the page size changes', () => {
  const filters = fs.readFileSync(path.join(ROOT, 'src', 'components', 'mods', 'ModsFilters.tsx'), 'utf8')
  const start = filters.indexOf('value={pageSize}')
  const end = filters.indexOf('</select>', start)
  assert.ok(start > 0 && end > start, 'the page-size control must exist')
  assert.match(filters.slice(start, end), /onPageSize\(/, 'the control updates the page size')
  const view = fs.readFileSync(path.join(ROOT, 'src', 'components', 'ModsView.tsx'), 'utf8')
  const handlerStart = view.indexOf('onPageSize={(size)')
  const handlerEnd = view.indexOf('}', view.indexOf('handleFilterChange()', handlerStart))
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'the page-size handler must exist')
  const handler = view.slice(handlerStart, handlerEnd)
  assert.match(handler, /setPageSize\(/, 'the handler updates the page size')
  assert.match(
    handler,
    /handleFilterChange\(\)/,
    'changing the page size must return to page 1 instead of reusing the old offset',
  )
})

test('the handler clamps pageSize and index to the documented search limits', async () => {
  const { handler, requests } = harness()

  async function search(pageSize, index) {
    requests.length = 0
    const result = await handler(null, { query: '', modFilter: '6', pageSize, index })
    assert.deepEqual(result, { data: [], pagination: { totalCount: 0 } })
    assert.equal(requests.length, 1, 'one page request reaches the HTTP layer')
    return new URL(requests[0].url).searchParams
  }

  let params = await search(500, 0)
  assert.equal(params.get('pageSize'), '50', 'pageSize above the API maximum is clamped')
  assert.equal(params.get('index'), null, 'the first page omits index')

  params = await search(100, 7250)
  assert.equal(params.get('pageSize'), '50')
  assert.equal(params.get('index'), '7250', 'a legal index is preserved when pageSize is clamped')

  params = await search(500, 9975)
  assert.equal(params.get('pageSize'), '50')
  assert.equal(params.get('index'), '9950')
  assert.equal(
    Number(params.get('index')) + Number(params.get('pageSize')),
    10_000,
    'the request stops exactly at the documented result limit',
  )

  params = await search(0, -10)
  assert.equal(params.get('pageSize'), '1', 'pageSize below one is clamped')
  assert.equal(params.get('index'), null, 'a negative index is clamped to the first page')
})
