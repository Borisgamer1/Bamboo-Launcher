/**
 * Phase 4 content store: adopt without any request, dedupe across instances,
 * reflink → hardlink → copy materialize, the ledger as the commit point,
 * migration without re-download, GC, and a real kill -9 crash check.
 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test } = require('node:test')

const { ModContentStore, ModLedger } = require('../dist-electron/mods/index.js')
const { jar, sha1, sha512, tempDir } = require('./harness.cjs')

const MODES = ['reflink', 'hardlink', 'copy']

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function withNetworkSpy(fn) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls += 1
    throw new Error('no network allowed here')
  }
  try {
    const value = await fn()
    return { value, calls }
  } finally {
    globalThis.fetch = original
  }
}

test('adopt stores an existing file without a single request', async () => {
  const store = new ModContentStore({ root: tempDir('store-adopt') })
  const instance = tempDir('store-adopt-instance')
  const body = jar({ 'mod.json': 'adopt' })
  const file = path.join(instance, 'mods', 'adopted.jar')
  write(file, body)

  const { value: adopted, calls } = await withNetworkSpy(() =>
    store.adopt(file, { sha1: sha1(body), sha512: sha512(body), bytes: body.length }),
  )
  assert.equal(calls, 0)
  assert.equal(adopted.created, true)
  assert.equal(adopted.sha1, sha1(body))
  assert.equal(adopted.sha512, sha512(body))
  assert.equal(adopted.bytes, body.length)
  assert.equal(adopted.link, 'hardlink')
  assert.ok(fs.existsSync(store.objectPath(adopted.sha512)))
  assert.deepEqual(fs.readFileSync(file), body)
  assert.equal((await store.catalog()).length, 1)
})

test('adopt rejects content that does not match and stores nothing', async () => {
  const store = new ModContentStore({ root: tempDir('store-reject') })
  const instance = tempDir('store-reject-instance')
  const file = path.join(instance, 'mods', 'liar.jar')
  write(file, jar({ 'mod.json': 'liar' }))
  await assert.rejects(
    store.adopt(file, { sha1: 'a'.repeat(40) }),
    (error) => error.code === 'content-changed',
  )
  assert.equal((await store.catalog()).length, 0)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.part')), [])
})

test('two instances share one stored object', async () => {
  const store = new ModContentStore({ root: tempDir('store-share') })
  const body = jar({ 'mod.json': 'shared' })
  const first = tempDir('store-share-a')
  const second = tempDir('store-share-b')
  write(path.join(first, 'mods', 'shared.jar'), body)
  write(path.join(second, 'mods', 'shared.jar'), body)

  const adoptedFirst = await store.adopt(path.join(first, 'mods', 'shared.jar'))
  const adoptedSecond = await store.adopt(path.join(second, 'mods', 'shared.jar'))
  assert.equal(adoptedFirst.created, true)
  assert.equal(adoptedSecond.created, false, 'identical content must not be stored twice')
  assert.equal((await store.catalog()).length, 1)

  const modeA = await store.materialize(adoptedFirst.sha512, path.join(first, 'mods', 'from-store.jar'))
  const modeB = await store.materialize(adoptedFirst.sha512, path.join(second, 'mods', 'from-store.jar'))
  console.log(`materialize mode on this machine: ${modeA} (second instance: ${modeB})`)
  assert.ok(MODES.includes(modeA) && MODES.includes(modeB))
  assert.deepEqual(fs.readFileSync(path.join(first, 'mods', 'from-store.jar')), body)
  assert.deepEqual(fs.readFileSync(path.join(second, 'mods', 'from-store.jar')), body)
  assert.equal((await store.catalog()).length, 1)

  const object = store.objectPath(adoptedFirst.sha512)
  if (modeA === 'hardlink') {
    assert.equal(fs.statSync(path.join(first, 'mods', 'from-store.jar')).ino, fs.statSync(object).ino)
    assert.ok(fs.statSync(object).nlink >= 2, 'a hardlinked object is shared on disk')
  }
})

test('materialize falls back to a real copy when the filesystem refuses links', async () => {
  const store = new ModContentStore({ root: tempDir('store-copy') })
  const body = jar({ 'mod.json': 'copy-fallback' })
  const staging = path.join(tempDir('store-copy-staging'), 'mod.jar')
  write(staging, body)
  const adopted = await store.adopt(staging)
  const destination = path.join(tempDir('store-copy-instance'), 'mods', 'copied.jar')

  // Reflink is refused by NTFS on this machine (see the share test above), so this
  // forces the last step of the chain by making hardlinks look unsupported too.
  const fsPromises = require('node:fs/promises')
  const realLink = fsPromises.link
  fsPromises.link = async () => {
    const error = new Error('hardlinks are not supported here')
    error.code = 'EPERM'
    throw error
  }
  let mode
  try {
    mode = await store.materialize(adopted.sha512, destination)
  } finally {
    fsPromises.link = realLink
  }

  assert.equal(mode, 'copy')
  assert.deepEqual(fs.readFileSync(destination), body)
  assert.notEqual(
    fs.statSync(destination).ino,
    fs.statSync(store.objectPath(adopted.sha512)).ino,
    'a copy owns its own bytes instead of sharing the object',
  )
  assert.deepEqual(fs.readdirSync(path.dirname(destination)).filter((n) => n.includes('.part')), [])
})

test('commit places the file, then records it, and rolls the file back on a failed ledger write', async () => {
  const store = new ModContentStore({ root: tempDir('store-commit') })
  const instance = tempDir('store-commit-instance')
  const body = jar({ 'mod.json': 'commit' })
  const staging = path.join(tempDir('store-staging'), 'mod.jar')
  write(staging, body)
  const adopted = await store.adopt(staging)

  const result = await store.commit({
    instanceDir: instance,
    folder: 'mods',
    filename: 'committed.jar',
    sha1: adopted.sha1,
    sha512: adopted.sha512,
    size: adopted.bytes,
    ledger: new ModLedger(instance),
    record: { provider: 'modrinth', projectId: 'P', versionId: 'v1', channel: 'release' },
  })
  assert.equal(result.recorded, true)
  assert.ok(MODES.includes(result.link))
  assert.deepEqual(fs.readFileSync(path.join(instance, 'mods', 'committed.jar')), body)

  const record = await new ModLedger(instance).get(adopted.sha1)
  assert.equal(record.sha512, adopted.sha512)
  assert.equal(record.size, body.length)
  assert.deepEqual(record.paths, ['mods/committed.jar'])
  assert.equal(record.projectId, 'P')
  assert.equal(record.stat.size, body.length)

  const failing = {
    async upsert() {
      throw new Error('ledger write failed')
    },
  }
  await assert.rejects(
    store.commit({
      instanceDir: instance,
      folder: 'mods',
      filename: 'rolled-back.jar',
      sha1: adopted.sha1,
      sha512: adopted.sha512,
      ledger: failing,
    }),
    /ledger write failed/,
  )
  assert.equal(fs.existsSync(path.join(instance, 'mods', 'rolled-back.jar')), false)

  await assert.rejects(
    store.commit({
      instanceDir: instance,
      folder: 'mods',
      filename: 'unknown.jar',
      sha1: adopted.sha1,
      sha512: 'b'.repeat(128),
    }),
    (error) => error.code === 'store-missing',
  )
})

test('migration adopts existing files without re-download and records them once', async () => {
  const instance = tempDir('store-migrate')
  const mods = path.join(instance, 'mods')
  const one = jar({ 'mod.json': 'one' })
  const two = jar({ 'mod.json': 'two' })
  write(path.join(mods, 'one.jar'), one)
  write(path.join(mods, 'two.jar'), two)
  write(path.join(mods, 'downloaded.jar.part-1234'), Buffer.from('partial'))
  const store = new ModContentStore({ root: tempDir('store-migrate-store') })
  const ledger = new ModLedger(instance)

  const { value: first, calls } = await withNetworkSpy(() =>
    store.migrateInstance({ instanceDir: instance, ledger }),
  )
  assert.equal(calls, 0, 'migration must never touch the network')
  assert.deepEqual(
    { scanned: first.scanned, adopted: first.adopted, recorded: first.recorded },
    { scanned: 2, adopted: 2, recorded: 2 },
  )
  assert.equal(first.objects, 2)
  assert.ok(first.bytes >= one.length + two.length)

  const records = await new ModLedger(instance).list()
  assert.deepEqual(
    records.map((record) => record.sha1).sort(),
    [sha1(one), sha1(two)].sort(),
  )
  for (const record of records) {
    assert.equal(record.sha512.length, 128)
    assert.equal(record.size > 0, true)
    assert.equal(record.paths.length, 1)
  }

  const second = await store.migrateInstance({ instanceDir: instance, ledger })
  assert.equal(second.adopted, 0)
  assert.equal(second.deduped, 2)
  assert.equal((await store.catalog()).length, 2)
  assert.deepEqual(fs.readFileSync(path.join(mods, 'one.jar')), one)
})

test('gc removes only objects no ledger references', async () => {
  const store = new ModContentStore({ root: tempDir('store-gc') })
  const kept = jar({ 'mod.json': 'kept' })
  const dropped = jar({ 'mod.json': 'dropped' })
  const staging = tempDir('store-gc-staging')
  write(path.join(staging, 'kept.jar'), kept)
  write(path.join(staging, 'dropped.jar'), dropped)
  const a = await store.adopt(path.join(staging, 'kept.jar'))
  const b = await store.adopt(path.join(staging, 'dropped.jar'))
  assert.equal((await store.catalog()).length, 2)

  const result = await store.gc([a.sha512])
  assert.equal(result.removed, 1)
  assert.equal(result.bytes, b.bytes)
  const remaining = await store.catalog()
  assert.deepEqual(remaining.map((object) => object.sha512), [a.sha512])
  assert.equal(fs.existsSync(store.objectPath(b.sha512)), false)
})

test('a killed process leaves a parseable ledger, intact objects and no orphan content', async () => {
  const instance = tempDir('store-crash')
  const storeRoot = tempDir('store-crash-store')
  const distIndex = path.join(__dirname, '..', 'dist-electron', 'mods', 'index.js')
  const source = `
    const fs = require('node:fs')
    const path = require('node:path')
    const crypto = require('node:crypto')
    const { ModContentStore, ModLedger } = require(${JSON.stringify(distIndex)})
    const store = new ModContentStore({ root: process.env.STORE_ROOT })
    const ledger = new ModLedger(process.env.INSTANCE_DIR)
    fs.mkdirSync(path.join(process.env.STORE_ROOT, 'staging'), { recursive: true })
    ;(async () => {
      for (let index = 0; index < 500; index += 1) {
        const staging = path.join(process.env.STORE_ROOT, 'staging', 'mod-' + index + '.jar')
        fs.writeFileSync(staging, crypto.randomBytes(48 * 1024 + index))
        const adopted = await store.adopt(staging)
        await store.commit({
          instanceDir: process.env.INSTANCE_DIR,
          folder: 'mods',
          filename: 'mod-' + index + '.jar',
          sha1: adopted.sha1,
          sha512: adopted.sha512,
          ledger,
          record: { provider: 'modrinth', projectId: 'P' + index },
        })
        process.stdout.write('tick ' + index + '\\n')
      }
    })().catch((error) => {
      console.error(error)
      process.exit(1)
    })
  `
  const child = spawn(process.execPath, ['-e', source], {
    env: { ...process.env, STORE_ROOT: storeRoot, INSTANCE_DIR: instance },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ticks = 0
  let stderr = ''
  child.stdout.on('data', (data) => {
    ticks += String(data).split('\n').filter((line) => line.startsWith('tick')).length
  })
  child.stderr.on('data', (data) => {
    stderr += String(data)
  })
  const deadline = Date.now() + 20_000
  while (ticks < 4 && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ticks >= 4, `child did not commit enough content: ${ticks} ticks, stderr=${stderr}`)
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))

  const store = new ModContentStore({ root: storeRoot })
  // The ledger is written through the project's atomic writer, which keeps the
  // previous revision as `.bak`; a kill can therefore land in the moment where the
  // current revision is the backup. Both revisions must stay readable.
  const ledgerFile = path.join(instance, 'mods.ledger.json')
  const backupFile = path.join(instance, 'mods.ledger.json.bak')
  assert.ok(
    fs.existsSync(ledgerFile) || fs.existsSync(backupFile),
    'a hard kill must not lose the ledger and its backup revision',
  )
  const revisions = [ledgerFile, backupFile].filter((file) => fs.existsSync(file))
  const parsed = JSON.parse(fs.readFileSync(revisions[0], 'utf8'))
  for (const revision of revisions) JSON.parse(fs.readFileSync(revision, 'utf8'))
  assert.equal(parsed.version, 1)
  const records = Object.values(parsed.entries)
  assert.ok(records.length >= 4)

  for (const record of records) {
    assert.match(record.sha1, /^[a-f0-9]{40}$/)
    assert.match(record.sha512, /^[a-f0-9]{128}$/)
    assert.equal(typeof record.size, 'number')
    assert.equal(typeof record.installedAt, 'number')
    assert.ok(record.paths.length >= 1)
    const file = path.join(instance, record.paths[0])
    assert.equal(fs.existsSync(file), true, `recorded file missing: ${record.paths[0]}`)
    const actual = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
    assert.equal(actual, record.sha1, `recorded file does not match its ledger entry: ${record.paths[0]}`)
  }

  const objects = await store.catalog()
  for (const object of objects) {
    const actual = crypto.createHash('sha512').update(fs.readFileSync(object.path)).digest('hex')
    assert.equal(actual, object.sha512, 'a torn object file reached the store')
  }
  assert.ok(objects.length >= records.length)

  const installed = fs
    .readdirSync(path.join(instance, 'mods'))
    .filter((name) => name.endsWith('.jar'))
  const recorded = new Set(records.flatMap((record) => record.paths.map((p) => path.basename(p))))
  const orphan = installed.filter((name) => !recorded.has(name))
  assert.ok(
    orphan.length <= 1,
    `at most the in-flight file may lack a ledger entry, found ${orphan.length}: ${orphan.join(', ')}`,
  )
  console.log(
    `crash check: ${records.length} ledger entries, ${installed.length} files, ` +
      `${orphan.length} unrecorded, ${objects.length} intact store objects`,
  )
})

test('concurrent writers into one instance keep every ledger entry', async () => {
  const instance = tempDir('store-concurrent')
  const staging = tempDir('store-concurrent-staging')
  const store = new ModContentStore({ root: tempDir('store-concurrent-store') })
  const adopted = []
  for (const index of [0, 1]) {
    const file = path.join(staging, `mod-${index}.jar`)
    write(file, jar({ 'mod.json': `concurrent-${index}` }))
    adopted.push(await store.adopt(file))
  }

  // Two handles on one ledger are the smallest form of the race, and the one that
  // loses an entry deterministically: the second writer must not save the snapshot
  // it read before the first writer stored its entry.
  const first = new ModLedger(instance)
  const second = new ModLedger(instance)
  await first.load()
  await second.load()
  await first.upsert({ sha1: adopted[0].sha1, paths: ['mods/a.jar'] })
  await second.upsert({ sha1: adopted[1].sha1, paths: ['mods/b.jar'] })
  assert.equal(
    (await new ModLedger(instance).list()).length,
    2,
    'a stale snapshot overwrote the other writer entry',
  )

  // The same race across two processes, both committing into the same instance at
  // the same moment: one commit used to overwrite the other's ledger entry and
  // leave its file unrecorded.
  const shared = tempDir('store-concurrent-proc')
  const root = tempDir('store-concurrent-proc-store')
  const barrier = path.join(root, 'go')
  const distIndex = path.join(__dirname, '..', 'dist-electron', 'mods', 'index.js')
  const source = `
    const fs = require('node:fs')
    const path = require('node:path')
    const crypto = require('node:crypto')
    const { ModContentStore, ModLedger } = require(${JSON.stringify(distIndex)})
    ;(async () => {
      const store = new ModContentStore({ root: process.env.STORE_ROOT })
      const staging = path.join(process.env.STORE_ROOT, 'staging', process.env.NAME + '.jar')
      fs.mkdirSync(path.dirname(staging), { recursive: true })
      fs.writeFileSync(staging, crypto.randomBytes(4096))
      const adopted = await store.adopt(staging)
      fs.writeFileSync(path.join(process.env.STORE_ROOT, 'ready-' + process.env.NAME), '')
      while (!fs.existsSync(process.env.BARRIER)) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await store.commit({
        instanceDir: process.env.INSTANCE_DIR,
        folder: 'mods',
        filename: process.env.NAME + '.jar',
        sha1: adopted.sha1,
        sha512: adopted.sha512,
        ledger: new ModLedger(process.env.INSTANCE_DIR),
        record: { provider: 'modrinth', projectId: process.env.NAME },
      })
    })().catch((error) => {
      console.error(error)
      process.exit(1)
    })
  `
  const names = ['x', 'y']
  const children = names.map((name) =>
    spawn(process.execPath, ['-e', source], {
      env: {
        ...process.env,
        STORE_ROOT: root,
        INSTANCE_DIR: shared,
        BARRIER: barrier,
        NAME: name,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  const errors = []
  const exits = []
  let running = children.length
  children.forEach((child, index) => {
    errors[index] = ''
    child.stderr.on('data', (data) => {
      errors[index] += String(data)
    })
    child.once('exit', (code) => {
      exits[index] = code
      running -= 1
    })
    child.stdout.resume()
  })
  const ready = () => names.every((name) => fs.existsSync(path.join(root, `ready-${name}`)))
  const deadline = Date.now() + 30_000
  while (!ready() && running > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(ready(), `children never reached the barrier: ${errors.join(' | ')}`)
  fs.writeFileSync(barrier, '')
  while (running > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (running > 0) {
    for (const child of children) child.kill('SIGKILL')
    assert.fail(`children did not finish: ${errors.join(' | ')}`)
  }
  assert.deepEqual(exits, [0, 0], `a child failed: ${errors.join(' | ')}`)

  const records = await new ModLedger(shared).list()
  const installed = fs.readdirSync(path.join(shared, 'mods')).filter((name) => name.endsWith('.jar'))
  const recorded = new Set(records.flatMap((record) => record.paths))
  assert.equal(installed.length, 2)
  assert.equal(records.length, 2, `a concurrent commit lost its ledger entry, got ${records.length}`)
  for (const name of installed) {
    assert.ok(recorded.has(`mods/${name}`), `file without a ledger entry: ${name}`)
  }
})

test('materialize reports store-missing when the object disappears under a held lock', async () => {
  const store = new ModContentStore({ root: tempDir('store-race'), lockTimeoutMs: 5_000 })
  const staging = path.join(tempDir('store-race-staging'), 'mod.jar')
  const body = jar({ 'mod.json': 'race' })
  write(staging, body)
  const adopted = await store.adopt(staging)
  const object = store.objectPath(adopted.sha512)
  const destination = path.join(tempDir('store-race-instance'), 'mods', 'raced.jar')

  // Another process holds the object lock, and GC deletes the object while it does:
  // the store must notice that after taking the lock instead of letting the raw
  // ENOENT of the link call escape.
  fs.writeFileSync(`${object}.lock`, '')
  const pending = store.materialize(adopted.sha512, destination)
  await new Promise((resolve) => setTimeout(resolve, 200))
  fs.rmSync(object, { force: true })
  fs.rmSync(`${object}.lock`, { force: true })

  await assert.rejects(
    pending,
    (error) => error.name === 'ModError' && error.code === 'store-missing',
  )
  assert.equal(fs.existsSync(destination), false)
  const folder = path.dirname(destination)
  const leftovers = fs.existsSync(folder) ? fs.readdirSync(folder) : []
  assert.deepEqual(leftovers.filter((name) => name.includes('.part')), [])
})

test('a ledger lock left behind by a killed writer does not block the next one', async () => {
  const instance = tempDir('ledger-lock-crash')
  const distIndex = path.join(__dirname, '..', 'dist-electron', 'mods', 'index.js')
  const source = `
    const fs = require('node:fs')
    const path = require('node:path')
    const { MOD_LEDGER_FILE } = require(${JSON.stringify(distIndex)})
    const lockFile = path.join(process.env.INSTANCE_DIR, MOD_LEDGER_FILE + '.lock')
    fs.writeFileSync(lockFile, String(process.pid))
    process.stdout.write('locked\\n')
    setInterval(() => {}, 1_000)
  `
  const holder = spawn(process.execPath, ['-e', source], {
    env: { ...process.env, INSTANCE_DIR: instance },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  holder.stderr.on('data', (data) => {
    stderr += String(data)
  })
  const started = Date.now()
  while (Date.now() - started < 10_000 && holder.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (fs.existsSync(path.join(instance, 'mods.ledger.json.lock'))) break
  }
  assert.ok(
    fs.existsSync(path.join(instance, 'mods.ledger.json.lock')),
    `the holder never took the lock: ${stderr}`,
  )
  holder.kill('SIGKILL')
  await new Promise((resolve) => holder.once('exit', resolve))

  // A lock whose recorded process is gone must be reclaimed instead of making the
  // instance unwritable until the stale timeout and then failing the write.
  const ledger = new ModLedger(instance)
  const writeStarted = Date.now()
  await ledger.upsert({ sha1: 'c'.repeat(40), paths: ['mods/after-crash.jar'] })
  const elapsed = Date.now() - writeStarted
  assert.ok(elapsed < 5_000, `the write waited ${elapsed}ms for a dead lock holder`)
  assert.equal((await new ModLedger(instance).list()).length, 1)
  assert.equal(fs.existsSync(path.join(instance, 'mods.ledger.json.lock')), false)
})

test('one placement policy serves both content stores', async () => {
  const mods = require('../dist-electron/mods/index.js')
  const instances = require('../dist-electron/instances/content-store.js')
  const link = require('../dist-electron/link.js')

  assert.equal(mods.ContentStore, undefined, 'the mod store must not shadow the instance store')
  assert.equal(typeof mods.ModContentStore, 'function')
  assert.equal(typeof instances.ContentStore, 'function')
  for (const name of ['linkInto', 'linkOrCopy', 'replaceFile']) {
    assert.equal(typeof link[name], 'function', `shared placement policy is missing ${name}`)
  }

  // The instance store keeps its contract, now through the shared policy: an
  // existing target is reported instead of replaced, new content is hardlinked and
  // therefore shares the object's inode.
  const body = jar({ 'mod.json': 'policy' })
  const source = path.join(tempDir('policy-src'), 'mod.jar')
  write(source, body)
  const legacy = new instances.ContentStore(tempDir('policy-root'))
  const sha = await legacy.put(source)
  const target = path.join(tempDir('policy-instance'), 'mods', 'linked.jar')
  assert.equal(await legacy.link(sha, target), 'hardlink')
  assert.equal(fs.statSync(target).ino, fs.statSync(legacy.objectPath(sha)).ino)
  assert.equal(await legacy.link(sha, target), 'exists')
  assert.deepEqual(fs.readFileSync(target), body)
})
