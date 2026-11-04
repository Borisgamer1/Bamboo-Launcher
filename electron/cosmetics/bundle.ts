import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCapeGeometry } from './cape'
import type { CosmeticSelection } from './selection'

/**
 * Builds the runtime bundle both renderers consume.
 *
 * `resources/cosmetics` is the authored source of truth: one folder per
 * cosmetic with a cosmetic.json, geometry and atlas. This module copies that
 * folder into the instance's `cosmetics` directory and writes the manifest the
 * Fabric mod reads before launch. It also turns the selected Mojang cape into a
 * local texture, so the mod never needs a network request while rendering.
 */
export interface CosmeticMeta {
  id: string
  name: string
  slot: 'hat' | 'back' | 'cape'
  bone: string
  attachment?: {
    bone?: string
    position?: number[]
    rotation?: number[]
    scale?: number[]
  }
  geometry?: string
  texture: string
}

export interface BundleResult {
  cosmeticCount: number
  customCapeCount: number
  capeApplied: string | null
  warnings: string[]
}

const MAX_CAPE_BYTES = 512 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function finiteTriple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback
  const parsed = value.slice(0, 3).map((entry) => Number(entry))
  return parsed.every((entry) => Number.isFinite(entry)) ? (parsed as [number, number, number]) : fallback
}

function attachmentOf(meta: CosmeticMeta) {
  const source = meta.attachment ?? {}
  return {
    bone: typeof source.bone === 'string' && source.bone ? source.bone : meta.bone,
    position: finiteTriple(source.position, [0, 0, 0]),
    rotation: finiteTriple(source.rotation, [0, 0, 0]),
    scale: finiteTriple(source.scale, [1, 1, 1]),
  }
}

async function readCatalog(resourcesRoot: string): Promise<Array<{ meta: CosmeticMeta; folder: string }>> {
  const entries = await readdir(resourcesRoot, { withFileTypes: true })
  const catalog: Array<{ meta: CosmeticMeta; folder: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const meta = JSON.parse(
        await readFile(join(resourcesRoot, entry.name, 'cosmetic.json'), 'utf8'),
      ) as CosmeticMeta
      if (!meta.id || !meta.texture) continue
      catalog.push({ meta, folder: entry.name })
    } catch {
      // A folder without cosmetic.json is not part of the catalog.
    }
  }
  return catalog
}

async function downloadCape(url: string, destination: string): Promise<boolean> {
  if (typeof globalThis.fetch !== 'function') return false
  try {
    const response = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    })
    if (!response.ok) return false
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_CAPE_BYTES) return false
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_CAPE_BYTES) return false
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false
    await writeFile(destination, bytes)
    return true
  } catch {
    return false
  }
}

export async function syncCosmeticsBundle(options: {
  instanceDir: string
  resourcesRoot: string
  selection: CosmeticSelection
}): Promise<BundleResult> {
  const { instanceDir, resourcesRoot, selection } = options
  const warnings: string[] = []
  const catalog = await readCatalog(resourcesRoot)
  if (catalog.length === 0) {
    return { cosmeticCount: 0, customCapeCount: 0, capeApplied: null, warnings: ['no cosmetics in resources'] }
  }

  const bundleDir = join(instanceDir, 'cosmetics')
  const filesDir = join(bundleDir, 'files')
  await rm(bundleDir, { recursive: true, force: true })
  await mkdir(filesDir, { recursive: true })

  const byId = new Map(catalog.map(({ meta }) => [meta.id, meta]))
  const activeSelections: Array<{ slug: string; category: string }> = []
  const customCapeCount = catalog.filter(({ meta }) => meta.slot === 'cape').length
  const cosmetics: Array<Record<string, unknown>> = []

  for (const { meta, folder } of catalog) {
    const geometryName = `${meta.id}.geo.json`
    const textureName = `${meta.id}.png`
    const sourceDir = join(resourcesRoot, folder)
    try {
      await copyFile(join(sourceDir, meta.texture), join(filesDir, textureName))
      if (meta.geometry) {
        await copyFile(join(sourceDir, meta.geometry), join(filesDir, geometryName))
      } else {
        // Texture-only capes get the vanilla cape shape here, so the mod can
        // mount them like any other body cosmetic instead of forcing a custom
        // texture into the vanilla cape's fixed 64x32 UV layout.
        await writeFile(
          join(filesDir, geometryName),
          `${JSON.stringify(createCapeGeometry(meta.id), null, 2)}\n`,
          'utf8',
        )
      }
    } catch {
      warnings.push(`${meta.id}: geometry or texture is missing`)
      continue
    }

    const entry: Record<string, unknown> = {
      slug: meta.id,
      category: meta.slot,
      displayName: meta.name,
      texture: `files/${textureName}`,
      attachment: attachmentOf(meta),
      geometry: `files/${geometryName}`,
    }
    cosmetics.push(entry)
  }

  const selected = (id: string | undefined, slot: 'hat' | 'back' | 'cape') => {
    const meta = id ? byId.get(id) : undefined
    if (!meta || meta.slot !== slot) return null
    return meta
  }

  for (const [slot, id] of [
    ['hat', selection.hat],
    ['back', selection.back],
    ['cape', selection.cape],
  ] as const) {
    if (selected(id, slot)) activeSelections.push({ slug: id as string, category: slot })
  }

  let capeApplied: string | null = null
  const selectedCape = selected(selection.cape, 'cape')
  // Don't auto-apply vanilla capes from profile - only apply if explicitly selected and no custom cape
  if (!selectedCape && selection.vanillaCapeId && selection.vanillaCapeUrl) {
    // Only apply if the user has explicitly selected it (cape not in activeSelections from custom capes)
    const file = join(filesDir, 'cape.png')
    if (await downloadCape(selection.vanillaCapeUrl, file)) {
      capeApplied = selection.vanillaCapeName ?? selection.vanillaCapeId
      // The cape object is separate from the cosmetic selection: it tells the
      // mod which texture replaces the vanilla cape for the local player.
      cosmetics.push({
        slug: `vanilla-${selection.vanillaCapeId}`,
        category: 'cape',
        displayName: capeApplied,
        texture: 'files/cape.png',
        attachment: { bone: 'bipedBody', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      })
    } else {
      warnings.push('the selected Mojang cape could not be downloaded')
    }
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    cosmetics,
    // Texture-only capes are folded into `cosmetics` with a generated mesh.
    // The array stays for older manifests; new bundles do not need it.
    customCapes: [],
    activeSelections,
    ...(capeApplied
      ? { cape: { id: selection.vanillaCapeId, name: capeApplied, file: 'files/cape.png' } }
      : {}),
  }
  await writeFile(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return {
    cosmeticCount: catalog.length,
    customCapeCount,
    capeApplied,
    warnings,
  }
}
