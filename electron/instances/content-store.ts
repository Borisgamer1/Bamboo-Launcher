import { randomBytes } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashFile } from '../download/checksum'
import { linkOrCopy, replaceFile } from '../link'
import type { Logger } from '../logger'

export type LinkResult = 'hardlink' | 'copy' | 'exists'

function tempName(target: string): string {
  return `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
}

async function isFile(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isFile() === true
}

/**
 * Sha-1 keyed content store of the game root: it puts a file into
 * `<gameRoot>/content/objects` and links stored objects into an instance. The
 * placement (hardlink, or a copy where the filesystem refuses one) comes from the
 * shared policy in `electron/link.ts`, so this store and the mod content store
 * cannot drift apart.
 */
export class ContentStore {
  readonly root: string
  readonly #logger?: Logger

  constructor(gameRoot: string, logger?: Logger) {
    this.root = join(gameRoot, 'content', 'objects')
    this.#logger = logger
  }

  objectPath(sha1: string): string {
    return join(this.root, sha1.slice(0, 2), sha1)
  }

  async put(file: string): Promise<string> {
    const sha1 = await hashFile('sha1', file)
    const target = this.objectPath(sha1)
    if (await isFile(target)) return sha1
    await mkdir(dirname(target), { recursive: true })
    const temp = tempName(target)
    try {
      await linkOrCopy(file, temp)
      await replaceFile(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      // Another writer may have stored the same content in the meantime.
      if (await isFile(target)) return sha1
      throw error
    }
    return sha1
  }

  async link(sha1: string, target: string): Promise<LinkResult> {
    const source = this.objectPath(sha1)
    if (await isFile(target)) return 'exists'
    await mkdir(dirname(target), { recursive: true })
    const temp = tempName(target)
    try {
      const mode = await linkOrCopy(source, temp)
      if (mode === 'copy') {
        this.#logger?.warn('Hardlink from content store failed; copied the object instead', {
          source,
          target,
        })
      }
      await replaceFile(temp, target)
      return mode
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async putAndLink(file: string, target: string): Promise<LinkResult> {
    const sha1 = await this.put(file)
    return this.link(sha1, target)
  }
}
