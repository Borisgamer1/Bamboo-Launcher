/**
 * P10 Java Resolver v2: architecture gate, reason codes, existence checks,
 * offline/no-runtime behaviour, scan fingerprints and the resolvedJava memo.
 *
 * Everything runs against the compiled dist-electron surface.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createCore } = require('../dist-electron/core.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { JavaManager } = require('../dist-electron/java/manager.js')
const { javaFingerprint } = require('../dist-electron/java/scan.js')
const { javaMemoRelativePath, resolveJavaMemo } = require('../dist-electron/java/memo.js')
const { archCompatible, getJavaPreference, selectJavaRecord } = require('../dist-electron/java/selector.js')

function fakeJdk(root, version, options = {}) {
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

function majorOf(version) {
  const parts = version.split('.')
  return parts[0] === '1' ? Number(parts[1]) : Number(parts[0])
}

function record(version, architecture, extra = {}) {
  return {
    path: extra.path ?? `C:\\Java\\${version}-${architecture}\\bin\\java.exe`,
    version,
    majorVersion: majorOf(version),
    architecture,
    vendor: 'Test',
    source: 'manual',
    valid: true,
    addedAt: 1,
    validatedAt: 1,
    ...extra,
  }
}

async function managerWith(label, versions, options = {}) {
  const root = tempDir(label)
  const manager = new JavaManager({
    file: path.join(root, 'java.json'),
    gameRoot: path.join(root, 'game'),
    logger: createNullLogger(),
    platform: options.platform ?? 'win32',
    arch: options.arch ?? 'x64',
    env: options.env ?? {},
    ...(options.isOnline ? { isOnline: options.isOnline } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const executables = []
  for (const entry of versions) {
    const executable = fakeJdk(root, entry.version, entry)
    const probed = await manager.test(executable)
    assert.ok(probed, `fake JDK ${entry.version} must be probed`)
    executables.push(executable)
  }
  return { root, manager, executables }
}

test('P10: architecture gate rejects arm64 on x64, allows x86 only up to Java 8', () => {
  assert.equal(archCompatible(record('21.0.1', 'arm64'), 'x64'), false)
  assert.equal(archCompatible(record('1.8.0_503', 'x86'), 'x64'), true)
  assert.equal(archCompatible(record('17.0.9', 'x86'), 'x64'), false)
  assert.equal(archCompatible(record('17.0.9', 'x64'), 'arm64'), true)

  const preference = getJavaPreference({
    minecraftVersion: '1.21',
    javaVersion: { majorVersion: 21 },
  })
  const selection = selectJavaRecord(
    [record('21.0.1', 'arm64'), record('17.0.9', 'x86')],
    preference,
    undefined,
    'x64',
  )
  assert.equal(selection.java, undefined)
  assert.equal(selection.quality, 'incompatible')
  assert.equal(selection.reason, 'java.arch-mismatch')
  assert.equal(selection.archMismatch, 2)
})

test('P10: NeoForge 1.20.1 gets the same Java 17 pin as Forge', async () => {
  const preference = getJavaPreference({
    minecraftVersion: '1.20.1',
    loader: 'neoforge',
    javaVersion: { majorVersion: 21 },
  })
  assert.equal(preference.requirement, '=17')
  assert.equal(preference.reason, 'java.neoforge-pin')

  const { manager } = await managerWith('p10-neoforge', [{ version: '17.0.15' }, { version: '21.0.7' }])
  const result = await manager.select({ minecraftVersion: '1.20.1', loader: 'neoforge' })
  assert.equal(result.java.majorVersion, 17)
  assert.equal(result.reason, 'java.exact-major')
})

test('P10: selection skips a vanished runtime and reports java.runtime-vanished', async () => {
  const { manager, executables } = await managerWith('p10-vanish', [
    { version: '17.0.15' },
    { version: '17.0.16' },
  ])
  const preferred = executables[0]
  fs.rmSync(preferred)
  const result = await manager.select({
    minecraftVersion: '1.20.1',
    javaVersion: { majorVersion: 17 },
    preferredPath: preferred,
  })
  assert.ok(result.java)
  assert.notEqual(result.java.path, preferred)
  assert.equal(result.reason, 'java.exact-major')
  assert.deepEqual(result.vanished, [preferred])
})

test('P10: offline without a candidate throws java.no-runtime and never fetches', async () => {
  let fetched = 0
  const { manager } = await managerWith('p10-offline', [{ version: '21.0.7' }], {
    isOnline: () => false,
    fetchImpl: async () => {
      fetched += 1
      throw new Error('network must not be used')
    },
  })
  await assert.rejects(
    manager.ensure({ minecraftVersion: '1.8.9', javaVersion: { majorVersion: 8 } }),
    (error) => error.code === 'java' && error.reason === 'java.no-runtime',
  )
  assert.equal(fetched, 0)
})

test('P10: a may-incompatible runtime is used offline without a download', async () => {
  let fetched = 0
  const { manager } = await managerWith('p10-maybe', [{ version: '11.0.20' }], {
    isOnline: () => false,
    fetchImpl: async () => {
      fetched += 1
      throw new Error('network must not be used')
    },
  })
  const ensured = await manager.ensure({
    minecraftVersion: '1.8.9',
    javaVersion: { majorVersion: 8 },
  })
  assert.equal(ensured.record.majorVersion, 11)
  assert.equal(ensured.selection.quality, 'may-incompatible')
  assert.equal(ensured.selection.reason, 'java.may-incompatible')
  assert.equal(fetched, 0)
})

test('P10: scan fingerprints skip unchanged runtimes on the second run', async () => {
  const root = tempDir('p10-scan')
  try {
    const first = fakeJdk(root, '17.0.15')
    const second = fakeJdk(root, '21.0.7')
    const manager = new JavaManager({
      file: path.join(root, 'java.json'),
      gameRoot: path.join(root, 'game'),
      logger: createNullLogger(),
      platform: 'linux',
      arch: 'x64',
      env: { APPDATA: path.join(root, 'empty') },
    })

    assert.ok(await javaFingerprint(first))
    const one = await manager.scan({ includeRegistry: false, extraPaths: [first, second] })
    assert.equal(one.probed, 2)
    assert.equal(one.skipped, 0)
    assert.equal(one.records.length, 2)
    assert.ok(one.records.every((entry) => entry.fingerprint))

    const two = await manager.scan({ includeRegistry: false, extraPaths: [first, second] })
    assert.equal(two.probed, 0)
    assert.equal(two.skipped, 2)
    assert.equal(two.added, 0)
    assert.equal(two.records.length, 2)
    assert.equal(new Set(two.records.map((entry) => entry.fingerprint)).size, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P10: resolvedJava memo stays relative to the game root', () => {
  const gameRoot = path.join('C:', 'Games', 'Bamboo')
  const inside = path.join(gameRoot, 'java', 'java-runtime-gamma', 'bin', 'java.exe')
  const relative = javaMemoRelativePath(gameRoot, inside)
  assert.equal(relative, 'java/java-runtime-gamma/bin/java.exe')
  assert.equal(javaMemoRelativePath(gameRoot, path.join('C:', 'Java', 'bin', 'java.exe')), undefined)

  const target = resolveJavaMemo(gameRoot, { major: 17, relativePath: relative, at: 1 })
  assert.equal(target.path, path.resolve(inside))
  assert.equal(target.major, 17)
  assert.equal(resolveJavaMemo(gameRoot, { major: 17, relativePath: '../escape', at: 1 }), undefined)
  assert.equal(resolveJavaMemo(gameRoot, { major: 17, relativePath: 'C:/Java/bin/java.exe', at: 1 }), undefined)
})

test('P10: launchInstance uses and then refreshes the resolvedJava memo', async () => {
  const base = tempDir('p10-core')
  try {
    const gameRoot = path.join(base, 'game')
    const instanceDirectory = path.join(gameRoot, 'instances', 'demo')
    const memoPath = path.join(gameRoot, 'java', 'java-runtime-gamma', 'bin', 'java.exe')
    fs.mkdirSync(path.dirname(memoPath), { recursive: true })
    fs.writeFileSync(memoPath, '')
    fs.mkdirSync(instanceDirectory, { recursive: true })

    const core = await createCore({
      appDataPath: base,
      legacyGameRoot: path.join(base, 'missing'),
      logger: createNullLogger(),
    })
    let captured
    let patch
    core.instanceManager = {
      get: async (id) => ({ instance: { id }, directory: instanceDirectory }),
      readFile: async () => ({
        id: 'inst-demo',
        name: 'Demo',
        version: '1.20.1',
        loader: 'vanilla',
        loaderVersion: '',
        javaPath: '',
        javaMode: 'auto',
        resolvedJava: { major: 17, relativePath: 'java/java-runtime-gamma/bin/java.exe', at: 1 },
        minMemory: 0,
        maxMemory: 4096,
        memoryMode: 'explicit',
      }),
      updateFile: async (_id, next) => {
        patch = next
        return next
      },
    }
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async (request) => {
        captured = request
        return {
          pid: 1234,
          plan: { javaPath: memoPath, javaMajorVersion: 17 },
          exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          launchId: 'launch-1',
        }
      },
    }

    await core.launchInstance({ instanceId: 'inst-demo' })
    assert.equal(captured.resolvedJavaPath, memoPath)
    assert.equal(captured.resolvedJavaMajor, 17)
    assert.equal(captured.javaPath, undefined)
    assert.deepEqual(patch, {
      resolvedJava: { major: 17, relativePath: 'java/java-runtime-gamma/bin/java.exe', at: patch.resolvedJava.at },
    })
    assert.ok(patch.resolvedJava.at > 1)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
