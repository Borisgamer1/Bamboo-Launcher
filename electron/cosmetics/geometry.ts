/**
 * Bedrock geometry -> triangle soup, in model pixels.
 *
 * This is the only place that turns a cosmetic's cube/UV data into vertices, so
 * the launcher preview and (later) any other consumer agree on face winding,
 * UV orientation and rotation. It has no renderer dependency and is covered by
 * tests/cosmetics-geometry.test.cjs.
 *
 * Conventions, all taken from the bundle format:
 * - 1 unit = 1 Blockbench pixel, +Y up, -Z is the character's front.
 * - Cube rotation is Euler in degrees, applied X then Y then Z (right-handed).
 * - Face UVs are atlas pixels with the origin at the top left; a negative
 *   `uv_size` mirrors the face along that axis (Bedrock's own encoding).
 */

export type Vec3 = [number, number, number]

export interface BedrockFaceUv {
  uv: [number, number]
  uv_size?: [number, number]
  uv_rotation?: number
}

export type FaceName = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'

export interface BedrockCube {
  origin?: Vec3
  size?: Vec3
  pivot?: Vec3
  rotation?: Vec3
  uv?: [number, number] | Partial<Record<FaceName, BedrockFaceUv>>
  inflate?: number
  mirror?: boolean
}

export interface BedrockBone {
  name: string
  parent?: string
  pivot?: Vec3
  cubes?: BedrockCube[]
}

export interface BedrockGeometry {
  description?: { identifier?: string; texture_width?: number; texture_height?: number }
  bones?: BedrockBone[]
}

/** A Blockbench/Bedrock document: the geometry array the bundle ships. */
export interface BedrockDocument {
  format_version?: string
  'minecraft:geometry'?: BedrockGeometry[]
}

export interface CosmeticMeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint16Array
  /** Publicly exposed so the caller can order draws without re-reading the geometry. */
  faceCount: number
}

const FACE_ORDER: FaceName[] = ['north', 'south', 'east', 'west', 'up', 'down']

/** Top-left, top-right, bottom-right, bottom-left as seen from outside the cube. */
const FACE_CORNERS: Record<FaceName, [number, number, number, number]> = {
  north: [7, 4, 0, 3],
  south: [5, 6, 2, 1],
  east: [6, 7, 3, 2],
  west: [4, 5, 1, 0],
  up: [4, 7, 6, 5],
  down: [1, 2, 3, 0],
}

const FACE_NORMALS: Record<FaceName, Vec3> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
}

const DEG = Math.PI / 180

function cubeCorners(origin: Vec3, size: Vec3, inflate: number): Vec3[] {
  const x0 = origin[0] - inflate
  const y0 = origin[1] - inflate
  const z0 = origin[2] - inflate
  const x1 = origin[0] + size[0] + inflate
  const y1 = origin[1] + size[1] + inflate
  const z1 = origin[2] + size[2] + inflate
  return [
    [x0, y0, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y0, z0],
    [x0, y1, z0],
    [x0, y1, z1],
    [x1, y1, z1],
    [x1, y1, z0],
  ]
}

function rotateAround(point: Vec3, pivot: Vec3, rotation: Vec3): Vec3 {
  let x = point[0] - pivot[0]
  let y = point[1] - pivot[1]
  let z = point[2] - pivot[2]

  const [rx, ry, rz] = [rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG]
  if (rx !== 0) {
    const cos = Math.cos(rx)
    const sin = Math.sin(rx)
    const nextY = y * cos - z * sin
    z = y * sin + z * cos
    y = nextY
  }
  if (ry !== 0) {
    const cos = Math.cos(ry)
    const sin = Math.sin(ry)
    const nextX = x * cos + z * sin
    z = -x * sin + z * cos
    x = nextX
  }
  if (rz !== 0) {
    const cos = Math.cos(rz)
    const sin = Math.sin(rz)
    const nextX = x * cos - y * sin
    y = x * sin + y * cos
    x = nextX
  }

  return [x + pivot[0], y + pivot[1], z + pivot[2]]
}

function rotateDirection(direction: Vec3, rotation: Vec3): Vec3 {
  return rotateAround(direction, [0, 0, 0], rotation)
}

/** Resolves a face rectangle, honouring negative sizes as a mirror. */
function faceRect(face: BedrockFaceUv): {
  left: number
  right: number
  top: number
  bottom: number
  rotation: number
} {
  const [u, v] = face.uv
  const [width, height] = face.uv_size ?? [0, 0]
  return {
    left: width < 0 ? u + width : u,
    right: width < 0 ? u : u + width,
    top: height < 0 ? v + height : v,
    bottom: height < 0 ? v : v + height,
    rotation: face.uv_rotation ?? 0,
  }
}

function rotateUvCorners(
  corners: Array<[number, number]>,
  rotation: number,
): Array<[number, number]> {
  const steps = ((Math.round(rotation / 90) % 4) + 4) % 4
  const result = corners.slice()
  for (let step = 0; step < steps; step += 1) result.unshift(result.pop() as [number, number])
  return result
}

function perFaceUv(cube: BedrockCube): Partial<Record<FaceName, BedrockFaceUv>> {
  if (!cube.uv) return {}
  if (Array.isArray(cube.uv)) {
    // Box UV is resolved by the importer; a bundle never mixes both shapes.
    return {}
  }
  return cube.uv
}

/**
 * Builds one BufferGeometry-worth of data for a single bone. Coordinates stay
 * in model pixels and are not re-based, so a caller mounts the mesh by
 * translating with the bone pivot it attached to.
 */
export function buildBoneMesh(cubeList: BedrockCube[]): CosmeticMeshData {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let faceCount = 0

  for (const cube of cubeList) {
    const origin = cube.origin ?? [0, 0, 0]
    const size = cube.size ?? [0, 0, 0]
    const inflate = cube.inflate ?? 0
    const rotation = cube.rotation ?? [0, 0, 0]
    const pivot = cube.pivot ?? [0, 0, 0]
    const hasRotation = rotation[0] !== 0 || rotation[1] !== 0 || rotation[2] !== 0

    const raw = cubeCorners(origin, size, inflate)
    const corners = hasRotation ? raw.map((point) => rotateAround(point, pivot, rotation)) : raw
    const faces = perFaceUv(cube)

    for (const faceName of FACE_ORDER) {
      const face = faces[faceName]
      if (!face) continue
      const rect = faceRect(face)
      const order = FACE_CORNERS[faceName]
      const normalRaw = FACE_NORMALS[faceName]
      const normal = hasRotation ? rotateDirection(normalRaw, rotation) : normalRaw

      const uvCorners = rotateUvCorners(
        [
          [rect.left, rect.top],
          [rect.right, rect.top],
          [rect.right, rect.bottom],
          [rect.left, rect.bottom],
        ],
        rect.rotation,
      )

      const base = positions.length / 3
      for (let index = 0; index < 4; index += 1) {
        const corner = corners[order[index]]
        positions.push(corner[0], corner[1], corner[2])
        normals.push(normal[0], normal[1], normal[2])
        const [u, v] = uvCorners[index]
        uvs.push(u, v)
      }
      // Faces are authored clockwise as seen from outside; WebGL culls those,
      // so the triangles are emitted counter-clockwise to face the camera.
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
      faceCount += 1
    }
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint16Array.from(indices),
    faceCount,
  }
}

/**
 * Pixel UVs to the 0..1 range three (and WebGL) sample with.
 *
 * The mesh data stays in atlas pixels so tests and the Java renderer share one
 * convention; renderers convert at their boundary through this function.
 */
export function normalizedUvs(uvs: Float32Array, width: number, height: number): Float32Array {
  if (!(width > 0) || !(height > 0)) return uvs
  const normalized = new Float32Array(uvs.length)
  for (let index = 0; index < uvs.length; index += 2) {
    normalized[index] = uvs[index] / width
    normalized[index + 1] = uvs[index + 1] / height
  }
  return normalized
}

export function boneMesh(
  source: BedrockGeometry | BedrockDocument,
  boneName?: string,
): CosmeticMeshData | null {
  const bones = unwrapGeometry(source).bones ?? []
  const bone = boneName ? bones.find((candidate) => candidate.name === boneName) : bones[0]
  if (!bone || !bone.cubes || bone.cubes.length === 0) return null
  return buildBoneMesh(bone.cubes)
}

/** The bundle stores the whole Bedrock document, so every consumer unwraps here. */
function unwrapGeometry(source: BedrockGeometry | BedrockDocument): BedrockGeometry {
  const document = source as BedrockDocument
  const wrapped = document['minecraft:geometry']
  if (Array.isArray(wrapped) && wrapped.length > 0) return wrapped[0]
  return source as BedrockGeometry
}

/**
 * The Minecraft box layout: one rectangle on the texture for all six faces.
 * `down` is mirrored vertically, exactly like the vanilla models.
 */
export function boxUvFaces(
  width: number,
  height: number,
  depth: number,
  u: number,
  v: number,
): Record<FaceName, BedrockFaceUv> {
  return {
    up: { uv: [u + depth, v], uv_size: [width, depth] },
    down: { uv: [u + depth + width, v], uv_size: [width, -depth] },
    // The net wraps around the box: the panel left of the front is the
    // character's right side, which sits at +X when the front is -Z.
    east: { uv: [u, v + depth], uv_size: [depth, height] },
    north: { uv: [u + depth, v + depth], uv_size: [width, height] },
    west: { uv: [u + depth + width, v + depth], uv_size: [depth, height] },
    south: { uv: [u + depth + width + depth, v + depth], uv_size: [width, height] },
  }
}

/** Min/max of the mesh in model pixels, for framing and regression tests. */
export function meshBounds(mesh: CosmeticMeshData): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  return { min, max }
}
