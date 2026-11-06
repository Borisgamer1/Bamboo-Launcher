/**
 * P14 legacy cleanup: the old renderer/IPC entry points must resolve through
 * the typed owners (Java store/selector, bounded log tail, LAN reader) and the
 * duplicated main.js implementations must stay deleted.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { registerIpc } = require('../dist-electron/ipc.js')

const TRUSTED = { senderFrame: { url: 'file:///app/index.html' } }

function record(majorVersion, overrides = {}) {
  return {
    path: `C:\\Java\\jdk-${majorVersion}\\bin\\java.exe`,
    version: `${majorVersion}.0.1`,
    majorVersion,
    architecture: 'x64',
    vendor: 'Eclipse Adoptium',
    source: 'scan',
    valid: true,
    ...overrides,
  }
}

function fakeCore({ gameRoot, records = [record(17), record(21)], folder = 'demo' }) {
  const calls = { scans: 0, selections: [] }
  const core = {
    paths: { gameRoot },
    java: {
      list: async () => records,
      scan: async () => {
        calls.scans += 1
        return { records }
      },
      select: async (request) => {
        calls.selections.push(request)
        return {
          preference: { majorVersion: 17, requirement: '=17' },
          quality: 'matched',
          java: records.find((entry) => entry.majorVersion === 17),
          matched: records,
          noJava: false,
        }
      },
    },
    instanceManager: {
      findByFolder: async (name) =>
        name === folder ? { directory: path.join(gameRoot, 'instances', folder) } : undefined,
    },
  }
  return { core, calls }
}

function handlersFor(core) {
  const handlers = new Map()
  registerIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, core)
  return handlers
}

test('P14 legacy Java channels resolve through the typed Java owner', async () => {
  const gameRoot = tempDir('p14-java')
  try {
    const { core, calls } = fakeCore({ gameRoot })
    const handlers = handlersFor(core)

    const versions = await handlers.get('get-java-versions')(TRUSTED, false)
    assert.deepEqual(versions.map((entry) => entry.majorVersion), [21, 17])
    assert.equal(versions[0].version, 21, 'legacy major alias stays available')
    assert.equal(versions[0].verStr, '21.0.1')
    assert.equal(versions[0].arch, 'x64')
    assert.equal(versions[0].vendor, 'Eclipse Adoptium')
    assert.equal(calls.scans, 0, 'a warm store must not rescan')

    await handlers.get('get-java-versions')(TRUSTED, true)
    assert.equal(calls.scans, 1, 'forceRescan scans exactly once')

    assert.equal(
      await handlers.get('find-java')(TRUSTED),
      'C:\\Java\\jdk-21\\bin\\java.exe',
    )

    const recommended = await handlers.get('get-recommended-java-for-mc')(TRUSTED, '1.20.1')
    assert.equal(recommended.recommended, 17)
    assert.equal(recommended.selected.majorVersion, 17)
    assert.deepEqual(recommended.available.map((entry) => entry.majorVersion), [21, 17])
    assert.deepEqual(calls.selections.at(-1), { minecraftVersion: '1.20.1' })

    const best = await handlers.get('find-best-java-for-mc')(TRUSTED, '1.20.1')
    assert.equal(best.majorVersion, 17)
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('P14 cold Java store scans once and hides invalidated records', async () => {
  const gameRoot = tempDir('p14-java-cold')
  try {
    const records = [record(17), record(8, { valid: false })]
    const { core, calls } = fakeCore({ gameRoot, records: [] })
    core.java.scan = async () => {
      calls.scans += 1
      return { records }
    }
    const handlers = handlersFor(core)
    const versions = await handlers.get('get-java-versions')(TRUSTED)
    assert.equal(calls.scans, 1)
    assert.deepEqual(versions.map((entry) => entry.majorVersion), [17])
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('P14 log and LAN channels use the bounded tail owner', async () => {
  const gameRoot = tempDir('p14-logs')
  try {
    const { core } = fakeCore({ gameRoot })
    const directory = path.join(gameRoot, 'instances', 'demo')
    fs.mkdirSync(path.join(directory, 'logs'), { recursive: true })
    const lines = []
    for (let index = 1; index <= 2105; index += 1) lines.push(`line ${index}`)
    lines.push('\u001b[32m[Render thread/INFO]: Published a LAN server on port 25566\u001b[0m')
    fs.writeFileSync(path.join(directory, 'logs', 'latest.log'), `${lines.join('\n')}\n`, 'utf8')

    const handlers = handlersFor(core)
    const text = await handlers.get('read-latest-log')(TRUSTED, 'demo')
    const tail = text.split('\n')
    assert.equal(tail.length, 2000, 'the full-file read is replaced by the 2000-line tail')
    assert.equal(tail.at(-1).includes('LAN server on port 25566'), true)
    assert.equal(tail.at(-1).includes('\u001b'), false, 'ANSI escapes are stripped')

    const lan = await handlers.get('detect-lan-server')(TRUSTED, 'demo')
    assert.deepEqual(lan, { port: 25566, address: '0.0.0.0:25566' })
    const hosted = await handlers.get('get-hosted-servers')(TRUSTED)
    assert.equal(hosted.demo.port, 25566)

    // Unmigrated legacy profiles still resolve below <gameRoot>/profiles.
    const legacyDir = path.join(gameRoot, 'profiles', 'legacy', 'logs')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'latest.log'), 'legacy line\n', 'utf8')
    assert.equal(await handlers.get('read-latest-log')(TRUSTED, 'legacy'), 'legacy line')
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true })
  }
})

test('P14 main.js keeps no duplicate Java scan, full log read or root literal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.equal(
    /ipcMain\.(handle|on|once)\(/.test(source),
    false,
    'every main.js channel must register through the shared IPC owner',
  )
  for (const legacy of [
    'scanJavaCandidates',
    'findAllJavaVersions',
    'JAVA_VERSION_MAPPING',
    'getRecommendedJavaVersionForMc',
    'selectBestJavaForMcVersion',
    'findInstallerJavaPath',
    "ipcMain.handle('detect-lan-server'",
    "ipcMain.handle('read-latest-log'",
    "readFileSync(logPath",
  ]) {
    assert.equal(source.includes(legacy), false, `${legacy} must stay deleted from main.js`)
  }
})

test('P14 main.js keeps no duplicate loader installers', () => {
  const source = ['main.js', 'electron/legacy/launch-ipc.ts', 'electron/legacy/loader-install.ts']
    .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
    .join('\n')
  for (const legacy of [
    'installModloader',
    'installForgeLoader',
    'installNeoforgeLoader',
    'extractLoaderFromInstallerJar',
    'patchLoaderVersion',
    'ensureVanillaVersion',
    'downloadVanillaJar',
    'downloadProfileLibraries',
    'downloadLibraryByPath',
    'ensureBambooClientMod',
    'ensureClientJarForNeoForge',
    'installFabricApi',
    'copyRecursiveSync',
    "ipc.handle('complete-reinstall'",
  ]) {
    assert.equal(source.includes(legacy), false, `${legacy} must stay deleted from main.js`)
  }

  assert.equal(
    source.match(/async function installLoaderViaCore\(/g)?.length,
    1,
    'one helper owns the remaining loader-install call sites',
  )
  assert.match(
    source,
    /core\.loaders\.install\(/,
    'loader installs must go through the core loader service',
  )
  assert.match(
    source,
    /const legacyDirectory = (?:options\.)?profileDirOrNull\(rootPath, folderName\)/,
    'launch-game must resolve the legacy profile directory it hands to the launch facade through the guard',
  )
})
