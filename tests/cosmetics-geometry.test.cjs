/**
 * Cosmetic geometry: the bundle's cube/UV data must become the same triangles
 * for every consumer, so the face order, UV orientation, negative sizes and
 * cube rotation are pinned here.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const {
  buildBoneMesh,
  boneMesh,
  boxUvFaces,
  meshBounds,
  normalizedUvs,
} = require('../dist-electron/cosmetics/geometry.js')
const { createCapeGeometry } = require('../dist-electron/cosmetics/cape.js')
const {
  packAtlas,
  toBedrock,
  encodePng,
  decodePng,
  eulerFromJavaRotation,
  textureName,
} = require('../scripts/import-cosmetics.cjs')

const RESOURCES = path.join(__dirname, '..', 'resources', 'cosmetics')

function cubeUv(uv, size) {
  return {
    north: { uv, uv_size: size },
    south: { uv, uv_size: size },
    east: { uv, uv_size: size },
    west: { uv, uv_size: size },
    up: { uv, uv_size: size },
    down: { uv, uv_size: size },
  }
}

function faceVertices(mesh, faceIndex) {
  const start = faceIndex * 4
  const out = []
  for (let vertex = 0; vertex < 4; vertex += 1) {
    const offset = start + vertex
    out.push({
      position: [
        mesh.positions[offset * 3],
        mesh.positions[offset * 3 + 1],
        mesh.positions[offset * 3 + 2],
      ],
      uv: [mesh.uvs[offset * 2], mesh.uvs[offset * 2 + 1]],
    })
  }
  return out
}

test('a cube emits six quads with outward normals and top-left UVs', () => {
  const mesh = buildBoneMesh([
    { origin: [0, 0, 0], size: [1, 1, 1], uv: cubeUv([0, 0], [1, 1]) },
  ])

  assert.equal(mesh.faceCount, 6)
  assert.equal(mesh.positions.length, 24 * 3)
  assert.equal(mesh.indices.length, 36)

  // Faces are emitted north, south, east, west, up, down.
  const north = faceVertices(mesh, 0)
  assert.deepEqual(north[0].position, [1, 1, 0])
  assert.deepEqual(north[1].position, [0, 1, 0])
  assert.deepEqual(north[2].position, [0, 0, 0])
  assert.deepEqual(north[3].position, [1, 0, 0])
  assert.deepEqual(north.map((corner) => corner.uv), [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])

  const northNormal = [mesh.normals[0], mesh.normals[1], mesh.normals[2]]
  assert.deepEqual(northNormal, [0, 0, -1])
  const upNormal = [mesh.normals[16 * 3], mesh.normals[16 * 3 + 1], mesh.normals[16 * 3 + 2]]
  assert.deepEqual(upNormal, [0, 1, 0])
})

test('face uv rectangles keep their atlas origin and size', () => {
  const mesh = buildBoneMesh([
    {
      origin: [0, 0, 0],
      size: [1, 1, 1],
      uv: {
        north: { uv: [8, 4], uv_size: [2, 3] },
        up: { uv: [5, 47], uv_size: [-5, -5] },
        east: { uv: [0, 0], uv_size: [4, 4], uv_rotation: 90 },
      },
    },
  ])

  const north = faceVertices(mesh, 0)
  assert.deepEqual(north.map((corner) => corner.uv), [
    [8, 4],
    [10, 4],
    [10, 7],
    [8, 7],
  ])

  // A negative size mirrors the rect instead of producing inverted bounds.
  // Only three faces were supplied, so the emitted order is north, east, up.
  const up = faceVertices(mesh, 2)
  assert.deepEqual(up.map((corner) => corner.uv), [
    [0, 42],
    [5, 42],
    [5, 47],
    [0, 47],
  ])

  // 90 degrees moves the first corner to the last position.
  const east = faceVertices(mesh, 1)
  assert.deepEqual(east.map((corner) => corner.uv), [
    [0, 4],
    [0, 0],
    [4, 0],
    [4, 4],
  ])
})

test('every quad winds counter-clockwise as seen from outside', () => {
  const mesh = buildBoneMesh([
    { origin: [-1, 0, -1], size: [2, 2, 2], uv: cubeUv([0, 0], [2, 2]) },
  ])
  const point = (index) => [
    mesh.positions[index * 3],
    mesh.positions[index * 3 + 1],
    mesh.positions[index * 3 + 2],
  ]

  for (let face = 0; face < mesh.faceCount; face += 1) {
    const [a, b, c] = [0, 1, 2].map((slot) => mesh.indices[face * 6 + slot])
    const [pa, pb, pc] = [a, b, c].map(point)
    const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ]
    const normal = [mesh.normals[a * 3], mesh.normals[a * 3 + 1], mesh.normals[a * 3 + 2]]
    const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2]
    assert.ok(dot > 0, `face ${face} is wound inwards`)
  }
})

test('the box net puts the right side on +X and the front on -Z', () => {
  const mesh = buildBoneMesh([
    { origin: [-4, 0, -4], size: [8, 8, 8], uv: boxUvFaces(8, 8, 8, 0, 0) },
  ])

  // Emitted north, south, east, west, up, down; corner 0 is the top-left texel.
  const firstUv = (face) => faceVertices(mesh, face)[0].uv
  assert.deepEqual(firstUv(0), [8, 8]) // front (the face)
  assert.deepEqual(firstUv(1), [24, 8]) // back
  assert.deepEqual(firstUv(2), [0, 8]) // character's right
  assert.deepEqual(firstUv(3), [16, 8]) // character's left
})

test('cube rotation turns positions and normals around the pivot', () => {
  const mesh = buildBoneMesh([
    {
      origin: [-1, 0, -1],
      size: [2, 4, 2],
      pivot: [0, 10, 0],
      rotation: [0, 0, 30],
      uv: cubeUv([0, 0], [1, 1]),
    },
  ])

  const north = faceVertices(mesh, 0)
  // (1, 4, -1) rotated 30 degrees about (0, 10, 0) on Z.
  const expectedX = Math.cos(Math.PI / 6) * 1 - Math.sin(Math.PI / 6) * -6
  const expectedY = 10 + Math.sin(Math.PI / 6) * 1 + Math.cos(Math.PI / 6) * -6
  assert.ok(Math.abs(north[0].position[0] - expectedX) < 1e-6)
  assert.ok(Math.abs(north[0].position[1] - expectedY) < 1e-6)
  assert.ok(Math.abs(north[0].position[2] + 1) < 1e-6)

  // The up normal leans with the cube; the north normal is on the rotation axis.
  const upNormal = [mesh.normals[16 * 3], mesh.normals[16 * 3 + 1], mesh.normals[16 * 3 + 2]]
  assert.ok(Math.abs(upNormal[0] + Math.sin(Math.PI / 6)) < 1e-6)
  assert.ok(Math.abs(upNormal[1] - Math.cos(Math.PI / 6)) < 1e-6)
  assert.ok(Math.abs(upNormal[2]) < 1e-6)
})

test('boneMesh reads the requested bone and rejects an empty one', () => {
  const geometry = {
    bones: [
      { name: 'bipedBody', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: cubeUv([0, 0], [1, 1]) }] },
      { name: 'bipedHead', cubes: [] },
    ],
  }
  assert.equal(boneMesh(geometry, 'bipedBody').faceCount, 6)
  assert.equal(boneMesh(geometry, 'bipedHead'), null)
  assert.equal(boneMesh(geometry, 'missing'), null)
})

test('every shipped cosmetic keeps its UVs inside its atlas', () => {
  const entries = fs
    .readdirSync(RESOURCES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(RESOURCES, entry.name, 'cosmetic.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))

  assert.ok(entries.length > 0, 'no cosmetics were generated')

  for (const entry of entries) {
    const geometry = entry.geometry
      ? JSON.parse(fs.readFileSync(path.join(RESOURCES, entry.id, entry.geometry), 'utf8'))['minecraft:geometry'][0]
      : createCapeGeometry(entry.id)['minecraft:geometry'][0]
    const width = geometry.description.texture_width
    const height = geometry.description.texture_height
    const mesh = boneMesh(geometry, entry.bone)
    assert.ok(mesh, `${entry.id} has no mesh on ${entry.bone}`)
    assert.ok(mesh.faceCount > 0, `${entry.id} produced no faces`)

    const seen = new Set()
    for (let index = 0; index < mesh.uvs.length; index += 2) {
      const u = mesh.uvs[index]
      const v = mesh.uvs[index + 1]
      assert.ok(u >= 0 && u <= width, `${entry.id} uv u ${u} outside 0..${width}`)
      assert.ok(v >= 0 && v <= height, `${entry.id} uv v ${v} outside 0..${height}`)
      seen.add(`${u},${v}`)
    }
    assert.ok(seen.size > 1, `${entry.id} collapsed every face onto one texel`)
  }
})

test('boneMesh accepts the shipped Bedrock document without a manual unwrap', () => {
  const entries = fs
    .readdirSync(RESOURCES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(RESOURCES, entry.name, 'cosmetic.json'))
    .filter((file) => fs.existsSync(file))
  assert.ok(entries.length > 0, 'no cosmetics were generated')

  for (const file of entries) {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    const document = entry.geometry
      ? JSON.parse(fs.readFileSync(path.join(RESOURCES, entry.id, entry.geometry), 'utf8'))
      : createCapeGeometry(entry.id)
    const mesh = boneMesh(document, entry.bone)
    assert.ok(mesh, `${entry.id} is not readable straight from its bundle document`)
    assert.ok(mesh.faceCount > 0, `${entry.id} produced no faces from its bundle document`)
  }
})

test('texture-only capes get the vanilla cape shape and layout', () => {
  const geometry = createCapeGeometry('vogel-cape')
  const mesh = boneMesh(geometry, 'bipedBody')
  assert.ok(mesh)
  assert.equal(mesh.faceCount, 6)
  const bounds = meshBounds(mesh)
  assert.deepEqual(bounds.min.slice(0, 2), [-5, 8])
  assert.deepEqual(bounds.max.slice(0, 2), [5, 24])
  assert.ok(Math.abs(bounds.min[2] - 2.1) < 1e-5)
  assert.ok(Math.abs(bounds.max[2] - 3.1) < 1e-5)

  // Face order is north, south, east, west, up, down. The outward-facing south
  // face (face 1) has to sample the unmirrored 10x16 panel at 1,1; the inward
  // north face takes the mirrored copy at 12,1. This is the same visual result
  // as vanilla's 180° cape yaw without rotating the mesh.
  assert.deepEqual(faceVertices(mesh, 1).map((corner) => corner.uv), [
    [1, 1],
    [11, 1],
    [11, 17],
    [1, 17],
  ])
  assert.deepEqual(faceVertices(mesh, 0).map((corner) => corner.uv), [
    [12, 1],
    [22, 1],
    [22, 17],
    [12, 17],
  ])
})

test('the bird cape maps its whole artwork onto the outward cape face', () => {
  const file = path.join(RESOURCES, 'bird-cape', 'bird-cape.geo.json')
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  const mesh = boneMesh(document, 'bipedBody')
  assert.ok(mesh)

  // South is the face the camera sees from behind. It must sample the full
  // 160x256 artwork panel, not the old 40x64 corner crop that blew the bird
  // up and cut it in half.
  assert.deepEqual(faceVertices(mesh, 1).map((corner) => corner.uv), [
    [0, 0],
    [160, 0],
    [160, 256],
    [0, 256],
  ])

  // The cape still hangs from the shoulders down to hip height.
  const bounds = meshBounds(mesh)
  assert.ok(Math.abs(bounds.min[1] - 8) < 0.2, `cape bottom ${bounds.min[1]}`)
  assert.ok(Math.abs(bounds.max[1] - 24) < 0.2, `cape top ${bounds.max[1]}`)
})

test('cape uvs normalise against the 64x32 sheet, not a square sheet', () => {
  const document = createCapeGeometry('preview')
  const description = document['minecraft:geometry'][0].description
  assert.equal(description.texture_width, 64)
  assert.equal(description.texture_height, 32)

  const mesh = boneMesh(document, 'bipedBody')
  const uvs = normalizedUvs(mesh.uvs, description.texture_width, description.texture_height)
  const at = (vertex, axis) => uvs[vertex * 2 + axis]
  const close = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`)

  // The outward south quad is the second face (vertices 4..7) and samples the
  // unmirrored panel: 1,1 to 11,17.
  const outward = 4
  close(at(outward, 0), 1 / 64, 'outward left u')
  close(at(outward, 1), 1 / 32, 'outward top v')
  close(at(outward + 2, 0), 11 / 64, 'outward right u')
  close(at(outward + 2, 1), 17 / 32, 'outward bottom v')

  // A square normalisation would halve every v above, sampling the top half
  // of the panel only. Every cape UV has to stay inside the sheet.
  for (let index = 0; index < uvs.length; index += 2) {
    assert.ok(uvs[index] >= 0 && uvs[index] <= 1, 'u outside the sheet')
    assert.ok(uvs[index + 1] >= 0 && uvs[index + 1] <= 1, 'v outside the sheet')
  }
})

test('pixel uvs normalise to the renderer range', () => {
  const uvs = new Float32Array([0, 0, 64, 32, 128, 64])
  assert.deepEqual(Array.from(normalizedUvs(uvs, 128, 64)), [0, 0, 0.5, 0.5, 1, 1])
  assert.equal(normalizedUvs(uvs, 0, 0), uvs)
})

test('the atlas packer keeps source pixels and maps the 0..16 grid onto cells', () => {
  const red = { key: '#0', width: 32, height: 32, rgba: Buffer.alloc(32 * 32 * 4, 255) }
  const blue = { key: '#1', width: 16, height: 16, rgba: Buffer.alloc(16 * 16 * 4, 255) }
  for (let index = 0; index < blue.rgba.length; index += 4) {
    blue.rgba[index] = 0
    blue.rgba[index + 1] = 0
  }

  const atlas = packAtlas([red, blue])
  assert.equal(atlas.width, 48)
  assert.equal(atlas.height, 32)
  assert.deepEqual(atlas.cells.get('#0'), { x: 0, y: 0, width: 32, height: 32, scaleX: 2, scaleY: 2 })
  assert.deepEqual(atlas.cells.get('#1'), { x: 32, y: 0, width: 16, height: 16, scaleX: 1, scaleY: 1 })

  // The packed pixel at (33, 1) must be the blue texture's pixel (1, 1).
  const offset = (1 * atlas.width + 33) * 4
  assert.deepEqual([...atlas.rgba.subarray(offset, offset + 4)], [0, 0, 255, 255])

  const model = {
    elements: [
      {
        name: 'part',
        from: [0, 0, 0],
        to: [1, 1, 1],
        faces: { north: { uv: [0, 0, 2, 4], texture: '#1' } },
      },
    ],
  }
  const geometry = toBedrock(model, atlas, { identifier: 'test', bone: 'bipedHead' })
  const cube = geometry['minecraft:geometry'][0].bones[0].cubes[0]
  assert.deepEqual(cube.uv.north, { uv: [32, 0], uv_size: [2, 4] })
  assert.equal(geometry['minecraft:geometry'][0].description.texture_width, 48)
})

test('java rotation and texture references are normalised', () => {
  assert.deepEqual(eulerFromJavaRotation({ angle: 30, axis: 'z', origin: [0, 10, 0] }), {
    pivot: [0, 10, 0],
    rotation: [0, 0, 30],
  })
  assert.deepEqual(eulerFromJavaRotation({ x: 5, y: 0, z: -5, origin: [0, 0, 0] }), {
    pivot: [0, 0, 0],
    rotation: [5, 0, -5],
  })
  assert.equal(eulerFromJavaRotation(undefined), null)
  assert.equal(textureName('Duck Crown:crown_high'), 'crown_high')
  assert.equal(textureName('plain'), 'plain')
})

test('png round-trip preserves pixels', () => {
  const rgba = Buffer.alloc(4 * 3 * 4)
  for (let index = 0; index < rgba.length; index += 1) rgba[index] = (index * 7) % 256
  const decoded = decodePng(encodePng(4, 3, rgba))
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 3)
  assert.deepEqual([...decoded.rgba], [...rgba])
})

test('mesh bounds cover the authored volume', () => {
  const mesh = buildBoneMesh([
    { origin: [-2, 0, -1], size: [4, 6, 2], uv: cubeUv([0, 0], [1, 1]) },
  ])
  assert.deepEqual(meshBounds(mesh), { min: [-2, 0, -1], max: [2, 6, 1] })
})
