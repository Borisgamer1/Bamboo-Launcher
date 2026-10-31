#!/usr/bin/env node
/**
 * Run the core suite with all non-loopback network access blocked.
 * Fails when any test attempts an external request (local fixture servers are
 * allowed), so the suite cannot silently depend on the internet.
 *
 * Usage: node scripts/offline-guard.cjs
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const tests = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.cjs'))
  .sort()
const logFile = path.join(os.tmpdir(), `bamboo-offline-${process.pid}.json`)
fs.rmSync(logFile, { force: true })

const result = spawnSync(
  process.execPath,
  ['--require', path.join(__dirname, 'no-network-preload.cjs'), '--test', ...tests.map((name) => path.join('tests', name))],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BAMBOO_OFFLINE_LOG: logFile },
  },
)

let blocked = []
try {
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
    try {
      blocked.push(JSON.parse(line))
    } catch {
      // A torn concurrent append must not hide the entries that did survive.
    }
  }
} catch {
  blocked = []
}
fs.rmSync(logFile, { force: true })

if (blocked.length > 0) {
  console.error(`Offline guard: ${blocked.length} blocked network attempt(s)`)
  for (const entry of blocked) {
    console.error(`- ${entry.kind} -> ${entry.host}`)
  }
}
if (result.status !== 0) {
  console.error(`Offline guard: tests failed (exit ${result.status})`)
  process.exit(result.status ?? 1)
}
if (blocked.length > 0) process.exit(1)
console.log(`Offline guard: ${tests.length} test files, 0 external network attempts`)
