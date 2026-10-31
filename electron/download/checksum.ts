import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

export type ChecksumAlgorithm = 'sha1' | 'sha512'

export interface Checksum {
  algorithm: ChecksumAlgorithm
  value: string
}

export interface DualHash {
  sha1: string
  sha512: string
  bytes: number
}

export interface DualHasher {
  update(chunk: Buffer | Uint8Array | string): void
  digest(): DualHash
}

/** One pass over the same chunks yields both hashes and the byte count. */
export function createDualHasher(): DualHasher {
  const sha1 = createHash('sha1')
  const sha512 = createHash('sha512')
  let bytes = 0
  return {
    update(chunk) {
      sha1.update(chunk)
      sha512.update(chunk)
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    },
    digest() {
      return { sha1: sha1.digest('hex'), sha512: sha512.digest('hex'), bytes }
    },
  }
}

/** Streams a file through the dual hasher; never holds the whole file in memory. */
export async function hashFileDual(file: string): Promise<DualHash> {
  const hasher = createDualHasher()
  for await (const chunk of createReadStream(file)) hasher.update(chunk as Buffer)
  return hasher.digest()
}

export function hashBuffer(algorithm: ChecksumAlgorithm, data: Buffer | string): string {
  return createHash(algorithm).update(data).digest('hex')
}

export function sha1Hex(data: Buffer | string): string {
  return hashBuffer('sha1', data)
}

export function sha512Hex(data: Buffer | string): string {
  return hashBuffer('sha512', data)
}

export async function hashFile(algorithm: ChecksumAlgorithm, file: string): Promise<string> {
  return hashBuffer(algorithm, await readFile(file))
}

export function checksumMatches(checksum: Checksum | undefined, actualHex: string): boolean {
  if (!checksum) return true
  return checksum.value.toLowerCase() === actualHex.toLowerCase()
}
