import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { CosmeticSlot } from './cosmiq'

/**
 * The cosmetics shop.
 *
 * The catalog is a single JSON file next to the packages. The launcher tries
 * the public GitHub copy first and falls back to the one shipped with the app,
 * so the shop works offline and a new item only needs a push to the repo.
 *
 * catalog.json:
 *   { "version": 1, "items": [
 *     { "id": "bird-cape", "name": "Bird Cape", "creator": "Bamboo",
 *       "description": "Cape with Green Bird", "rarity": "Legendary",
 *       "slots": ["back", "cape"], "file": "./bird-cape.cosmiq" }
 *   ] }
 *
 * `file` is relative to the catalog (or an absolute https URL).
 */

const REMOTE_CATALOG_URL =
  'https://raw.githubusercontent.com/Borisgamer1/Bamboo-Cosmetics/main/catalog.json'
const LOCAL_SHOP_DIRECTORY = resolve(__dirname, '..', '..', 'resources', 'cosmetics-shop')
const MAXIMUM_CATALOG_BYTES = 512 * 1024
const MAXIMUM_PACKAGE_BYTES = 16 * 1024 * 1024
const MAXIMUM_IMAGE_BYTES = 2 * 1024 * 1024
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']
const SLOTS: CosmeticSlot[] = ['head', 'back', 'cape']

let cached: { catalog: ShopCatalog; at: number } | null = null

export interface ShopItem {
  id: string
  name: string
  creator: string
  description: string
  rarity: string
  slots: CosmeticSlot[]
  /** Resolved download target: https URL or absolute local path. */
  file: string
  /** Thumbnail: data URL for the bundled copy, https URL for GitHub. */
  image: string | null
  remote: boolean
}

export interface ShopCatalog {
  items: ShopItem[]
  source: 'remote' | 'local'
  error?: string
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

function slotsOf(value: unknown): CosmeticSlot[] {
  if (!Array.isArray(value)) return ['back']
  const slots = value.filter((entry): entry is CosmeticSlot =>
    SLOTS.includes(entry as CosmeticSlot),
  )
  return slots.length > 0 ? [...new Set(slots)] : ['back']
}

function itemsOf(payload: unknown, source: 'remote' | 'local', base: string): ShopItem[] {
  if (!payload || typeof payload !== 'object') throw new Error('Shop-Katalog ist ungültig')
  const raw = (payload as { items?: unknown }).items
  if (!Array.isArray(raw)) throw new Error('Shop-Katalog enthält keine Liste')

  const items: ShopItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = text(record.id, 64)
    const file = text(record.file, 512)
    if (!id || !file) continue
    let target: string
    try {
      target = source === 'remote' ? new URL(file, base).toString() : resolveLocal(base, file)
    } catch {
      continue
    }
    const rarity = RARITIES.find(
      (candidate) => candidate.toLowerCase() === text(record.rarity, 24).toLowerCase(),
    )
    items.push({
      id,
      name: text(record.name, 96) || id,
      creator: text(record.creator, 96) || 'Unbekannt',
      description: text(record.description, 512),
      rarity: rarity ?? 'Common',
      slots: slotsOf(record.slots),
      file: target,
      image: imageOf(record.image, source, base),
      remote: source === 'remote',
    })
  }
  return items.sort((left, right) => left.name.localeCompare(right.name))
}

/** Thumbnail path/URL, or null when the entry has none. */
function imageOf(value: unknown, source: 'remote' | 'local', base: string): string | null {
  const raw = text(value, 512)
  if (!raw) return null
  try {
    return source === 'remote' ? new URL(raw, base).toString() : resolveLocal(base, raw)
  } catch {
    return null
  }
}

function resolveLocal(directory: string, file: string): string {
  const target = resolve(directory, file)
  if (target !== directory && !target.startsWith(`${directory}${sep}`)) {
    throw new Error('Shop-Datei liegt außerhalb des Ordners')
  }
  return target
}

async function readRemoteCatalog(): Promise<ShopItem[]> {
  const response = await fetch(REMOTE_CATALOG_URL, {
    signal: AbortSignal.timeout(8000),
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Shop nicht erreichbar (${response.status})`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAXIMUM_CATALOG_BYTES) throw new Error('Shop-Katalog ist zu groß')
  const payload: unknown = await response.json()
  return itemsOf(payload, 'remote', REMOTE_CATALOG_URL)
}

async function readLocalCatalog(): Promise<ShopItem[]> {
  const file = resolve(LOCAL_SHOP_DIRECTORY, 'catalog.json')
  const payload: unknown = JSON.parse(await readFile(file, 'utf8'))
  const items = itemsOf(payload, 'local', LOCAL_SHOP_DIRECTORY)
  // The renderer cannot read files, so bundled thumbnails travel as data URLs.
  return Promise.all(
    items.map(async (item) =>
      item.image ? { ...item, image: await localImage(item.image) } : item,
    ),
  )
}

async function localImage(file: string): Promise<string | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAXIMUM_IMAGE_BYTES) return null
    const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
    const type = extension === 'jpg' ? 'jpeg' : extension
    return `data:image/${type};base64,${(await readFile(file)).toString('base64')}`
  } catch {
    return null
  }
}

export async function loadShop(): Promise<ShopCatalog> {
  if (cached && Date.now() - cached.at < 60_000) return cached.catalog
  let catalog: ShopCatalog
  try {
    catalog = { items: await readRemoteCatalog(), source: 'remote' }
  } catch (remoteError) {
    try {
      catalog = { items: await readLocalCatalog(), source: 'local' }
    } catch {
      catalog = {
        items: [],
        source: 'local',
        error:
          remoteError instanceof Error
            ? `Shop nicht erreichbar: ${remoteError.message}`
            : 'Shop nicht erreichbar',
      }
    }
  }
  // An empty result is retried on the next call; a failed GitHub request must
  // not hide a catalog that becomes reachable a minute later.
  if (catalog.items.length > 0) cached = { catalog, at: Date.now() }
  return catalog
}

export async function shopPackageById(id: string): Promise<{ item: ShopItem; bytes: Buffer }> {
  const catalog = await loadShop()
  const item = catalog.items.find((entry) => entry.id === id)
  if (!item) throw new Error('Cosmetic ist nicht im Shop')
  return { item, bytes: await loadShopPackage(item) }
}

export async function loadShopPackage(item: ShopItem): Promise<Buffer> {
  if (item.remote) {
    const response = await fetch(item.file, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`Download fehlgeschlagen (${response.status})`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAXIMUM_PACKAGE_BYTES) throw new Error('Paket ist zu groß')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAXIMUM_PACKAGE_BYTES) throw new Error('Paket ist zu groß')
    return bytes
  }
  return readFile(assertLocalPackage(item.file))
}

function assertLocalPackage(file: string): string {
  if (!file.startsWith(`${LOCAL_SHOP_DIRECTORY}${sep}`)) {
    throw new Error('Shop-Datei liegt außerhalb des Ordners')
  }
  return file
}
