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

export function resolveJavaMemo(
  gameRoot: string,
  memo: ResolvedJava | undefined,
): JavaMemoTarget | undefined {
  if (!memo || !memo.relativePath || isAbsolute(memo.relativePath)) return undefined
  const root = resolve(gameRoot)
  const absolute = resolve(root, memo.relativePath)
  const relativePath = relative(root, absolute)
  if (!relativePath || isAbsolute(relativePath)) return undefined
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) return undefined
  return { path: absolute, major: memo.major }
}
