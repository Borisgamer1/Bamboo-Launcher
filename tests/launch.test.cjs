/**
 * Phase 5 tests: argument generation for legacy and modern versions (with
 * quoting/paths containing spaces), placeholder substitution, rules/features,
 * natives extraction with lock and cache, legacy asset links, spawn/watcher
 * and kill strategy, prechecks and the LaunchService java.ensure path.
 * No game is started; the spawn implementation is injected.
 */
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')
const AdmZip = require('adm-zip')

const { createNullLogger } = require('../dist-electron/logger.js')
const { resolveVersionModel } = require('../dist-electron/version/resolve.js')
const { LaunchTracker } = require('../dist-electron/launch-tracker.js')
const { JavaManager } = require('../dist-electron/java/manager.js')
const {
  formatArgument,
  quoteArgument,
  formatCommandLine,
  redactCommand,
  offlineUuid,
  supportsQuickPlay,
} = require('../dist-electron/launch/args.js')
const { prepareLaunch } = require('../dist-electron/launch/prepare.js')
const { resolveJvmPlan } = require('../dist-electron/launch/jvm.js')
const { prepareNatives } = require('../dist-electron/launch/natives.js')
const { linkLegacyAssets } = require('../dist-electron/launch/assets.js')
const { startLaunchProcess, resolveJavaExecutable } = require('../dist-electron/launch/process.js')
const { LaunchService } = require('../dist-electron/launch/service.js')
const fixtures = require('./fixtures/version-fixtures.cjs')

const WINDOWS = { name: 'windows', arch: 'x64', version: '10.0.19045' }

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function materializeFixtures(label = 'fixtures') {
  // A folder with a space proves the quoting path on every run.
  const gameRoot = path.join(tempDir(label), 'Bamboo Games')
  for (const [id, json] of Object.entries(fixtures.versions)) {
    writeJson(path.join(gameRoot, 'versions', id, `${id}.json`), json)
  }
  for (const [name, json] of Object.entries(fixtures.assets)) {
    writeJson(path.join(gameRoot, 'assets', 'indexes', name), json)
  }
  return gameRoot
}

function testJvm(overrides = {}) {
  const maxMemoryMb = overrides.maxMemoryMb ?? 0
  return resolveJvmPlan({
    memoryMode: overrides.memoryMode ?? (maxMemoryMb > 0 ? 'explicit' : 'auto'),
    minMemoryMb: overrides.minMemoryMb ?? 0,
    maxMemoryMb,
    jvmPreset: overrides.jvmPreset ?? 'auto',
    extraJvmArgs: overrides.extraJvmArgs ?? [],
    javaMajor: overrides.javaMajor ?? 17,
    javaArch: 'x64',
    modCount: 0,
    totalMemMb: Math.max(16384, maxMemoryMb + 2048),
    loader: 'vanilla',
    ...overrides,
  })
}

function account(overrides = {}) {
  return {
    name: 'Steve',
    uuid: '11112222333344445555666677778888',
    accessToken: 'super-secret-token',
    type: 'offline',
    ...overrides,
  }
}

async function planFor(gameRoot, versionId, extra = {}) {
  const model = await resolveVersionModel(gameRoot, versionId, { logger: createNullLogger() })
  return prepareLaunch({
    gameRoot,
    versionId,
    model,
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
    javaPath: 'C:\\Program Files\\Java\\jre1.8.0_503\\bin\\java.exe',
    account: account(),
    jvm: testJvm(extra),
    platform: WINDOWS,
    extractNatives: false,
    linkLegacyAssets: false,
    logger: createNullLogger(),
    ...extra,
  })
}

function createFakeJdk(root, version) {
  const home = path.join(root, `jdk-${version}`)
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  const executable = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  fs.writeFileSync(executable, '')
  fs.writeFileSync(
    path.join(home, 'release'),
    `JAVA_VERSION="${version}"\nOS_ARCH="amd64"\nIMPLEMENTOR="Eclipse Adoptium"\n`,
    'utf8',
  )
  return executable
}

test('format/quote helpers substitute placeholders and mask tokens', () => {
  assert.equal(formatArgument('--username ${auth_player_name}', { auth_player_name: 'Steve' }), '--username Steve')
  assert.equal(formatArgument('--xuid ${auth_xuid}', { auth_xuid: '' }), '--xuid ')
  assert.equal(formatArgument('${unknown_thing}', {}), '${unknown_thing}')
  assert.equal(quoteArgument('plain'), 'plain')
  assert.equal(quoteArgument('C:\\Program Files\\x.jar'), '"C:\\Program Files\\x.jar"')
  assert.equal(formatCommandLine(['cmd', 'C:\\a b\\c']), 'cmd "C:\\a b\\c"')
  assert.deepEqual(
    redactCommand(['java', '--accessToken', 'secret', '--username', 'Steve']),
    ['java', '--accessToken', '****', '--username', 'Steve'],
  )
  assert.equal(offlineUuid('Steve').length, 32)
  assert.equal(offlineUuid('Steve'), offlineUuid('Steve'))
  assert.equal(supportsQuickPlay('1.20.1'), true)
  assert.equal(supportsQuickPlay('1.20'), true)
  assert.equal(supportsQuickPlay('1.19.4'), false)
  assert.equal(supportsQuickPlay('1.8.9'), false)
  assert.equal(supportsQuickPlay('25w14a'), false)
})

test('legacy 1.8.9 builds minecraftArguments with classpath, natives and legacy user type', async () => {
  const gameRoot = materializeFixtures('legacy')
  const plan = await planFor(gameRoot, '1.8.9', {
    minMemoryMb: 512,
    maxMemoryMb: 2048,
    versionType: 'release',
  })
  const command = plan.command
  const classpath = command[command.indexOf('-cp') + 1]
  assert.equal(command[0], 'C:\\Program Files\\Java\\jre1.8.0_503\\bin\\java.exe')
  assert.ok(command.includes('-Xms512M'))
  assert.ok(command.includes('-Xmx2048M'))
  assert.ok(command.includes('-Djava.library.path=' + plan.natives.directory.replace(/\\/g, '/')))
  assert.ok(classpath.includes('libraries/com/mojang/netty/1.6.1/netty-1.6.1.jar'))
  assert.ok(classpath.includes('/versions/1.8.9/1.8.9.jar'))
  assert.ok(classpath.includes(';'), 'Windows classpath separator')
  assert.ok(command.includes('net.minecraft.client.main.Main'))
  assert.ok(command.includes('--username') && command.includes('Steve'))
  assert.ok(command.includes('--accessToken') && command.includes('super-secret-token'))
  assert.ok(command.includes('--version') && command.includes('1.8.9'))
  assert.ok(command.includes('--assetIndex') && command.includes('1.8'))
  assert.ok(command.includes('--userType') && command.includes('legacy'))
  assert.ok(!command.includes('--clientId'), 'legacy versions do not get clientId')
  assert.ok(
    formatCommandLine(plan.displayCommand).includes('"') &&
      formatCommandLine(plan.displayCommand).includes('Bamboo Games'),
    'paths with spaces must be quoted in the display command',
  )
  assert.ok(!plan.displayCommand.join(' ').includes('super-secret-token'), 'display command must mask the token')
  assert.ok(plan.displayCommand.join(' ').includes('--accessToken ****'))
})

test('modern 1.20.1 evaluates rules/features and gates quickPlay by version', async () => {
  const gameRoot = materializeFixtures('modern')
  const withResolution = await planFor(gameRoot, '1.20.1', {
    resolution: { width: 1280, height: 720 },
    server: { host: 'mc.example.net', port: 25566 },
  })
  assert.ok(withResolution.command.includes('--width') && withResolution.command.includes('1280'))
  assert.ok(withResolution.command.includes('--height') && withResolution.command.includes('720'))
  assert.ok(withResolution.command.includes('--quickPlayMultiplayer'))
  assert.ok(withResolution.command.includes('mc.example.net:25566'))
  assert.ok(!withResolution.command.includes('-XstartOnFirstThread'), 'macOS-only rule must be dropped on Windows')
  assert.ok(withResolution.command.includes('-Dos.name=Windows 10'), 'Windows rule must be applied')

  const withoutResolution = await planFor(gameRoot, '1.20.1')
  assert.ok(!withoutResolution.command.includes('--width'), 'feature-gated args must disappear without the feature')
  assert.ok(!withoutResolution.command.includes('--quickPlayMultiplayer'))

  const legacyQuickPlay = await planFor(gameRoot, '1.8.9', { server: { host: 'mc.example.net', port: 25567 } })
  assert.ok(legacyQuickPlay.command.includes('--server') && legacyQuickPlay.command.includes('mc.example.net'))
  assert.ok(legacyQuickPlay.command.includes('--port') && legacyQuickPlay.command.includes('25567'))
  assert.ok(!legacyQuickPlay.command.includes('--quickPlayMultiplayer'))

  // `${user_type}` follows the account: Microsoft accounts are `msa`.
  writeJson(path.join(gameRoot, 'versions', 'usertype-probe', 'usertype-probe.json'), {
    id: 'usertype-probe',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --userType ${user_type}',
    assets: '5',
    libraries: [],
  })
  const msAccount = await planFor(gameRoot, 'usertype-probe', {
    account: account({ type: 'microsoft' }),
  })
  assert.ok(msAccount.command.includes('--userType') && msAccount.command.includes('msa'))
})

test('natives are extracted once, honour excludes and strip platform folders', async () => {
  const gameRoot = materializeFixtures('natives')
  const model = await resolveVersionModel(gameRoot, '1.8.9', { logger: createNullLogger() })
  const nativeLibrary = model.natives.find((library) => library.name.includes('lwjgl-platform'))
  assert.ok(nativeLibrary, 'fixture must resolve a native library')
  fs.mkdirSync(path.dirname(nativeLibrary.absolutePath), { recursive: true })
  const zip = new AdmZip()
  zip.addFile('lwjgl.dll', Buffer.from('fake-dll'))
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('manifest'))
  zip.addFile('windows/x64/opengl32.dll', Buffer.from('fake-opengl'))
  zip.writeZip(nativeLibrary.absolutePath)

  const first = await prepareNatives(model, { logger: createNullLogger() })
  assert.equal(first.cacheHit, false)
  assert.equal(first.extracted, 2)
  assert.equal(fs.readFileSync(path.join(first.directory, 'lwjgl.dll'), 'utf8'), 'fake-dll')
  assert.equal(fs.readFileSync(path.join(first.directory, 'opengl32.dll'), 'utf8'), 'fake-opengl')
  assert.equal(fs.existsSync(path.join(first.directory, 'META-INF')), false)
  assert.equal(fs.existsSync(`${first.directory}.json`), true, 'cache file must exist')
  assert.equal(fs.existsSync(`${first.directory}.lock`), false, 'lock must be released')

  const second = await prepareNatives(model, { logger: createNullLogger() })
  assert.equal(second.cacheHit, true)
  assert.equal(second.extracted, 0)

  fs.writeFileSync(path.join(first.directory, 'lwjgl.dll'), 'corrupted')
  const repaired = await prepareNatives(model, { logger: createNullLogger() })
  assert.equal(repaired.cacheHit, false)
  assert.equal(fs.readFileSync(path.join(first.directory, 'lwjgl.dll'), 'utf8'), 'fake-dll')
})

test('legacy asset indexes get a hardlinked virtual tree', async () => {
  const gameRoot = materializeFixtures('assets')
  const model = await resolveVersionModel(gameRoot, '1.6.4', { logger: createNullLogger() })
  assert.equal(model.assets.legacyVirtual, true)
  for (const object of model.assets.objects) {
    fs.mkdirSync(path.dirname(object.absolutePath), { recursive: true })
    fs.writeFileSync(object.absolutePath, `object-${object.name}`)
  }

  const dry = await linkLegacyAssets(model, { dryRun: true })
  assert.equal(dry.candidates, model.assets.objects.length)
  assert.equal(dry.linked, 0)

  const linked = await linkLegacyAssets(model)
  assert.equal(linked.linked, model.assets.objects.length)
  assert.equal(
    fs.readFileSync(path.join(linked.directory, 'sound', 'click.ogg'), 'utf8'),
    'object-sound/click.ogg',
  )
  const second = await linkLegacyAssets(model)
  assert.equal(second.linked, 0)
  assert.equal(second.skipped, model.assets.objects.length)
})

test('spawn uses javaw, detached cwd and the taskkill kill hook', async () => {
  const gameRoot = materializeFixtures('spawn')
  const plan = await planFor(gameRoot, '1.20.1', {
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
  })
  const javaDir = path.join(gameRoot, 'java', 'bin')
  fs.mkdirSync(javaDir, { recursive: true })
  const javaExe = path.join(javaDir, 'java.exe')
  const javawExe = path.join(javaDir, 'javaw.exe')
  fs.writeFileSync(javaExe, '')
  fs.writeFileSync(javawExe, '')
  plan.command[0] = javaExe
  plan.displayCommand[0] = javaExe
  assert.equal(resolveJavaExecutable(javaExe, 'win32'), javawExe)
  assert.equal(resolveJavaExecutable(javaExe, 'linux'), javaExe)

  const spawns = []
  const events = []
  let killedPid
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.unref = () => undefined
    spawns.push({ command, args, options, child })
    return child
  }
  const handle = startLaunchProcess({
    plan,
    // The javaw naming is a Windows rule; assert it on every host.
    platform: 'win32',
    spawnImpl,
    killImpl: async (pid) => {
      killedPid = pid
    },
    onEvent: (event) => events.push(event),
    logger: createNullLogger(),
  })
  assert.equal(handle.pid, 4242)
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].command, javawExe)
  assert.equal(spawns[0].options.detached, true)
  assert.equal(spawns[0].options.cwd, plan.gameDirectory)
  assert.ok(spawns[0].args.includes('net.minecraft.client.main.Main'))

  await handle.kill()
  assert.equal(killedPid, 4242)
  assert.equal(handle.killed, true)

  // Feed ready marker + crash report path, then let the fake process exit.
  const fake = spawns[0].child
  fake.stdout.emit('data', Buffer.from('LWJGL Version: 3.3.1\n'))
  fake.stderr.emit('data', Buffer.from('Crash report saved to: C:\\crash-reports\\crash-1.txt\n'))
  fake.emit('close', 0, null)
  const exit = await handle.exit
  assert.equal(exit.code, 0)
  assert.equal(exit.crashReport, 'C:\\crash-reports\\crash-1.txt')
  assert.ok(events.some((event) => event.type === 'ready'))
  assert.ok(events.some((event) => event.type === 'crash-report'))
  assert.ok(events.some((event) => event.type === 'exit'))
})

test('LaunchService resolves java via ensure, prechecks and tracks the launch', async () => {
  const gameRoot = materializeFixtures('service')
  const storeRoot = tempDir('service-store')
  const jdk = createFakeJdk(storeRoot, '17.0.15')
  const java = new JavaManager({
    file: path.join(storeRoot, 'java.json'),
    gameRoot,
    logger: createNullLogger(),
    platform: 'win32',
    arch: 'x64',
  })
  const record = await java.test(jdk)
  assert.ok(record, 'fake JDK must be recognized')

  const launches = new LaunchTracker(createNullLogger())
  const service = new LaunchService({
    gameRoot: () => gameRoot,
    cacheDir: path.join(storeRoot, 'cache'),
    java,
    launches,
    logger: createNullLogger(),
    totalMemMb: () => 8192,
  })

  // A missing client jar is a fatal precheck before any spawn attempt.
  await assert.rejects(
    () =>
      service.start({
        versionId: '1.20.1',
        gameDirectory: gameRoot,
        account: account({ type: 'microsoft' }),
        extractNatives: false,
        track: false,
        spawnImpl: () => {
          throw new Error('spawn must not be reached')
        },
      }),
    (error) => error.code === 'precheck',
  )

  fs.mkdirSync(path.join(gameRoot, 'versions', '1.20.1'), { recursive: true })
  fs.writeFileSync(path.join(gameRoot, 'versions', '1.20.1', '1.20.1.jar'), 'client')

  // Prechecks require every library/native archive on disk, so materialize the
  // fixtures the same way the phase 4 installer would.
  const model = await resolveVersionModel(gameRoot, '1.20.1', { logger: createNullLogger() })
  for (const library of model.libraries) {
    if (library.isNative) continue
    fs.mkdirSync(path.dirname(library.absolutePath), { recursive: true })
    fs.writeFileSync(library.absolutePath, 'library')
  }
  for (const native of model.natives) {
    fs.mkdirSync(path.dirname(native.absolutePath), { recursive: true })
    fs.writeFileSync(native.absolutePath, 'native')
  }

  const prepared = await service.prepare({
    versionId: '1.20.1',
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
    account: account({ type: 'microsoft' }),
    extractNatives: false,
  })
  assert.equal(prepared.java.source, 'matched')
  assert.equal(prepared.java.majorVersion, 17)
  assert.equal(prepared.java.path, jdk)
  assert.equal(prepared.plan.precheck.librariesMissing.length, 0)
  assert.ok(prepared.plan.jvm, 'P13: every plan carries the resolved JVM plan')
  assert.equal(prepared.plan.jvm.presetId, 'vanilla-balanced')
  assert.equal(prepared.plan.jvm.heapMb, 4096, '8 GB host → 4096 MB heap')
  assert.equal(prepared.plan.jvm.xmsMb, 2048)
  const xmx = prepared.plan.command.filter((argument) => argument.startsWith('-Xmx'))
  assert.equal(xmx.length, 1, 'exactly one -Xmx is generated')
  assert.equal(xmx[0], `-Xmx${prepared.plan.jvm.heapMb}M`)
  assert.ok(prepared.plan.command.includes('net.minecraft.client.main.Main'))
  assert.ok(prepared.plan.command.includes('Steve'))
  assert.ok(!prepared.plan.displayCommand.join(' ').includes('super-secret-token'))
  assert.equal(launches.activeCount, 0)

  const modded = await service.prepare({
    versionId: '1.20.1',
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
    account: account({ type: 'microsoft' }),
    extractNatives: false,
    loader: 'fabric',
    memoryMode: 'explicit',
    maxMemoryMb: 4096,
    jvmPreset: 'modded-aikar',
  })
  assert.equal(modded.plan.jvm.presetId, 'modded-aikar')
  assert.equal(modded.plan.command.filter((argument) => argument.startsWith('-Xmx')).length, 1)
  assert.ok(modded.plan.command.includes('-Xmx4096M'))
  assert.ok(modded.plan.command.includes('-XX:+ParallelRefProcEnabled'))

  const spawnImpl = () => {
    const fake = new EventEmitter()
    fake.pid = 5151
    fake.stdout = new EventEmitter()
    fake.stderr = new EventEmitter()
    fake.unref = () => undefined
    setTimeout(() => fake.emit('close', 0, null), 5)
    return fake
  }
  const handle = await service.start({
    versionId: '1.20.1',
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
    account: account({ type: 'microsoft' }),
    extractNatives: false,
    spawnImpl,
    killImpl: async () => undefined,
  })
  assert.equal(handle.pid, 5151)
  assert.ok(handle.launchId, 'launch telemetry must produce an id')
  assert.equal(launches.activeCount, 1)
  const exit = await handle.exit
  assert.equal(exit.code, 0)
  assert.equal(launches.activeCount, 0, 'tracker finishes on exit')

  // A profile-selected runtime that does not satisfy the version is rejected.
  await assert.rejects(
    () =>
      service.start({
        versionId: '1.8.9',
        gameDirectory: gameRoot,
        account: account(),
        javaPath: jdk,
        extractNatives: false,
        track: false,
        spawnImpl: () => {
          throw new Error('spawn must not be reached')
        },
      }),
    (error) => error.code === 'java-invalid' && /benötigt =8/.test(error.message),
  )

  // A missing library is a fatal precheck, not a launch that dies later.
  const victim = model.libraries.find((library) => !library.isNative)
  assert.ok(victim)
  fs.rmSync(victim.absolutePath)
  await assert.rejects(
    () =>
      service.start({
        versionId: '1.20.1',
        gameDirectory: gameRoot,
        account: account({ type: 'microsoft' }),
        extractNatives: false,
        track: false,
        spawnImpl: () => {
          throw new Error('spawn must not be reached')
        },
      }),
    (error) => error.code === 'precheck' && /Bibliothek/.test(error.message),
  )
})

test('dry runs never unpack or link anything', async () => {
  const gameRoot = materializeFixtures('dryrun')
  const model = await resolveVersionModel(gameRoot, '1.6.4', { logger: createNullLogger() })
  const plan = await prepareLaunch({
    gameRoot,
    versionId: '1.6.4',
    model,
    gameDirectory: gameRoot,
    javaPath: 'java',
    account: account(),
    jvm: testJvm(),
    platform: WINDOWS,
    extractNatives: false,
    linkLegacyAssets: false,
  })
  assert.equal(plan.natives.extracted, 0)
  assert.equal(plan.legacyAssets.linked, 0)
  assert.equal(plan.legacyAssets.candidates, model.assets.objects.length)
  assert.equal(fs.existsSync(model.assets.virtualDir), false, 'dry run must not create the virtual tree')
})

test('a vanished version JSON is reinstalled by the repair path before the launch', async () => {
  const gameRoot = materializeFixtures('missing-version')
  const storeRoot = tempDir('missing-version-store')
  const versionFile = path.join(gameRoot, 'versions', '1.20.1', '1.20.1.json')
  const versionJson = fs.readFileSync(versionFile, 'utf8')

  // Materialize everything the precheck looks at, then drop only the version JSON.
  const model = await resolveVersionModel(gameRoot, '1.20.1', { logger: createNullLogger() })
  fs.mkdirSync(path.dirname(model.clientJar), { recursive: true })
  fs.writeFileSync(model.clientJar, 'client')
  for (const library of model.libraries) {
    if (library.isNative) continue
    fs.mkdirSync(path.dirname(library.absolutePath), { recursive: true })
    fs.writeFileSync(library.absolutePath, 'library')
  }
  for (const native of model.natives) {
    fs.mkdirSync(path.dirname(native.absolutePath), { recursive: true })
    fs.writeFileSync(native.absolutePath, 'native')
  }
  fs.rmSync(versionFile)

  const jdk = createFakeJdk(storeRoot, '17.0.15')
  const java = new JavaManager({
    file: path.join(storeRoot, 'java.json'),
    gameRoot,
    logger: createNullLogger(),
    platform: 'win32',
    arch: 'x64',
  })
  assert.ok(await java.test(jdk), 'fake JDK must be recognized')

  const installed = []
  const service = new LaunchService({
    gameRoot: () => gameRoot,
    cacheDir: path.join(storeRoot, 'cache'),
    java,
    launches: new LaunchTracker(createNullLogger()),
    logger: createNullLogger(),
    totalMemMb: () => 8192,
    installImpl: async (root, versionId) => {
      installed.push({ root, versionId })
      fs.writeFileSync(versionFile, versionJson)
      return { versionJsonDownloaded: true }
    },
  })

  const request = {
    versionId: '1.20.1',
    gameDirectory: path.join(gameRoot, 'profiles', 'My Pack'),
    account: account({ type: 'microsoft' }),
    extractNatives: false,
    track: false,
  }
  const spawnImpl = () => {
    throw new Error('spawn must not be reached')
  }

  // Without the repair flag the missing JSON stays a hard resolve error.
  await assert.rejects(
    () => service.start({ ...request, spawnImpl }),
    (error) => error.code === 'missing-version' && /1\.20\.1\.json/.test(error.message),
  )
  assert.deepEqual(installed, [], 'no install without repairMissing')

  // With repairMissing the install engine restores the JSON and the launch runs.
  const events = []
  const fakeProcess = () => {
    const fake = new EventEmitter()
    fake.pid = 9090
    fake.stdout = new EventEmitter()
    fake.stderr = new EventEmitter()
    fake.unref = () => undefined
    setTimeout(() => fake.emit('close', 0, null), 5)
    return fake
  }
  const handle = await service.start({
    ...request,
    repairMissing: true,
    onEvent: (event) => events.push(event),
    spawnImpl: fakeProcess,
    killImpl: async () => undefined,
  })
  assert.equal(installed.length, 1, 'the install engine is consulted exactly once')
  assert.equal(installed[0].versionId, '1.20.1', 'the vanished version ID is reinstalled')
  assert.ok(
    events.some((event) => event.type === 'status' && /1\.20\.1/.test(event.message)),
    'the repair is reported to the UI',
  )
  assert.equal(handle.pid, 9090)
  const exit = await handle.exit
  assert.equal(exit.code, 0)
  assert.equal(fs.existsSync(versionFile), true)
})
