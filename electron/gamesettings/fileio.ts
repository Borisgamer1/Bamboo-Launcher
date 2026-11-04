/** Uses a private backup during rename and truncates linked files in place, so a rename cannot break a shared inode. */
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describeError, getDefaultLogger } from '../logger'
import { writeTextPreservingHardlink } from './hardlink'

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    // A first write has no previous file; that is the expected path.
    getDefaultLogger().child('settings').debug('options.txt backup probe failed', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function writeGameFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const temp = `${file}.tmp-${suffix}`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  const hadPrevious = await exists(file)
  const backup = `${file}.bak-${suffix}`
  if (hadPrevious) await rename(file, backup)
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    if (hadPrevious) await rename(backup, file).catch(() => undefined)
    throw error
  }
  if (hadPrevious) await rm(backup, { force: true }).catch(() => undefined)
}

export async function writeGameFile(
  file: string,
  content: string,
): Promise<'atomic' | 'in-place'> {
  return writeTextPreservingHardlink(file, content, writeGameFileAtomic)
}
