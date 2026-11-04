/**
 * Phase 2 resolver tests: deterministic required graph, cycle diagnosis,
 * conflicts, optional opt-in, incompatible blocks, external/unresolved and
 * hard limits. Fixtures only.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

const { ModError, resolveModPlan } = require('../dist-electron/mods/index.js')

let clock = 0

function version(id, projectId, dependencies = [], extra = {}) {
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
    ...extra,
  }
}

const dep = (projectId, type = 'required', extra = {}) => ({ projectId, type, ...extra })

class FakeProvider {
  id = 'modrinth'

  constructor(projects) {
    this.projects = projects
    this.versionCalls = 0
  }

  async versions(projectId) {
    this.versionCalls += 1
    return this.projects[projectId] ?? []
  }

  async version(_projectId, versionId) {
    const found = Object.values(this.projects)
      .flat()
      .find((entry) => entry.id === versionId)
    if (!found) throw new ModError('provider-error', `missing ${versionId}`)
    return found
  }

  async search() {
    throw new Error('unused')
  }

  async project(projectId) {
    return { id: projectId, slug: projectId, title: projectId, provider: 'modrinth' }
  }

  async filesByIds() {
    throw new Error('unused')
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

test('required graph installs transitively in depth order', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B')])],
    B: [version('b1', 'B', [dep('C')])],
    C: [version('c1', 'C')],
  }
  const plan = await resolve(projects)
  assert.equal(plan.primary.id, 'a1')
  assert.deepEqual(plan.install.map((entry) => entry.version.projectId), ['B', 'C'])
  assert.deepEqual(plan.install.map((entry) => entry.depth), [1, 2])
  assert.deepEqual(plan.install[0].requiredBy, [
    { provider: 'modrinth', projectId: 'A', versionId: 'a1' },
  ])
  assert.deepEqual(plan.cycles, [])
  assert.equal(plan.providerSnapshot.resolvedAt, 1)
  assert.equal(plan.resolverVersion, 1)
})

test('cycle A->B->A is diagnosed, planned once and never loops', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B')])],
    B: [version('b1', 'B', [dep('A', 'required', { versionId: 'a1' })])],
  }
  const plan = await resolve(projects)
  assert.deepEqual(plan.install.map((entry) => entry.version.projectId), ['B'])
  assert.deepEqual(plan.cycles, [['A', 'B', 'A']])
  assert.ok(plan.skipped.some((entry) => entry.reason === 'duplicate-project'))
})

test('two versions of one project become a conflict and the first plan wins', async () => {
  const projects = {
    A: [
      version('a1', 'A', [
        dep('B', 'required', { versionId: 'b1' }),
        dep('C'),
      ]),
    ],
    B: [version('b1', 'B'), version('b2', 'B')],
    C: [version('c1', 'C', [dep('B', 'required', { versionId: 'b2' })])],
  }
  const plan = await resolve(projects)
  assert.deepEqual(plan.install.map((entry) => entry.version.id), ['b1', 'c1'])
  assert.deepEqual(plan.conflicts, [
    {
      projectId: 'B',
      plannedVersionId: 'b1',
      requestedVersionId: 'b2',
      parent: { provider: 'modrinth', projectId: 'C', versionId: 'c1' },
    },
  ])
  assert.ok(plan.skipped.some((entry) => entry.reason === 'conflicting-dependency'))
})

test('duplicate requirements of the same version are deduped', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B'), dep('B'), dep('C')])],
    B: [version('b1', 'B')],
    C: [version('c1', 'C', [dep('B')])],
  }
  const plan = await resolve(projects)
  assert.deepEqual(plan.install.map((entry) => entry.version.projectId), ['B', 'C'])
  assert.equal(plan.install[0].requiredBy.length, 2)
  assert.equal(plan.conflicts.length, 0)
  assert.ok(plan.skipped.some((entry) => entry.reason === 'duplicate-project'))
})

test('missing and mismatched required dependencies are reported', async () => {
  const projects = {
    A: [
      version('a1', 'A', [
        dep('NOVERSIONS'),
        dep('PINNED', 'required', { versionId: 'gone' }),
        dep('WRONGPIN', 'required', { versionId: 'other1' }),
        { type: 'required', fileName: 'external.jar' },
      ]),
    ],
    PINNED: [version('p1', 'PINNED')],
    WRONGPIN: [version('other1', 'OTHER')],
  }
  const plan = await resolve(projects)
  assert.deepEqual(
    plan.unresolved.map((entry) => entry.reason),
    ['external-dependency', 'no-compatible-version', 'missing-version', 'version-project-mismatch'],
  )
  assert.equal(plan.install.length, 0)
})

test('primary pin must belong to the requested project', async () => {
  const projects = { A: [version('a1', 'A')], B: [version('b1', 'B')] }
  await assert.rejects(
    () => resolve(projects, { versionId: 'b1' }),
    (error) =>
      error instanceof ModError && error.code === 'version-project-mismatch',
  )
})

test('optional dependencies are recommendations unless opted in', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('O', 'optional'), dep('P', 'optional', { versionId: 'p2' })])],
    O: [version('o1', 'O')],
    P: [version('p1', 'P'), version('p2', 'P')],
  }
  const plan = await resolve(projects)
  assert.equal(plan.install.length, 0)
  assert.equal(plan.optional.length, 2)
  assert.equal(plan.conflicts.length, 0, 'optional entries never conflict')

  const optedIn = await resolve(projects, { optionalOptIn: ['O'] })
  assert.deepEqual(optedIn.install.map((entry) => entry.version.projectId), ['O'])
})

test('installed projects and incompatible targets are reported, not installed', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('I'), dep('X', 'incompatible')])],
    I: [version('i1', 'I')],
    X: [version('x1', 'X')],
  }
  const plan = await resolve(projects, { installed: [{ projectId: 'I', versionId: 'i1' }, { projectId: 'X' }] })
  assert.equal(plan.install.length, 0)
  assert.ok(plan.skipped.some((entry) => entry.reason === 'already-installed'))
  assert.deepEqual(plan.blocked, [
    {
      projectId: 'X',
      parent: { provider: 'modrinth', projectId: 'A', versionId: 'a1' },
      reason: 'incompatible',
    },
  ])
})

test('embedded, tool and include stay diagnosed instead of downloading', async () => {
  const projects = {
    A: [
      version('a1', 'A', [
        dep('E', 'embedded'),
        dep('T', 'tool'),
        dep('N', 'include'),
      ]),
    ],
  }
  const plan = await resolve(projects)
  assert.deepEqual(
    plan.skipped.map((entry) => entry.reason),
    ['embedded', 'include', 'tool'],
  )
  assert.equal(plan.install.length, 0)
})

test('quilt targets skip Fabric API', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('P7dR8mSH')], { loaders: ['quilt'] })],
  }
  const plan = await resolveModPlan({
    provider: new FakeProvider(projects),
    projectId: 'A',
    target: { minecraftVersion: '1.20.1', loader: 'quilt' },
    now: () => 1,
  })
  assert.deepEqual(plan.skipped, [
    {
      projectId: 'P7dR8mSH',
      parent: { provider: 'modrinth', projectId: 'A', versionId: 'a1' },
      reason: 'quilt-fabric-api',
    },
  ])
})

test('incompatible blocks a target planned later through another branch', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B'), dep('D')])],
    B: [version('b1', 'B', [dep('C', 'incompatible')])],
    D: [version('d1', 'D', [dep('C')])],
    C: [version('c1', 'C')],
  }
  const plan = await resolve(projects)
  assert.deepEqual(plan.install.map((entry) => entry.version.projectId), ['B', 'D'])
  assert.ok(!plan.install.some((entry) => entry.version.projectId === 'C'))
  assert.deepEqual(plan.blocked, [
    {
      projectId: 'C',
      parent: { provider: 'modrinth', projectId: 'B', versionId: 'b1' },
      reason: 'incompatible',
    },
  ])
  assert.equal(plan.primaryBlocked, false)
})

test('incompatible with only a version id is diagnosed', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B'), dep('C')])],
    B: [version('b1', 'B', [{ versionId: 'c1', type: 'incompatible' }])],
    C: [version('c1', 'C')],
  }
  const plan = await resolve(projects)
  assert.deepEqual(plan.blocked, [
    {
      projectId: 'C',
      versionId: 'c1',
      parent: { provider: 'modrinth', projectId: 'B', versionId: 'b1' },
      reason: 'incompatible',
    },
  ])

  const inactive = await resolve({
    A: [version('a1', 'A', [dep('B')])],
    B: [version('b1', 'B', [{ versionId: 'missing', type: 'incompatible' }])],
  })
  assert.deepEqual(inactive.blocked, [])
  assert.deepEqual(inactive.skipped, [
    {
      versionId: 'missing',
      parent: { provider: 'modrinth', projectId: 'B', versionId: 'b1' },
      reason: 'incompatible',
    },
  ])
})

test('a blocked primary is signalled explicitly', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('B')])],
    B: [version('b1', 'B', [dep('A', 'incompatible')])],
  }
  const plan = await resolve(projects)
  assert.equal(plan.primaryBlocked, true)
  assert.deepEqual(plan.blocked, [
    {
      projectId: 'A',
      parent: { provider: 'modrinth', projectId: 'B', versionId: 'b1' },
      reason: 'incompatible',
    },
  ])
})

test('already-installed skips record the installed version', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('I')])],
    I: [version('i1', 'I')],
  }
  const plan = await resolve(projects, { installed: [{ projectId: 'I', versionId: 'i1' }] })
  assert.deepEqual(plan.skipped, [
    {
      projectId: 'I',
      versionId: 'i1',
      parent: { provider: 'modrinth', projectId: 'A', versionId: 'a1' },
      reason: 'already-installed',
    },
  ])
  assert.equal(plan.primaryBlocked, false)
})

test('datapack-loader versions are accepted with a diagnosis', async () => {
  const projects = {
    A: [version('a1', 'A', [], { loaders: ['datapack'] })],
  }
  const plan = await resolve(projects)
  assert.equal(plan.primary.id, 'a1')
  assert.deepEqual(plan.datapackFallbacks, [
    { provider: 'modrinth', projectId: 'A', versionId: 'a1' },
  ])
})

test('node and depth limits fail with resolution-limit', async () => {
  const chain = {
    A: [version('a1', 'A', [dep('B')])],
    B: [version('b1', 'B', [dep('C')])],
    C: [version('c1', 'C')],
  }
  await assert.rejects(
    () => resolve(chain, { maxDepth: 1 }),
    (error) => error instanceof ModError && error.code === 'resolution-limit',
  )
  await assert.rejects(
    () => resolve(chain, { maxNodes: 2 }),
    (error) => error instanceof ModError && error.code === 'resolution-limit',
  )
})

test('a stalled provider times out with resolution-limit', async () => {
  const provider = {
    id: 'modrinth',
    versions: () => new Promise(() => {}),
  }
  await assert.rejects(
    () =>
      resolveModPlan({
        provider,
        projectId: 'A',
        target,
        providerTimeoutMs: 20,
      }),
    (error) => error instanceof ModError && error.code === 'resolution-limit',
  )
})

test('dependency order does not change the plan', async () => {
  const projects = {
    A: [version('a1', 'A', [dep('C'), dep('B')])],
    B: [version('b1', 'B')],
    C: [version('c1', 'C')],
  }
  const first = await resolve(projects)
  const second = await resolve(projects)
  assert.deepEqual(first, second)
  assert.deepEqual(first.install.map((entry) => entry.version.projectId), ['B', 'C'])
})
