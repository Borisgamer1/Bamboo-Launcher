import path from 'node:path'
import { DownloadError } from './http'

export function isSafeRelativePath(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false
  if (candidate.length === 0 || candidate.includes('\0')) return false
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false
  for (const segment of candidate.split(/[\\/]+/)) {
    if (segment === '..') return false
  }
  return true
}

export function resolveInside(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new DownloadError('invalid', `Unsafe path in install manifest: ${String(relative)}`)
  }
  const resolved = path.resolve(root, relative)
  const inside = path.relative(path.resolve(root), resolved)
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) return resolved
  throw new DownloadError('invalid', `Path escapes destination: ${relative}`)
}
