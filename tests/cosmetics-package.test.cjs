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

test('keeps one account-wide library and mirrors it into every instance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bamboo-cosmetics-'))
  try {
    const library = path.join(root, 'library')
    const first = path.join(root, 'one')
    const second = path.join(root, 'two')
    const bytes = bytesOf('bamboo-sticks.cosmiq')
    assert.equal(installedCosmetic('anything.cosmiq', bytes).valid, true)

    const afterInstall = await installPackage(library, [first, second], bytes, 'Bamboo Sticks')
    assert.equal(afterInstall.length, 1)
    const file = afterInstall[0].file
    assert.ok(fs.existsSync(path.join(library, file)), 'library copy')
    assert.ok(fs.existsSync(path.join(first, 'bamboo', 'cosmetics', file)), 'first instance')
    assert.ok(fs.existsSync(path.join(second, 'bamboo', 'cosmetics', file)), 'second instance')

    // A package dropped into an instance by hand is adopted, not overwritten.
    const third = path.join(root, 'three')
    fs.mkdirSync(path.join(third, 'bamboo', 'cosmetics'), { recursive: true })
    fs.writeFileSync(path.join(third, 'bamboo', 'cosmetics', 'strohhut.cosmiq'), bytesOf('strohhut.cosmiq'))
    const adopted = await listInstalled(library, [first, second, third])
    assert.deepEqual(adopted.map((entry) => entry.name).sort(), ['Bamboo Sticks', 'Strohhut'])
    assert.ok(fs.existsSync(path.join(library, 'strohhut.cosmiq')))

    const preview = await previewInstalled(library, file)
    assert.equal(preview.name, 'Bamboo Sticks')
    assert.equal(preview.parts.length, 2)

    const afterRemove = await removeInstalled(library, [first, second, third], file)
    assert.deepEqual(afterRemove.map((entry) => entry.name), ['Strohhut'])
    assert.equal(fs.existsSync(path.join(first, 'bamboo', 'cosmetics', file)), false)
    assert.equal(fs.existsSync(path.join(second, 'bamboo', 'cosmetics', file)), false)
    await assert.rejects(() => previewInstalled(library, '../escape.cosmiq'), /Ungültiger/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bundled catalog points at artwork that exists', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(SHOP, 'catalog.json'), 'utf8'))
  const cape = catalog.items.find((entry) => entry.id === 'bird-cape')
  assert.equal(cape.image, './previews/bird-cape.png')
  assert.ok(fs.existsSync(path.join(SHOP, cape.image)), 'preview file next to the catalog')
  for (const item of catalog.items) {
    assert.equal(item.image, `./previews/${item.id}.png`, `${item.id} has a preview`)
    assert.ok(fs.existsSync(path.join(SHOP, item.image)), `${item.id}: preview file next to the catalog`)
  }
})

test('shop entries expose resolved artwork instead of a filesystem path', async () => {
  // The remote catalog is tried first on purpose; the offline guard must not
  // count this test's deliberate request as a hidden dependency.
  process.env.BAMBOO_OFFLINE_EXPECT = 'raw.githubusercontent.com'
  const { loadShop } = require('../dist-electron/cosmetics/shop.js')
  const catalog = await loadShop()
  assert.ok(catalog.items.length > 0)
  for (const item of catalog.items) {
    if (item.image === null) continue
    // Bundled: data URL, because the renderer cannot read files.
    // Remote: the raw GitHub URL of the PNG.
    assert.ok(
      item.image.startsWith(catalog.source === 'local' ? 'data:image/' : 'https://'),
      `${item.id}: ${item.image.slice(0, 40)}`,
    )
  }
})
