/**
 * Phase 2 tests: Java matrix, selection determinism, runtime resolution and
 * the SHA-1 verified Mojang runtime installer (local HTTP fixture, no internet).
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createNullLogger } = require('../dist-electron/logger.js')
const { JavaManager } = require('../dist-electron/java/manager.js')
const { parseRuntimeManifest, resolveRuntimeComponent, runtimePlatformKey } = require('../dist-electron/java/manifest.js')
const { installRuntime } = require('../dist-electron/java/installer.js')
const { sha1Hex } = require('../dist-electron/download/checksum.js')
const { isSafeRelativePath } = require('../dist-electron/download/paths.js')
const { parseMinecraftVersion, parseJavaMajorVersion, parseReleaseFile, parseJavaVersionOutput } = require('../dist-electron/java/version.js')
const { getJavaPreference } = require('../dist-electron/java/selector.js')
const { parseRegistryJavaHomes, probeJava } = require('../dist-electron/java/scan.js')

function createFakeJdk(root, version, options = {}) {
  const home = path.join(root, `jdk-${version}${options.suffix ?? ''}`)
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  const executable = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  fs.writeFileSync(executable, '')
  fs.writeFileSync(
    path.join(home, 'release'),
    `JAVA_VERSION="${version}"\nOS_ARCH="${options.arch ?? 'amd64'}"\nIMPLEMENTOR="${options.vendor ?? 'Eclipse Adoptium'}"\n`,
    'utf8',
  )
  return executable
}

async function createManager(label, versions) {
  const root = tempDir(label)
  const manager = new JavaManager({
    file: path.join(root, 'java.json'),
    gameRoot: path.join(root, 'game'),
    logger: createNullLogger(),
    platform: 'win32',
    arch: 'x64',
  })
  for (const entry of versions) {
    const executable = createFakeJdk(root, entry.version, entry)
    const record = await manager.test(executable)
    assert.ok(record, `fake JDK ${entry.version} must be probed`)
    assert.equal(record.majorVersion, parseJavaMajorVersion(entry.version))
  }
  return manager
}

test('parses Minecraft and JVM version strings', () => {
  assert.deepEqual(parseMinecraftVersion('1.8.9'), { raw: '1.8.9', major: 1, minor: 8, patch: 9 })
  assert.equal(parseMinecraftVersion('1.20.1-forge-47.3.22').minor, 20)
  assert.equal(parseMinecraftVersion('25w14a'), undefined)
  assert.equal(parseJavaMajorVersion('1.8.0_503'), 8)
  assert.equal(parseJavaMajorVersion('17.0.9'), 17)
  assert.equal(parseJavaMajorVersion('21'), 21)
  assert.equal(parseJavaMajorVersion('25-ea'), 25)
  assert.equal(parseJavaMajorVersion('16.0.1.9.1'), 16)

  const release = parseReleaseFile('JAVA_VERSION="1.8.0_503"\nOS_ARCH="amd64"\nIMPLEMENTOR="Oracle"\n')
  assert.equal(release.majorVersion, 8)
  assert.equal(release.architecture, 'x64')
  assert.equal(release.vendor, 'Oracle')

  const output = parseJavaVersionOutput(
    'Property settings:\n    java.version = 21.0.1\n    os.arch = aarch64\n    java.vendor = Eclipse Adoptium\nopenjdk version "21.0.1" 2024-10-15',
  )
  assert.equal(output.majorVersion, 21)
  assert.equal(output.architecture, 'arm64')
  assert.equal(output.vendor, 'Eclipse Adoptium')
})

test('probes a JVM through -XshowSettings when no release file exists', async () => {
  const root = tempDir('probe')
  const home = path.join(root, 'jdk-no-release')
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  const executable = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  fs.writeFileSync(executable, '')

  const record = await probeJava(executable, {
    execJava: async (file, args) => {
      assert.equal(file, executable)
      assert.ok(args.includes('-XshowSettings:properties'))
      return 'java.version = 21.0.1\nos.arch = amd64\njava.vendor = Test Vendor\n'
    },
  })
  assert.ok(record)
  assert.equal(record.majorVersion, 21)
  assert.equal(record.architecture, 'x64')
  assert.equal(record.vendor, 'Test Vendor')
  assert.equal(record.valid, true)
})

test('parses registry output into JDK homes', () => {
  const output = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\JavaSoft\\JDK\\17.0.9',
    '    JavaHome    REG_SZ    C:\\Program Files\\Java\\jdk-17',
    '    Path    REG_SZ    C:\\Program Files\\Java\\jdk-17\\bin',
    '    NotAPath    REG_SZ    whatever',
  ].join('\r\n')
  assert.deepEqual(parseRegistryJavaHomes(output), [
    'C:\\Program Files\\Java\\jdk-17',
    'C:\\Program Files\\Java\\jdk-17\\bin',
  ])
})

test('DoD: 1.8.9 selects Java 8 even when 17/21/25 are installed', async () => {
  const manager = await createManager('legacy', [
    { version: '1.8.0_503' },
    { version: '17.0.15' },
    { version: '21.0.7' },
    { version: '25.0.1' },
  ])
  const result = await manager.select({
    minecraftVersion: '1.8.9',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  })
  assert.equal(result.quality, 'matched')
  assert.equal(result.java.majorVersion, 8)
  assert.equal(result.preference.requirement, '=8')
  assert.equal(result.preference.component, 'jre-legacy')
})

test('DoD: 1.16.5 selects Java 8 from its version metadata', async () => {
  const manager = await createManager('sixteen', [
    { version: '1.8.0_503' },
    { version: '17.0.15' },
    { version: '25.0.1' },
  ])
  const result = await manager.select({
    minecraftVersion: '1.16.5',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  })
  assert.equal(result.java.majorVersion, 8)
  assert.equal(result.preference.requirement, '=8')
})

test('DoD: 1.20.1 selects Java 17 and falls back forward to 21 when 17 is missing', async () => {
  const with17 = await createManager('twenty', [
    { version: '1.8.0_503' },
    { version: '17.0.15' },
    { version: '21.0.7' },
    { version: '25.0.1' },
  ])
  const exact = await with17.select({
    minecraftVersion: '1.20.1',
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  })
  assert.equal(exact.java.majorVersion, 17)
  assert.equal(exact.preference.requirement, '>=17')

  const without17 = await createManager('forward', [{ version: '21.0.7' }, { version: '25.0.1' }])
  const forward = await without17.select({
    minecraftVersion: '1.20.1',
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  })
  assert.equal(forward.quality, 'matched')
  assert.equal(forward.java.majorVersion, 21, 'Java 21 must satisfy a 17 requirement')
})

test('DoD: Forge 1.20.1 is pinned to 17, never to Java 25', async () => {
  const manager = await createManager('forge', [
    { version: '1.8.0_503' },
    { version: '17.0.15' },
    { version: '21.0.7' },
    { version: '25.0.1' },
  ])
  const preferred = getJavaPreference({ minecraftVersion: '1.20.1', loader: 'forge' })
  assert.equal(preferred.requirement, '=17')
  assert.equal(preferred.component, 'java-runtime-gamma')

  const result = await manager.select({ minecraftVersion: '1.20.1-forge-47.3.22', loader: 'forge' })
  assert.equal(result.java.majorVersion, 17)

  const without17 = await createManager('forge-no17', [{ version: '21.0.7' }, { version: '25.0.1' }])
  const none = await without17.select({ minecraftVersion: '1.20.1', loader: 'forge' })
  assert.equal(none.java, undefined, 'Java 25 must not satisfy the Forge pin')
  assert.equal(none.quality, 'incompatible')
  assert.equal(none.preference.majorVersion, 17)
})

test('DoD: 1.21 selects Java 21, exact major wins over 25', async () => {
  const manager = await createManager('modern', [
    { version: '17.0.15' },
    { version: '21.0.7' },
    { version: '25.0.1' },
  ])
  const result = await manager.select({
    minecraftVersion: '1.21',
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  })
  assert.equal(result.java.majorVersion, 21)
  assert.equal(result.preference.requirement, '>=21')
})

test('Java 8 is strict: Java 11 is only a may-incompatible fallback', async () => {
  const manager = await createManager('strict', [{ version: '11.0.20' }, { version: '17.0.15' }])
  const result = await manager.select({
    minecraftVersion: '1.8.9',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  })
  assert.equal(result.quality, 'may-incompatible')
  assert.equal(result.java.majorVersion, 11)
  assert.equal(result.matched.length, 0)
})

test('compatibleJavaMajors is an exact allowlist and OpenJ9 loses to HotSpot', async () => {
  const manager = await createManager('allowlist', [
    { version: '17.0.15', suffix: '-openj9', vendor: 'IBM Semeru' },
    { version: '17.0.15', suffix: '-hotspot' },
    { version: '21.0.7' },
  ])
  const allow = await manager.select({
    minecraftVersion: '1.20.1',
    compatibleJavaMajors: [17],
  })
  assert.equal(allow.java.majorVersion, 17)
  assert.ok(!allow.java.path.toLowerCase().includes('openj9'), 'HotSpot must win the tie')

  const noMatch = await manager.select({ minecraftVersion: '1.20.1', compatibleJavaMajors: [16] })
  assert.equal(noMatch.java, undefined)
})

test('runtime manifest resolves by major, not by stale component name', () => {
  const manifest = parseRuntimeManifest({
    manifest: {
      'windows-x64': {
        'java-runtime-gamma': [
          { version: { name: '17.0.15' }, manifest: { url: 'https://example/gamma.json', sha1: 'a', size: 1 } },
        ],
        'java-runtime-delta': [
          { version: { name: '21.0.7' }, manifest: { url: 'https://example/delta.json', sha1: 'b', size: 1 } },
        ],
      },
    },
  })
  assert.equal(runtimePlatformKey('win32', 'x64'), 'windows-x64')
  assert.equal(runtimePlatformKey('win32', 'ia32'), 'windows-x86')
  assert.equal(runtimePlatformKey('linux', 'x64'), 'linux')

  const stale = resolveRuntimeComponent(manifest, 'windows-x64', 17, 'java-runtime-beta')
  assert.equal(stale.component, 'java-runtime-gamma', 'java-runtime-beta no longer exists')

  const modern = resolveRuntimeComponent(manifest, 'windows-x64', 21)
  assert.equal(modern.component, 'java-runtime-delta')
  assert.equal(resolveRuntimeComponent(manifest, 'windows-x64', 8), undefined)
})

test('runtime installer verifies SHA-1, skips intact files and rejects corruption', async () => {
  const gameRoot = tempDir('install')
  const javaBytes = Buffer.from('fake-java-binary', 'utf8')
  const releaseBytes = Buffer.from('JAVA_VERSION="17.0.15"\n', 'utf8')
  const hits = { runtime: 0, java: 0, release: 0 }
  const routes = {}

  const server = http.createServer((req, res) => {
    const route = routes[req.url]
    if (!route) {
      res.writeHead(404).end('missing')
      return
    }
    if (req.url === '/runtime.json') hits.runtime += 1
    if (req.url === '/java.exe') hits.java += 1
    if (req.url === '/release') hits.release += 1
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(route)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const runtimeJson = JSON.stringify({
      files: {
        'bin/': { type: 'directory' },
        'bin/java.exe': {
          type: 'file',
          executable: true,
          downloads: { raw: { url: `${base}/java.exe`, sha1: sha1Hex(javaBytes), size: javaBytes.length } },
        },
        release: {
          type: 'file',
          downloads: { raw: { url: `${base}/release`, sha1: sha1Hex(releaseBytes), size: releaseBytes.length } },
        },
      },
    })
    routes['/runtime.json'] = Buffer.from(runtimeJson, 'utf8')
    routes['/java.exe'] = javaBytes
    routes['/release'] = releaseBytes

    const entry = {
      version: { name: '17.0.15' },
      manifest: {
        url: `${base}/runtime.json`,
        sha1: sha1Hex(runtimeJson),
        size: Buffer.byteLength(runtimeJson),
      },
    }

    const progress = []
    const installed = await installRuntime({
      gameRoot,
      component: 'java-runtime-gamma',
      entry,
      platform: 'win32',
      onProgress: (state) => progress.push(state),
    })
    assert.equal(installed.javaPath, path.join(gameRoot, 'java', 'java-runtime-gamma', 'bin', 'java.exe'))
    assert.equal(fs.readFileSync(installed.javaPath, 'utf8'), 'fake-java-binary')
    assert.equal(progress.at(-1).completedFiles, 2)
    assert.equal(progress.at(-1).totalFiles, 2)
    assert.ok(progress.at(-1).totalBytes >= javaBytes.length)

    const hitsAfterFirst = { ...hits }
    const second = await installRuntime({
      gameRoot,
      component: 'java-runtime-gamma',
      entry,
      platform: 'win32',
    })
    assert.equal(second.downloadedBytes, 0)
    assert.equal(hits.java, hitsAfterFirst.java, 'intact java.exe must not be downloaded again')
    assert.equal(hits.release, hitsAfterFirst.release)

    const badEntry = {
      version: { name: '17.0.15' },
      manifest: {
        url: `${base}/runtime.json`,
        sha1: 'deadbeef',
        size: Buffer.byteLength(runtimeJson),
      },
    }
    await assert.rejects(
      () => installRuntime({ gameRoot: tempDir('bad'), component: 'java-runtime-gamma', entry: badEntry, platform: 'win32' }),
      /manifest SHA-1 mismatch/,
    )

    assert.equal(isSafeRelativePath('bin/java.exe'), true)
    assert.equal(isSafeRelativePath('../escape'), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
