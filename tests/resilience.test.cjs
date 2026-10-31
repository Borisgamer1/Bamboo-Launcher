/**
 * Phase 10 chaos tests (offline, deterministic).
 *
 * Real local sockets are cut mid-body, a real read-only target blocks rename,
 * ENOSPC is injected at the write boundary (the machine's disk is never
 * filled), and a truncated lock is quarantined and rebuilt.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { tempDir } = require('./harness.cjs')

const AdmZip = require('adm-zip')
const { createNullLogger } = require('../dist-electron/logger.js')
const { sha1Hex } = require('../dist-electron/download/checksum.js')
const { runInstallManifest } = require('../dist-electron/download/executor.js')
const { readModpackLock, installModpack } = require('../dist-electron/mods/index.js')
const { InstanceLocks, InstanceError } = require('../dist-electron/instances/index.js')

const fastRetry = {
  attempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  sleep: async () => undefined,
  random: () => 0.5,
}

function spec(pathname, url, content) {
  return {
    path: pathname,
    urls: [url],
    size: content.length,
    checksum: { algorithm: 'sha1', value: sha1Hex(content) },
  }
}

async function runFiles(destination, files, options = {}) {
  return runInstallManifest(
    { version: 1, tasks: [{ type: 'files', id: 'chaos', destination, files }] },
    { retry: fastRetry, ...options },
  )
}

test('a socket cut mid-body fails cleanly, leaves no temp file and resumes', async (context) => {
  const payload = Buffer.from('x'.repeat(256 * 1024), 'utf8')
  let cut = true
  const server = http.createServer((req, res) => {
    if (!cut) {
      res.writeHead(200, { 'content-length': payload.length }).end(payload)
      return
    }
    res.writeHead(200, { 'content-length': payload.length })
    res.write(payload.subarray(0, 1024))
    setTimeout(() => res.destroy(), 5)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const root = tempDir('socket-cut')
  context.after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const file = spec('payload.bin', `${base}/file`, payload)
  await assert.rejects(
    () => runFiles(root, [file]),
    (error) => error && error.code === 'network',
  )
  assert.equal(fs.existsSync(path.join(root, 'payload.bin')), false)
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.part')), false)
  cut = false
  const resumed = await runFiles(root, [file])
  assert.equal(resumed.downloadedFiles, 1)
  assert.equal(fs.readFileSync(path.join(root, 'payload.bin')).length, payload.length)
})

test('ENOSPC at the write boundary leaves the old file and no temp artifacts', async (context) => {
  const payload = Buffer.from('disk-full-payload', 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': payload.length }).end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = tempDir('enospc')
  context.after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const file = spec('file.bin', `http://127.0.0.1:${server.address().port}/file`, payload)
  fs.writeFileSync(path.join(root, 'file.bin'), 'old-content')
  await assert.rejects(
    () =>
      runFiles(root, [file], {
        writeFileImpl: async () => {
          const error = new Error('no space left on device')
          error.code = 'ENOSPC'
          throw error
        },
      }),
    (error) => error && error.code === 'ENOSPC',
  )
  assert.equal(fs.readFileSync(path.join(root, 'file.bin'), 'utf8'), 'old-content')
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.part')), false)
  // Without the fault, the same run succeeds.
  await runFiles(root, [file])
  assert.equal(fs.readFileSync(path.join(root, 'file.bin'), 'utf8'), payload.toString())
})

test('a read-only target blocks replacement without losing the old bytes', async (context) => {
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    context.skip('root can write into a read-only directory')
    return
  }
  const payload = Buffer.from('new-bytes', 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': payload.length }).end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const root = tempDir('readonly')
  context.after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const target = path.join(root, 'file.bin')
  fs.writeFileSync(target, 'old-bytes')
  if (process.platform === 'win32') fs.chmodSync(target, 0o444)
  else fs.chmodSync(root, 0o500)
  try {
    await assert.rejects(
      () =>
        runFiles(root, [
          spec('file.bin', `http://127.0.0.1:${server.address().port}/file`, payload),
        ]),
      (error) => ['EPERM', 'EACCES', 'EROFS'].includes(error?.code),
    )
    assert.equal(fs.readFileSync(target, 'utf8'), 'old-bytes')
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.part')), false)
  } finally {
    if (process.platform === 'win32') fs.chmodSync(target, 0o666)
    else fs.chmodSync(root, 0o700)
  }
  await runFiles(root, [
    spec('file.bin', `http://127.0.0.1:${server.address().port}/file`, payload),
  ])
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-bytes')
})

test('a truncated modpack lock is quarantined and rebuilt', async (context) => {
  const root = tempDir('bad-lock')
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const instanceDir = path.join(root, 'instance')
  fs.mkdirSync(instanceDir, { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'modpack.lock.json'), '{ "version": 1, "files": [', 'utf8')
  const archive = path.join(root, 'empty.mrpack')
  const zip = new AdmZip()
  zip.addFile(
    'modrinth.index.json',
    Buffer.from(JSON.stringify({ name: 'Chaos', formatVersion: 1, dependencies: {}, files: [] })),
  )
  zip.writeZip(archive)
  const result = await installModpack({ instanceDir, archivePath: archive, logger: createNullLogger() })
  assert.equal(result.installed.length, 0)
  assert.equal(fs.readdirSync(instanceDir).some((name) => name.startsWith('modpack.lock.json.corrupt-')), true)
  const lock = await readModpackLock(instanceDir)
  assert.equal(lock.format, 'mrpack')
  assert.equal(lock.files.length, 0)
})

test('a live instance lock blocks a second operation until released', async (context) => {
  const root = tempDir('lock')
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const locks = new InstanceLocks(createNullLogger())
  const first = await locks.acquire(root, { operation: 'install', instanceId: 'i1' })
  await assert.rejects(
    () => locks.acquire(root, { operation: 'delete', instanceId: 'i1' }),
    (error) => error instanceof InstanceError && error.code === 'locked',
  )
  await locks.release(first)
  const second = await locks.acquire(root, { operation: 'delete', instanceId: 'i1' })
  await locks.release(second)
})

test('an aborted Forge processor is killed, leaves no output, and the rerun succeeds', async (context) => {
  const { runJavaTask } = require('../dist-electron/loaders/java-task.js')
  const root = tempDir('processor-abort')
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, 'patched.jar')
  const spec = (script) => ({
    id: 'processor-abort',
    strategies: [[{ executable: process.execPath, args: ['-e', script, output] }]],
    outputs: [{ path: output, validator: 'zip' }],
    skipIfOutputsValid: false,
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    () => runJavaTask(spec('setInterval(() => {}, 1000)'), { signal: controller.signal }),
    (error) => error && error.code === 'aborted',
  )
  assert.equal(fs.existsSync(output), false, 'an aborted processor must not leave a partial output')

  // Real rerun with a process that writes a valid (empty) zip.
  const zip = new AdmZip()
  zip.addFile('patched.class', Buffer.from('patched', 'utf8'))
  const seed = path.join(root, 'seed.zip')
  fs.writeFileSync(seed, zip.toBuffer())
  const resumed = await runJavaTask(
    spec(`require('fs').copyFileSync(${JSON.stringify(seed)}, process.argv[1])`),
    {},
  )
  assert.equal(resumed.ran, true)
  assert.equal(resumed.commands, 1)
  assert.equal(new AdmZip(output).getEntries().length, 1)
})
