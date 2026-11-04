import { readFile } from 'node:fs/promises'
import type { BedrockCube, BedrockFaceUv, FaceName, Vec3 } from './geometry'

/**
 * Reads Bamboo's `.cosmiq` packages for the launcher preview.
 *
 * The container is a Cosmiq package: `COSMIQCP`, framing version 1, then two
 * big-endian lengths (manifest JSON, model JSON) and both documents. The model
 * is a Blockbench java_block document whose textures are embedded as PNG data
 * URLs, so a package needs no second file and can be shown without the game.
 *
 * Geometry stays in Blockbench pixels and feet space (y = 0 at the ground,
 * +Z behind the player), which is exactly the space the player preview uses.
 * The package's `cosmiq.bamboo.fit` is already baked into the elements, so it
 * is never applied a second time here.
 */

const MAGIC = Buffer.from('COSMIQCP', 'ascii')
const HEADER_BYTES = MAGIC.length + 1 + 4 + 4
const MAXIMUM_PACKAGE_BYTES = 16 * 1024 * 1024
const MAXIMUM_MANIFEST_BYTES = 64 * 1024
const MAXIMUM_MODEL_BYTES = 12 * 1024 * 1024
const MAXIMUM_TEXTURE_BYTES = 4 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FACE_NAMES: FaceName[] = ['north', 'south', 'east', 'west', 'up', 'down']
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']

export type CosmeticSlot = 'head' | 'back' | 'cape'

export interface CosmeticPreviewPart {
  /** PNG data URL; the renderer samples it with nearest-neighbour. */
  texture: string
  textureWidth: number
  textureHeight: number
  cubes: BedrockCube[]
}

export interface CosmeticPreview {
  id: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  faces: number
  parts: CosmeticPreviewPart[]
}

export interface InstalledCosmetic {
  /** File name inside `bamboo/cosmetics`. */
  file: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  bytes: number
  valid: boolean
  error?: string
}

interface ParsedPackage {
  manifest: Record<string, unknown>
  model: Record<string, unknown>
}

interface BlockbenchElement {
  from?: unknown
  to?: unknown
  origin?: unknown
  rotation?: unknown
  faces?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  let clean = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    clean += code < 0x20 || code === 0x7f ? ' ' : character
  }
  clean = clean.trim()
  return clean.length > maximum ? clean.slice(0, maximum) : clean
}

function finite(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function triple(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const parsed = value.slice(0, 3).map(finite)
  if (parsed.some((entry) => entry === null)) return null
  return parsed as Vec3
}

function quad(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const parsed = value.slice(0, 4).map(finite)
  if (parsed.some((entry) => entry === null)) return null
  return parsed as [number, number, number, number]
}

function slotsOf(manifest: Record<string, unknown>, tags: string[]): CosmeticSlot[] {
  const slots = new Set<CosmeticSlot>()
  const declared = Array.isArray(manifest.bodySlots) ? manifest.bodySlots : []
  for (const entry of declared) {
    if (typeof entry !== 'string') continue
    const name = entry.toLowerCase()
    if (name.includes('head') || name.includes('hat')) slots.add('head')
    else if (name.includes('back')) slots.add('back')
    else if (name.includes('cape')) slots.add('cape')
  }
  if (tags.some((tag) => tag.includes('cape'))) slots.add('cape')
  if (slots.size === 0) slots.add('back')
  return [...slots]
}

function rarityOf(model: Record<string, unknown>): string {
  const cosmiq = record(model.cosmiq)
  const bamboo = cosmiq ? record(cosmiq.bamboo) : null
  const raw = bamboo ? text(bamboo.rarity, 24).toLowerCase() : ''
  return RARITIES.find((entry) => entry.toLowerCase() === raw) ?? 'Common'
}

function parsePackage(bytes: Buffer): ParsedPackage {
  if (bytes.length < HEADER_BYTES) throw new Error('Paketkopf ist unvollständig')
  if (bytes.length > MAXIMUM_PACKAGE_BYTES) throw new Error('Paket ist zu groß')
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Datei ist kein Cosmiq-Paket')
  }
  if (bytes[MAGIC.length] !== 1) {
    throw new Error('Unbekannte Paket-Version')
  }
  const manifestLength = bytes.readInt32BE(MAGIC.length + 1)
  const modelLength = bytes.readInt32BE(MAGIC.length + 5)
  if (
    manifestLength < 2 ||
    manifestLength > MAXIMUM_MANIFEST_BYTES ||
    modelLength < 2 ||
    modelLength > MAXIMUM_MODEL_BYTES ||
    HEADER_BYTES + manifestLength + modelLength !== bytes.length
  ) {
    throw new Error('Paketlängen passen nicht zur Datei')
  }
  const manifest = record(
    JSON.parse(bytes.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength).toString('utf8')),
  )
  const model = record(
    JSON.parse(bytes.subarray(HEADER_BYTES + manifestLength).toString('utf8')),
  )
  if (!manifest || !model) throw new Error('Paket enthält kein gültiges Modell')
  return { manifest, model }
}

interface DecodedTexture {
  url: string
  width: number
  height: number
}

function decodeTexture(value: unknown): DecodedTexture | null {
  const source = record(value)?.source
  if (typeof source !== 'string') return null
  const comma = source.indexOf(',')
  if (comma < 0 || !source.startsWith('data:image/png;base64,')) return null
  const bytes = Buffer.from(source.slice(comma + 1), 'base64')
  if (bytes.length < 24 || bytes.length > MAXIMUM_TEXTURE_BYTES) return null
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null
  return { url: source, width, height }
}

/** One Blockbench element can use several textures; split it per texture. */
function cubesOf(
  element: BlockbenchElement,
  textures: Array<DecodedTexture | null>,
  resolutionWidth: number,
  resolutionHeight: number,
): Array<{ texture: number; cube: BedrockCube }> {
  const from = triple(element.from)
  const to = triple(element.to)
  const faces = record(element.faces)
  if (!from || !to || !faces) return []
  const size: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  if (size.some((entry) => entry === 0)) return []

  let pivot: Vec3 | undefined
  let rotation: Vec3 | undefined
  // Cosmiq's exporter writes Euler triples around the element origin; a
  // hand-authored Blockbench file uses { angle, axis, origin } instead.
  const euler = triple(element.rotation)
  if (euler && euler.some((value) => value !== 0)) {
    pivot = triple(element.origin) ?? [from[0] + size[0] / 2, from[1] + size[1] / 2, from[2] + size[2] / 2]
    rotation = euler
  } else {
    const elementRotation = record(element.rotation)
    if (elementRotation) {
      const angle = finite(elementRotation.angle)
      const origin = triple(elementRotation.origin)
      const axis = text(elementRotation.axis, 1).toLowerCase()
      if (angle !== null && origin && (axis === 'x' || axis === 'y' || axis === 'z')) {
        pivot = origin
        rotation = [axis === 'x' ? angle : 0, axis === 'y' ? angle : 0, axis === 'z' ? angle : 0]
      }
    }
  }

  const perTexture = new Map<number, Partial<Record<FaceName, BedrockFaceUv>>>()
  for (const faceName of FACE_NAMES) {
    const face = record(faces[faceName])
    if (!face) continue
    const rect = quad(face.uv)
    const texture = finite(face.texture)
    if (!rect || texture === null) continue
    const index = Math.trunc(texture)
    const decoded = textures[index]
    if (index < 0 || !decoded) continue
    // Blockbench UVs live in the model resolution (usually 16), the PNG can be
    // any size. Scaling to image pixels keeps the shared mesh builder exact.
    const scaleX = decoded.width / (resolutionWidth || decoded.width)
    const scaleY = decoded.height / (resolutionHeight || decoded.height)
    const rotationSteps = finite(face.rotation) ?? 0
    const facesOfTexture = perTexture.get(index) ?? {}
    facesOfTexture[faceName] = {
      uv: [Math.min(rect[0], rect[2]) * scaleX, Math.min(rect[1], rect[3]) * scaleY],
      uv_size: [(rect[2] - rect[0]) * scaleX, (rect[3] - rect[1]) * scaleY],
      ...(rotationSteps ? { uv_rotation: rotationSteps } : {}),
    }
    perTexture.set(index, facesOfTexture)
  }

  const result: Array<{ texture: number; cube: BedrockCube }> = []
  for (const [texture, uv] of perTexture) {
    result.push({
      texture,
      cube: {
        origin: from,
        size,
        uv,
        ...(pivot && rotation ? { pivot, rotation } : {}),
      },
    })
  }
  return result
}

function metadataOf(manifest: Record<string, unknown>, model: Record<string, unknown>, id: string) {
  const tags = Array.isArray(manifest.tags)
    ? manifest.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const cosmiq = record(model.cosmiq)
  const publicMetadata = cosmiq ? record(cosmiq.public) : null
  return {
    name: text(manifest.displayName, 96) || id,
    creator: text(manifest.creatorName, 96) || text(publicMetadata?.creatorName, 96) || 'Unbekannt',
    description:
      text(manifest.description, 512) || text(publicMetadata?.description, 512) || '',
    rarity: rarityOf(model),
    slots: slotsOf(manifest, tags),
  }
}

export function parseCosmiq(bytes: Buffer, id: string): CosmeticPreview {
  const { manifest, model } = parsePackage(bytes)
  const metadata = metadataOf(manifest, model, id)
  const resolution = record(model.resolution)
  const resolutionWidth = finite(resolution?.width) ?? 16
  const resolutionHeight = finite(resolution?.height) ?? 16

  const rawTextures = Array.isArray(model.textures) ? model.textures : []
  const textures = rawTextures.map(decodeTexture)
  const elements = Array.isArray(model.elements) ? model.elements : []

  const parts = new Map<number, { texture: DecodedTexture; cubes: BedrockCube[] }>()
  for (const entry of elements) {
    const element = record(entry)
    if (!element) continue
    for (const { texture, cube } of cubesOf(element, textures, resolutionWidth, resolutionHeight)) {
      const decoded = textures[texture]
      if (!decoded) continue
      const part = parts.get(texture) ?? { texture: decoded, cubes: [] }
      part.cubes.push(cube)
      parts.set(texture, part)
    }
  }

  const previewParts: CosmeticPreviewPart[] = []
  let faces = 0
  for (const part of parts.values()) {
    if (part.cubes.length === 0) continue
    faces += part.cubes.reduce((sum, cube) => sum + Object.keys(cube.uv ?? {}).length, 0)
    previewParts.push({
      texture: part.texture.url,
      textureWidth: part.texture.width,
      textureHeight: part.texture.height,
      cubes: part.cubes,
    })
  }
  if (previewParts.length === 0) throw new Error('Paket enthält keine sichtbaren Flächen')

  return {
    id,
    ...metadata,
    faces,
    parts: previewParts,
  }
}

export async function readCosmiqFile(file: string): Promise<CosmeticPreview> {
  return parseCosmiq(await readFile(file), file)
}

/** Metadata only; the launcher asks for the textures when an item is selected. */
export function installedCosmetic(file: string, bytes: Buffer): InstalledCosmetic {
  try {
    // Listing must not decode every texture; only the selected package is
    // turned into geometry.
    const { manifest, model } = parsePackage(bytes)
    return {
      file,
      ...metadataOf(manifest, model, file),
      bytes: bytes.length,
      valid: true,
    }
  } catch (error) {
    return {
      file,
      name: file.replace(/\.cosmiq$/i, ''),
      creator: '',
      description: '',
      rarity: 'Common',
      slots: ['back'],
      bytes: bytes.length,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
