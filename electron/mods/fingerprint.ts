/**
 * CurseForge file fingerprints — detection of unknown JARs only, and opt-in.
 *
 * The algorithm is MurmurHash2 (32-bit) over the file's raw bytes with the four
 * ASCII whitespace bytes (tab, LF, CR, space) removed anywhere in the stream; the
 * seed is `1 ^ <filtered length>`. The zip structure is *not* interpreted, so a
 * repacked archive with identical entries fingerprints differently.
 *
 * Two properties matter for how this may be used:
 *  - 32 bits collide, and the whitespace rule makes different byte streams equal,
 *    so a match is a *candidate* that must be confirmed by name/size/metadata;
 *  - it is not an integrity check. Downloads are verified with SHA-1/SHA-512.
 */
import { readFile } from 'node:fs/promises'

const MURMUR_MULTIPLIER = 0x5bd1_e995

function isStrippedByte(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32
}

export function curseForgeFingerprint(bytes: Uint8Array): number {
  let filtered = 0
  for (const byte of bytes) {
    if (!isStrippedByte(byte)) filtered += 1
  }

  let hash = (1 ^ filtered) >>> 0
  let word = 0
  let shift = 0
  for (const byte of bytes) {
    if (isStrippedByte(byte)) continue
    word = (word | (byte << shift)) >>> 0
    shift += 8
    if (shift === 32) {
      let mixed = Math.imul(word, MURMUR_MULTIPLIER)
      mixed = Math.imul(mixed ^ (mixed >>> 24), MURMUR_MULTIPLIER)
      hash = (Math.imul(hash, MURMUR_MULTIPLIER) ^ mixed) >>> 0
      word = 0
      shift = 0
    }
  }
  if (shift > 0) hash = Math.imul(hash ^ word, MURMUR_MULTIPLIER) >>> 0

  hash ^= hash >>> 13
  hash = Math.imul(hash, MURMUR_MULTIPLIER) >>> 0
  hash ^= hash >>> 15
  return hash >>> 0
}

export async function fingerprintFile(file: string): Promise<number> {
  return curseForgeFingerprint(await readFile(file))
}
