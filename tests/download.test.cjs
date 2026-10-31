/**
 * Phase 4 tests: checksum validation, retry/mirror rotation, skip/resume,
 * abort, transactional materialize rollback, a full vanilla install from an
 * empty root and the missing asset-index repair path. All servers are local
 * fixtures; no Mojang request is made.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, tempDir } = require('./harness.cjs')

const { createNullLogger } = require('../dist-electron/logger.js')
const { sha1Hex, sha512Hex } = require('../dist-electron/download/checksum.js')
const { runInstallManifest, isFileValid } = require('../dist-electron/download/executor.js')
const { requestBuffer } = require('../dist-electron/download/http.js')
const { applyMaterializeTask, MaterializeError } = require('../dist-electron/download/materialize.js')
const { resolveVersionModel } = require('../dist-electron/version/resolve.js')
const { installAssets } = require('../dist-electron/install/assets.js')
const { installVersion } = require('../dist-electron/install/version.js')

const fastRetry = {
  attempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  sleep: async () => undefined,
  random: () => 0.5,
}

function spec(pathname, urls, content) {
  return {
    path: pathname,
    urls,
    size: content.length,
    checksum: { algorithm: 'sha1', value: sha1Hex(content) },
  }
}

async function runFiles(destination, files, options = {}) {
  return runInstallManifest(
    { version: 1, tasks: [{ type: 'files', id: 'files', destination, files }] },
    { retry: fastRetry, ...options },
  )
}

test('download engine rejects bad checksums and rotates mirrors', async () => {
  const good = Buffer.from('verified mirror payload', 'utf8')
  const good512 = Buffer.from('sha-512 payload', 'utf8')
  const server = await fixtureServer({
    '/bad': { status: 500, body: Buffer.from('nope') },
    '/corrupt': { body: Buffer.from('wrong bytesxxxxxxxxxxxx') },
    '/good': { body: good },
    '/good512': { body: good512 },
  })
  const root = tempDir('rotation')
  try {
    const checksumFile = spec('a.bin', [`${server.base}/bad`, `${server.base}/good`], good)
    const corruptFile = spec('b.bin', [`${server.base}/corrupt`, `${server.base}/good`], good)
    const sha512File = {
      path: 'c512.bin',
      urls: [`${server.base}/good512`],
      size: good512.length,
      checksum: { algorithm: 'sha512', value: sha512Hex(good512) },
    }
    const report = await runFiles(root, [checksumFile, corruptFile, sha512File])
    assert.equal(report.downloadedFiles, 3)
    assert.equal(report.downloadedBytes, good.length * 2 + good512.length)
    assert.equal(fs.readFileSync(path.join(root, 'a.bin')).toString(), good.toString())
    assert.equal(fs.readFileSync(path.join(root, 'b.bin')).toString(), good.toString())
    assert.equal(fs.readFileSync(path.join(root, 'c512.bin')).toString(), good512.toString())
    assert.equal(server.hits.get('/bad'), 1)
    assert.equal(server.hits.get('/corrupt'), 1)
    assert.equal(server.hits.get('/good'), 2)

    const doomed = spec('c.bin', [`${server.base}/corrupt`], good)
    await assert.rejects(
      () => runFiles(root, [doomed]),
      (error) => error.code === 'checksum-mismatch' && error.attempts === undefined,
    )
    assert.equal(fs.existsSync(path.join(root, 'c.bin')), false, 'corrupt payload must not be materialized')
    assert.equal(server.hits.get('/corrupt'), 3, 'two attempts for the doomed file')

    const escaped = spec('../escape.bin', [`${server.base}/good`], good)
    await assert.rejects(
      () => runFiles(path.join(root, 'safe'), [escaped]),
      (error) => error.code === 'invalid',
    )
    assert.equal(fs.existsSync(path.join(root, 'escape.bin')), false, 'paths must not escape the destination')
  } finally {
    await server.close()
  }
})

test('terminal permission errors are not retried', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      requestBuffer({
        urls: ['http://127.0.0.1/denied'],
        retry: fastRetry,
        fetchImpl: async () => {
          calls += 1
          const error = new Error('denied by filesystem')
          error.code = 'EACCES'
          throw error
        },
      }),
    (error) => error.code === 'EACCES',
  )
  assert.equal(calls, 1, 'EACCES must abort immediately instead of backing off')
})

test('a shared install signal does not accumulate fetch abort listeners', async () => {
  const root = tempDir('listener-budget')
  const controller = new AbortController()
  const counts = new WeakMap()
  let maxPerSignal = 0
  const addEventListener = AbortSignal.prototype.addEventListener
  const removeEventListener = AbortSignal.prototype.removeEventListener

  // Electron 20's fetch keeps an abort listener on the signal it receives for
  // the lifetime of the response. This fake fetch mirrors that so the test
  // fails if one long-lived install signal is handed to every file.
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type === 'abort') {
      const next = (counts.get(this) ?? 0) + 1
      counts.set(this, next)
      maxPerSignal = Math.max(maxPerSignal, next)
    }
    return addEventListener.call(this, type, listener, options)
  }
  AbortSignal.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'abort') counts.set(this, Math.max(0, (counts.get(this) ?? 0) - 1))
    return removeEventListener.call(this, type, listener, options)
  }

  try {
    const files = Array.from({ length: 120 }, (_, index) => ({
      path: `f${index}.bin`,
      urls: [`http://127.0.0.1/${index}`],
    }))
    await runFiles(root, files, {
      signal: controller.signal,
      maxConcurrency: 4,
      fetchImpl: async (_url, init) => {
        init?.signal?.addEventListener('abort', () => undefined, { once: true })
        return new Response('x')
      },
    })
    assert.ok(maxPerSignal <= 8, `one signal received ${maxPerSignal} abort listeners`)
  } finally {
    AbortSignal.prototype.addEventListener = addEventListener
    AbortSignal.prototype.removeEventListener = removeEventListener
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('zip and json validators reject damaged existing files', async () => {
  const root = tempDir('validators')
  try {
    const zip = path.join(root, 'lib.jar')
    fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    assert.equal(await isFileValid(zip, { validator: 'zip' }), true)
    fs.writeFileSync(zip, 'not a zip')
    assert.equal(await isFileValid(zip, { validator: 'zip' }), false)

    const json = path.join(root, 'index.json')
    fs.writeFileSync(json, '{"objects":{}}')
    assert.equal(await isFileValid(json, { validator: 'json' }), true)
    fs.writeFileSync(json, '{not json')
    assert.equal(await isFileValid(json, { validator: 'json' }), false)

    // The explicit trustExistingSize fast path accepts a size match without
    // hashing; normal files must still fail a checksum mismatch.
    const trusted = path.join(root, 'trusted.jar')
    fs.writeFileSync(trusted, 'sizematches')
    assert.equal(await isFileValid(trusted, { size: 11, trustExistingSize: true }), true)
    assert.equal(
      await isFileValid(trusted, { size: 11, checksum: { algorithm: 'sha1', value: sha1Hex(Buffer.from('other')) } }),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('existing files are skipped and corrupt files are repaired', async () => {
  const one = Buffer.from('one', 'utf8')
  const two = Buffer.from('two-two', 'utf8')
  const three = Buffer.from('three-three-three', 'utf8')
  const server = await fixtureServer({
    '/one': { body: one },
    '/two': { body: two },
    '/three': { body: three },
  })
  const root = tempDir('resume')
  try {
    const files = [
      spec('one.bin', [`${server.base}/one`], one),
      spec('two.bin', [`${server.base}/two`], two),
      spec('three.bin', [`${server.base}/three`], three),
    ]
    fs.writeFileSync(path.join(root, 'one.bin'), one)
    // Same size, wrong content: only the checksum can detect this.
    fs.writeFileSync(path.join(root, 'two.bin'), Buffer.from('TWO-TWO'))

    const first = await runFiles(root, files)
    assert.equal(first.skippedFiles, 1)
    assert.equal(first.downloadedFiles, 2)
    assert.equal(server.hits.get('/one'), undefined, 'valid file must not be requested')
    assert.equal(server.hits.get('/two'), 1)
    assert.equal(fs.readFileSync(path.join(root, 'two.bin')).toString(), 'two-two')

    const second = await runFiles(root, files)
    assert.equal(second.downloadedBytes, 0)
    assert.equal(second.downloadedFiles, 0)
    assert.equal(second.skippedFiles, 3)
    assert.equal(await isFileValid(path.join(root, 'one.bin'), files[0]), true)
  } finally {
    await server.close()
  }
})

test('abort at 50% leaves no temp files and the next run resumes', async () => {
  const contents = [1, 2, 3, 4].map((index) => Buffer.from(`payload-${index}-`.repeat(20), 'utf8'))
  const routes = {}
  contents.forEach((content, index) => {
    routes[`/f${index}`] = { body: content }
  })
  const server = await fixtureServer(routes)
  const root = tempDir('abort')
  try {
    const files = contents.map((content, index) =>
      spec(`f${index}.bin`, [`${server.base}/f${index}`], content),
    )
    const controller = new AbortController()
    const progress = []
    await assert.rejects(
      () =>
        runFiles(root, files, {
          signal: controller.signal,
          maxConcurrency: 1,
          onProgress: (state) => {
            progress.push(state)
            if (state.phase === 'file-done' && state.completedFiles === 2) {
              controller.abort(new Error('test abort at 50%'))
            }
          },
        }),
      (error) => error.code === 'aborted',
    )
    assert.equal(progress.filter((state) => state.phase === 'file-done').length, 2)
    assert.equal(fs.existsSync(path.join(root, 'f0.bin')), true)
    assert.equal(fs.existsSync(path.join(root, 'f1.bin')), true)
    assert.equal(fs.existsSync(path.join(root, 'f2.bin')), false)
    assert.equal(
      fs.readdirSync(root).some((name) => name.includes('.part')),
      false,
      'aborted downloads must not leave temp files',
    )

    const resumed = await runFiles(root, files)
    assert.equal(resumed.skippedFiles, 2)
    assert.equal(resumed.downloadedFiles, 2)
    assert.equal(server.hits.get('/f0'), 1)
    assert.equal(server.hits.get('/f1'), 1)
    contents.forEach((content, index) => {
      assert.equal(fs.readFileSync(path.join(root, `f${index}.bin`)).toString(), content.toString())
    })
  } finally {
    await server.close()
  }
})

test('materialize failures roll back previously written and removed files', async () => {
  const root = tempDir('rollback')
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'old-a')
    fs.writeFileSync(path.join(root, 'b.txt'), 'old-b')
    const failing = {
      type: 'materialize',
      id: 'rollback',
      root,
      operations: [
        { type: 'write', path: 'a.txt', content: 'new-a' },
        { type: 'remove', path: 'b.txt' },
        { type: 'write', path: 'nested/c.txt', content: 'new-c' },
        { type: 'copy', from: 'missing.txt', path: 'copy.txt' },
      ],
    }
    await assert.rejects(
      () => applyMaterializeTask(failing),
      (error) => error instanceof MaterializeError && error.rollbackErrors.length === 0,
    )
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old-a')
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'old-b')
    assert.equal(fs.existsSync(path.join(root, 'nested')), false)
    assert.equal(fs.existsSync(path.join(root, 'copy.txt')), false)
    assert.equal(fs.existsSync(path.join(root, '.bamboo-tmp')), false)

    fs.writeFileSync(path.join(root, 'old.txt'), 'before')
    await applyMaterializeTask({
      type: 'materialize',
      id: 'commit',
      root,
      operations: [
        { type: 'write', path: 'new.txt', content: 'after' },
        { type: 'remove', path: 'old.txt' },
        { type: 'ensure-directory', path: 'data/empty' },
      ],
    })
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'after')
    assert.equal(fs.existsSync(path.join(root, 'old.txt')), false)
    assert.equal(fs.statSync(path.join(root, 'data', 'empty')).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(root, '.bamboo-tmp')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dependency order, cycle detection and java tasks are enforced', async () => {
  const payload = Buffer.from('dependency-payload', 'utf8')
  const server = await fixtureServer({ '/payload': { body: payload } })
  const root = tempDir('graph')
  try {
    // The materialize task is listed first but depends on the file task.
    const report = await runInstallManifest(
      {
        version: 1,
        tasks: [
          {
            type: 'materialize',
            id: 'copy-after-download',
            root,
            dependsOn: ['download'],
            operations: [{ type: 'copy', from: 'payload.bin', path: 'copied.bin' }],
          },
          {
            type: 'files',
            id: 'download',
            destination: root,
            files: [spec('payload.bin', [`${server.base}/payload`], payload)],
          },
          { type: 'java', id: 'jre', majorVersion: 17 },
        ],
      },
      {
        retry: fastRetry,
        installJava: async (task, context) => {
          assert.equal(task.majorVersion, 17)
          assert.equal(context.signal.aborted, false)
        },
      },
    )
    assert.equal(report.tasks, 3)
    assert.equal(fs.readFileSync(path.join(root, 'copied.bin')).toString(), payload.toString())

    await assert.rejects(
      () =>
        runInstallManifest({
          version: 1,
          tasks: [
            { type: 'java', id: 'a', majorVersion: 8, dependsOn: ['b'] },
            { type: 'java', id: 'b', majorVersion: 8, dependsOn: ['a'] },
          ],
        }),
      (error) => error.code === 'invalid' && /Cyclic/.test(error.message),
    )

    await assert.rejects(
      () => runInstallManifest({ version: 1, tasks: [{ type: 'java', id: 'only', majorVersion: 8 }] }),
      (error) => error.code === 'invalid' && /No Java installer/.test(error.message),
    )
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('DoD: 1.20.1 installs from an empty root, reruns download 0 bytes and repairs one file', async () => {
  const client = Buffer.from('client-jar-bytes', 'utf8')
  const libA = Buffer.from('library-a', 'utf8')
  const libB = Buffer.from('library-b', 'utf8')
  const objectA = Buffer.from('asset-object-a', 'utf8')
  const objectB = Buffer.from('asset-object-b', 'utf8')
  const hashA = sha1Hex(objectA)
  const hashB = sha1Hex(objectB)

  const routes = {}
  const server = await fixtureServer(routes)
  const index = {
    objects: {
      'minecraft/sounds/a.ogg': { hash: hashA, size: objectA.length },
      'icons/b.png': { hash: hashB, size: objectB.length },
    },
  }
  const indexBytes = Buffer.from(JSON.stringify(index))
  const versionJson = {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: {
      id: '5',
      url: `${server.base}/assets/indexes/5.json`,
      sha1: sha1Hex(indexBytes),
      size: indexBytes.length,
      totalSize: objectA.length + objectB.length,
    },
    downloads: { client: { url: `${server.base}/client.jar`, sha1: sha1Hex(client), size: client.length } },
    libraries: [
      {
        name: 'com.example:alpha:1.0',
        downloads: {
          artifact: {
            path: 'com/example/alpha/1.0/alpha-1.0.jar',
            url: `${server.base}/libs/alpha.jar`,
            sha1: sha1Hex(libA),
            size: libA.length,
          },
        },
      },
      {
        name: 'com.example:beta:2.0',
        downloads: {
          artifact: {
            path: 'com/example/beta/2.0/beta-2.0.jar',
            url: `${server.base}/libs/beta.jar`,
            sha1: sha1Hex(libB),
            size: libB.length,
          },
        },
      },
    ],
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  }
  const versionBytes = Buffer.from(JSON.stringify(versionJson))
  const manifestBytes = Buffer.from(
    JSON.stringify({
      latest: { release: '1.20.1', snapshot: '1.20.1' },
      versions: [
        {
          id: '1.20.1',
          type: 'release',
          url: `${server.base}/version.json`,
          sha1: sha1Hex(versionBytes),
        },
      ],
    }),
  )
  Object.assign(routes, {
    '/version_manifest_v2.json': { body: manifestBytes },
    '/version.json': { body: versionBytes },
    '/client.jar': { body: client },
    '/libs/alpha.jar': { body: libA },
    '/libs/beta.jar': { body: libB },
    '/assets/indexes/5.json': { body: indexBytes },
    [`/${hashA.slice(0, 2)}/${hashA}`]: { body: objectA },
    [`/${hashB.slice(0, 2)}/${hashB}`]: { body: objectB },
  })

  const root = tempDir('version-install')
  const cacheDir = path.join(root, 'cache')
  try {
    const first = await installVersion(root, '1.20.1', {
      cacheDir,
      manifestSources: [`${server.base}/version_manifest_v2.json`],
      objectBaseUrls: [server.base],
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(first.versionJsonDownloaded, true)
    assert.equal(first.model.mainClass, 'net.minecraft.client.main.Main')
    assert.equal(first.filesReport.downloadedFiles, 3)
    assert.equal(first.assets.objectsReport.downloadedFiles, 2)
    assert.equal(first.model.assets.available, true)
    assert.equal(first.model.assets.count, 2)
    assert.equal(first.model.assets.id, '5')
    assert.equal(fs.readFileSync(path.join(root, 'versions/1.20.1/1.20.1.jar'), 'utf8'), client.toString())
    assert.equal(
      fs.readFileSync(path.join(root, 'libraries/com/example/alpha/1.0/alpha-1.0.jar'), 'utf8'),
      libA.toString(),
    )
    assert.equal(fs.readFileSync(path.join(root, 'assets/indexes/5.json'), 'utf8'), indexBytes.toString())
    assert.equal(fs.existsSync(path.join(root, `assets/objects/${hashA.slice(0, 2)}/${hashA}`)), true)
    assert.equal(fs.existsSync(path.join(root, `assets/objects/${hashB.slice(0, 2)}/${hashB}`)), true)
    for (const entry of first.model.classpath.slice(0, -1)) {
      assert.equal(fs.existsSync(entry), true, `library ${entry} must exist`)
    }

    const manifestHits = server.hits.get('/version_manifest_v2.json')
    const second = await installVersion(root, '1.20.1', {
      cacheDir,
      manifestSources: [`${server.base}/version_manifest_v2.json`],
      objectBaseUrls: [server.base],
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(second.downloadedBytes, 0, 'a complete root must not download anything again')
    assert.equal(second.filesReport.skippedFiles, 3)
    assert.equal(second.assets.objectsReport.skippedFiles, 2)
    assert.equal(server.hits.get('/version_manifest_v2.json'), manifestHits, 'version JSON exists, so the manifest is not fetched')

    fs.writeFileSync(path.join(root, 'versions/1.20.1/1.20.1.jar'), 'corrupted')
    const repaired = await installVersion(root, '1.20.1', {
      cacheDir,
      manifestSources: [`${server.base}/version_manifest_v2.json`],
      objectBaseUrls: [server.base],
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(repaired.downloadedBytes, client.length)
    assert.equal(repaired.filesReport.downloadedFiles, 1)
    assert.equal(repaired.filesReport.skippedFiles, 2)
    assert.equal(server.hits.get('/client.jar'), 2)
    assert.equal(fs.readFileSync(path.join(root, 'versions/1.20.1/1.20.1.jar'), 'utf8'), client.toString())
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a real missing asset index (17 for 1.21) is fetched by the engine and appears in the resolver', async () => {
  const objectOne = Buffer.from('legacy-looking-object-one', 'utf8')
  const objectTwo = Buffer.from('legacy-looking-object-two', 'utf8')
  const hashOne = sha1Hex(objectOne)
  const hashTwo = sha1Hex(objectTwo)
  const routes = {}
  const server = await fixtureServer(routes)
  const index = {
    objects: {
      'minecraft/lang/de_de.json': { hash: hashOne, size: objectOne.length },
      // Same hash under a second name: the index has three entries, but only
      // two object files may be downloaded.
      'minecraft/lang/en_us.json': { hash: hashOne, size: objectOne.length },
      'minecraft/textures/gui/title.png': { hash: hashTwo, size: objectTwo.length },
    },
  }
  const indexBytes = Buffer.from(JSON.stringify(index))
  Object.assign(routes, {
    '/assets/indexes/17.json': { body: indexBytes },
    [`/${hashOne.slice(0, 2)}/${hashOne}`]: { body: objectOne },
    [`/${hashTwo.slice(0, 2)}/${hashTwo}`]: { body: objectTwo },
  })

  const root = tempDir('asset-index-17')
  try {
    fs.mkdirSync(path.join(root, 'versions', '1.21'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'versions', '1.21', '1.21.json'),
      JSON.stringify({
        id: '1.21',
        type: 'release',
        mainClass: 'net.minecraft.client.main.Main',
        assets: '17',
        assetIndex: {
          id: '17',
          url: `${server.base}/assets/indexes/17.json`,
          sha1: sha1Hex(indexBytes),
          size: indexBytes.length,
          totalSize: objectOne.length + objectTwo.length,
        },
        javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
      }),
    )
    const before = await resolveVersionModel(root, '1.21', { logger: createNullLogger() })
    assert.equal(before.assets.id, '17')
    assert.equal(before.assets.available, false, 'index 17 is the missing file in this scenario')
    assert.equal(before.assets.count, 0)

    const installed = await installAssets(root, before, {
      objectBaseUrls: [server.base],
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(installed.assets.available, true)
    assert.equal(installed.assets.count, 3)
    assert.equal(installed.downloadedBytes, indexBytes.length + objectOne.length + objectTwo.length)
    assert.equal(installed.indexReport.downloadedFiles, 1)
    assert.equal(installed.objectsReport.downloadedFiles, 2, 'shared hashes are downloaded once')
    assert.equal(server.hits.get(`/${hashOne.slice(0, 2)}/${hashOne}`), 1)

    const after = await resolveVersionModel(root, '1.21', { logger: createNullLogger() })
    assert.equal(after.assets.available, true)
    assert.equal(after.assets.count, 3)
    assert.equal(after.assets.legacyVirtual, false)
    for (const object of after.assets.objects) {
      assert.equal(fs.existsSync(object.absolutePath), true)
    }

    const again = await installAssets(root, after, {
      objectBaseUrls: [server.base],
      retry: fastRetry,
      logger: createNullLogger(),
    })
    assert.equal(again.downloadedBytes, 0)
    assert.equal(again.skippedFiles, 2)
    assert.equal(server.hits.get('/assets/indexes/17.json'), 1)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
