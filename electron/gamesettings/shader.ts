import { join } from 'node:path'
import { readTextFile } from '../atomic'
import { GameSettingsError } from './errors'
import { writeGameFile } from './fileio'
import { mergeProperties, parseProperties, type PropertyDocument } from './properties'

export const SHADER_KEYS = ['shaderPack', 'enableShaders'] as const
export type ShaderKey = (typeof SHADER_KEYS)[number]

export interface ShaderOptions {
  source: 'optionsshaders' | 'iris' | 'oculus'
  file: string
  document: PropertyDocument
  shaderPack?: string
  enableShaders?: boolean
}

export interface ShaderWriteResult {
  changed: boolean
  file: string
  diff: Record<string, string>
  source: ShaderOptions['source']
}

const MODERN_FILES: Array<{ name: 'iris' | 'oculus'; file: string }> = [
  { name: 'iris', file: join('config', 'iris.properties') },
  { name: 'oculus', file: join('config', 'oculus.properties') },
  { name: 'iris', file: 'iris.properties' },
  { name: 'oculus', file: 'oculus.properties' },
]

async function readFirst(instanceDir: string): Promise<{ source: ShaderOptions['source']; file: string } | undefined> {
  for (const candidate of MODERN_FILES) {
    const file = join(instanceDir, candidate.file)
    if ((await readTextFile(file)) !== undefined) return { source: candidate.name, file }
  }
  const legacy = join(instanceDir, 'optionsshaders.txt')
  if ((await readTextFile(legacy)) !== undefined) return { source: 'optionsshaders', file: legacy }
  return undefined
}

export async function readShaderOptions(instanceDir: string): Promise<ShaderOptions | undefined> {
  const found = await readFirst(instanceDir)
  if (!found) return undefined
  const text = (await readTextFile(found.file)) ?? ''
  const separator = found.source === 'optionsshaders' ? ':' : '='
  const document = parseProperties(text, separator)
  const rawPack = document.values.shaderPack
  const rawEnabled = document.values.enableShaders
  return {
    source: found.source,
    file: found.file,
    document,
    ...(rawPack !== undefined ? { shaderPack: rawPack } : {}),
    ...(rawEnabled !== undefined ? { enableShaders: /^true$/i.test(rawEnabled) } : {}),
  }
}

export async function writeShaderOptions(
  instanceDir: string,
  patch: Partial<Record<ShaderKey, string | boolean>>,
): Promise<ShaderWriteResult> {
  const found = await readFirst(instanceDir)
  const source: ShaderOptions['source'] = found?.source ?? 'optionsshaders'
  const file = found?.file ?? join(instanceDir, 'optionsshaders.txt')
  const separator = source === 'optionsshaders' ? ':' : '='
  const original = found ? ((await readTextFile(file)) ?? '') : ''
  const stringPatch: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!SHADER_KEYS.includes(key as ShaderKey)) {
      throw new GameSettingsError('invalid-key', `Unsupported shader option: ${key}`)
    }
    if (value === undefined) continue
    stringPatch[key] = typeof value === 'boolean' ? String(value) : value
  }
  const merged = mergeProperties(original, stringPatch, separator)
  let text = merged.text
  if (!found && text.length > 0 && !text.endsWith('\n')) text += '\n'
  if (merged.changed || (!found && text.length > 0)) await writeGameFile(file, text)
  return { changed: merged.changed, file, diff: merged.diff, source }
}

export function shaderState(options: ShaderOptions | undefined): {
  shaderPack: string
  enableShaders: boolean
} {
  if (!options) return { shaderPack: 'OFF', enableShaders: false }
  const shaderPack = options.shaderPack ?? 'OFF'
  return {
    shaderPack,
    enableShaders: options.enableShaders ?? (shaderPack !== 'OFF' && shaderPack.length > 0),
  }
}
