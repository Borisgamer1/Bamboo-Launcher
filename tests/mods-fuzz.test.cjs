/**
 * Phase 6 robustness tests: hostile paths, hostile jars and archives, malicious
 * metadata in the resolver (huge dependency lists, depth bombs, cycles, ~10.000
 * edges) and hostile provider payloads. Every case asserts a bounded, typed
 * outcome — never a hang, a crash or a path outside the instance root.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const AdmZip = require('adm-zip')
const { fixtureServer, jar, sha1, tempDir } = require('./harness.cjs')

const {
  ModContentStore,
  ModError,
  ModrinthClient,
  ModrinthProvider,
  curseForgeFingerprint,
  readModMetadataList,
  readModpackFormat,
  readMrpackManifest,
  resolveModPlan,
} = require('../dist-electron/mods/index.js')
const { MAX_FILENAME_BYTES, resolveFileInside, resolveInside } = require(
  '../dist-electron/mods/paths.js',
)

const ROOT = 'C:/fuzz/instance'

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** The invariant every hostile input has to satisfy. */
function guardRejectsOrStaysInside(label, resolve) {
  let target
  try {
    target = resolve()
  } catch (error) {
    assert.ok(
      error instanceof ModError && error.code === 'unsafe-path',
      `${label}: expected unsafe-path, got ${error && error.name}:${error && error.code}`,
    )
    return 'rejected'
  }
  assert.ok(isInside(ROOT, target), `${label}: escaped the root to ${target}`)
  return 'inside'
}

test('hostile paths are rejected or stay inside the instance root', () => {
  const filenames = [
    '..',
    '../evil.jar',
    '..\\evil.jar',
    'a/../../evil.jar',
    '/etc/passwd',
    'C:\\Windows\\evil.jar',
    'mods/../../evil.jar',
    '',
    '.',
    '\\server\share\evil.jar',
    'sub/dir/mod.jar',
    'a\u0000b.jar',
    'a\u001fb.jar',
    `${'x'.repeat(MAX_FILENAME_BYTES + 45)}.jar`,
    '../../../../../../etc/shadow',
  ]
  const outcomes = filenames.map((name) =>
    guardRejectsOrStaysInside(JSON.stringify(name.slice(0, 40)), () =>
      resolveFileInside(ROOT, 'mods', name),
    ),
  )
  // The unusable ones must be rejected outright, not handed to the filesystem.
  assert.equal(outcomes[0], 'rejected', 'parent directory')
  assert.equal(outcomes[11], 'rejected', 'NUL byte')
  assert.equal(outcomes[12], 'rejected', 'control character')
  assert.equal(outcomes[13], 'rejected', 'over-long filename')
  assert.equal(filenames.length, outcomes.length)

  const segments = [
    ['mods', '..', '..', 'evil.jar'],
    ['mods/../../evil.jar'],
    ['mods', 'a\u0000b.jar'],
    ['C:\\Windows\\evil.jar'],
    ['mods', 'sub/../../evil.jar'],
  ]
  for (const parts of segments) {
    const outcome = guardRejectsOrStaysInside(parts.join('|'), () => resolveInside(ROOT, ...parts))
    assert.ok(outcome === 'rejected' || outcome === 'inside')
  }
  // Plain content stays usable.
  assert.equal(
    resolveFileInside(ROOT, 'mods', 'MOD-1.2.3.jar'),
    path.resolve(ROOT, 'mods', 'MOD-1.2.3.jar'),
  )
  assert.equal(
    resolveInside(ROOT, 'mods/sub/mod.jar'),
    path.resolve(ROOT, 'mods/sub/mod.jar'),
  )
})

test('the content store refuses hostile destinations and keeps its objects', async () => {
  const dir = tempDir('fuzz-store')
  try {
    const store = new ModContentStore({ root: dir })
    const source = path.join(dir, 'source.jar')
    const body = jar({ 'fabric.mod.json': '{"id":"fuzz","version":"1"}' })
    fs.writeFileSync(source, body)
    const adopted = await store.adopt(source, { sha1: sha1(body) })
    const instanceDir = path.join(dir, 'instance')
    fs.mkdirSync(instanceDir, { recursive: true })

    for (const hostile of [
      { folder: '..', filename: 'evil.jar' },
      { folder: 'mods/../../..', filename: 'evil.jar' },
      { folder: 'mods', filename: '../evil.jar' },
      { folder: 'mods', filename: 'sub/evil.jar' },
      { folder: 'mods', filename: 'evil\u0000.jar' },
    ]) {
      await assert.rejects(
        () =>
          store.commit({
            instanceDir,
            folder: hostile.folder,
            filename: hostile.filename,
            sha1: adopted.sha1,
            sha512: adopted.sha512,
            size: adopted.bytes,
            ledger: undefined,
          }),
        (error) => error instanceof ModError && error.code === 'unsafe-path',
        JSON.stringify(hostile),
      )
      assert.equal(fs.existsSync(path.join(dir, 'evil.jar')), false)
    }
    assert.equal(await store.has(adopted.sha512), true, 'the object itself survives')
    assert.deepEqual(
      fs.readdirSync(instanceDir),
      [],
      'a rejected commit leaves the instance empty',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hostile jars are ignored, never fatal', async () => {
  const dir = tempDir('fuzz-jars')
  try {
    const real = jar({ 'fabric.mod.json': '{"id":"real","version":"1.0.0"}' })
    const nested = jar({
      'META-INF/jars/inner.jar': real,
      'fabric.mod.json': '{"id":"outer","version":"1"}',
    })
    // One level deep is the contract: the packaged jar's metadata is read, the jar
    // packaged *inside* it is not, so the bomb cannot grow the work per level.
    const bomb = jar({
      'META-INF/jars/nested.jar': jar({
        'fabric.mod.json': '{"id":"nested-only","version":"1"}',
        'META-INF/jars/deeper.jar': real,
      }),
    })
    const payloads = {
      'empty.jar': Buffer.alloc(0),
      'random.jar': Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256)),
      'truncated.jar': real.subarray(0, Math.floor(real.length / 2)),
      'no-metadata.jar': jar({ 'assets/logo.png': 'png' }),
      'traversal.jar': jar({ '../../evil.json': '{"id":"evil"}' }),
      'huge.jar': jar({ 'fabric.mod.json': `{"id":"huge","version":"1","x":"${'a'.repeat(200_000)}"}` }),
      'nested.jar': nested,
      'bomb.jar': bomb,
    }
    for (const [name, payload] of Object.entries(payloads)) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, payload)
      const started = Date.now()
      const parsed = await readModMetadataList(file)
      assert.ok(Array.isArray(parsed), `${name}: expected an array`)
      assert.ok(Date.now() - started < 5_000, `${name}: took too long`)
      for (const mod of parsed) assert.equal(typeof mod.id, 'string', `${name}: id`)
    }
    assert.deepEqual(await readModMetadataList(path.join(dir, 'empty.jar')), [])
    assert.deepEqual(await readModMetadataList(path.join(dir, 'no-metadata.jar')), [])
    assert.equal(
      (await readModMetadataList(path.join(dir, 'nested.jar'))).length,
      2,
      'the packaged jar is read one level deep',
    )
    const bombed = await readModMetadataList(path.join(dir, 'bomb.jar'))
    assert.equal(bombed.length, 1, 'a nested jar is never unpacked recursively')
    assert.equal(bombed[0].id, 'nested-only', 'the packaged jar is the one that is read')

    // A directory of only hostile jars still scans without a single throw.
    const scanDir = path.join(dir, 'mods')
    fs.mkdirSync(scanDir, { recursive: true })
    for (const [name, payload] of Object.entries(payloads)) {
      fs.writeFileSync(path.join(scanDir, name), payload)
    }
    const empty = await readModMetadataList(path.join(scanDir, 'random.jar'))
    assert.deepEqual(empty, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the murmur2 fingerprint never throws and always returns a uint32', () => {
  const real = jar({ 'fabric.mod.json': '{"id":"fp","version":"1"}' })
  const samples = {
    empty: Buffer.alloc(0),
    one: Buffer.from([0x00]),
    stripped: Buffer.from([0x09, 0x0a, 0x0d, 0x20, 0x09, 0x0a]),
    random: Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 131) % 256)),
    jar: real,
    truncated: real.subarray(0, 17),
  }
  for (const [name, bytes] of Object.entries(samples)) {
    const first = curseForgeFingerprint(bytes)
    const second = curseForgeFingerprint(bytes)
    assert.ok(Number.isInteger(first), `${name}: not an integer`)
    assert.ok(first >= 0 && first <= 0xffffffff, `${name}: out of uint32 range (${first})`)
    assert.equal(first, second, `${name}: not deterministic`)
  }
  // Bytes the algorithm strips must not change the result.
  const base = Buffer.from('abcdefgh')
  const padded = Buffer.concat([base, Buffer.from([0x09, 0x0a, 0x0d, 0x20])])
  assert.equal(curseForgeFingerprint(base), curseForgeFingerprint(padded))
})

test('hostile archives are reported as such, not parsed', async () => {
  const dir = tempDir('fuzz-archives')
  try {
    const real = jar({ 'modrinth.index.json': '{"name":"Pack","dependencies":{},"files":[]}' })
    const files = {
      'garbage.mrpack': Buffer.from('not a zip at all'),
      'empty.mrpack': Buffer.alloc(0),
      'truncated.mrpack': real.subarray(0, Math.floor(real.length / 2)),
    }
    for (const [name, payload] of Object.entries(files)) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, payload)
      await assert.rejects(
        () => readModpackFormat(file),
        (error) => error instanceof ModError && error.code === 'not-a-modpack',
        name,
      )
    }

    const noManifest = path.join(dir, 'nomanifest.zip')
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('hello'))
    zip.writeZip(noManifest)
    await assert.rejects(
      () => readModpackFormat(noManifest),
      (error) => error instanceof ModError && error.code === 'not-a-modpack',
    )

    const badIndex = path.join(dir, 'badindex.mrpack')
    const badZip = new AdmZip()
    badZip.addFile('modrinth.index.json', Buffer.from('{"name":'))
    badZip.writeZip(badIndex)
    await assert.rejects(
      () => readMrpackManifest(badIndex),
      (error) => error instanceof ModError && error.code === 'invalid-manifest',
    )
    await assert.rejects(
      () => readMrpackManifest(noManifest),
      (error) => error instanceof ModError && error.code === 'not-a-modpack',
    )

    // A 10.000-file index parses in bounded time instead of exploding.
    const hugeIndex = path.join(dir, 'huge.mrpack')
    const hugeZip = new AdmZip()
    const manifest = {
      name: 'Huge',
      dependencies: { minecraft: '1.20.1' },
      files: Array.from({ length: 10_000 }, (_, i) => ({
        path: `mods/mod-${i}.jar`,
        downloads: [`https://example.invalid/${i}.jar`],
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        fileSize: 1024,
      })),
    }
    hugeZip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(manifest)))
    hugeZip.writeZip(hugeIndex)
    const started = Date.now()
    const parsed = await readMrpackManifest(hugeIndex)
    const elapsed = Date.now() - started
    assert.equal(parsed.files.length, 10_000)
    assert.ok(elapsed < 5_000, `10.000 files took ${elapsed}ms`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

let clock = 0

function version(id, projectId, dependencies = []) {
  clock += 1
  return {
    id,
    projectId,
    name: id,
    versionNumber: id,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    files: [{ filename: `${id}.jar`, url: `https://example.invalid/${id}.jar` }],
    dependencies,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    channel: 'release',
  }
}

const dep = (projectId, type = 'required') => ({ projectId, type })

class FakeProvider {
  id = 'modrinth'

  constructor(projects) {
    this.projects = projects
    this.calls = 0
  }

  async versions(projectId) {
    this.calls += 1
    return this.projects[projectId] ?? []
  }

  async version(_projectId, versionId) {
    const found = Object.values(this.projects)
      .flat()
      .find((entry) => entry.id === versionId)
    if (!found) throw new ModError('provider-error', `missing ${versionId}`)
    return found
  }

  async project(projectId) {
    return { id: projectId, slug: projectId, title: projectId, provider: 'modrinth' }
  }
}

const target = { minecraftVersion: '1.20.1', loader: 'fabric' }
const resolve = (projects, options = {}) =>
  resolveModPlan({
    provider: new FakeProvider(projects),
    projectId: 'A',
    target,
    now: () => 1,
    ...options,
  })

async function timed(label, work) {
  const started = Date.now()
  const value = await work()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 20_000, `${label}: ${elapsed}ms is not a bounded run`)
  console.log(`    [fuzz] ${label}: ${elapsed}ms`)
  return value
}

test('a 10.000-entry dependency list is capped by default and resolved when raised', async () => {
  const projects = { A: [version('a1', 'A', Array.from({ length: 10_000 }, (_, i) => dep(`D${i}`)))] }
  for (let i = 0; i < 10_000; i += 1) projects[`D${i}`] = [version(`d${i}`, `D${i}`)]

  await assert.rejects(
    () => timed('10k deps, default cap', () => resolve(projects)),
    (error) => error instanceof ModError && error.code === 'resolution-limit',
  )
  const plan = await timed('10k deps, cap raised', () =>
    resolve(projects, { maxNodes: 20_000, maxDepth: 20_000 }),
  )
  assert.equal(plan.install.length, 10_000)
  assert.equal(plan.cycles.length, 0)
  assert.equal(plan.unresolved.length, 0)
})

test('a 10.000-deep chain hits the depth limit and stays bounded', async () => {
  const projects = {}
  for (let i = 1; i <= 10_000; i += 1) {
    projects[`B${i}`] = [version(`b${i}`, `B${i}`, i < 10_000 ? [dep(`B${i + 1}`)] : [])]
  }
  projects.A = [version('a1', 'A', [dep('B1')])]

  await assert.rejects(
    () => timed('10k chain, default depth', () => resolve(projects)),
    (error) => error instanceof ModError && error.code === 'resolution-limit',
  )
  const plan = await timed('10k chain, depth raised', () =>
    resolve(projects, { maxNodes: 20_000, maxDepth: 20_000 }),
  )
  assert.equal(plan.install.length, 10_000)
  assert.equal(plan.install[9_999].depth, 10_000)
})

test('cycles in malicious metadata are reported and terminate', async () => {
  const mutual = await timed('mutual cycle', () =>
    resolve({
      A: [version('a1', 'A', [dep('B')])],
      B: [version('b1', 'B', [dep('A')])],
    }),
  )
  assert.equal(mutual.cycles.length, 1)
  assert.deepEqual(mutual.cycles[0].slice().sort(), ['A', 'B', 'A'].slice().sort())
  assert.equal(mutual.install.length, 1)

  const self = await timed('self cycle', () => resolve({ A: [version('a1', 'A', [dep('A')])] }))
  assert.deepEqual(self.cycles, [['A', 'A']])
  assert.equal(self.install.length, 0)

  // 500 projects pointing back at the primary: still one finite answer.
  const star = { A: [version('a1', 'A', Array.from({ length: 500 }, (_, i) => dep(`S${i}`)))] }
  for (let i = 0; i < 500; i += 1) star[`S${i}`] = [version(`s${i}`, `S${i}`, [dep('A')])]
  const starPlan = await timed('500 back-edges', () => resolve(star, { maxNodes: 5_000 }))
  assert.equal(starPlan.install.length, 500)
  assert.equal(starPlan.cycles.length, 1)
  assert.equal(starPlan.cycles[0][0], 'A')
  assert.equal(starPlan.cycles[0].at(-1), 'A')
  assert.ok(starPlan.cycles[0].length >= 3)

  // A 10.000-node ring: the cycle diagnosis itself must not recurse to death.
  const ring = { A: [version('a1', 'A', [dep('R1')])] }
  for (let i = 1; i <= 10_000; i += 1) {
    ring[`R${i}`] = [version(`r${i}`, `R${i}`, [dep(i < 10_000 ? `R${i + 1}` : 'A')])]
  }
  const ringPlan = await timed('10.000-node ring', () =>
    resolve(ring, { maxNodes: 20_000, maxDepth: 20_000 }),
  )
  assert.equal(ringPlan.cycles.length, 1)
  assert.ok(ringPlan.cycles[0].length > 10_000)
  assert.equal(ringPlan.cycles[0][0], 'A')
  assert.equal(ringPlan.cycles[0].at(-1), 'A')
})

test('an incompatible storm cannot smuggle its target into the install plan', async () => {
  const deps = [dep('X')]
  for (let i = 0; i < 1_000; i += 1) deps.push(dep(`D${i}`))
  const projects = { A: [version('a1', 'A', deps)], X: [version('x1', 'X')] }
  for (let i = 0; i < 1_000; i += 1) {
    projects[`D${i}`] = [version(`d${i}`, `D${i}`, [dep('X', 'incompatible')])]
  }
  const plan = await timed('1.000 incompatible edges', () => resolve(projects, { maxNodes: 5_000 }))
  assert.equal(plan.blocked.length, 1_000)
  assert.equal(
    plan.install.some((entry) => entry.version.projectId === 'X'),
    false,
    'a blocked project must not be installed',
  )
  assert.equal(plan.primaryBlocked, false)
})

test('10.000 duplicate edges collapse into one install and bounded diagnostics', async () => {
  const deps = [dep('C')]
  for (let i = 0; i < 200; i += 1) deps.push(dep(`P${i}`))
  const projects = { A: [version('a1', 'A', deps)], C: [version('c1', 'C')] }
  for (let i = 0; i < 200; i += 1) {
    projects[`P${i}`] = [
      version(`p${i}`, `P${i}`, Array.from({ length: 50 }, () => dep('C'))),
    ]
  }
  const plan = await timed('10.000 duplicate edges', () => resolve(projects, { maxNodes: 5_000 }))
  assert.equal(plan.install.length, 201)
  assert.equal(
    plan.skipped.filter((entry) => entry.reason === 'duplicate-project').length,
    10_000,
    'every repeated edge is diagnosed, none is installed twice',
  )
  const child = plan.install.find((entry) => entry.version.projectId === 'C')
  assert.ok(child)
  assert.equal(
    child.requiredBy.length,
    201,
    'one requiredBy entry per distinct parent (the primary plus each P)',
  )
  assert.equal(
    new Set(child.requiredBy.map((key) => key.versionId)).size,
    201,
    'no parent is recorded twice',
  )
})

test('hostile provider payloads are bounded and typed', async () => {
  const hits = Array.from({ length: 2_000 }, (_, i) => ({
    project_id: `p${i}`,
    slug: `p${i}`,
    title: `P${i}`,
    description: null,
    project_type: 'mod',
    downloads: 'not-a-number',
    follows: null,
    versions: 42,
    date_modified: 12345,
    icon_url: 7,
  }))
  const server = await fixtureServer({
    '/search': (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.searchParams.get('query') === 'broken') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"hits": ')
        return
      }
      if (url.searchParams.get('query') === 'wrong-shape') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"hits": {}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          hits,
          offset: Number(url.searchParams.get('offset') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 20),
          total_hits: 2_000,
        }),
      )
    },
  })
  try {
    const provider = new ModrinthProvider(
      new ModrinthClient({ baseUrl: server.base, retry: { attempts: 1 } }),
    )
    const page = await timed('2.000 hostile hits', () =>
      provider.search({
        query: 'x'.repeat(5_000),
        projectType: 'mod',
        limit: 1_000_000,
        offset: -5,
      }),
    )
    assert.ok(page.hits.length <= 100, `limit not clamped: ${page.hits.length}`)
    assert.equal(page.hits[0].id, 'p0')
    for (const hit of page.hits) assert.equal(typeof hit.title, 'string')

    await assert.rejects(
      () => provider.search({ query: 'wrong-shape', projectType: 'mod', limit: 20 }, { bypassCache: true }),
      (error) => error instanceof ModError && error.code === 'provider-error',
    )
    await assert.rejects(
      () => provider.search({ query: 'broken', projectType: 'mod', limit: 20 }, { bypassCache: true }),
      (error) => error instanceof ModError && error.code === 'provider-error',
    )
  } finally {
    await server.close()
  }
})
