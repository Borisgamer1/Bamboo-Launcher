/**
 * Phase 9 part 2 tests: MMC/Prism import, lock-diff updates, offline index.
 * Everything here is local; no provider or Minecraft endpoint is contacted.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { jar, sha1, tempDir } = require('./harness.cjs')

const AdmZip = require('adm-zip')
const { createNullLogger } = require('../dist-electron/logger.js')
const { InstanceStore } = require('../dist-electron/instance-store.js')
const { InstanceManager } = require('../dist-electron/instances/index.js')
const {
  importMmcInstance,
  importMmcArchive,
  readMmcInstance,
  readModpackLock,
  installModpack,
  updateModpack,
  ModError,
  OfflineModIndex,
  CurseForgeClient,
} = require('../dist-electron/mods/index.js')

function seedVersion(gameRoot, versionId) {
  const dir = path.join(gameRoot, 'versions', versionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${versionId}.json`),
    JSON.stringify({ id: versionId, type: 'release', mainClass: 'net.minecraft.client.main.Main' }),
    'utf8',
  )
}

async function setup(label) {
  const base = tempDir(label)
  const gameRoot = path.join(base, 'game')
  const appData = path.join(base, 'appData')
  fs.mkdirSync(gameRoot, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  seedVersion(gameRoot, '1.20.1')
  const store = new InstanceStore(path.join(appData, 'instances.json'), createNullLogger())
  await store.load()
  const calls = []
  const manager = new InstanceManager({
    gameRoot: () => gameRoot,
    store,
    logger: createNullLogger(),
    loaderInstaller: async (kind, request) => {
      calls.push({ kind, request })
      const versionId = `${request.minecraftVersion}-${kind}-${request.loaderVersion}`
      seedVersion(gameRoot, versionId)
      return { versionId }
    },
  })
  return { base, gameRoot, manager, calls }
}

function writeRealisticPrismFolder(dir, options = {}) {
  fs.mkdirSync(path.join(dir, '.minecraft', 'mods'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.minecraft', 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'mmc-pack.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        components: [
          { uid: 'org.lwjgl3', version: '3.3.1', dependencyOnly: true },
          { uid: 'net.minecraft', version: '1.20.1', important: true },
          { uid: 'net.minecraftforge', version: '47.4.22' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  const java = path.join(dir, 'runtime', 'bin', 'javaw.exe')
  fs.mkdirSync(path.dirname(java), { recursive: true })
  fs.writeFileSync(java, 'fake-java', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'instance.cfg'),
    [
      '[General]',
      'ConfigVersion=1.3',
      'InstanceType=OneSix',
      'name=Gun Mod',
      'OverrideMemory=true',
      'MinMemAlloc=2048',
      'MaxMemAlloc=8192',
      'OverrideJavaArgs=true',
      'JvmArgs="-XX:+UseG1GC"',
      'OverrideJavaLocation=true',
      `JavaPath=${java.replace(/\\/g, '/')}`,
      'ManagedPack=false',
      '',
    ].join('\r\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, '.minecraft', 'options.txt'), 'fov:0.5\n', 'utf8')
  fs.writeFileSync(path.join(dir, '.minecraft', 'config', 'mod.cfg'), 'enabled=true\n', 'utf8')
  const modFile = path.join(dir, '.minecraft', 'mods', 'example-1.0.jar')
  fs.writeFileSync(
    modFile,
    jar({ 'mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="examplemod"\nversion="1.0"\n' }),
  )
  fs.mkdirSync(path.join(dir, '.minecraft', 'saves', 'world'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.minecraft', 'saves', 'world', 'level.dat'), 'level', 'utf8')
  return { java, modFile }
}

test('reads a Prism instance.cfg and mmc-pack.json', async (context) => {
  const base = tempDir('mmc-read')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const source = path.join(base, 'Gun Mod')
  const seeded = writeRealisticPrismFolder(source)
  // MMC exports often wrap the instance in one folder; resolve it.
  const nested = path.join(base, 'export')
  fs.mkdirSync(nested)
  fs.cpSync(source, path.join(nested, 'Gun Mod'), { recursive: true })

  const info = await readMmcInstance(nested)
  assert.equal(info.name, 'Gun Mod')
  assert.equal(info.minecraftVersion, '1.20.1')
  assert.equal(info.loader, 'forge')
  assert.equal(info.loaderVersion, '47.4.22')
  assert.equal(info.minMemory, 2048)
  assert.equal(info.maxMemory, 8192)
  assert.equal(info.javaPath, seeded.java)
  assert.equal(info.clientDir, path.join(nested, 'Gun Mod', '.minecraft'))
})

test('imports a real MMC/Prism folder into a managed instance and links jars', async (context) => {
  const { base, gameRoot, manager, calls } = await setup('mmc-import')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const source = path.join(base, 'Gun Mod')
  const seeded = writeRealisticPrismFolder(source)

  const result = await importMmcInstance({
    manager,
    gameRoot: () => gameRoot,
    sourceDir: source,
    logger: createNullLogger(),
  })
  assert.equal(result.minecraftVersion, '1.20.1')
  assert.equal(result.loader, 'forge')
  assert.equal(result.loaderVersion, '47.4.22')
  assert.equal(result.instance.instance.name, 'Gun Mod')
  assert.equal(result.instance.instance.loader, 'forge')
  assert.equal(result.instance.instance.maxMemory, 8192)
  assert.equal(result.instance.instance.javaPath, seeded.java)
  assert.deepEqual(calls, [
    { kind: 'forge', request: { minecraftVersion: '1.20.1', loaderVersion: '47.4.22' } },
  ])

  const targetMod = path.join(result.instance.directory, 'mods', 'example-1.0.jar')
  assert.equal(fs.existsSync(targetMod), true)
  assert.equal(fs.existsSync(path.join(result.instance.directory, 'options.txt')), true)
  assert.equal(
    fs.readFileSync(path.join(result.instance.directory, 'config', 'mod.cfg'), 'utf8'),
    'enabled=true\n',
  )
  assert.equal(
    fs.readFileSync(path.join(result.instance.directory, 'saves', 'world', 'level.dat'), 'utf8'),
    'level',
  )
  // The jar is stored once and hardlinked; saves are independent copies.
  assert.equal(fs.statSync(targetMod).ino, fs.statSync(seeded.modFile).ino)
  assert.equal(fs.statSync(targetMod).nlink >= 2, true)
  assert.notEqual(
    fs.statSync(path.join(result.instance.directory, 'saves', 'world', 'level.dat')).ino,
    fs.statSync(path.join(source, '.minecraft', 'saves', 'world', 'level.dat')).ino,
  )

  const meta = JSON.parse(
    fs.readFileSync(path.join(result.instance.directory, 'instance.json'), 'utf8'),
  )
  assert.equal(meta.upstream.type, 'mmc')
  assert.equal(meta.upstream.format, 'mmc-pack')
  assert.equal(meta.upstream.components.length, 3)
  assert.equal(meta.upstream.jvmArgs, '-XX:+UseG1GC')
  assert.equal(fs.existsSync(result.instance.directory), true)
})

test('imports an exported MMC zip and rejects path traversal', async (context) => {
  const { base, gameRoot, manager } = await setup('mmc-zip')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const source = path.join(base, 'Hardcore')
  writeRealisticPrismFolder(source)
  const archive = path.join(base, 'Hardcore.zip')
  const zip = new AdmZip()
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(full, `${name}/`)
      else zip.addFile(name, fs.readFileSync(full))
    }
  }
  walk(source, 'Hardcore/')
  zip.writeZip(archive)

  const result = await importMmcArchive({
    manager,
    gameRoot: () => gameRoot,
    sourceDir: source,
    archivePath: archive,
  })
  assert.equal(result.instance.instance.name, 'Gun Mod')
  assert.equal(fs.existsSync(path.join(result.instance.directory, 'mods', 'example-1.0.jar')), true)

  const evil = path.join(base, 'evil.zip')
  const evilZip = new AdmZip()
  evilZip.addFile('../escape.txt', Buffer.from('x'))
  evilZip.writeZip(evil)
  await assert.rejects(
    () => importMmcArchive({ manager, gameRoot: () => gameRoot, sourceDir: source, archivePath: evil }),
    (error) => error instanceof ModError && error.code === 'unsafe-path',
  )
})

async function fileServer(files) {
  const server = http.createServer((req, res) => {
    const data = files[req.url]
    if (!data) {
      res.writeHead(404).end('missing')
      return
    }
    res.writeHead(200, { 'content-length': data.length }).end(data)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function writeMrpack(file, files, overrides = {}) {
  const zip = new AdmZip()
  zip.addFile(
    'modrinth.index.json',
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        name: 'Diff Pack',
        versionId: overrides.versionId ?? '1.0.0',
        dependencies: overrides.dependencies ?? { minecraft: '1.20.1', 'fabric-loader': '0.15.11' },
        files,
      }),
    ),
  )
  for (const [name, content] of Object.entries(overrides.files ?? {})) {
    zip.addFile(`overrides/${name}`, Buffer.from(content))
  }
  zip.writeZip(file)
}

test('mrpack update applies a lock diff: changed, added, removed, then zero bytes', async (context) => {
  const base = tempDir('lock-diff')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const a1 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1.0' }) })
  const a2 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '2.0' }) })
  const b1 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'modb', version: '1.0' }) })
  const c1 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'modc', version: '1.0' }) })
  const live = await fileServer({ '/a1.jar': a1, '/a2.jar': a2, '/b1.jar': b1, '/c1.jar': c1 })
  context.after(() => live.close())
  const fileEntry = (name, data) => ({
    path: `mods/${name.replace(/[0-9]\.jar$/, '.jar')}`,
    downloads: [`${live.base}/${name}`],
    fileSize: data.length,
    hashes: { sha1: sha1(data) },
  })
  const v1 = path.join(base, 'pack-1.mrpack')
  const v2 = path.join(base, 'pack-2.mrpack')
  writeMrpack(
    v1,
    [fileEntry('a1.jar', a1), fileEntry('b1.jar', b1)],
    { files: { 'config/pack.cfg': 'version=1\n' } },
  )
  writeMrpack(
    v2,
    [fileEntry('a2.jar', a2), fileEntry('c1.jar', c1)],
    { versionId: '2.0.0', files: { 'config/pack.cfg': 'version=2\n' } },
  )

  const first = await installModpack({ instanceDir, archivePath: v1 })
  assert.deepEqual(first.installed.sort(), ['mods/a.jar', 'mods/b.jar'])
  assert.deepEqual(first.removed, [])
  const lock = await readModpackLock(instanceDir)
  assert.equal(lock.format, 'mrpack')
  assert.equal(lock.files.length, 2)
  assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'pack.cfg'), 'utf8'), 'version=1\n')

  const update = await updateModpack({
    instanceDir,
    archivePath: v2,
    upstream: { provider: 'modrinth', format: 'mrpack', projectId: 'demo', versionId: '2.0.0' },
  })
  assert.deepEqual(update.updated.sort(), ['mods/a.jar'])
  assert.deepEqual(update.installed.sort(), ['mods/a.jar', 'mods/c.jar'])
  assert.deepEqual(update.removed, ['mods/b.jar'])
  assert.equal(update.downloadedBytes > 0, true)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'b.jar')), false)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'a.jar')), true)
  assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'pack.cfg'), 'utf8'), 'version=2\n')
  const updatedLock = await readModpackLock(instanceDir)
  assert.equal(updatedLock.upstream.provider, 'modrinth')
  assert.equal(updatedLock.versionId, '2.0.0')

  const repeat = await updateModpack({ instanceDir, archivePath: v2 })
  assert.equal(repeat.downloadedBytes, 0)
  assert.deepEqual(repeat.installed, [])
  assert.deepEqual(repeat.updated, [])
  assert.deepEqual(repeat.removed, [])
})

test('lock diff keeps an obsolete file the user modified instead of deleting it', async (context) => {
  const base = tempDir('lock-keep')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const a = jar({ 'fabric.mod.json': JSON.stringify({ id: 'a', version: '1' }) })
  const v1 = path.join(base, 'one.mrpack')
  const v2 = path.join(base, 'two.mrpack')
  const live = await fileServer({ '/a.jar': a })
  context.after(() => live.close())
  writeMrpack(v1, [
    { path: 'mods/a.jar', downloads: [`${live.base}/a.jar`], fileSize: a.length, hashes: { sha1: sha1(a) } },
  ])
  writeMrpack(v2, [])
  await installModpack({ instanceDir, archivePath: v1 })
  fs.writeFileSync(path.join(instanceDir, 'mods', 'a.jar'), 'user-edited')
  const update = await updateModpack({ instanceDir, archivePath: v2 })
  assert.deepEqual(update.removed, [])
  assert.deepEqual(update.kept, ['mods/a.jar'])
  assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'a.jar'), 'utf8'), 'user-edited')
})

test('CurseForge update removes the old file and a dependency the new version dropped', async (context) => {
  const base = tempDir('cf-diff')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const modA1 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1', depends: { modb: '*' } }) })
  const modA2 = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '2' }) })
  const modB = jar({ 'fabric.mod.json': JSON.stringify({ id: 'modb', version: '1' }) })
  const live = await fileServer({ '/a1.jar': modA1, '/a2.jar': modA2, '/b.jar': modB })
  context.after(() => live.close())
  const fileData = (id, modId, name, data, deps = []) => ({
    id,
    modId,
    fileName: name,
    displayName: name,
    fileLength: data.length,
    downloadUrl: `${live.base}/${name === 'moda-1.jar' ? 'a1.jar' : name === 'moda-2.jar' ? 'a2.jar' : 'b.jar'}`,
    hashes: [{ algo: 1, value: sha1(data) }],
    gameVersions: ['1.20.1'],
    dependencies: deps,
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v1/mods/1/files/10') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: fileData(10, 1, 'moda-1.jar', modA1, [{ modId: 2, relationType: 3 }]) }))
      return
    }
    if (url.pathname === '/v1/mods/1/files/11') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: fileData(11, 1, 'moda-2.jar', modA2) }))
      return
    }
    if (url.pathname === '/v1/mods/2/files') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [fileData(20, 2, 'modb.jar', modB)] }))
      return
    }
    res.writeHead(404).end('missing')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new CurseForgeClient({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    fetchImpl: fetch,
  })
  const pack = (fileID) => {
    const archive = path.join(base, `cf-${fileID}.zip`)
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          name: 'CF Diff',
          minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.15.11', primary: true }] },
          files: [{ projectID: 1, fileID, required: true }],
        }),
      ),
    )
    zip.writeZip(archive)
    return archive
  }

  const first = await installModpack({
    instanceDir,
    archivePath: pack(10),
    curseforge: client,
    minecraftVersion: '1.20.1',
    loader: 'fabric',
  })
  assert.deepEqual(first.installed, ['moda-1.jar'])
  assert.deepEqual(first.installedDependencies, ['modb.jar'])

  const update = await updateModpack({
    instanceDir,
    archivePath: pack(11),
    curseforge: client,
    minecraftVersion: '1.20.1',
    loader: 'fabric',
  })
  assert.deepEqual(update.installed, ['moda-2.jar'])
  assert.deepEqual(update.removed.sort(), ['mods/moda-1.jar', 'mods/modb.jar'])
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda-1.jar')), false)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'modb.jar')), false)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda-2.jar')), true)
  const repeat = await updateModpack({
    instanceDir,
    archivePath: pack(11),
    curseforge: client,
    minecraftVersion: '1.20.1',
    loader: 'fabric',
  })
  assert.equal(repeat.downloadedBytes, 0)
  assert.deepEqual(repeat.removed, [])
})

test('CurseForge 200-mod pack installs fully and resolves 5 required deps (fixture scale check)', async (context) => {
  const base = tempDir('cf-scale')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const payloads = new Map()
  for (let id = 1; id <= 205; id += 1) {
    const data = jar({
      'fabric.mod.json': JSON.stringify({
        id: `mod${id}`,
        version: '1.0',
        ...(id <= 5 ? { depends: { [`mod${200 + id}`]: '*' } } : {}),
      }),
    })
    payloads.set(id, data)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const single = url.pathname.match(/^\/v1\/mods\/(\d+)\/files\/(\d+)$/)
    if (single) {
      const modId = Number(single[1])
      const data = payloads.get(modId)
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: Number(single[2]),
            modId,
            fileName: `mod${modId}.jar`,
            displayName: `Mod ${modId}`,
            fileLength: data.length,
            downloadUrl: `http://127.0.0.1:${server.address().port}/cf/mod${modId}.jar`,
            hashes: [{ algo: 1, value: sha1(data) }],
            gameVersions: ['1.20.1'],
            dependencies: modId <= 5 ? [{ modId: 200 + modId, relationType: 3 }] : [],
          },
        }),
      )
      return
    }
    const list = url.pathname.match(/^\/v1\/mods\/(\d+)\/files$/)
    if (list) {
      const modId = Number(list[1])
      const data = payloads.get(modId)
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: data
            ? [{
                id: modId * 10,
                modId,
                fileName: `mod${modId}.jar`,
                displayName: `Mod ${modId}`,
                fileLength: data.length,
                downloadUrl: `http://127.0.0.1:${server.address().port}/cf/mod${modId}.jar`,
                hashes: [{ algo: 1, value: sha1(data) }],
                gameVersions: ['1.20.1'],
                dependencies: [],
              }]
            : [],
        }),
      )
      return
    }
    const file = url.pathname.match(/^\/cf\/mod(\d+)\.jar$/)
    if (file) {
      const data = payloads.get(Number(file[1]))
      res.writeHead(200, { 'content-length': data.length }).end(data)
      return
    }
    res.writeHead(404).end('missing')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new CurseForgeClient({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    fetchImpl: fetch,
  })
  const archive = path.join(base, 'scale.zip')
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        name: 'Scale 200',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.15.11', primary: true }] },
        files: Array.from({ length: 200 }, (_, index) => ({
          projectID: index + 1,
          fileID: (index + 1) * 10,
          required: true,
        })),
      }),
    ),
  )
  zip.writeZip(archive)

  const first = await installModpack({
    instanceDir,
    archivePath: archive,
    curseforge: client,
    minecraftVersion: '1.20.1',
    loader: 'fabric',
  })
  assert.equal(first.installed.length, 200)
  assert.equal(first.installedDependencies.length, 5)
  assert.equal(first.missingDependencies.length, 0)
  assert.equal(fs.readdirSync(path.join(instanceDir, 'mods')).length, 205)
  const lock = await readModpackLock(instanceDir)
  assert.equal(lock.files.length, 205)

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
})

test('a failed CurseForge update keeps the previously installed file', async (context) => {
  const base = tempDir('cf-failed-update')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const oldMod = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '1' }) })
  const newMod = jar({ 'fabric.mod.json': JSON.stringify({ id: 'moda', version: '2' }) })
  let failDownload = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v1/mods/1/files/10' || url.pathname === '/v1/mods/1/files/11') {
      const next = url.pathname.endsWith('/11')
      const data = next ? newMod : oldMod
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: {
            id: next ? 11 : 10,
            modId: 1,
            fileName: next ? 'moda-2.jar' : 'moda-1.jar',
            displayName: next ? 'moda-2.jar' : 'moda-1.jar',
            fileLength: data.length,
            downloadUrl: `http://127.0.0.1:${server.address().port}/${next ? 'broken.jar' : 'moda-1.jar'}`,
            hashes: [{ algo: 1, value: sha1(data) }],
            gameVersions: ['1.20.1'],
            dependencies: [],
          },
        }),
      )
      return
    }
    if (url.pathname === '/moda-1.jar') {
      res.writeHead(200, { 'content-length': oldMod.length }).end(oldMod)
      return
    }
    if (url.pathname === '/broken.jar') {
      failDownload = true
      res.writeHead(500).end('boom')
      return
    }
    res.writeHead(404).end('missing')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new CurseForgeClient({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    fetchImpl: fetch,
  })
  const pack = (fileID) => {
    const archive = path.join(base, `pack-${fileID}.zip`)
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          name: 'CF Failure',
          minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.15.11', primary: true }] },
          files: [{ projectID: 1, fileID, required: true }],
        }),
      ),
    )
    zip.writeZip(archive)
    return archive
  }
  await installModpack({
    instanceDir,
    archivePath: pack(10),
    curseforge: client,
    minecraftVersion: '1.20.1',
    loader: 'fabric',
  })
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda-1.jar')), true)
  await assert.rejects(
    () => updateModpack({
      instanceDir,
      archivePath: pack(11),
      curseforge: client,
      minecraftVersion: '1.20.1',
      loader: 'fabric',
    }),
    /HTTP 500|download/i,
  )
  assert.equal(failDownload, true)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda-1.jar')), true)
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'moda-2.jar')), false)
  const lock = await readModpackLock(instanceDir)
  assert.equal(lock.files.length, 1)
  assert.equal(lock.files[0].path, 'mods/moda-1.jar')
})

test('update refuses a pack that changes the loader', async (context) => {
  const base = tempDir('loader-mismatch')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const instanceDir = path.join(base, 'instance')
  const one = path.join(base, 'one.mrpack')
  const two = path.join(base, 'two.mrpack')
  writeMrpack(one, [])
  writeMrpack(two, [], { dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.14' } })
  await installModpack({ instanceDir, archivePath: one })
  await assert.rejects(
    () => updateModpack({ instanceDir, archivePath: two }),
    (error) => error instanceof ModError && error.code === 'loader-mismatch',
  )
})

test('update refuses to run without a lock', async (context) => {
  const base = tempDir('no-lock')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const archive = path.join(base, 'empty.mrpack')
  writeMrpack(archive, [])
  await assert.rejects(
    () => updateModpack({ instanceDir: path.join(base, 'instance'), archivePath: archive }),
    (error) => error instanceof ModError && error.code === 'no-lock',
  )
})

test('offline index persists SHA-1 lookups and reads local jars without network', async (context) => {
  const base = tempDir('index')
  context.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const mods = path.join(base, 'mods')
  fs.mkdirSync(mods)
  const sodium = jar({
    'fabric.mod.json': JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.5.8' }),
  })
  const modFile = path.join(mods, 'sodium.jar')
  fs.writeFileSync(modFile, sodium)

  const file = path.join(base, 'index.json')
  const index = new OfflineModIndex(file, createNullLogger())
  await index.recordFile(modFile, {
    projectId: 'AANobbMI',
    slug: 'sodium',
    name: 'Sodium',
    versionId: 'abc',
    versionNumber: '0.5.8',
    source: 'modrinth',
  })
  assert.equal(await index.size, 1)
  const reopened = new OfflineModIndex(file, createNullLogger())
  const found = await reopened.lookupFile(modFile)
  assert.equal(found.projectId, 'AANobbMI')
  assert.equal(found.slug, 'sodium')
  assert.equal(found.versionNumber, '0.5.8')
  assert.equal((await reopened.lookup('0'.repeat(40))), undefined)

  const unknown = path.join(mods, 'unknown.jar')
  fs.writeFileSync(unknown, jar({ 'fabric.mod.json': JSON.stringify({ id: 'unknown', version: '1' }) }))
  const scanned = await reopened.scanDirectory(mods)
  assert.equal(scanned.length, 2)
  const unknownEntry = scanned.find((entry) => entry.modId === 'unknown')
  assert.equal(unknownEntry.source, 'local-jar')

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(Object.keys(onDisk.entries).length, 2)
})
