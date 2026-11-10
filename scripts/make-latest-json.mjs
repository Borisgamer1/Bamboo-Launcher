/**
 * Builds the updater feed (`latest.json`) for a release folder.
 *
 *   node scripts/make-latest-json.mjs --base-url https://github.com/OWNER/REPO/releases/download/v0.2.5
 *
 * Expected layout: the folder holds the installer artifacts and the `.sig`
 * files Tauri writes next to them (`createUpdaterArtifacts: true`). By default
 * that is `release/v<version>/`; `--dir` points the script somewhere else (CI
 * downloads the uploaded assets first) and `--out` picks a different target.
 *
 * Upload every file plus `latest.json` to the release that the configured
 * endpoint points at; the launcher then updates itself in place.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8'))
const version = config.version

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const baseUrl = (flag('--base-url') ?? process.env.RELEASE_BASE_URL ?? '').replace(/\/+$/, '')
if (!baseUrl) {
  console.error('Fehlt: --base-url <url> oder RELEASE_BASE_URL')
  process.exit(1)
}

const folder = flag('--dir') ?? join(root, 'release', `v${version}`)
if (!existsSync(folder)) {
  console.error(`Nicht gefunden: ${folder}`)
  process.exit(1)
}

const files = readdirSync(folder)
const signature = (name) => {
  const path = join(folder, `${name}.sig`)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null
}

function entry(name, platform) {
  const sig = name ? signature(name) : null
  if (!sig) return null
  return [platform, { signature: sig, url: `${baseUrl}/${encodeURIComponent(name)}` }]
}

// Prefer the artifact Tauri signs for the updater: NSIS on Windows, the packed
// .app on macOS and the compressed AppImage on Linux.
const pick = (...patterns) =>
  files.find((name) => patterns.some((pattern) => pattern.test(name)))

const windows = pick(/-setup\.exe$/)
const linux = pick(/\.AppImage\.tar\.gz$/, /\.AppImage$/)

// A universal build ships one tarball that serves both Mac architectures.
const appTarballs = files.filter((name) => name.endsWith('.app.tar.gz'))
const macUniversal = appTarballs.find((name) => /universal/i.test(name))
const macArm = appTarballs.find((name) => /aarch64|arm64/i.test(name))
const macIntel = appTarballs.find((name) => !/aarch64|arm64|universal/i.test(name))

const platforms = Object.fromEntries(
  [
    windows && entry(windows, 'windows-x86_64'),
    (macUniversal ?? macArm) && entry(macUniversal ?? macArm, 'darwin-aarch64'),
    (macUniversal ?? macIntel) && entry(macUniversal ?? macIntel, 'darwin-x86_64'),
    linux && entry(linux, 'linux-x86_64'),
  ].filter(Boolean),
)

if (Object.keys(platforms).length === 0) {
  console.error('Keine signierten Artefakte gefunden. Mit TAURI_SIGNING_PRIVATE_KEY bauen.')
  process.exit(1)
}

const notesPath = flag('--notes-file') ?? join(folder, 'RELEASE_NOTES.md')
const feed = {
  version,
  notes: existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '',
  pub_date: new Date().toISOString(),
  platforms,
}

const target = flag('--out') ?? join(folder, 'latest.json')
writeFileSync(target, `${JSON.stringify(feed, null, 2)}\n`)
console.log(`${target}: ${Object.keys(platforms).join(', ')}`)
