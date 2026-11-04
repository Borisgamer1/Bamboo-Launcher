import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { DownloadError } from './http'
import { resolveInside } from './paths'
import { describeError, getDefaultLogger } from '../logger'
import type { InstallMaterializeTask, MaterializeOperation } from './types'

export class MaterializeError extends Error {
  readonly rollbackErrors: unknown[]

  constructor(message: string, options: { cause?: unknown; rollbackErrors?: unknown[] } = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'MaterializeError'
    this.rollbackErrors = options.rollbackErrors ?? []
  }
}

interface JournalEntry {
  undo: () => Promise<void>
}

export interface MaterializeOptions {
  signal?: AbortSignal
}

function tempSuffix(): string {
  return `${process.pid}-${randomBytes(6).toString('hex')}`
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch (error) {
    getDefaultLogger().child('download:materialize').debug('directory probe failed; treating as file', {
      target,
      error: describeError(error),
    })
    return false
  }
}

async function moveToBackup(target: string, backupDir: string): Promise<string | undefined> {
  if (!(await pathExists(target))) return undefined
  await mkdir(backupDir, { recursive: true })
  const backup = path.join(backupDir, `${randomBytes(8).toString('hex')}.bak`)
  await rename(target, backup)
  return backup
}

async function restoreBackup(target: string, backup: string | undefined): Promise<void> {
  await rm(target, { recursive: true, force: true })
  if (backup) await rename(backup, target)
}

async function cleanupBackups(backupDir: string): Promise<void> {
  await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
  await rmdir(path.dirname(backupDir)).catch(() => undefined)
}

async function ensureParent(
  target: string,
  journal: JournalEntry[],
): Promise<void> {
  const parent = path.dirname(target)
  const missing: string[] = []
  let cursor = parent
  while (!(await pathExists(cursor))) {
    missing.push(cursor)
    const next = path.dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  await mkdir(parent, { recursive: true })
  if (missing.length > 0) {
    journal.push({
      undo: async () => {
        for (const dir of missing) {
          await rmdir(dir).catch(() => undefined)
        }
      },
    })
  }
}

async function writeAtomically(
  target: string,
  content: string | Buffer,
  journal: JournalEntry[],
  backupDir: string,
  options: { mode?: number; from?: string } = {},
): Promise<void> {
  await ensureParent(target, journal)
  const backup = await moveToBackup(target, backupDir)
  journal.push({ undo: () => restoreBackup(target, backup) })
  const temp = `${target}.bamboo-${tempSuffix()}.tmp`
  try {
    if (options.from) {
      await copyFile(options.from, temp)
    } else {
      await writeFile(temp, content, options.mode !== undefined ? { mode: options.mode } : undefined)
    }
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function readZipEntry(archive: string, entryName: string): Buffer {
  let zip: AdmZip
  try {
    zip = new AdmZip(archive)
  } catch (error) {
    throw new DownloadError('invalid', `Archive is not readable: ${archive}`, { cause: error })
  }
  const exact = zip.getEntry(entryName)
  const entry =
    exact ??
    zip.getEntries().find((candidate) => candidate.entryName === entryName || candidate.entryName.endsWith(`/${entryName}`))
  if (!entry || entry.isDirectory) {
    throw new DownloadError('invalid', `Archive entry not found: ${entryName}`)
  }
  return entry.getData()
}

function mergeZipArchives(archives: string[], excludePrefixes: string[]): Buffer {
  const merged = new AdmZip()
  const seen = new Set<string>()
  for (const archive of archives) {
    let zip: AdmZip
    try {
      zip = new AdmZip(archive)
    } catch (error) {
      throw new DownloadError('invalid', `Archive is not readable: ${archive}`, { cause: error })
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const name = entry.entryName.replace(/\\/g, '/')
      if (excludePrefixes.some((prefix) => name.startsWith(prefix))) continue
      if (seen.has(name)) continue
      seen.add(name)
      merged.addFile(name, entry.getData())
    }
  }
  return merged.toBuffer()
}

async function applyOperation(
  root: string,
  operation: MaterializeOperation,
  journal: JournalEntry[],
  backupDir: string,
): Promise<void> {
  switch (operation.type) {
    case 'ensure-directory': {
      const target = resolveInside(root, operation.path)
      if (await pathExists(target)) {
        if (!(await isDirectory(target))) {
          throw new DownloadError('invalid', `Cannot create directory over file: ${operation.path}`)
        }
        return
      }
      const missing: string[] = []
      let cursor = target
      while (!(await pathExists(cursor))) {
        missing.push(cursor)
        const next = path.dirname(cursor)
        if (next === cursor) break
        cursor = next
      }
      await mkdir(target, { recursive: true })
      journal.push({
        undo: async () => {
          for (const dir of missing) {
            await rmdir(dir).catch(() => undefined)
          }
        },
      })
      return
    }
    case 'write': {
      const target = resolveInside(root, operation.path)
      await writeAtomically(target, operation.content, journal, backupDir, { mode: operation.mode })
      return
    }
    case 'copy': {
      const source = resolveInside(root, operation.from)
      const target = resolveInside(root, operation.path)
      await writeAtomically(target, '', journal, backupDir, { from: source })
      return
    }
    case 'link': {
      const source = resolveInside(root, operation.from)
      const target = resolveInside(root, operation.path)
      await ensureParent(target, journal)
      const backup = await moveToBackup(target, backupDir)
      journal.push({ undo: () => restoreBackup(target, backup) })
      try {
        await link(source, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES') {
          getDefaultLogger().child('download:materialize').debug('hardlink unavailable; copying instead', {
            source,
            target,
            code,
          })
          await copyFile(source, target)
        } else {
          throw error
        }
      }
      return
    }
    case 'remove': {
      const target = resolveInside(root, operation.path)
      if (!(await pathExists(target))) return
      const backup = await moveToBackup(target, backupDir)
      journal.push({ undo: () => restoreBackup(target, backup) })
      return
    }
    case 'extract': {
      const archive = resolveInside(root, operation.archive)
      const target = resolveInside(root, operation.path)
      await writeAtomically(target, readZipEntry(archive, operation.entry), journal, backupDir)
      return
    }
    case 'merge-zip': {
      const archives = operation.archives.map((archive) => resolveInside(root, archive))
      const target = resolveInside(root, operation.path)
      const buffer = mergeZipArchives(archives, operation.excludePrefixes ?? [])
      await writeAtomically(target, buffer, journal, backupDir)
      return
    }
    default: {
      const exhaustive: never = operation
      throw new DownloadError('invalid', `Unsupported materialize operation: ${JSON.stringify(exhaustive)}`)
    }
  }
}

export async function applyMaterializeTask(
  task: InstallMaterializeTask,
  options: MaterializeOptions = {},
): Promise<void> {
  const backupDir = path.join(task.root, '.bamboo-tmp', `materialize-${tempSuffix()}`)
  const journal: JournalEntry[] = []
  try {
    for (const operation of task.operations) {
      if (options.signal?.aborted) {
        throw new DownloadError('aborted', 'Materialize aborted')
      }
      await applyOperation(task.root, operation, journal, backupDir)
    }
    await cleanupBackups(backupDir)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const entry of [...journal].reverse()) {
      try {
        await entry.undo()
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
        getDefaultLogger().child('download:materialize').warn('rollback step failed', {
          error: describeError(rollbackError),
        })
      }
    }
    await cleanupBackups(backupDir)
    throw new MaterializeError(`Materialize task ${task.id} failed`, {
      cause: error,
      rollbackErrors,
    })
  }
}
