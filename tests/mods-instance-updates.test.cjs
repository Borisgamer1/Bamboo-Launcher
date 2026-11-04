'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  checkInstanceModUpdates,
  clearModHashCache,
} = require('../dist-electron/mods/instance-updates.js')

function instance(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-updates-'))
  const mods = path.join(directory, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(mods, name), content)
  }
  return directory
}

function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex')
}

function version(projectId, versionNumber, fileName, hash) {
  return {
    id: `${projectId}-${versionNumber}`,
    projectId,
    name: `${projectId} ${versionNumber}`,
    versionNumber,
    gameVersions: ['26.3'],
    loaders: ['fabric'],
    dependencies: [],
    files: [{ url: `https://example.invalid/${fileName}`, filename: fileName, primary: true, hashes: { sha1: hash } }],
  }
}

function client(table) {
  const calls = []
  return {
    calls,
    async updateMany(hashes, target) {
      calls.push({ hashes, target })
      const result = {}
      for (const hash of hashes) {
        if (table[hash]) result[hash] = table[hash]
      }
      return result
    },
  }
}

test('one batched call returns the newer build for a known jar', async () => {
  clearModHashCache()
  const old = 'old jar bytes'
  const directory = instance({ 'a-1.0.jar': old, 'b.jar': 'unknown jar' })
  const fake = client({ [sha1(old)]: version('proj-a', '2.0', 'a-2.0.jar', 'cafebabe') })

  const result = await checkInstanceModUpdates({
    instanceDir: directory,
    minecraftVersion: '26.3',
    loader: 'fabric',
    client: fake,
  })

  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].hashes.length, 2)
  assert.deepEqual(result.resolved, ['a-1.0.jar'])
  assert.equal(result.updates.length, 1)
  assert.equal(result.updates[0].file, 'a-1.0.jar')
  assert.equal(result.updates[0].versionNumber, '2.0')
  assert.equal(result.updates[0].fileName, 'a-2.0.jar')
  assert.equal(result.updates[0].url, 'https://example.invalid/a-2.0.jar')
})

test('an installed build that already is the newest counts as resolved, not as update', async () => {
  clearModHashCache()
  const content = 'current jar bytes'
  const directory = instance({ 'a.jar': content })
  const fake = client({ [sha1(content)]: version('proj-a', '2.0', 'a-2.0.jar', sha1(content)) })

  const result = await checkInstanceModUpdates({
    instanceDir: directory,
    minecraftVersion: '26.3',
    loader: 'fabric',
    client: fake,
  })

  assert.deepEqual(result.resolved, ['a.jar'])
  assert.deepEqual(result.updates, [])
})

test('files the provider does not know stay unresolved', async () => {
  clearModHashCache()
  const directory = instance({ 'local.jar': 'handmade' })
  const fake = client({})

  const result = await checkInstanceModUpdates({
    instanceDir: directory,
    minecraftVersion: '26.3',
    client: fake,
  })

  assert.deepEqual(result.resolved, [])
  assert.deepEqual(result.updates, [])
})

test('a missing mods folder is not an error', async () => {
  clearModHashCache()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-updates-empty-'))
  const fake = client({})
  const result = await checkInstanceModUpdates({
    instanceDir: directory,
    minecraftVersion: '26.3',
    client: fake,
  })
  assert.deepEqual(result, { resolved: [], updates: [] })
  assert.equal(fake.calls.length, 0)
})
