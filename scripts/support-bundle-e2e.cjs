#!/usr/bin/env node
/**
 * Real support-bundle run (blueprint phase 10 §4), no network.
 *
 * Builds a realistic appData/gameRoot tree with deliberate canaries
 * (tokens, JWTs, API keys, account names, Windows/POSIX/UNC paths), exports a
 * bundle, scans every ZIP entry, checks the manifest hashes and proves the
 * source tree is byte-identical afterwards.
 *
 * Usage: node scripts/support-bundle-e2e.cjs
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const AdmZip = require('adm-zip')
const { createSupportBundle } = require('../dist-electron/support-bundle.js')

const CANARIES = [
  'SECRET-ACCESS-7f3a',
  'SECRET-REFRESH-9b2c',
  'SECRET-APIKEY-4d5e',
  'SECRET-CLIENT-1a2b',
  'QUERY-SECRET-8c9d',
  'CLIENT-SECRET-2e3f',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2',
  'READONLY-PASSWORD-5a6b',
  'SNAKE-SECRET-3c4d',
]

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function hashTree(root) {
  const hashes = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(file)
        continue
      }
      if (!entry.isFile()) continue
      hashes[path.relative(root, file)] = sha256(fs.readFileSync(file))
    }
  }
  walk(root)
  return hashes
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-support-e2e-'))
const appData = path.join(root, 'appData')
const gameRoot = path.join(root, 'game')
const logs = path.join(appData, 'logs')
const instanceDir = path.join(gameRoot, 'instances', 'alice')
const versionDir = path.join(gameRoot, 'versions', '1.20.1')
for (const dir of [logs, instanceDir, versionDir]) fs.mkdirSync(dir, { recursive: true })

fs.writeFileSync(
  path.join(appData, 'settings.json'),
  JSON.stringify({
    currentTheme: 'bamboo',
    lang: 'de',
    telemetryEnabled: true,
    apiKey: CANARIES[2],
    accounts: [{ name: 'Alice', accessToken: CANARIES[0] }],
  }),
)
fs.writeFileSync(
  path.join(appData, 'instances.json'),
  JSON.stringify({
    version: 1,
    selectedInstance: 'i1',
    instances: [{
      id: 'i1',
      name: 'Alice Private World',
      path: instanceDir,
      version: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      managed: true,
    }],
  }),
)
fs.writeFileSync(
  path.join(appData, 'java.json'),
  JSON.stringify({
    version: 1,
    records: [{
      path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.12\\bin\\java.exe',
      version: '17.0.12',
      majorVersion: 17,
      architecture: 'x64',
      vendor: 'Eclipse Adoptium',
      source: 'scan',
      valid: true,
    }],
  }),
)
fs.writeFileSync(path.join(appData, 'accounts.json'), JSON.stringify({
  accounts: [{ id: 'i1', name: 'Alice', uuid: 'uuid-alice', accessToken: CANARIES[0] }],
}))
fs.writeFileSync(path.join(appData, 'accounts.tokens.json'), JSON.stringify({
  v: 1,
  entries: { i1: { accessToken: CANARIES[0], refreshToken: CANARIES[1] } },
}))
fs.writeFileSync(
  path.join(appData, 'settings.json.corrupt-1700000000000'),
  '{ "currentTheme": "bamboo", ',
)
fs.writeFileSync(
  path.join(logs, 'main.log'),
  [
    JSON.stringify({
      ts: '2026-10-19T00:00:00.000Z',
      level: 'info',
      tag: 'core:launch',
      msg: 'Launch started',
      data: {
        gameRoot,
        instancePath: instanceDir,
        javaPath: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.12\\bin\\java.exe',
        account: 'Alice',
        accessToken: CANARIES[0],
        refreshToken: CANARIES[1],
        clientSecret: CANARIES[5],
        url: `https://example.test/download?access_token=${CANARIES[4]}&file=mod.jar`,
        jwt: CANARIES[6],
      },
    }),
    JSON.stringify({
      ts: '2026-10-19T00:00:01.000Z',
      level: 'warn',
      tag: 'core:download',
      msg: 'Mirror failed',
      data: {
        file: 'C:\\Users\\Alice Smith\\AppData\\Roaming\\bamboo\\cache\\x.jar',
        posix: '/home/alice/.minecraft/options.txt',
        unc: '\\\\server\\share\\alice\\secret.txt',
      },
    }),
    `plain text Authorization: Bearer ${CANARIES[0]}`,
    'env ACME_TOKEN=env-secret-value password=PLAIN-PASSWORD',
    '{"access_token":"SNAKE-SECRET-3c4d","refresh_token":"SNAKE-SECRET-3c4d"} failed at C:/My Games/instance/secret.txt',
    '',
  ].join('\n'),
)
fs.writeFileSync(
  path.join(versionDir, '1.20.1.json'),
  JSON.stringify({ id: '1.20.1', type: 'release', javaVersion: { majorVersion: 17 } }),
)
fs.writeFileSync(
  path.join(versionDir, 'bamboo-loader.json'),
  JSON.stringify({
    loader: 'fabric',
    loaderVersion: '0.15.11',
    minecraftVersion: '1.20.1',
    versionId: 'fabric-loader-0.15.11-1.20.1',
    installedAt: '2026-10-19T00:00:00Z',
    installerPath: 'C:\\Users\\Alice Smith\\installer.jar',
  }),
)

const before = hashTree(root)
const destination = path.join(root, 'out', 'bamboo-support.zip')
const first = createSupportBundle({
  appData,
  gameRoot,
  destination,
  now: new Date('2026-10-19T12:00:00Z'),
})
first
  .then(async (result) => {
    assert.equal(fs.existsSync(result.file), true)
    assert.ok(result.bytes > 0)
    assert.equal(result.sanitizedLogFiles, 1)
    assert.equal(result.file, destination)

    // The same destination is reused to prove the atomic replace path.
    const second = await createSupportBundle({
      appData,
      gameRoot,
      destination,
      now: new Date('2026-10-19T12:00:01Z'),
    })
    assert.equal(second.file, destination)

    const zip = new AdmZip(destination)
    const entries = {}
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) entries[entry.entryName] = entry.getData().toString('utf8')
    }
    const names = Object.keys(entries)
    const combined = Object.values(entries).join('\n')

    assert.ok(names.includes('README.txt'))
    assert.ok(names.includes('summary.json'))
    assert.ok(names.includes('settings.json'))
    assert.ok(names.includes('instances.json'))
    assert.ok(names.includes('java.json'))
    assert.ok(names.includes('versions.json'))
    assert.ok(names.includes('manifest.json'))
    assert.ok(names.includes('logs/main.log'))
    assert.equal(names.some((name) => /accounts/i.test(name)), false)

    for (const canary of CANARIES) {
      assert.equal(
        combined.includes(canary),
        false,
        `bundle leaked canary ${canary.slice(0, 12)}…`,
      )
    }
    assert.equal(combined.includes('Alice'), false)
    assert.equal(combined.includes('PLAIN-PASSWORD'), false)
    assert.equal(combined.includes('My Games'), false)
    assert.equal(combined.includes('env-secret-value'), false)
    for (const pattern of [
      /[A-Za-z]:\\Users\\/,
      /[A-Za-z]:\\Program Files\\/,
      /\/home\/alice\//,
      /\\\\server\\share\\/,
    ]) {
      assert.equal(pattern.test(combined), false, `bundle leaked path matching ${pattern}`)
    }

    const summary = JSON.parse(entries['summary.json'])
    assert.equal(summary.roots.appData, '<appData>')
    assert.equal(summary.roots.gameRoot, '<gameRoot>')
    assert.equal(summary.counts.installedVersions, 1)
    assert.equal(summary.counts.logFiles, 1)
    const versions = JSON.parse(entries['versions.json'])
    assert.deepEqual(versions[0], {
      id: '1.20.1',
      type: 'release',
      inheritsFrom: '',
      javaMajor: 17,
      loader: 'fabric',
      loaderVersion: '0.15.11',
      installedAt: '2026-10-19T00:00:00Z',
    })
    const instanceSummary = JSON.parse(entries['instances.json'])
    assert.equal(instanceSummary[0].label, 'instance-1')
    assert.equal(instanceSummary[0].path, undefined)

    const manifest = JSON.parse(entries['manifest.json'])
    assert.equal(manifest.entries.length, names.length - 1)
    for (const entry of manifest.entries) {
      assert.equal(
        sha256(Buffer.from(entries[entry.path], 'utf8')),
        entry.sha256,
        `manifest hash for ${entry.path}`,
      )
    }

    const after = hashTree(root)
    const originalKeys = Object.keys(before)
    for (const key of originalKeys) {
      assert.equal(after[key], before[key], `support export modified ${key}`)
    }
    assert.equal(
      Object.keys(after).filter((key) => key.includes('.corrupt-')).length,
      Object.keys(before).filter((key) => key.includes('.corrupt-')).length,
      'support export must not quarantine launcher state',
    )
    const liveUnchanged = originalKeys.every((key) => after[key] === before[key])

    console.log(JSON.stringify({
      script: 'support-bundle-e2e',
      status: 'PASSED',
      file: path.basename(result.file),
      entries: names.length,
      bytes: second.bytes,
      sanitizedLogFiles: second.sanitizedLogFiles,
      canariesChecked: CANARIES.length,
      liveUnchanged,
    }, null, 2))
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
