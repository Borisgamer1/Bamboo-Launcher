/**
 * Phase 10 tests: opt-in telemetry and support-bundle redaction.
 * No network is used or needed.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { fixtureServer, sha1, tempDir } = require('./harness.cjs')

const AdmZip = require('adm-zip')
const { createNullLogger } = require('../dist-electron/logger.js')
const { TelemetryService, telemetryErrorCode } = require('../dist-electron/telemetry.js')
const { createSupportBundle } = require('../dist-electron/support-bundle.js')
const { sanitizeSupportText } = require('../dist-electron/support/sanitize.js')
const { LoaderService } = require('../dist-electron/loaders/service.js')
const { createCore } = require('../dist-electron/core.js')
const { runInstallManifest } = require('../dist-electron/download/executor.js')
const { LaunchTracker } = require('../dist-electron/launch-tracker.js')
const { installVersion } = require('../dist-electron/install/version.js')
const { installModpack } = require('../dist-electron/mods/index.js')

const fastRetry = {
  attempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
  sleep: async () => undefined,
  random: () => 0.5,
}

/** Local fixture server: pathname -> Buffer, with per-path hit counts. */
test('telemetry is disabled by default, writes nothing and has no network code', async (context) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'telemetry.ts'), 'utf8')
  for (const forbidden of ["node:http", "node:https", "node:net", "node:dns", "fetch(", "undici"]) {
    assert.equal(source.includes(forbidden), false, `telemetry.ts must not use ${forbidden}`)
  }
  const dir = tempDir('telemetry-off')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'telemetry.json')
  const service = new TelemetryService(file, { enabled: false, now: () => 1000 })
  service.record('download', { ok: true, durationMs: 5 })
  await service.save()
  assert.equal(service.enabled, false)
  assert.equal(fs.existsSync(file), false)
  const snapshot = await service.snapshot()
  assert.equal(snapshot.enabled, false)
  assert.deepEqual(snapshot.phases, {})
})

test('telemetry aggregates codes and success rates, persists when enabled and deletes on opt-out', async (context) => {
  const dir = tempDir('telemetry-on')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'telemetry.json')
  const service = new TelemetryService(file, { enabled: true, now: () => 2000 })
  await service.load()
  service.record('download', { ok: true, durationMs: 10 })
  service.record('download', { ok: false, code: 'network', durationMs: 20 })
  service.record('loader', { ok: false, code: 'EACCES', durationMs: 3 })
  service.record('launch', { ok: true, durationMs: 40 })
  await service.save()

  const reloaded = new TelemetryService(file, { enabled: true, now: () => 3000 })
  await reloaded.load()
  const snapshot = await reloaded.snapshot()
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.phases.download.attempts, 2)
  assert.equal(snapshot.phases.download.successes, 1)
  assert.equal(snapshot.phases.download.failures, 1)
  assert.equal(snapshot.phases.download.byCode.network, 1)
  assert.equal(snapshot.phases.download.successRate, 0.5)
  assert.equal(snapshot.phases.loader.byCode.EACCES, 1)
  assert.equal(snapshot.phases.launch.successRate, 1)

  await reloaded.setEnabled(false)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual((await reloaded.snapshot()).phases, {})
})

test('telemetry maps errors to short codes and never records messages/paths', async (context) => {
  const dir = tempDir('telemetry-code')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const service = new TelemetryService(path.join(dir, 'telemetry.json'), { enabled: true })
  const error = new Error('secret C:\\Users\\alice\\token')
  error.code = 'ENOSPC'
  assert.equal(telemetryErrorCode(error), 'ENOSPC')
  assert.equal(telemetryErrorCode(new Error('boom')), 'unknown')
  assert.equal(telemetryErrorCode({ code: 'bad code with spaces' }), 'unknown')

  await assert.rejects(
    () => service.measure('install', async () => {
      throw error
    }),
    /secret/,
  )
  await service.save()
  const raw = fs.readFileSync(path.join(dir, 'telemetry.json'), 'utf8')
  assert.equal(raw.includes('secret'), false)
  assert.equal(raw.includes('Users'), false)
  assert.equal(raw.includes('ENOSPC'), true)
  const snapshot = await service.snapshot()
  assert.equal(snapshot.phases.install.byCode.ENOSPC, 1)
})

test('launch telemetry treats non-zero exits and explicit errors as failures', async (context) => {
  const dir = tempDir('telemetry-launch')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const service = new TelemetryService(path.join(dir, 'telemetry.json'), { enabled: true })
  const tracker = new LaunchTracker(createNullLogger(), service)
  const base = { version: '1.20.1', instancePath: 'instance', javaPath: 'java' }

  tracker.begin(base).finish({ exitCode: 1 })
  tracker.begin(base).finish({ exitCode: 0, error: 'spawn failed' })
  tracker.begin(base).finish({ exitCode: 0 })
  await service.save()
  const launch = (await service.snapshot()).phases.launch
  assert.equal(launch.attempts, 3)
  assert.equal(launch.successes, 1)
  assert.equal(launch.failures, 2)
  assert.equal(launch.byCode['launch-exit-1'], 1)
  assert.equal(launch.byCode['launch-error'], 1)
})

test('the download executor records real success and failure codes', async (context) => {
  const payload = Buffer.from('telemetry-payload', 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': payload.length }).end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = tempDir('telemetry-download')
  const url = `http://127.0.0.1:${server.address().port}/file`
  context.after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const service = new TelemetryService(path.join(dir, 'telemetry.json'), { enabled: true })
  const manifest = (root, checksum) => ({
    version: 1,
    tasks: [{
      type: 'files',
      id: 'telemetry',
      destination: root,
      files: [{ path: 'file.bin', urls: [url], size: payload.length, checksum }],
    }],
  })
  const hash = crypto.createHash('sha1').update(payload).digest('hex')
  await runInstallManifest(manifest(path.join(dir, 'ok'), { algorithm: 'sha1', value: hash }), {
    telemetry: service,
  })
  await assert.rejects(
    () => runInstallManifest(manifest(path.join(dir, 'bad'), { algorithm: 'sha1', value: '0'.repeat(40) }), {
      telemetry: service,
      retry: { attempts: 1 },
    }),
    (error) => error && error.code === 'checksum-mismatch',
  )
  await service.save()
  const snapshot = await service.snapshot()
  assert.equal(snapshot.phases.download.attempts, 2)
  assert.equal(snapshot.phases.download.successes, 1)
  assert.equal(snapshot.phases.download.failures, 1)
  assert.equal(snapshot.phases.download.byCode['checksum-mismatch'], 1)
})

test('a version install is counted once under install, not per manifest as download', async (context) => {
  const client = Buffer.from('telemetry-client-jar', 'utf8')
  const lib = Buffer.from('telemetry-library', 'utf8')
  const routes = {}
  const server = await fixtureServer(routes)
  const dir = tempDir('phase-install')
  context.after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const versionJson = {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    downloads: { client: { url: `${server.base}/client.jar`, sha1: sha1(client), size: client.length } },
    libraries: [
      {
        name: 'com.example:alpha:1.0',
        downloads: {
          artifact: {
            path: 'com/example/alpha/1.0/alpha-1.0.jar',
            url: `${server.base}/libs/alpha.jar`,
            sha1: sha1(lib),
            size: lib.length,
          },
        },
      },
    ],
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  }
  const versionBytes = Buffer.from(JSON.stringify(versionJson), 'utf8')
  Object.assign(routes, {
    '/version_manifest_v2.json': Buffer.from(
      JSON.stringify({
        latest: { release: '1.20.1', snapshot: '1.20.1' },
        versions: [
          { id: '1.20.1', type: 'release', url: `${server.base}/version.json`, sha1: sha1(versionBytes) },
        ],
      }),
      'utf8',
    ),
    '/version.json': versionBytes,
    '/client.jar': client,
    '/libs/alpha.jar': lib,
  })

  const service = new TelemetryService(path.join(dir, 'telemetry.json'), { enabled: true, now: () => 1000 })
  await installVersion(path.join(dir, 'game'), '1.20.1', {
    cacheDir: path.join(dir, 'cache'),
    manifestSources: [`${server.base}/version_manifest_v2.json`],
    retry: fastRetry,
    withAssets: false,
    telemetry: service,
  })
  await service.save()

  const snapshot = await service.snapshot()
  // The version JSON and the client/libraries are two manifest runs, but both
  // are part of this one install attempt.
  assert.equal(snapshot.phases.install.attempts, 1)
  assert.equal(snapshot.phases.install.successes, 1)
  assert.equal(snapshot.phases.download, undefined, 'nested manifest runs must not count as download')
  assert.equal(server.hits.get('/version.json'), 1)
  assert.equal(server.hits.get('/client.jar'), 1)
})

test('a loader install is counted once under loader, including its base install', async (context) => {
  const loaderJar = Buffer.from('fabric-loader-jar', 'utf8')
  const client = Buffer.from('base-client-jar', 'utf8')
  const routes = {}
  const server = await fixtureServer(routes)
  const root = tempDir('phase-loader')
  const gameRoot = path.join(root, 'game')
  context.after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  // A complete base version: the loader's ensureBaseVersion pass still runs its
  // manifests, but every file is already valid on disk.
  const versionDir = path.join(gameRoot, 'versions', '1.20.1')
  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(
    path.join(versionDir, '1.20.1.json'),
    JSON.stringify({
      id: '1.20.1',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      downloads: { client: { url: `${server.base}/base-client.jar`, sha1: sha1(client), size: client.length } },
      libraries: [],
      javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    }),
  )
  fs.writeFileSync(path.join(versionDir, '1.20.1.jar'), client)

  const profile = {
    id: 'fabric-loader-0.15.11-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: [] },
    libraries: [
      {
        name: 'net.fabricmc:fabric-loader:0.15.11',
        url: `${server.base}/fabric/`,
        sha1: sha1(loaderJar),
        size: loaderJar.length,
      },
    ],
  }
  Object.assign(routes, {
    '/v2/versions/loader/1.20.1': Buffer.from(
      JSON.stringify([{ loader: { version: '0.15.11', stable: true } }]),
    ),
    '/v2/versions/loader/1.20.1/0.15.11/profile/json': Buffer.from(JSON.stringify(profile)),
    '/fabric/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar': loaderJar,
  })

  const service = new TelemetryService(path.join(root, 'telemetry.json'), { enabled: true, now: () => 1000 })
  const loaders = new LoaderService({
    gameRoot: () => gameRoot,
    telemetry: service,
    retry: fastRetry,
    logger: createNullLogger(),
  })
  const result = await loaders.install('fabric', {
    minecraftVersion: '1.20.1',
    loaderVersion: '0.15.11',
    metaBase: server.base,
    retry: fastRetry,
    logger: createNullLogger(),
  })
  await service.save()

  assert.equal(result.loader, 'fabric')
  const snapshot = await service.snapshot()
  assert.equal(snapshot.phases.loader.attempts, 1)
  assert.equal(snapshot.phases.loader.successes, 1)
  assert.equal(snapshot.phases.install, undefined, 'the nested base install belongs to loader')
  assert.equal(snapshot.phases.download, undefined, 'loader manifests must not count as download')
})

test('install and modpack phases record their own outcomes', async (context) => {
  const dir = tempDir('telemetry-phases')
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const service = new TelemetryService(path.join(dir, 'telemetry.json'), { enabled: true })

  await assert.rejects(
    () => installVersion(path.join(dir, 'game'), 'missing', {
      cacheDir: path.join(dir, 'cache'),
      manifest: { get: async () => ({ manifest: { versions: [] } }) },
      telemetry: service,
    }),
    (error) => error && error.code === 'invalid',
  )

  const instanceDir = path.join(dir, 'instance')
  fs.mkdirSync(instanceDir, { recursive: true })
  const archive = path.join(dir, 'empty.mrpack')
  const zip = new AdmZip()
  zip.addFile(
    'modrinth.index.json',
    Buffer.from(JSON.stringify({ name: 'Telemetry', formatVersion: 1, dependencies: {}, files: [] })),
  )
  zip.writeZip(archive)
  await installModpack({ instanceDir, archivePath: archive, telemetry: service })

  await service.save()
  const snapshot = await service.snapshot()
  assert.equal(snapshot.phases.install.attempts, 1)
  assert.equal(snapshot.phases.install.byCode.invalid, 1)
  assert.equal(snapshot.phases.modpack.attempts, 1)
  assert.equal(snapshot.phases.modpack.successes, 1)
})

test('core wires opt-in telemetry and removes the file when switched off', async (context) => {
  const appData = tempDir('core-telemetry')
  context.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  const core = await createCore({
    appDataPath: appData,
    legacyGameRoot: path.join(appData, 'missing-legacy'),
    logger: createNullLogger(),
  })
  try {
    assert.equal((await core.status()).telemetryEnabled, false)
    assert.equal(fs.existsSync(path.join(appData, 'telemetry.json')), false)
    await core.saveSettingsFromRenderer({ telemetryEnabled: true })
    assert.equal((await core.status()).telemetryEnabled, true)
    core.telemetry.record('download', { ok: true })
    await core.telemetry.save()
    assert.equal(fs.existsSync(path.join(appData, 'telemetry.json')), true)
    const bundle = await core.createSupportBundle(appData)
    assert.equal(fs.existsSync(bundle.file), true)
    assert.equal((await core.telemetry.snapshot()).phases.support.attempts, 1)
    await core.saveSettingsFromRenderer({ telemetryEnabled: false })
    assert.equal((await core.status()).telemetryEnabled, false)
    assert.equal(fs.existsSync(path.join(appData, 'telemetry.json')), false)
  } finally {
    await core.settings.save({})
  }
})

test('support bundle contains sanitized summaries and no accounts, tokens or absolute paths', async (context) => {
  const root = tempDir('bundle')
  const appData = path.join(root, 'appData')
  const gameRoot = path.join(root, 'game')
  fs.mkdirSync(path.join(appData, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(gameRoot, 'versions', '1.20.1'), { recursive: true })
  fs.writeFileSync(
    path.join(gameRoot, 'versions', '1.20.1', '1.20.1.json'),
    JSON.stringify({ id: '1.20.1', type: 'release', javaVersion: { majorVersion: 17 } }),
  )
  fs.writeFileSync(
    path.join(gameRoot, 'versions', '1.20.1', 'bamboo-loader.json'),
    JSON.stringify({
      loader: 'fabric',
      loaderVersion: '0.15.11',
      minecraftVersion: '1.20.1',
      versionId: 'fabric-loader-0.15.11-1.20.1',
      installedAt: '2026-10-19T00:00:00Z',
      installerPath: 'C:\\Users\\alice\\.bamboo\\installer.jar',
    }),
  )
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const secret = 'SECRET-TOKEN-7f3a'
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({
      currentTheme: 'dark',
      lang: 'de',
      telemetryEnabled: true,
      apiKey: secret,
      nested: { accessToken: secret },
    }),
  )
  fs.writeFileSync(
    path.join(appData, 'instances.json'),
    JSON.stringify({
      version: 1,
      selectedInstance: 'i1',
      instances: [
        {
          id: 'i1',
          name: 'Alice Private World',
          path: path.join(gameRoot, 'instances', 'alice'),
          version: '1.20.1',
          loader: 'fabric',
          loaderVersion: '0.15.11',
          managed: true,
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(appData, 'java.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          path: 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
          version: '17.0.12',
          majorVersion: 17,
          vendor: 'Eclipse Adoptium',
          architecture: 'x64',
          source: 'scan',
          valid: true,
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(appData, 'logs', 'main.log'),
    [
      JSON.stringify({
        ts: '2026-10-19T00:00:00Z',
        msg: 'start',
        data: {
          gameRoot,
          account: 'Alice',
          accessToken: secret,
          clientSecret: 'CLIENT-SECRET-123',
          url: 'https://example.test/download?access_token=QUERY-SECRET&file=a.jar',
          jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2',
        },
      }),
      JSON.stringify({ ts: '2026-10-19T00:00:01Z', msg: 'file', data: { path: 'C:\\Users\\alice smith\\AppData\\file.jar' } }),
      `{"access_token":"${secret}","refresh_token":"${secret}"} failed at C:\\My Games\\instance\\secret.txt`,
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(appData, 'accounts.json'), JSON.stringify({ accounts: [{ name: 'Alice', uuid: 'uuid-1' }] }))
  fs.writeFileSync(path.join(appData, 'accounts.tokens.json'), JSON.stringify({ v: 1, entries: { i1: { a: secret } } }))

  const result = await createSupportBundle({
    appData,
    gameRoot,
    destination: root,
    now: new Date('2026-10-19T12:00:00Z'),
    telemetry: {
      enabled: true,
      since: 1,
      updatedAt: 2,
      phases: { download: { attempts: 1, successes: 1, failures: 0, durationMs: 3, byCode: {}, successRate: 1 } },
    },
  })
  assert.equal(fs.existsSync(result.file), true)
  assert.ok(result.bytes > 0)
  assert.equal(result.sanitizedLogFiles, 1)
  assert.equal(result.entries.includes('accounts.json'), false)
  assert.equal(result.entries.includes('accounts.tokens.json'), false)

  const zip = new AdmZip(result.file)
  const texts = {}
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    texts[entry.entryName] = entry.getData().toString('utf8')
  }
  assert.equal(Object.keys(texts).some((name) => name.includes('accounts')), false)
  const combined = Object.values(texts).join('\n')
  assert.equal(combined.includes(secret), false)
  assert.equal(combined.includes('C:\\Users'), false)
  assert.equal(combined.includes('C:\\Program Files'), false)
  assert.equal(combined.includes('Alice'), false)
  assert.equal(combined.includes('CLIENT-SECRET'), false)
  assert.equal(combined.includes('QUERY-SECRET'), false)
  assert.equal(combined.includes('c2lnbmF0dXJl'), false)
  assert.equal(combined.includes('My Games'), false)
  assert.equal(combined.includes('<path>') || combined.includes('<appData>'), true)

  const summary = JSON.parse(texts['summary.json'])
  assert.equal(summary.roots.appData, '<appData>')
  assert.equal(summary.roots.gameRoot, '<gameRoot>')
  assert.equal(summary.counts.instances, 1)
  assert.equal(summary.counts.javaRuntimes, 1)
  assert.equal(summary.telemetry.phases.download.successRate, 1)
  const settings = JSON.parse(texts['settings.json'])
  assert.deepEqual(Object.keys(settings).sort(), ['currentTheme', 'lang', 'telemetryEnabled'])
  const instances = JSON.parse(texts['instances.json'])
  assert.equal(instances[0].label, 'instance-1')
  assert.equal(instances[0].version, '1.20.1')
  const java = JSON.parse(texts['java.json'])
  assert.equal(java[0].label, 'java-1')
  assert.equal(java[0].path, undefined)
  const versions = JSON.parse(texts['versions.json'])
  assert.equal(versions.length, 1)
  assert.equal(versions[0].id, '1.20.1')
  assert.equal(versions[0].loader, 'fabric')
  assert.equal(versions[0].javaMajor, 17)
  assert.equal(JSON.stringify(versions).includes('installer'), false)

  const manifest = JSON.parse(texts['manifest.json'])
  assert.equal(manifest.entries.length, Object.keys(texts).length - 1)
  for (const entry of manifest.entries) {
    assert.ok(texts[entry.path], `manifest entry ${entry.path} is present`)
    assert.equal(
      crypto.createHash('sha256').update(texts[entry.path], 'utf8').digest('hex'),
      entry.sha256,
    )
  }
})

test('sanitizeSupportText replaces known roots before generic paths', () => {
  const text = 'C:\\Data\\game\\instances\\a.jar C:\\Users\\alice\\secret.txt "accessToken":"abc" Bearer xyz'
  const clean = sanitizeSupportText(text, { appData: 'C:\\Data', gameRoot: 'C:\\Data\\game' })
  assert.equal(clean.includes('C:\\Data'), false)
  assert.equal(clean.includes('C:\\Users'), false)
  assert.equal(clean.includes('abc'), false)
  assert.equal(clean.includes('Bearer [redacted]'), true)
})

test('sanitizeSupportText handles unquoted paths with spaces and snake_case token keys', () => {
  const bs = String.fromCharCode(92)
  const secret = 'SNAKE-SECRET-42'
  const clean = sanitizeSupportText(
    [
      `{"access_token":"${secret}","refresh_token":"${secret}","id_token":"${secret}"}`,
      `failed at C:${bs}My Games${bs}instance${bs}secret.txt`,
      `failed at /home/Alice Smith/secret.txt`,
      `failed at ${bs}${bs}server${bs}share name${bs}secret.txt`,
    ].join('\n'),
    { appData: 'C:' + bs + 'Data', gameRoot: 'C:' + bs + 'Data' + bs + 'game' },
  )
  assert.equal(clean.includes(secret), false)
  for (const leak of ['My Games', 'Alice', 'share name']) {
    assert.equal(clean.includes(leak), false, `must not contain ${leak}`)
  }
})

test('sanitizeSupportText handles quoted paths, JWT, query tokens and env secrets', () => {
  const text = [
    '"path":"C:\\Users\\Alice Smith\\AppData\\Roaming\\file.jar"',
    '"clientSecret":"abc123" "accountName":"Alice"',
    'url=https://example.test/x?token=SECRET&x=1&api_key=SECOND',
    'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz',
  ].join('\n')
  const clean = sanitizeSupportText(text, { appData: 'C:\\Data', gameRoot: 'C:\\Data\\game' })
  for (const secret of ['Alice', 'abc123', 'SECRET', 'SECOND', 'QWxhZGRpbj', 'c2lnbmF0dXJl', 'ghp_']) {
    assert.equal(clean.includes(secret), false, `must not contain ${secret}`)
  }
  assert.equal(clean.includes('C:\\Users'), false)
  assert.equal(clean.includes('https://example.test/x?token=[redacted]'), true)
})
