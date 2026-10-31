/**
 * Phase 1 tests: canonical ledger migration/writes and provider adapters
 * (cache keys, search mapping, version/file lookup). Fixture servers only.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, sha1, sha512, tempDir } = require('./harness.cjs')

const {
  CurseForgeClient,
  CurseForgeProvider,
  ModError,
  ModLedger,
  ModrinthClient,
  ModrinthProvider,
  curseForgeDependencyKind,
} = require('../dist-electron/mods/index.js')

test('ledger migrates lock and offline index without writing in shadow mode', async () => {
  const dir = tempDir('ledger')
  try {
    const instanceDir = path.join(dir, 'instance')
    fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
    const content = Buffer.from('mod-a-bytes')
    const sha = sha1(content)
    const orphan = sha1(Buffer.from('orphan'))
    fs.writeFileSync(
      path.join(instanceDir, 'modpack.lock.json'),
      JSON.stringify({
        version: 1,
        format: 'curseforge',
        name: 'Pack',
        versionId: '1',
        upstream: { provider: 'curseforge', format: 'curseforge' },
        dependencies: {},
        files: [
          {
            path: 'mods/a.jar',
            sha1: sha,
            sha512: sha512(content),
            size: content.length,
            projectId: 42,
            fileId: 420,
          },
        ],
        updatedAt: 111,
      }),
    )
    fs.writeFileSync(
      path.join(instanceDir, 'mods.index.json'),
      JSON.stringify({
        version: 1,
        entries: {
          [sha]: {
            sha1: sha,
            projectId: '42',
            name: 'A',
            versionId: 'v1',
            versionNumber: '1.0',
            file: 'a.jar',
            source: 'curseforge',
            updatedAt: 222,
          },
          [orphan]: {
            sha1: orphan,
            projectId: '99',
            name: 'Orphan',
            file: 'missing.jar',
            source: 'modrinth',
            updatedAt: 333,
          },
        },
      }),
    )

    const ledger = new ModLedger(instanceDir)
    await ledger.load()
    assert.equal(fs.existsSync(ledger.file), false, 'loading must not create the ledger')

    const a = await ledger.get(sha)
    assert.deepEqual(a.paths, ['mods/a.jar'])
    assert.equal(a.name, 'A')
    assert.equal(a.versionId, 'v1')
    assert.equal(a.projectId, '42')
    assert.equal(a.fileId, '420')
    assert.equal(a.provider, 'curseforge')
    assert.equal(a.size, content.length)
    assert.equal(a.sha512, sha512(content))

    const unplaced = await ledger.get(orphan)
    assert.deepEqual(unplaced.paths, [])
    assert.equal(unplaced.name, 'Orphan', 'index-only metadata is kept, not dropped')
    assert.equal(ledger.migration.lockFiles, 1)
    assert.equal(ledger.migration.indexEntries, 2)
    assert.equal(ledger.migration.indexEntriesWithoutPath, 1)

    await ledger.save()
    const reopened = new ModLedger(instanceDir)
    await reopened.load()
    assert.equal(fs.existsSync(reopened.file), true)
    assert.equal((await reopened.get(sha)).name, 'A')
    assert.equal((await reopened.byPath('mods/a.jar')).sha1, sha)
    assert.equal(reopened.migration, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger serializes concurrent writes into one complete file', async () => {
  const dir = tempDir('ledger-parallel')
  try {
    const instanceDir = path.join(dir, 'instance')
    fs.mkdirSync(instanceDir, { recursive: true })
    const ledger = new ModLedger(instanceDir)
    const hashes = Array.from({ length: 25 }, (_, index) => sha1(Buffer.from(`file-${index}`)))
    await Promise.all(
      hashes.map((sha, index) =>
        ledger.upsert({
          sha1: sha,
          paths: [`mods/file-${index}.jar`],
          installedAt: index,
        }),
      ),
    )
    const reopened = new ModLedger(instanceDir)
    await reopened.load()
    const records = await reopened.list()
    assert.equal(records.length, 25)
    assert.deepEqual(records.map((record) => record.sha1).sort(), [...hashes].sort())
    const parsed = JSON.parse(fs.readFileSync(path.join(instanceDir, 'mods.ledger.json'), 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(Object.keys(parsed.entries).length, 25)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Modrinth provider canonicalises search keys and caches pages', async () => {
  const dir = tempDir('provider-modrinth')
  let searchCalls = 0
  let projectCalls = 0
  let lastSearch
  const server = await fixtureServer({
    '/v2/search': (req, res) => {
      searchCalls += 1
      const url = new URL(req.url, 'http://127.0.0.1')
      lastSearch = url.searchParams
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          hits: [
            {
              project_id: 'sodium',
              slug: 'sodium',
              title: 'Sodium',
              description: 'Rendering',
              project_type: 'mod',
              downloads: 100,
              follows: 10,
              author: 'CaffeineMC',
              categories: ['fabric', 'optimization'],
              versions: ['1.20.1'],
            },
          ],
          total_hits: 1,
          offset: Number(url.searchParams.get('offset') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 10),
        }),
      )
    },
    '/v2/project/sodium': (req, res) => {
      projectCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'sodium',
          slug: 'sodium',
          title: 'Sodium',
          description: 'Rendering',
          project_type: 'mod',
        }),
      )
    },
  })
  try {
    let now = 1_000_000
    const provider = new ModrinthProvider(new ModrinthClient({ baseUrl: `${server.base}/v2` }), {
      cache: { now: () => now },
    })
    const first = await provider.search({
      query: 'Sodium',
      loaders: ['fabric', 'forge'],
      gameVersions: ['1.20.1'],
      limit: 5,
    })
    const equivalent = await provider.search({
      query: ' sodium ',
      loaders: ['forge', 'fabric'],
      gameVersions: ['1.20.1'],
      limit: 5,
    })
    assert.equal(searchCalls, 1, 'facet order and query case share one cache entry')
    assert.equal(equivalent.total, 1)
    assert.equal(first.hits[0].provider, 'modrinth')
    assert.equal(first.hits[0].author, 'CaffeineMC')
    assert.deepEqual(JSON.parse(lastSearch.get('facets')), [
      ['categories:fabric', 'categories:forge'],
      ['versions:1.20.1'],
    ])

    await provider.search({
      query: 'sodium',
      loaders: ['fabric', 'forge'],
      gameVersions: ['1.20.1'],
      limit: 5,
      offset: 5,
    })
    assert.equal(searchCalls, 2, 'a different page is a separate fetch inside the same query')

    now += 11 * 60_000
    await provider.search({
      query: 'sodium',
      loaders: ['fabric', 'forge'],
      gameVersions: ['1.20.1'],
      limit: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(searchCalls, 3, 'expired entries are served and refreshed in the background')

    await provider.search(
      { query: 'sodium', loaders: ['fabric', 'forge'], gameVersions: ['1.20.1'], limit: 5 },
      { bypassCache: true },
    )
    assert.equal(searchCalls, 4, 'bypassCache forces a network read')

    const project = await provider.project('sodium')
    await provider.project('sodium')
    assert.equal(projectCalls, 1)
    assert.equal(project.provider, 'modrinth')
    await provider.project('sodium', { bypassCache: true })
    assert.equal(projectCalls, 2)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge provider searches the public catalog and maps files to versions', async () => {
  const dir = tempDir('provider-curseforge')
  let searchParams
  let filesParams
  let fileCalls = 0
  const file = {
    id: 123,
    modId: 238222,
    displayName: 'JEI 1.0',
    fileName: 'jei.jar',
    fileLength: 100,
    downloadUrl: null,
    gameVersions: ['1.20.1', 'Forge'],
    hashes: [{ algo: 1, value: 'A'.repeat(40) }],
    dependencies: [{ modId: 999, relationType: 3 }],
    releaseType: 2,
    fileDate: '2026-01-01T00:00:00Z',
  }
  const server = await fixtureServer({
    '/v1/mods/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      searchParams = url.searchParams
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [
            {
              id: 238222,
              name: 'Just Enough Items',
              slug: 'jei',
              summary: 'Item lookup',
              classId: 6,
              downloadCount: 1234,
              logo: { url: 'https://example.invalid/jei.png' },
              authors: [{ name: 'mezz' }],
              categories: [{ name: 'API' }],
              latestFilesIndexes: [
                {
                  gameVersion: '1.20.1',
                  fileId: 123,
                  filename: 'jei.jar',
                  releaseType: 1,
                  gameVersionTypeId: 1,
                  modLoader: 1,
                },
              ],
              allowModDistribution: true,
            },
          ],
          pagination: { index: 0, pageSize: 10, resultCount: 1, totalCount: 1 },
        }),
      )
    },
    '/v1/mods/238222/files': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      filesParams = url.searchParams
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [file] }))
    },
    '/v1/mods/238222/files/123': (req, res) => {
      fileCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: file }))
    },
  })
  try {
    const client = new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${server.base}/v1`,
      fetchImpl: fetch,
    })
    const provider = new CurseForgeProvider(client)
    const page = await provider.search({
      query: 'jei',
      projectType: 'mod',
      loaders: ['forge'],
      gameVersions: ['1.20.1'],
      gameVersionTypeId: 1,
      sort: 'downloads',
      limit: 10,
    })
    assert.equal(searchParams.get('gameId'), '432')
    assert.equal(searchParams.get('classId'), '6')
    assert.equal(searchParams.get('gameVersion'), '1.20.1')
    assert.equal(searchParams.get('modLoaderType'), '1')
    assert.equal(searchParams.get('gameVersionTypeId'), '1')
    assert.equal(searchParams.get('sortField'), '6')
    assert.equal(searchParams.get('sortOrder'), 'desc')
    assert.equal(searchParams.get('searchFilter'), 'jei')
    assert.equal(searchParams.get('pageSize'), '10')
    assert.equal(searchParams.get('index'), '0')
    assert.equal(page.total, 1)
    assert.equal(page.hits[0].provider, 'curseforge')
    assert.equal(page.hits[0].projectType, 'mod')
    assert.deepEqual(page.hits[0].versions, ['1.20.1'])
    assert.equal(page.hits[0].downloads, 1234)
    assert.equal(page.hits[0].allowModDistribution, true)

    const versions = await provider.versions('238222', {
      minecraftVersion: '1.20.1',
      loader: 'forge',
    })
    assert.equal(filesParams.get('gameVersion'), '1.20.1')
    assert.equal(filesParams.get('modLoaderType'), '1')
    assert.equal(filesParams.get('pageSize'), '50')
    assert.equal(versions.length, 1)
    assert.equal(versions[0].id, '123')
    assert.equal(versions[0].projectId, '238222')
    assert.deepEqual(versions[0].gameVersions, ['1.20.1'])
    assert.deepEqual(versions[0].loaders, ['forge'])
    assert.deepEqual(versions[0].dependencies, [{ projectId: '999', type: 'required' }])
    assert.equal(versions[0].channel, 'beta')
    assert.equal(versions[0].files[0].url, undefined)
    assert.equal(versions[0].files[0].hashes.sha1, 'a'.repeat(40))

    const single = await provider.version('238222', '123')
    await provider.version('238222', '123')
    assert.equal(fileCalls, 1, 'version metadata is cached')
    assert.equal(single.name, 'JEI 1.0')

    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map(curseForgeDependencyKind),
      ['embedded', 'optional', 'required', 'tool', 'incompatible', 'include'],
    )
    await assert.rejects(
      () => provider.project('not-a-number'),
      (error) => error instanceof ModError && error.code === 'provider-error',
    )
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const cfFile = (id) => ({
  id,
  modId: 7,
  displayName: `File ${id}`,
  fileName: `file-${id}.jar`,
  fileLength: 10,
  downloadUrl: `https://mediafilez.forgecdn.net/files/0/${id}/file-${id}.jar`,
  gameVersions: ['1.20.1', 'Forge'],
  hashes: [{ algo: 1, value: String(id).padStart(40, 'a') }],
  dependencies: [],
  releaseType: 1,
  fileDate: '2026-01-01T00:00:00Z',
})

test('CurseForge versions paginate to the API total and project metadata survives', async () => {
  const dir = tempDir('provider-curseforge-pages')
  const fileRequests = []
  const server = await fixtureServer({
    '/v1/mods/7/files': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const index = Number(url.searchParams.get('index'))
      fileRequests.push(index)
      const data = index === 0
        ? Array.from({ length: 50 }, (_, i) => cfFile(1000 + i))
        : Array.from({ length: 7 }, (_, i) => cfFile(2000 + i))
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data,
          pagination: { index, pageSize: 50, resultCount: data.length, totalCount: 57 },
        }),
      )
    },
    '/v1/mods/7': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: 7,
            name: 'Paginated',
            slug: 'paginated',
            summary: 'All pages',
            classId: 6,
            downloadCount: 4242,
            logo: { url: 'https://example.invalid/logo.png' },
            authors: [{ name: 'Author' }],
            categories: [{ name: 'API' }],
            allowModDistribution: false,
          },
        }),
      )
    },
    '/v1/mods/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [],
          pagination: { index: 0, pageSize: 20, totalCount: 0 },
          sortField: url.searchParams.get('sortField'),
        }),
      )
    },
  })
  try {
    const sortFields = []
    const provider = new CurseForgeProvider(new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${server.base}/v1`,
      fetchImpl: (url, init) => {
        const sortField = new URL(url).searchParams.get('sortField')
        if (sortField) sortFields.push(sortField)
        return fetch(url, init)
      },
    }))
    const versions = await provider.versions('7', { minecraftVersion: '1.20.1', loader: 'forge' })
    assert.equal(versions.length, 57, 'every page is read, not just the first 50')
    assert.deepEqual(fileRequests, [0, 50])
    assert.equal(versions[0].id, '1000')
    assert.equal(versions[56].id, '2006')

    const project = await provider.project('7')
    assert.equal(project.title, 'Paginated')
    assert.equal(project.projectType, 'mod')
    assert.equal(project.allowModDistribution, false)
    assert.equal(project.downloads, 4242)
    assert.equal(project.iconUrl, 'https://example.invalid/logo.png')
    assert.equal(project.author, 'Author')
    assert.deepEqual(project.categories, ['API'])

    await assert.rejects(
      () => provider.search({ query: 'x', categories: ['api'] }),
      (error) =>
        error instanceof ModError &&
        error.code === 'provider-error' &&
        /numeric ids/.test(error.message),
    )

    await provider.search({ query: 'x', sort: 'newest' }, { bypassCache: true })
    await provider.search({ query: 'x', sort: 'updated' }, { bypassCache: true })
    assert.deepEqual(sortFields, ['11', '3'], 'newest is submitted, updated is last-updated')
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('filesByIds resolves keys in order for both providers', async () => {
  const dir = tempDir('provider-files-by-id')
  const cfSha1 = 'b'.repeat(40)
  const modrinthSha1 = 'c'.repeat(40)
  let cfCalls = 0
  let modrinthCalls = 0
  const server = await fixtureServer({
    '/v1/mods/files': (req, res) => {
      cfCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [
            { ...cfFile(456), hashes: [{ algo: 1, value: cfSha1 }] },
            { ...cfFile(123), hashes: [{ algo: 1, value: cfSha1 }] },
          ],
        }),
      )
    },
    '/v2/version_files': (req, res) => {
      modrinthCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          [modrinthSha1]: {
            id: 'version-1',
            project_id: 'sodium',
            name: 'Sodium 1.0',
            version_number: '1.0',
            version_type: 'release',
            game_versions: ['1.20.1'],
            loaders: ['fabric'],
            files: [
              { url: 'https://cdn.modrinth.com/x.jar', filename: 'x.jar', hashes: { sha1: modrinthSha1 } },
            ],
            dependencies: [],
          },
        }),
      )
    },
  })
  try {
    const cf = new CurseForgeProvider(new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${server.base}/v1`,
      fetchImpl: fetch,
    }))
    const cfKeys = [
      { provider: 'curseforge', projectId: '7', fileId: '123' },
      { provider: 'curseforge', projectId: '7', fileId: '456' },
    ]
    const cfVersions = await cf.filesByIds(cfKeys)
    assert.deepEqual(cfVersions.map((version) => version.id), ['123', '456'])
    assert.equal(cfVersions[0].files[0].hashes.sha1, cfSha1)
    await cf.filesByIds(cfKeys)
    assert.equal(cfCalls, 1, 'file lookups are cached')

    const modrinth = new ModrinthProvider(
      new ModrinthClient({ baseUrl: `${server.base}/v2` }),
      {},
    )
    const keys = [{ provider: 'modrinth', projectId: 'sodium', sha1: modrinthSha1.toUpperCase() }]
    const found = await modrinth.filesByIds(keys)
    assert.equal(found.length, 1)
    assert.equal(found[0].id, 'version-1')
    assert.equal(found[0].channel, 'release')
    await modrinth.filesByIds(keys)
    assert.equal(modrinthCalls, 1, 'hash lookups are cached')

    await assert.rejects(
      () => modrinth.filesByIds([{ provider: 'modrinth', projectId: 'x', sha1: 'nope' }]),
      (error) => error instanceof ModError && error.code === 'provider-error',
    )
    await assert.rejects(
      () => cf.filesByIds([{ provider: 'modrinth', projectId: 'x', fileId: '1' }]),
      (error) => error instanceof ModError && error.code === 'provider-error',
    )
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge provider uses all seven shared class ids and maps them back', async () => {
  const classIds = {
    mod: 6,
    plugin: 5,
    resourcepack: 12,
    shader: 6552,
    datapack: 6945,
    worlds: 17,
    modpack: 4471,
  }
  const requested = []
  const server = await fixtureServer({
    '/v1/mods/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const classId = Number(url.searchParams.get('classId'))
      requested.push(classId)
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [
            {
              id: 1000 + classId,
              name: `type-${classId}`,
              slug: `type-${classId}`,
              summary: '',
              classId,
              latestFilesIndexes: [],
            },
          ],
          pagination: { index: 0, pageSize: 10, resultCount: 1, totalCount: 1 },
        }),
      )
    },
  })
  try {
    const provider = new CurseForgeProvider(
      new CurseForgeClient({
        apiKey: 'test-key',
        baseUrl: `${server.base}/v1`,
        fetchImpl: fetch,
      }),
    )
    for (const [projectType, classId] of Object.entries(classIds)) {
      const page = await provider.search({ query: `type-${projectType}`, projectType, limit: 10 })
      assert.equal(requested.at(-1), classId, `${projectType} sends its own class id`)
      assert.equal(page.hits[0].projectType, projectType, `${classId} maps back to ${projectType}`)
    }
    assert.equal(new Set(requested).size, 7, 'no two types collapse onto one class id')
  } finally {
    await server.close()
  }
})
