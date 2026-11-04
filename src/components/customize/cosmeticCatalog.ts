import { createCapeGeometry } from '../../../electron/cosmetics/cape'
import type { BedrockDocument } from '../../../electron/cosmetics/geometry'

/**
 * The cosmetic bundle the tab renders.
 *
 * Everything here is produced by scripts/import-cosmetics.cjs: one atlas and
 * one Bedrock geometry per cosmetic, already placed in the player's coordinate
 * space. Vite inlines the geometry and hashes the atlas, so the tab works in
 * the dev server and in a packaged build without filesystem access.
 */
export type CosmeticSlot = 'hat' | 'back' | 'cape'

/**
 * Placement on top of the geometry, in Blockbench pixels and degrees.
 *
 * `position` is in the player's feet space (x right, y up, z back), the same
 * space the imported geometry uses. `rotation` turns the mesh around the mount
 * bone, `scale` scales it around that bone. The dev editor writes these values
 * into cosmetic.json and the Java renderer reads the same object.
 */
export interface CosmeticTransform {
  bone: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface CosmeticEntry {
  id: string
  name: string
  slot: CosmeticSlot
  bone: string
  transform: CosmeticTransform
  /** Modelled geometry, or the generated vanilla cape shape for texture-only capes. */
  geometry: BedrockDocument
  atlasUrl: string
  atlasWidth: number
  atlasHeight: number
  cubes: number
}

interface CosmeticMeta {
  id: string
  name: string
  slot: CosmeticSlot
  bone: string
  offset: [number, number, number]
  attachment?: Partial<CosmeticTransform>
  /** Absent for texture-only capes; the catalog generates the vanilla shape. */
  geometry?: string
  texture: string
  cubes?: number
}

function triple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback
  const parsed = value.slice(0, 3).map((entry) => Number(entry))
  return parsed.every((entry) => Number.isFinite(entry)) ? (parsed as [number, number, number]) : fallback
}

function readTransform(meta: CosmeticMeta): CosmeticTransform {
  const attachment = meta.attachment ?? {}
  return {
    bone: typeof attachment.bone === 'string' && attachment.bone ? attachment.bone : meta.bone,
    position: triple(attachment.position, [0, 0, 0]),
    rotation: triple(attachment.rotation, [0, 0, 0]),
    scale: triple(attachment.scale, [1, 1, 1]),
  }
}

const metaModules = import.meta.glob('../../../resources/cosmetics/*/cosmetic.json', {
  eager: true,
  import: 'default',
}) as Record<string, CosmeticMeta>

const geometryModules = import.meta.glob('../../../resources/cosmetics/*/*.geo.json', {
  eager: true,
  import: 'default',
}) as Record<string, BedrockDocument>

const atlasModules = import.meta.glob('../../../resources/cosmetics/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function slugOf(path: string): string | null {
  const match = /\/cosmetics\/([^/]+)\//.exec(path)
  return match ? match[1] : null
}

function findModule<T>(modules: Record<string, T>, slug: string, file: string): T | null {
  for (const [path, value] of Object.entries(modules)) {
    if (path.endsWith(`/${slug}/${file}`)) return value
  }
  return null
}

function loadCatalog(): CosmeticEntry[] {
  const entries: CosmeticEntry[] = []
  for (const [path, meta] of Object.entries(metaModules)) {
    const slug = slugOf(path)
    if (!slug) continue
    const geometry = meta.geometry
      ? findModule(geometryModules, slug, meta.geometry)
      : createCapeGeometry(meta.id)
    const atlasUrl = findModule(atlasModules, slug, meta.texture)
    if (!geometry || !atlasUrl) {
      console.warn(`[cosmetics] ${slug} is missing its geometry or atlas`)
      continue
    }
    const description = geometry['minecraft:geometry']?.[0]?.description
    entries.push({
      id: meta.id,
      name: meta.name,
      slot: meta.slot,
      bone: meta.bone,
      transform: readTransform(meta),
      geometry,
      atlasUrl,
      atlasWidth: description?.texture_width ?? 64,
      atlasHeight: description?.texture_height ?? 64,
      cubes: meta.cubes ?? 1,
    })
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

export const COSMETIC_ENTRIES: CosmeticEntry[] = loadCatalog()

export function cosmeticsForSlot(slot: CosmeticSlot): CosmeticEntry[] {
  return COSMETIC_ENTRIES.filter((entry) => entry.slot === slot)
}

export function cosmeticById(id: string | undefined): CosmeticEntry | undefined {
  if (!id) return undefined
  return COSMETIC_ENTRIES.find((entry) => entry.id === id)
}

export interface VanillaCape {
  id: string
  name: string
  url: string
  active: boolean
}
