import { asRecord } from './shared'

const LOADER_KEYS = ['fabric-loader', 'quilt-loader', 'forge', 'neoforge', 'loader'] as const

function normalizedKey(key: string): string {
  const lower = key.toLowerCase()
  if (lower === 'fabricloader') return 'fabric-loader'
  if (lower === 'quiltloader') return 'quilt-loader'
  return lower
}

export function normalizeDependencies(source: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(asRecord(source))) {
    if (typeof value !== 'string' || value.length === 0) continue
    result[normalizedKey(key)] = value
  }
  return result
}

export function loaderInfo(dependencies: Record<string, string>): {
  loader: string
  version: string
} {
  for (const key of LOADER_KEYS) {
    const version = dependencies[key]
    if (!version) continue
    if (key === 'fabric-loader') return { loader: 'Fabric', version }
    if (key === 'quilt-loader') return { loader: 'Quilt', version }
    if (key === 'forge') return { loader: 'Forge', version }
    if (key === 'neoforge') return { loader: 'Neoforge', version }
    return { loader: 'Vanilla', version }
  }
  return { loader: 'Vanilla', version: '' }
}

export function instanceLoaderKey(modloader: unknown): string | undefined {
  if (typeof modloader !== 'string') return undefined
  const value = modloader.toLowerCase()
  if (value === 'fabric') return 'fabric-loader'
  if (value === 'quilt') return 'quilt-loader'
  if (value === 'forge') return 'forge'
  if (value === 'neoforge') return 'neoforge'
  return undefined
}
