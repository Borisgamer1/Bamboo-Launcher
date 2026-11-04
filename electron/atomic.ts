/** Every write goes through `<file>.tmp-<pid>` + fsync + transactional rename; a corrupt file is quarantined instead of deleted. */
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describeError, getDefaultLogger, type Logger } from './logger'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return
    throw error
  })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    // Probing existence is expected to fail for absent paths.
    getDefaultLogger().child('atomic').debug('path probe treated as absent', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

export async function readJsonFile<T>(file: string, logger?: Logger): Promise<T | undefined> {
  const text = await readTextFile(file)
  if (text === undefined) return undefined
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as T
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`
    await copyFile(file, quarantine).catch((copyError) => {
      getDefaultLogger().child('atomic').debug('corrupt JSON could not be quarantined', {
        file,
        quarantine,
        error: describeError(copyError),
      })
    })
    logger?.warn('Corrupt JSON quarantined; falling back to defaults', {
      file,
      quarantine,
      error: (error as Error).message,
    })
    return undefined
  }
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** On Windows the current file is moved to `<file>.bak` first and the backup is restored if the final rename fails, so previous content is never lost. */
export async function writeTextFileAtomic(file: string, content: string, logger?: Logger): Promise<void> {
  await ensureDir(dirname(file))
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const backup = `${file}.bak`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  const hadPrevious = await pathExists(file)
  if (hadPrevious) {
    await rm(backup, { force: true })
    await rename(file, backup).catch(async (error) => {
      logger?.warn('Could not move previous file aside; retrying with copy', {
        file,
        error: (error as Error).message,
      })
      await copyFile(file, backup)
      await rm(file, { force: true })
    })
  }

  try {
    await rename(temp, file)
    if (hadPrevious) {
      await chmod(file, 0o600).catch((error) => {
        getDefaultLogger().child('atomic').debug('file permissions could not be tightened', {
          file,
          error: describeError(error),
        })
      })
    }
  } catch (error) {
    await rm(temp, { force: true }).catch((cleanupError) => {
      getDefaultLogger().child('atomic').debug('temporary file could not be removed after failed write', {
        temp,
        error: describeError(cleanupError),
      })
    })
    if (hadPrevious) {
      await rename(backup, file).catch((restoreError) => {
        getDefaultLogger().child('atomic').warn('previous file could not be restored after failed write', {
          file,
          backup,
          error: describeError(restoreError),
        })
      })
    }
    throw error
  }
}

export async function writeJsonFile(file: string, value: unknown, logger?: Logger): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  await writeTextFileAtomic(file, content, logger)
  await fsyncFile(file).catch((error) => {
    // The bytes are written; only crash-durability is reduced.
    getDefaultLogger().child('atomic').debug('file could not be synced to disk', {
      file,
      error: describeError(error),
    })
  })
}
