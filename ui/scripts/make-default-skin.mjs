/**
 * Builds `public/images/default-skin.png`: the 64x64 sheet the cosmetics
 * preview falls back to when no account skin and no local skin exist.
 *
 * Run once after changing the palette: `node scripts/make-default-skin.mjs`.
 * The layout is Minecraft's box net; only the base layer is painted, so every
 * overlay region stays fully transparent and adds no second skin on top.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 64
const pixels = new Uint8Array(SIZE * SIZE * 4)

const COLORS = {
  skin: [230, 181, 140],
  skinShade: [208, 154, 114],
  hair: [58, 42, 30],
  shirt: [63, 107, 74],
  shirtLight: [79, 127, 88],
  shirtDark: [47, 82, 57],
  trousers: [47, 58, 68],
  trousersShade: [38, 47, 55],
  shoes: [27, 34, 42],
  eye: [43, 43, 43],
}

function paint(x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * SIZE + column) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = 255
    }
  }
}

// Head base: 32x16 at (0,0). Front face sits on (8,8)-(16,16).
paint(0, 0, 32, 16, COLORS.skin)
paint(8, 0, 8, 8, COLORS.hair) // top
paint(16, 0, 8, 8, COLORS.skinShade) // bottom (neck)
paint(0, 8, 8, 8, COLORS.hair) // right
paint(24, 8, 8, 8, COLORS.hair) // back
paint(16, 8, 8, 8, COLORS.hair) // left
// Front: fringe, eyes, mouth.
paint(8, 8, 8, 2, COLORS.hair)
paint(9, 12, 2, 1, COLORS.eye)
paint(13, 12, 2, 1, COLORS.eye)
paint(10, 14, 4, 1, COLORS.skinShade)

// Body base: 16x12x4 net = 16x16 at (16,16).
paint(16, 16, 24, 16, COLORS.shirt)
paint(32, 20, 4, 12, COLORS.shirtDark) // back panel
paint(16, 20, 4, 12, COLORS.shirtLight) // right panel
paint(20, 20, 8, 12, COLORS.shirt)
paint(23, 20, 2, 12, COLORS.shirtLight) // bamboo stripe down the chest

// Arms: sleeve, skin hands. Right at (40,16), left at (32,48).
paint(40, 16, 16, 16, COLORS.shirt)
paint(40, 28, 16, 4, COLORS.skin)
paint(32, 48, 16, 16, COLORS.shirt)
paint(32, 60, 16, 4, COLORS.skin)

// Legs: trousers, shoes. Right at (0,16), left at (16,48).
paint(0, 16, 16, 16, COLORS.trousers)
paint(0, 29, 16, 3, COLORS.shoes)
paint(16, 48, 16, 16, COLORS.trousers)
paint(16, 61, 16, 3, COLORS.shoes)
paint(0, 16, 16, 4, COLORS.trousersShade)

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // RGBA
// Every scanline starts with filter type 0.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let row = 0; row < SIZE; row += 1) {
  const start = row * (SIZE * 4 + 1)
  raw[start] = 0
  Buffer.from(pixels.buffer, row * SIZE * 4, SIZE * 4).copy(raw, start + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images', 'default-skin.png')
writeFileSync(target, png)
console.log(`default-skin.png: ${png.length} bytes`)
