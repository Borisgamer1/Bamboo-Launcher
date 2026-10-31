/**
 * Contract tests for the shipped mod handlers `download-mod` and
 * `delete-content-file`. `main.js` forwards their payloads unchanged to
 * `electron/mods/legacy-bridge`, so these objects are what the renderer sends
 * and what it reads back.
 *
 * The requirements are the security properties the core already guarantees:
 * a download whose bytes do not match the published hash must write nothing, a
 * provider filename with `..` or an absolute path must be refused, and file,
 * pack lock and content index must agree after install, update and removal.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const AdmZip = require('adm-zip')
const { fixtureServer, jar, sha1, sha512, tempDir } = require('./harness.cjs')

/** A jar whose only entry is mod metadata, as the fixture provider serves it. */
const modJar = (id, version) =>
  jar({ 'fabric.mod.json': JSON.stringify({ id, name: id, version }) })
const {
  exportLegacyProfile,
  importLegacyProfile,
  installLegacyMod,
  removeLegacyContent,
} = require('../dist-electron/mods/legacy-bridge.js')
const {
  OfflineModIndex,
  readModpackLock,
  writeModpackLock,
} = require('../dist-electron/mods/index.js')

/** Metadata for one Modrinth version; the URL is what the UI would send. */
function versionPayload(base, { id, filename, bytes }) {
  return JSON.stringify({
    id,
    project_id: 'project-state',
    name: filename,
    version_number: id,
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: `${base}/files/${filename}`,
        filename,
        size: bytes.length,
        hashes: { sha1: sha1(bytes), sha512: sha512(bytes) },
        primary: true,
      },
    ],
  })
}

function cdnUrl(versionId, filename) {
  // The renderer only sends a CDN URL; its version segment is the identity the
  // bridge resolves through the API before any write.
  return `https://cdn.modrinth.com/data/project-state/versions/${versionId}/${filename}`
}

test('a download with the wrong hash is refused and writes nothing', async () => {
  const dir = tempDir('hash')
  const root = path.join(dir, 'game')
  const good = modJar('demo', '1.0')
  // Same length, one flipped byte: the size check passes, the hash must not.
  const tampered = Buffer.from(good)
  tampered[tampered.length - 1] ^= 0xff
  const routes = {}
  const server = await fixtureServer(routes)
  try {
    routes['/version/v1'] = versionPayload(server.base, {
      id: 'v1',
      filename: 'demo.jar',
      bytes: good,
    })
    routes['/files/demo.jar'] = tampered
    await assert.rejects(
      () =>
        installLegacyMod(
          {
            folderName: 'Hash Pack',
            versionId: '1.20.1',
            downloadUrl: cdnUrl('v1', 'demo.jar'),
            filename: 'demo.jar',
            itemType: 'mods',
          },
          { rootPath: root, modrinthBaseUrl: server.base },
        ),
      /checksum|Checksum/i,
    )
    const instanceDir = path.join(root, 'profiles', 'Hash Pack')
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'demo.jar')), false)
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods.index.json')), false)
    // Nothing may be left behind under a temp/part name either.
    const leftovers = fs.existsSync(path.join(instanceDir, 'mods'))
      ? fs.readdirSync(path.join(instanceDir, 'mods'))
      : []
    assert.deepEqual(leftovers, [])
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unsafe content filenames are refused by both shipped handlers', async () => {
  const dir = tempDir('traversal')
  const root = path.join(dir, 'game')
  const outside = path.join(root, 'profiles', 'evil.jar')
  const sentinel = path.join(dir, 'sentinel.jar')
  fs.mkdirSync(path.dirname(outside), { recursive: true })
  fs.writeFileSync(sentinel, 'keep')

  // (b1) install: `..` must be rejected before any network call.
  await assert.rejects(
    () =>
      installLegacyMod(
        {
          folderName: 'Safe Pack',
          versionId: '1.20.1',
          downloadUrl: cdnUrl('v1', '../evil.jar'),
          filename: '../evil.jar',
          itemType: 'mods',
        },
        { rootPath: root, modrinthBaseUrl: 'http://127.0.0.1:1' },
      ),
    (error) => error.code === 'unsafe-path',
  )
  assert.equal(fs.existsSync(outside), false)

  // (b2) absolute path.
  await assert.rejects(
    () =>
      installLegacyMod(
        {
          folderName: 'Safe Pack',
          versionId: '1.20.1',
          downloadUrl: cdnUrl('v1', 'evil.jar'),
          filename: sentinel,
          itemType: 'mods',
        },
        { rootPath: root, modrinthBaseUrl: 'http://127.0.0.1:1' },
      ),
    (error) => error.code === 'unsafe-path',
  )

  // (b3) delete: traversal returns false (the legacy boolean contract) and
  // leaves both the sentinel and the file outside the instance untouched.
  fs.mkdirSync(path.join(root, 'profiles', 'Safe Pack', 'mods'), { recursive: true })
  fs.writeFileSync(path.join(root, 'profiles', 'Safe Pack', 'mods', 'keep.jar'), 'keep')
  const removed = await removeLegacyContent(
    { folderName: 'Safe Pack', fileName: '../../sentinel.jar', type: 'mods' },
    { rootPath: root },
  )
  assert.equal(removed, false)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep')
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'Safe Pack', 'mods', 'keep.jar')), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('install, update and removal keep file, pack lock and index in sync', async () => {
  const dir = tempDir('state')
  const root = path.join(dir, 'game')
  const v1 = modJar('demo', '1.0')
  const v2 = modJar('demo', '2.0')
  const routes = {}
  const server = await fixtureServer(routes)
  try {
    routes['/files/demo.jar'] = (req, res, count) => (count === 1 ? v1 : v2)
    routes['/version/v1'] = versionPayload(server.base, { id: 'v1', filename: 'demo.jar', bytes: v1 })
    routes['/version/v2'] = versionPayload(server.base, { id: 'v2', filename: 'demo.jar', bytes: v2 })
    // Seed the instance through the shipped pack import so a lock entry exists.
    const archive = path.join(dir, 'state.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          name: 'State Pack',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [
            {
              path: 'mods/demo.jar',
              downloads: [`${server.base}/files/demo.jar`],
              fileSize: v1.length,
              hashes: { sha1: sha1(v1), sha512: sha512(v1) },
            },
          ],
        }),
      ),
    )
    zip.writeZip(archive)
    const imported = await importLegacyProfile(
      { filePath: archive, installMods: true, installConfig: true },
      { rootPath: root },
    )
    assert.equal(imported.success, true, imported.error)
    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
    const folderName = profiles[0].folderName
    const instanceDir = path.join(root, 'profiles', folderName)
    const file = path.join(instanceDir, 'mods', 'demo.jar')
    assert.equal(fs.readFileSync(file).equals(v1), true)

    // Update through the shipped download handler (same filename, new bytes).
    const installed = await installLegacyMod(
      {
        folderName,
        profileName: 'State Pack',
        versionId: '1.20.1',
        downloadUrl: cdnUrl('v2', 'demo.jar'),
        filename: 'demo.jar',
        itemType: 'mods',
      },
      { rootPath: root, modrinthBaseUrl: server.base },
    )
    assert.equal(installed.success, true)
    assert.equal(installed.path, file)
    assert.equal(installed.size, v2.length)
    assert.equal(fs.readFileSync(file).equals(v2), true)

    const index = new OfflineModIndex(path.join(instanceDir, 'mods.index.json'))
    const entries = await index.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sha1, sha1(v2))
    assert.equal(entries[0].versionId, 'v2')
    assert.equal(entries[0].projectId, 'project-state')

    const lockAfterUpdate = await readModpackLock(instanceDir)
    assert.equal(lockAfterUpdate.files.length, 1)
    assert.equal(lockAfterUpdate.files[0].path, 'mods/demo.jar')
    assert.equal(lockAfterUpdate.files[0].sha1, sha1(v2))
    assert.equal(lockAfterUpdate.files[0].size, v2.length)

    // Remove through the shipped delete handler.
    const removed = await removeLegacyContent(
      { folderName, fileName: 'demo.jar', type: 'mods' },
      { rootPath: root },
    )
    assert.equal(removed, true)
    assert.equal(fs.existsSync(file), false)
    // Re-read from disk: the bridge writes through its own index instance.
    assert.deepEqual(await new OfflineModIndex(path.join(instanceDir, 'mods.index.json')).list(), [])
    const lockAfterRemove = await readModpackLock(instanceDir)
    assert.equal(lockAfterRemove.files.length, 0)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('delete-content-file keeps its datapack folder contract', async () => {
  const dir = tempDir('datapack')
  const root = path.join(dir, 'game')
  const instanceDir = path.join(root, 'profiles', 'Pack')
  fs.mkdirSync(path.join(instanceDir, 'datapacks'), { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'datapacks', 'data.zip'), 'zip')
  try {
    const removed = await removeLegacyContent(
      { folderName: 'Pack', fileName: 'data.zip', type: 'datapacks' },
      { rootPath: root },
    )
    assert.equal(removed, true)
    assert.equal(fs.existsSync(path.join(instanceDir, 'datapacks', 'data.zip')), false)
    // Idempotent: the UI deletes twice during an update flow.
    assert.equal(
      await removeLegacyContent(
        { folderName: 'Pack', fileName: 'data.zip', type: 'datapacks' },
        { rootPath: root },
      ),
      true,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a custom BAMBOO_GAME_ROOT routes all four handlers into that root', async () => {
  const dir = tempDir('env-root')
  const root = path.join(dir, 'custom-root')
  fs.mkdirSync(root, { recursive: true })
  const bytes = modJar('envdemo', '1.0')
  const routes = {}
  const server = await fixtureServer(routes)
  const previous = process.env.BAMBOO_GAME_ROOT
  process.env.BAMBOO_GAME_ROOT = root
  try {
    // import-profile
    const archive = path.join(dir, 'Env Pack.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          name: 'Env Pack',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [],
        }),
      ),
    )
    zip.writeZip(archive)
    const imported = await importLegacyProfile(
      { filePath: archive, installMods: true },
      { modrinthBaseUrl: server.base },
    )
    assert.equal(imported.success, true, imported.error)
    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
    const folderName = profiles[0].folderName
    const instanceDir = path.join(root, 'profiles', folderName)

    // download-mod: no rootPath is passed on purpose.
    routes['/version/v1'] = versionPayload(server.base, { id: 'v1', filename: 'env.jar', bytes })
    routes['/files/env.jar'] = bytes
    const installed = await installLegacyMod(
      {
        folderName,
        versionId: '1.20.1',
        downloadUrl: cdnUrl('v1', 'env.jar'),
        filename: 'env.jar',
        itemType: 'mods',
      },
      { modrinthBaseUrl: server.base },
    )
    assert.equal(installed.success, true)
    assert.equal(installed.path, path.join(instanceDir, 'mods', 'env.jar'))

    // export-profile without savePath lands in <root>/cache.
    const exported = await exportLegacyProfile(
      { format: 'mrpack', instanceName: 'Env Pack', folderName, suggestedFileName: 'env-pack.mrpack' },
      { modrinthBaseUrl: server.base },
    )
    assert.equal(exported.success, true, exported.error)
    assert.equal(exported.filePath, path.join(root, 'cache', 'env-pack.mrpack'))

    // delete-content-file
    assert.equal(await removeLegacyContent({ folderName, fileName: 'env.jar', type: 'mods' }), true)
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'env.jar')), false)
  } finally {
    if (previous === undefined) delete process.env.BAMBOO_GAME_ROOT
    else process.env.BAMBOO_GAME_ROOT = previous
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped main process routes all four handlers through the bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  for (const call of [
    'importLegacyProfile(payload,',
    'exportLegacyProfile(payload)',
    'installLegacyMod(payload',
    'removeLegacyContent(payload)',
  ]) {
    assert.ok(source.includes(call), `${call} must be wired`)
  }
})

test('a CurseForge CDN download is verified from API metadata and committed', async () => {
  const dir = tempDir('curseforge')
  const root = path.join(dir, 'game')
  const folderName = 'CF Pack'
  const instanceDir = path.join(root, 'profiles', folderName)
  fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
  const oldBytes = modJar('cfdemo', '0.9')
  fs.writeFileSync(path.join(instanceDir, 'mods', 'cfmod.jar'), oldBytes)
  await writeModpackLock(instanceDir, {
    version: 1,
    format: 'mrpack',
    name: 'CF Pack',
    versionId: '0.9.0',
    upstream: { provider: 'local', format: 'mrpack', name: 'CF Pack' },
    dependencies: { minecraft: '1.20.1' },
    files: [
      { path: 'mods/cfmod.jar', sha1: sha1(oldBytes), size: oldBytes.length, source: 'pack' },
    ],
    updatedAt: Date.now(),
  })

  const bytes = modJar('cfdemo', '1.0')
  const apiCalls = []
  const routes = {}
  const server = await fixtureServer(routes)
  try {
    routes['/v1/mods/files'] = async (req) => {
      const raw = await new Promise((resolve) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => resolve(data))
      })
      apiCalls.push({ headers: req.headers, body: JSON.parse(raw) })
      return JSON.stringify({
        data: [
          {
            id: 123456,
            modId: 4242,
            displayName: 'CF Demo 1.0',
            fileName: 'cfmod.jar',
            fileLength: bytes.length,
            downloadUrl: `${server.base}/files/123/456/cfmod.jar`,
            gameVersions: ['1.20.1'],
            hashes: [{ algo: 1, value: sha1(bytes) }],
            dependencies: [],
          },
        ],
      })
    }
    routes['/files/123/456/cfmod.jar'] = bytes

    const installed = await installLegacyMod(
      {
        folderName,
        profileName: folderName,
        // The renderer sends only the CDN URL and the file name — no hashes.
        versionId: '1.20.1',
        downloadUrl: 'https://edge.forgecdn.net/files/123/456/cfmod.jar',
        filename: 'cfmod.jar',
        itemType: 'mods',
      },
      {
        rootPath: root,
        curseforgeApiKey: 'test-cf-key',
        curseforgeBaseUrl: `${server.base}/v1`,
      },
    )

    assert.equal(installed.success, true)
    assert.equal(apiCalls.length, 1)
    assert.deepEqual(apiCalls[0].body, { fileIds: [123456] })
    assert.equal(apiCalls[0].headers['x-api-key'], 'test-cf-key')
    assert.equal(installed.path, path.join(instanceDir, 'mods', 'cfmod.jar'))
    assert.equal(installed.size, bytes.length)
    assert.equal(fs.readFileSync(installed.path).equals(bytes), true)

    const index = new OfflineModIndex(path.join(instanceDir, 'mods.index.json'))
    const entries = await index.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sha1, sha1(bytes))
    assert.equal(entries[0].source, 'curseforge')
    assert.equal(entries[0].projectId, '4242')
    assert.equal(entries[0].versionId, '123456')

    const lock = await readModpackLock(instanceDir)
    assert.equal(lock.files.length, 1)
    assert.equal(lock.files[0].path, 'mods/cfmod.jar')
    assert.equal(lock.files[0].sha1, sha1(bytes))
    assert.equal(lock.files[0].size, bytes.length)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a CurseForge download with manipulated bytes is refused and writes nothing', async () => {
  const dir = tempDir('curseforge-bad')
  const root = path.join(dir, 'game')
  const good = modJar('cfdemo', '2.0')
  const tampered = Buffer.from(good)
  tampered[tampered.length - 1] ^= 0xff
  const routes = {}
  const server = await fixtureServer(routes)
  try {
    routes['/v1/mods/files'] = JSON.stringify({
      data: [
        {
          id: 777888,
          modId: 55,
          displayName: 'CF Tampered',
          fileName: 'bad.jar',
          fileLength: good.length,
          downloadUrl: `${server.base}/files/777/888/bad.jar`,
          gameVersions: [],
          hashes: [{ algo: 1, value: sha1(good) }],
          dependencies: [],
        },
      ],
    })
    routes['/files/777/888/bad.jar'] = tampered

    await assert.rejects(
      () =>
        installLegacyMod(
          {
            folderName: 'CF Bad',
            versionId: '1.20.1',
            downloadUrl: 'https://edge.forgecdn.net/files/777/888/bad.jar',
            filename: 'bad.jar',
            itemType: 'mods',
          },
          {
            rootPath: root,
            curseforgeApiKey: 'test-cf-key',
            curseforgeBaseUrl: `${server.base}/v1`,
          },
        ),
      // The transfer now runs through the phase 4 pipeline, which reports the
      // mismatch as a DownloadError with the spec's reason instead of free text.
      (error) => error.name === 'DownloadError' && error.code === 'checksum-mismatch',
    )
    const instanceDir = path.join(root, 'profiles', 'CF Bad')
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'bad.jar')), false)
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods.index.json')), false)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a CurseForge download without an API key fails with an actionable message', async () => {
  const dir = tempDir('curseforge-nokey')
  try {
    await assert.rejects(
      () =>
        installLegacyMod(
          {
            folderName: 'CF NoKey',
            versionId: '1.20.1',
            downloadUrl: 'https://edge.forgecdn.net/files/1/2/nokey.jar',
            filename: 'nokey.jar',
            itemType: 'mods',
          },
          { rootPath: path.join(dir, 'game') },
        ),
      /API-Key/i,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
