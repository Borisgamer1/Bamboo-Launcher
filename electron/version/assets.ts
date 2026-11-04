import { join } from 'node:path'
import { readJsonFile } from '../atomic'
import type { Logger } from '../logger'

export const ASSET_OBJECT_BASE_URL = 'https://resources.download.minecraft.net'

export interface AssetIndexEntry {
  hash: string
  size: number
}

export interface AssetIndexJson {
  objects?: Record<string, AssetIndexEntry>
  virtual?: boolean
  map_to_resources?: boolean
}

export interface ResolvedAssetObject {
  name: string
  hash: string
  size: number
  path: string
  absolutePath: string
  url: string
  virtualPath?: string
}

export interface ResolvedAssets {
  id: string
  available: boolean
  legacyVirtual: boolean
  objectsFile: string
  virtualDir?: string
  count: number
  totalSize: number
  objects: ResolvedAssetObject[]
}

export interface AssetIndexInfo {
  id: string
  totalSize?: number
  sha1?: string
  size?: number
  url?: string
}

export async function resolveAssets(options: {
  gameRoot: string
  indexId: string
  assetsField?: string
  indexInfo?: AssetIndexInfo
  logger?: Logger
}): Promise<ResolvedAssets> {
  const objectsFile = join(options.gameRoot, 'assets', 'indexes', `${options.indexId}.json`)
  const index = await readJsonFile<AssetIndexJson>(objectsFile, options.logger)
  const legacyVirtual =
    options.assetsField === 'legacy' ||
    Boolean(options.assetsField?.startsWith('pre-')) ||
    index?.virtual === true ||
    index?.map_to_resources === true

  if (!index || !index.objects) {
    return {
      id: options.indexId,
      available: false,
      legacyVirtual,
      objectsFile,
      count: 0,
      totalSize: options.indexInfo?.totalSize ?? 0,
      objects: [],
    }
  }

  const objects: ResolvedAssetObject[] = []
  let totalSize = 0
  for (const [name, entry] of Object.entries(index.objects)) {
    if (!entry || typeof entry.hash !== 'string' || typeof entry.size !== 'number') continue
    const path = `objects/${entry.hash.slice(0, 2)}/${entry.hash}`
    const object: ResolvedAssetObject = {
      name,
      hash: entry.hash,
      size: entry.size,
      path,
      absolutePath: join(options.gameRoot, 'assets', path),
      url: `${ASSET_OBJECT_BASE_URL}/${entry.hash.slice(0, 2)}/${entry.hash}`,
    }
    if (legacyVirtual) object.virtualPath = `virtual/${options.indexId}/${name}`
    objects.push(object)
    totalSize += entry.size
  }
  objects.sort((a, b) => a.name.localeCompare(b.name))

  const result: ResolvedAssets = {
    id: options.indexId,
    available: true,
    legacyVirtual,
    objectsFile,
    count: objects.length,
    totalSize,
    objects,
  }
  if (legacyVirtual) result.virtualDir = join(options.gameRoot, 'assets', 'virtual', options.indexId)
  return result
}
