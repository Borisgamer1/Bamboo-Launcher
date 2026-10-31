import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import type { Logger } from '../logger'
import type { ModpackLock, ModpackLockFile } from './types'

export const MODPACK_LOCK_FILE = 'modpack.lock.json'

export interface ModpackUpstream {
  provider: 'modrinth' | 'curseforge' | 'local' | string
  format: 'mrpack' | 'curseforge' | string
  name?: string
  versionId?: string
  projectId?: string
  file?: string
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeFile(raw: unknown): ModpackLockFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const path = stringValue(value.path)
  if (!path) return undefined
  return {
    path,
    ...(stringValue(value.sha1) ? { sha1: stringValue(value.sha1) } : {}),
    ...(stringValue(value.sha512) ? { sha512: stringValue(value.sha512) } : {}),
    ...(typeof value.size === 'number' ? { size: value.size } : {}),
    ...(typeof value.projectId === 'number' || typeof value.projectId === 'string'
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.fileId === 'number' ? { fileId: value.fileId } : {}),
    ...(stringValue(value.source) ? { source: stringValue(value.source) } : {}),
  }
}

export async function readModpackLock(
  instanceDir: string,
  logger?: Logger,
): Promise<ModpackLock | undefined> {
  const raw = await readJsonFile<Record<string, unknown>>(
    join(instanceDir, MODPACK_LOCK_FILE),
    logger,
  )
  if (!raw || raw.version !== 1) return undefined
  const format = raw.format === 'curseforge' ? 'curseforge' : raw.format === 'mrpack' ? 'mrpack' : undefined
  if (!format || typeof raw.name !== 'string') return undefined
  const files = Array.isArray(raw.files)
    ? raw.files.map(normalizeFile).filter((file): file is ModpackLockFile => Boolean(file))
    : []
  const upstreamRaw = raw.upstream && typeof raw.upstream === 'object'
    ? (raw.upstream as Record<string, unknown>)
    : {}
  return {
    version: 1,
    format,
    name: raw.name,
    versionId: stringValue(raw.versionId) ?? '',
    upstream: {
      provider: stringValue(upstreamRaw.provider) ?? 'local',
      format: stringValue(upstreamRaw.format) ?? format,
      ...(stringValue(upstreamRaw.name) ? { name: stringValue(upstreamRaw.name) } : {}),
      ...(stringValue(upstreamRaw.versionId) ? { versionId: stringValue(upstreamRaw.versionId) } : {}),
      ...(stringValue(upstreamRaw.projectId) ? { projectId: stringValue(upstreamRaw.projectId) } : {}),
      ...(stringValue(upstreamRaw.file) ? { file: stringValue(upstreamRaw.file) } : {}),
    },
    dependencies:
      raw.dependencies && typeof raw.dependencies === 'object'
        ? Object.fromEntries(
            Object.entries(raw.dependencies as Record<string, unknown>)
              .filter(([, value]) => typeof value === 'string')
              .map(([key, value]) => [key, String(value)]),
          )
        : {},
    files,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

export async function writeModpackLock(
  instanceDir: string,
  lock: ModpackLock,
  logger?: Logger,
): Promise<void> {
  await writeJsonFile(join(instanceDir, MODPACK_LOCK_FILE), lock, logger)
}
