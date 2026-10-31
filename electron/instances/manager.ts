import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolveVersionModel } from '../version/resolve'
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from '../atomic'
import { normalizeJavaPath, slugify } from '../instance-store'
import type { InstanceStore } from '../instance-store'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import type { InstanceFile, InstanceLoader, LauncherInstance } from '../schemas'
import { InstanceFileSchema, parseWithDefaults } from '../schemas'
import { ContentStore } from './content-store'
import { InstanceError } from './errors'
import { InstanceLocks } from './lock'
import {
  COPIED_DIRS,
  COPIED_FILES,
  INSTANCE_FILE,
  INSTANCE_LOCK_FILE,
  INSTANCE_SUBDIRS,
  LINKED_DIRS,
  instancesRoot,
  resolveInstancePath,
  rewriteInstancePath,
  trashRoot,
} from './layout'

export interface InstanceDescriptor {
  instance: LauncherInstance
  directory: string
}

export interface InstanceManagerOptions {
  gameRoot: () => string
  store: InstanceStore
  logger?: Logger
  cacheDir?: string
  loaderInstaller?: (
    kind: InstanceLoader,
    request: { minecraftVersion: string; loaderVersion?: string },
  ) => Promise<{ versionId: string }>
  baseInstaller?: (minecraftVersion: string) => Promise<unknown>
  locks?: InstanceLocks
}

export interface CreateInstanceRequest {
  name: string
  versionId?: string
  minecraftVersion?: string
  loader?: InstanceLoader
  loaderVersion?: string
  javaPath?: string
  minMemory?: number
  maxMemory?: number
  group?: string
  icon?: string
}

export interface DuplicateInstanceOptions {
  name?: string
  group?: string
}

function requireName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (name.length === 0 || name.length > 80) {
    throw new InstanceError('invalid-name', 'Instance name must be 1–80 characters')
  }
  return name
}

function versionJsonPath(gameRoot: string, versionId: string): string {
  return join(gameRoot, 'versions', versionId, `${versionId}.json`)
}

function looksLikeMinecraftVersion(value: string): boolean {
  return /^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])$/.test(value)
}

function loaderProfileId(
  loader: InstanceLoader,
  minecraftVersion: string,
  loaderVersion: string,
): string | undefined {
  if (!loaderVersion) return undefined
  if (loader === 'fabric' || loader === 'quilt') {
    return `${loader}-loader-${loaderVersion}-${minecraftVersion}`
  }
  if (loader === 'forge') return `${minecraftVersion}-forge-${loaderVersion}`
  if (loader === 'neoforge') return `neoforge-${loaderVersion}`
  return undefined
}

async function isDirectory(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => undefined)
  return info?.isDirectory() === true
}

async function removeTree(target: string): Promise<Error | undefined> {
  let last: Error | undefined
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return undefined
    } catch (error) {
      last = error as Error
      getDefaultLogger().child('instances').debug('instance tree removal attempt failed; retrying', {
        target,
        attempt: attempt + 1,
        error: last.message,
      })
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  return last
}

async function copyTree(source: string, target: string): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    // A missing source directory is legitimately empty. Any other read failure
    // would otherwise produce a silent, incomplete duplicate, so it aborts.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      getDefaultLogger().child('instances').warn('Instance directory could not be read while copying', {
        source,
        error: describeError(error),
      })
      throw error
    }
    getDefaultLogger().child('instances').debug('Source directory absent while copying', { source })
    entries = []
  }
  await ensureDir(target)
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) {
      await copyFile(from, to)
    }
  }
}

export class InstanceManager {
  readonly #getGameRoot: () => string
  readonly #store: InstanceStore
  readonly #logger?: Logger
  readonly #loaderInstaller?: InstanceManagerOptions['loaderInstaller']
  readonly #baseInstaller?: InstanceManagerOptions['baseInstaller']
  readonly locks: InstanceLocks

  constructor(options: InstanceManagerOptions) {
    this.#getGameRoot = options.gameRoot
    this.#store = options.store
    this.#logger = options.logger
    this.#loaderInstaller = options.loaderInstaller
    this.#baseInstaller = options.baseInstaller
    this.locks = options.locks ?? new InstanceLocks(options.logger)
  }

  async list(): Promise<InstanceDescriptor[]> {
    const gameRoot = this.#getGameRoot()
    const records = await this.#store.list()
    return records.map((instance) => ({
      instance,
      directory: resolveInstancePath(gameRoot, instance),
    }))
  }

  async get(id: string): Promise<InstanceDescriptor> {
    const instance = await this.#store.get(id)
    if (!instance) throw new InstanceError('not-found', `Unknown instance: ${id}`, { id })
    return { instance, directory: resolveInstancePath(this.#getGameRoot(), instance) }
  }

  async readFile(instanceId: string): Promise<InstanceFile> {
    const found = await this.get(instanceId)
    const { file, raw } = await this.#loadInstanceFile(found)
    const storedJavaMode = raw?.javaMode
    const storedMemoryMode = raw?.memoryMode
    const javaPath = normalizeJavaPath(file.javaPath)
    // The legacy UI wrote its "Automatisch" label into javaPath. Empty is the
    // launch core's automatic marker; keeping the label would pin a fake EXE.
    const javaMode: 'auto' | 'pinned' =
      javaPath.length === 0
        ? 'auto'
        : storedJavaMode === 'auto' || storedJavaMode === 'pinned'
          ? storedJavaMode
          : 'pinned'
    const memoryMode: 'auto' | 'explicit' =
      storedMemoryMode === 'auto' || storedMemoryMode === 'explicit'
        ? storedMemoryMode
        : file.maxMemory > 0
          ? 'explicit'
          : 'auto'
    const versionFields = await this.#normalizeVersionFields(file)
    const changed =
      javaPath !== file.javaPath ||
      storedJavaMode !== javaMode ||
      storedMemoryMode !== memoryMode ||
      versionFields.changed
    if (!changed) return file

    const normalized: InstanceFile = {
      ...file,
      javaPath,
      javaMode,
      memoryMode,
      version: versionFields.version,
      versionId: versionFields.versionId,
    }
    try {
      await writeJsonFile(join(found.directory, INSTANCE_FILE), normalized, this.#logger)
    } catch (error) {
      this.#logger?.warn('Instance field migration could not be persisted', {
        id: instanceId,
        error: (error as Error).message,
      })
    }
    if (versionFields.changed) {
      try {
        await this.#store.upsert({
          ...found.instance,
          version: normalized.version,
          versionId: normalized.versionId,
          updatedAt: Date.now(),
        })
      } catch (error) {
        this.#logger?.warn('Instance index migration could not be persisted', {
          id: instanceId,
          error: (error as Error).message,
        })
      }
    }
    return normalized
  }

  /**
   * Older launches stored the installed loader profile id in `version`, but
   * `version` is the Minecraft version everywhere else. Recover the game
   * version from the installed profile and keep the profile id separately.
   */
  async #normalizeVersionFields(
    file: InstanceFile,
  ): Promise<{ version: string; versionId: string; changed: boolean }> {
    const version = String(file.version ?? '').trim()
    let versionId = String(file.versionId ?? '').trim()
    if (!version) return { version, versionId, changed: false }

    if (versionId) {
      if (looksLikeMinecraftVersion(version)) return { version, versionId, changed: false }
      const minecraftVersion = await this.#minecraftVersionOfProfile(versionId)
      return minecraftVersion && minecraftVersion !== version
        ? { version: minecraftVersion, versionId, changed: true }
        : { version, versionId, changed: false }
    }

    if (!looksLikeMinecraftVersion(version)) {
      const minecraftVersion = await this.#minecraftVersionOfProfile(version)
      if (minecraftVersion && minecraftVersion !== version) {
        return { version: minecraftVersion, versionId: version, changed: true }
      }
      // Keep the unrepairable value launchable: it is the profile id, not a
      // Minecraft version, so never hand it to the dependency resolver.
      return { version, versionId: version, changed: true }
    }

    if (file.loader !== 'vanilla') {
      const candidate = loaderProfileId(file.loader, version, file.loaderVersion)
      if (
        candidate &&
        (await pathExists(versionJsonPath(this.#getGameRoot(), candidate)))
      ) {
        versionId = candidate
        return { version, versionId, changed: true }
      }
    }
    return { version, versionId, changed: false }
  }

  async #minecraftVersionOfProfile(versionId: string): Promise<string | undefined> {
    const gameRoot = this.#getGameRoot()
    let current = versionId
    for (let depth = 0; depth < 8; depth += 1) {
      const raw = await readJsonFile<Record<string, unknown>>(
        versionJsonPath(gameRoot, current),
        this.#logger,
      )
      if (!raw) break
      const parent =
        typeof raw.inheritsFrom === 'string' ? raw.inheritsFrom.trim() : ''
      if (!parent) {
        return looksLikeMinecraftVersion(current) ? current : undefined
      }
      current = parent
      if (looksLikeMinecraftVersion(current)) return current
    }
    if (looksLikeMinecraftVersion(current)) return current
    const fabric = /^(?:fabric|quilt)-loader-.+-(\d+\.\d+(?:\.\d+)?)$/.exec(versionId)
    if (fabric?.[1]) return fabric[1]
    const forge = /^(\d+\.\d+(?:\.\d+)?)-forge-.+$/.exec(versionId)
    if (forge?.[1]) return forge[1]
    return undefined
  }

  async updateFile(instanceId: string, patch: Partial<InstanceFile>): Promise<InstanceFile> {
    const found = await this.get(instanceId)
    const current = await this.readFile(instanceId)
    const next = this.#instanceFile({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    })
    await writeJsonFile(join(found.directory, INSTANCE_FILE), next, this.#logger)
    await this.#store.upsert({
      ...found.instance,
      name: next.name,
      version: next.version,
      versionId: next.versionId,
      loader: next.loader,
      loaderVersion: next.loaderVersion,
      javaPath: next.javaPath,
      minMemory: next.minMemory,
      maxMemory: next.maxMemory,
      group: next.group,
      updatedAt: next.updatedAt,
    })
    this.#logger?.info('Instance file updated', { id: instanceId })
    return next
  }

  async findByFolder(folderName: string): Promise<InstanceDescriptor | undefined> {
    const target = basename(String(folderName ?? '').trim()).toLowerCase()
    if (!target) return undefined
    const found = (await this.list()).find((entry) => {
      const stored = String(entry.instance.folderName ?? '').toLowerCase()
      return stored === target || basename(entry.directory).toLowerCase() === target
    })
    return found
  }

  async create(request: CreateInstanceRequest): Promise<InstanceDescriptor> {
    const name = requireName(request.name)
    const gameRoot = this.#getGameRoot()
    const { versionId, minecraftVersion, loader, loaderVersion } =
      await this.#resolveVersion(request)

    const id = await this.#uniqueId(slugify(name) || 'instance')
    const folder = await this.#uniqueFolder(slugify(name) || 'instance')
    const directory = join(instancesRoot(gameRoot), folder)
    await ensureDir(instancesRoot(gameRoot))
    await mkdir(directory, { recursive: false })
    for (const sub of INSTANCE_SUBDIRS) await ensureDir(join(directory, sub))

    const now = Date.now()
    const file = this.#instanceFile({
      id,
      name,
      version: minecraftVersion,
      versionId,
      loader,
      loaderVersion,
      lastPlayedAt: 0,
      playTimeMs: 0,
      javaPath: request.javaPath ?? '',
      minMemory: request.minMemory ?? 0,
      maxMemory: request.maxMemory ?? 0,
      group: request.group ?? '',
      icon: request.icon ?? '',
      createdAt: now,
      updatedAt: now,
    })
    await writeJsonFile(join(directory, INSTANCE_FILE), file, this.#logger)

    const instance = await this.#store.upsert({
      id,
      name,
      folderName: folder,
      managed: true,
      path: join('instances', folder),
      version: minecraftVersion,
      versionId,
      loader,
      loaderVersion,
      javaPath: request.javaPath ?? '',
      minMemory: request.minMemory ?? 0,
      maxMemory: request.maxMemory ?? 0,
      group: request.group ?? '',
      createdAt: now,
      updatedAt: now,
    })
    if (!(await this.#store.selected())) await this.#store.select(id)
    this.#logger?.info('Instance created', { id, name, versionId, loader, directory })
    return { instance, directory }
  }

  async duplicate(id: string, options: DuplicateInstanceOptions = {}): Promise<InstanceDescriptor> {
    const source = await this.get(id)
    const gameRoot = this.#getGameRoot()
    const lock = await this.locks.acquire(source.directory, {
      operation: 'duplicate',
      instanceId: id,
    })
    let createdDirectory = ''
    try {
      const sourceFile = await this.#readInstanceFile(source)
      const name = requireName(options.name ?? `${source.instance.name} (Kopie)`)
      const newId = await this.#uniqueId(slugify(name) || 'instance')
      const folder = await this.#uniqueFolder(slugify(name) || 'instance')
      const directory = join(instancesRoot(gameRoot), folder)
      createdDirectory = directory
      await ensureDir(instancesRoot(gameRoot))
      await mkdir(directory, { recursive: false })
      for (const sub of INSTANCE_SUBDIRS) await ensureDir(join(directory, sub))

      const content = new ContentStore(gameRoot, this.#logger?.child('content'))
      for (const dirName of LINKED_DIRS) {
        const from = join(source.directory, dirName)
        const to = join(directory, dirName)
        for (const file of await this.#walkFiles(from)) {
          const relative = file.slice(from.length + 1)
          await content.putAndLink(file, join(to, relative))
        }
      }
      for (const dirName of COPIED_DIRS) {
        await copyTree(join(source.directory, dirName), join(directory, dirName))
      }
      for (const fileName of COPIED_FILES) {
        const from = join(source.directory, fileName)
        if (await pathExists(from)) await copyFile(from, join(directory, fileName))
      }

      const now = Date.now()
      const copy = this.#instanceFile({
        ...sourceFile,
        id: newId,
        name,
        group: options.group ?? sourceFile.group,
        createdAt: now,
        updatedAt: now,
        lastPlayedAt: 0,
        playTimeMs: 0,
      })
      await writeJsonFile(join(directory, INSTANCE_FILE), copy, this.#logger)

      const instance = await this.#store.upsert({
        id: newId,
        name,
        folderName: folder,
        managed: true,
        path: join('instances', folder),
        version: source.instance.version,
        versionId: source.instance.versionId,
        loader: source.instance.loader,
        loaderVersion: source.instance.loaderVersion,
        javaPath: source.instance.javaPath,
        minMemory: source.instance.minMemory,
        maxMemory: source.instance.maxMemory,
        group: options.group ?? sourceFile.group,
        createdAt: now,
        updatedAt: now,
      })
      this.#logger?.info('Instance duplicated', { from: id, id: newId, directory })
      return { instance, directory }
    } catch (error) {
      if (createdDirectory) {
        const cleanup = await removeTree(createdDirectory)
        this.#logger?.warn(
          cleanup
            ? 'Duplicate failed; partial instance folder could not be removed'
            : 'Duplicate failed; partial instance folder removed',
          {
            directory: createdDirectory,
            error: describeError(error),
            cleanupError: cleanup ? cleanup.message : undefined,
          },
        )
      }
      throw error
    } finally {
      await this.locks.release(lock)
    }
  }

  async rename(id: string, nextName: string): Promise<InstanceDescriptor> {
    const name = requireName(nextName)
    const found = await this.get(id)
    const gameRoot = this.#getGameRoot()
    const lock = await this.locks.acquire(found.directory, { operation: 'rename', instanceId: id })
    let directory = found.directory
    try {
      let folderName = String(found.instance.folderName ?? '')
      let storedPath = String(found.instance.path ?? '')
      if (found.instance.managed !== false) {
        const folder = await this.#uniqueFolder(slugify(name) || folderName, folderName)
        if (folder !== folderName) {
          const nextDirectory = join(instancesRoot(gameRoot), folder)
          if (await pathExists(nextDirectory)) {
            throw new InstanceError('exists', `Instance folder already exists: ${nextDirectory}`, {
              directory: nextDirectory,
            })
          }
          await rename(found.directory, nextDirectory)
          directory = nextDirectory
          folderName = folder
          storedPath = join('instances', folder)
        }
      }

      const file = await this.#readInstanceFile({ ...found, directory })
      await writeJsonFile(
        join(directory, INSTANCE_FILE),
        this.#instanceFile({ ...file, name, updatedAt: Date.now() }),
        this.#logger,
      )
      const instance = await this.#store.upsert({
        ...found.instance,
        name,
        folderName,
        path: storedPath,
        updatedAt: Date.now(),
      })
      this.#logger?.info('Instance renamed', { id, name, directory })
      return { instance, directory }
    } catch (error) {
      if (directory !== found.directory) {
        await rename(directory, found.directory).catch((rollbackError) => {
          this.#logger?.warn('Instance rename rollback failed', {
            directory,
            target: found.directory,
            error: describeError(rollbackError),
          })
        })
      }
      throw error
    } finally {
      await this.locks.releaseAt(directory, lock.lock.owner)
      if (directory !== found.directory) {
        await this.locks.releaseAt(found.directory, lock.lock.owner).catch((error) => {
          this.#logger?.debug('Old instance lock release failed after rename', {
            directory: found.directory,
            error: describeError(error),
          })
        })
      }
    }
  }

  async delete(id: string, options: { keepFiles?: boolean } = {}): Promise<boolean> {
    const found = await this.get(id)
    const gameRoot = this.#getGameRoot()
    const lock = await this.locks.acquire(found.directory, { operation: 'delete', instanceId: id })
    try {
      if (found.instance.managed === false || options.keepFiles) {
        await this.#store.remove(id)
        return true
      }
      const trash = join(trashRoot(gameRoot), `${id}-${Date.now()}`)
      await ensureDir(trashRoot(gameRoot))
      try {
        await rename(found.directory, trash)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await this.#store.remove(id)
      await this.locks.releaseAt(trash, lock.lock.owner)
      const removeError = await removeTree(trash)
      if (removeError) {
        this.#logger?.warn('Instance folder left in trash', {
          trash,
          error: removeError.message,
        })
      }
      this.#logger?.info('Instance deleted', { id, trash })
      return true
    } finally {
      await this.locks.releaseAt(found.directory, lock.lock.owner).catch((error) => {
        this.#logger?.debug('Instance lock release failed after delete', {
          directory: found.directory,
          error: describeError(error),
        })
      })
    }
  }

  async relocate(oldRoot: string, newRoot: string): Promise<number> {
    const records = await this.#store.list()
    let changed = 0
    for (const record of records) {
      if (record.managed !== false) continue
      const next = rewriteInstancePath(String(record.path ?? ''), oldRoot, newRoot)
      if (!next || next === record.path) continue
      await this.#store.upsert({ ...record, path: next, updatedAt: Date.now() })
      changed += 1
    }
    if (changed > 0) this.#logger?.info('Instance paths rewritten', { oldRoot, newRoot, changed })
    return changed
  }

  async sharedResources(id: string): Promise<{
    gameRoot: string
    instanceDirectory: string
    libraries: number
    natives: number
  }> {
    const gameRoot = this.#getGameRoot()
    const found = await this.get(id)
    const file = await this.readFile(id)
    const model = await resolveVersionModel(gameRoot, file.versionId || file.version)
    return {
      gameRoot,
      instanceDirectory: found.directory,
      libraries: model.libraries.length,
      natives: model.natives.length,
    }
  }

  async #resolveVersion(request: CreateInstanceRequest): Promise<{
    versionId: string
    minecraftVersion: string
    loader: InstanceLoader
    loaderVersion: string
  }> {
    const gameRoot = this.#getGameRoot()
    const loader: InstanceLoader = request.loader ?? 'vanilla'
    let versionId = request.versionId ?? ''
    let loaderVersion = request.loaderVersion ?? ''
    let minecraftVersion = request.minecraftVersion ?? ''

    if (loader !== 'vanilla') {
      if (!versionId) {
        if (!minecraftVersion) {
          throw new InstanceError(
            'invalid-request',
            'minecraftVersion is required when no versionId is given',
          )
        }
        if (!this.#loaderInstaller) {
          throw new InstanceError('invalid-request', 'No loader installer configured')
        }
        const installed = await this.#loaderInstaller(loader, {
          minecraftVersion,
          ...(loaderVersion ? { loaderVersion } : {}),
        })
        versionId = installed.versionId
      }
      if (!minecraftVersion) {
        minecraftVersion = (await this.#minecraftVersionOfProfile(versionId)) ?? ''
      }
      if (!minecraftVersion) {
        if (looksLikeMinecraftVersion(versionId)) minecraftVersion = versionId
        else {
          throw new InstanceError(
            'invalid-request',
            `Cannot determine the Minecraft version for ${versionId}`,
            { versionId },
          )
        }
      }
    } else if (!versionId) {
      if (!minecraftVersion) {
        throw new InstanceError('invalid-request', 'versionId or minecraftVersion is required')
      }
      versionId = minecraftVersion
    } else if (!minecraftVersion) {
      minecraftVersion = versionId
    }

    if (!(await pathExists(versionJsonPath(gameRoot, versionId)))) {
      if (!this.#baseInstaller) {
        throw new InstanceError(
          'invalid-request',
          `Version is not installed: ${versionId}`,
          { versionId },
        )
      }
      await this.#baseInstaller(versionId)
    }
    if (!(await pathExists(versionJsonPath(gameRoot, versionId)))) {
      throw new InstanceError('invalid-request', `Version is not installed: ${versionId}`, {
        versionId,
      })
    }
    if (!loaderVersion && loader !== 'vanilla') {
      loaderVersion = request.loaderVersion ?? ''
    }
    return { versionId, minecraftVersion, loader, loaderVersion }
  }

  #instanceFile(file: InstanceFile): InstanceFile {
    return parseWithDefaults(InstanceFileSchema, file, file) as InstanceFile
  }

  async #loadInstanceFile(
    found: InstanceDescriptor,
  ): Promise<{ file: InstanceFile; raw?: Record<string, unknown> }> {
    const file = join(found.directory, INSTANCE_FILE)
    const raw = await readJsonFile<Record<string, unknown>>(file, this.#logger)
    if (raw) {
      return {
        file: parseWithDefaults(InstanceFileSchema, raw, this.#defaultFile(found)) as InstanceFile,
        raw,
      }
    }
    return { file: this.#defaultFile(found) }
  }

  async #readInstanceFile(found: InstanceDescriptor): Promise<InstanceFile> {
    return (await this.#loadInstanceFile(found)).file
  }

  #defaultFile(found: InstanceDescriptor): InstanceFile {
    return {
      id: found.instance.id,
      name: found.instance.name,
      version: found.instance.version,
      versionId: found.instance.versionId ?? '',
      loader: found.instance.loader,
      loaderVersion: found.instance.loaderVersion,
      javaPath: found.instance.javaPath,
      javaMode: found.instance.javaPath ? 'pinned' : 'auto',
      minMemory: found.instance.minMemory,
      maxMemory: found.instance.maxMemory,
      memoryMode: found.instance.maxMemory > 0 ? 'explicit' : 'auto',
      icon: '',
      group: '',
      lastPlayedAt: 0,
      playTimeMs: 0,
      createdAt: found.instance.createdAt,
      updatedAt: found.instance.updatedAt,
    }
  }

  async #uniqueId(base: string): Promise<string> {
    const records = await this.#store.list()
    const used = new Set(records.map((record) => record.id.toLowerCase()))
    let candidate = `instance-${base}`
    let index = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = `instance-${base}-${index}`
      index += 1
    }
    return candidate
  }

  async #uniqueFolder(base: string, exclude?: string): Promise<string> {
    const gameRoot = this.#getGameRoot()
    const records = await this.#store.list()
    const used = new Set(
      records
        .filter((record) => record.managed !== false)
        .map((record) => String(record.folderName ?? '').toLowerCase())
        .filter(Boolean),
    )
    const excluded = String(exclude ?? '').toLowerCase()
    let candidate = base
    let index = 2
    while (
      candidate.toLowerCase() !== excluded &&
      (used.has(candidate.toLowerCase()) || (await pathExists(join(instancesRoot(gameRoot), candidate))))
    ) {
      candidate = `${base}-${index}`
      index += 1
    }
    return candidate
  }

  async #walkFiles(root: string): Promise<string[]> {
    if (!(await isDirectory(root))) return []
    const result: string[] = []
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === INSTANCE_LOCK_FILE) continue
      const full = join(root, entry.name)
      if (entry.isDirectory()) result.push(...(await this.#walkFiles(full)))
      else if (entry.isFile()) result.push(full)
    }
    return result
  }
}
