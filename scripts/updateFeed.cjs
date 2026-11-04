'use strict'
/**
 * What a publishable release needs. The launcher's updater reads
 * `latest.yml` from the newest published GitHub release, so a release made of
 * just the installer silently disables updates for every installed copy —
 * exactly what happened with v0.2.1.
 *
 * Fatal: the installer and `latest.yml`. Optional: the blockmap only enables
 * the delta download; without it electron-updater logs a warning and fetches
 * the whole installer (AppUpdater: "Cannot download differentially, fallback
 * to full download"), so it is a warning here, never a failed publish.
 */
const fs = require('node:fs')
const path = require('node:path')

function parseLatestVersion(text) {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text ?? ''))
  return match ? match[1] : null
}

function expectedInstaller(version) {
  return `Bamboo-Launcher-Setup-${version}.exe`
}

/**
 * @param {{
 *   version: string,
 *   tag: string,
 *   assets: string[],
 *   latestYmlVersion: string | null,
 *   draft?: boolean,
 *   prerelease?: boolean,
 * }} release
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
function evaluateRelease(release) {
  const problems = []
  const warnings = []
  const version = String(release.version ?? '')
  const tag = String(release.tag ?? '')
  const assets = Array.isArray(release.assets) ? release.assets : []
  const installer = expectedInstaller(version)

  if (release.draft) problems.push('Das Release ist ein Draft — der Updater liest nur veröffentlichte Releases.')
  if (release.prerelease) problems.push('Das Release ist als Pre-Release markiert — /releases/latest ignoriert es.')
  if (tag !== `v${version}`) problems.push(`Tag ${tag} passt nicht zur Version v${version}.`)
  if (!assets.includes(installer)) problems.push(`${installer} fehlt im Release.`)
  if (!assets.includes(`${installer}.blockmap`)) {
    warnings.push(`${installer}.blockmap fehlt — das Update lädt dann die volle ${installer}, statt nur die Änderungen.`)
  }
  if (!assets.includes('latest.yml')) {
    problems.push('latest.yml fehlt im Release — ohne sie findet kein installierter Launcher ein Update.')
  } else if (release.latestYmlVersion == null) {
    problems.push('latest.yml konnte nicht gelesen werden (keine Version darin).')
  } else if (release.latestYmlVersion !== version) {
    problems.push(`latest.yml nennt Version ${release.latestYmlVersion}, erwartet wird ${version}.`)
  }

  return { ok: problems.length === 0, problems, warnings }
}

/** Assets and latest.yml version from a local electron-builder output folder. */
function readLocalArtifacts(dir, version) {
  const assets = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  const latestFile = path.join(dir, 'latest.yml')
  const latestYmlVersion = fs.existsSync(latestFile)
    ? parseLatestVersion(fs.readFileSync(latestFile, 'utf8'))
    : null
  return { assets, latestYmlVersion, version }
}

module.exports = { parseLatestVersion, evaluateRelease, readLocalArtifacts, expectedInstaller }
