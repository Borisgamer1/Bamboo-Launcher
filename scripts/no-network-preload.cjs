/**
 * Test-only preload: fail any non-loopback network access.
 *
 * Local fixture servers (127.0.0.1) stay allowed; the goal is to catch a test
 * that silently depends on api.modrinth.com, CurseForge, Mojang or the network.
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')

const blocked = []
const logFile = process.env.BAMBOO_OFFLINE_LOG
// A test that proves the offline fallback expects its blocked host; anything
// else is a hidden dependency and fails the run. Read per call, so the test
// can declare its expectation right before it triggers the request.
function expectedHosts() {
  return new Set(
    String(process.env.BAMBOO_OFFLINE_EXPECT ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

function isLoopback(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function block(kind, host) {
  const message = `offline-guard blocked ${kind} to ${host}`
  const entry = {
    kind,
    host,
    expected: expectedHosts().has(String(host ?? '').toLowerCase()),
    stack: new Error(message).stack,
  }
  blocked.push(entry)
  // Append immediately: the guard runs every test file in its own process, so
  // writing the whole array on exit lets the last process overwrite the rest.
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
    } catch {
      // The parent reports a missing log as a failed guard.
    }
  }
  const error = new Error(message)
  error.code = 'EOFFLINE'
  throw error
}

function hostFromArgs(args) {
  const first = args[0]
  if (typeof first === 'string') {
    try {
      return new URL(first).hostname
    } catch {
      const [host] = first.split(':')
      return host
    }
  }
  if (first instanceof URL) return first.hostname
  if (first && typeof first === 'object') return first.hostname ?? first.host
  const second = args[1]
  return second && typeof second === 'object' ? second.hostname ?? second.host : undefined
}

const originalFetch = globalThis.fetch
if (typeof originalFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(String(input))
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopback(url.hostname)) {
        block('fetch', url.hostname)
      }
    }
    return originalFetch.call(this, input, init)
  }
}

for (const [name, mod] of [
  ['http', http],
  ['https', https],
]) {
  for (const method of ['request', 'get']) {
    const original = mod[method]
    mod[method] = function guarded(...args) {
      const host = hostFromArgs(args)
      if (!isLoopback(host)) block(`${name}.${method}`, host)
      return original.apply(this, args)
    }
  }
}

const originalConnect = net.connect
net.connect = net.createConnection = function guardedConnect(...args) {
  const host = hostFromArgs(args)
  if (!isLoopback(host)) block('net.connect', host)
  return originalConnect.apply(this, args)
}

process.on('exit', () => {
  if (blocked.some((entry) => !entry.expected)) process.exitCode = 99
})
