import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  installedCosmetic,
  parseCosmiq,
  readCosmiqFile,
  type CosmeticPreview,
  type InstalledCosmetic,
} from './cosmiq'

/**
 * The cosmetics library.
 *
 * Cosmetics belong to the account, not to a single instance: the player
 * installs a package once and it has to be available in every world. The game
 * only reads `<instance>/bamboo/cosmetics`, so the library in the launcher data
 * folder is the source of truth and every instance folder is a mirror of it.
 *
 * Files that only exist in an instance folder are adopted into the library
 * instead of being deleted: a package exported from the Cosmiq editor by hand
 * must never disappear because the launcher did not know it.
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

async function packageNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.cosmiq'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Copies one package into every instance the game may start. */
async function mirror(
  libraryDirectory: string,
  instanceDirectories: string[],
  file: string,
): Promise<void> {
  for (const instance of instanceDirectories) {
    const directory = cosmeticsDirectory(instance)
    try {
      await mkdir(directory, { recursive: true })
      await copyFile(join(libraryDirectory, file), join(directory, file))
    } catch {
      // A locked or removed instance folder must not fail the install.
    }
  }
}

/**
 * Adopts unknown instance packages and fills missing ones, so an instance that
 * was created after the last install still sees the whole library.
 */
export async function reconcile(
  libraryDirectory: string,
  instanceDirectories: string[],
): Promise<void> {
  await mkdir(libraryDirectory, { recursive: true })
  const known = new Set((await packageNames(libraryDirectory)).map((name) => name.toLowerCase()))
  for (const instance of instanceDirectories) {
    const directory = cosmeticsDirectory(instance)
    for (const name of await packageNames(directory)) {
      if (known.has(name.toLowerCase())) continue
      try {
        await copyFile(join(directory, name), join(libraryDirectory, name))
        known.add(name.toLowerCase())
      } catch {
        // Unreadable package: leave it where it is.
      }
    }
  }
  for (const name of await packageNames(libraryDirectory)) {
    for (const instance of instanceDirectories) {
      const directory = cosmeticsDirectory(instance)
      const target = join(directory, name)
      try {
        if (await exists(target)) continue
        await mkdir(directory, { recursive: true })
        await copyFile(join(libraryDirectory, name), target)
      } catch {
        // Locked or removed instance folder.
      }
    }
  }
}

export async function listInstalled(
  libraryDirectory: string,
  instanceDirectories: string[],
): Promise<InstalledCosmetic[]> {
  await reconcile(libraryDirectory, instanceDirectories)
  const installed: InstalledCosmetic[] = []
  for (const name of await packageNames(libraryDirectory)) {
    const file = join(libraryDirectory, name)
    try {
      const info = await stat(file)
      if (info.size > 16 * 1024 * 1024) continue
      installed.push(installedCosmetic(name, await readFile(file)))
    } catch {
      // A file that vanished between readdir and read is simply not listed.
    }
  }
  return installed.sort((left, right) => left.name.localeCompare(right.name))
}

export async function previewInstalled(
  libraryDirectory: string,
  file: string,
): Promise<CosmeticPreview> {
  return readCosmiqFile(join(libraryDirectory, safeFile(file)))
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

/** Writes a validated package into the library and every instance folder. */
export async function installPackage(
  libraryDirectory: string,
  instanceDirectories: string[],
  bytes: Buffer,
  displayName: string,
): Promise<InstalledCosmetic[]> {
  const preview = parseCosmiq(bytes, displayName)
  await mkdir(libraryDirectory, { recursive: true })
  const existing = new Set((await packageNames(libraryDirectory)).map((name) => name.toLowerCase()))
  const file = fileNameFor(preview.name, existing)
  await writeFile(join(libraryDirectory, file), bytes, { flag: 'wx' })
  await mirror(libraryDirectory, instanceDirectories, file)
  return listInstalled(libraryDirectory, instanceDirectories)
}

export async function removeInstalled(
  libraryDirectory: string,
  instanceDirectories: string[],
  file: string,
): Promise<InstalledCosmetic[]> {
  const name = safeFile(file)
  const target = join(libraryDirectory, name)
  let bytes: Buffer | null = null
  try {
    bytes = await readFile(target)
    await unlink(target)
  } catch {
    // Already gone: still clean the mirrors below.
  }
  for (const instance of instanceDirectories) {
    const copy = join(cosmeticsDirectory(instance), name)
    try {
      if (!bytes || !(await readFile(copy)).equals(bytes)) continue
      await unlink(copy)
    } catch {
      // A modified copy in an instance folder is left alone on purpose.
    }
  }
  return listInstalled(libraryDirectory, instanceDirectories)
}
