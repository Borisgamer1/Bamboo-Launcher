import { basename, isAbsolute, relative, resolve } from 'node:path'
import { ModError } from './errors'

/** The longest name any of the filesystems this app runs on accepts. */
export const MAX_FILENAME_BYTES = 255

/** A NUL truncates inside a syscall on POSIX, so no control character belongs in a path. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function resolveFileInside(root: string, folder: string, filename: string): string {
  if (filename === '' || filename === '.' || filename === '..' || /[\\/]/.test(filename) || basename(filename) !== filename) {
    throw new ModError('unsafe-path', `Invalid content filename: ${filename}`, { filename })
  }
  if (hasControlCharacters(filename) || Buffer.byteLength(filename) > MAX_FILENAME_BYTES) {
    throw new ModError('unsafe-path', `Unusable content filename: ${filename}`, { filename })
  }
  return resolveInside(root, folder, filename)
}

export function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root)
  if (segments.some((segment) => hasControlCharacters(segment))) {
    throw new ModError('unsafe-path', `Unusable path segment: ${segments.join('/')}`, {
      path: segments.join('/'),
    })
  }
  const target = resolve(base, ...segments)
  const rel = relative(base, target)
  const shown = segments.join('/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ModError('unsafe-path', `Path escapes the instance: ${shown}`, { path: shown })
  }
  return target
}
