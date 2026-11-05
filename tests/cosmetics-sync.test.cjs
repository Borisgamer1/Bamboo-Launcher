const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { readConfig, syncFile, syncStatus, writeInstanceSync } = require(
  '../dist-electron/cosmetics/sync.js',
)

const URL = 'https://demo-project.supabase.co'
const KEY = `sb_publishable_${'a'.repeat(24)}`

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bamboo-sync-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const withMod = path.join(root, 'instances', 'with-mod')
  const withoutMod = path.join(root, 'instances', 'without-mod')
  await fs.mkdir(path.join(withMod, 'mods'), { recursive: true })
  await fs.mkdir(withoutMod, { recursive: true })
  await fs.writeFile(path.join(withMod, 'mods', 'bamboo-cosmetics-26.3-fabric.jar'), '')
  return { root, withMod, withoutMod }
}

/** The shipped pair is a build constant; the env override is how a test points at one. */
function project(t) {
  process.env.BAMBOO_SUPABASE_URL = `${URL}/`
  process.env.BAMBOO_SUPABASE_KEY = KEY
  t.after(() => {
    delete process.env.BAMBOO_SUPABASE_URL
    delete process.env.BAMBOO_SUPABASE_KEY
  })
}

test('the project pair lands in bamboo/sync.json of every instance', async (t) => {
  project(t)
  const { withMod, withoutMod } = await workspace(t)

  const config = await readConfig()
  assert.deepEqual(config, { supabaseUrl: URL, anonKey: KEY })
  assert.equal(syncFile(withMod), path.join(withMod, 'bamboo', 'sync.json'))
  for (const directory of [withMod, withoutMod]) {
    assert.equal(await writeInstanceSync(directory, config), true)
    const document = JSON.parse(await fs.readFile(syncFile(directory), 'utf8'))
    assert.deepEqual(document, { enabled: true, supabaseUrl: URL, anonKey: KEY })
  }

  const status = await syncStatus([withMod, withoutMod])
  assert.equal(status.configured, true)
  assert.deepEqual(status.instances, { total: 2, ready: 1, missingMod: 1 })
})

test('readiness needs both the mod jar and a readable sync.json', async (t) => {
  project(t)
  const { withMod, withoutMod } = await workspace(t)
  const config = await readConfig()
  for (const directory of [withMod, withoutMod]) {
    await writeInstanceSync(directory, config)
  }

  await fs.rm(syncFile(withoutMod))
  let status = await syncStatus([withMod, withoutMod])
  assert.equal(status.instances.ready, 1)
  assert.equal(status.instances.missingMod, 0)

  await fs.rm(path.join(withMod, 'mods', 'bamboo-cosmetics-26.3-fabric.jar'))
  status = await syncStatus([withMod, withoutMod])
  assert.equal(status.instances.ready, 0)

  await fs.writeFile(syncFile(withMod), '{not json')
  status = await syncStatus([withMod, withoutMod])
  assert.equal(status.instances.ready, 0)
})

test('a hand-disabled sync.json does not count as ready', async (t) => {
  project(t)
  const { withMod } = await workspace(t)
  await writeInstanceSync(withMod, await readConfig())
  await fs.writeFile(
    syncFile(withMod),
    JSON.stringify({ enabled: false, supabaseUrl: URL, anonKey: KEY }),
  )

  const status = await syncStatus([withMod])
  assert.equal(status.configured, true)
  assert.equal(status.instances.ready, 0)
})

test('a build without a project writes nothing and says so', async (t) => {
  // The shipped build carries the project; an empty override is the documented
  // way to reach the "no project" state.
  process.env.BAMBOO_SUPABASE_URL = ''
  process.env.BAMBOO_SUPABASE_KEY = ''
  t.after(() => {
    delete process.env.BAMBOO_SUPABASE_URL
    delete process.env.BAMBOO_SUPABASE_KEY
  })
  const { withMod } = await workspace(t)

  assert.equal(await readConfig(), null)
  assert.equal(await writeInstanceSync(withMod, null), false)
  await assert.rejects(() => fs.stat(syncFile(withMod)))

  const status = await syncStatus([withMod])
  assert.equal(status.configured, false)
  assert.deepEqual(status.instances, { total: 1, ready: 0, missingMod: 0 })
})

test('a malformed project URL is not a project', async (t) => {
  process.env.BAMBOO_SUPABASE_URL = 'not-a-url'
  process.env.BAMBOO_SUPABASE_KEY = KEY
  t.after(() => {
    delete process.env.BAMBOO_SUPABASE_URL
    delete process.env.BAMBOO_SUPABASE_KEY
  })

  assert.equal(await readConfig(), null)
  assert.equal((await syncStatus([])).configured, false)
})
