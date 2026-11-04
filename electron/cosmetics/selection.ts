import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The launcher-owned cosmetic selection.
 *
 * It is written by the Anpassen tab and read by the launch path. Keeping it in
 * the main process instead of localStorage is what lets the game bundle carry
 * the same equipped set the preview shows.
 */
export interface CosmeticSelection {
  hat?: string
  back?: string
  cape?: string
  vanillaCapeId?: string
  vanillaCapeName?: string
  vanillaCapeUrl?: string
}

export interface CosmeticSelectionFile {
  version: 1
  selection: CosmeticSelection
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_URL = 2048

function slug(value: unknown): string | undefined {
  return typeof value === 'string' && SLUG.test(value.trim()) ? value.trim() : undefined
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function parseSelection(value: unknown): CosmeticSelection {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const selection: CosmeticSelection = {}
  const hat = slug(record.hat)
  const back = slug(record.back)
  const cape = slug(record.cape)
  const vanillaCapeId = slug(record.vanillaCapeId)
  const vanillaCapeName = label(record.vanillaCapeName)
  const vanillaCapeUrl = httpsUrl(record.vanillaCapeUrl)
  if (hat) selection.hat = hat
  if (back) selection.back = back
  if (cape) selection.cape = cape
  if (vanillaCapeId) selection.vanillaCapeId = vanillaCapeId
  if (vanillaCapeId && vanillaCapeName) selection.vanillaCapeName = vanillaCapeName
  if (vanillaCapeId && vanillaCapeUrl) selection.vanillaCapeUrl = vanillaCapeUrl
  return selection
}

export function selectionFile(appData: string): string {
  return join(appData, 'cosmetics-selection.json')
}

export async function readSelection(appData: string): Promise<CosmeticSelection> {
  try {
    const raw = JSON.parse(await readFile(selectionFile(appData), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && 'selection' in raw) {
      return parseSelection((raw as { selection: unknown }).selection)
    }
    return parseSelection(raw)
  } catch {
    return {}
  }
}

export async function writeSelection(appData: string, value: unknown): Promise<CosmeticSelection> {
  const selection = parseSelection(value)
  const file = selectionFile(appData)
  await mkdir(dirname(file), { recursive: true })
  const payload: CosmeticSelectionFile = { version: 1, selection }
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return selection
}
