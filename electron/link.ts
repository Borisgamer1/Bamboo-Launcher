/**
 * One placement policy for the whole app: getting a file's bytes to a target path
 * as cheaply as the filesystem allows, and swapping a finished temporary file
 * into its final name.
 *
 * `linkInto` is the full strategy chain (reflink → hardlink → copy) that the mod
 * content store uses when it hands an object back to an instance. `linkOrCopy` is
 * the same chain without the reflink step, used by the instance content store,
 * whose keys are SHA-1 and which reports an already-present target instead of
 * replacing it. `replaceFile` finishes a placement on both Windows (where a plain
 * rename over an existing file fails with EPERM/EEXIST) and POSIX.
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, link, rename, rm } from 'node:fs/promises'
import { describeError, getDefaultLogger } from './logger'

export type Placement = 'reflink' | 'hardlink' | 'copy'
/** Placement without the copy-on-write clone, for callers that never want one. */
export type DirectPlacement = Exclude<Placement, 'reflink'>

async function linkOrCopyInto(source: string, temp: string): Promise<DirectPlacement> {
  try {
    await rm(temp, { force: true })
    await link(source, temp)
    return 'hardlink'
  } catch (error) {
    // Another volume, or no hardlink support at all; fall through to a copy.
    getDefaultLogger().child('link').debug('hardlink unavailable; using copy', {
      source,
      error: describeError(error),
    })
  }
  await rm(temp, { force: true })
  await copyFile(source, temp)
  return 'copy'
}

export async function linkInto(source: string, temp: string): Promise<Placement> {
  try {
    await rm(temp, { force: true })
    await copyFile(source, temp, fsConstants.COPYFILE_FICLONE_FORCE)
    return 'reflink'
  } catch (error) {
    // A copy-on-write clone only exists on CoW filesystems; use the cheaper
    // inode-sharing strategy instead.
    getDefaultLogger().child('link').debug('reflink unavailable; falling back', {
      source,
      error: describeError(error),
    })
  }
  return linkOrCopyInto(source, temp)
}

export function linkOrCopy(source: string, temp: string): Promise<DirectPlacement> {
  return linkOrCopyInto(source, temp)
}

/**
 * Copy-only placement: the same policy minus every sharing strategy, for the
 * store's rollback switch when inode sharing is what misbehaves.
 */
export async function copyInto(source: string, temp: string): Promise<'copy'> {
  await rm(temp, { force: true })
  await copyFile(source, temp)
  return 'copy'
}

export async function replaceFile(temp: string, destination: string): Promise<void> {
  try {
    await rename(temp, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await rm(destination, { force: true })
    await rename(temp, destination)
  }
}
