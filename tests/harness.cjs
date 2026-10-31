/**
 * One definition of the helpers every test file needs: temp dirs, jar hashes
 * and a local HTTP fixture server.
 *
 * A route may be
 *  - a string or Buffer: answered with 200 (JSON content type for strings),
 *  - `{ status, headers, body }`: answered with that status/headers,
 *  - `function (req, res, count, url)`: writes the response itself; a returned
 *    value is sent as a 200 body, so simple handlers stay one-liners.
 * Unknown paths answer 404 `missing`.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bamboo-${label}-`))
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function sha512(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex')
}

function jar(entries) {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'))
  }
  return zip.toBuffer()
}

function send(res, status, contentType, body, headers) {
  const buffer = body === undefined || body === null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(String(body))
  res.writeHead(status, {
    ...(contentType ? { 'content-type': contentType } : {}),
    'content-length': buffer.length,
    ...(headers ?? {}),
  })
  res.end(buffer)
}

async function fixtureServer(routes) {
  const hits = new Map()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const count = (hits.get(url.pathname) ?? 0) + 1
    hits.set(url.pathname, count)
    const route = routes[url.pathname]
    if (route === undefined) {
      send(res, 404, 'text/plain', 'missing')
      return
    }
    if (typeof route === 'function') {
      const result = await route(req, res, count, url)
      if (result !== undefined && !res.writableEnded) {
        send(res, 200, typeof result === 'string' ? 'application/json' : 'application/octet-stream', result)
      }
      return
    }
    if (route && typeof route === 'object' && !Buffer.isBuffer(route)) {
      send(res, route.status ?? 200, undefined, route.body, route.headers)
      return
    }
    send(res, 200, typeof route === 'string' ? 'application/json' : 'application/octet-stream', route)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    routes,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

module.exports = { fixtureServer, jar, sha1, sha512, tempDir }
