import * as THREE from 'three'
import {
  boneMesh,
  buildBoneMesh,
  boxUvFaces,
  normalizedUvs,
  type CosmeticMeshData,
} from '../../../electron/cosmetics/geometry'
import { createCapeGeometry } from '../../../electron/cosmetics/cape'

/**
 * The vanilla biped in model pixels, feet at y = 0, head top at y = 32.
 *
 * Skin boxes use Minecraft's box layout on a 64×64 sheet, so the same, tested
 * mesh builder that renders cosmetics also renders the player. The two layer
 * meshes are separate draws: the base layer is opaque cutout, the overlay is
 * translucent.
 */
const SKIN_TEXTURE = 64

export interface PlayerModel {
  /** Feet-space group; callers scale it to blocks. */
  readonly root: THREE.Group
  /** Local origin at the head pivot (0, 24, 0); cosmetic meshes mount here. */
  readonly head: THREE.Group
  /** Local origin at the body pivot (0, 24, 0). */
  readonly body: THREE.Group
  /** Cape plane, already hanging from the shoulders. */
  readonly cape: THREE.Group
  setSkin(texture: THREE.Texture | null): void
  setCape(texture: THREE.Texture | null): void
  dispose(): void
}

interface BoxSpec {
  origin: [number, number, number]
  size: [number, number, number]
  /** Uninflated dimensions the texture layout was drawn for. */
  layout: [number, number, number]
  uv: [number, number]
  textureSize: number
}

interface PartSpec {
  name: 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg'
  pivot: [number, number, number]
  base: BoxSpec
  overlay: BoxSpec
}

function partSpecs(slim: boolean): PartSpec[] {
  const armWidth = slim ? 3 : 4
  const sleeveWidth = slim ? 3.5 : 4
  return [
    {
      name: 'head',
      pivot: [0, 24, 0],
      base: { origin: [-4, 0, -4], size: [8, 8, 8], layout: [8, 8, 8], uv: [0, 0], textureSize: SKIN_TEXTURE },
      overlay: {
        origin: [-4.5, -0.5, -4.5],
        size: [9, 9, 9],
        layout: [8, 8, 8],
        uv: [32, 0],
        textureSize: SKIN_TEXTURE,
      },
    },
    {
      name: 'body',
      pivot: [0, 24, 0],
      base: { origin: [-4, -12, -2], size: [8, 12, 4], layout: [8, 12, 4], uv: [16, 16], textureSize: SKIN_TEXTURE },
      overlay: {
        origin: [-4.25, -12.25, -2.25],
        size: [8.5, 12.5, 4.5],
        layout: [8, 12, 4],
        uv: [16, 32],
        textureSize: SKIN_TEXTURE,
      },
    },
    {
      name: 'rightArm',
      pivot: [-5, 24, 0],
      base: {
        origin: [-(armWidth - 1), -12, -2],
        size: [armWidth, 12, 4],
        layout: [armWidth, 12, 4],
        uv: [40, 16],
        textureSize: SKIN_TEXTURE,
      },
      overlay: {
        origin: [-(armWidth - 1) - 0.25, -12.25, -2.25],
        size: [sleeveWidth, 12.5, 4.5],
        layout: [armWidth, 12, 4],
        uv: [40, 32],
        textureSize: SKIN_TEXTURE,
      },
    },
    {
      name: 'leftArm',
      pivot: [5, 24, 0],
      base: {
        origin: [-1, -12, -2],
        size: [armWidth, 12, 4],
        layout: [armWidth, 12, 4],
        uv: [32, 48],
        textureSize: SKIN_TEXTURE,
      },
      overlay: {
        origin: [-1.25, -12.25, -2.25],
        size: [sleeveWidth, 12.5, 4.5],
        layout: [armWidth, 12, 4],
        uv: [48, 48],
        textureSize: SKIN_TEXTURE,
      },
    },
    {
      name: 'rightLeg',
      pivot: [-2, 12, 0],
      base: { origin: [-2, -12, -2], size: [4, 12, 4], layout: [4, 12, 4], uv: [0, 16], textureSize: SKIN_TEXTURE },
      overlay: {
        origin: [-2.25, -12.25, -2.25],
        size: [4.5, 12.5, 4.5],
        layout: [4, 12, 4],
        uv: [0, 32],
        textureSize: SKIN_TEXTURE,
      },
    },
    {
      name: 'leftLeg',
      pivot: [2, 12, 0],
      base: { origin: [-2, -12, -2], size: [4, 12, 4], layout: [4, 12, 4], uv: [16, 48], textureSize: SKIN_TEXTURE },
      overlay: {
        origin: [-2.25, -12.25, -2.25],
        size: [4.5, 12.5, 4.5],
        layout: [4, 12, 4],
        uv: [0, 48],
        textureSize: SKIN_TEXTURE,
      },
    },
  ]
}

/**
 * A bundle mesh as a three geometry. UVs are normalised against the sheet the
 * geometry declares, which is not square for a cape (64x32).
 */
export function meshGeometry(
  mesh: CosmeticMeshData,
  textureWidth: number,
  textureHeight: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(normalizedUvs(mesh.uvs, textureWidth, textureHeight), 2))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  return geometry
}

/** A three.js geometry from one box of the skin sheet. */
export function skinBoxGeometry(spec: BoxSpec): THREE.BufferGeometry {
  const [width, height, depth] = spec.layout
  const mesh: CosmeticMeshData = buildBoneMesh([
    {
      origin: spec.origin,
      size: spec.size,
      uv: boxUvFaces(width, height, depth, spec.uv[0], spec.uv[1]),
    },
  ])
  return meshGeometry(mesh, spec.textureSize, spec.textureSize)
}

export function createPlayerModel(variant: 'classic' | 'slim'): PlayerModel {
  const root = new THREE.Group()
  root.name = 'player'

  // DoubleSide: a mirrored box net culls some underside faces otherwise, which
  // left the bottom of the hand and parts of the arm overlay invisible.
  const skinMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  })
  const overlayMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.92,
    metalness: 0,
    alphaTest: 0.1,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const capeMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0,
    alphaTest: 0.5,
    transparent: true,
    side: THREE.DoubleSide,
  })

  const parts = new Map<string, THREE.Group>()
  const geometries: THREE.BufferGeometry[] = []

  for (const spec of partSpecs(variant === 'slim')) {
    const group = new THREE.Group()
    group.name = spec.name
    group.position.set(spec.pivot[0], spec.pivot[1], spec.pivot[2])

    const baseGeometry = skinBoxGeometry(spec.base)
    const overlayGeometry = skinBoxGeometry(spec.overlay)
    geometries.push(baseGeometry, overlayGeometry)

    const base = new THREE.Mesh(baseGeometry, skinMaterial)
    base.name = `${spec.name}:base`
    const overlay = new THREE.Mesh(overlayGeometry, overlayMaterial)
    overlay.name = `${spec.name}:overlay`
    group.add(base, overlay)
    root.add(group)
    parts.set(spec.name, group)
  }

  // Cape: the same document the bundle carries for texture-only capes, so the
  // preview samples the 64x32 cape sheet exactly like the game does. A cape UV
  // is not a skin box net normalised by 64x64; treating it that way sampled
  // only the top half of each panel.
  const capeDocument = createCapeGeometry('player')
  const capeSheet = boneMesh(capeDocument, 'bipedBody')
  if (!capeSheet) throw new Error('Cape geometry is empty')
  const capeEntry = capeDocument['minecraft:geometry']?.[0]
  if (!capeEntry) throw new Error('Cape geometry is empty')
  const capePivot: [number, number, number] = capeEntry.bones?.[0]?.pivot ?? [0, 24, 0]
  const cape = new THREE.Group()
  cape.name = 'cape'
  // Hinge at the shoulders like vanilla, so the plane hangs from y=24 down to
  // y=8 instead of floating above the head. The mesh is authored in feet
  // space, so it has to be rebased on the body pivot before it is mounted.
  cape.rotation.x = -0.12
  const capeGeometry = meshGeometry(
    capeSheet,
    capeEntry.description?.texture_width ?? 64,
    capeEntry.description?.texture_height ?? 32,
  )
  geometries.push(capeGeometry)
  const capeMesh = new THREE.Mesh(capeGeometry, capeMaterial)
  capeMesh.name = 'cape:sheet'
  capeMesh.position.set(-capePivot[0], -capePivot[1], -capePivot[2])
  capeMesh.visible = false
  cape.add(capeMesh)
  const body = parts.get('body') as THREE.Group
  body.add(cape)

  return {
    root,
    head: parts.get('head') as THREE.Group,
    body,
    cape,
    setSkin(texture) {
      skinMaterial.map = texture
      overlayMaterial.map = texture
      skinMaterial.needsUpdate = true
      overlayMaterial.needsUpdate = true
    },
    setCape(texture) {
      capeMaterial.map = texture
      capeMaterial.needsUpdate = true
      capeMesh.visible = Boolean(texture)
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose()
      skinMaterial.dispose()
      overlayMaterial.dispose()
      capeMaterial.dispose()
    },
  }
}

/** Nearest-neighbour, top-left UVs, no mipmaps: the skin sheet contract. */
export function configureSkinTexture(texture: THREE.Texture): THREE.Texture {
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

export function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => resolve(configureSkinTexture(texture)),
      undefined,
      () => reject(new Error(`Texture konnte nicht geladen werden: ${url}`)),
    )
  })
}
