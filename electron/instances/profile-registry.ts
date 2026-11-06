import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import path from 'node:path'
import { describeError, getDefaultLogger, type Logger } from '../logger'

/**
 * The single owner of the legacy instance list (`<gameRoot>/profiles.json`).
 *
 * Everything that reads or writes that file goes through this class: the atomic
 * replace, the quarantine of an unreadable copy, and the folder-name rules live
 * here once instead of being repeated at each handler. `update()` and
 * `patchSizes()` re-read inside the call, so a caller that measured something
 * expensive beforehand can never write a stale list over a newer one.
 */
export interface LegacyProfile {
  folderName?: unknown
  name?: unknown
  id?: unknown
  size?: unknown
  [key: string]: unknown
}

export function profileFolderSlug(value: unknown): string {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'instance'
  )
}

export function profileFolderOf(profile: LegacyProfile | null | undefined): string {
  const stored = typeof profile?.folderName === 'string' ? profile.folderName.trim() : ''
  if (stored && stored !== '.' && stored !== '..') return path.basename(stored)
  return profileFolderSlug(profile?.name || profile?.id || 'instance')
}

export interface UpdateResult<T> {
  next?: LegacyProfile[]
  result: T
}

export class ProfileRegistry {
  readonly #file: string
  readonly #logger: Logger
  /** Fingerprint of the unreadable state already kept, so reads stay idempotent. */
  #quarantineKey = ''

  constructor(readonly rootPath: string, logger: Logger = getDefaultLogger().child('profiles')) {
    this.#file = path.join(rootPath, 'profiles.json')
    this.#logger = logger
  }

  get file(): string {
    return this.#file
  }

  /** Never throws: an unreadable file is copied aside and reported as empty. */
  read(): LegacyProfile[] {
    return this.#readList() ?? []
  }

  /**
   * The list the UI shows. Older layouts kept the same list inside
   * `profiles/profiles.json` or as one JSON file per profile; both are still
   * read when the main file is missing or unreadable.
   */
  readWithFallback(): LegacyProfile[] {
    const primary = this.#readList()
    if (primary) return primary

    const nested = path.join(this.rootPath, 'profiles', 'profiles.json')
    try {
      if (existsSync(nested)) {
        const parsed: unknown = JSON.parse(readFileSync(nested, 'utf8'))
        if (Array.isArray(parsed)) return parsed as LegacyProfile[]
        this.#logger.warn('profiles/profiles.json is not a list')
      }
    } catch (error) {
      this.#logger.warn('profiles/profiles.json is unreadable', { error: describeError(error) })
    }

    const profilesDir = path.join(this.rootPath, 'profiles')
    if (!existsSync(profilesDir) || !statSync(profilesDir).isDirectory()) return []
    const result: LegacyProfile[] = []
    for (const name of readdirSync(profilesDir)) {
      if (!name.endsWith('.json') || name === 'profiles.json') continue
      try {
        const parsed: unknown = JSON.parse(readFileSync(path.join(profilesDir, name), 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          result.push(parsed as LegacyProfile)
        }
      } catch (error) {
        this.#logger.debug('skipping unreadable profile file', { file: name, error: describeError(error) })
      }
    }
    return result
  }

  /** `undefined` when the file is missing, unreadable or not a list. */
  #readList(): LegacyProfile[] | undefined {
    if (!existsSync(this.#file)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (Array.isArray(parsed)) return parsed as LegacyProfile[]
      this.#logger.warn('profiles.json is not a list')
    } catch (error) {
      this.#logger.warn('profiles.json is unreadable', { error: describeError(error) })
    }
    // A read error is as much a reason to keep the file as broken JSON is.
    this.#quarantineIfUnreadable()
    return undefined
  }

  /** Sibling temp file + rename: a crash cannot leave a truncated list. */
  write(profiles: LegacyProfile[]): void {
    // Never replace a file that could not be read before it was kept.
    this.#quarantineIfUnreadable()
    mkdirSync(this.rootPath, { recursive: true })
    const temp = `${this.#file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(profiles, null, 2))
    renameSync(temp, this.#file)
  }

  /** Load, mutate, write — serialized by the caller's own synchronous block. */
  update<T>(mutator: (profiles: LegacyProfile[]) => UpdateResult<T>): T {
    const current = this.read()
    const { next, result } = mutator(current)
    if (next) this.write(next)
    return result
  }

  /**
   * Writes sizes that were measured before the call onto whatever the list looks
   * like now. Entries are never added or dropped, so a save that happened during
   * the measurement window cannot be lost.
   */
  patchSizes(folderSizes: ReadonlyMap<string, string>): boolean {
    if (folderSizes.size === 0) return false
    let changed = false
    this.update((profiles) => {
      const next = profiles.map((profile) => {
        if (!profile || typeof profile !== 'object') return profile
        const size = folderSizes.get(profileFolderOf(profile).toLowerCase())
        if (size === undefined || profile.size === size) return profile
        changed = true
        return { ...profile, size }
      })
      return { next: changed ? next : undefined, result: undefined }
    })
    return changed
  }

  /**
   * One copy per unreadable state. A directory in place of the file is copied as
   * a directory; nothing here may throw into a caller.
   */
  #quarantineIfUnreadable(): void {
    let stat: Stats
    try {
      stat = statSync(this.#file)
    } catch {
      return // missing, or metadata itself is unreadable: nothing to copy
    }
    const key = `${stat.isDirectory() ? 'dir' : 'file'}:${stat.size}:${stat.mtimeMs}`
    if (key === this.#quarantineKey) return
    if (!stat.isDirectory() && this.#readsAsList()) return
    const backup = `${this.#file}.corrupt-${Date.now()}`
    try {
      if (stat.isDirectory()) cpSync(this.#file, backup, { recursive: true })
      else copyFileSync(this.#file, backup)
      this.#quarantineKey = key
      this.#logger.warn('profiles.json quarantined', { backup })
    } catch (error) {
      this.#logger.error('profiles.json could not be quarantined', { error: describeError(error) })
    }
  }

  #readsAsList(): boolean {
    try {
      return Array.isArray(JSON.parse(readFileSync(this.#file, 'utf8')))
    } catch {
      return false
    }
  }
}

const registries = new Map<string, ProfileRegistry>()

/** One registry per game root, so the folder rules and writer stay single. */
export function profileRegistry(rootPath: string, logger?: Logger): ProfileRegistry {
  const key = path.resolve(rootPath)
  const existing = registries.get(key)
  if (existing) return existing
  const created = new ProfileRegistry(key, logger)
  registries.set(key, created)
  return created
}
