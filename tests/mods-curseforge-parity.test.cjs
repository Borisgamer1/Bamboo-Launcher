/**
 * Phase 5 (CurseForge parity): the documented search filters and pagination, the
 * download chain metadata → download-url → CDN fallback, the visible
 * allowModDistribution block, update detection through file ids and the
 * latest-files index, the opt-in murmur2 fingerprint path, and one file taken all
 * the way through the phase 4 pipeline and removed again.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, jar, sha1, tempDir } = require('./harness.cjs')

const {
  curseForgeCdnUrl,
  curseForgeFingerprint,
  CurseForgeClient,
  CurseForgeProvider,
  ModContentStore,
  ModError,
  ModLedger,
  removeInstalledContent,
} = require('../dist-electron/mods/index.js')
const { streamToFile } = require('../dist-electron/download/index.js')

function providerAgainst(server) {
  const requests = []
  const client = new CurseForgeClient({
    apiKey: 'test-key',
    baseUrl: `${server.base}/v1`,
    fetchImpl: (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      return fetch(url, init)
    },
  })
  return { provider: new CurseForgeProvider(client), requests }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const searchHit = (id, slug, allowModDistribution) => ({
  id,
  name: slug,
  slug,
  summary: `${slug} summary`,
  classId: 6,
  downloadCount: 1000 + id,
  latestFilesIndexes: [
    { gameVersion: '1.20.1', fileId: 1000 + id, filename: `${slug}.jar`, releaseType: 1 },
  ],
  allowModDistribution,
})

const cfFile = (id, overrides = {}) => ({
  id,
  modId: 7,
  displayName: `File ${id}`,
  fileName: `file-${id}.jar`,
  fileLength: 4096,
  downloadUrl: null,
  gameVersions: ['1.20.1', 'Forge'],
  hashes: [{ algo: 1, value: String(id).padStart(40, 'a') }],
  dependencies: [],
  releaseType: 1,
  fileDate: '2026-01-01T00:00:00Z',
  ...overrides,
})

test('CurseForge search submits the documented filters and paginates', async () => {
  const pages = []
  const server = await fixtureServer({
    '/v1/mods/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const index = Number(url.searchParams.get('index') ?? 0)
      pages.push(url.searchParams)
      const data =
        index === 0 ? [searchHit(238222, 'jei', true)] : [searchHit(448233, 'entityculling', false)]
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data,
          pagination: {
            index,
            pageSize: Number(url.searchParams.get('pageSize') ?? 20),
            resultCount: data.length,
            totalCount: 200,
          },
        }),
      )
    },
  })
  try {
    const { provider } = providerAgainst(server)
    const first = await provider.search({
      query: 'jei',
      projectType: 'mod',
      loaders: ['forge'],
      gameVersions: ['1.20.1'],
      gameVersionTypeId: 1,
      sort: 'updated',
      limit: 25,
      offset: 0,
    })
    assert.equal(pages.length, 1)
    assert.equal(pages[0].get('gameId'), '432')
    assert.equal(pages[0].get('classId'), '6')
    assert.equal(pages[0].get('gameVersion'), '1.20.1')
    assert.equal(pages[0].get('modLoaderType'), '1')
    assert.equal(pages[0].get('gameVersionTypeId'), '1')
    assert.equal(pages[0].get('sortField'), '3', 'updated sorts by last update')
    assert.equal(pages[0].get('index'), '0')
    assert.equal(pages[0].get('pageSize'), '25')
    assert.equal(first.total, 200)
    assert.equal(first.offset, 0)
    assert.equal(first.limit, 25)
    assert.equal(first.hits[0].slug, 'jei')
    assert.equal(first.hits[0].projectType, 'mod')
    assert.equal(first.hits[0].allowModDistribution, true)

    const second = await provider.search({
      query: 'jei',
      projectType: 'mod',
      loaders: ['forge'],
      gameVersions: ['1.20.1'],
      gameVersionTypeId: 1,
      sort: 'updated',
      limit: 25,
      offset: 25,
    })
    assert.equal(pages.length, 2, 'the next page is a separate request')
    assert.equal(pages[1].get('index'), '25')
    assert.equal(second.hits[0].slug, 'entityculling')
    assert.equal(second.hits[0].allowModDistribution, false, 'the policy flag is visible in hits')

    // Two loaders switch to the documented list parameter.
    let listParams
    const listServer = await fixtureServer({
      '/v1/mods/search': (req, res) => {
        listParams = new URL(req.url, 'http://127.0.0.1').searchParams
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ data: [], pagination: { index: 0, pageSize: 5, totalCount: 0 } }),
        )
      },
    })
    try {
      const list = providerAgainst(listServer)
      await list.provider.search({
        query: 'x',
        projectType: 'mod',
        loaders: ['forge', 'fabric'],
        limit: 5,
      })
      assert.equal(listParams.get('modLoaderTypes'), '1,4')
      assert.equal(listParams.get('modLoaderType'), null)
      assert.equal(listParams.get('gameId'), '432')
    } finally {
      await listServer.close()
    }
  } finally {
    await server.close()
  }
})

test('download resolution walks metadata, download-url and the CDN fallback', async () => {
  const server = await fixtureServer({
    '/v1/mods/7/files/1001': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: cfFile(1001, { downloadUrl: 'https://mediafilez.forgecdn.net/files/0/1001/m1.jar' }),
        }),
      )
    },
    '/v1/mods/7/files/1002': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: cfFile(1002) }),
      )
    },
    '/v1/mods/7/files/1002/download-url': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: 'https://edge.forgecdn.net/files/0/1002/m2.jar' }),
      )
    },
    '/v1/mods/7/files/1003': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: cfFile(1003) }),
      )
    },
    '/v1/mods/7/files/1003/download-url': (req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
    },
    '/v1/mods/7': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: 7,
            name: 'Allows distribution',
            slug: 'allows',
            summary: '',
            classId: 6,
            allowModDistribution: true,
          },
        }),
      )
    },
    '/v1/mods/8/files/1004': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: cfFile(1004, { modId: 8 }) }),
      )
    },
    '/v1/mods/8/files/1004/download-url': (req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{}')
    },
    '/v1/mods/8/files/1005': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: cfFile(1005, {
            modId: 8,
            downloadUrl: 'https://mediafilez.forgecdn.net/files/0/1005/m5.jar',
          }),
        }),
      )
    },
    '/v1/mods/8': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: 8,
            name: 'Blocks distribution',
            slug: 'blocks',
            summary: '',
            classId: 6,
            allowModDistribution: false,
          },
        }),
      )
    },
  })
  try {
    const { provider, requests } = providerAgainst(server)

    // (1) The API handed out a URL: used as is, without asking for one.
    const direct = await provider.download({ projectId: '7', versionId: '1001' })
    assert.equal(direct.source, 'metadata')
    assert.equal(direct.url, 'https://mediafilez.forgecdn.net/files/0/1001/m1.jar')
    assert.equal(direct.filename, 'file-1001.jar')
    assert.equal(direct.size, 4096)
    assert.equal(direct.hashes.sha1, String(1001).padStart(40, 'a'))
    assert.deepEqual(requests, ['GET /v1/mods/7/files/1001'], 'no extra request for a metadata URL')

    // (2) No URL in the metadata: the dedicated endpoint answers.
    const viaEndpoint = await provider.download({ projectId: '7', versionId: '1002' })
    assert.equal(viaEndpoint.source, 'endpoint')
    assert.equal(viaEndpoint.url, 'https://edge.forgecdn.net/files/0/1002/m2.jar')
    await provider.download({ projectId: '7', versionId: '1002' })
    assert.equal(
      requests.filter((entry) => entry.endsWith('/download-url')).length,
      2,
      'download URLs are not cached (their lifetime is undocumented)',
    )

    // (3) The endpoint withholds the URL and the author allows distribution: CDN.
    const viaCdn = await provider.download({ projectId: '7', versionId: '1003' })
    assert.equal(viaCdn.source, 'cdn')
    assert.equal(viaCdn.url, curseForgeCdnUrl({ id: 1003, fileName: 'file-1003.jar' }))
    assert.equal(viaCdn.url, 'https://mediafilez.forgecdn.net/files/1/003/file-1003.jar')

    // (4) Distribution disabled: the unlisted fallback is blocked, visibly.
    await assert.rejects(
      () => provider.download({ projectId: '8', versionId: '1004' }),
      (error) =>
        error instanceof ModError &&
        error.code === 'distribution-blocked' &&
        error.details.projectId === '8' &&
        error.details.fileId === '1004',
    )

    // (5) A URL the API itself offers stays usable even then: only the unlisted CDN
    // route is gated, never an author-sanctioned URL.
    const sanctioned = await provider.download({ projectId: '8', versionId: '1005' })
    assert.equal(sanctioned.source, 'metadata')
    assert.equal(sanctioned.url, 'https://mediafilez.forgecdn.net/files/0/1005/m5.jar')
  } finally {
    await server.close()
  }
})

test('CurseForge updates resolve through file ids and the latest-files index', async () => {
  let fileCalls = 0
  const server = await fixtureServer({
    '/v1/mods/files': (req, res) => {
      // First call: the installed file, with a deliberately wrong hash — an update
      // must not depend on it. Later calls: the candidate the index named.
      fileCalls += 1
      const data =
        fileCalls === 1
          ? [cfFile(1001, { hashes: [{ algo: 1, value: 'f'.repeat(40) }] })]
          : [cfFile(1002, { fileDate: '2026-02-02T00:00:00Z' })]
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    },
    '/v1/mods': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [
            {
              id: 7,
              name: 'Updates',
              slug: 'updates',
              summary: '',
              classId: 6,
              allowModDistribution: true,
              latestFilesIndexes: [
                {
                  gameVersion: '1.20.1',
                  fileId: 1002,
                  filename: 'file-1002.jar',
                  releaseType: 1,
                  gameVersionTypeId: 1,
                  modLoader: 1,
                },
              ],
            },
          ],
        }),
      )
    },
  })
  try {
    const { provider, requests } = providerAgainst(server)
    const updates = await provider.checkUpdates(
      [{ key: 'mods/a.jar', projectId: '7', fileId: '1001', channel: 'release' }],
      { minecraftVersion: '1.20.1', loader: 'forge', gameVersionTypeId: 1 },
    )
    const update = updates.get('mods/a.jar')
    assert.equal(update.projectId, '7')
    assert.equal(update.fileId, '1002')
    assert.equal(update.versionId, '1002')
    assert.equal(update.publishedAt, '2026-02-02T00:00:00Z', 'the candidate carries its file date')
    assert.deepEqual(requests, ['POST /v1/mods/files', 'POST /v1/mods', 'POST /v1/mods/files'])
    assert.ok(
      !requests.some((entry) => /fingerprint|version_files/.test(entry)),
      'update detection never falls back to hash or fingerprint matching',
    )
  } finally {
    await server.close()
  }
})

/** The same specification written as the classic MurmurHash2 body, as a cross-check. */
function referenceFingerprint(bytes) {
  const filtered = []
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) filtered.push(byte)
  }
  const multiplier = 0x5bd1e995
  const length = filtered.length
  let hash = (1 ^ length) >>> 0
  let offset = 0
  while (length - offset >= 4) {
    let word = filtered[offset] | (filtered[offset + 1] << 8) | (filtered[offset + 2] << 16)
    word = (word | (filtered[offset + 3] << 24)) >>> 0
    word = Math.imul(word, multiplier) >>> 0
    word = (word ^ (word >>> 24)) >>> 0
    word = Math.imul(word, multiplier) >>> 0
    hash = (Math.imul(hash, multiplier) ^ word) >>> 0
    offset += 4
  }
  const rest = length - offset
  if (rest >= 3) hash = (hash ^ (filtered[offset + 2] << 16)) >>> 0
  if (rest >= 2) hash = (hash ^ (filtered[offset + 1] << 8)) >>> 0
  if (rest >= 1) {
    hash = (hash ^ filtered[offset]) >>> 0
    hash = Math.imul(hash, multiplier) >>> 0
  }
  hash = (hash ^ (hash >>> 13)) >>> 0
  hash = Math.imul(hash, multiplier) >>> 0
  return (hash ^ (hash >>> 15)) >>> 0
}

test('fingerprints are computed locally, matched on request, and stay candidates', async () => {
  for (const size of [0, 1, 3, 4, 5, 8, 31, 32, 33, 257, 4096]) {
    const bytes = crypto.randomBytes(size)
    assert.equal(
      curseForgeFingerprint(bytes),
      referenceFingerprint(bytes),
      `both implementations must agree for ${size} bytes`,
    )
  }
  assert.equal(
    curseForgeFingerprint(Buffer.from('a\tb\nc\rd e')),
    curseForgeFingerprint(Buffer.from('abcde')),
    'the four stripped ASCII whitespace bytes never change the value',
  )
  const jarFingerprint = curseForgeFingerprint(jar({ 'mod.json': 'fingerprint' }))
  assert.ok(
    Number.isInteger(jarFingerprint) && jarFingerprint >= 0 && jarFingerprint <= 0xffffffff,
    'the fingerprint is an unsigned 32-bit value',
  )

  const bodies = []
  const server = await fixtureServer({
    '/v1/fingerprints': async (req, res) => {
      bodies.push(await readBody(req))
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            isCacheBuilt: true,
            exactMatches: [
              {
                id: jarFingerprint,
                file: {
                  id: 500,
                  modId: 7,
                  fileName: 'known.jar',
                  fileDate: '2026-03-03T00:00:00Z',
                },
              },
            ],
            exactFingerprints: [jarFingerprint],
            unmatchedFingerprints: [],
          },
        }),
      )
    },
  })
  try {
    const { provider } = providerAgainst(server)
    const result = await provider.fingerprintMatches([jarFingerprint])
    assert.equal(result.cacheBuilt, true)
    assert.deepEqual(result.matches, [
      {
        fingerprint: jarFingerprint,
        projectId: '7',
        fileId: '500',
        filename: 'known.jar',
        publishedAt: '2026-03-03T00:00:00Z',
      },
    ])
    assert.equal('url' in result.matches[0], false, 'a match never carries a download')
    assert.deepEqual(result.unmatched, [])
    assert.deepEqual(bodies, [{ fingerprints: [jarFingerprint] }])

    // Opt-in: nothing is requested without fingerprints, repeats are cached.
    await provider.fingerprintMatches([])
    await provider.fingerprintMatches([jarFingerprint])
    assert.equal(bodies.length, 1)
  } finally {
    await server.close()
  }
})

test('the legacy client download obeys the distribution policy on every route', async () => {
  const body = jar({ 'mod.json': 'legacy' })
  const fileSha1 = sha1(body)
  const server = await fixtureServer({
    '/v1/mods/8/files/1004': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: cfFile(1004, { modId: 8, fileLength: body.length, hashes: [{ algo: 1, value: fileSha1 }] }),
        }),
      )
    },
    '/v1/mods/8/files/1004/download-url': (req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{}')
    },
    '/v1/mods/8': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: { id: 8, name: 'Blocked', slug: 'blocked', summary: '', classId: 6, allowModDistribution: false },
        }),
      )
    },
    '/cdn/files/1/004/file-1004.jar': body,
  })
  try {
    const requests = []
    const client = new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${server.base}/v1`,
      cdnBase: `${server.base}/cdn/files`,
      fetchImpl: (url, init) => {
        requests.push(new URL(url).pathname)
        return fetch(url, init)
      },
    })
    const destination = path.join(tempDir('cf-legacy-blocked'), 'file-1004.jar')
    const file = await client.file(8, 1004)
    await assert.rejects(
      () => client.download(file, destination),
      (error) =>
        error instanceof ModError &&
        error.code === 'distribution-blocked' &&
        error.details.projectId === '8',
    )
    assert.equal(fs.existsSync(destination), false, 'no file may be placed')
    assert.equal(
      requests.some((entry) => entry.startsWith('/cdn/files/')),
      false,
      'the unlisted CDN route must not be touched for a blocked project',
    )

    // The same client still downloads through the phase 4 pipeline when allowed.
    const allowedServer = await fixtureServer({
      '/v1/mods/7/files/1001': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            data: cfFile(1001, { fileLength: body.length, hashes: [{ algo: 1, value: fileSha1 }] }),
          }),
        )
      },
      '/v1/mods/7/files/1001/download-url': (req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      },
      '/v1/mods/7': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            data: { id: 7, name: 'Allowed', slug: 'allowed', summary: '', classId: 6, allowModDistribution: true },
          }),
        )
      },
      '/cdn/files/1/001/file-1001.jar': body,
    })
    try {
      const cdn = new CurseForgeClient({
        apiKey: 'test-key',
        baseUrl: `${allowedServer.base}/v1`,
        cdnBase: `${allowedServer.base}/cdn/files`,
      })
      const target = path.join(tempDir('cf-legacy-allowed'), 'file-1001.jar')
      const allowedFile = await cdn.file(7, 1001)
      const result = await cdn.download(allowedFile, target)
      assert.equal(result.skipped, false)
      assert.equal(result.bytes, body.length)
      assert.deepEqual(fs.readFileSync(target), body)
      assert.equal(await cdn.download(allowedFile, target).then((entry) => entry.skipped), true)
      assert.deepEqual(
        fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.part')),
        [],
      )
    } finally {
      await allowedServer.close()
    }
  } finally {
    await server.close()
  }
})

test('a failed download URL gets a second resolution round instead of the same dead link', async () => {
  const body = jar({ 'mod.json': 'second-round' })
  const fileSha1 = sha1(body)
  const server = await fixtureServer({
    '/v1/mods/7/files/1001': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: cfFile(1001, {
            fileLength: body.length,
            hashes: [{ algo: 1, value: fileSha1 }],
            downloadUrl: 'https://mediafilez.forgecdn.net/files/1/001/stale-file-1001.jar',
          }),
        }),
      )
    },
    '/v1/mods/7/files/1001/download-url': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: `${server.base}/files/fresh-file-1001.jar` }),
      )
    },
    '/files/stale-file-1001.jar': (req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('expired')
    },
    '/files/fresh-file-1001.jar': body,
  })
  try {
    const { provider } = providerAgainst(server)
    const request = { projectId: '7', versionId: '1001' }
    const first = await provider.download(request)
    assert.equal(first.source, 'metadata')
    const destination = path.join(tempDir('cf-second-round'), first.filename)
    await assert.rejects(
      () =>
        streamToFile({
          urls: [first.url],
          destination,
          retry: { attempts: 1 },
          fetchImpl: (url) =>
            url === first.url ? Promise.resolve(new Response('', { status: 403 })) : fetch(url),
        }),
      (error) => error.name === 'DownloadError' && error.code === 'http-error',
    )
    assert.equal(fs.existsSync(destination), false, 'the dead URL leaves no file')

    // Second round: nothing may answer with the URL that just failed.
    const second = await provider.download({ ...request, excludeUrl: first.url })
    assert.equal(second.source, 'endpoint')
    assert.notEqual(second.url, first.url)
    const downloaded = await streamToFile({
      urls: [second.url],
      destination,
      expected: { sha1: fileSha1, size: body.length },
    })
    assert.equal(downloaded.sha1, fileSha1)
    assert.deepEqual(fs.readFileSync(destination), body)
  } finally {
    await server.close()
  }
})

test('the client download re-resolves once when the chosen route is dead', async () => {
  const body = jar({ 'mod.json': 'stale-route' })
  const fileSha1 = sha1(body)
  // The stale URL must stay on the fixture server: this test drives the real
  // download path, so an external host here would be an actual internet request.
  let staleUrl = ''
  const server = await fixtureServer({
    '/v1/mods/7/files/1001': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: cfFile(1001, {
            fileLength: body.length,
            hashes: [{ algo: 1, value: fileSha1 }],
            // Exactly what the API hands out: a URL that has since expired.
            downloadUrl: staleUrl,
          }),
        }),
      )
    },
    '/v1/mods/7/files/1001/download-url': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: `${server.base}/files/fresh-file-1001.jar` }),
      )
    },
    '/files/stale-file-1001.jar': (req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('expired')
    },
    '/files/fresh-file-1001.jar': body,
  })
  staleUrl = `${server.base}/files/stale-file-1001.jar`
  try {
    const asked = []
    const client = new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${server.base}/v1`,
      fetchImpl: (url, init) => {
        asked.push(new URL(url).pathname)
        return fetch(url, init)
      },
    })
    const target = path.join(tempDir('cf-client-second-round'), 'file-1001.jar')
    // Without the second round this is where the old code stopped:
    // DownloadError:http-error for the expired metadata URL, nothing on disk.
    const result = await client.download(await client.file(7, 1001), target)
    assert.equal(result.skipped, false)
    assert.equal(result.bytes, body.length)
    assert.deepEqual(fs.readFileSync(target), body)
    assert.ok(
      asked.includes('/files/stale-file-1001.jar'),
      'the dead metadata route is attempted first, on the fixture server',
    )
    assert.equal(
      asked.filter((entry) => entry === '/v1/mods/7/files/1001/download-url').length,
      1,
      'the failed route must be replaced by asking download-url again',
    )
    assert.equal(
      asked.filter((entry) => entry.startsWith('/cdn/')).length,
      0,
      'a working second route makes the CDN fallback unnecessary',
    )
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name.includes('.part')),
      [],
    )
  } finally {
    await server.close()
  }
})

test('search pagination stops at the documented limit with its own diagnostic', async () => {
  const server = await fixtureServer({
    '/v1/mods/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [],
          pagination: {
            index: Number(url.searchParams.get('index') ?? 0),
            pageSize: Number(url.searchParams.get('pageSize') ?? 20),
            totalCount: 10_000,
          },
        }),
      )
    },
  })
  try {
    const { provider, requests } = providerAgainst(server)
    const query = {
      query: '',
      projectType: 'mod',
      loaders: ['forge'],
      gameVersions: ['1.20.1'],
      limit: 50,
    }
    // Exactly at the limit: still served.
    const last = await provider.search({ ...query, offset: 9950 })
    assert.equal(last.offset, 9950)
    assert.equal(requests.length, 1)

    await assert.rejects(
      () => provider.search({ ...query, offset: 9975 }),
      (error) =>
        error instanceof ModError &&
        error.code === 'pagination-limit' &&
        error.details.index === 9975 &&
        error.details.limit === 10_000,
    )
    assert.equal(requests.length, 1, 'the impossible page is rejected before any request')
  } finally {
    await server.close()
  }
})

test('a CurseForge file installs through the phase 4 pipeline and is removable again', async () => {
  const body = jar({ 'mod.json': 'installed' })
  const fileSha1 = sha1(body)
  const server = await fixtureServer({
    '/v1/mods/7/files/1001': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: cfFile(1001, { fileLength: body.length }) }),
      )
    },
    '/v1/mods/7/files/1001/download-url': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: `${server.base}/files/file-1001.jar` }),
      )
    },
    '/files/file-1001.jar': body,
    '/v1/mods/7': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: 7,
            name: 'Installable',
            slug: 'installable',
            summary: '',
            classId: 6,
            allowModDistribution: true,
          },
        }),
      )
    },
  })
  try {
    const { provider } = providerAgainst(server)
    const resolved = await provider.download({ projectId: '7', versionId: '1001' })
    assert.equal(resolved.source, 'endpoint')

    const instance = tempDir('cf-install-instance')
    const store = new ModContentStore({ root: tempDir('cf-install-store') })
    const destination = path.join(instance, 'mods', resolved.filename)
    const downloaded = await streamToFile({
      urls: [resolved.url],
      destination,
      expected: { sha1: fileSha1, size: body.length },
    })
    const adopted = await store.adopt(destination, {
      sha1: downloaded.sha1,
      sha512: downloaded.sha512,
      bytes: downloaded.bytes,
    })
    assert.equal(adopted.created, true)
    const ledger = new ModLedger(instance)
    const committed = await store.commit({
      instanceDir: instance,
      folder: 'mods',
      filename: resolved.filename,
      sha1: downloaded.sha1,
      sha512: downloaded.sha512,
      size: downloaded.bytes,
      ledger,
      record: {
        provider: 'curseforge',
        projectId: '7',
        fileId: '1001',
        versionId: '1001',
        name: 'Installable',
        channel: 'release',
      },
    })
    assert.equal(committed.recorded, true)
    assert.deepEqual(fs.readFileSync(destination), body)
    const installed = await ledger.list()
    assert.equal(installed.length, 1)
    assert.equal(installed[0].sha1, fileSha1)
    assert.equal(installed[0].fileId, '1001')
    assert.equal(installed[0].provider, 'curseforge')
    assert.deepEqual(installed[0].paths, [`mods/${resolved.filename}`])
    assert.equal((await store.catalog()).length, 1)

    // Removal uses the existing removal path; the ledger is the state that forgets it.
    const removed = await removeInstalledContent({
      instanceDir: instance,
      path: `mods/${resolved.filename}`,
      expectedSha1: fileSha1,
    })
    assert.equal(removed.sha1, fileSha1)
    assert.equal(fs.existsSync(destination), false)
    assert.equal(await ledger.removePath(`mods/${resolved.filename}`), fileSha1)
    assert.deepEqual(await new ModLedger(instance).list(), [])
    assert.equal((await store.catalog()).length, 1, 'the object stays for other instances')
  } finally {
    await server.close()
  }
})
