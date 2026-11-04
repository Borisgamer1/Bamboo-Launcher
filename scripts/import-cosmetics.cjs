#!/usr/bin/env node
/**
 * Builds the launcher's cosmetic assets from the Blockbench sources in
 * BambooContent/Cosmetics.
 *
 * Input:  a Java block model per cosmetic (elements + faces + per-face UVs in a
 *         0..16 grid, one or more textures) and its PNG textures.
 * Output: one atlas per cosmetic plus a Bedrock geometry whose per-face UVs are
 *         already expressed in atlas pixels. Both the launcher preview and the
 *         Fabric mod read this output, so there is exactly one place that maps
 *         Blockbench UVs onto a texture.
 *
 * The atlas rule is fixed and covered by tests:
 *   every source texture gets a cell of its own pixel size, cells are packed in
 *   one row, and  uv_atlas = uv_source * (cellWidth / 16) + cellOrigin.
 *
 * Usage: node scripts/import-cosmetics.cjs [--check]
 *        --check  build in memory and report what would change, write nothing
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const PROJECT_ROOT = path.join(__dirname, '..')
const DEFAULT_CONTENT_ROOT = path.join(PROJECT_ROOT, '..', 'BambooContent', 'Cosmetics')
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'resources', 'cosmetics')
const UV_GRID = 16

/* ------------------------------------------------------------------ PNG I/O */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let transparency = null
  const chunks = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      chunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  let position = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position]
    position += 1
    const line = Buffer.from(raw.subarray(position, position + stride))
    position += stride
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[index] = (line[index] + left) & 0xff
          break
        case 2:
          line[index] = (line[index] + up) & 0xff
          break
        case 3:
          line[index] = (line[index] + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const estimate = left + up - upLeft
          const distanceLeft = Math.abs(estimate - left)
          const distanceUp = Math.abs(estimate - up)
          const distanceUpLeft = Math.abs(estimate - upLeft)
          const predictor =
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft
          line[index] = (line[index] + predictor) & 0xff
          break
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`)
      }
    }
    previous = line
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      if (colorType === 6) {
        rgba[target] = line[x * 4]
        rgba[target + 1] = line[x * 4 + 1]
        rgba[target + 2] = line[x * 4 + 2]
        rgba[target + 3] = line[x * 4 + 3]
      } else if (colorType === 2) {
        rgba[target] = line[x * 3]
        rgba[target + 1] = line[x * 3 + 1]
        rgba[target + 2] = line[x * 3 + 2]
        rgba[target + 3] = 255
      } else if (colorType === 3) {
        const index = line[x]
        rgba[target] = palette[index * 3]
        rgba[target + 1] = palette[index * 3 + 1]
        rgba[target + 2] = palette[index * 3 + 2]
        rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255
      } else if (colorType === 4) {
        rgba[target] = line[x * 2]
        rgba[target + 1] = line[x * 2]
        rgba[target + 2] = line[x * 2]
        rgba[target + 3] = line[x * 2 + 1]
      } else {
        rgba[target] = line[x]
        rgba[target + 1] = line[x]
        rgba[target + 2] = line[x]
        rgba[target + 3] = 255
      }
    }
  }
  return { width, height, rgba }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------- model import */

/** Java block model texture reference (`"Pack:name"`) to a bare texture name. */
function textureName(reference) {
  const value = String(reference)
  const separator = value.lastIndexOf(':')
  return (separator >= 0 ? value.slice(separator + 1) : value).trim()
}

function readModel(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(json.elements) || json.elements.length === 0) {
    throw new Error(`${path.basename(file)} has no elements`)
  }
  if (!json.textures || typeof json.textures !== 'object') {
    throw new Error(`${path.basename(file)} has no texture map`)
  }
  return json
}

/** Pack every referenced texture into one row; returns cells keyed by `#key`. */
function packAtlas(textures) {
  let width = 0
  let height = 0
  for (const texture of textures) {
    width += texture.width
    height = Math.max(height, texture.height)
  }
  const rgba = Buffer.alloc(width * height * 4)
  const cells = new Map()
  let x = 0
  for (const texture of textures) {
    for (let y = 0; y < texture.height; y += 1) {
      texture.rgba.copy(rgba, (y * width + x) * 4, y * texture.width * 4, (y + 1) * texture.width * 4)
    }
    cells.set(texture.key, {
      x,
      y: 0,
      width: texture.width,
      height: texture.height,
      scaleX: texture.width / UV_GRID,
      scaleY: texture.height / UV_GRID,
    })
    x += texture.width
  }
  return { width, height, rgba, cells }
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

function eulerFromJavaRotation(rotation) {
  if (!rotation) return null
  const origin = Array.isArray(rotation.origin) ? rotation.origin : [0, 0, 0]
  if (typeof rotation.angle === 'number') {
    const axis = String(rotation.axis || '').toLowerCase()
    const angle = rotation.angle
    return {
      pivot: [origin[0], origin[1], origin[2]],
      rotation:
        axis === 'x'
          ? [angle, 0, 0]
          : axis === 'y'
            ? [0, angle, 0]
            : axis === 'z'
              ? [0, 0, angle]
              : null,
    }
  }
  if (typeof rotation.x === 'number' || typeof rotation.y === 'number' || typeof rotation.z === 'number') {
    return {
      pivot: [origin[0], origin[1], origin[2]],
      rotation: [rotation.x || 0, rotation.y || 0, rotation.z || 0],
    }
  }
  return null
}

const FACE_NAMES = ['north', 'south', 'east', 'west', 'up', 'down']

/**
 * Converts a Java block model into a Bedrock geometry with atlas UVs.
 * `bone` is the attachment anchor the renderer mounts the mesh on; `offset`
 * moves the authored model into the player's feet space, so every consumer
 * renders the same placement without inventing its own correction.
 */
/** The player-space pivot of the part the mesh is mounted on. */
function bonePivot(bone) {
  switch (String(bone || '').toLowerCase()) {
    case 'bipedhead':
    case 'bipedbody':
      return [0, 24, 0]
    case 'bipedleftarm':
    case 'bipedrightarm':
      return [0, 22, 0]
    case 'bipedleftleg':
    case 'bipedrightleg':
      return [0, 12, 0]
    default:
      return [0, 0, 0]
  }
}

function toBedrock(model, atlas, { identifier, bone, offset = [0, 0, 0], pivot = bonePivot(bone) }) {
  const cubes = []
  for (const element of model.elements) {
    const from = element.from
    const to = element.to
    if (!Array.isArray(from) || !Array.isArray(to)) {
      throw new Error(`${element.name || 'element'} is missing from/to`)
    }
    const uv = {}
    for (const face of FACE_NAMES) {
      const source = element.faces && element.faces[face]
      if (!source || !Array.isArray(source.uv)) continue
      const cell = atlas.cells.get(source.texture)
      if (!cell) throw new Error(`face ${face} of ${element.name} uses an unpacked texture`)
      const [u0, v0, u1, v1] = source.uv
      uv[face] = {
        uv: [round(u0 * cell.scaleX + cell.x), round(v0 * cell.scaleY + cell.y)],
        uv_size: [round((u1 - u0) * cell.scaleX), round((v1 - v0) * cell.scaleY)],
      }
    }
    if (Object.keys(uv).length === 0) continue
    const cube = {
      origin: [from[0] + offset[0], from[1] + offset[1], from[2] + offset[2]],
      size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
      uv,
    }
    if (typeof element.inflate === 'number' && element.inflate !== 0) cube.inflate = element.inflate
    if (element.mirror === true) cube.mirror = true
    const rotation = eulerFromJavaRotation(element.rotation)
    if (rotation && rotation.rotation && rotation.rotation.some((value) => value !== 0)) {
      cube.pivot = [
        rotation.pivot[0] + offset[0],
        rotation.pivot[1] + offset[1],
        rotation.pivot[2] + offset[2],
      ]
      cube.rotation = rotation.rotation
    }
    cubes.push(cube)
  }

  return {
    format_version: '1.12.0',
    'minecraft:geometry': [
      {
        description: {
          identifier: `geometry.bamboo.${identifier}`,
          texture_width: atlas.width,
          texture_height: atlas.height,
        },
        bones: [{ name: bone, pivot, cubes }],
      },
    ],
  }
}

/* -------------------------------------------------------------------- driver */

function listTextures(model, texturesDir) {
  const available = new Map()
  for (const file of fs.readdirSync(texturesDir)) {
    if (!file.toLowerCase().endsWith('.png')) continue
    available.set(file.slice(0, -4).toLowerCase(), path.join(texturesDir, file))
  }
  const ordered = []
  for (const [key, reference] of Object.entries(model.textures)) {
    if (key === 'particle') continue
    const name = textureName(reference)
    const file = available.get(name.toLowerCase())
    if (!file) {
      throw new Error(`texture "${name}" is referenced but missing in ${texturesDir}`)
    }
    ordered.push({ key: `#${key}`, file, name, ...decodePng(fs.readFileSync(file)) })
  }
  return ordered
}

function defaultAttachment(entry) {
  return {
    bone: entry.bone,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }
}

/**
 * The transform is authored in the dev editor and lives in cosmetic.json, the
 * bundle contract both renderers read. Re-importing keeps it instead of
 * resetting every slider, unless sources.json explicitly carries one.
 */
function readAttachment(entry, existingMeta) {
  const candidate = existingMeta && existingMeta.attachment ? existingMeta.attachment : entry.attachment
  if (!candidate) return defaultAttachment(entry)
  return {
    bone: typeof candidate.bone === 'string' && candidate.bone ? candidate.bone : entry.bone,
    position: Array.isArray(candidate.position) ? candidate.position : [0, 0, 0],
    rotation: Array.isArray(candidate.rotation) ? candidate.rotation : [0, 0, 0],
    scale: Array.isArray(candidate.scale) ? candidate.scale : [1, 1, 1],
  }
}

function readExistingMeta(id) {
  const file = path.join(OUTPUT_ROOT, id, 'cosmetic.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function buildEntry(entry, contentRoot) {
  const sourceDir = path.join(contentRoot, entry.folder)
  if (!fs.existsSync(sourceDir)) return { skipped: `folder not found: ${sourceDir}` }
  const models = fs.readdirSync(sourceDir).filter((file) => file.toLowerCase().endsWith('.json'))
  if (models.length !== 1) {
    return { skipped: `expected exactly one model json in ${sourceDir}, found ${models.length}` }
  }
  const model = readModel(path.join(sourceDir, models[0]))
  const textures = listTextures(model, path.join(sourceDir, 'textures'))
  if (textures.length === 0) return { skipped: `no textures in ${sourceDir}` }
  const atlas = packAtlas(textures)
  const offset = entry.offset || [0, 0, 0]
  const geometry = toBedrock(model, atlas, { identifier: entry.id, bone: entry.bone, offset })
  const meta = {
    id: entry.id,
    name: entry.name,
    slot: entry.slot,
    bone: entry.bone,
    offset,
    attachment: readAttachment(entry, readExistingMeta(entry.id)),
    geometry: `${entry.id}.geo.json`,
    texture: `${entry.id}.png`,
    source: entry.folder,
    cubes: geometry['minecraft:geometry'][0].bones[0].cubes.length,
  }
  return { meta, geometry, atlas, textures: textures.length }
}

function main() {
  const check = process.argv.includes('--check')
  const contentRoot = process.env.BAMBOO_COSMETIC_SOURCE || DEFAULT_CONTENT_ROOT
  const sourcesFile = path.join(OUTPUT_ROOT, 'sources.json')
  if (!fs.existsSync(sourcesFile)) {
    console.error(`Missing ${sourcesFile}`)
    process.exitCode = 1
    return
  }
  const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
  if (!Array.isArray(sources.entries)) {
    console.error('sources.json has no entries')
    process.exitCode = 1
    return
  }

  const written = []
  const skipped = []
  for (const entry of sources.entries) {
    let result
    try {
      result = buildEntry(entry, contentRoot)
    } catch (error) {
      skipped.push(`${entry.folder}: ${error.message}`)
      continue
    }
    if (result.skipped) {
      skipped.push(`${entry.folder}: ${result.skipped}`)
      continue
    }
    const dir = path.join(OUTPUT_ROOT, entry.id)
    const files = [
      [path.join(dir, result.meta.geometry), `${JSON.stringify(result.geometry, null, 2)}\n`],
      [path.join(dir, `${entry.id}.png`), encodePng(result.atlas.width, result.atlas.height, result.atlas.rgba)],
      [path.join(dir, 'cosmetic.json'), `${JSON.stringify(result.meta, null, 2)}\n`],
    ]
    if (!check) fs.mkdirSync(dir, { recursive: true })
    for (const [file, content] of files) {
      if (!check) fs.writeFileSync(file, content)
      written.push(path.relative(PROJECT_ROOT, file))
    }
    console.log(
      `${entry.id}: ${result.meta.cubes} cubes, ${result.textures} texture(s), atlas ${result.atlas.width}x${result.atlas.height}`,
    )
  }

  for (const message of skipped) console.warn(`skipped ${message}`)
  console.log(`${check ? 'would write' : 'wrote'} ${written.length} file(s)`)
}

if (require.main === module) main()

module.exports = {
  decodePng,
  encodePng,
  packAtlas,
  toBedrock,
  textureName,
  eulerFromJavaRotation,
  readModel,
  buildEntry,
}
