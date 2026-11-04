/**
 * P13 JVM presets and heap policy (spec §5.2–§5.5).
 *
 * The resolver is pure: every case supplies the Java record fields, the mod
 * count and the host memory. The last test checks the instance > settings
 * precedence at the real `LauncherCore.launchInstance()` seam.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const { createCore } = require('../dist-electron/core.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { InstanceFileSchema, SettingsSchema } = require('../dist-electron/schemas.js')
const { JVM_PRESETS, JVM_PRESET_IDS } = require('../dist-electron/launch/presets.js')
const {
  JVM_REASON_CODES,
  jvmReasonRank,
  mergeJvmArguments,
  resolveJvmPlan,
  resolveJvmPreferences,
} = require('../dist-electron/launch/jvm.js')
const { buildLaunchCommand } = require('../dist-electron/launch/args.js')
const launchArgs = require('../dist-electron/launch/args.js')
const { prepareLaunch } = require('../dist-electron/launch/prepare.js')
const { LaunchTracker } = require('../dist-electron/launch-tracker.js')
const { TelemetryService } = require('../dist-electron/telemetry.js')

function input(overrides = {}) {
  return {
    memoryMode: 'auto',
    minMemoryMb: 0,
    maxMemoryMb: 0,
    javaMajor: 21,
    javaArch: 'x64',
    javaVendor: 'Eclipse Adoptium',
    jvmPreset: 'auto',
    extraJvmArgs: [],
    modCount: 0,
    totalMemMb: 16384,
    loader: 'vanilla',
    ...overrides,
  }
}

function plan(overrides = {}) {
  return resolveJvmPlan(input(overrides))
}

function hasArgs(args, expected) {
  for (const argument of expected) assert.ok(args.includes(argument), `missing ${argument}`)
}

const WINDOWS = { name: 'windows', arch: 'x64', version: '10.0.19045' }

function fakeModel(jvmArgs) {
  return {
    id: '1.20.1',
    minecraftVersion: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    libraries: [],
    clientJar: 'C:\\game\\versions\\1.20.1\\1.20.1.jar',
    natives: [],
    nativeDirectory: 'C:\\game\\natives',
    assets: { id: '1.20', count: 0, objects: [], available: false },
    arguments: { jvm: jvmArgs, game: ['--username', '${auth_player_name}'] },
  }
}

function commandFor(jvm, jvmArgs, logger) {
  return buildLaunchCommand({
    gameRoot: 'C:\\game',
    versionId: '1.20.1',
    model: fakeModel(jvmArgs),
    gameDirectory: 'C:\\game',
    javaPath: 'java',
    account: { name: 'Steve', uuid: '1', type: 'offline' },
    platform: WINDOWS,
    extractNatives: false,
    linkLegacyAssets: false,
    jvm,
    ...(logger ? { logger } : {}),
  })
}

function recordingLogger() {
  const records = []
  const logger = {
    debug: (message, data) => records.push({ message, data }),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  }
  return { logger, records }
}

test('P13 presets are exact and contain no client-hostile Aikar flags', () => {
  assert.deepEqual([...JVM_PRESET_IDS], ['vanilla-balanced', 'modded-aikar', 'low-latency-zgc', 'custom'])
  assert.deepEqual([...JVM_PRESETS['vanilla-balanced'].args], [
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:MaxGCPauseMillis=50',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapRegionSize=32M',
  ])
  assert.deepEqual([...JVM_PRESETS['modded-aikar'].args], [
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:MaxTenuringThreshold=1',
  ])
  assert.deepEqual([...JVM_PRESETS['low-latency-zgc'].args], ['-XX:+UseZGC'])
  assert.deepEqual([...JVM_PRESETS.custom.args], [])

  const all = JVM_PRESET_IDS.flatMap((id) => [...JVM_PRESETS[id].args]).join(' ')
  for (const forbidden of ['AlwaysPreTouch', 'PerfDisableSharedMem', 'DisableExplicitGC', 'using.aikars.flags']) {
    assert.equal(all.includes(forbidden), false, forbidden)
  }
})

test('P13 main.js no longer derives RAM and delegates JVM to launchInstance', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.equal(source.includes('const ramMb ='), false)
  assert.equal(source.includes('resolveJvmPreferences'), false)
  assert.equal(source.includes('core.launch.start'), false)
  assert.ok(source.includes('launchLegacyInstance(core'))
})

test('P13 auto selects balanced for vanilla, Aikar for mods/loaders, never ZGC', () => {
  assert.equal(plan({ modCount: 0 }).presetId, 'vanilla-balanced')
  assert.equal(plan({ modCount: 20 }).presetId, 'modded-aikar')
  assert.equal(plan({ modCount: 0, loader: 'fabric' }).presetId, 'modded-aikar')
  assert.equal(plan({ modCount: 0, loader: 'vanilla', totalMemMb: 65536 }).presetId, 'vanilla-balanced')
  assert.ok(plan({ modCount: 0 }).downgrades.includes('jvm.preset-auto'))
})

test('P13 guard rails cascade one step at a time with stable reasons', () => {
  const java8Aikar = plan({
    jvmPreset: 'modded-aikar',
    javaMajor: 8,
    memoryMode: 'explicit',
    maxMemoryMb: 4096,
  })
  assert.equal(java8Aikar.presetId, 'vanilla-balanced')
  assert.ok(java8Aikar.downgrades.includes('jvm.downgrade-java'))
  assert.equal(java8Aikar.args.includes('-XX:+ParallelRefProcEnabled'), false)

  const lowHeapAikar = plan({
    jvmPreset: 'modded-aikar',
    javaMajor: 17,
    memoryMode: 'explicit',
    maxMemoryMb: 3072,
  })
  assert.equal(lowHeapAikar.presetId, 'vanilla-balanced')
  assert.ok(lowHeapAikar.downgrades.includes('jvm.downgrade-low-heap'))

  const zgcLowHeap = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 21, totalMemMb: 12288 })
  assert.equal(zgcLowHeap.presetId, 'modded-aikar')
  assert.ok(zgcLowHeap.downgrades.includes('jvm.downgrade-low-heap'))
  assert.equal(zgcLowHeap.args.includes('-XX:+UseZGC'), false)

  const zgcJava17 = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 17 })
  assert.equal(zgcJava17.presetId, 'modded-aikar')
  assert.ok(zgcJava17.downgrades.includes('jvm.downgrade-java'))

  const openj9 = plan({ jvmPreset: 'modded-aikar', javaVendor: 'IBM Semeru' })
  assert.equal(openj9.presetId, 'custom')
  assert.ok(openj9.downgrades.includes('jvm.downgrade-openj9'))
  assert.equal(openj9.args.some((argument) => argument.startsWith('-XX:')), false)
  assert.equal(openj9.args.includes('-Xmx8192M'), true)

  const custom = plan({ jvmPreset: 'custom' })
  assert.equal(custom.presetId, 'custom')
  assert.ok(custom.downgrades.includes('jvm.preset-explicit'))
  assert.equal(custom.args.some((argument) => argument.startsWith('-XX:')), false)
})

test('P13 ZGC adds ZGenerational only on Java 21–22', () => {
  const java21 = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 21 })
  assert.equal(java21.presetId, 'low-latency-zgc')
  hasArgs(java21.args, ['-XX:+UseZGC', '-XX:+ZGenerational'])

  const java22 = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 22 })
  assert.ok(java22.args.includes('-XX:+ZGenerational'))

  const java23 = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 23 })
  assert.equal(java23.args.includes('-XX:+ZGenerational'), false)

  const java25 = plan({ jvmPreset: 'low-latency-zgc', javaMajor: 25 })
  assert.equal(java25.args.includes('-XX:+ZGenerational'), false)
})

test('P13 heap formula covers 8/12/16/32/4 GB and respects the 32-bit cap', () => {
  const cases = [
    [8192, 4096],
    [12288, 6144],
    [16384, 8192],
    [32768, 8192],
    [4096, 1536],
  ]
  for (const [totalMemMb, expected] of cases) {
    const resolved = plan({ totalMemMb, modCount: 0 })
    assert.equal(resolved.heapMb, expected, `${totalMemMb} MB host`)
    assert.equal(resolved.xmsMb, Math.min(2048, expected))
  }

  const x86 = plan({
    memoryMode: 'explicit',
    maxMemoryMb: 4096,
    javaArch: 'x86',
    totalMemMb: 65536,
  })
  assert.equal(x86.heapMb, 1400)
  assert.equal(x86.xmsMb, 1400)
  assert.ok(x86.downgrades.includes('jvm.heap-32bit'))
})

test('P13 explicit heap, user -Xmx and -Xms rules are clamped and ordered', () => {
  const eightGb = plan({ memoryMode: 'explicit', maxMemoryMb: 12288, totalMemMb: 8192 })
  assert.equal(eightGb.heapMb, 6144)
  assert.ok(eightGb.downgrades.includes('jvm.heap-clamped'))

  const userXmx = plan({ extraJvmArgs: ['-Xmx12G'], totalMemMb: 8192 })
  assert.equal(userXmx.heapMb, 6144)
  assert.equal(userXmx.args.filter((argument) => argument.startsWith('-Xmx')).length, 1)
  assert.equal(userXmx.args.includes('-Xmx6144M'), true)
  assert.equal(userXmx.downgrades.includes('jvm.arg-dropped'), false)

  const explicit = plan({
    memoryMode: 'explicit',
    minMemoryMb: 512,
    maxMemoryMb: 2048,
    totalMemMb: 16384,
  })
  assert.equal(explicit.xmsMb, 512)
  assert.ok(explicit.args.indexOf('-Xms512M') < explicit.args.indexOf('-Xmx2048M'))

  const aikar = plan({
    jvmPreset: 'modded-aikar',
    memoryMode: 'explicit',
    maxMemoryMb: 4096,
    totalMemMb: 16384,
  })
  // Explicit mode keeps the existing `minMemory` policy; auto Aikar pins Xms.
  assert.equal(aikar.xmsMb, 2048)
  const aikarAuto = plan({ jvmPreset: 'modded-aikar', totalMemMb: 16384 })
  assert.equal(aikarAuto.xmsMb, aikarAuto.heapMb)

  const customXms = plan({ jvmPreset: 'custom', extraJvmArgs: ['-Xms1024M'] })
  assert.equal(customXms.xmsMb, 1024)
  assert.ok(customXms.args.includes('-Xms1024M'))

  const customNoXms = plan({ jvmPreset: 'custom' })
  assert.equal(customNoXms.xmsMb, 0)
  assert.equal(customNoXms.args.some((argument) => argument.startsWith('-Xms')), false)
})

test('P13 merge drops duplicate keys, separate heap forms and G1 under ZGC', () => {
  const merged = mergeJvmArguments(
    ['-Xmx8192M', '-Xms2048M', '-XX:+UseZGC'],
    ['-Xmx4G', '-Dfoo=bar', '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50'],
  )
  assert.deepEqual(merged.args, ['-Xms2048M', '-Xmx8192M', '-XX:+UseZGC', '-Dfoo=bar'])
  assert.equal(merged.dropped.includes('-Xmx4G'), true)
  assert.equal(merged.dropped.includes('-XX:+UseG1GC'), true)
  assert.equal(merged.dropped.includes('-XX:MaxGCPauseMillis=50'), true)

  const classpath = mergeJvmArguments(['-cp', 'one.jar'], ['-cp', 'two.jar', '-Dfoo=bar'])
  assert.deepEqual(classpath.args, ['-cp', 'one.jar', '-Dfoo=bar'])
  assert.equal(classpath.dropped.includes('two.jar'), true)

  const invalid = plan({
    jvmPreset: 'custom',
    extraJvmArgs: ['-Xmx', '4G', '-Dfoo=bar'],
  })
  assert.equal(invalid.args.includes('-Xmx'), false)
  assert.equal(invalid.args.includes('4G'), false)
  assert.ok(invalid.downgrades.includes('jvm.arg-dropped'))
})

test('P13 version JSON loses collector conflicts to the plan', () => {
  const jvm = resolveJvmPlan(input({ jvmPreset: 'vanilla-balanced', javaMajor: 21 }))
  const built = commandFor(jvm, ['-XX:+UseZGC', '-XX:+ZGenerational'])
  const collectors = built.command.filter((argument) =>
    /UseZGC|UseG1GC|ZGenerational|MaxGCPauseMillis/.test(argument),
  )
  assert.ok(collectors.includes('-XX:+UseG1GC'))
  assert.equal(collectors.includes('-XX:+UseZGC'), false)
  assert.equal(collectors.includes('-XX:+ZGenerational'), false)
  assert.equal(built.command.filter((argument) => argument.startsWith('-Xmx')).length, 1)
})

test('P13 merged JVM arguments keep the order the JVM demands', () => {
  // Regression: a sorted merge moved -XX:+UnlockExperimentalVMOptions behind
  // -XX:G1NewSizePercent, and the JVM refused to start ("Could not create the
  // Java Virtual Machine") instead of launching Minecraft.
  const jvm = resolveJvmPlan(input({ jvmPreset: 'vanilla-balanced', javaMajor: 21 }))
  const built = commandFor(jvm, [
    '-Djava.library.path=C:\\game\\natives',
    '-XX:HeapDumpPath=heapdump',
    '-XX:StackShadowPages=32',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
  ])
  const unlock = built.command.indexOf('-XX:+UnlockExperimentalVMOptions')
  const experimental = built.command.indexOf('-XX:G1NewSizePercent=20')
  assert.ok(unlock > 0, 'UnlockExperimentalVMOptions must survive the merge')
  assert.ok(experimental > 0, 'the experimental G1 flag must survive the merge')
  assert.ok(unlock < experimental, 'Unlock must precede the experimental option')

  // Heap first, everything else keeps the order of plan and version JSON.
  assert.equal(built.command[1], '-Xms2048M')
  assert.equal(built.command[2], '-Xmx8192M')
  assert.ok(built.command.indexOf('-Djava.library.path=C:\\game\\natives') < built.command.indexOf('-XX:StackShadowPages=32'))
})

test('P13 custom without Xms strips version-JSON -Xms from the command', () => {
  const jvm = resolveJvmPlan(input({ jvmPreset: 'custom', extraJvmArgs: ['-Dfoo=bar'] }))
  assert.equal(jvm.xmsMb, 0)
  const built = commandFor(jvm, ['-Xms2048M'])
  assert.equal(built.command.some((argument) => argument.startsWith('-Xms')), false)
  assert.ok(built.command.includes('-Dfoo=bar'))
})

test('P13 jvm.arg-dropped logs the argument with its source', () => {
  const { logger, records } = recordingLogger()
  const jvm = resolveJvmPlan(input({ jvmPreset: 'vanilla-balanced' }))
  commandFor(jvm, ['-Xmx4G', '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50'], logger)
  const dropped = records.filter((record) => record.message === 'jvm.arg-dropped')
  assert.ok(dropped.some((record) => record.data.argument === '-Xmx4G' && record.data.source === 'version-json'))
  assert.ok(dropped.some((record) => record.data.argument === '-XX:+UseG1GC' && record.data.source === 'version-json'))
  assert.ok(dropped.every((record) => typeof record.data.source === 'string'))
})

test('P13 launch telemetry persists preset, heap and downgrades', async (context) => {
  const dir = tempDir('p13-telemetry')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'telemetry.json')
  const service = new TelemetryService(file, { enabled: true })
  const tracker = new LaunchTracker(createNullLogger(), service)
  const base = {
    version: '1.20.1',
    instancePath: 'instance',
    javaPath: 'java',
    jvm: { presetId: 'modded-aikar', heapMb: 4096, downgrades: ['jvm.downgrade-low-heap'] },
  }
  tracker.begin(base).finish({ exitCode: 0 })
  tracker.begin(base).finish({ exitCode: 1 })
  await service.save()
  const snapshot = await service.snapshot()
  const sample = snapshot.phases.launch.jvm['modded-aikar']
  assert.equal(sample.attempts, 2)
  assert.equal(sample.successes, 1)
  assert.equal(sample.failures, 1)
  assert.equal(sample.heapMb, 4096)
  assert.deepEqual(sample.downgrades, ['jvm.downgrade-low-heap'])
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(persisted.phases.launch.jvm['modded-aikar'].heapMb, 4096)
})

test('P13 identical input gives byte-identical output across runs and key orders', () => {
  const first = input({
    jvmPreset: 'modded-aikar',
    extraJvmArgs: ['-Dfoo=bar', '-XX:G1HeapWastePercent=7'],
    modCount: 25,
    totalMemMb: 24576,
  })
  const frozen = Object.freeze({ ...first, extraJvmArgs: Object.freeze([...first.extraJvmArgs]) })
  const a = resolveJvmPlan(frozen)
  const b = resolveJvmPlan({ ...frozen })
  const reversed = Object.fromEntries(Object.entries(frozen).reverse())
  const c = resolveJvmPlan({ ...reversed, extraJvmArgs: Object.freeze([...frozen.extraJvmArgs]) })

  assert.equal(JSON.stringify(a.args), JSON.stringify(b.args))
  assert.equal(JSON.stringify(a.args), JSON.stringify(c.args))
  assert.equal(JSON.stringify(a.downgrades), JSON.stringify(b.downgrades))
  assert.equal(JSON.stringify(a.downgrades), JSON.stringify(c.downgrades))
  assert.deepEqual(plan({ jvmPreset: 'custom' }), plan({ jvmPreset: 'custom' }))
})

test('P13 schemas keep jvmPreset optional on instances and default it globally', () => {
  assert.equal(SettingsSchema.parse({}).jvmPreset, 'auto')
  assert.equal(SettingsSchema.parse({ jvmPreset: 'not-a-preset' }).jvmPreset, 'auto')

  const minimal = InstanceFileSchema.parse({ id: 'inst' })
  assert.equal(minimal.jvmPreset, undefined)
  assert.equal(minimal.extraJvmArgs, undefined)

  const configured = InstanceFileSchema.parse({
    id: 'inst',
    jvmPreset: 'low-latency-zgc',
    extraJvmArgs: ['-Xmx4G'],
  })
  assert.equal(configured.jvmPreset, 'low-latency-zgc')
  assert.deepEqual(configured.extraJvmArgs, ['-Xmx4G'])
})

test('P14 resolveJvmPreferences is the single instance > settings > auto mapper', () => {
  const automatic = resolveJvmPreferences({ maxMemoryMb: 0 })
  assert.equal(automatic.memoryMode, 'auto')
  assert.equal(automatic.jvmPreset, 'auto')
  assert.deepEqual(automatic.extraJvmArgs, [])

  const configured = resolveJvmPreferences({
    maxMemoryMb: 4096,
    minMemoryMb: 1024,
    fallbackPreset: 'low-latency-zgc',
    extraJvmArgs: ['-Dfoo=bar'],
  })
  assert.equal(configured.memoryMode, 'explicit')
  assert.equal(configured.maxMemoryMb, 4096)
  assert.equal(configured.minMemoryMb, 1024)
  assert.equal(configured.jvmPreset, 'low-latency-zgc')
  assert.deepEqual(configured.extraJvmArgs, ['-Dfoo=bar'])

  // An explicit instance preset, including `auto`, beats the global settings.
  assert.equal(
    resolveJvmPreferences({ jvmPreset: 'auto', fallbackPreset: 'modded-aikar' }).jvmPreset,
    'auto',
  )
  assert.equal(
    resolveJvmPreferences({ jvmPreset: 'custom', fallbackPreset: 'modded-aikar' }).jvmPreset,
    'custom',
  )

  // The mapper owns the array, so callers cannot mutate the instance file.
  const source = ['-Dfoo=bar']
  const copied = resolveJvmPreferences({ extraJvmArgs: source })
  copied.extraJvmArgs.push('-Dbaz=1')
  assert.deepEqual(source, ['-Dfoo=bar'])
  assert.equal(resolveJvmPreferences({ maxMemoryMb: Number.NaN }).maxMemoryMb, 0)
})

test('P14 reason codes have one ranked source and unknown codes sort last', () => {
  assert.equal(new Set(JVM_REASON_CODES).size, JVM_REASON_CODES.length)
  assert.equal(jvmReasonRank('jvm.preset-auto'), 0)
  assert.ok(jvmReasonRank('jvm.arg-dropped') > jvmReasonRank('jvm.heap-auto'))
  assert.equal(jvmReasonRank('jvm.unknown-code'), JVM_REASON_CODES.length)
  assert.ok(jvmReasonRank('jvm.unknown-code') > jvmReasonRank('jvm.arg-dropped'))
})

test('P14 dead JVM scaffolding stays deleted', async () => {
  assert.equal(launchArgs.DEFAULT_JVM_ARGS, undefined)
  await assert.rejects(
    () => prepareLaunch({}),
    /requires the JVM plan resolved by LaunchService\.prepare/,
  )
})

test('P13 core gives the instance preset precedence over settings', async () => {
  const base = tempDir('p13-core')
  try {
    const gameRoot = path.join(base, 'game')
    const instanceDirectory = path.join(gameRoot, 'instances', 'demo')
    fs.mkdirSync(instanceDirectory, { recursive: true })

    const core = await createCore({
      appDataPath: base,
      legacyGameRoot: path.join(base, 'missing'),
      logger: createNullLogger(),
    })
    await core.settings.save({ jvmPreset: 'low-latency-zgc' })

    let captured
    let instancePreset
    core.instanceManager = {
      get: async (id) => ({ instance: { id }, directory: instanceDirectory }),
      readFile: async () => ({
        id: 'inst-demo',
        name: 'Demo',
        version: '1.20.1',
        loader: 'vanilla',
        loaderVersion: '',
        javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
        javaMode: 'pinned',
        minMemory: 1024,
        maxMemory: 4096,
        memoryMode: 'explicit',
        ...(instancePreset ? { jvmPreset: instancePreset } : {}),
        extraJvmArgs: ['-Dfoo=bar'],
      }),
      updateFile: async () => ({}),
    }
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async (request) => {
        captured = request
        return {
          pid: 1234,
          plan: { javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe', javaMajorVersion: 17 },
          exit: Promise.resolve({ code: 0, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          launchId: 'launch-p13',
        }
      },
    }

    await core.launchInstance({ instanceId: 'inst-demo' })
    assert.equal(captured.jvmPreset, 'low-latency-zgc')
    assert.equal(captured.memoryMode, 'explicit')
    assert.deepEqual(captured.extraJvmArgs, ['-Dfoo=bar'])

    instancePreset = 'custom'
    await core.launchInstance({ instanceId: 'inst-demo' })
    assert.equal(captured.jvmPreset, 'custom')

    instancePreset = 'auto'
    await core.launchInstance({ instanceId: 'inst-demo' })
    assert.equal(captured.jvmPreset, 'auto')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
