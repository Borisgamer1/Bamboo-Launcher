#!/usr/bin/env node
/**
 * Benchmark driver for the mod pipeline.
 *
 * Default run (roadmap phase 6): cold vs. warm provider lookups, a 1.000-mod
 * resolution, 10 parallel installations against a real filesystem and a slow
 * network through the streaming download.
 *
 * `--baseline` (roadmap phase 0): the fixture matrix — 50 / 250 / 1.000 JARs
 * with 20 % unknown, 10 % locally changed and 5 % missing — measured through the
 * real paths: `scanMissingDependencies`, `hashFileDual`, `checkInstalledUpdates`
 * on a `ModLedger` and the streaming download of 50 MB. Every combination runs
 * `--runs` times (default 5) and is printed as min–max with the median, because a
 * single wall-clock number on a desktop machine is not reproducible; the counts
 * (hashed, cached, requests, statuses) are invariant and the run fails if they
 * differ between repetitions.
 *
 * Every number is measured in the run that prints it; nothing is estimated.
 *
 * Usage: node --expose-gc bench/mods-bench.cjs [--mods 1000] [--baseline] [--runs 5]
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')

const {
  ModContentStore,
  ModLedger,
  ModMetrics,
  ModrinthClient,
  ModrinthProvider,
  checkInstalledUpdates,
  resolveModPlan,
  scanMissingDependencies,
} = require('../dist-electron/mods/index.js')
const { streamToFile } = require('../dist-electron/download/index.js')
const { hashFileDual } = require('../dist-electron/download/checksum.js')

const rows = []
function row(label, value) {
  rows.push({ label, value })
  console.log(`  ${label.padEnd(46)} ${value}`)
}

function ms(started) {
  return `${Date.now() - started}ms`
}

function mb(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function gc() {
  if (typeof global.gc === 'function') global.gc()
}

function rss() {
  gc()
  return process.memoryUsage().rss
}

/** The highest RSS seen while `work` ran, sampled every 20 ms. */
async function withPeakRss(work) {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 20)
  try {
    const value = await work()
    return { value, peak }
  } finally {
    clearInterval(timer)
  }
}

function rssRow(label, base, peak) {
  row(label, `${mb(peak)} (base ${mb(base)}, +${mb(Math.max(0, peak - base))})`)
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const parsed = Number(process.argv[index + 1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function spread(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0],
    max: sorted.at(-1),
    median: sorted[Math.floor(sorted.length / 2)],
  }
}

/** `min–max ms (median)` — a range, because one run's millisecond is noise. */
function msRange(values, suffix = '') {
  const { min, max, median } = spread(values)
  return `${min}–${max} ms (median ${median}${suffix})`
}

function peakRange(bases, peaks) {
  const base = spread(bases)
  const peak = spread(peaks)
  return `${mb(peak.min)}–${mb(peak.max)} (median ${mb(peak.median)}, base ${mb(base.median)}, +${mb(Math.max(0, peak.median - base.median))})`
}

let invariantsChecked = 0
let invariantsHeld = 0

/**
 * Structural results must not move between repetitions: a count that varies is a
 * finding, not noise, so it is printed as VARIES and fails the run.
 */
function invariant(label, values, render) {
  invariantsChecked += 1
  const distinct = [...new Set(values.map((value) => JSON.stringify(value)))]
  if (distinct.length === 1) {
    invariantsHeld += 1
    row(label, `${render(JSON.parse(distinct[0]))} (identical in all runs)`)
    return
  }
  row(label, `VARIES: ${distinct.map((entry) => render(JSON.parse(entry))).join(' | ')}`)
}

function send(res, status, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buffer.length })
  res.end(buffer)
}

/** A fixture provider API: 50 hits per search page, 120 versions per project. */
async function providerServer() {
  const hits = Array.from({ length: 50 }, (_, i) => ({
    project_id: `p${i}`,
    slug: `p${i}`,
    title: `P${i}`,
    description: 'bench',
    project_type: 'mod',
    downloads: 1000 + i,
    follows: 10,
    versions: ['v1'],
  }))
  const version = (projectId, index) => ({
    id: `${projectId}-v${index}`,
    project_id: projectId,
    name: `${projectId} ${index}`,
    version_number: `${index}`,
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    date_published: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
    version_type: 'release',
    files: [
      {
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        url: `https://example.invalid/${projectId}-${index}.jar`,
        filename: `${projectId}-${index}.jar`,
        primary: true,
        size: 64,
      },
    ],
    dependencies: [],
  })
  const requests = { total: 0 }
  const server = http.createServer((req, res) => {
    requests.total += 1
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/search') return send(res, 200, { hits, offset: 0, limit: 50, total_hits: 50 })
    const match = /^\/project\/(p\d+)\/version$/.exec(url.pathname)
    if (match) {
      const project = match[1]
      return send(
        res,
        200,
        Array.from({ length: 120 }, (_, i) => version(project, i)),
      )
    }
    return send(res, 404, { error: 'missing' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A fixture CDN that trickles the body in chunks, for the slow-network case. */
async function slowServer(sizeBytes, chunkBytes, delayMs) {
  const chunk = Buffer.alloc(chunkBytes, 0x42)
  const server = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': sizeBytes })
    for (let sent = 0; sent < sizeBytes; sent += chunkBytes) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function benchVersion(id, projectId, dependencies) {
  return {
    id,
    projectId,
    name: id,
    versionNumber: id,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    files: [{ filename: `${id}.jar`, url: `https://example.invalid/${id}.jar` }],
    dependencies,
    publishedAt: '2026-01-01T00:00:00Z',
    channel: 'release',
  }
}

/**
 * Exactly `mods` installed mods (multiples of 10): root → 10% branches → 9 leaves
 * each, so the plan has one entry per mod and three levels of depth.
 */
function thousandModProjects(mods) {
  const projects = {}
  const rootDeps = []
  const branches = Math.ceil(mods / 10)
  const leaves = mods - branches
  let created = 0
  for (let b = 0; b < branches; b += 1) {
    rootDeps.push({ projectId: `B${b}`, type: 'required' })
    const branchDeps = []
    for (let c = 0; c < 9 && created < leaves; c += 1) {
      created += 1
      const id = `M${b}_${c}`
      branchDeps.push({ projectId: id, type: 'required' })
      projects[id] = [benchVersion(id, id, [])]
    }
    projects[`B${b}`] = [benchVersion(`b${b}`, `B${b}`, branchDeps)]
  }
  projects.Root = [benchVersion('root', 'Root', rootDeps)]
  return projects
}

class BenchProvider {
  id = 'modrinth'

  constructor(projects) {
    this.projects = projects
  }

  async versions(projectId) {
    return this.projects[projectId] ?? []
  }

  async version(_projectId, versionId) {
    return Object.values(this.projects)
      .flat()
      .find((entry) => entry.id === versionId)
  }

  async project(projectId) {
    return { id: projectId, slug: projectId, title: projectId, provider: 'modrinth' }
  }
}

/**
 * Phase 0 fixture: `size` JARs of which 20 % are unknown to the ledger, 10 % were
 * changed locally and 5 % are recorded but gone. The ledger is written in its own
 * on-disk format and then read back through `ModLedger`, so the fixture cannot
 * drift away from the real schema.
 */
async function buildInstance(root, size, requestMap) {
  const instanceDir = path.join(root, `instance-${size}`)
  const modsDir = path.join(instanceDir, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })

  const clean = Math.round(size * 0.65)
  const changed = Math.round(size * 0.1)
  const unknown = Math.round(size * 0.2)
  const gone = size - clean - changed - unknown
  const entries = {}
  const installedAt = Date.parse('2026-01-01T00:00:00Z')
  let filesOnDisk = 0

  const writeJar = (index) => {
    const zip = new AdmZip()
    zip.addFile(
      'fabric.mod.json',
      Buffer.from(JSON.stringify({ id: `bench-${index}`, version: '1.0.0' })),
    )
    // A few KiB of payload so hashing is not measuring empty files.
    // ~3 KiB of incompressible payload per JAR, so hashing measures bytes instead
    // of measuring how well deflate compresses one repeated filler byte.
    const payload = Buffer.allocUnsafe(3 * 1024)
    let seed = (index + 1) * 0x9e3779b1
    for (let offset = 0; offset < payload.length; offset += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      payload[offset] = seed >>> 24
    }
    zip.addFile(`assets/data-${index}.bin`, payload)
    const file = path.join(modsDir, `mod-${index}.jar`)
    zip.writeZip(file)
    filesOnDisk += 1
    return file
  }
  const record = (index, sha1, extra) => {
    entries[sha1] = {
      sha1,
      paths: [`mods/mod-${index}.jar`],
      provider: 'modrinth',
      projectId: `p${index}`,
      versionId: `v${index}`,
      name: `mod-${index}.jar`,
      channel: 'release',
      publishedAt: '2026-01-01T00:00:00Z',
      installedAt,
      ...extra,
    }
    requestMap.set(sha1, index)
  }

  for (let index = 0; index < clean + changed + unknown; index += 1) {
    const file = writeJar(index)
    const info = fs.statSync(file)
    if (index < clean) {
      const sha1 = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
      record(index, sha1, { stat: { size: info.size, mtimeMs: info.mtimeMs } })
    } else if (index < clean + changed) {
      // The file was edited after the install: the recorded hash and the recorded
      // mtime both belong to the older content, so the check has to re-hash it.
      const stale = crypto.createHash('sha1').update(`stale-${index}`).digest('hex')
      record(index, stale, { stat: { size: info.size, mtimeMs: info.mtimeMs - 60_000 } })
    }
    // The rest stays unknown: a file on disk the ledger has never seen.
  }
  for (let index = 0; index < gone; index += 1) {
    const missingIndex = clean + changed + unknown + index
    const sha1 = crypto.createHash('sha1').update(`gone-${missingIndex}`).digest('hex')
    record(missingIndex, sha1, {})
  }

  const ledgerJson = JSON.stringify({ version: 1, updatedAt: Date.now(), entries })
  fs.writeFileSync(path.join(instanceDir, 'mods.ledger.json'), ledgerJson)
  return {
    instanceDir,
    modsDir,
    ledgerJson,
    counts: { size, filesOnDisk, clean, changed, unknown, gone, records: Object.keys(entries).length },
  }
}

/** The real Modrinth update endpoint: a hash → version map, 100 hashes per batch. */
async function updateServer(requestMap) {
  const requests = { updateMany: 0, hashes: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {}
      if (req.url.startsWith('/version_files/update_many')) {
        requests.updateMany += 1
        const hashes = Array.isArray(body.hashes) ? body.hashes : []
        requests.hashes += hashes.length
        const map = {}
        for (const hash of hashes) {
          const index = requestMap.get(String(hash).toLowerCase())
          if (index === undefined) continue
          map[hash] = {
            id: `v${index}`, // same version as installed: up-to-date
            project_id: `p${index}`,
            name: `v${index}`,
            version_number: '1.0.0',
            game_versions: ['1.20.1'],
            loaders: ['fabric'],
            date_published: '2026-01-01T00:00:00Z',
            version_type: 'release',
            files: [
              {
                hashes: { sha1: hash, sha512: 'b'.repeat(128) },
                url: `https://example.invalid/${index}.jar`,
                filename: `mod-${index}.jar`,
                primary: true,
                size: 3500,
              },
            ],
            dependencies: [],
          }
        }
        return send(res, 200, map)
      }
      return send(res, 404, { error: 'missing' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function baseline() {
  const runs = argValue('--runs', 5)
  console.log(`mods-bench --baseline: ${process.platform} ${process.arch}, node ${process.version}, ${os.cpus().length} cpus`)
  console.log(`  started ${new Date().toISOString()}, ${runs} runs per combination`)
  console.log('  fixture per size: 65 % clean, 10 % locally changed, 20 % unknown, 5 % missing')
  console.log('  every timing is printed as min–max with the median; RSS = peak during the phase')
  console.log('  counts are invariant checks: a differing count fails the run')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-baseline-'))
  try {
    for (const size of [50, 250, 1_000]) {
      const requestMap = new Map()
      const fixture = await buildInstance(root, size, requestMap)
      console.log(`\n[${size} JARs] ${fixture.counts.filesOnDisk} on disk, ${fixture.counts.records} ledger records`)
      console.log(
        `  clean ${fixture.counts.clean}, changed ${fixture.counts.changed}, unknown ${fixture.counts.unknown}, missing ${fixture.counts.gone}`,
      )

      const ledger = new ModLedger(fixture.instanceDir)
      await ledger.load()
      const records = await ledger.list()
      if (records.length !== fixture.counts.records) {
        throw new Error(`ledger fixture mismatch: ${records.length} != ${fixture.counts.records}`)
      }

      // Scan: the real metadata reader over every JAR on disk.
      const scanRuns = []
      let started = Date.now()
      for (let run = 0; run < runs; run += 1) {
        const base = rss()
        started = Date.now()
        const traced = await withPeakRss(() => scanMissingDependencies(fixture.modsDir))
        scanRuns.push({ ms: Date.now() - started, base, peak: traced.peak, parsed: traced.value.mods.length })
      }
      row('scan', `${msRange(scanRuns.map((entry) => entry.ms))}, ${runs} runs`)
      invariant('scan mods parsed', scanRuns.map((entry) => entry.parsed), (value) => `${value}`)
      row(
        'scan RSS peak',
        peakRange(scanRuns.map((entry) => entry.base), scanRuns.map((entry) => entry.peak)),
      )

      // Hash: every JAR on disk, dual hash, no fast path at all.
      const jarFiles = fs
        .readdirSync(fixture.modsDir)
        .map((name) => path.join(fixture.modsDir, name))
      const hashRuns = []
      for (let run = 0; run < runs; run += 1) {
        const hashBase = rss()
        started = Date.now()
        let hashBytes = 0
        const traced = await withPeakRss(async () => {
          for (const file of jarFiles) hashBytes += (await hashFileDual(file)).bytes
        })
        hashRuns.push({ ms: Date.now() - started, base: hashBase, peak: traced.peak, bytes: hashBytes })
      }
      row('hash all JARs', msRange(hashRuns.map((entry) => entry.ms)))
      invariant(
        'hashed bytes',
        hashRuns.map((entry) => entry.bytes),
        (value) => `${mb(value)} over ${jarFiles.length} files`,
      )
      row(
        'hash RSS peak',
        peakRange(hashRuns.map((entry) => entry.base), hashRuns.map((entry) => entry.peak)),
      )

      // Update check: cold (no checkedAt yet), warm (within TTL), warm + refresh.
      const server = await updateServer(requestMap)
      const metrics = new ModMetrics()
      const provider = new ModrinthProvider(
        new ModrinthClient({ baseUrl: server.base, metrics, retry: { attempts: 1 } }),
        { cache: { metrics } },
      )
      const target = { minecraftVersion: '1.20.1', loader: 'fabric' }
      const coldRuns = []
      for (let run = 0; run < runs; run += 1) {
        // Each repetition starts from the fixture ledger, so it is truly cold.
        const current = await freshLedger(fixture.instanceDir, fixture.ledgerJson)
        const base = rss()
        started = Date.now()
        const before = server.requests.updateMany
        const traced = await withPeakRss(() =>
          checkInstalledUpdates({
            instanceDir: fixture.instanceDir,
            ledger: current,
            provider,
            target,
          }),
        )
        const result = traced.value
        coldRuns.push({
          ms: Date.now() - started,
          hashed: result.hashed,
          cached: result.cached,
          checked: result.checked,
          updates: result.updates.length,
          requests: server.requests.updateMany - before,
          base,
          peak: traced.peak,
          statuses: result.entries.reduce((all, entry) => {
            all[entry.status] = (all[entry.status] ?? 0) + 1
            return all
          }, {}),
        })
      }
      row('update check cold', `${msRange(coldRuns.map((entry) => entry.ms))}, ${runs} runs`)
      invariant(
        'cold hashed / cached / checked',
        coldRuns.map((entry) => [entry.hashed, entry.cached, entry.checked]),
        (value) => value.join(' / '),
      )
      invariant(
        'cold requests / updates found',
        coldRuns.map((entry) => [entry.requests, entry.updates]),
        (value) => value.join(' / '),
      )
      invariant(
        'cold statuses',
        coldRuns.map((entry) => entry.statuses),
        (value) => JSON.stringify(value),
      )
      row(
        'cold RSS peak',
        peakRange(coldRuns.map((entry) => entry.base), coldRuns.map((entry) => entry.peak)),
      )

      const warmRuns = []
      for (let run = 0; run < runs; run += 1) {
        // A warm run reads the ledger the cold run wrote, checks included.
        const current = await readLedger(fixture.instanceDir)
        const base = rss()
        started = Date.now()
        const before = server.requests.updateMany
        const traced = await withPeakRss(() =>
          checkInstalledUpdates({
            instanceDir: fixture.instanceDir,
            ledger: current,
            provider,
            target,
          }),
        )
        const result = traced.value
        warmRuns.push({
          ms: Date.now() - started,
          hashed: result.hashed,
          cached: result.cached,
          requests: server.requests.updateMany - before,
          base,
          peak: traced.peak,
        })
      }
      row('update check warm', `${msRange(warmRuns.map((entry) => entry.ms))}, ${runs} runs`)
      invariant(
        'warm hashed / cached',
        warmRuns.map((entry) => [entry.hashed, entry.cached]),
        (value) => value.join(' / '),
      )
      invariant('warm requests', warmRuns.map((entry) => entry.requests), (value) => `${value}`)
      row(
        'warm RSS peak',
        peakRange(warmRuns.map((entry) => entry.base), warmRuns.map((entry) => entry.peak)),
      )

      const refreshRuns = []
      for (let run = 0; run < runs; run += 1) {
        const current = await readLedger(fixture.instanceDir)
        started = Date.now()
        const before = server.requests.updateMany
        const refreshed = await checkInstalledUpdates({
          instanceDir: fixture.instanceDir,
          ledger: current,
          provider,
          target,
          refresh: true,
        })
        refreshRuns.push({
          ms: Date.now() - started,
          hashed: refreshed.hashed,
          requests: server.requests.updateMany - before,
        })
      }
      row('update check warm + refresh', `${msRange(refreshRuns.map((entry) => entry.ms))}, ${runs} runs`)
      invariant(
        'refresh hashed / requests',
        refreshRuns.map((entry) => [entry.hashed, entry.requests]),
        (value) => value.join(' / '),
      )
      row('provider batches / hashes asked', `${server.requests.updateMany} / ${server.requests.hashes}`)
      const snapshot = metrics.snapshot()
      row(
        'telemetry requests / cache',
        `${snapshot.requests} / ${snapshot.cacheHits} hits, ${snapshot.cacheMisses} misses`,
      )
      await server.close()
    }

    // The spec's last measurement point: 50 MB through the pipeline, per run.
    console.log(`\n[download 50 MB] local server, no artificial delay, ${runs} runs`)
    const fiftyMb = 50 * 1024 * 1024
    const fast = await slowServer(fiftyMb, 1024 * 1024, 0)
    const downloadRuns = []
    for (let run = 0; run < runs; run += 1) {
      const target = path.join(root, `fifty-${run}.bin`)
      const downloadMetrics = new ModMetrics()
      const downloadBase = rss()
      const startedDownload = Date.now()
      const traced = await withPeakRss(() =>
        streamToFile({
          urls: [`${fast.base}/fifty.bin`],
          destination: target,
          expected: { size: fiftyMb },
          metrics: downloadMetrics,
        }),
      )
      downloadRuns.push({
        ms: Date.now() - startedDownload,
        bytes: traced.value.bytes,
        onDisk: fs.statSync(target).size,
        base: downloadBase,
        peak: traced.peak,
        written: downloadMetrics.snapshot().downloadBytes,
        hashed: downloadMetrics.snapshot().hashBytes,
      })
    }
    const throughput = spread(
      downloadRuns.map((entry) => entry.bytes / 1024 / 1024 / (entry.ms / 1000)),
    )
    row('wall time', `${msRange(downloadRuns.map((entry) => entry.ms))}, ${runs} runs`)
    row(
      'throughput',
      `${throughput.min.toFixed(1)}–${throughput.max.toFixed(1)} MiB/s (median ${throughput.median.toFixed(1)})`,
    )
    invariant(
      'downloaded / on disk / metrics',
      downloadRuns.map((entry) => [entry.bytes, entry.onDisk, entry.written, entry.hashed]),
      (value) => `${mb(value[0])} / ${mb(value[1])}, metrics wrote ${mb(value[2])} and hashed ${mb(value[3])}`,
    )
    row('RSS peak', peakRange(downloadRuns.map((entry) => entry.base), downloadRuns.map((entry) => entry.peak)))
    await fast.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log(
    `\ninvariants: ${invariantsHeld}/${invariantsChecked} held${invariantsHeld === invariantsChecked ? '' : ' — a varying count is a defect, not noise'}`,
  )
  if (invariantsHeld !== invariantsChecked) process.exitCode = 1
}

/**
 * Resets the ledger file to its fixture state and reads it through a new
 * `ModLedger`: a loaded instance caches its entries, so reusing one would make a
 * "cold" run warm behind the measurement's back.
 */
async function freshLedger(instanceDir, ledgerJson) {
  fs.writeFileSync(path.join(instanceDir, 'mods.ledger.json'), ledgerJson)
  const ledger = new ModLedger(instanceDir)
  await ledger.load()
  return ledger
}

/** The same, without touching the file: the state the last run left behind. */
async function readLedger(instanceDir) {
  const ledger = new ModLedger(instanceDir)
  await ledger.load()
  return ledger
}

async function main() {
  if (process.argv.includes('--baseline')) {
    await baseline()
    return
  }
  const mods = Number(process.argv[process.argv.indexOf('--mods') + 1]) || 1_000
  console.log(`mods-bench: ${process.platform} ${process.arch}, node ${process.version}, ${os.cpus().length} cpus`)
  console.log(`\n[1] provider lookups, cold vs. warm (200 projects, 120 versions each)`)
  const metrics = new ModMetrics()
  let server = await providerServer()
  const provider = new ModrinthProvider(
    new ModrinthClient({ baseUrl: server.base, metrics, retry: { attempts: 1 } }),
    { cache: { metrics } },
  )
  const projectIds = Array.from({ length: 200 }, (_, i) => `p${i % 50}`)

  let started = Date.now()
  for (const id of projectIds) {
    await provider.versions(id, { minecraftVersion: '1.20.1', loader: 'fabric' })
  }
  const coldMs = Date.now() - started
  const coldRequests = server.requests.total

  started = Date.now()
  for (const id of projectIds) {
    await provider.versions(id, { minecraftVersion: '1.20.1', loader: 'fabric' })
  }
  const warmMs = Date.now() - started
  row('cold 200 lookups', `${coldMs}ms (${(coldMs / 200).toFixed(2)}ms each)`)
  row('warm 200 lookups', `${warmMs}ms (${(warmMs / 200).toFixed(2)}ms each)`)
  row('speedup warm vs. cold', `${(coldMs / Math.max(1, warmMs)).toFixed(1)}x`)
  row('API requests cold / warm', `${coldRequests} / ${server.requests.total - coldRequests}`)

  // One deliberate failure so the telemetry shows a classified error reason too.
  started = Date.now()
  await provider
    .versions('missing', { minecraftVersion: '1.20.1', loader: 'fabric' }, { bypassCache: true })
    .catch(() => undefined)
  row('classified failure', `1 in ${ms(started)} (byCode: ${JSON.stringify(metrics.snapshot().byCode)})`)
  await server.close()

  console.log(`\n[2] resolver: ${mods} mods in one plan`)
  const projects = thousandModProjects(mods)
  const beforeRss = rss()
  started = Date.now()
  const plan = await resolveModPlan({
    provider: new BenchProvider(projects),
    projectId: 'Root',
    target: { minecraftVersion: '1.20.1', loader: 'fabric' },
    maxNodes: mods + 100,
    maxDepth: mods + 100,
  })
  const resolveMs = Date.now() - started
  const afterRss = rss()
  row('resolve wall time', `${resolveMs}ms`)
  row('installs / skipped / cycles', `${plan.install.length} / ${plan.skipped.length} / ${plan.cycles.length}`)
  row('project count in fixture', `${Object.keys(projects).length}`)
  row('RSS delta while resolving (after gc)', mb(Math.max(0, afterRss - beforeRss)))

  console.log(`\n[3] 10 installations, sequential vs. parallel (real filesystem)`)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-bench-'))
  try {
    const storeMetrics = new ModMetrics()
    const store = new ModContentStore({ root: path.join(root, 'store'), metrics: storeMetrics })
    const files = Array.from({ length: 10 }, (_, i) => {
      const file = path.join(root, `payload-${i}.bin`)
      fs.writeFileSync(file, Buffer.alloc(256 * 1024, i + 1))
      return file
    })
    const sequentialStore = new ModContentStore({ root: path.join(root, 'seq-store') })
    const sequentialInstances = files.map((_, i) => {
      const dir = path.join(root, `seq-instance-${i}`)
      fs.mkdirSync(dir, { recursive: true })
      return dir
    })
    started = Date.now()
    for (const [i, file] of files.entries()) {
      const adopted = await sequentialStore.adopt(file)
      await sequentialStore.commit({
        instanceDir: sequentialInstances[i],
        folder: 'mods',
        filename: `payload-${i}.jar`,
        sha1: adopted.sha1,
        sha512: adopted.sha512,
        size: adopted.bytes,
      })
    }
    const sequentialMs = Date.now() - started

    const parallelInstances = files.map((_, i) => {
      const dir = path.join(root, `par-instance-${i}`)
      fs.mkdirSync(dir, { recursive: true })
      return dir
    })
    started = Date.now()
    await Promise.all(
      files.map(async (file, i) => {
        const adopted = await store.adopt(file)
        await store.commit({
          instanceDir: parallelInstances[i],
          folder: 'mods',
          filename: `payload-${i}.jar`,
          sha1: adopted.sha1,
          sha512: adopted.sha512,
          size: adopted.bytes,
        })
      }),
    )
    const parallelMs = Date.now() - started
    const linked = fs.statSync(path.join(parallelInstances[0], 'mods', 'payload-0.jar')).nlink
    row('10 installs sequential', `${sequentialMs}ms`)
    row('10 installs parallel', `${parallelMs}ms`)
    row('placed file is a link (nlink)', String(linked))
    row('objects stored', `${(await store.catalog()).length}`)
    row('hash bytes hashed here', mb(storeMetrics.snapshot().hashBytes))

    // Shared content: 10 instances, one object, 10 commits.
    const sharedRoot = path.join(root, 'shared-store')
    const sharedStore = new ModContentStore({ root: sharedRoot })
    const shared = path.join(root, 'shared.bin')
    fs.writeFileSync(shared, Buffer.alloc(512 * 1024, 7))
    const adoptedShared = await sharedStore.adopt(shared)
    const sharedTargets = Array.from({ length: 10 }, (_, i) => {
      const dir = path.join(root, `shared-instance-${i}`)
      fs.mkdirSync(dir, { recursive: true })
      return path.join(dir, 'shared.jar')
    })
    started = Date.now()
    await Promise.all(
      sharedTargets.map((target) =>
        sharedStore.materialize(adoptedShared.sha512, target),
      ),
    )
    const sharedMs = Date.now() - started
    const sameInode = sharedTargets.every(
      (target) => fs.statSync(target).ino === fs.statSync(sharedTargets[0]).ino,
    )
    row('10 links to one object', `${sharedMs}ms, same inode: ${sameInode}`)

    console.log(`\n[4] slow network: 4 MiB in 64 KiB chunks, 25ms apart`)
    const slowSize = 4 * 1024 * 1024
    server = await slowServer(slowSize, 64 * 1024, 25)
    const downloadMetrics = new ModMetrics()
    const target = path.join(root, 'slow.bin')
    const downloadRssBefore = rss()
    started = Date.now()
    const downloaded = await streamToFile({
      urls: [`${server.base}/slow.bin`],
      destination: target,
      expected: { size: slowSize },
      onProgress: (bytes) => downloadMetrics.downloadBytes(bytes),
    })
    const slowMs = Date.now() - started
    const downloadRssAfter = rss()
    await server.close()
    row('streamed bytes', `${downloaded.bytes} (${mb(downloaded.bytes)})`)
    row('wall time', `${slowMs}ms`)
    row('throughput', `${(downloaded.bytes / 1024 / 1024 / (slowMs / 1000)).toFixed(2)} MiB/s`)
    row('RSS delta while streaming (after gc)', mb(Math.max(0, downloadRssAfter - downloadRssBefore)))
    row('RSS delta / streamed size', `${((Math.max(0, downloadRssAfter - downloadRssBefore) / downloaded.bytes) * 100).toFixed(3)}%`)
    row('file on disk', mb(fs.statSync(target).size))

    const snapshot = metrics.snapshot()
    console.log(`\n[5] telemetry snapshot (local, in-process)`)
    row('requests', `${snapshot.requests}`)
    row('cache hits / misses', `${snapshot.cacheHits} / ${snapshot.cacheMisses}`)
    row('cache hit rate', snapshot.cacheHitRate.toFixed(3))
    row('hash bytes (store)', mb(storeMetrics.snapshot().hashBytes))
    row('download bytes (slow run)', mb(downloadMetrics.snapshot().downloadBytes))
    const stages = Object.entries(snapshot.stages)
      .map(([stage, stat]) => `${stage}: n=${stat.count} avg=${(stat.totalMs / stat.count).toFixed(2)}ms max=${stat.maxMs}ms`)
    row('stages', stages.join(' | ') || 'none')
    row('error reasons', JSON.stringify(snapshot.byCode))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`bench failed: ${error && error.message}`)
  process.exit(1)
})
