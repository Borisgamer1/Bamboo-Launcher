/**
 * Phase 3 update engine: ledger stat fast path, hash mismatch, provider
 * batches and the release/beta/alpha rules of both adapters. Fixtures only.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { ModLedger, ModrinthClient, checkInstalledUpdates } = require('../dist-electron/mods/index.js')
const { ModrinthProvider } = require('../dist-electron/mods/providers/modrinth.js')
const { CurseForgeProvider } = require('../dist-electron/mods/providers/curseforge.js')
const { jar, sha1, tempDir } = require('./harness.cjs')

class FakeProvider {
  id = 'modrinth'

  constructor(results = {}) {
    this.results = results
    this.calls = []
  }

  async search() {
    throw new Error('unused')
  }

  async project(projectId) {
    return { id: projectId, slug: projectId, title: projectId, provider: 'modrinth' }
  }

  async versions() {
    throw new Error('unused')
  }

  async version() {
    throw new Error('unused')
  }

  async filesByIds() {
    throw new Error('unused')
  }

  async checkUpdates(files) {
    this.calls.push(files)
    return new Map(
      Object.entries(this.results).filter(([key]) => files.some((file) => file.key === key)),
    )
  }
}

function installed(label, record) {
  const dir = tempDir(label)
  const buffer = jar({ 'mod.json': label })
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mods', `${label}.jar`), buffer)
  return {
    dir,
    buffer,
    sha1: sha1(buffer),
    record: {
      sha1: sha1(buffer),
      paths: [`mods/${label}.jar`],
      provider: 'modrinth',
      projectId: 'P',
      versionId: 'v1',
      channel: 'release',
      installedAt: 1,
      ...record,
    },
  }
}

async function seed(dir, record) {
  const ledger = new ModLedger(dir)
  await ledger.upsert(record)
  return ledger
}

const target = { minecraftVersion: '1.20.1', loader: 'fabric' }

test('update available, then the ledger signature makes the next check warm', async () => {
  const fixture = installed('update')
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({
    [fixture.sha1]: { projectId: 'P', versionId: 'v2', channel: 'release' },
  })
  const first = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(first.updates.length, 1)
  assert.equal(first.entries[0].status, 'update-available')
  assert.equal(first.entries[0].reason, 'newer-version')
  assert.equal(first.hashed, 1)
  assert.equal(first.entries[0].candidate.versionId, 'v2')

  const second = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger: new ModLedger(fixture.dir),
    provider,
    target,
    now: () => 2_000,
  })
  assert.equal(second.checked, 1)
  assert.equal(second.hashed, 0)
  assert.equal(second.cached, 1)
  assert.equal(provider.calls.length, 1)
  assert.equal(second.entries[0].status, 'update-available')
  assert.equal(second.entries[0].candidate.versionId, 'v2')
})

test('up to date is reported without inventing an update', async () => {
  const fixture = installed('current')
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({
    [fixture.sha1]: { projectId: 'P', versionId: 'v1', channel: 'release' },
  })
  const result = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(result.entries[0].status, 'up-to-date')
  assert.equal(result.entries[0].reason, 'already-current')
  assert.equal(result.updates.length, 0)
})

test('a locally changed file is not offered as an update', async () => {
  const dir = tempDir('changed')
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mods', 'changed.jar'), jar({ a: 'changed' }))
  const ledger = await seed(dir, {
    sha1: sha1(Buffer.from('original')),
    paths: ['mods/changed.jar'],
    provider: 'modrinth',
    projectId: 'P',
    versionId: 'v1',
    installedAt: 1,
  })
  const provider = new FakeProvider({})
  const result = await checkInstalledUpdates({
    instanceDir: dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(result.entries[0].status, 'local-change')
  assert.equal(result.entries[0].reason, 'hash-mismatch')
  assert.equal(provider.calls.length, 0)
  assert.equal(result.checked, 1)
})

test('a project no longer on the provider is unresolved and negatively cached', async () => {
  const fixture = installed('gone')
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({})
  const first = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(first.entries[0].status, 'unresolved')
  assert.equal(first.entries[0].reason, 'not-on-provider')
  assert.equal(first.unresolved, 1)

  const second = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger: new ModLedger(fixture.dir),
    provider,
    target,
    now: () => 2_000,
  })
  assert.equal(second.cached, 1)
  assert.equal(provider.calls.length, 1)
})

test('installed beta keeps the beta channel even when the instance asks for release', async () => {
  const fixture = installed('beta', { channel: 'beta' })
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({
    [fixture.sha1]: { projectId: 'P', versionId: 'v2', channel: 'beta' },
  })
  await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    channel: 'release',
    now: () => 1_000,
  })
  assert.equal(provider.calls[0][0].channel, 'beta')
})

test('an older published candidate never counts as an update', async () => {
  const fixture = installed('older', { publishedAt: '2026-02-01T00:00:00Z' })
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({
    [fixture.sha1]: {
      projectId: 'P',
      versionId: 'v2',
      channel: 'release',
      publishedAt: '2026-01-01T00:00:00Z',
    },
  })
  const result = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(result.entries[0].status, 'up-to-date')
  assert.equal(result.entries[0].reason, 'older-version')
})

test('1000 unchanged mods cost one provider call and no re-hash when warm', async () => {
  const dir = tempDir('scale')
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  const entries = {}
  for (let index = 0; index < 1000; index += 1) {
    const buffer = Buffer.from(`scale-${index}`)
    const file = `mods/scale-${index}.jar`
    fs.writeFileSync(path.join(dir, file), buffer)
    const hash = sha1(buffer)
    entries[hash] = {
      sha1: hash,
      paths: [file],
      provider: 'modrinth',
      projectId: `P${index}`,
      versionId: 'v1',
      channel: 'release',
      installedAt: 1,
    }
  }
  fs.writeFileSync(
    path.join(dir, 'mods.ledger.json'),
    JSON.stringify({ version: 1, updatedAt: 1, entries }),
  )
  const provider = {
    id: 'modrinth',
    calls: 0,
    async checkUpdates(files) {
      this.calls += 1
      assert.equal(files.length, 1000)
      return new Map(
        files.map((file) => [
          file.key,
          { projectId: file.projectId, versionId: 'v1', channel: 'release' },
        ]),
      )
    },
  }
  const first = await checkInstalledUpdates({
    instanceDir: dir,
    ledger: new ModLedger(dir),
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(provider.calls, 1)
  assert.equal(first.checked, 1000)
  assert.equal(first.hashed, 1000)

  const second = await checkInstalledUpdates({
    instanceDir: dir,
    ledger: new ModLedger(dir),
    provider,
    target,
    now: () => 2_000,
  })
  assert.equal(provider.calls, 1)
  assert.equal(second.checked, 1000)
  assert.equal(second.hashed, 0)
  assert.equal(second.cached, 1000)
})

test('an offline provider leaves the ledger state as stale instead of failing', async () => {
  const fixture = installed('offline')
  const ledger = await seed(fixture.dir, fixture.record)
  const online = new FakeProvider({
    [fixture.sha1]: { projectId: 'P', versionId: 'v2', channel: 'release' },
  })
  await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider: online,
    target,
    now: () => 1_000,
  })
  const offline = {
    id: 'modrinth',
    async checkUpdates() {
      throw new Error('network down')
    },
  }
  const result = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger: new ModLedger(fixture.dir),
    provider: offline,
    target,
    refresh: true,
    now: () => 2_000,
  })
  assert.equal(result.offline, true)
  assert.equal(result.entries[0].status, 'update-available')
  assert.equal(result.entries[0].reason, 'stale')
  assert.equal(result.entries[0].stale, true)
  assert.equal(result.entries[0].candidate.versionId, 'v2')
})

test('an aborted check stops before asking the provider', async () => {
  const fixture = installed('aborted')
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new FakeProvider({})
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    checkInstalledUpdates({
      instanceDir: fixture.dir,
      ledger,
      provider,
      target,
      signal: controller.signal,
      now: () => 1_000,
    }),
    (error) => error.code === 'aborted',
  )
  assert.equal(provider.calls.length, 0)
})

test('Modrinth update_many normalizes its hash -> versions array response', async () => {
  const hash = 'a'.repeat(40)
  const client = new ModrinthClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          [hash]: [
            {
              id: 'v2',
              project_id: 'P',
              name: 'two',
              version_number: '2',
              game_versions: ['1.20.1'],
              loaders: ['fabric'],
              files: [
                {
                  hashes: { sha1: hash },
                  url: 'https://example.invalid/two.jar',
                  filename: 'two.jar',
                  primary: true,
                },
              ],
              dependencies: [],
              date_published: '2026-01-01T00:00:00Z',
              version_type: 'release',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  const result = await client.updateMany([hash], target, ['release'])
  assert.equal(result[hash].id, 'v2')
  assert.equal(result[hash].channel, 'release')
})

function modrinthVersion(id, channel) {
  return {
    id,
    projectId: 'P',
    name: id,
    versionNumber: id,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    files: [{ id: `${id}-file`, filename: `${id}.jar`, primary: true, url: `https://example.invalid/${id}.jar` }],
    dependencies: [],
    publishedAt: '2026-01-01T00:00:00Z',
    channel,
  }
}

test('Modrinth falls back release -> beta -> alpha only as far as needed', async () => {
  const calls = []
  const client = {
    async updateMany(hashes, _target, versionTypes) {
      calls.push(versionTypes)
      if (versionTypes.length === 1 && versionTypes[0] === 'release') return {}
      if (versionTypes.includes('beta')) {
        return { [hashes[0]]: modrinthVersion('v-beta', 'beta') }
      }
      return {}
    },
  }
  const provider = new ModrinthProvider(client)
  const result = await provider.checkUpdates(
    [{ key: 'aaaa', projectId: 'P', sha1: 'a'.repeat(40), channel: 'release' }],
    target,
  )
  assert.deepEqual(calls, [['release'], ['beta']])
  assert.equal(result.get('aaaa').versionId, 'v-beta')
  assert.equal(result.get('aaaa').channel, 'beta')
})

test('Modrinth stops at release when a release exists', async () => {
  const calls = []
  const client = {
    async updateMany(hashes, _target, versionTypes) {
      calls.push(versionTypes)
      return { [hashes[0]]: modrinthVersion('v-release', 'release') }
    },
  }
  const provider = new ModrinthProvider(client)
  const result = await provider.checkUpdates(
    [{ key: 'aaaa', projectId: 'P', sha1: 'a'.repeat(40), channel: 'release' }],
    target,
  )
  assert.deepEqual(calls, [['release']])
  assert.equal(result.get('aaaa').versionId, 'v-release')
})

function curseForgeClient(indexes) {
  return {
    async filesByIds() {
      return [{ id: 100, modId: 10, fileName: 'old.jar', fileDate: '', releaseType: 1 }]
    },
    async mods() {
      return [{ id: 10, latestFilesIndexes: indexes }]
    },
  }
}

test('CurseForge prefers the latest release over a newer alpha', async () => {
  const provider = new CurseForgeProvider(
    curseForgeClient([
      { gameVersion: '1.20.1', fileId: 103, filename: 'alpha.jar', releaseType: 3, modLoader: 4 },
      { gameVersion: '1.20.1', fileId: 101, filename: 'release.jar', releaseType: 1, modLoader: 4 },
    ]),
  )
  const result = await provider.checkUpdates(
    [{ key: 'sha', projectId: '10', fileId: '100', channel: 'release' }],
    target,
  )
  assert.equal(result.get('sha').versionId, '101')
  assert.equal(result.get('sha').channel, 'release')
})

test('CurseForge filters indexes by Minecraft version and loader', async () => {
  const provider = new CurseForgeProvider(
    curseForgeClient([
      { gameVersion: '1.21.1', fileId: 200, filename: 'new-mc.jar', releaseType: 1, modLoader: 4 },
      { gameVersion: '1.20.1', fileId: 201, filename: 'forge.jar', releaseType: 1, modLoader: 1 },
      { gameVersion: '1.20.1', fileId: 202, filename: 'fabric.jar', releaseType: 1, modLoader: 4 },
    ]),
  )
  const result = await provider.checkUpdates(
    [{ key: 'sha', projectId: '10', fileId: '100', channel: 'release' }],
    target,
  )
  assert.equal(result.get('sha').versionId, '202')
})

function curseForgeClientWithFiles(files, indexes) {
  const byId = new Map(files.map((file) => [file.id, file]))
  return {
    async filesByIds(ids) {
      return ids.map((id) => byId.get(id)).filter(Boolean)
    },
    async mods() {
      return [{ id: 238222, latestFilesIndexes: indexes }]
    },
  }
}

test('CurseForge candidates carry the file date the API returns', async () => {
  const provider = new CurseForgeProvider(
    curseForgeClientWithFiles(
      [
        { id: 100, modId: 238222, fileName: 'old.jar', fileDate: '2023-01-01T00:00:00Z', releaseType: 1 },
        { id: 101, modId: 238222, fileName: 'new.jar', fileDate: '2026-05-05T10:00:00Z', releaseType: 1 },
      ],
      [{ gameVersion: '1.20.1', fileId: 101, filename: 'new.jar', releaseType: 1, modLoader: 4 }],
    ),
  )
  const result = await provider.checkUpdates(
    [{ key: 'sha', projectId: '238222', fileId: '100', channel: 'release' }],
    target,
  )
  assert.equal(result.get('sha').publishedAt, '2026-05-05T10:00:00Z')
})

test('an older CurseForge candidate is never offered as an update', async () => {
  // Real JEI data (project 238222). The installed file is the newer 1.20.1/fabric
  // beta 9298210 (2026-10-23); the only index entry left for that pair is the older
  // release 8778010 (2026-08-31), which is what a stale index looks like. The file
  // date is the only signal that separates this from a real update.
  const fixture = installed('cf-older', {
    provider: 'curseforge',
    projectId: '238222',
    fileId: '9298210',
    versionId: '9298210',
    channel: 'release',
    publishedAt: '2026-10-23T14:03:53.52Z',
  })
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = new CurseForgeProvider(
    curseForgeClientWithFiles(
      [
        {
          id: 9298210,
          modId: 238222,
          fileName: 'jei-1.20.1-fabric-15.74.0.229.jar',
          fileDate: '2026-10-23T14:03:53.52Z',
          releaseType: 2,
        },
        {
          id: 8778010,
          modId: 238222,
          fileName: 'jei-1.20.1-fabric-15.56.0.205.jar',
          fileDate: '2026-08-31T13:57:07.527Z',
          releaseType: 1,
        },
      ],
      [
        {
          gameVersion: '1.20.1',
          fileId: 8778010,
          filename: 'jei-1.20.1-fabric-15.56.0.205.jar',
          releaseType: 1,
          modLoader: 4,
        },
      ],
    ),
  )
  const candidate = (
    await provider.checkUpdates(
      [{ key: fixture.sha1, projectId: '238222', fileId: '9298210', channel: 'release' }],
      target,
    )
  ).get(fixture.sha1)
  assert.equal(candidate.versionId, '8778010')
  assert.equal(candidate.publishedAt, '2026-08-31T13:57:07.527Z')

  const result = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(result.entries[0].status, 'up-to-date')
  assert.equal(result.entries[0].reason, 'older-version')
  assert.equal(result.updates.length, 0)
})

test('records belonging to another provider are skipped, not counted as unresolved', async () => {
  const mine = installed('mine')
  const ledger = await seed(mine.dir, mine.record)
  const foreign = jar({ 'mod.json': 'foreign' })
  fs.writeFileSync(path.join(mine.dir, 'mods', 'foreign.jar'), foreign)
  await ledger.upsert({
    sha1: sha1(foreign),
    paths: ['mods/foreign.jar'],
    provider: 'curseforge',
    projectId: '10',
    fileId: '100',
    versionId: '100',
    installedAt: 1,
  })
  const provider = new FakeProvider({ [mine.sha1]: { projectId: 'P', versionId: 'v1', channel: 'release' } })
  const result = await checkInstalledUpdates({
    instanceDir: mine.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  const foreignEntry = result.entries.find((entry) => entry.fileName === 'foreign.jar')
  assert.equal(foreignEntry.status, 'skipped')
  assert.equal(foreignEntry.reason, 'provider-mismatch')
  assert.equal(result.unresolved, 0)
  assert.equal(provider.calls[0].length, 1)
})

test('a failing provider reports its cause instead of reporting a silent offline', async () => {
  const fixture = installed('broken-provider')
  const ledger = await seed(fixture.dir, fixture.record)
  const provider = {
    id: 'modrinth',
    async checkUpdates() {
      throw new TypeError('adapter bug')
    },
  }
  const result = await checkInstalledUpdates({
    instanceDir: fixture.dir,
    ledger,
    provider,
    target,
    now: () => 1_000,
  })
  assert.equal(result.offline, true)
  assert.match(result.offlineCause, /TypeError: adapter bug/)
  assert.equal(result.entries[0].status, 'unresolved')
})
