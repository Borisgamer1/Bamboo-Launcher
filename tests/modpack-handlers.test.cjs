/**
 * Contract tests for the two shipped modpack handlers:
 * `import-profile` (local `.mrpack`) and `export-profile` (`format: 'mrpack'`).
 *
 * `main.js` forwards these payloads unchanged to `electron/mods/legacy-bridge`,
 * so the payload/result objects here are exactly what the renderer sends and
 * reads. The pack work itself must be the checked core: manifest downloads with
 * hash checks, overrides applied last, and a standards-compliant export.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const AdmZip = require('adm-zip')
const { fixtureServer, jar, sha1, sha512, tempDir } = require('./harness.cjs')

/** A jar whose only entry is mod metadata, as the fixture provider serves it. */
const fabricJar = (id, version) =>
  jar({ 'fabric.mod.json': JSON.stringify({ id, name: id, version }) })
const {
  importLegacyProfile,
  previewLegacyProfile,
  exportLegacyProfile,
} = require('../dist-electron/mods/legacy-bridge.js')
const { readModpackFormat, readMrpackManifest } = require('../dist-electron/mods/index.js')
const { extractMrpackWithTar } = require('../dist-electron/mods/tar.js')

const PACK_CONFIG = 'value = 42\n'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

function writeCurseForgeZip(file, { name, version, files = [], overrides = {}, clientOverrides = {} }) {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        manifestType: 'minecraftModpack',
        name,
        version,
        author: 'Fixture Author',
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.15.11', primary: true }] },
        files,
        overrides: 'overrides',
      }),
    ),
  )
  zip.addFile('icon.png', PNG_1PX)
  for (const [entry, content] of Object.entries(overrides)) {
    zip.addFile(`overrides/${entry}`, Buffer.from(content))
  }
  for (const [entry, content] of Object.entries(clientOverrides)) {
    zip.addFile(`client-overrides/${entry}`, Buffer.from(content))
  }
  zip.writeZip(file)
  return file
}

function writeMrpack(file, { name, dependencies, files, overrides = {}, clientOverrides = {} }) {
  const zip = new AdmZip()
  zip.addFile(
    'modrinth.index.json',
    Buffer.from(
      JSON.stringify({ formatVersion: 1, game: 'minecraft', name, versionId: '1.0.0', dependencies, files }),
    ),
  )
  for (const [entry, content] of Object.entries(overrides)) {
    zip.addFile(`overrides/${entry}`, Buffer.from(content))
  }
  for (const [entry, content] of Object.entries(clientOverrides)) {
    zip.addFile(`client-overrides/${entry}`, Buffer.from(content))
  }
  zip.writeZip(file)
  return file
}

test('import-profile installs every manifest file with its hash plus all overrides', async () => {
  const dir = tempDir('import')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('shipped', '2.0')
  const bundledJar = fabricJar('bundled', '1.0')
  const server = await fixtureServer({
    '/files/shipped.jar': modJar,
    '/files/bundled.jar': bundledJar,
    '/files/unused.jar': modJar,
  })
  try {
    const archive = writeMrpack(path.join(dir, 'Ships Pack.mrpack'), {
      name: 'Ships Pack',
      dependencies: { minecraft: '1.20.1', fabricLoader: '0.15.11' },
      files: [
        {
          path: 'mods/shipped.jar',
          downloads: [`${server.base}/files/shipped.jar`],
          fileSize: modJar.length,
          hashes: { sha1: sha1(modJar), sha512: sha512(modJar) },
        },
        {
          path: 'mods/server-only.jar',
          downloads: [`${server.base}/files/unused.jar`],
          fileSize: modJar.length,
          hashes: { sha1: sha1(modJar), sha512: sha512(modJar) },
          env: { client: 'unsupported', server: 'required' },
        },
      ],
      overrides: {
        'config/pack.toml': 'enabled = true\n',
        'mods/bundled.jar': bundledJar,
        // Packs ship arbitrary author directories, not only config/ and mods/.
        'kubejs/startup_scripts/custom.js': 'console.info("pack")\n',
        'defaultconfigs/ui.cfg': 'theme=custom\n',
        'fancymenu/customization/background.yml': 'background: bamboo\n',
        'root-note.txt': 'pack root file\n',
      },
      clientOverrides: { 'options.txt': 'guiScale:2\n' },
    })

    const preview = await previewLegacyProfile(archive)
    assert.equal(preview.modCount, 2, 'preview must not count a client-unsupported file')
    assert.equal(preview.resourcepackCount, 0)
    assert.equal(preview.totalFiles, 8, 'preview must count supported files plus every override')

    // Exactly the payload the renderer sends to `import-profile`.
    const result = await importLegacyProfile(
      {
        filePath: archive,
        targetInstanceName: 'Ships Pack',
        installMods: true,
        installResourcepacks: true,
        installShaderpacks: true,
        installDatapacks: true,
        installWorlds: false,
        installConfig: true,
        installScreenshots: false,
      },
      { rootPath: root },
    )

    assert.equal(result.success, true, result.error)
    assert.equal(result.instanceName, 'Ships Pack')
    assert.match(result.instanceId, /^[0-9a-f-]{36}$/)
    assert.equal(result.modsInstalled, 2)
    assert.equal(result.worldsImported, 0)
    assert.equal(preview.modCount, result.modsInstalled, 'preview and import must share one count')

    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
    assert.equal(profiles.length, 1)
    const profile = profiles[0]
    assert.equal(profile.name, 'Ships Pack')
    assert.equal(profile.minecraftVersion, '1.20.1')
    assert.equal(profile.modloader, 'Fabric')
    assert.equal(profile.modloaderVersion, '0.15.11')

    const gameDir = path.join(root, 'profiles', profile.folderName)
    const installed = fs.readFileSync(path.join(gameDir, 'mods', 'shipped.jar'))
    assert.equal(installed.equals(modJar), true)
    assert.equal(sha1(installed), sha1(modJar))
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'config', 'pack.toml'), 'utf8'),
      'enabled = true\n',
    )
    assert.equal(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8'), 'guiScale:2\n')
    assert.equal(fs.readFileSync(path.join(gameDir, 'mods', 'bundled.jar')).equals(bundledJar), true)
    // Every author file, including arbitrary override directories, must exist.
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'kubejs', 'startup_scripts', 'custom.js'), 'utf8'),
      'console.info("pack")\n',
    )
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'defaultconfigs', 'ui.cfg'), 'utf8'),
      'theme=custom\n',
    )
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'fancymenu', 'customization', 'background.yml'), 'utf8'),
      'background: bamboo\n',
    )
    assert.equal(fs.readFileSync(path.join(gameDir, 'root-note.txt'), 'utf8'), 'pack root file\n')
    assert.equal(fs.existsSync(path.join(gameDir, 'modrinth.index.json')), true)
    // A client-unsupported entry must not be downloaded.
    assert.equal(fs.existsSync(path.join(gameDir, 'mods', 'server-only.jar')), false)
    assert.equal(server.hits.get('/files/unused.jar'), undefined)

    // The pack lock must survive into the instance so a later update works.
    const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'modpack.lock.json'), 'utf8'))
    assert.equal(lock.format, 'mrpack')
    assert.deepEqual(lock.files.map((entry) => entry.path), ['mods/shipped.jar'])
    assert.equal(lock.files[0].sha1, sha1(modJar))
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile accepts an archive larger than 2 GiB without loading it into one buffer', async () => {
  const dir = tempDir('import-large')
  const root = path.join(dir, 'game')
  const archive = path.join(dir, 'Large Pack.mrpack')
  const hugeSize = 2 * 1024 * 1024 * 1024 + 1
  const zlib = require('node:zlib')
  const crc = (buffer) => zlib.crc32(buffer) >>> 0

  const local = (name, data, size) => {
    const encoded = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(data ? crc(data) : 0, 14)
    header.writeUInt32LE(data ? data.length : size, 18)
    header.writeUInt32LE(data ? data.length : size, 22)
    header.writeUInt16LE(encoded.length, 26)
    return Buffer.concat([header, encoded, ...(data ? [data] : [])])
  }
  const central = (name, data, size, offset) => {
    const encoded = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(data ? crc(data) : 0, 16)
    header.writeUInt32LE(data ? data.length : size, 20)
    header.writeUInt32LE(data ? data.length : size, 24)
    header.writeUInt16LE(encoded.length, 28)
    header.writeUInt32LE(offset, 42)
    return Buffer.concat([header, encoded])
  }

  try {
    const manifest = Buffer.from(JSON.stringify({
      formatVersion: 1,
      game: 'minecraft',
      name: 'Large Pack',
      dependencies: { minecraft: '1.20.1' },
      files: [],
    }))
    const override = Buffer.from('large = true\n')
    const fd = fs.openSync(archive, 'w')
    const records = []
    let offset = 0
    for (const [name, data] of [
      ['modrinth.index.json', manifest],
      ['overrides/config/large.toml', override],
    ]) {
      const item = local(name, data, data.length)
      fs.writeSync(fd, item, 0, item.length, offset)
      records.push({ name, data, offset })
      offset += item.length
    }
    const hugeOffset = offset
    const hugeHeader = local('assets/huge.bin', null, hugeSize)
    fs.writeSync(fd, hugeHeader, 0, hugeHeader.length, offset)
    offset += hugeHeader.length + hugeSize
    fs.ftruncateSync(fd, offset)
    records.push({ name: 'assets/huge.bin', data: null, size: hugeSize, offset: hugeOffset })
    const centralOffset = offset
    const centralDirectory = Buffer.concat(
      records.map((record) =>
        central(record.name, record.data, record.data ? record.data.length : record.size, record.offset),
      ),
    )
    fs.writeSync(fd, centralDirectory, 0, centralDirectory.length, centralOffset)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(records.length, 8)
    end.writeUInt16LE(records.length, 10)
    end.writeUInt32LE(centralDirectory.length, 12)
    end.writeUInt32LE(centralOffset, 16)
    fs.writeSync(fd, end, 0, end.length, centralOffset + centralDirectory.length)
    fs.closeSync(fd)

    assert.ok(fs.statSync(archive).size > 2 * 1024 * 1024 * 1024)
    const preview = await previewLegacyProfile(archive)
    assert.equal(preview.title, 'Large Pack')
    assert.equal(preview.modCount, 0)
    assert.equal(preview.totalFiles, 1, 'only the override is content; the huge asset is not read')

    const result = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Large Pack', installConfig: true },
      { rootPath: root },
    )
    assert.equal(result.success, true, result.error)
    assert.equal(
      fs.readFileSync(path.join(root, 'profiles', result.profile.folderName, 'config', 'large.toml'), 'utf8'),
      'large = true\n',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile reserves a distinct folder when two names share one slug', async () => {
  const dir = tempDir('import-folder')
  const root = path.join(dir, 'game')
  const archive = writeMrpack(path.join(dir, 'same.mrpack'), {
    name: 'Same Pack',
    dependencies: { minecraft: '1.21.1' },
    files: [],
  })
  try {
    const first = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Same Pack' },
      { rootPath: root },
    )
    const second = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Same_Pack' },
      { rootPath: root },
    )
    assert.equal(first.success, true, first.error)
    assert.equal(second.success, true, second.error)

    const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'))
    assert.equal(profiles.length, 2)
    const folders = profiles.map((profile) => profile.folderName)
    assert.equal(new Set(folders).size, 2, `folders must be distinct: ${folders.join(', ')}`)
    for (const folder of folders) {
      assert.equal(fs.existsSync(path.join(root, 'profiles', folder)), true)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile accepts a CurseForge zip without formatVersion and keeps icon, version, content and overrides', async () => {
  const dir = tempDir('import-curseforge')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('cf-bundled', '1.2')
  const archive = writeCurseForgeZip(path.join(dir, 'CF Pack.zip'), {
    name: 'CF Pack',
    version: '3.2.1',
    // The installer skips incomplete manifest entries; the preview must too.
    files: [{ projectID: 7 }, { fileID: 99 }],
    overrides: {
      'mods/cf-bundled.jar': modJar,
      'config/cf-pack.toml': 'enabled = true\n',
      'kubejs/client_scripts/custom.js': 'console.info("cf")\n',
      'fancymenu/customization/background.yml': 'background: cf\n',
    },
    clientOverrides: { 'mods/client-only.jar': modJar },
  })
  const progress = []
  try {
    assert.equal(await readModpackFormat(archive), 'curseforge')
    const preview = await previewLegacyProfile(archive)
    assert.equal(preview.modCount, 1, 'CurseForge preview must not count client-overrides or ID-less entries')
    const result = await importLegacyProfile(
      {
        filePath: archive,
        taskId: 'import:cf-test',
        targetInstanceName: 'CF Pack',
        installMods: true,
        installResourcepacks: true,
        installShaderpacks: true,
        installDatapacks: true,
        installWorlds: false,
        installConfig: true,
        installScreenshots: false,
      },
      { rootPath: root, onBackgroundTask: (event) => progress.push(event) },
    )

    assert.equal(result.success, true, result.error)
    const profile = result.profile
    assert.equal(profile.name, 'CF Pack')
    assert.equal(profile.modpackSource, 'curseforge')
    assert.equal(profile.modpackVersion, '3.2.1')
    assert.equal(profile.minecraftVersion, '1.20.1')
    assert.equal(profile.modloader, 'Fabric')
    assert.equal(profile.modloaderVersion, '0.15.11')
    assert.match(profile.thumbnail, /^data:image\/png;base64,/)
    assert.equal(profile.thumbnail.includes(PNG_1PX.toString('base64')), true)
    assert.equal(profile.mods, 1)
    assert.equal(preview.modCount, profile.mods, 'preview and import must share one count')
    assert.deepEqual(
      profile.content.map((entry) => `${entry.type}:${entry.fileName}`),
      ['mods:cf-bundled.jar'],
    )

    const gameDir = path.join(root, 'profiles', profile.folderName)
    for (const [entry, content] of Object.entries({
      'config/cf-pack.toml': 'enabled = true\n',
      'kubejs/client_scripts/custom.js': 'console.info("cf")\n',
      'fancymenu/customization/background.yml': 'background: cf\n',
    })) {
      assert.equal(fs.readFileSync(path.join(gameDir, entry), 'utf8'), content)
    }
    assert.equal(fs.readFileSync(path.join(gameDir, 'mods', 'cf-bundled.jar')).equals(modJar), true)
    const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'modpack.lock.json'), 'utf8'))
    assert.equal(lock.format, 'curseforge')
    assert.equal(lock.versionId, '3.2.1')

    assert.ok(progress.length >= 4, `expected real progress events, got ${progress.length}`)
    assert.equal(progress[0].id, 'import:cf-test')
    for (let index = 1; index < progress.length; index += 1) {
      assert.ok(
        progress[index].percent > progress[index - 1].percent,
        `progress must rise monotonically: ${progress.map((event) => event.percent).join(', ')}`,
      )
    }
    assert.equal(progress.at(-1).percent, 100)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge preview counts dependencies resolved by the install and skips ID-less entries', async () => {
  const dir = tempDir('import-curseforge-deps')
  const root = path.join(dir, 'game')
  const mainJar = fabricJar('cf-main', '1.0')
  const dependencyJar = fabricJar('cf-dependency', '1.0')
  let live
  const routes = {
    '/v1/mods/1/files/10': (req, res) => {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            data: {
              id: 10,
              modId: 1,
              displayName: 'Main',
              fileName: 'main.jar',
              fileLength: mainJar.length,
              downloadUrl: `${live.base}/cf/main.jar`,
              hashes: [{ algo: 1, value: sha1(mainJar) }],
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
                displayName: 'Dependency',
                fileName: 'dependency.jar',
                fileLength: dependencyJar.length,
                downloadUrl: `${live.base}/cf/dependency.jar`,
                hashes: [{ algo: 1, value: sha1(dependencyJar) }],
                gameVersions: ['1.20.1'],
                dependencies: [],
              },
            ],
          }),
        )
    },
    '/cf/main.jar': { body: mainJar },
    '/cf/dependency.jar': { body: dependencyJar },
  }
  live = await fixtureServer(routes)
  const archive = writeCurseForgeZip(path.join(dir, 'CF Dependencies.zip'), {
    name: 'CF Dependencies',
    version: '1.0.0',
    files: [
      { projectID: 1, fileID: 10, required: true },
      { projectID: 7 },
      { fileID: 99 },
    ],
    overrides: { 'config/dependency.toml': 'enabled = true\n' },
  })
  const bridgeOptions = {
    curseforgeApiKey: 'test-key',
    curseforgeBaseUrl: `${live.base}/v1`,
    fetchImpl: fetch,
  }
  try {
    const preview = await previewLegacyProfile(archive, bridgeOptions)
    assert.equal(preview.modCount, 2, 'preview must include the pack file and its resolved dependency')

    const result = await importLegacyProfile(
      {
        filePath: archive,
        targetInstanceName: 'CF Dependencies',
        installMods: true,
        installResourcepacks: true,
        installShaderpacks: true,
        installDatapacks: true,
        installWorlds: false,
        installConfig: true,
        installScreenshots: false,
      },
      { rootPath: root, ...bridgeOptions },
    )

    assert.equal(result.success, true, result.error)
    assert.equal(result.profile.mods, 2)
    assert.equal(preview.modCount, result.profile.mods, 'preview and import must use the same set')
    assert.deepEqual(
      result.profile.content.map((entry) => entry.fileName).sort(),
      ['dependency.jar', 'main.jar'],
    )
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CurseForge manifest files are planned and installed by their real project type', async () => {
  const dir = tempDir('import-curseforge-types')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('type-mod', '1.0')
  const resourcepack = Buffer.from('resource-pack-bytes')
  const shaderpack = Buffer.from('shader-pack-bytes')
  let live
  const routes = {
    '/v1/mods': JSON.stringify({
      data: [
        { id: 1, classId: 6, name: 'Mod', slug: 'mod' },
        { id: 2, classId: 12, name: 'Resource Pack', slug: 'resource-pack' },
        { id: 3, classId: 6552, name: 'Shader', slug: 'shader' },
      ],
    }),
  }
  live = await fixtureServer(routes)
  const fileRoute = (id, modId, fileName, buffer, pathname) =>
    JSON.stringify({
      data: {
        id,
        modId,
        displayName: fileName,
        fileName,
        fileLength: buffer.length,
        downloadUrl: `${live.base}${pathname}`,
        hashes: [{ algo: 1, value: sha1(buffer) }],
        gameVersions: ['1.20.1'],
        dependencies: [],
      },
    })
  routes['/v1/mods/1/files/10'] = fileRoute(10, 1, 'type-mod.jar', modJar, '/cf/type-mod.jar')
  routes['/v1/mods/2/files/20'] = fileRoute(20, 2, 'type-rp.zip', resourcepack, '/cf/type-rp.zip')
  routes['/v1/mods/3/files/30'] = fileRoute(30, 3, 'type-shader.zip', shaderpack, '/cf/type-shader.zip')
  routes['/cf/type-mod.jar'] = modJar
  routes['/cf/type-rp.zip'] = resourcepack
  routes['/cf/type-shader.zip'] = shaderpack
  const archive = writeCurseForgeZip(path.join(dir, 'Typed Pack.zip'), {
    name: 'Typed Pack',
    version: '1.0.0',
    files: [
      { projectID: 1, fileID: 10, required: true },
      { projectID: 2, fileID: 20, required: true },
      { projectID: 3, fileID: 30, required: true },
    ],
  })
  const bridgeOptions = {
    curseforgeApiKey: 'test-key',
    curseforgeBaseUrl: `${live.base}/v1`,
    fetchImpl: fetch,
  }
  try {
    const preview = await previewLegacyProfile(archive, bridgeOptions)
    assert.equal(preview.modCount, 1)
    assert.equal(preview.resourcepackCount, 1)
    assert.equal(preview.shaderCount, 1)

    const result = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Typed Pack', installMods: true },
      { rootPath: root, ...bridgeOptions },
    )
    assert.equal(result.success, true, result.error)
    const profile = result.profile
    assert.equal(profile.mods, 1)
    assert.equal(profile.resourcePacks, 1)
    assert.equal(profile.shaderPacks, 1)
    const gameDir = path.join(root, 'profiles', profile.folderName)
    assert.equal(fs.readFileSync(path.join(gameDir, 'mods', 'type-mod.jar')).equals(modJar), true)
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'resourcepacks', 'type-rp.zip')).equals(resourcepack),
      true,
    )
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'shaderpacks', 'type-shader.zip')).equals(shaderpack),
      true,
    )
    assert.deepEqual(
      profile.content.map((entry) => `${entry.type}:${entry.fileName}`).sort(),
      ['mods:type-mod.jar', 'resourcepacks:type-rp.zip', 'shaderpacks:type-shader.zip'],
    )
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile refuses an archive whose download does not match the manifest hash', async () => {
  const dir = tempDir('hash')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('expected', '1.0')
  const tampered = fabricJar('tampered', '6.6')
  const server = await fixtureServer({ '/files/mod.jar': tampered })
  try {
    const archive = writeMrpack(path.join(dir, 'tampered.mrpack'), {
      name: 'Tampered',
      dependencies: { minecraft: '1.20.1' },
      files: [
        {
          path: 'mods/mod.jar',
          downloads: [`${server.base}/files/mod.jar`],
          fileSize: modJar.length,
          hashes: { sha1: sha1(modJar), sha512: sha512(modJar) },
        },
      ],
    })
    const result = await importLegacyProfile({ filePath: archive }, { rootPath: root })
    assert.equal(result.success, false)
    assert.ok(result.error)
    const profileDir = path.join(root, 'profiles', 'tampered')
    assert.equal(fs.existsSync(path.join(profileDir, 'mods', 'mod.jar')), false)
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('export-profile writes a valid mrpack that imports again', async () => {
  const dir = tempDir('export')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('exported', '3.1')
  const instanceDir = path.join(root, 'profiles', 'Export Pack')
  fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
  fs.mkdirSync(path.join(instanceDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'mods', 'exported.jar'), modJar)
  fs.writeFileSync(path.join(instanceDir, 'config', 'exported.toml'), PACK_CONFIG)

  const routes = {}
  const server = await fixtureServer(routes)
  try {
    const versionRoute = `/version_file/${sha1(modJar)}`
    routes[versionRoute] = JSON.stringify({
      id: 'version-1',
      project_id: 'project-1',
      name: 'Exported',
      version_number: '3.1',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      files: [
        {
          url: `${server.base}/files/exported.jar`,
          filename: 'exported.jar',
          size: modJar.length,
          hashes: { sha1: sha1(modJar), sha512: sha512(modJar) },
          primary: true,
        },
      ],
    })
    routes['/files/exported.jar'] = modJar

    const destination = path.join(dir, 'out', 'Export Pack.mrpack')
    const result = await exportLegacyProfile(
      {
        format: 'mrpack',
        instanceName: 'Export Pack',
        folderName: 'Export Pack',
        manifest: { instance: { name: 'Export Pack', minecraftVersion: '1.20.1' } },
        mrpackIndex: {
          name: 'Export Pack',
          versionId: '4.0.0',
          // The shipped UI sends the camelCase key; the pack must not keep it.
          dependencies: { minecraft: '1.20.1', fabricLoader: '0.15.11' },
        },
        options: {
          includeMods: true,
          includeResourcepacks: true,
          includeShaderpacks: true,
          includeDatapacks: true,
          includeConfig: true,
          includeWorlds: false,
          includeScreenshots: false,
        },
        suggestedFileName: 'Export Pack.mrpack',
        savePath: destination,
      },
      { rootPath: root, modrinthBaseUrl: server.base },
    )

    assert.equal(result.success, true, result.error)
    assert.equal(result.filePath, destination)
    assert.equal(result.fileName, 'Export Pack.mrpack')
    assert.ok(result.fileSize > 0)
    assert.ok(fs.existsSync(destination))

    const manifest = await readMrpackManifest(destination)
    assert.equal(manifest.name, 'Export Pack')
    assert.equal(manifest.versionId, '4.0.0')
    assert.deepEqual(manifest.dependencies, {
      minecraft: '1.20.1',
      'fabric-loader': '0.15.11',
    })
    assert.equal(manifest.dependencies.fabricLoader, undefined)
    assert.deepEqual(manifest.files.map((file) => file.path), ['mods/exported.jar'])
    assert.equal(manifest.files[0].hashes.sha1, sha1(modJar))
    assert.equal(manifest.files[0].hashes.sha512, sha512(modJar))
    assert.equal(manifest.files[0].fileSize, modJar.length)
    assert.deepEqual(manifest.files[0].downloads, [`${server.base}/files/exported.jar`])

    // Re-import through the shipped handler: the archive must be self-contained.
    const secondRoot = path.join(dir, 'second')
    const imported = await importLegacyProfile(
      { filePath: destination, installMods: true, installConfig: true },
      { rootPath: secondRoot },
    )
    assert.equal(imported.success, true, imported.error)
    const profiles = JSON.parse(fs.readFileSync(path.join(secondRoot, 'profiles.json'), 'utf8'))
    const gameDir = path.join(secondRoot, 'profiles', profiles[0].folderName)
    assert.equal(fs.readFileSync(path.join(gameDir, 'mods', 'exported.jar')).equals(modJar), true)
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'config', 'exported.toml'), 'utf8'),
      PACK_CONFIG,
    )
    assert.equal(profiles[0].modloader, 'Fabric')
    assert.equal(profiles[0].minecraftVersion, '1.20.1')

    // A payload without `mrpackIndex` (legacy default path) still gets the
    // loader requirement from `manifest.instance`, under the spec key.
    const manifestOnly = path.join(dir, 'manifest-only.mrpack')
    const fallback = await exportLegacyProfile(
      {
        format: 'mrpack',
        instanceName: 'Export Pack',
        folderName: 'Export Pack',
        manifest: {
          instance: {
            name: 'Export Pack',
            minecraftVersion: '1.20.1',
            modloader: 'Fabric',
            modloaderVersion: '0.15.11',
          },
        },
        suggestedFileName: 'manifest-only.mrpack',
        savePath: manifestOnly,
      },
      { rootPath: root, modrinthBaseUrl: server.base },
    )
    assert.equal(fallback.success, true, fallback.error)
    const fallbackManifest = await readMrpackManifest(manifestOnly)
    assert.deepEqual(fallbackManifest.dependencies, {
      minecraft: '1.20.1',
      'fabric-loader': '0.15.11',
    })
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the mrpack tar fallback keeps the same command and stays asynchronous', async () => {
  const calls = []
  let settled = false
  const pending = extractMrpackWithTar(
    'C:\\cache\\pack one.mrpack',
    'C:\\cache\\extracted',
    (command, options, done) => {
      calls.push({ command, options })
      setImmediate(() => done(null))
    },
  )
  pending.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'the caller must keep running while tar works')
  await pending
  assert.equal(settled, true)
  assert.deepEqual(calls, [
    {
      command: 'tar -xf "C:\\cache\\pack one.mrpack" -C "C:\\cache\\extracted"',
      options: { encoding: 'utf8', timeout: 60000 },
    },
  ])
})

test('a failing tar keeps the existing mrpack error message', async () => {
  await assert.rejects(
    () =>
      extractMrpackWithTar('pack.mrpack', 'out', (_command, _options, done) => {
        setImmediate(() => done(new Error('tar exited with code 2')))
      }),
    { message: 'mrpack konnte nicht entpackt werden' },
  )
})

test('the shipped mrpack handler awaits the fallback instead of blocking the main loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.equal(source.includes('execSync'), false, 'no synchronous child process in main.js')
  assert.ok(
    source.includes('await extractMrpackWithTar(mrpackPath, extractDir)'),
    'the tar fallback must be awaited',
  )
})

function blockedCurseForgeRoutes(live, file) {
  const projectID = 11
  const fileID = 110
  live.routes[`/v1/mods/${projectID}/files/${fileID}`] = JSON.stringify({
    data: {
      id: fileID,
      modId: projectID,
      displayName: file.fileName,
      fileName: file.fileName,
      fileLength: file.buffer.length,
      downloadUrl: null,
      hashes: [{ algo: 1, value: sha1(file.buffer) }],
      gameVersions: ['1.20.1'],
      dependencies: [],
    },
  })
  // CurseForge withholds the URL (403) and denies third-party distribution.
  live.routes[`/v1/mods/${projectID}/files/${fileID}/download-url`] = { status: 403, body: '' }
  live.routes[`/v1/mods/${projectID}`] = JSON.stringify({
    data: { id: projectID, name: 'Blocked', slug: 'blocked', allowModDistribution: false },
  })
  return { projectID, fileID, hash: sha1(file.buffer) }
}

test('import-profile resolves a distribution-blocked CurseForge file from Modrinth by exact SHA-1', async () => {
  const dir = tempDir('import-modrinth-fallback')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('fallback', '1.0')
  const live = await fixtureServer({})
  const file = { fileName: 'blocked-fallback.jar', buffer: modJar }
  const { hash } = blockedCurseForgeRoutes(live, file)
  live.routes[`/v2/version_file/${hash}`] = JSON.stringify({
    id: 'mr-version-1',
    project_id: 'mr-project-1',
    name: 'Fallback',
    version_number: '1.0',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: `${live.base}/mr/${file.fileName}`,
        filename: file.fileName,
        size: modJar.length,
        hashes: { sha1: hash, sha512: sha512(modJar) },
        primary: true,
      },
    ],
  })
  live.routes[`/mr/${file.fileName}`] = modJar
  const archive = writeCurseForgeZip(path.join(dir, 'Blocked Pack.zip'), {
    name: 'Blocked Pack',
    version: '1.0.0',
    files: [{ projectID: 11, fileID: 110, required: true }],
    overrides: { 'config/fallback.toml': 'fallback = true\n' },
  })
  const bridgeOptions = {
    curseforgeApiKey: 'test-key',
    curseforgeBaseUrl: `${live.base}/v1`,
    modrinthBaseUrl: `${live.base}/v2`,
    fetchImpl: fetch,
  }
  try {
    const preview = await previewLegacyProfile(archive, bridgeOptions)
    assert.equal(preview.modCount, 1)
    const result = await importLegacyProfile(
      {
        filePath: archive,
        targetInstanceName: 'Blocked Pack',
        installMods: true,
        installConfig: true,
      },
      { rootPath: root, ...bridgeOptions },
    )
    assert.equal(result.success, true, result.error)
    assert.equal(result.profile.mods, 1)
    assert.equal(preview.modCount, result.profile.mods, 'preview and import must count the same plan')
    const gameDir = path.join(root, 'profiles', result.profile.folderName)
    assert.equal(fs.readFileSync(path.join(gameDir, 'mods', file.fileName)).equals(modJar), true)
    assert.equal(
      fs.readFileSync(path.join(gameDir, 'config', 'fallback.toml'), 'utf8'),
      'fallback = true\n',
    )
    assert.ok(live.hits.get(`/v2/version_file/${hash}`) >= 1, 'lookup must use the manifest SHA-1')
    assert.equal(live.hits.get(`/mr/${file.fileName}`), 1)
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile reports a blocked CurseForge file with no Modrinth match as a warning', async () => {
  const dir = tempDir('import-modrinth-missing')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('missing', '1.0')
  const live = await fixtureServer({})
  const file = { fileName: 'blocked-missing.jar', buffer: modJar }
  const { hash } = blockedCurseForgeRoutes(live, file)
  // No /v2/version_file route: the hash is unknown to Modrinth (404).
  const archive = writeCurseForgeZip(path.join(dir, 'Missing Pack.zip'), {
    name: 'Missing Pack',
    version: '1.0.0',
    files: [{ projectID: 11, fileID: 110, required: true }],
  })
  try {
    const result = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Missing Pack', installMods: true },
      {
        rootPath: root,
        curseforgeApiKey: 'test-key',
        curseforgeBaseUrl: `${live.base}/v1`,
        modrinthBaseUrl: `${live.base}/v2`,
        fetchImpl: fetch,
      },
    )
    assert.equal(result.success, true, result.error)
    assert.ok(
      Array.isArray(result.warnings) && result.warnings.length === 1,
      'the unobtainable file must be reported as a warning',
    )
    assert.match(result.warnings[0], /blocked-missing\.jar/)
    assert.match(result.warnings[0], /no matching Modrinth file/)
    assert.ok(result.profile, 'the profile must still be created')
    const gameDir = path.join(root, 'profiles', result.profile.folderName)
    assert.equal(
      fs.existsSync(path.join(gameDir, 'mods', file.fileName)),
      false,
      'the blocked file must not be placed',
    )
    assert.equal(live.hits.get(`/mr/${file.fileName}`), undefined, 'no unverified body may be requested')
    assert.ok(live.hits.get(`/v2/version_file/${hash}`), 'the fallback must look up the manifest hash')
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import-profile rejects a Modrinth fallback whose bytes do not match the SHA-1', async () => {
  const dir = tempDir('import-modrinth-tampered')
  const root = path.join(dir, 'game')
  const modJar = fabricJar('verified', '1.0')
  const tampered = Buffer.from(modJar)
  tampered[0] ^= 0xff
  const live = await fixtureServer({})
  const file = { fileName: 'blocked-tampered.jar', buffer: modJar }
  const { hash } = blockedCurseForgeRoutes(live, file)
  live.routes[`/v2/version_file/${hash}`] = JSON.stringify({
    id: 'mr-version-1',
    project_id: 'mr-project-1',
    name: 'Tampered',
    version_number: '1.0',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: `${live.base}/mr/tampered.jar`,
        filename: file.fileName,
        size: tampered.length,
        hashes: { sha1: hash, sha512: sha512(modJar) },
        primary: true,
      },
    ],
  })
  live.routes['/mr/tampered.jar'] = tampered
  const archive = writeCurseForgeZip(path.join(dir, 'Tampered Pack.zip'), {
    name: 'Tampered Pack',
    version: '1.0.0',
    files: [{ projectID: 11, fileID: 110, required: true }],
  })
  try {
    const result = await importLegacyProfile(
      { filePath: archive, targetInstanceName: 'Tampered Pack', installMods: true },
      {
        rootPath: root,
        curseforgeApiKey: 'test-key',
        curseforgeBaseUrl: `${live.base}/v1`,
        modrinthBaseUrl: `${live.base}/v2`,
        fetchImpl: fetch,
      },
    )
    assert.equal(result.success, false)
    assert.match(result.error, /blocked-tampered\.jar/)
    assert.match(result.error, /SHA-1/i)
    assert.equal(fs.existsSync(path.join(root, 'profiles.json')), false, 'no partial profile')
  } finally {
    await live.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
