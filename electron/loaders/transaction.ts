import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { describeError, getDefaultLogger } from '../logger'
import { LoaderError } from './errors'

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    getDefaultLogger().child('loaders:transaction').debug('path probe failed; treating as absent', {
      target,
      error: describeError(error),
    })
    return false
  }
}

interface JournalEntry {
  undo: () => Promise<void>
}

export class LoaderTransaction {
  readonly stagingDir: string
  readonly #backupDir: string
  readonly #journal: JournalEntry[] = []
  #counter = 0
  #finished = false

  constructor(gameRoot: string, label: string) {
    this.stagingDir = path.join(gameRoot, '.bamboo-tmp', `loaders-${label}-${randomBytes(6).toString('hex')}`)
    this.#backupDir = path.join(this.stagingDir, 'backups')
  }

  get finished(): boolean {
    return this.#finished
  }

  async ensureDir(target: string): Promise<void> {
    await mkdir(target, { recursive: true })
  }

  async ensureStaging(): Promise<void> {
    await mkdir(this.stagingDir, { recursive: true })
  }

  async protect(target: string): Promise<void> {
    if (this.#finished) throw new LoaderError('invalid', 'Loader transaction is already finished')
    if (await pathExists(target)) {
      await mkdir(this.#backupDir, { recursive: true })
      const backup = path.join(this.#backupDir, `${this.#counter += 1}.bak`)
      await rename(target, backup)
      this.#journal.push({
        undo: async () => {
          await rm(target, { force: true })
          await rename(backup, target)
        },
      })
      return
    }
    this.#journal.push({
      undo: async () => {
        await rm(target, { recursive: true, force: true })
      },
    })
  }

  async write(target: string, content: string | Buffer, mode?: number): Promise<void> {
    await this.protect(target)
    await mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.bamboo-${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, content, mode !== undefined ? { mode } : undefined)
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async writeJson(target: string, value: unknown): Promise<void> {
    await this.write(target, `${JSON.stringify(value, null, 2)}\n`)
  }

  async copy(from: string, target: string): Promise<void> {
    await this.protect(target)
    await mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.bamboo-${randomBytes(6).toString('hex')}.tmp`
    try {
      await copyFile(from, temp)
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async extract(archive: string, entryName: string, target: string): Promise<void> {
    let zip: AdmZip
    try {
      zip = new AdmZip(archive)
    } catch (error) {
      throw new LoaderError('installer', `Installer-Archiv nicht lesbar: ${archive}`, { cause: error })
    }
    const entry = zip.getEntry(entryName)
    if (!entry || entry.isDirectory) {
      throw new LoaderError('installer', `Installer-Eintrag fehlt: ${entryName}`)
    }
    await this.write(target, entry.getData())
  }

  async remove(target: string): Promise<void> {
    if (!(await pathExists(target))) return
    await this.protect(target)
    await rm(target, { recursive: true, force: true })
  }

  async rollback(): Promise<void> {
    if (this.#finished) return
    this.#finished = true
    const errors: string[] = []
    for (const entry of [...this.#journal].reverse()) {
      try {
        await entry.undo()
      } catch (error) {
        errors.push((error as Error).message)
        getDefaultLogger().child('loaders:transaction').warn('rollback step failed', {
          error: describeError(error),
        })
      }
    }
    await rm(this.stagingDir, { recursive: true, force: true }).catch(() => undefined)
    if (errors.length > 0) {
      throw new LoaderError('rollback', `Rollback unvollständig: ${errors.join('; ')}`)
    }
  }

  async commit(): Promise<void> {
    if (this.#finished) return
    this.#finished = true
    await rm(this.stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    await this.ensureStaging()
    try {
      const result = await body()
      await this.commit()
      return result
    } catch (error) {
      await this.rollback().catch((rollbackError) => {
        throw new LoaderError(
          'rollback',
          `${(error as Error).message}; Rollback-Fehler: ${(rollbackError as Error).message}`,
          { cause: error },
        )
      })
      throw error
    }
  }
}

export { pathExists as transactionPathExists }
