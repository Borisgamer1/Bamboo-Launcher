/**
 * Phase 3 tests: inheritance, rules, library dedup/natives, asset indexes,
 * legacy virtual assets, manifest ETag cache and mirror fallback.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createNullLogger } = require('../dist-electron/logger.js')
const { resolveVersionModel, loadVersionChain, VersionResolveError } = require('../dist-electron/version/resolve.js')
const { VersionResolver } = require('../dist-electron/version/resolver.js')
const { VersionManifestService } = require('../dist-electron/version/manifest.js')
const { evaluateRules, resolveLaunchArguments, currentPlatform } = require('../dist-electron/version/rules.js')
const { compareMavenVersions, parseMavenCoordinate, coordinatePath } = require('../dist-electron/version/libraries.js')
const fixtures = require('./fixtures/version-fixtures.cjs')

const WINDOWS = { name: 'windows', arch: 'x64', version: '10.0.19045' }
const LINUX = { name: 'linux', arch: 'x64', version: '6.8.0' }

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function materializeFixtures() {
  const gameRoot = tempDir('fixtures')
  for (const [id, json] of Object.entries(fixtures.versions)) {
    writeJson(path.join(gameRoot, 'versions', id, `${id}.json`), json)
  }
  for (const [name, json] of Object.entries(fixtures.assets)) {
    writeJson(path.join(gameRoot, 'assets', 'indexes', name), json)
  }
  return gameRoot
}

function libraryByName(model, name) {
  return model.libraries.find((library) => library.name === name)
}

test('evaluates OS, arch and feature rules with last-match-wins', () => {
  assert.equal(evaluateRules(undefined, WINDOWS), true)
  assert.equal(
    evaluateRules([{ action: 'allow', os: { name: 'windows' } }], WINDOWS),
    true,
  )
  assert.equal(evaluateRules([{ action: 'allow', os: { name: 'osx' } }], WINDOWS), false)
  assert.equal(
    evaluateRules([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], WINDOWS),
    false,
  )
  assert.equal(
    evaluateRules([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], WINDOWS),
    true,
  )
  assert.equal(
    evaluateRules([{ action: 'allow', os: { name: 'windows', version: '^6\\.' } }], WINDOWS),
    false,
  )
  assert.equal(
    evaluateRules([{ action: 'allow', features: { has_custom_resolution: true } }], WINDOWS, {
      has_custom_resolution: true,
    }),
    true,
  )
  assert.equal(
    evaluateRules([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], WINDOWS),
    false,
  )
  assert.equal(currentPlatform('win32', 'x64', '10.0.1').name, 'windows')
  assert.equal(currentPlatform('darwin', 'arm64', '14.0').name, 'osx')
})

test('parses Maven coordinates and compares versions', () => {
  assert.equal(coordinatePath(parseMavenCoordinate('org.ow2.asm:asm:9.5')), 'org/ow2/asm/asm/9.5/asm-9.5.jar')
  assert.equal(
    coordinatePath(parseMavenCoordinate('net.minecraftforge:forge:1.20.1-47.2.0:universal')),
    'net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar',
  )
  assert.ok(compareMavenVersions('9.5', '9.3') > 0)
  assert.ok(compareMavenVersions('9.6', '9.5') > 0)
  assert.ok(compareMavenVersions('1.0-alpha', '1.0') < 0)
  assert.equal(compareMavenVersions('9.5', '9.5'), 0)
})

test('DoD: 1.8.9 resolves legacy natives, arguments and asset hash tree', async () => {
  const gameRoot = materializeFixtures()
  const model = await resolveVersionModel(gameRoot, '1.8.9', {
    platform: WINDOWS,
    logger: createNullLogger(),
  })

  assert.deepEqual(model.chain, ['1.8.9'])
  assert.equal(model.mainClass, 'net.minecraft.client.main.Main')
  assert.equal(model.minecraftVersion, '1.8.9')
  assert.equal(model.javaVersion.majorVersion, 8)
  assert.equal(model.javaVersion.component, 'jre-legacy')

  assert.equal(model.natives.length, 1)
  const native = model.natives[0]
  assert.ok(native.classifier.startsWith('natives-windows'))
  assert.ok(native.path.endsWith('natives-windows.jar'))
  assert.deepEqual(native.extractExclude, ['META-INF/'])

  assert.ok(libraryByName(model, 'example:windows-only:1.0'))
  assert.equal(libraryByName(model, 'example:osx-only:1.0'), undefined)
  assert.equal(model.libraries.length, 3, 'netty, lwjgl and windows-only')
  assert.equal(model.classpath.length, 4)
  assert.equal(model.classpath.at(-1), model.clientJar)
  assert.ok(model.clientJar.endsWith(path.join('versions', '1.8.9', '1.8.9.jar')))

  assert.equal(model.assets.id, '1.8')
  assert.equal(model.assets.available, true)
  assert.equal(model.assets.legacyVirtual, false)
  assert.equal(model.assets.count, 3)
  assert.match(model.assets.objects[0].path, /^objects\/[0-9a-f]{2}\/[0-9a-f]{40}$/)
  assert.ok(model.assets.objects[0].absolutePath.includes(path.join('assets', 'objects')))

  assert.equal(model.arguments.game[0], '--username')
  assert.ok(model.arguments.jvm.includes('-cp'))
  assert.ok(resolveLaunchArguments(model.arguments.jvm, WINDOWS).includes('-Djava.library.path=${natives_directory}'))
})

test('DoD: 1.20.1 resolves modern natives, rules and asset index', async () => {
  const gameRoot = materializeFixtures()
  const model = await resolveVersionModel(gameRoot, '1.20.1', {
    platform: WINDOWS,
    logger: createNullLogger(),
  })

  assert.equal(model.natives.length, 0, 'modern natives are classpath libraries')
  assert.ok(libraryByName(model, 'org.lwjgl:lwjgl:3.3.1:natives-windows'))
  assert.equal(libraryByName(model, 'org.lwjgl:lwjgl:3.3.1:natives-macos'), undefined)
  assert.equal(model.libraries.length, 4)
  assert.equal(model.classpath.length, 5)
  assert.equal(model.assets.id, '5')
  assert.equal(model.assets.count, 4)
  assert.equal(model.assets.legacyVirtual, false)
  assert.equal(model.javaVersion.majorVersion, 17)

  const withResolution = resolveLaunchArguments(model.arguments.game, WINDOWS, {
    has_custom_resolution: true,
  })
  assert.ok(withResolution.includes('--width'))
  const withoutResolution = resolveLaunchArguments(model.arguments.game, WINDOWS, {})
  assert.ok(!withoutResolution.includes('--width'))
  assert.ok(!resolveLaunchArguments(model.arguments.game, WINDOWS).includes('-XstartOnFirstThread'))

  const windowsJvm = resolveLaunchArguments(model.arguments.jvm, WINDOWS)
  assert.ok(windowsJvm.includes('-Dos.name=Windows 10'))
  const linuxJvm = resolveLaunchArguments(model.arguments.jvm, LINUX)
  assert.ok(!linuxJvm.includes('-Dos.name=Windows 10'))
})

test('DoD: Forge inherits base version, patches libraries and keeps assets/java', async () => {
  const gameRoot = materializeFixtures()
  const model = await resolveVersionModel(gameRoot, '1.20.1-forge-47.2.0', {
    platform: WINDOWS,
    logger: createNullLogger(),
  })

  assert.deepEqual(model.chain, ['1.20.1-forge-47.2.0', '1.20.1'])
  assert.equal(model.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher')
  assert.equal(model.minecraftVersion, '1.20.1')
  assert.equal(model.jarVersion, '1.20.1')
  assert.equal(model.assets.id, '5')
  assert.equal(model.assets.count, 4)
  assert.equal(model.javaVersion.majorVersion, 17)
  assert.ok(model.downloads.client, 'client download is inherited')

  const asm = model.libraries.filter((library) => library.groupId === 'org.ow2.asm' && library.artifactId === 'asm')
  assert.equal(asm.length, 1, 'duplicate asm must be deduplicated')
  assert.equal(asm[0].version, '9.5', 'Forge patched asm must replace the older base version')
  assert.ok(libraryByName(model, 'net.minecraftforge:forge:1.20.1-47.2.0:universal'))
  assert.ok(model.classpath.some((entry) => entry.includes(path.join('asm', '9.5', 'asm-9.5.jar'))))
  assert.ok(model.arguments.jvm.includes('-Dforge.logging.console.level=info'))
})

test('DoD: Fabric profile inherits base version and adds loader libraries', async () => {
  const gameRoot = materializeFixtures()
  const model = await resolveVersionModel(gameRoot, 'fabric-loader-0.15.0-1.20.1', {
    platform: WINDOWS,
    logger: createNullLogger(),
  })

  assert.deepEqual(model.chain, ['fabric-loader-0.15.0-1.20.1', '1.20.1'])
  assert.equal(model.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
  assert.equal(model.jarVersion, '1.20.1')
  assert.ok(libraryByName(model, 'net.fabricmc:fabric-loader:0.15.0'))
  const asm = model.libraries.filter((library) => library.groupId === 'org.ow2.asm' && library.artifactId === 'asm')
  assert.equal(asm.length, 1)
  assert.equal(asm[0].version, '9.6')
  assert.equal(model.assets.id, '5')
  assert.equal(model.javaVersion.majorVersion, 17)
})

test('legacy virtual asset index gets a virtual path per object', async () => {
  const gameRoot = materializeFixtures()
  const model = await resolveVersionModel(gameRoot, '1.6.4', { platform: WINDOWS })
  assert.equal(model.assets.id, 'legacy')
  assert.equal(model.assets.available, true)
  assert.equal(model.assets.legacyVirtual, true)
  assert.equal(model.assets.count, 2)
  assert.ok(model.assets.virtualDir.endsWith(path.join('assets', 'virtual', 'legacy')))
  for (const object of model.assets.objects) {
    assert.equal(object.virtualPath, `virtual/legacy/${object.name}`)
  }
})

test('detects circular inheritance', async () => {
  const gameRoot = materializeFixtures()
  await assert.rejects(
    () => resolveVersionModel(gameRoot, 'cycle-a'),
    (error) => error instanceof VersionResolveError && error.code === 'circular-inheritance',
  )
  await assert.rejects(() => loadVersionChain(gameRoot, 'cycle-a'), /cycle-a -> cycle-b -> cycle-a/)
})

test('enforces the inheritance depth limit', async () => {
  const gameRoot = tempDir('depth')
  for (let index = 0; index < 6; index += 1) {
    const id = `chain-${index}`
    writeJson(path.join(gameRoot, 'versions', id, `${id}.json`), {
      id,
      ...(index < 5 ? { inheritsFrom: `chain-${index + 1}` } : {}),
      mainClass: 'example.Main',
      libraries: [],
    })
  }
  await assert.rejects(
    () => resolveVersionModel(gameRoot, 'chain-0', { maxDepth: 3 }),
    (error) => error instanceof VersionResolveError && error.code === 'inherit-depth',
  )
  const ok = await resolveVersionModel(gameRoot, 'chain-0', { maxDepth: 8 })
  assert.equal(ok.chain.length, 6)
})

test('reports missing version JSONs', async () => {
  const gameRoot = materializeFixtures()
  await assert.rejects(
    () => resolveVersionModel(gameRoot, 'does-not-exist'),
    (error) => error instanceof VersionResolveError && error.code === 'missing-version',
  )
})

test('version manifest uses ETag cache, 304 revalidation and mirror fallback', async () => {
  const manifestBody = {
    latest: { release: '1.20.1', snapshot: '24w14a' },
    versions: [
      { id: '1.20.1', type: 'release', url: 'https://example.invalid/1.20.1.json' },
      { id: '24w14a', type: 'snapshot', url: 'https://example.invalid/24w14a.json' },
    ],
  }
  let networkHits = 0
  let notModified = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/broken') {
      res.writeHead(500).end('broken')
      return
    }
    networkHits += 1
    if (req.headers['if-none-match'] === '"v1"') {
      notModified += 1
      res.writeHead(304, { ETag: '"v1"' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', ETag: '"v1"' })
    res.end(JSON.stringify(manifestBody))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const cacheDir = tempDir('manifest')
    const service = new VersionManifestService({
      cacheDir,
      sources: [`${base}/manifest.json`],
      fetchImpl: fetch,
    })

    const first = await service.get()
    assert.equal(first.source, 'network')
    assert.equal(first.manifest.versions.length, 2)
    assert.equal(first.etag, '"v1"')
    assert.equal(networkHits, 1)

    const cached = await service.get()
    assert.equal(cached.source, 'cache')
    assert.equal(networkHits, 1, 'fresh cache must not hit the network')

    const revalidated = await service.get({ maxAgeMs: 0 })
    assert.equal(revalidated.source, 'not-modified')
    assert.equal(notModified, 1)

    const mirror = new VersionManifestService({
      cacheDir: tempDir('manifest-mirror'),
      sources: [`${base}/broken`, `${base}/manifest.json`],
      fetchImpl: fetch,
    })
    const fromMirror = await mirror.get()
    assert.equal(fromMirror.source, 'network')

    const offline = new VersionManifestService({
      cacheDir,
      sources: ['http://127.0.0.1:1/manifest.json'],
      fetchImpl: fetch,
    })
    const stale = await offline.get({ maxAgeMs: 0 })
    assert.equal(stale.source, 'stale-cache')
    assert.equal(stale.manifest.latest.release, '1.20.1')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('VersionResolver lists installed versions without touching them', async () => {
  const gameRoot = materializeFixtures()
  const resolver = new VersionResolver({
    gameRoot,
    cacheDir: path.join(gameRoot, 'cache'),
    logger: createNullLogger(),
    platform: WINDOWS,
  })
  const installed = await resolver.listInstalled()
  assert.ok(installed.includes('1.20.1'))
  assert.ok(installed.includes('fabric-loader-0.15.0-1.20.1'))
  const model = await resolver.resolve('1.20.1')
  assert.equal(model.mainClass, 'net.minecraft.client.main.Main')
})
