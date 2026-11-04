#!/usr/bin/env node
/**
 * Fails when a release cannot update installed launchers.
 *
 *   node scripts/check-update-feed.cjs            # local release/ artifacts
 *   node scripts/check-update-feed.cjs --remote    # the published GitHub release
 *
 * `--remote` waits for GitHub to show the new release and checks the assets
 * the updater needs, so a broken publish turns into a red workflow instead of
 * a silent dead update channel. A missing blockmap only warns: the installer
 * and latest.yml decide whether updates work at all.
 */
const fs = require('node:fs')
const path = require('node:path')
const { evaluateRelease, readLocalArtifacts } = require('./updateFeed.cjs')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const publish = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {}
const owner = publish.owner
const repo = publish.repo
const tag = `v${version}`

const remote = process.argv.includes('--remote')
const outDir = path.join(root, pkg.build?.directories?.output || 'release')

function report(result, label) {
  for (const warning of result.warnings ?? []) console.warn(`warning: ${warning}`)
  if (result.ok) {
    console.log(`Update feed OK — ${label}`)
    return true
  }
  console.error(`Update feed broken — ${label}`)
  for (const problem of result.problems) console.error(`- ${problem}`)
  return false
}

async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bamboo-release-check' } })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}

async function fetchLatestYml(tagName) {
  const url = `https://github.com/${owner}/${repo}/releases/download/${tagName}/latest.yml`
  const response = await fetch(url, { headers: { 'User-Agent': 'bamboo-release-check' } })
  if (!response.ok) return null
  return response.text()
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkRemote() {
  if (!owner || !repo) throw new Error('build.publish.owner/repo fehlt in package.json')
  let release = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    release = await fetchLatestRelease()
    if (release && release.tag_name === tag) break
    if (attempt < 6) await sleep(5000)
  }
  const assets = Array.isArray(release?.assets) ? release.assets.map((asset) => asset.name) : []
  const text = assets.includes('latest.yml') ? await fetchLatestYml(release.tag_name) : null
  const result = evaluateRelease({
    version,
    tag: release?.tag_name ?? '',
    assets,
    latestYmlVersion: text ? require('./updateFeed.cjs').parseLatestVersion(text) : null,
    draft: Boolean(release?.draft),
    prerelease: Boolean(release?.prerelease),
  })
  return report(result, `GitHub ${owner}/${repo} ${release?.tag_name ?? '(kein Release)'}`)
}

function checkLocal() {
  const artifacts = readLocalArtifacts(outDir, version)
  const result = evaluateRelease({
    version,
    tag,
    assets: artifacts.assets,
    latestYmlVersion: artifacts.latestYmlVersion,
    draft: false,
    prerelease: false,
  })
  return report(result, `${path.relative(root, outDir)}/`)
}

;(async () => {
  if (!checkLocal()) {
    process.exitCode = 1
    return
  }
  if (!remote) {
    process.exitCode = 0
    return
  }
  process.exitCode = (await checkRemote()) ? 0 : 1
})().catch((error) => {
  console.error(`Update feed check failed: ${error.message}`)
  process.exitCode = 1
})
