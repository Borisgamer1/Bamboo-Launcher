import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { describeError, type Logger } from '../logger'
import { resolveInside } from '../mods/paths'

/**
 * Installs Minecraft worlds the way the game reads them: a folder with
 * `level.dat` inside the instance's `saves` directory.
 *
 * Rules, stated once for every caller (download and local upload):
 *  - A world is the folder that holds `level.dat`. When an archive wraps its
 *    world(s) in a folder - the normal case - that folder name is kept, so the
 *    folder is named like the pack author named it. Several worlds in one
 *    archive are all installed.
 *  - When the world files sit at the archive root, the archive's own name (or
 *    the name the caller passes) is used.
 *  - Generic wrapper names (`world`, `saves`, ...) are replaced by the caller's
 *    name when one is known, because they carry no information. The world's real
 *    display name always comes from `level.dat` anyway.
 *  - An existing world folder is never overwritten and never skipped: the new
 *    world is installed next to it as `<name> (2)`, `<name> (3)`, ... and the
 *    result says that it was renamed, so the UI can name the folder it created.
 *  - Archives without any `level.dat` are refused with an explicit error; a
 *    world is never quietly dropped into a content folder.
 */

export const SAVES_FOLDER = 'saves'
export const WORLD_LEVEL_FILE = 'level.dat'

const STAGING_FOLDER = '.bamboo-world-staging'

/** Guards against archives that are not worlds at all (zip bombs, huge packs). */
const MAX_ENTRY_COUNT = 200_000
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024

const GENERIC_WORLD_NAMES = new Set(['world', 'worlds', 'saves', 'minecraft', 'new world'])

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export interface InstalledWorld {
  /** Folder created inside `saves`; this is what the game and the UI show. */
  folderName: string
  /** Absolute path of the installed world folder. */
  path: string
  /** World folder name as it was inside the archive ('' = archive root). */
  sourceName: string
  /** Files written for this world. */
  files: number
  /** True when an existing world forced a `(2)`-style name. */
  renamed: boolean
}

export interface WorldInstallResult {
  worlds: InstalledWorld[]
}

export interface WorldInstallProgress {
  done: number
  total: number
  file?: string
}

export interface InstallWorldOptions {
  instanceDir: string
  archivePath: string
  /** Name used when the archive itself carries no useful folder name. */
  preferredName?: string
  logger?: Logger
  /** Reported per extracted file so large worlds keep a visible progress bar. */
  onProgress?: (progress: WorldInstallProgress) => void
}

/** A folder name the filesystems accept and the game can read. */
export function sanitizeWorldFolderName(raw: string): string {
  let name = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (name === '' || name === '.' || name === '..') name = 'World'
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `${name}_`
  const clamped = name.slice(0, 64).trim().replace(/[. ]+$/, '')
  return clamped === '' ? 'World' : clamped
}

/**
 * Normalized archive path of an entry, or null for entries that must not be
 * extracted (absolute paths, traversal, macOS resource forks, dotfiles).
 */
export function archiveEntryPath(entryName: string): string | null {
  const normalized = String(entryName ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (/^[a-zA-Z]:/.test(normalized)) return null
  const segments = normalized
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => segment.replace(/[. ]+$/, ''))
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  if (segments[0].startsWith('.') || segments[0] === '__MACOSX') return null
  return segments.join('/')
}

/**
 * World roots inside an archive. Only the shallowest roots are returned, so a
 * world that sits inside another folder cannot be installed twice; the archive
 * root (`''`) counts when the world files are at the top level.
 */
export function scanArchiveWorlds(
  entries: { entryName: string; isDirectory?: boolean }[],
): { root: string; files: number }[] {
  const depths = new Map<string, number>()
  let counted = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const path = archiveEntryPath(entry.entryName)
    if (!path) continue
    counted += 1
    const segments = path.split('/')
    if (segments[segments.length - 1].toLowerCase() !== WORLD_LEVEL_FILE) continue
    const root = segments.slice(0, -1).join('/')
    depths.set(root, segments.length - 1)
  }
  if (depths.size === 0) return []
  const shallowest = Math.min(...depths.values())
  const roots = [...depths.entries()]
    .filter(([, depth]) => depth === shallowest)
    .map(([root]) => root)
  return roots.map((root) => ({
    root,
    files:
      root === ''
        ? counted
        : entries.filter((entry) => {
            if (entry.isDirectory) return false
            const path = archiveEntryPath(entry.entryName)
            return path !== null && path.startsWith(`${root}/`)
          }).length,
  }))
}

/**
 * The folder name a new world gets in `saves`: the preferred name, `(2)`, `(3)`
 * ... until it is free. `taken` carries the names reserved earlier in the same
 * install (archives can hold several worlds).
 */
export function availableWorldFolderName(
  savesDir: string,
  preferred: string,
  taken: Set<string> = new Set(),
): { folderName: string; renamed: boolean } {
  const base = sanitizeWorldFolderName(preferred)
  let candidate = base
  let counter = 2
  while (taken.has(candidate.toLowerCase()) || existsSync(join(savesDir, candidate))) {
    candidate = `${base} (${counter})`
    counter += 1
  }
  return { folderName: candidate, renamed: candidate !== base }
}

function nameWithoutArchiveExtension(file: string): string {
  const extension = extname(file)
  return extension === '' ? file : basename(file, extension)
}

function preferredFolderNameFor(
  root: string,
  options: { preferredName?: string; archivePath: string },
): string {
  const internal = root === '' ? '' : root.split('/').pop() || ''
  const generic = internal === '' || GENERIC_WORLD_NAMES.has(internal.toLowerCase())
  const fallback = options.preferredName?.trim() || nameWithoutArchiveExtension(options.archivePath)
  if (generic && fallback !== '') return fallback
  return internal
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
  // A cross-device move (or a filesystem that refuses a directory rename) is
  // still an install: copy the staged world and drop the staging folder.
  await cp(source, destination, { recursive: true })
  await rm(source, { recursive: true, force: true })
}

export async function installWorldArchive(options: InstallWorldOptions): Promise<WorldInstallResult> {
  const logger = options.logger?.child('worlds:install')
  let zip: AdmZip
  try {
    zip = new AdmZip(options.archivePath)
  } catch (error) {
    logger?.warn('world archive unreadable', {
      archive: options.archivePath,
      error: describeError(error),
    })
    throw new Error(`Welt-Archiv ist nicht lesbar: ${basename(options.archivePath)}`, { cause: error })
  }

  const entries = zip.getEntries()
  const roots = scanArchiveWorlds(entries)
  if (roots.length === 0) {
    throw new Error(
      `Im Archiv ${basename(options.archivePath)} wurde keine Minecraft-Welt gefunden: ` +
        'erwartet wird ein Ordner mit level.dat (oder die Weltdateien direkt im Archiv).',
    )
  }

  const files = entries.filter((entry) => !entry.isDirectory && archiveEntryPath(entry.entryName) !== null)
  if (files.length > MAX_ENTRY_COUNT) {
    throw new Error(`Welt-Archiv enthält zu viele Dateien (${files.length}); Installation abgebrochen`)
  }
  const declaredBytes = files.reduce((total, entry) => total + (entry.header?.size ?? 0), 0)
  if (declaredBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new Error('Welt-Archiv ist unerwartet groß; Installation abgebrochen')
  }

  const savesDir = resolveInside(options.instanceDir, SAVES_FOLDER)
  await mkdir(savesDir, { recursive: true })
  const stagingDir = resolveInside(
    options.instanceDir,
    STAGING_FOLDER,
    `${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  await mkdir(stagingDir, { recursive: true })

  const installed: InstalledWorld[] = []
  const taken = new Set<string>()
  try {
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index]
      const relative = archiveEntryPath(entry.entryName)
      if (!relative) continue
      const target = resolveInside(stagingDir, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.getData())
      options.onProgress?.({ done: index + 1, total: files.length, file: relative })
    }

    for (const world of roots) {
      const source = world.root === '' ? stagingDir : join(stagingDir, world.root)
      const preferred = preferredFolderNameFor(world.root, options)
      const { folderName, renamed } = availableWorldFolderName(savesDir, preferred, taken)
      taken.add(folderName.toLowerCase())
      const destination = resolveInside(savesDir, folderName)
      await moveDirectory(source, destination)
      installed.push({
        folderName,
        path: destination,
        sourceName: world.root,
        files: world.files,
        renamed,
      })
      logger?.info('world installed', { folderName, renamed, files: world.files })
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  return { worlds: installed }
}
