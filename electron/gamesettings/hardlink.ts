import { copyFile, link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeError, getDefaultLogger } from '../logger'
import { GameSettingsError } from './errors'

async function statSafe(file: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(file)
  } catch (error) {
    // Missing link targets are expected; callers branch on the absence.
    getDefaultLogger().child('settings').debug('options.txt stat failed', { file, error: describeError(error) })
    return undefined
  }
}

export async function isHardLinked(first: string, second: string): Promise<boolean> {
  const [a, b] = await Promise.all([statSafe(first), statSafe(second)])
  if (!a || !b) return false
  return a.dev === b.dev && a.ino === b.ino && a.ino !== 0 && a.nlink >= 2 && b.nlink >= 2
}

export interface LinkFileResult {
  linked: boolean
  alreadyLinked: boolean
  backup?: string
}

export async function linkFile(
  source: string,
  target: string,
  options: { force?: boolean } = {},
): Promise<LinkFileResult> {
  const sourceStat = await statSafe(source)
  if (!sourceStat) {
    throw new GameSettingsError('options-missing', `Source file does not exist: ${source}`)
  }
  const targetStat = await statSafe(target)
  if (
    targetStat &&
    targetStat.ino !== 0 &&
    sourceStat.ino !== 0 &&
    targetStat.dev === sourceStat.dev &&
    targetStat.ino === sourceStat.ino &&
    targetStat.nlink >= 2 &&
    sourceStat.nlink >= 2
  ) {
    return { linked: true, alreadyLinked: true }
  }

  let backup: string | undefined
  if (targetStat) {
    if (!options.force) {
      throw new GameSettingsError(
        'hardlink-conflict',
        `Target exists and is not linked: ${target}. Pass force to replace it.`,
      )
    }
    backup = `${target}.pre-link-${Date.now()}`
    await rename(target, backup)
  }

  await mkdir(dirname(target), { recursive: true })
  try {
    await link(source, target)
  } catch (error) {
    if (backup) await rename(backup, target).catch(() => undefined)
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      throw new GameSettingsError(
        'hardlink-unsupported',
        `Hardlinks are not supported between ${source} and ${target}`,
        { cause: error },
      )
    }
    throw error
  }
  return { linked: true, alreadyLinked: false, ...(backup ? { backup } : {}) }
}

export async function unlinkFile(target: string): Promise<boolean> {
  const info = await statSafe(target)
  if (!info || info.nlink <= 1) return false

  const content = await readFile(target)
  const temp = `${target}.unlink-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const backup = `${target}.unlink-backup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temp, content)
  await rename(target, backup)
  try {
    await rename(temp, target)
  } catch (error) {
    await rename(backup, target).catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  await rm(backup, { force: true }).catch(() => undefined)
  return true
}

/** Linked files are truncated in place so root and instance stay one inode. */
export async function writeTextPreservingHardlink(
  file: string,
  content: string,
  atomicWrite: (file: string, content: string) => Promise<void>,
): Promise<'atomic' | 'in-place'> {
  const info = await statSafe(file)
  if (info && info.nlink > 1) {
    const handle = await open(file, 'r+')
    try {
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return 'in-place'
  }
  await atomicWrite(file, content)
  return 'atomic'
}

export async function copyFileSafe(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

export function optionsPaths(rootDir: string, instanceDir: string): { root: string; instance: string } {
  return {
    root: join(rootDir, 'options.txt'),
    instance: join(instanceDir, 'options.txt'),
  }
}
