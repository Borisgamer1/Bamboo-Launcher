/**
 * Builds the electron-updater feeds for the pre-Rust builds.
 *
 *   node scripts/make-legacy-update-yml.mjs --dir release/v0.2.6
 *
 * Old Electron installs (0.2.4 and older) read `latest.yml` (Windows) and
 * `latest-linux.yml` (Linux) from the GitHub release. Without those files they
 * never see a new version, so the Rust package is offered through the same
 * native update dialog they already know. macOS is left out on purpose:
 * electron-updater would need a Squirrel `.zip`, which Tauri does not build.
 *
 * Upload the written files next to `latest.json`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8')).version

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const folder = flag('--dir') ?? join(root, 'release', `v${version}`)
if (!existsSync(folder)) {
  console.error(`Nicht gefunden: ${folder}`)
  process.exit(1)
}

const notes = `Bamboo Launcher ${version}

Dieses Update ersetzt den alten Electron-Build durch die Rust- und
Tauri-Fassung. Der Launcher kann sich dabei nicht selbst umbauen: Das Paket
startet nach dem Herunterladen den Installer und richtet die neue Version ein.

Windows bekommt das NSIS-Setup, Linux das AppImage. macOS laedt das DMG
einmalig von Hand:
https://github.com/Borisgamer1/Bamboo-Launcher/releases/latest

Alle Pakete: https://github.com/Borisgamer1/Bamboo-Launcher/releases/latest
`

const sha512 = (name) => {
  const buffer = readFileSync(join(folder, name))
  return {
    sha512: createHash('sha512').update(buffer).digest('base64'),
    size: statSync(join(folder, name)).size,
  }
}

const files = readdirSync(folder)
const pick = (pattern) => files.find((name) => pattern.test(name) && !name.endsWith('.sig'))

function write(feed, artifact) {
  const { sha512: digest, size } = sha512(artifact)
  const yaml = [
    `version: ${version}`,
    'files:',
    `  - url: ${artifact}`,
    `    sha512: ${digest}`,
    `    size: ${size}`,
    `path: ${artifact}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date().toISOString()}'`,
    `releaseName: Bamboo Launcher ${version} - Rust und Tauri`,
    'releaseNotes: |',
    ...notes.split('\n').map((line) => `  ${line.trimEnd()}`),
    '',
  ].join('\n')
  writeFileSync(join(folder, feed), yaml)
  console.log(`${feed}: ${artifact}`)
}

const windows = pick(/-setup\.exe$/)
const linux = pick(/\.AppImage$/)
if (!windows && !linux) {
  console.error('Kein NSIS-Setup und kein AppImage im Ordner — kein Legacy-Feed geschrieben.')
  process.exit(1)
}

if (windows) write('latest.yml', windows)
if (linux) write('latest-linux.yml', linux)
