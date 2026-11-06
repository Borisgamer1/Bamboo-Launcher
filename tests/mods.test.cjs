/**
 * Phase 9 tests: metadata, dependency check, providers and modpack import.
 * Everything runs against a local fixture server; no real API is contacted.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, jar, sha1, sha512, tempDir } = require('./harness.cjs')

const AdmZip = require('adm-zip')
const { createNullLogger } = require('../dist-electron/logger.js')
const { inspectJarMetadata } = require('../dist-electron/mods/jar-inspect.js')
const {
  parseModMetadata,
  parseTomlSubset,
  readModMetadata,
  readModMetadataList,
  findMissingRequired,
  providedIds,
  ModrinthClient,
  CurseForgeClient,
  curseForgeCdnUrl,
  readModpackFormat,
  readMrpackManifest,
  readModpackLock,
  installModpack,
  updateModpack,
  exportModpack,
  checkModUpdates,
  applyModUpdate,
  installModrinthProject,
  removeInstalledContent,
  OfflineModIndex,
  pickModrinthVersion,
  ModError,
} = require('../dist-electron/mods/index.js')

test('parses Fabric, Forge, NeoForge and legacy metadata', () => {
  const fabric = parseModMetadata({
    'fabric.mod.json': Buffer.from(
      JSON.stringify({
        id: 'sodium',
        name: 'Sodium',
        version: '0.5.8',
        depends: { minecraft: '>=1.20', fabricloader: '>=0.15', java: '>=17', 'indium': '*' },
        provides: ['sodium-api'],
      }),
    ),
  })
  assert.equal(fabric.id, 'sodium')
  assert.equal(fabric.loader, 'fabric')
  assert.equal(fabric.minecraftVersionRange, '>=1.20')
  assert.deepEqual(fabric.provides, ['sodium-api'])
  assert.deepEqual(fabric.dependencies.map((dep) => dep.id), ['indium'])

  const toml = `
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="examplemod"
version="1.2.3"
displayName="Example Mod"
provides=["example-api"]

[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47,)"
    ordering="NONE"
    side="BOTH"
[[dependencies.examplemod]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.21)"
    ordering="NONE"
    side="BOTH"
[[dependencies.examplemod]]
    modId="othermod"
    mandatory=true
    versionRange="[2.0,)"
    ordering="NONE"
    side="BOTH"
[[dependencies.examplemod]]
    modId="optionalmod"
    mandatory=false
    versionRange="*"
    ordering="NONE"
    side="BOTH"
`
  const forge = parseModMetadata({ 'META-INF/mods.toml': Buffer.from(toml) })
  assert.equal(forge.id, 'examplemod')
  assert.equal(forge.name, 'Example Mod')
  assert.equal(forge.loader, 'forge')
  assert.equal(forge.minecraftVersionRange, '[1.20.1,1.21)')
  assert.deepEqual(forge.dependencies.map((dep) => dep.id), ['othermod'])
  assert.deepEqual(forge.provides, ['example-api'])

  const neo = parseModMetadata({
    'META-INF/neoforge.mods.toml': Buffer.from(toml.replace('examplemod', 'neomod')),
  })
  assert.equal(neo.loader, 'neoforge')
  assert.equal(neo.id, 'neomod')

  const legacy = parseModMetadata({
    'mcmod.info': Buffer.from(
      JSON.stringify([{ modid: 'oldmod', name: 'Old', version: '1.0', requiredMods: ['coremod'] }]),
    ),
  })
  assert.equal(legacy.loader, 'legacy')
  assert.deepEqual(legacy.dependencies.map((dep) => dep.id), ['coremod'])

  assert.equal(parseModMetadata({ 'readme.txt': Buffer.from('x') }), undefined)
})

test('jar inspector reuses the core metadata and adds icon, description and authors', () => {
  const dir = tempDir('jar-inspect')
  try {
    const zip = new AdmZip()
    zip.addFile(
      'fabric.mod.json',
      Buffer.from(
        JSON.stringify({
          id: 'sodium',
          name: 'Sodium',
          version: '0.5.8',
          description: 'Rendering engine',
          authors: ['jellysquid3', { name: 'Other' }],
          icon: 'assets/icon.png',
        }),
      ),
    )
    zip.addFile('assets/icon.png', Buffer.from([137, 80, 78, 71]))
    const jarPath = path.join(dir, 'sodium.jar')
    fs.writeFileSync(jarPath, zip.toBuffer())

    const meta = inspectJarMetadata(jarPath)
    assert.equal(meta.modName, 'Sodium')
    assert.equal(meta.modVersion, '0.5.8')
    assert.equal(meta.modLoader, 'fabric')
    assert.equal(meta.description, 'Rendering engine')
    assert.equal(meta.authors, 'jellysquid3, Other')
    assert.equal(meta.iconBase64, 'data:image/png;base64,iVBORw=='
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('TOML subset strips comments after headers and values, keeps # in strings', () => {
  const tables = parseTomlSubset([
    'modLoader = "javafml" #mandatory',
    '[[mods]] #mandatory',
    '    modId = "iceandfire" #mandatory',
    '    description = "# not a comment" # optional',
    '[[dependencies.iceandfire]] #optional',
    '    modId="citadel" #mandatory',
    '    mandatory=true #mandatory',
    '    versionRange="[1.8.1,1.8.99]" #mandatory',
  ].join('\n'))
  const mod = tables.find((table) => table.path[0] === 'mods')
  assert.equal(mod.values.modId, 'iceandfire')
  assert.equal(mod.values.description, '# not a comment')
  const dependency = tables.find((table) => table.path[0] === 'dependencies')
  assert.equal(dependency.values.modId, 'citadel')
  assert.equal(dependency.values.mandatory, true)
  assert.equal(dependency.values.versionRange, '[1.8.1,1.8.99]')
})

test('TOML subset ignores multi-line descriptions and parses arrays', () => {
  const tables = parseTomlSubset(`
[[mods]]
modId="x"
description='''
multi
line
'''
version="1.0"
tags=["a", "b"]
`)
  const mod = tables.find((table) => table.path[0] === 'mods')
  assert.equal(mod.values.modId, 'x')
  assert.equal(mod.values.version, '1.0')
  assert.deepEqual(mod.values.tags, ['a', 'b'])
})

test('readModMetadata reads a jar and the dependency check reports only missing required ids', async () => {
  const dir = tempDir('deps')
  try {
    const core = path.join(dir, 'core.jar')
    fs.writeFileSync(
      core,
      jar({
        'fabric.mod.json': JSON.stringify({ id: 'corelib', version: '1.0', provides: ['core-api'] }),
      }),
    )
    const addon = path.join(dir, 'addon.jar')
    fs.writeFileSync(
      addon,
      jar({
        'fabric.mod.json': JSON.stringify({
          id: 'addon',
          version: '1.0',
          depends: { corelib: '*', 'missing-lib': '>=2' },
          recommends: { 'optional-lib': '*' },
        }),
      }),
    )
    const optionalOnly = path.join(dir, 'optional.jar')
    fs.writeFileSync(
      optionalOnly,
      jar({
        'META-INF/mods.toml': `[[mods]]\nmodId="opt"\nversion="1"\n[[dependencies.opt]]\nmodId="ghost"\nmandatory=false\nversionRange="*"\n`,
      }),
    )
    const parsed = await readModMetadata(addon)
    assert.equal(parsed.id, 'addon')
    const all = [await readModMetadata(core), await readModMetadata(addon), await readModMetadata(optionalOnly)]
    assert.ok(providedIds(all).has('core-api'))
    const missing = findMissingRequired(all)
    assert.deepEqual(missing.map((entry) => entry.id), ['missing-lib'])
    assert.deepEqual(missing[0].requiredBy, ['addon'])
    assert.equal(missing[0].versionRange, '>=2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('jar-in-jar modules satisfy required Fabric dependencies', async () => {
  const dir = tempDir('nested')
  try {
    const inner = new AdmZip()
    inner.addFile(
      'fabric.mod.json',
      Buffer.from(JSON.stringify({ id: 'inner-lib', version: '1.0', provides: ['inner-api'] })),
    )
    const outer = new AdmZip()
    outer.addFile(
      'fabric.mod.json',
      Buffer.from(
        JSON.stringify({ id: 'outer', version: '1.0', depends: { 'inner-lib': '*', 'inner-api': '*' } }),
      ),
    )
    outer.addFile('META-INF/jars/inner-lib.jar', inner.toBuffer())
    const jarPath = path.join(dir, 'outer.jar')
    fs.writeFileSync(jarPath, outer.toBuffer())

    const list = await readModMetadataList(jarPath)
    assert.deepEqual(list.map((mod) => mod.id).sort(), ['inner-lib', 'outer'])
    assert.deepEqual(findMissingRequired(list), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Modrinth client picks a matching version and skips a second download', async () => {
  const dir = tempDir('modrinth')
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'demo', version: '1.0' }) })
  const routes = {
    '/v2/project/demo/version': {
      body: Buffer.from(
        JSON.stringify([
          {
            id: 'v2',
            project_id: 'proj-demo',
            name: 'Demo 2.0',
            version_number: '2.0',
            game_versions: ['1.21'],
            loaders: ['fabric'],
            files: [{ url: 'http://127.0.0.1:1/nope.jar', filename: 'demo-2.jar', primary: true }],
          },
          {
            id: 'v1',
            project_id: 'proj-demo',
            name: 'Demo 1.0',
            version_number: '1.0',
            game_versions: ['1.20.1'],
            loaders: ['fabric'],
            files: [
              {
                url: 'BASE/files/demo-1.jar',
                filename: 'demo-1.jar',
                size: payload.length,
                hashes: { sha1: sha1(payload), sha512: sha512(payload) },
                primary: true,
              },
            ],
            dependencies: [{ project_id: 'dep', dependency_type: 'required' }],
          },
        ]),
      ),
    },
    '/files/demo-1.jar': { body: payload },
  }
  const server = await fixtureServer(routes)
  routes['/v2/project/demo/version'].body = Buffer.from(
    routes['/v2/project/demo/version'].body.toString('utf8').replaceAll('BASE', server.base),
  )
  try {
    const client = new ModrinthClient({ baseUrl: `${server.base}/v2`, fetchImpl: fetch })
    const version = await client.resolveVersion('demo', {
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    assert.equal(version.versionNumber, '1.0')
    const target = path.join(dir, 'mods', 'demo-1.jar')
    const first = await client.downloadVersion(version, target)
    assert.equal(first.skipped, false)
    assert.ok(first.bytes > 0)
    const second = await client.downloadVersion(version, target)
    assert.equal(second.skipped, true)
    assert.equal(second.bytes, 0)
    assert.equal(fs.readFileSync(target).equals(payload), true)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mrpack install downloads files, applies overrides last and is idempotent', async () => {
  const dir = tempDir('mrpack')
  const payload = jar({
    'fabric.mod.json': JSON.stringify({ id: 'packmod', version: '1.0' }),
  })
  const server = await fixtureServer({
    '/files/packmod.jar': { body: payload },
  })
  try {
    const archive = path.join(dir, 'pack.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          name: 'Test Pack',
          versionId: '1.0.0',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [
            {
              path: 'mods/packmod.jar',
              downloads: [`${server.base}/files/packmod.jar`],
              fileSize: payload.length,
              hashes: { sha1: sha1(payload) },
            },
            {
              path: 'mods/server-only.jar',
              downloads: [`${server.base}/files/server-only.jar`],
              env: { client: 'unsupported', server: 'required' },
            },
          ],
        }),
      ),
    )
    zip.addFile('overrides/config/pack.cfg', Buffer.from('key=value\n'))
    zip.writeZip(archive)

    assert.equal(await readModpackFormat(archive), 'mrpack')
    const instanceDir = path.join(dir, 'instance')
    const first = await installModpack({ instanceDir, archivePath: archive })
    assert.equal(first.format, 'mrpack')
    assert.deepEqual(first.installed, ['mods/packmod.jar'])
    assert.deepEqual(first.skipped, ['mods/server-only.jar'])
    assert.equal(first.overrides, 1)
    assert.ok(first.downloadedBytes > 0)
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'pack.cfg'), 'utf8'), 'key=value\n')
    assert.equal(fs.existsSync(path.join(instanceDir, 'modrinth.index.json')), true)

    const second = await installModpack({ instanceDir, archivePath: archive })
    assert.equal(second.downloadedBytes, 0)
    assert.deepEqual(second.installed, [])
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mrpack refuses path traversal entries', async () => {
  const dir = tempDir('traversal')
  try {
    const archive = path.join(dir, 'evil.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          name: 'Evil',
          dependencies: {},
          files: [{ path: '../outside.jar', downloads: ['http://127.0.0.1:1/x'], hashes: {} }],
        }),
      ),
    )
    zip.writeZip(archive)
    await assert.rejects(
      () => installModpack({ instanceDir: path.join(dir, 'instance'), archivePath: archive }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge client honors Retry-After and resolves required dependencies', async () => {
  const dir = tempDir('curseforge')
  const modA = jar({
    'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1.0', depends: { modb: '*' } }),
  })
  const modB = jar({ 'fabric.mod.json': JSON.stringify({ id: 'modb', version: '1.0' }) })
  const sleeps = []
  let live
  const routes = {
    '/v1/mods/1/files/10': (req, res, count) => {
      if (count === 1) {
        res.writeHead(429, { 'retry-after': '1' }).end('slow down')
        return
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            data: {
              id: 10,
              modId: 1,
              fileName: 'moda.jar',
              fileLength: modA.length,
              downloadUrl: `${live.base}/cf/moda.jar`,
              hashes: [{ algo: 1, value: sha1(modA) }],
              gameVersions: ['1.20.1'],
              dependencies: [{ modId: 2, relationType: 3 }],
            },
          }),
        )
    },
    '/v1/mods/2/files': (req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            data: [
              {
                id: 20,
                modId: 2,
                fileName: 'modb.jar',
                fileLength: modB.length,
                downloadUrl: `${live.base}/cf/modb.jar`,
                hashes: [{ algo: 1, value: sha1(modB) }],
                gameVersions: ['1.20.1'],
                dependencies: [],
              },
            ],
          }),
        )
    },
    '/cf/moda.jar': { body: modA },
    '/cf/modb.jar': { body: modB },
  }
  live = await fixtureServer(routes)
  try {
    const client = new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${live.base}/v1`,
      fetchImpl: fetch,
      sleep: async (ms) => sleeps.push(ms),
    })
    const archive = path.join(dir, 'pack.zip')
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          name: 'CF Pack',
          minecraft: {
            version: '1.20.1',
            modLoaders: [{ id: 'fabric-0.15.11', primary: true }],
          },
          files: [{ projectID: 1, fileID: 10, required: true }],
          overrides: 'overrides',
        }),
      ),
    )
    zip.addFile('overrides/config/cf.cfg', Buffer.from('a=b\n'))
    zip.writeZip(archive)

    const instanceDir = path.join(dir, 'instance')
    const first = await installModpack({
      instanceDir,
      archivePath: archive,
      curseforge: client,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    assert.equal(first.format, 'curseforge')
    assert.deepEqual(first.installed, ['moda.jar'])
    assert.deepEqual(first.installedDependencies, ['modb.jar'])
    assert.deepEqual(first.missingDependencies, [])
    assert.ok(sleeps.length >= 1, '429 must wait before retrying')
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda.jar')), true)
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'modb.jar')), true)
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'cf.cfg'), 'utf8'), 'a=b\n')

    const second = await installModpack({
      instanceDir,
      archivePath: archive,
      curseforge: client,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    assert.equal(second.downloadedBytes, 0)
    assert.deepEqual(second.installed, [])
    assert.deepEqual(second.installedDependencies, [])
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge falls back to the public CDN when download-url is withheld', async () => {
  const dir = tempDir('curseforge-cdn')
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1.0' }) })
  const routes = {
    '/v1/mods/1/files/10010/download-url': (req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden"}')
    },
    '/cdn/10/010/mod%20a.jar': { body: payload },
    // The CDN fallback is only taken with the author's permission, so the chain
    // asks for the project before it touches that route.
    '/v1/mods/1': (req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: { id: 1, name: 'Mod A', allowModDistribution: true } }))
    },
  }
  const live = await fixtureServer(routes)
  try {
    assert.equal(
      curseForgeCdnUrl({ id: 10010, fileName: 'mod a.jar' }, `${live.base}/cdn`),
      `${live.base}/cdn/10/010/mod%20a.jar`,
    )
    const client = new CurseForgeClient({
      apiKey: 'test-key',
      baseUrl: `${live.base}/v1`,
      cdnBase: `${live.base}/cdn`,
    })
    const target = path.join(dir, 'mod a.jar')
    const result = await client.download(
      {
        id: 10010,
        modId: 1,
        fileName: 'mod a.jar',
        fileLength: payload.length,
        downloadUrl: null,
        hashes: [{ algo: 1, value: sha1(payload) }],
        dependencies: [],
        displayName: 'Mod A',
        gameVersions: ['1.20.1'],
      },
      target,
    )
    assert.equal(result.bytes, payload.length)
    assert.equal(fs.readFileSync(target).length, payload.length)
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge sends the API key to its API and CDN hosts only', async () => {
  // Since 2026-07-16 the CDN rejects keyless direct downloads; an arbitrary
  // `downloadUrl` host still must not receive the key.
  // https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/
  const dir = tempDir('curseforge-headers')
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1.0' }) })
  const file = {
    id: 10010,
    modId: 1,
    fileName: 'mod.jar',
    displayName: 'Mod A',
    fileLength: payload.length,
    downloadUrl: null,
    gameVersions: ['1.20.1'],
    hashes: [{ algo: 1, value: sha1(payload) }],
    dependencies: [],
  }
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {} })
    if (String(url).includes('/v1/mods/1')) {
      return new Response(JSON.stringify({ data: { id: 1, name: 'Mod A' } }), { status: 200 })
    }
    return new Response(payload, { status: 200 })
  }
  try {
    const client = new CurseForgeClient({ apiKey: 'test-key', fetchImpl })
    await client.mod(1)
    const cdnHosts = ['edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net']
    for (const [index, host] of cdnHosts.entries()) {
      await client.download(
        { ...file, downloadUrl: `https://${host}/files/10/010/mod.jar` },
        path.join(dir, `cdn-${index}.jar`),
      )
    }
    await client.download(
      { ...file, downloadUrl: 'https://mirror.example/files/mod.jar' },
      path.join(dir, 'mirror.jar'),
    )

    assert.equal(requests.length, 5)
    assert.equal(requests[0].url, 'https://api.curseforge.com/v1/mods/1')
    assert.equal(requests[0].headers['x-api-key'], 'test-key')
    for (const [index, host] of cdnHosts.entries()) {
      assert.equal(requests[index + 1].url, `https://${host}/files/10/010/mod.jar`)
      assert.equal(requests[index + 1].headers['x-api-key'], 'test-key', host)
    }
    assert.equal(requests[4].url, 'https://mirror.example/files/mod.jar')
    assert.equal(requests[4].headers['x-api-key'], undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a CDN redirect never forwards the API key to a foreign host', async () => {
  const dir = tempDir('curseforge-redirect')
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1.0' }) })
  const seen = []
  const follower = await fixtureServer({
    '/files/10/010/mod.jar': (req, res) => {
      seen.push({ host: 'follower', key: req.headers['x-api-key'] })
      res.writeHead(200, { 'content-length': payload.length }).end(payload)
    },
  })
  let location = `${follower.base}/files/10/010/mod.jar`
  const redirector = await fixtureServer({
    '/files/10/010/mod.jar': (req, res) => {
      seen.push({ host: 'redirector', key: req.headers['x-api-key'] })
      res.writeHead(302, { location }).end()
    },
  })
  // DNS cannot point edge.forgecdn.net at the fixture, so the fetch seam maps
  // the CurseForge hostnames onto the two local servers. Key decision, redirect
  // following and hash verification remain the shipped code.
  const fetchImpl = (url, init) => {
    const target = new URL(url)
    const local = {
      'edge.forgecdn.net': redirector.base,
      'mediafilez.forgecdn.net': follower.base,
    }[target.hostname]
    return fetch(local ? `${local}${target.pathname}` : url, init)
  }
  const file = {
    id: 10010,
    modId: 1,
    fileName: 'mod.jar',
    displayName: 'Mod A',
    fileLength: payload.length,
    downloadUrl: 'https://edge.forgecdn.net/files/10/010/mod.jar',
    gameVersions: ['1.20.1'],
    hashes: [{ algo: 1, value: sha1(payload) }],
    dependencies: [],
  }
  try {
    const client = new CurseForgeClient({ apiKey: 'test-key', fetchImpl })
    await client.download(file, path.join(dir, 'foreign.jar'))
    assert.deepEqual(seen, [
      { host: 'redirector', key: 'test-key' },
      { host: 'follower', key: undefined },
    ])

    // The same chain, but the redirect stays on a CurseForge CDN host.
    seen.length = 0
    location = 'https://mediafilez.forgecdn.net/files/10/010/mod.jar'
    await client.download(file, path.join(dir, 'cdn.jar'))
    assert.deepEqual(seen, [
      { host: 'redirector', key: 'test-key' },
      { host: 'follower', key: 'test-key' },
    ])
  } finally {
    await follower.close()
    await redirector.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge client requires an API key', () => {
  assert.throws(
    () => new CurseForgeClient({ apiKey: '' }),
    (error) => error instanceof ModError && error.code === 'missing-api-key',
  )
})

function writePack(directory, name, dependencies) {
  const archive = path.join(directory, `${name}.mrpack`)
  const zip = new AdmZip()
  zip.addFile(
    'modrinth.index.json',
    Buffer.from(JSON.stringify({ formatVersion: 1, name, dependencies, files: [] })),
  )
  zip.writeZip(archive)
  return archive
}

test('update refuses a loader change even when the dependency key changes', async () => {
  const dir = tempDir('loader-change')
  try {
    const instanceDir = path.join(dir, 'instance')
    await installModpack({
      instanceDir,
      archivePath: writePack(dir, 'v1', { minecraft: '1.20.1', 'fabric-loader': '0.15.11' }),
    })
    await assert.rejects(
      () =>
        updateModpack({
          instanceDir,
          archivePath: writePack(dir, 'v2', { minecraft: '1.20.1', forge: '47.2.0' }),
        }),
      (error) => error instanceof ModError && error.code === 'loader-mismatch',
    )
    // The same loader with a new build is still a change and must be refused.
    await assert.rejects(
      () =>
        updateModpack({
          instanceDir,
          archivePath: writePack(dir, 'v3', {
            minecraft: '1.20.1',
            'fabric-loader': '0.16.0',
          }),
        }),
      (error) => error instanceof ModError && error.code === 'loader-mismatch',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('version selection never falls back to a different loader', () => {
  const versions = [
    {
      id: 'forge-1',
      projectId: 'p',
      name: 'Forge build',
      versionNumber: '1',
      gameVersions: ['1.20.1'],
      loaders: ['forge'],
      files: [{ url: 'http://127.0.0.1:1/x.jar', filename: 'x.jar' }],
      dependencies: [],
    },
  ]
  assert.equal(pickModrinthVersion(versions, { minecraftVersion: '1.20.1', loader: 'fabric' }), undefined)
  assert.equal(pickModrinthVersion(versions, { minecraftVersion: '1.20.1' })?.id, 'forge-1')
  assert.equal(
    pickModrinthVersion(versions, { minecraftVersion: '1.21', loader: 'forge' }),
    undefined,
  )
})

test('export writes a self-contained mrpack that imports into a fresh instance', async () => {
  const dir = tempDir('export')
  const payload = jar({
    'fabric.mod.json': JSON.stringify({ id: 'packmod', version: '1.0' }),
  })
  const server = await fixtureServer({ '/files/packmod.jar': { body: payload } })
  try {
    const archive = path.join(dir, 'source.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          name: 'Source Pack',
          versionId: '2.1.0',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [
            {
              path: 'mods/packmod.jar',
              downloads: [`${server.base}/files/packmod.jar`],
              fileSize: payload.length,
              hashes: { sha1: sha1(payload), sha512: sha512(payload) },
            },
          ],
        }),
      ),
    )
    zip.addFile('overrides/config/pack.cfg', Buffer.from('key=value\n'))
    zip.writeZip(archive)

    const instanceDir = path.join(dir, 'instance')
    await installModpack({ instanceDir, archivePath: archive })
    fs.mkdirSync(path.join(instanceDir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(instanceDir, 'logs', 'latest.log'), 'noise')
    fs.mkdirSync(path.join(instanceDir, 'saves', 'world'), { recursive: true })
    fs.writeFileSync(path.join(instanceDir, 'saves', 'world', 'level.dat'), 'world')

    const exported = path.join(dir, 'exported.mrpack')
    const result = await exportModpack({ instanceDir, destination: exported })
    assert.equal(result.files, 0)
    assert.equal(result.overrides, 2)
    const manifest = await readMrpackManifest(exported)
    assert.equal(manifest.name, 'Source Pack')
    assert.equal(manifest.versionId, '2.1.0')
    assert.deepEqual(manifest.dependencies, { minecraft: '1.20.1', 'fabric-loader': '0.15.11' })
    const exportedZip = new AdmZip(exported)
    assert.equal(exportedZip.getEntry('overrides/mods/packmod.jar') !== null, true)
    assert.equal(exportedZip.getEntry('overrides/config/pack.cfg') !== null, true)
    assert.equal(exportedZip.getEntry('overrides/logs/latest.log'), null)
    assert.equal(exportedZip.getEntry('overrides/saves/world/level.dat'), null)
    assert.equal(exportedZip.getEntry('overrides/modpack.lock.json'), null)

    const fresh = path.join(dir, 'fresh')
    const imported = await installModpack({ instanceDir: fresh, archivePath: exported })
    assert.equal(imported.overrides, 2)
    assert.equal(
      fs.readFileSync(path.join(fresh, 'config', 'pack.cfg'), 'utf8'),
      'key=value\n',
    )
    assert.equal(fs.readFileSync(path.join(fresh, 'mods', 'packmod.jar')).equals(payload), true)

    // With a resolver the managed file becomes a download reference again.
    const withReferences = path.join(dir, 'referenced.mrpack')
    const referenced = await exportModpack({
      instanceDir,
      destination: withReferences,
      resolveFile: ({ path: filePath }) =>
        filePath.endsWith('.jar') ? { downloads: [`${server.base}/files/packmod.jar`] } : undefined,
    })
    assert.equal(referenced.files, 1)
    assert.equal(referenced.overrides, 1)
    const referencedManifest = await readMrpackManifest(withReferences)
    assert.deepEqual(referencedManifest.files.map((file) => file.path), ['mods/packmod.jar'])
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('update check batches installed hashes and applies only a verified replacement', async () => {
  const dir = tempDir('updates')
  const oldJar = jar({ 'fabric.mod.json': JSON.stringify({ id: 'demo', version: '1.0' }) })
  const newJar = jar({ 'fabric.mod.json': JSON.stringify({ id: 'demo', version: '2.0' }) })
  let received
  const routes = {
    '/v2/version_files/update_many': (req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received = { method: req.method, body: JSON.parse(body) }
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            [sha1(oldJar)]: {
              id: 'v2',
              project_id: 'proj-demo',
              name: 'Demo 2.0',
              version_number: '2.0',
              game_versions: ['1.20.1'],
              loaders: ['fabric'],
              files: [
                {
                  url: `${live.base}/files/demo-2.jar`,
                  filename: 'demo-2.jar',
                  size: newJar.length,
                  hashes: { sha1: sha1(newJar), sha512: sha512(newJar) },
                  primary: true,
                },
              ],
              dependencies: [],
            },
          }),
        )
      })
    },
    '/files/demo-2.jar': { body: newJar },
  }
  const live = await fixtureServer(routes)
  try {
    const instanceDir = path.join(dir, 'instance')
    fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
    fs.writeFileSync(path.join(instanceDir, 'mods', 'demo-1.jar'), oldJar)
    fs.writeFileSync(path.join(instanceDir, 'mods', 'notes.txt'), 'ignored')
    const client = new ModrinthClient({ baseUrl: `${live.base}/v2` })

    const check = await checkModUpdates({
      instanceDir,
      client,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    })
    assert.equal(check.checked, 1)
    assert.equal(check.updates.length, 1)
    assert.deepEqual(check.unresolved, [])
    assert.equal(received.method, 'POST')
    assert.equal(received.body.algorithm, 'sha1')
    assert.deepEqual(received.body.hashes, [sha1(oldJar)])
    assert.deepEqual(received.body.loaders, ['fabric'])
    assert.deepEqual(received.body.game_versions, ['1.20.1'])

    const applied = await applyModUpdate({
      instanceDir,
      candidate: check.updates[0],
      client,
    })
    assert.equal(applied.installed, 'mods/demo-2.jar')
    assert.equal(applied.removed, 'mods/demo-1.jar')
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'demo-1.jar')), false)
    assert.equal(
      fs.readFileSync(path.join(instanceDir, 'mods', 'demo-2.jar')).equals(newJar),
      true,
    )

    // A stale decision must not delete a file the user replaced meanwhile.
    fs.writeFileSync(path.join(instanceDir, 'mods', 'stale.jar'), oldJar)
    const staleCandidate = { ...check.updates[0], path: 'mods/stale.jar' }
    fs.writeFileSync(path.join(instanceDir, 'mods', 'stale.jar'), Buffer.from('changed'))
    await assert.rejects(
      () => applyModUpdate({ instanceDir, candidate: staleCandidate, client }),
      (error) => error instanceof ModError && error.code === 'stale-update',
    )
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('search maps hits and sends facets as AND groups', async () => {
  const dir = tempDir('search')
  let params
  const server = await fixtureServer({
    '/v2/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      params = {
        query: url.searchParams.get('query'),
        limit: url.searchParams.get('limit'),
        facets: url.searchParams.get('facets'),
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          hits: [
            {
              project_id: 'sodium',
              slug: 'sodium',
              title: 'Sodium',
              description: 'Rendering',
              icon_url: 'http://example.invalid/icon.png',
              versions: ['1.20.1'],
            },
            { project_id: 'broken' },
          ],
        }),
      )
    },
  })
  try {
    const client = new ModrinthClient({ baseUrl: `${server.base}/v2` })
    const hits = await client.search('sodium', { limit: 5, facets: ['project_type:mod'] })
    assert.equal(params.query, 'sodium')
    assert.equal(params.limit, '5')
    assert.deepEqual(JSON.parse(params.facets), [['project_type:mod']])
    assert.equal(hits.length, 2)
    assert.equal(hits[0].title, 'Sodium')
    assert.equal(hits[0].iconUrl, 'http://example.invalid/icon.png')
    assert.deepEqual(hits[0].versions, ['1.20.1'])
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('installs a pinned dependency version and honors the content folder', async () => {
  const dir = tempDir('install')
  const mainJar = jar({ 'fabric.mod.json': JSON.stringify({ id: 'main', version: '1.0' }) })
  const depJar = jar({ 'fabric.mod.json': JSON.stringify({ id: 'dep', version: '2.0' }) })
  const packJar = Buffer.from('resource pack bytes')
  const routes = {
    '/v2/project/main/version': {
      body: Buffer.from(
        JSON.stringify([
          {
            id: 'main-1',
            project_id: 'main',
            name: 'Main',
            version_number: '1.0',
            game_versions: ['1.20.1'],
            loaders: ['fabric'],
            files: [{ url: 'BASE/files/main.jar', filename: 'main.jar', primary: true }],
            dependencies: [{ version_id: 'dep-ver', dependency_type: 'required' }],
          },
        ]),
      ),
    },
    '/v2/project/pack/version': {
      body: Buffer.from(
        JSON.stringify([
          {
            id: 'pack-1',
            project_id: 'pack',
            name: 'Pack',
            version_number: '1.0',
            game_versions: ['1.20.1'],
            loaders: ['minecraft'],
            files: [{ url: 'BASE/files/pack.zip', filename: 'pack.zip', primary: true }],
            dependencies: [],
          },
        ]),
      ),
    },
    '/v2/version/dep-ver': {
      body: Buffer.from(
        JSON.stringify({
          id: 'dep-ver',
          project_id: 'dep',
          name: 'Dep',
          version_number: '2.0',
          game_versions: ['1.20.1'],
          loaders: ['fabric'],
          files: [{ url: 'BASE/files/dep.jar', filename: 'dep.jar', primary: true }],
          dependencies: [],
        }),
      ),
    },
    '/files/main.jar': { body: mainJar },
    '/files/dep.jar': { body: depJar },
    '/files/pack.zip': { body: packJar },
  }
  const live = await fixtureServer(routes)
  for (const [key, route] of Object.entries(routes)) {
    // Only JSON routes carry the placeholder; re-encoding a jar through UTF-8
    // would corrupt it.
    if (key.startsWith('/v2/') && route.body) {
      route.body = Buffer.from(route.body.toString('utf8').replaceAll('BASE', live.base))
    }
  }
  try {
    const client = new ModrinthClient({ baseUrl: `${live.base}/v2` })
    const instanceDir = path.join(dir, 'instance')
    const result = await installModrinthProject({
      instanceDir,
      projectId: 'main',
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      client,
    })
    assert.deepEqual(result.installed, ['main.jar'])
    assert.deepEqual(result.dependencies, ['dep.jar'])
    assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'main.jar')).equals(mainJar), true)
    assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'dep.jar')).equals(depJar), true)

    const packDir = path.join(dir, 'pack-instance')
    const pack = await installModrinthProject({
      instanceDir: packDir,
      projectId: 'pack',
      minecraftVersion: '1.20.1',
      client,
      folder: 'resourcepacks',
    })
    assert.deepEqual(pack.installed, ['pack.zip'])
    assert.equal(fs.existsSync(path.join(packDir, 'resourcepacks', 'pack.zip')), true)
    assert.equal(fs.existsSync(path.join(packDir, 'mods')), false)

    await assert.rejects(
      () =>
        installModrinthProject({
          instanceDir: packDir,
          projectId: 'pack',
          minecraftVersion: '1.20.1',
          client,
          folder: 'world',
        }),
      /Unsupported content folder/,
    )
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('removal verifies bytes, prunes the folder and forgets the index entry', async () => {
  const dir = tempDir('remove')
  try {
    const instanceDir = path.join(dir, 'instance')
    const target = path.join(instanceDir, 'mods', 'nested', 'gone.jar')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'jar-bytes')
    const sha = sha1(Buffer.from('jar-bytes'))
    const index = new OfflineModIndex(path.join(dir, 'index.json'))
    await index.recordFile(target, { projectId: 'p', versionId: 'v', source: 'modrinth' })
    assert.ok(await index.lookup(sha))

    await assert.rejects(
      () =>
        removeInstalledContent({
          instanceDir,
          path: 'mods/nested/gone.jar',
          expectedSha1: 'a'.repeat(40),
        }),
      (error) => error instanceof ModError && error.code === 'content-changed',
    )
    await assert.rejects(
      () => removeInstalledContent({ instanceDir, path: '../outside.jar' }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )
    await assert.rejects(
      () => removeInstalledContent({ instanceDir, path: 'config/options.txt' }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )

    const result = await removeInstalledContent({
      instanceDir,
      path: 'mods/nested/gone.jar',
      expectedSha1: sha,
      index,
    })
    assert.equal(result.removed, 'mods/nested/gone.jar')
    assert.equal(fs.existsSync(target), false)
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods')), false)
    assert.equal(await index.lookup(sha), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('provider filenames cannot escape the instance on install or update', async () => {
  const dir = tempDir('escape')
  const payload = Buffer.from('jar-bytes')
  const routes = {
    '/v2/project/evil/version': null,
    '/v2/project/absolute/version': null,
    '/files/x.jar': { body: payload },
  }
  const live = await fixtureServer(routes)
  const versionFor = (projectId, filename) => ({
    body: Buffer.from(
      JSON.stringify([
        {
          id: 'v1',
          project_id: projectId,
          name: 'Evil',
          version_number: '1.0',
          game_versions: ['1.20.1'],
          loaders: ['fabric'],
          files: [{ url: `${live.base}/files/x.jar`, filename, primary: true }],
          dependencies: [],
        },
      ]),
    ),
  })
  routes['/v2/project/evil/version'] = versionFor('evil', '../../escape.jar')
  routes['/v2/project/absolute/version'] = versionFor(
    'absolute',
    path.join(dir, 'absolute.jar'),
  )
  try {
    const client = new ModrinthClient({ baseUrl: `${live.base}/v2` })
    const instanceDir = path.join(dir, 'inst')
    await assert.rejects(
      () =>
        installModrinthProject({
          instanceDir,
          projectId: 'evil',
          minecraftVersion: '1.20.1',
          loader: 'fabric',
          client,
        }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )
    await assert.rejects(
      () =>
        installModrinthProject({
          instanceDir,
          projectId: 'absolute',
          minecraftVersion: '1.20.1',
          loader: 'fabric',
          client,
        }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )
    assert.equal(fs.existsSync(path.join(dir, 'escape.jar')), false)
    assert.equal(fs.existsSync(path.join(dir, 'absolute.jar')), false)
    assert.equal(fs.existsSync(path.join(instanceDir, '..', 'escape.jar')), false)

    // applyModUpdate must not follow an escaping filename from the latest version.
    fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
    const installed = path.join(instanceDir, 'mods', 'demo.jar')
    fs.writeFileSync(installed, 'old-bytes')
    const candidate = {
      path: 'mods/demo.jar',
      sha1: sha1(Buffer.from('old-bytes')),
      projectId: 'demo',
      latest: {
        id: 'v2',
        projectId: 'demo',
        name: 'Demo',
        versionNumber: '2.0',
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
        files: [
          {
            url: `${live.base}/files/x.jar`,
            filename: '../escape-update.jar',
            primary: true,
          },
        ],
        dependencies: [],
      },
    }
    await assert.rejects(
      () => applyModUpdate({ instanceDir, candidate, client }),
      (error) => error instanceof ModError && error.code === 'unsafe-path',
    )
    assert.equal(fs.readFileSync(installed, 'utf8'), 'old-bytes')
    assert.equal(fs.existsSync(path.join(dir, 'escape-update.jar')), false)
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('update and removal commit file, lock and index together', async () => {
  const dir = tempDir('state')
  const v1 = Buffer.from('mod-v1')
  const v2 = Buffer.from('mod-v2')
  const routes = {
    '/v1.jar': { body: v1 },
    '/v2.jar': { body: v2 },
    '/v2/version_files/update_many': (req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            [sha1(v1)]: {
              id: 'v2',
              project_id: 'demo',
              name: 'Demo',
              version_number: '2.0',
              game_versions: ['1.20.1'],
              loaders: ['fabric'],
              files: [
                {
                  url: `${live.base}/v2.jar`,
                  filename: 'packmod.jar',
                  primary: true,
                  hashes: { sha1: sha1(v2), sha512: sha512(v2) },
                },
              ],
              dependencies: [],
            },
          }),
        )
      })
    },
  }
  const live = await fixtureServer(routes)
  try {
    const instanceDir = path.join(dir, 'instance')
    const archive = path.join(dir, 'pack.mrpack')
    const zip = new AdmZip()
    zip.addFile(
      'modrinth.index.json',
      Buffer.from(
        JSON.stringify({
          name: 'State Pack',
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
          files: [
            {
              path: 'mods/packmod.jar',
              downloads: [`${live.base}/v1.jar`],
              fileSize: v1.length,
              hashes: { sha1: sha1(v1) },
            },
          ],
        }),
      ),
    )
    zip.writeZip(archive)
    await installModpack({ instanceDir, archivePath: archive })

    const file = path.join(instanceDir, 'mods', 'packmod.jar')
    const index = new OfflineModIndex(path.join(dir, 'index.json'))
    await index.recordFile(file, { projectId: 'demo', versionId: 'v1', source: 'modrinth' })
    const client = new ModrinthClient({ baseUrl: `${live.base}/v2` })

    const check = await checkModUpdates({
      instanceDir,
      client,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
      index,
    })
    assert.equal(check.updates.length, 1)
    await applyModUpdate({ instanceDir, candidate: check.updates[0], client, index })

    const lockAfterUpdate = await readModpackLock(instanceDir)
    const fileSha1 = sha1(fs.readFileSync(file))
    assert.equal(fs.readFileSync(file).equals(v2), true)
    assert.equal(lockAfterUpdate.files.length, 1)
    assert.equal(lockAfterUpdate.files[0].sha1, fileSha1)
    assert.equal(lockAfterUpdate.files[0].sha512, sha512(v2))
    assert.equal(lockAfterUpdate.files[0].size, v2.length)
    const entriesAfterUpdate = await index.list()
    assert.equal(entriesAfterUpdate.length, 1)
    assert.equal(entriesAfterUpdate[0].versionId, 'v2')
    assert.equal(entriesAfterUpdate[0].sha1, fileSha1)

    const removed = await removeInstalledContent({
      instanceDir,
      path: 'mods/packmod.jar',
      index,
    })
    assert.equal(removed.removed, 'mods/packmod.jar')
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(await index.list(), [])
    const lockAfterRemove = await readModpackLock(instanceDir)
    assert.equal(lockAfterRemove.files.length, 0)
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

