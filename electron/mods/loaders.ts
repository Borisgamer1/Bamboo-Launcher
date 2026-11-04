import type { ModLoader } from './types'

export const MODRINTH_LOADER_NAMES: Record<ModLoader, string | undefined> = {
  fabric: 'fabric',
  quilt: 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
  legacy: 'forge',
  unknown: undefined,
}

export const CURSEFORGE_LOADER_IDS: Record<ModLoader, number | undefined> = {
  forge: 1,
  quilt: 5,
  fabric: 4,
  neoforge: 6,
  legacy: 1,
  unknown: undefined,
}

const TOKEN_LOADERS: Array<[token: string, loader: ModLoader]> = [
  ['neoforge', 'neoforge'],
  ['quilt', 'quilt'],
  ['fabric', 'fabric'],
  ['forge', 'forge'],
]

const LOADER_TOKENS = new Set([
  ...TOKEN_LOADERS.map(([token]) => token),
  'rift',
  'liteloader',
])

export function loadersFromGameVersions(values: string[]): string[] {
  const loaders = new Set<string>()
  for (const value of values) {
    const token = value.toLowerCase()
    const match = TOKEN_LOADERS.find(([name]) => token.includes(name))
    if (match) loaders.add(match[1])
  }
  return [...loaders].sort()
}

export function minecraftVersions(values: string[]): string[] {
  return values.filter((value) => !LOADER_TOKENS.has(value.toLowerCase()))
}
