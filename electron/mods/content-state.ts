import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { hashBuffer } from '../download/checksum'
import type { Logger } from '../logger'
import { readModpackLock, writeModpackLock } from './lock'
import type { OfflineModIndex, RecordModOptions } from './offline-index'
import { resolveInside } from './paths'

export interface CommitInstalledFileOptions {
  instanceDir: string
  path: string
  previousPath?: string
  previousSha1?: string
  record?: RecordModOptions
  index?: OfflineModIndex
  logger?: Logger
}

export interface CommittedFile {
  sha1: string
  sha512: string
  size: number
}

export async function commitInstalledFile(options: CommitInstalledFileOptions): Promise<CommittedFile> {
  const absolute = resolveInside(options.instanceDir, options.path)
  const buffer = await readFile(absolute)
  const sha1 = hashBuffer('sha1', buffer)
  const sha512 = hashBuffer('sha512', buffer)
  const name = basename(options.path)

  if (options.index) {
    await options.index.forgetFile(name)
    if (options.previousPath && basename(options.previousPath).toLowerCase() !== name.toLowerCase()) {
      await options.index.forgetFile(basename(options.previousPath))
    }
    if (options.previousSha1) await options.index.forget(options.previousSha1)
    await options.index.record(sha1, { ...options.record, file: name })
  }

  const lock = await readModpackLock(options.instanceDir, options.logger)
  if (lock) {
    const path = options.path.replace(/\\/g, '/')
    const previous = options.previousPath?.replace(/\\/g, '/')
    const entry =
      lock.files.find((file) => file.path === path) ??
      (previous ? lock.files.find((file) => file.path === previous) : undefined)
    if (entry) {
      entry.path = path
      entry.sha1 = sha1
      entry.sha512 = sha512
      entry.size = buffer.length
      lock.updatedAt = Date.now()
      await writeModpackLock(options.instanceDir, lock, options.logger)
    }
  }

  return { sha1, sha512, size: buffer.length }
}

export interface CommitRemovedFileOptions {
  instanceDir: string
  path: string
  index?: OfflineModIndex
  logger?: Logger
}

export interface RemovedFileState {
  lockEntryRemoved: boolean
  indexEntriesRemoved: number
}

export async function commitRemovedFile(
  options: CommitRemovedFileOptions,
): Promise<RemovedFileState> {
  const path = options.path.replace(/\\/g, '/')
  resolveInside(options.instanceDir, path)
  let lockEntryRemoved = false
  const lock = await readModpackLock(options.instanceDir, options.logger)
  if (lock) {
    const index = lock.files.findIndex((file) => file.path === path)
    if (index >= 0) {
      lock.files.splice(index, 1)
      lock.updatedAt = Date.now()
      await writeModpackLock(options.instanceDir, lock, options.logger)
      lockEntryRemoved = true
    }
  }
  const indexEntriesRemoved = options.index ? await options.index.forgetFile(basename(path)) : 0
  return { lockEntryRemoved, indexEntriesRemoved }
}
