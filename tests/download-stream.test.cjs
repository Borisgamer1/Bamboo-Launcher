/**
 * Phase 4 streaming pipeline: SHA-1 + SHA-512 + size in one pass over the same
 * bytes, fsync + rename for the destination, and no file left behind when the
 * content is wrong, the download is aborted or the size does not match.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { streamToFile } = require('../dist-electron/download/index.js')
const { fixtureServer, jar, sha1, sha512, tempDir } = require('./harness.cjs')

function parts(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.part'))
}

test('streams a jar to its destination, hashing sha1 and sha512 in one pass', async () => {
  const body = jar({ 'mod.json': '{"id":"stream"}' })
  const server = await fixtureServer({ '/mod.jar': body })
  try {
    const dir = tempDir('stream-basic')
    const destination = path.join(dir, 'mods', 'mod.jar')
    const result = await streamToFile({
      urls: [`${server.base}/mod.jar`],
      destination,
      expected: { sha1: sha1(body), sha512: sha512(body), size: body.length },
    })
    assert.equal(result.sha1, sha1(body))
    assert.equal(result.sha512, sha512(body))
    assert.equal(result.bytes, body.length)
    assert.equal(result.attempts, 1)
    assert.deepEqual(fs.readFileSync(destination), body)
    assert.deepEqual(parts(path.dirname(destination)), [])
  } finally {
    await server.close()
  }
})

test('a hash mismatch leaves no new file and keeps the previous one', async () => {
  const server = await fixtureServer({ '/mod.jar': Buffer.from('wrong content') })
  try {
    const dir = tempDir('stream-mismatch')
    const destination = path.join(dir, 'mod.jar')
    fs.writeFileSync(destination, Buffer.from('previous'))
    await assert.rejects(
      streamToFile({
        urls: [`${server.base}/mod.jar`],
        destination,
        expected: { sha1: 'a'.repeat(40) },
        retry: { attempts: 1 },
      }),
      (error) => error.code === 'checksum-mismatch',
    )
    assert.equal(fs.readFileSync(destination, 'utf8'), 'previous')
    assert.deepEqual(parts(dir), [])
  } finally {
    await server.close()
  }
})

test('a size mismatch leaves no file behind', async () => {
  const server = await fixtureServer({ '/mod.jar': Buffer.from('1234') })
  try {
    const dir = tempDir('stream-size')
    const destination = path.join(dir, 'mod.jar')
    await assert.rejects(
      streamToFile({
        urls: [`${server.base}/mod.jar`],
        destination,
        expected: { size: 99 },
        retry: { attempts: 1 },
      }),
      (error) => error.code === 'size-mismatch',
    )
    assert.equal(fs.existsSync(destination), false)
    assert.deepEqual(parts(dir), [])
  } finally {
    await server.close()
  }
})

test('an abort mid-stream leaves no file behind', async () => {
  const chunk = Buffer.alloc(64 * 1024, 7)
  const server = await fixtureServer({
    '/big.jar': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer)
          return
        }
        if (!res.write(chunk)) clearInterval(timer)
      }, 1)
      res.on('close', () => clearInterval(timer))
    },
  })
  try {
    const dir = tempDir('stream-abort')
    const destination = path.join(dir, 'big.jar')
    const controller = new AbortController()
    const promise = streamToFile({
      urls: [`${server.base}/big.jar`],
      destination,
      signal: controller.signal,
      retry: { attempts: 1 },
    })
    setTimeout(() => controller.abort(), 60)
    await assert.rejects(promise, (error) => error.code === 'aborted')
    assert.equal(fs.existsSync(destination), false)
    assert.deepEqual(parts(dir), [])
  } finally {
    await server.close()
  }
})

test('retries a transient HTTP error and still delivers the file', async () => {
  const body = Buffer.from('payload')
  const server = await fixtureServer({
    '/mod.jar': (req, res, count) => (count === 1 ? { status: 500, body: 'boom' } : body),
  })
  try {
    const dir = tempDir('stream-retry')
    const destination = path.join(dir, 'mod.jar')
    const result = await streamToFile({
      urls: [`${server.base}/mod.jar`],
      destination,
      expected: { sha1: sha1(body) },
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    assert.equal(result.attempts, 2)
    assert.deepEqual(fs.readFileSync(destination), body)
  } finally {
    await server.close()
  }
})

test('a 300 MB streamed download keeps process memory flat', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 5)
  const chunks = 300
  const total = chunk.length * chunks
  const server = await fixtureServer({
    '/big.jar': (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(total),
      })
      let index = 0
      const pump = () => {
        while (index < chunks) {
          index += 1
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
    },
  })
  try {
    const dir = tempDir('stream-rss')
    const destination = path.join(dir, 'big.jar')
    const before = process.memoryUsage().rss
    let peak = before
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 20)
    let result
    try {
      result = await streamToFile({
        urls: [`${server.base}/big.jar`],
        destination,
        expected: { size: total },
      })
    } finally {
      clearInterval(sampler)
    }
    const delta = Math.max(0, peak - before)
    console.log(
      `stream rss: bytes=${result.bytes} peak-grow=${(delta / 1048576).toFixed(1)} MiB ` +
        `(payload ${(total / 1048576).toFixed(0)} MiB)`,
    )
    assert.equal(result.bytes, total)
    assert.equal(fs.statSync(destination).size, total)
    assert.ok(delta < 128 * 1024 * 1024, `peak RSS grew by ${delta} bytes for a ${total} byte download`)
  } finally {
    await server.close()
  }
})
