import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  installedCosmetic,
  parseCosmiq,
  readCosmiqFile,
  type CosmeticPreview,
  type InstalledCosmetic,
} from './cosmiq'

/**
 * The launcher-side view of `<instance>/bamboo/cosmetics`.
 *
 * The game owns the folder: it lists and equips what is in there. The launcher
 * only installs packages into it, shows them and deletes them, so both sides
 * always see the same files without a second manifest to keep in sync.
 */

export function cosmeticsDirectory(instanceDirectory: string): string {
  return join(instanceDirectory, 'bamboo', 'cosmetics')
}

function safeFile(file: string): string {
  const name = basename(String(file ?? ''))
  if (name !== file || !name.toLowerCase().endsWith('.cosmiq')) {
    throw new Error('Ungültiger Cosmetic-Dateiname')
  }
  return name
}

export async function listInstalled(instanceDirectory: string): Promise<InstalledCosmetic[]> {
  const directory = cosmeticsDirectory(instanceDirectory)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const installed: InstalledCosmetic[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.cosmiq')) continue
    const file = join(directory, entry.name)
    try {
      const info = await stat(file)
      if (info.size > 16 * 1024 * 1024) continue
      installed.push(installedCosmetic(entry.name, await readFile(file)))
    } catch {
      // A file that vanished between readdir and read is simply not listed.
    }
  }
  return installed.sort((left, right) => left.name.localeCompare(right.name))
}

export async function previewInstalled(
  instanceDirectory: string,
  file: string,
): Promise<CosmeticPreview> {
  return readCosmiqFile(join(cosmeticsDirectory(instanceDirectory), safeFile(file)))
}

export async function removeInstalled(
  instanceDirectory: string,
  file: string,
): Promise<InstalledCosmetic[]> {
  const target = join(cosmeticsDirectory(instanceDirectory), safeFile(file))
  await unlink(target)
  return listInstalled(instanceDirectory)
}

function fileNameFor(name: string, existing: Set<string>): string {
  const base =
    name
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Cosmetic'
  let candidate = `${base}.cosmiq`
  let suffix = 2
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix}).cosmiq`
    suffix += 1
  }
  return candidate
}

/** Writes a validated package into the instance folder; returns the new list. */
export async function installPackage(
  instanceDirectory: string,
  bytes: Buffer,
  displayName: string,
): Promise<InstalledCosmetic[]> {
  const preview = parseCosmiq(bytes, displayName)
  const directory = cosmeticsDirectory(instanceDirectory)
  await mkdir(directory, { recursive: true })
  const existing = new Set(
    (await readdir(directory)).filter((entry) => entry.toLowerCase().endsWith('.cosmiq')).map((entry) => entry.toLowerCase()),
  )
  const file = fileNameFor(preview.name, existing)
  await writeFile(join(directory, file), bytes, { flag: 'wx' })
  return listInstalled(instanceDirectory)
}
