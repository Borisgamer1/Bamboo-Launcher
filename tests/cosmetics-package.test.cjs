'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { parseCosmiq, installedCosmetic } = require('../dist-electron/cosmetics/cosmiq.js')
const { buildBoneMesh, meshBounds } = require('../dist-electron/cosmetics/geometry.js')
const { installPackage, listInstalled, previewInstalled, removeInstalled } = require('../dist-electron/cosmetics/store.js')

const SHOP = path.join(__dirname, '..', 'resources', 'cosmetics-shop')
const bytesOf = (file) => fs.readFileSync(path.join(SHOP, file))

function previewOf(file) {
  return parseCosmiq(bytesOf(file), file.replace(/\.cosmiq$/, ''))
}

test('reads the package metadata the game shows', () => {
  const cape = previewOf('bird-cape.cosmiq')
  assert.equal(cape.name, 'Bird Cape')
  assert.equal(cape.creator, 'Bamboo Launcher')
  assert.equal(cape.rarity, 'Legendary')
  assert.deepEqual(cape.slots, ['back', 'cape'])
  assert.equal(cape.parts.length, 1)
  assert.equal(cape.faces, 6)

  const hat = previewOf('strohhut.cosmiq')
  assert.deepEqual(hat.slots, ['head'])
})

test('keeps the baked placement and only maps UVs into the texture', () => {
  const cape = previewOf('bird-cape.cosmiq')
  const mesh = buildBoneMesh(cape.parts[0].cubes)
  const bounds = meshBounds(mesh)
  // The package already contains the fit: the cape hangs from the shoulders.
  assert.ok(Math.abs(bounds.min[1] - 7.92) < 0.05, `cape bottom ${bounds.min[1]}`)
  assert.ok(Math.abs(bounds.max[1] - 23.92) < 0.05, `cape top ${bounds.max[1]}`)
  assert.ok(bounds.min[2] > 1.5, `cape must sit behind the body, z ${bounds.min[2]}`)

  const { textureWidth, textureHeight } = cape.parts[0]
  for (let index = 0; index < mesh.uvs.length; index += 2) {
    assert.ok(mesh.uvs[index] >= 0 && mesh.uvs[index] <= textureWidth, 'u outside the sheet')
    assert.ok(mesh.uvs[index + 1] >= 0 && mesh.uvs[index + 1] <= textureHeight, 'v outside the sheet')
  }
})

test('lays the straw hat on top of the head', () => {
  const hat = previewOf('strohhut.cosmiq')
  const bounds = meshBounds(buildBoneMesh(hat.parts[0].cubes))
  assert.ok(bounds.min[1] > 28, `hat bottom ${bounds.min[1]}`)
  assert.ok(bounds.max[1] < 38, `hat top ${bounds.max[1]}`)
})

test('rejects a file that is not a package', () => {
  assert.throws(() => parseCosmiq(Buffer.alloc(64, 0x41), 'broken'), /kein Cosmiq-Paket/)
  const truncated = bytesOf('bird-cape.cosmiq').subarray(0, 10)
  assert.throws(() => parseCosmiq(truncated, 'truncated'), /unvollst/)
})

test('installs, lists and removes a package in the instance folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-cosmetics-'))
  try {
    const bytes = bytesOf('bamboo-sticks.cosmiq')
    const info = installedCosmetic('anything.cosmiq', bytes)
    assert.equal(info.valid, true)

    const afterInstall = await installPackage(root, bytes, 'Bamboo Sticks')
    assert.equal(afterInstall.length, 1)
    assert.equal(afterInstall[0].name, 'Bamboo Sticks')
    assert.ok(fs.existsSync(path.join(root, 'bamboo', 'cosmetics', afterInstall[0].file)))

    const preview = await previewInstalled(root, afterInstall[0].file)
    assert.equal(preview.name, 'Bamboo Sticks')
    assert.equal(preview.parts.length, 2)

    const afterRemove = await removeInstalled(root, afterInstall[0].file)
    assert.deepEqual(afterRemove, [])
    assert.deepEqual(await listInstalled(root), [])
    await assert.rejects(() => previewInstalled(root, '../escape.cosmiq'), /Ungültiger/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
