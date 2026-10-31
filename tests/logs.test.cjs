/**
 * P11 crash/log engine: bounded tail, crash reports, all eleven rules,
 * deterministic analysis, and reversible fixes with stale-id/EACCES handling.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { test } = require('node:test')
const { fixtureServer, jar, sha1, sha512, tempDir } = require('./harness.cjs')

const {
  analyzeInstance,
  applyFixAction,
  undoFixAction,
  getAnalysis,
  RULES,
  readLogTail,
  discoverLogs,
  readLanPort,
  parseCrashReport,
} = require('../dist-electron/logs/index.js')
const { InstanceLocks } = require('../dist-electron/instances/lock.js')
const { createCore } = require('../dist-electron/core.js')
const { createNullLogger } = require('../dist-electron/logger.js')
const { launchLegacyInstance } = require('../dist-electron/launch/legacy.js')

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function instanceLog(dir, lines) {
  const file = path.join(dir, 'logs', 'latest.log')
  write(file, lines.join('\n'))
  return file
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function deps(overrides = {}) {
  const patches = []
  const value = {
    patches,
    updateFile: async (_id, patch) => {
      patches.push(patch)
      return { id: 'inst', ...patch }
    },
    locks: new InstanceLocks(),
    findJava: async (major) =>
      major === 17
        ? { path: 'C:\\Java\\jdk-17\\bin\\java.exe' }
        : major === 8
          ? { path: 'C:\\Java\\jre-8\\bin\\java.exe' }
          : undefined,
    ...overrides,
  }
  return value
}

test('P11: tail is byte-capped, line-capped, ANSI-stripped and drops the partial first line', async () => {
  const root = tempDir('p11-tail')
  try {
    const file = path.join(root, 'latest.log')
    const filler = Array.from({ length: 12000 }, (_, index) => `line ${index} Missing sound for event:minecraft:test`)
    const lines = ['\u001b[31mfirst line must be dropped\u001b[0m', ...filler, '\u001b[32mTAIL-MARKER\u001b[0m']
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    const tail = await readLogTail(file)
    assert.equal(tail.truncated, true)
    assert.ok(tail.lines.length <= 2000)
    assert.equal(tail.lines.at(-1), 'TAIL-MARKER')
    assert.ok(!tail.lines.some((line) => line.includes('\u001b[')))
    assert.ok(!tail.lines.includes('first line must be dropped'))
    assert.ok(tail.bytes > 512 * 1024)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: 0-byte and missing logs yield empty tails; gzip logs are discovered and read', async () => {
  const root = tempDir('p11-gzip')
  try {
    const logs = path.join(root, 'logs')
    fs.mkdirSync(logs, { recursive: true })
    assert.deepEqual((await readLogTail(path.join(logs, 'missing.log'))).lines, [])
    write(path.join(logs, 'empty.log'), '')
    assert.deepEqual((await readLogTail(path.join(logs, 'empty.log'))).lines, [])
    fs.writeFileSync(
      path.join(logs, '2025-01-01-1.log.gz'),
      zlib.gzipSync('Published a LAN server on port 25566\n'),
    )
    const found = await discoverLogs(logs)
    const gzip = found.find((entry) => entry.gzip)
    assert.ok(gzip)
    assert.deepEqual((await readLogTail(gzip.path)).lines, ['Published a LAN server on port 25566'])
    assert.equal(await readLanPort(path.join(logs, 'empty.log')), undefined)
    assert.equal(await readLanPort(gzip.path), 25566)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: crash parser extracts header fields and caps mods/causes', async () => {
  const root = tempDir('p11-report')
  try {
    const file = path.join(root, 'crash-test.txt')
    const causes = Array.from({ length: 7 }, (_, index) => `Caused by: example.Cause${index}`)
    write(
      file,
      [
        '---- Minecraft Crash Report ----',
        'Description: Test crash',
        '-- System Details --',
        'Minecraft Version: 1.20.1',
        'Java Version: 17.0.9',
        'Mod List:',
        ...Array.from({ length: 510 }, (_, index) => `  mod${index}{1.0}`),
        '',
        ...causes,
        'Stacktrace:',
        '\tat example.Main.main(Main.java:1)',
      ].join('\n'),
    )
    const report = await parseCrashReport(file)
    assert.ok(report)
    assert.equal(report.description, 'Test crash')
    assert.equal(report.minecraftVersion, '1.20.1')
    assert.equal(report.javaVersion, '17.0.9')
    assert.equal(report.mods.length, 500)
    assert.equal(report.causes.length, 5)
    assert.equal(report.stacktrace, 'at example.Main.main(Main.java:1)')

    write(path.join(root, 'empty.txt'), '')
    assert.equal(await parseCrashReport(path.join(root, 'empty.txt')), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: every rule hits its authoritative pattern and output is deterministic', async () => {
  const root = tempDir('p11-rules')
  try {
    const instanceDir = path.join(root, 'instance')
    const lines = [
      'UnsupportedClassVersionError: example/Foo has been compiled by a more recent version of the Java Runtime (class file version 61.0)',
      'Caused by: java.lang.reflect.InaccessibleObjectException: Unable to make field private final accessible: module java.base does not "opens java.lang"',
      "Caused by: net.minecraftforge.fml.ModLoadingException: Mod ID: 'foo', Requested by: 'bar', Expected range: '[1.0,)'",
      "Mod 'bar' (bar) 1.0.0 requires any version of 'foo', which is missing!",
      'Duplicate mods found for modid example',
      'Mod resolution failed: Incompatible mod set',
      'Mixin apply for mod fancy failed during transformation',
      'java.lang.OutOfMemoryError: Java heap space',
      'GLFW error 65542: Pixel format not accelerated',
      'java.util.zip.ZipException: zip END header not found',
      'java.lang.NoClassDefFoundError: example/missing/Thing',
    ]
    instanceLog(instanceDir, lines)
    const first = await analyzeInstance({ instanceId: 'inst-rules', instanceDir, maxMemoryMb: 4096 })
    assert.equal(first.findings.length, 11)
    assert.deepEqual(first.findings.map((finding) => finding.ruleId), RULES.map((rule) => rule.id))
    assert.ok(first.findings.every((finding) => finding.evidence.length <= 3))
    assert.equal(first.reasons.filter((reason) => reason === 'crash.no-signal').length, 0)
    assert.ok(first.reasons.includes('crash.confidence-low'))

    const second = await analyzeInstance({ instanceId: 'inst-rules', instanceDir, maxMemoryMb: 4096 })
    assert.deepEqual(
      second.findings.map((finding) => ({
        rule: finding.ruleId,
        evidence: finding.evidence,
        actions: finding.actions,
      })),
      first.findings.map((finding) => ({
        rule: finding.ruleId,
        evidence: finding.evidence,
        actions: finding.actions,
      })),
    )
    const heap = first.findings.find((finding) => finding.ruleId === 'out-of-memory')
    assert.equal(heap.actions[0].kind, 'raise-heap')
    assert.equal(heap.actions[0].toMb, 6144)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: legacy-on-modern-jvm ignores the normal OptiFine exports warning', async () => {
  const root = tempDir('p11-legacy')
  try {
    const instanceDir = path.join(root, 'instance')
    instanceLog(instanceDir, [
      'WARN: java.lang.reflect.InaccessibleObjectException: Unable to make field accessible: module java.base does not "exports java.lang"',
    ])
    const normal = await analyzeInstance({ instanceId: 'normal', instanceDir, maxMemoryMb: 4096 })
    assert.equal(normal.findings.length, 0)
    assert.ok(normal.reasons.includes('crash.no-signal'))

    instanceLog(instanceDir, [
      'Exception in thread "main" java.lang.reflect.InaccessibleObjectException: Unable to make field accessible: module java.base does not "opens java.lang"',
    ])
    const crash = await analyzeInstance({ instanceId: 'crash', instanceDir, maxMemoryMb: 4096 })
    assert.equal(crash.findings[0].ruleId, 'legacy-on-modern-jvm')
    assert.equal(crash.findings[0].actions[0].major, 8)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: stale crash report is ignored and report-only analysis is labelled', async () => {
  const root = tempDir('p11-report-window')
  try {
    const instanceDir = path.join(root, 'instance')
    const report = path.join(instanceDir, 'crash-reports', 'crash-old.txt')
    write(report, 'Description: old\nCaused by: java.lang.OutOfMemoryError: Java heap space\n')
    const old = Date.now() - 60_000
    fs.utimesSync(report, old / 1000, old / 1000)
    const stale = await analyzeInstance({
      instanceId: 'stale',
      instanceDir,
      maxMemoryMb: 4096,
      launchStartedAt: Date.now(),
    })
    assert.equal(stale.findings.length, 0)
    assert.ok(stale.reasons.includes('crash.report-stale'))

    const fresh = await analyzeInstance({ instanceId: 'fresh', instanceDir, maxMemoryMb: 4096 })
    assert.equal(fresh.findings[0].ruleId, 'out-of-memory')
    assert.ok(fresh.reasons.includes('crash.report-only'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: raise-heap applies and undo restores the previous memory fields', async () => {
  const root = tempDir('p11-heap')
  try {
    const instanceDir = path.join(root, 'instance')
    instanceLog(instanceDir, ['java.lang.OutOfMemoryError: Java heap space'])
    const analysis = await analyzeInstance({
      instanceId: 'inst-heap',
      instanceDir,
      maxMemoryMb: 4096,
      memoryMode: 'auto',
    })
    const action = analysis.findings[0].actions[0]
    const hook = deps()
    const applied = await applyFixAction(analysis.id, action.id, hook)
    assert.equal(applied.ok, true)
    assert.equal(applied.changed.join(','), 'maxMemory,memoryMode')
    assert.ok(applied.undoToken)
    assert.deepEqual(hook.patches[0], { maxMemory: 6144, memoryMode: 'explicit' })

    const undone = await undoFixAction(applied.undoToken, hook)
    assert.equal(undone.ok, true)
    assert.deepEqual(hook.patches[1], { maxMemory: 4096, memoryMode: 'auto' })
    assert.equal((await undoFixAction(applied.undoToken, hook)).code, 'INVALID')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: switch-java pins the runtime, clears the memo and undo restores it', async () => {
  const root = tempDir('p11-switch')
  try {
    const instanceDir = path.join(root, 'instance')
    instanceLog(instanceDir, [
      'Exception in thread "main" java.lang.reflect.InaccessibleObjectException: Unable to make field accessible: module java.base does not "opens java.lang"',
    ])
    const analysis = await analyzeInstance({
      instanceId: 'inst-switch',
      instanceDir,
      maxMemoryMb: 4096,
      javaMode: 'auto',
      javaPath: '',
      resolvedJava: { major: 21, relativePath: 'java/java-runtime-delta/bin/java.exe', at: 1 },
    })
    const action = analysis.findings[0].actions[0]
    assert.equal(action.kind, 'switch-java')
    assert.equal(action.major, 8)
    const hook = deps()
    const applied = await applyFixAction(analysis.id, action.id, hook)
    assert.equal(applied.ok, true)
    assert.equal(hook.patches[0].javaMode, 'pinned')
    assert.equal(hook.patches[0].resolvedJava, undefined)
    const undone = await undoFixAction(applied.undoToken, hook)
    assert.equal(undone.ok, true)
    assert.equal(hook.patches[1].javaMode, 'auto')
    assert.equal(hook.patches[1].resolvedJava.major, 21)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: disable-mod moves the JAR, undo moves it back, stale ids never write', async () => {
  const root = tempDir('p11-disable')
  try {
    const instanceDir = path.join(root, 'instance')
    const mods = path.join(instanceDir, 'mods')
    fs.mkdirSync(mods, { recursive: true })
    const jar = path.join(mods, 'fancy.jar')
    write(jar, 'jar')
    instanceLog(instanceDir, ['Mixin apply for mod fancy failed'])
    const analysis = await analyzeInstance({ instanceId: 'inst-disable', instanceDir, maxMemoryMb: 4096 })
    const action = analysis.findings[0].actions[0]
    assert.equal(action.kind, 'disable-mod')
    assert.equal(action.jar, 'fancy.jar')

    const hook = deps()
    const applied = await applyFixAction(analysis.id, action.id, hook)
    assert.equal(applied.ok, true)
    assert.equal(fs.existsSync(jar), false)
    assert.ok(fs.existsSync(path.join(instanceDir, 'mods-disabled', 'index.json')))
    assert.ok(applied.undoToken)

    const undone = await undoFixAction(applied.undoToken, hook)
    assert.equal(undone.ok, true)
    assert.equal(fs.existsSync(jar), true)
    assert.equal((await undoFixAction(applied.undoToken, hook)).code, 'INVALID')
    assert.equal((await applyFixAction('missing', 'missing', hook)).code, 'INVALID')
    assert.equal(getAnalysis('missing'), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: launchInstance analyzes a non-zero exit and pushes through the sink', async () => {
  const root = tempDir('p11-trigger')
  try {
    let pushed
    const core = await createCore({
      appDataPath: path.join(root, 'app'),
      legacyGameRoot: path.join(root, 'missing'),
      logger: createNullLogger(),
      onAnalysis: (result) => {
        pushed = result
      },
    })
    const instanceDir = path.join(core.paths.gameRoot, 'instances', 'trigger')
    fs.mkdirSync(instanceDir, { recursive: true })
    core.instanceManager = {
      get: async (id) => ({ instance: { id }, directory: instanceDir }),
      readFile: async () => ({
        id: 'inst-trigger',
        version: '1.20.1',
        loader: 'vanilla',
        loaderVersion: '',
        javaPath: '',
        javaMode: 'auto',
        minMemory: 0,
        maxMemory: 4096,
        memoryMode: 'auto',
      }),
      updateFile: async () => ({}),
    }
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async () => ({
        pid: 1,
        plan: {},
        exit: Promise.resolve({ code: 1, signal: null, durationMs: 1 }),
        kill: async () => undefined,
        killed: false,
        stderrLines: ['java.lang.OutOfMemoryError: Java heap space'],
        launchId: 'launch-p11',
      }),
    }
    await core.launchInstance({ instanceId: 'inst-trigger' })
    await waitFor(() => pushed !== undefined)
    assert.ok(pushed)
    assert.equal(pushed.launchId, 'launch-p11')
    assert.equal(pushed.findings[0].ruleId, 'out-of-memory')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P9/P11: legacy launch-game adopts the profile and pushes the core analysis', async () => {
  const base = tempDir('p11-legacy')
  try {
    let pushed
    const core = await createCore({
      appDataPath: path.join(base, 'app'),
      legacyGameRoot: path.join(base, 'missing'),
      logger: createNullLogger(),
      onAnalysis: (result) => {
        pushed = result
      },
    })
    const instanceDir = path.join(core.paths.gameRoot, 'profiles', 'legacy')
    fs.mkdirSync(path.join(instanceDir, 'logs'), { recursive: true })
    core.getLaunchIdentity = async () => ({ name: 'Steve', uuid: '1', type: 'offline' })
    core.launch = {
      start: async (request) => {
        assert.equal(request.gameDirectory, instanceDir)
        assert.equal(request.versionId, '1.20.1')
        return {
          pid: 1,
          plan: {},
          exit: Promise.resolve({ code: 1, signal: null, durationMs: 1 }),
          kill: async () => undefined,
          killed: false,
          stderrLines: ['java.lang.OutOfMemoryError: Java heap space'],
          launchId: 'launch-legacy',
        }
      },
    }

    const handle = await launchLegacyInstance(core, {
      folderName: 'legacy',
      directory: instanceDir,
      name: 'Legacy',
      minecraftVersion: '1.20.1',
      versionId: '1.20.1',
      loader: 'vanilla',
      loaderVersion: '',
    })
    assert.equal(handle.launchId, 'launch-legacy')

    const adopted = await core.instances.list()
    assert.equal(adopted.length, 1)
    assert.equal(adopted[0].path, instanceDir)
    assert.equal(adopted[0].managed, false)
    assert.equal((await core.instanceManager.findByFolder('legacy')).instance.id, adopted[0].id)

    await waitFor(() => pushed !== undefined)
    assert.ok(pushed)
    assert.equal(pushed.launchId, 'launch-legacy')
    assert.equal(pushed.findings[0].ruleId, 'out-of-memory')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('P11: duplicate-mod selects the older JAR when attribution has no stack id', async () => {
  const root = tempDir('p11-duplicate')
  try {
    const instanceDir = path.join(root, 'instance')
    const mods = path.join(instanceDir, 'mods')
    fs.mkdirSync(mods, { recursive: true })
    const older = path.join(mods, 'example-1.0.jar')
    const newer = path.join(mods, 'example-2.0.jar')
    write(older, 'old jar')
    write(newer, 'new jar')
    const now = Date.now() / 1000
    fs.utimesSync(older, now - 120, now - 120)
    fs.utimesSync(newer, now, now)
    instanceLog(instanceDir, ['Duplicate mods found for modid example'])

    const analysis = await analyzeInstance({ instanceId: 'inst-duplicate', instanceDir, maxMemoryMb: 4096 })
    const finding = analysis.findings.find((item) => item.ruleId === 'duplicate-mod')
    assert.ok(finding)
    assert.equal(finding.actions.length, 1)
    assert.equal(finding.actions[0].kind, 'disable-mod')
    assert.equal(finding.actions[0].jar, 'example-1.0.jar')

    const applied = await applyFixAction(analysis.id, finding.actions[0].id, deps())
    assert.equal(applied.ok, true)
    assert.equal(fs.existsSync(older), false)
    assert.equal(fs.existsSync(newer), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: a read-only index fails with EACCES before the JAR is moved', async () => {
  const root = tempDir('p11-readonly-index')
  try {
    const instanceDir = path.join(root, 'instance')
    const mods = path.join(instanceDir, 'mods')
    const disabled = path.join(instanceDir, 'mods-disabled')
    fs.mkdirSync(mods, { recursive: true })
    fs.mkdirSync(disabled, { recursive: true })
    const file = path.join(mods, 'fancy.jar')
    write(file, 'jar')
    const index = path.join(disabled, 'index.json')
    write(index, JSON.stringify({ version: 1, entries: [] }))
    fs.chmodSync(index, 0o444)
    instanceLog(instanceDir, ['Mixin apply for mod fancy failed'])

    try {
      const analysis = await analyzeInstance({ instanceId: 'inst-readonly', instanceDir, maxMemoryMb: 4096 })
      const action = analysis.findings[0].actions[0]
      const applied = await applyFixAction(analysis.id, action.id, deps())
      assert.equal(applied.ok, false)
      assert.equal(applied.code, 'EACCES')
      assert.equal(applied.undoToken, undefined)
      assert.equal(fs.existsSync(file), true)
      assert.deepEqual(fs.readdirSync(disabled), ['index.json'])
    } finally {
      fs.chmodSync(index, 0o666)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: core installs a missing dependency after a click and undo moves every installed file out', async () => {
  const root = tempDir('p11-install-dependency')
  const payload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'depmod', version: '1.0' }) })
  const subPayload = jar({ 'fabric.mod.json': JSON.stringify({ id: 'subdep', version: '1.0' }) })
  const server = await fixtureServer({
    '/v2/search': JSON.stringify({
      hits: [{ project_id: 'dep-project', slug: 'depmod', title: 'Dependency' }],
    }),
    '/v2/project/dep-project/version': JSON.stringify([
      {
        id: 'dep-version',
        project_id: 'dep-project',
        name: 'Dependency 1.0',
        version_number: '1.0',
        game_versions: ['1.20.1'],
        loaders: ['fabric'],
        files: [
          {
            url: 'BASE/files/depmod-1.0.jar',
            filename: 'depmod-1.0.jar',
            size: payload.length,
            hashes: { sha1: sha1(payload), sha512: sha512(payload) },
            primary: true,
          },
        ],
        dependencies: [{ project_id: 'sub-dep', dependency_type: 'required' }],
      },
    ]),
    '/v2/project/sub-dep/version': JSON.stringify([
      {
        id: 'sub-version',
        project_id: 'sub-dep',
        name: 'Sub dependency 1.0',
        version_number: '1.0',
        game_versions: ['1.20.1'],
        loaders: ['fabric'],
        files: [
          {
            url: 'BASE/files/subdep-1.0.jar',
            filename: 'subdep-1.0.jar',
            size: subPayload.length,
            hashes: { sha1: sha1(subPayload), sha512: sha512(subPayload) },
            primary: true,
          },
        ],
        dependencies: [],
      },
    ]),
    '/files/depmod-1.0.jar': payload,
    '/files/subdep-1.0.jar': subPayload,
  })
  for (const route of ['/v2/project/dep-project/version', '/v2/project/sub-dep/version']) {
    server.routes[route] = Buffer.from(
      server.routes[route].toString('utf8').replaceAll('BASE', server.base),
    )
  }
  try {
    const core = await createCore({
      appDataPath: path.join(root, 'app'),
      legacyGameRoot: path.join(root, 'missing'),
      logger: createNullLogger(),
      fetchImpl: fetch,
      modrinthBaseUrl: `${server.base}/v2`,
    })
    const instanceDir = path.join(root, 'instance')
    fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
    instanceLog(instanceDir, [
      "Caused by: net.minecraftforge.fml.ModLoadingException: Mod ID: 'depmod', Requested by: 'main', Expected range: '[1.0,)'",
    ])
    core.instanceManager = {
      get: async () => ({ instance: { id: 'inst-dep' }, directory: instanceDir }),
      readFile: async () => ({
        id: 'inst-dep',
        version: '1.20.1',
        loader: 'fabric',
        loaderVersion: '',
        javaPath: '',
        javaMode: 'auto',
        minMemory: 0,
        maxMemory: 4096,
        memoryMode: 'auto',
      }),
      updateFile: async () => ({}),
      locks: new InstanceLocks(),
    }

    const analysis = await core.analyze('inst-dep')
    const finding = analysis.findings.find((item) => item.ruleId === 'missing-dependency-forge')
    assert.ok(finding)
    const action = finding.actions.find((item) => item.kind === 'install-dependency')
    assert.ok(action)
    const applied = await core.applyFix(analysis.id, action.id)
    assert.equal(applied.ok, true)
    const installed = path.join(instanceDir, 'mods', 'depmod-1.0.jar')
    const installedSub = path.join(instanceDir, 'mods', 'subdep-1.0.jar')
    assert.equal(fs.readFileSync(installed).equals(payload), true)
    assert.equal(fs.readFileSync(installedSub).equals(subPayload), true)
    assert.ok(applied.undoToken)

    const undone = await core.undoFix(applied.undoToken)
    assert.equal(undone.ok, true)
    assert.equal(fs.existsSync(installed), false)
    assert.equal(fs.existsSync(installedSub), false)
    const disabled = fs.readdirSync(path.join(instanceDir, 'mods-disabled'), { recursive: true })
    assert.ok(disabled.some((entry) => String(entry).endsWith('depmod-1.0.jar')))
    assert.ok(disabled.some((entry) => String(entry).endsWith('subdep-1.0.jar')))
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: core executes open-path and open-url actions through the shell seam', async () => {
  const root = tempDir('p11-open')
  try {
    const opened = []
    const urls = []
    const core = await createCore({
      appDataPath: path.join(root, 'app'),
      legacyGameRoot: path.join(root, 'missing'),
      logger: createNullLogger(),
      openPath: async (target) => {
        opened.push(target)
      },
      openUrl: async (url) => {
        urls.push(url)
      },
    })
    const instanceDir = path.join(root, 'instance')
    fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true })
    instanceLog(instanceDir, ['Mod resolution failed: Incompatible mod set'])
    core.instanceManager = {
      get: async () => ({ instance: { id: 'inst-open' }, directory: instanceDir }),
      readFile: async () => ({
        id: 'inst-open',
        version: '1.20.1',
        loader: 'fabric',
        loaderVersion: '',
        javaPath: '',
        javaMode: 'auto',
        minMemory: 0,
        maxMemory: 4096,
        memoryMode: 'auto',
      }),
      updateFile: async () => ({}),
      locks: new InstanceLocks(),
    }

    const pathAnalysis = await core.analyze('inst-open')
    const pathAction = pathAnalysis.findings[0].actions[0]
    assert.equal(pathAction.kind, 'open-path')
    const pathResult = await core.applyFix(pathAnalysis.id, pathAction.id)
    assert.equal(pathResult.ok, true)
    assert.deepEqual(opened, [path.join(instanceDir, 'mods')])
    assert.equal(pathResult.undoToken, undefined)

    instanceLog(instanceDir, ['GLFW error 65542: Pixel format not accelerated (NVIDIA GeForce)'])
    const urlAnalysis = await core.analyze('inst-open')
    const urlAction = urlAnalysis.findings[0].actions[0]
    assert.equal(urlAction.kind, 'open-url')
    const urlResult = await core.applyFix(urlAnalysis.id, urlAction.id)
    assert.equal(urlResult.ok, true)
    assert.deepEqual(urls, ['https://www.nvidia.com/en-us/drivers/'])
    assert.equal(urlResult.undoToken, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shared default logger records the tag and redacts secrets', () => {
  const root = tempDir('logger-default')
  const {
    createFileLogger,
    createNullLogger,
    describeError,
    getDefaultLogger,
    setDefaultLogger,
  } = require('../dist-electron/logger.js')
  try {
    setDefaultLogger(createFileLogger({ dir: root }))
    getDefaultLogger().child('smoke').warn('fallback used', {
      accessToken: 'secret-value',
      error: describeError(new Error('disk busy')),
    })
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'main.log'), 'utf8').trim())
    assert.equal(entry.level, 'warn')
    assert.equal(entry.tag, 'core:smoke')
    assert.equal(entry.msg, 'fallback used')
    assert.equal(entry.data.accessToken, '[redacted]')
    assert.equal(entry.data.error, 'disk busy')
  } finally {
    setDefaultLogger(createNullLogger())
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P11: EACCES on updateFile returns EACCES without an undo token', async () => {
  const root = tempDir('p11-eacces')
  try {
    const instanceDir = path.join(root, 'instance')
    instanceLog(instanceDir, ['java.lang.OutOfMemoryError: Java heap space'])
    const analysis = await analyzeInstance({ instanceId: 'inst-eacces', instanceDir, maxMemoryMb: 4096 })
    const action = analysis.findings[0].actions[0]
    const hook = deps({
      updateFile: async () => {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      },
    })
    const applied = await applyFixAction(analysis.id, action.id, hook)
    assert.equal(applied.ok, false)
    assert.equal(applied.code, 'EACCES')
    assert.equal(applied.undoToken, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
