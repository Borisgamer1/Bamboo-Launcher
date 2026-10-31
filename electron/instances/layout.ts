import { isAbsolute, join, relative, resolve } from 'node:path'

export const INSTANCES_DIR = 'instances'
export const INSTANCE_FILE = 'instance.json'
export const INSTANCE_LOCK_FILE = 'instance-lock.json'
export const TRASH_DIR = '.trash'

export const INSTANCE_SUBDIRS = [
  'mods',
  'config',
  'saves',
  'resourcepacks',
  'shaderpacks',
  'screenshots',
  'logs',
  'crash-reports',
] as const

export const LINKED_DIRS = ['mods', 'resourcepacks', 'shaderpacks'] as const

export const COPIED_DIRS = ['saves', 'config'] as const
export const COPIED_FILES = ['options.txt', 'servers.dat'] as const

export function instancesRoot(gameRoot: string): string {
  return join(gameRoot, INSTANCES_DIR)
}

export function trashRoot(gameRoot: string): string {
  return join(instancesRoot(gameRoot), TRASH_DIR)
}

export interface InstancePathRecord {
  managed?: boolean
  path?: string
  folderName?: string
}

export function resolveInstancePath(gameRoot: string, record: InstancePathRecord): string {
  const stored = String(record.path ?? '')
  if (record.managed || stored === '' || !isAbsolute(stored)) {
    const relativePath = stored !== '' ? stored : join(INSTANCES_DIR, String(record.folderName ?? ''))
    return resolve(gameRoot, relativePath)
  }
  return resolve(stored)
}

export function rewriteInstancePath(
  storedPath: string,
  oldRoot: string,
  newRoot: string,
): string | undefined {
  const stored = String(storedPath ?? '')
  if (!stored || !isAbsolute(stored)) return undefined
  const oldResolved = resolve(oldRoot)
  const nextResolved = resolve(newRoot)
  const rel = relative(oldResolved, resolve(stored))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return join(nextResolved, rel)
}
