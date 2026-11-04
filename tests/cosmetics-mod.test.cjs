'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ensureBambooMod } = require('../dist-electron/cosmetics/mod.js')

const MOD_FILE = 'bamboo-cosmetics-26.3-fabric.jar'
const SHIPPED = path.join(__dirname, '..', 'resources', 'bamboo-mod', MOD_FILE)

function instance() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-mod-'))
}

test('only fabric on 26.3 gets the mod', async () => {
  const directory = instance()
  assert.equal(await ensureBambooMod(directory, '26.3', 'vanilla'), 'wrong-loader')
  assert.equal(await ensureBambooMod(directory, '1.21.11', 'fabric'), 'wrong-version')
  assert.equal(fs.existsSync(path.join(directory, 'mods', MOD_FILE)), false)
})

test('copies the shipped build and keeps it afterwards', async () => {
  const directory = instance()
  assert.equal(await ensureBambooMod(directory, '26.3', 'fabric'), 'installed')
  const target = path.join(directory, 'mods', MOD_FILE)
  assert.equal(fs.statSync(target).size, fs.statSync(SHIPPED).size)
  assert.equal(await ensureBambooMod(directory, '26.3', 'fabric'), 'present')
})

test('a release build wins over the shipped jar and is cached', async () => {
  const directory = instance()
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-mod-cache-'))
  const release = Buffer.from('release build bytes, deliberately not the shipped size')
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    if (String(url).includes('/releases/latest')) {
      return {
        status: 200,
        json: async () => ({
          tag_name: 'v9.9.9',
          assets: [
            { name: 'bamboo-cosmetics-26.3-fabric.jar', browser_download_url: 'https://example.invalid/mod.jar' },
          ],
        }),
      }
    }
    return { status: 200, arrayBuffer: async () => release } 
  }
  try {
    assert.equal(await ensureBambooMod(directory, '26.3', 'fabric', { cacheDir }), 'installed')
    const target = path.join(directory, 'mods', MOD_FILE)
    assert.equal(fs.readFileSync(target).toString(), release.toString())
    assert.equal(calls, 2)

    // Second instance in the cache window: no network at all.
    const cached = instance()
    const before = calls
    assert.equal(await ensureBambooMod(cached, '26.3', 'fabric', { cacheDir }), 'installed')
    assert.equal(fs.readFileSync(path.join(cached, 'mods', MOD_FILE)).toString(), release.toString())
    assert.equal(calls, before)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a broken release falls back to the shipped jar', async () => {
  const directory = instance()
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-mod-cache-broken-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    assert.equal(await ensureBambooMod(directory, '26.3', 'fabric', { cacheDir }), 'installed')
    assert.equal(fs.statSync(path.join(directory, 'mods', MOD_FILE)).size, fs.statSync(SHIPPED).size)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('replaces an older build and a stale copy', async () => {
  const directory = instance()
  const mods = path.join(directory, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  fs.writeFileSync(path.join(mods, 'bamboo-cosmetics-0.9-fabric.jar'), 'old')
  assert.equal(await ensureBambooMod(directory, '26.3', 'fabric'), 'installed')
  assert.equal(fs.existsSync(path.join(mods, 'bamboo-cosmetics-0.9-fabric.jar')), false)

  const target = path.join(mods, MOD_FILE)
  fs.writeFileSync(target, 'stale')
  assert.equal(await ensureBambooMod(directory, '26.3', 'fabric'), 'updated')
  assert.equal(fs.statSync(target).size, fs.statSync(SHIPPED).size)
})
