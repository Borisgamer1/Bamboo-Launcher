/**
 * Driver for the real-Electron auth harness.
 *
 * Runs two real Electron processes against one user data dir (login, then a
 * restart) and then inspects the bytes on disk independently of Electron:
 * no access token, refresh token or Minecraft token may appear in plaintext
 * anywhere under the user data directory.
 *
 * Usage: node scripts/e2e-auth/run.cjs
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, '.e2e-auth')
const USER_DATA = path.join(OUT, 'userData')
const EARLIEST_USER_DATA = path.join(OUT, 'earliest-userData')
const EXPIRY_USER_DATA = path.join(OUT, 'expiry-userData')
const REJECTED_USER_DATA = path.join(OUT, 'rejected-userData')
const OFFLINE_USER_DATA = path.join(OUT, 'offline-userData')
const UNAVAILABLE_USER_DATA = path.join(OUT, 'unavailable-userData')
const MID_USER_DATA = path.join(OUT, 'mid-session-userData')
const UI_USER_DATA = path.join(OUT, 'login-ui-userData')
const GAME_ROOT = path.join(OUT, 'game')
const ELECTRON = require('electron')

function run(mode, userData, label) {
  const result = spawnSync(ELECTRON, [path.join(__dirname, 'main.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BAMBOO_E2E_MODE: mode,
      BAMBOO_E2E_RUN: label,
      BAMBOO_E2E_OUT: OUT,
      BAMBOO_E2E_USER_DATA: userData,
      BAMBOO_SKIP_BOOTSTRAP: '1',
      BAMBOO_GAME_ROOT: GAME_ROOT,
    },
    stdio: 'inherit',
    windowsHide: false,
  })
  if (result.status !== 0) {
    console.error(`\n[e2e-auth] ${label}/${mode} process exited with ${result.status}`)
    process.exit(result.status || 1)
  }
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile()) files.push(full)
  }
  return files
}

function loadSecrets() {
  const files = fs
    .readdirSync(OUT)
    .filter((file) => /^secrets-.*\.json$/.test(file))
    .map((file) => path.join(OUT, file))
  const tokens = new Set()
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of ['msAccess', 'msRefresh', 'mcAccess']) {
      for (const value of data[key] || []) tokens.add(value)
    }
    if (data.refreshToken) tokens.add(data.refreshToken)
  }
  return [...tokens]
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(GAME_ROOT, { recursive: true })

run('earliest', EARLIEST_USER_DATA, 'earliest')
run('login', USER_DATA, 'main')
run('login-ui', UI_USER_DATA, 'ui')
run('restore', USER_DATA, 'main')
run('expiry', EXPIRY_USER_DATA, 'expiry')
run('rejected', REJECTED_USER_DATA, 'rejected')
run('login', OFFLINE_USER_DATA, 'offline')
run('offline', OFFLINE_USER_DATA, 'offline')
run('unavailable', UNAVAILABLE_USER_DATA, 'unavailable')
run('login', MID_USER_DATA, 'mid')
run('mid-session', MID_USER_DATA, 'mid')

// ─── Independent on-disk inspection ────────────────────────────────────────
const tokens = loadSecrets()
const leaks = []
let scannedBytes = 0
let filesScanned = 0
for (const dir of [USER_DATA, EARLIEST_USER_DATA, EXPIRY_USER_DATA, REJECTED_USER_DATA, OFFLINE_USER_DATA, UNAVAILABLE_USER_DATA, MID_USER_DATA, UI_USER_DATA]) {
  for (const file of walk(dir)) {
    const stat = fs.statSync(file)
    if (stat.size > 25 * 1024 * 1024) continue
    const body = fs.readFileSync(file).toString('latin1')
    filesScanned += 1
    scannedBytes += stat.size
    for (const token of tokens) {
      if (body.includes(token)) leaks.push({ file: path.relative(dir, file), token: token.slice(0, 8) + '…' })
    }
  }
}

const reports = fs
  .readdirSync(OUT)
  .filter((file) => /^report-.*\.json$/.test(file))
  .map((file) => JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8')))
const checks = Object.assign({}, ...reports.map((report) => report.checks))
const failed = Object.entries(checks).filter(([, value]) => !value.pass)
const earliestReport = reports.find((report) => report.mode === 'earliest') || {}

const tokenFile = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'accounts.tokens.json'), 'utf8'))
const accounts = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf8'))
const storage = fs.readdirSync(USER_DATA)

const summary = {
  electron: require('electron/package.json').version,
  userData: USER_DATA,
  filesScanned,
  bytesScanned: scannedBytes,
  tokensSearched: tokens.length,
  plaintextLeaks: leaks,
  checksRun: Object.keys(checks).length,
  failedChecks: failed.map(([name]) => name),
  earliestSignInMs: earliestReport.timing || null,
  runs: reports.map((report) => ({ mode: report.mode, passed: report.passed })),
  kontoDom: reports
    .filter((report) => report.dom)
    .map((report) => ({ mode: report.mode, state: report.dom.state, text: report.dom.text || report.dom.after })),
  tokenFileAccounts: Object.keys(tokenFile.entries || {}),
  accountsJsonKeys: Object.keys(accounts),
  topLevelUserData: storage.filter((name) => /token|account/i.test(name)),
}
console.log('\n[e2e-auth] summary', JSON.stringify(summary, null, 2))

if (leaks.length > 0) {
  console.error('\n[e2e-auth] FAIL: plaintext token found on disk')
  process.exit(1)
}
console.log(`\n[e2e-auth] PASS: ${Object.keys(checks).length} runtime checks, ${tokens.length} tokens absent from ${filesScanned} files (${scannedBytes} bytes) under both user data dirs`)
