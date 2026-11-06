import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ResolvedJava } from '../schemas'

export interface JavaMemoTarget {
  path: string
  major: number
}

export function javaMemoRelativePath(gameRoot: string, javaPath: string): string | undefined {
  const root = resolve(gameRoot)
  const absolute = resolve(javaPath)
  const relativePath = relative(root, absolute)
  if (!relativePath || isAbsolute(relativePath)) return undefined
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return undefined
  return relativePath.split(sep).join('/')
}

// Memos are stored with forward slashes but may be read on another platform.
// A drive-letter path is absolute on Windows and relative to POSIX `resolve`.
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:|[\\/]{2})/

export function resolveJavaMemo(
  gameRoot: string,
  memo: ResolvedJava | undefined,
): JavaMemoTarget | undefined {
  if (
    !memo ||
    !memo.relativePath ||
    isAbsolute(memo.relativePath) ||
    WINDOWS_ABSOLUTE.test(memo.relativePath)
  ) {
    return undefined
  }
  const root = resolve(gameRoot)
  const absolute = resolve(root, memo.relativePath)
  const relativePath = relative(root, absolute)
  if (!relativePath || isAbsolute(relativePath)) return undefined
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return undefined
  return { path: absolute, major: memo.major }
}
