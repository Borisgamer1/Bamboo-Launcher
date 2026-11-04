import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Writes the preview editor's placement into the same cosmetic.json the game
 * bundle is built from.
 *
 * This is a development tool: it only touches files inside the checked-out
 * resources folder and is never enabled in a packaged build. The importer
 * preserves the attachment, so re-importing the Blockbench model does not
 * reset the calibrated values.
 */
const COSMETIC_ROOT = resolve(__dirname, '..', '..', 'resources', 'cosmetics')

export interface CosmeticTransformPayload {
  id: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

function finiteTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const parsed = value.slice(0, 3).map((entry) => Number(entry))
  if (!parsed.every((entry) => Number.isFinite(entry))) return null
  return [parsed[0], parsed[1], parsed[2]]
}

export async function saveCosmeticTransform(payload: unknown): Promise<{ path: string }> {
  const isDefaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
  if (!isDefaultApp) throw new Error('The transform editor is only available in a development build')
  if (!payload || typeof payload !== 'object') throw new Error('Invalid transform payload')
  const record = payload as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid cosmetic id')

  const position = finiteTriple(record.position)
  const rotation = finiteTriple(record.rotation)
  const scale = finiteTriple(record.scale)
  if (!position || !rotation || !scale) throw new Error('Invalid transform values')
  if (scale.some((value) => value <= 0)) throw new Error('Scale must stay positive')

  const file = resolve(COSMETIC_ROOT, id, 'cosmetic.json')
  if (!file.startsWith(`${COSMETIC_ROOT}\\`) && !file.startsWith(`${COSMETIC_ROOT}/`)) {
    throw new Error('Refusing to write outside the cosmetics folder')
  }

  const meta = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  meta.attachment = { bone: typeof meta.bone === 'string' ? meta.bone : 'bipedBody', position, rotation, scale }
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { path: join(id, 'cosmetic.json') }
}
