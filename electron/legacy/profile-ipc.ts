import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { profileFolderOf, profileRegistry, profileFolderSlug } from '../instances/profile-registry'
import type { LegacyProfile } from '../instances/profile-registry'
import type { Logger } from '../logger'

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

interface FirstRunResult {
  path: string
  created: boolean
  reason?: string
  keybindCount?: number
}

export interface ProfileIpcOptions {
  logger: Logger
  gameRoot(): string
  resolveGameRoot(): Promise<string>
  shell: { openPath(path: string): Promise<string> | string }
  launches: {
    has(folderName: string): boolean
    rename(from: string, to: string): void
  }
  instanceSizeCache: Map<string, number>
  instanceSizeDirty: Set<string>
  formatSize(bytes: number): string
  scheduleInstanceSizeRefresh(rootPath: string): void
  forgetInstanceSize(folderName: string): void
  readProfilesSync(rootPath: string): LegacyProfile[]
  writeProfilesSync(rootPath: string, profiles: LegacyProfile[]): void
  profileDirOrNull(rootPath: string, folderName: unknown): string | null
  uniqueProfileFolder(
    rootPath: string,
    desiredBase: string,
    profiles: LegacyProfile[],
    excludeFolder?: string,
  ): string
  uniqueProfileName(profiles: LegacyProfile[], baseName: string): string
  upsertCoreInstance(
    profile: LegacyProfile,
    overrides?: Record<string, unknown>,
  ): Promise<void>
  removeCoreInstance(folderName: string): Promise<boolean>
  renameCoreInstance(oldFolder: string, newFolder: string, newDir: string): Promise<boolean>
  syncCoreInstances(profiles: LegacyProfile[]): Promise<void>
  writeFirstRunOptions(gameDir: string, options: unknown): FirstRunResult
}

/**
 * Everything that creates, opens, renames, clones or deletes an instance on
 * disk. These handlers touch three places that must agree: profiles.json, the
 * folder under profiles/ and the core register.
 */
export function registerProfileIpc(ipc: IpcRegistrar, options: ProfileIpcOptions): void {
  const { logger } = options

  ipc.handle('create-instance', async (_event, payload) => {
    const data = (payload ?? {}) as Record<string, unknown>
    const folderName = data.folderName
    const instanceOptions = data.options as Record<string, unknown> | undefined
    const { name, version, loader, loaderVersion } = data
    try {
      if (!folderName || typeof folderName !== 'string' || folderName.includes('..')) {
        return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }
      }
      const rootPath = await options.resolveGameRoot()
      const profileFolder = options.uniqueProfileFolder(
        rootPath,
        folderName,
        options.readProfilesSync(rootPath),
      )
      const gameDir = join(rootPath, 'profiles', profileFolder)
      mkdirSync(gameDir, { recursive: true })
      const result = options.writeFirstRunOptions(gameDir, instanceOptions)
      logger.debug('create-instance: options.txt ready', {
        path: result.path,
        created: result.created,
        keybinds: result.keybindCount ?? 0,
        requestedFolder: folderName,
        folder: profileFolder,
      })
      await options.upsertCoreInstance(
        {
          folderName: profileFolder,
          name: name || profileFolder,
          version: version || instanceOptions?._mcVersion,
        },
        { loader, loaderVersion },
      )
      return {
        success: true,
        folderName: profileFolder,
        path: result.path,
        created: result.created,
        reason: result.reason,
        keybindCount: result.keybindCount ?? 0,
      }
    } catch (error) {
      logger.error('create-instance failed', { error: (error as Error).message })
      return { success: false, error: (error as Error).message }
    }
  })

  ipc.handle('open-profile-folder', async (_event, folderName) => {
    const rootPath = options.gameRoot()
    const instanceDir = options.profileDirOrNull(rootPath, folderName)
    if (!instanceDir) {
      return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }
    }
    const gameDir = join(instanceDir, 'saves')
    if (!existsSync(gameDir)) mkdirSync(gameDir, { recursive: true })
    void options.shell.openPath(gameDir)
    return { success: true }
  })

  ipc.handle('open-instance-folder', async (_event, folderName) => {
    const rootPath = options.gameRoot()
    const gameDir = options.profileDirOrNull(rootPath, folderName)
    if (!gameDir) {
      return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }
    }
    if (!existsSync(gameDir)) mkdirSync(gameDir, { recursive: true })
    void options.shell.openPath(gameDir)
    return { success: true }
  })

  ipc.handle('delete-profile-files', async (_event, folderName) => {
    const rootPath = options.gameRoot()
    const gameDir = options.profileDirOrNull(rootPath, folderName)
    if (!gameDir) {
      logger.warn('delete-profile-files: rejected folder name', { folderName })
      return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }
    }
    // A running game holds files open; a recursive delete would stop halfway and
    // leave a broken instance behind.
    if (options.launches.has(String(folderName))) {
      logger.warn('delete-profile-files: instance is running', { folderName })
      return {
        success: false,
        error: 'Die Instanz läuft noch. Beende das Spiel, dann löschen.',
        code: 'instance-running',
      }
    }
    let deleted = false
    try {
      if (existsSync(gameDir)) {
        rmSync(gameDir, { recursive: true, force: true })
        deleted = true
        logger.info('profile folder deleted', { gameDir })
      }
    } catch (error) {
      logger.error('profile folder could not be deleted', {
        gameDir,
        error: (error as Error).message,
      })
      return { success: false, error: (error as Error).message }
    }
    if (!(await options.removeCoreInstance(String(folderName)))) {
      logger.error('delete-profile-files: core still lists the deleted instance', {
        folderName,
      })
    }
    options.forgetInstanceSize(String(folderName))
    const screenshotsDir = join(rootPath, 'screenshots')
    let screenshots = 0
    if (existsSync(screenshotsDir)) {
      const prefix = String(folderName) + '__'
      for (const file of readdirSync(screenshotsDir)) {
        if (!file.startsWith(prefix)) continue
        try {
          unlinkSync(join(screenshotsDir, file))
          screenshots += 1
        } catch (error) {
          logger.debug('profile screenshot could not be deleted', {
            file,
            error: (error as Error).message,
          })
        }
      }
      if (screenshots > 0) logger.debug('profile screenshots deleted', { folderName, screenshots })
    }
    return { success: true, deleted, screenshots }
  })

  ipc.handle('get-profiles', async () => {
    const rootPath = options.gameRoot()
    // profiles.json is the truth for the visible list and its folder names; the
    // core register is projected from it, never merged back.
    const profiles = profileRegistry(rootPath).readWithFallback()
    void options.syncCoreInstances(profiles)
    return profiles
  })

  ipc.handle('save-profiles', async (_event, profiles) => {
    const rootPath = options.gameRoot()
    if (!existsSync(rootPath)) mkdirSync(rootPath, { recursive: true })
    const enriched = (profiles as LegacyProfile[]).map((profile) => {
      const folderName = profileFolderOf(profile)
      const key = folderName.toLowerCase()
      const cached = options.instanceSizeCache.get(key)
      // No measured size yet: keep what the renderer had and queue the folder.
      if (cached === undefined) options.instanceSizeDirty.add(key)
      const size =
        cached === undefined
          ? typeof profile.size === 'string' && profile.size
            ? profile.size
            : '0 B'
          : options.formatSize(cached) || '0 B'
      return { ...profile, folderName, size }
    })
    options.writeProfilesSync(rootPath, enriched)
    await options.syncCoreInstances(enriched)
    options.scheduleInstanceSizeRefresh(rootPath)
    return true
  })

  // A rename touches three places that must agree: the profile list, the folder
  // on disk and the core register. All of it happens here instead of in each
  // handler.
  async function commitInstanceRename(payload: Record<string, unknown>) {
    const { oldFolderName, newName } = payload
    const rootPath = options.gameRoot()
    const registry = profileRegistry(rootPath)
    if (!existsSync(registry.file)) {
      return { success: false, error: 'Profiles file not found' }
    }

    let currentFolder = ''
    let newFolder = ''
    let newDir = ''
    let failure = ''
    let failureCode = ''
    let movedFrom = ''
    let movedTo = ''

    let profiles: LegacyProfile[]
    try {
      profiles = registry.update((list) => {
        const idx = list.findIndex(
          (profile) =>
            profileFolderOf(profile).toLowerCase() === String(oldFolderName || '').toLowerCase(),
        )
        if (idx === -1) return { result: list }
        currentFolder = profileFolderOf(list[idx])
        // Never fail on a name that already exists: reserve the next free folder.
        const folderName = options.uniqueProfileFolder(
          rootPath,
          profileFolderSlug(newName),
          list,
          currentFolder,
        )
        const oldDir = options.profileDirOrNull(rootPath, currentFolder)
        const targetDir = options.profileDirOrNull(rootPath, folderName)
        if (!oldDir || !targetDir) {
          failure = 'Ungültiger Instanzordner'
          failureCode = 'invalid-folder'
          return { result: list }
        }
        if (folderName !== currentFolder && existsSync(oldDir)) {
          if (existsSync(targetDir)) {
            failure = 'Folder name already exists'
            failureCode = 'folder-exists'
            return { result: list }
          }
          renameSync(oldDir, targetDir)
          movedFrom = oldDir
          movedTo = targetDir
        }
        newFolder = folderName
        newDir = targetDir
        const next = list.slice()
        next[idx] = { ...next[idx], name: newName, folderName }
        return { next, result: next }
      })
    } catch (error) {
      // The list was not replaced: put the folder back, so profiles.json, the
      // disk and the launch key still name the same folder.
      if (movedFrom) {
        try {
          renameSync(movedTo, movedFrom)
        } catch (rollbackError) {
          logger.error('rename-instance: folder rollback failed', {
            folderName: newFolder,
            error: (rollbackError as Error).message,
          })
        }
      }
      throw error
    }

    if (!currentFolder) return { success: false, error: 'Instance not found', code: 'not-found' }
    if (failure) {
      return { success: false, error: failure, ...(failureCode ? { code: failureCode } : {}) }
    }

    // Runtime keys move only once the list is on disk.
    if (newFolder && newFolder !== currentFolder) {
      options.launches.rename(currentFolder, newFolder)
      const oldSizeKey = currentFolder.toLowerCase()
      const newSizeKey = newFolder.toLowerCase()
      const cachedSize = options.instanceSizeCache.get(oldSizeKey)
      if (cachedSize !== undefined) options.instanceSizeCache.set(newSizeKey, cachedSize)
      options.instanceSizeCache.delete(oldSizeKey)
      options.instanceSizeDirty.delete(oldSizeKey)
    }

    // Second register: without this the core keeps pointing at the old folder.
    if (!(await options.renameCoreInstance(currentFolder, newFolder, newDir))) {
      logger.error('rename-instance: core still points at the old folder', {
        oldFolderName: currentFolder,
        newFolderName: newFolder,
      })
    }
    return { success: true, newFolderName: newFolder, profiles }
  }

  ipc.handle('rename-instance', async (_event, payload) => {
    const data = (payload ?? {}) as Record<string, unknown>
    try {
      return await commitInstanceRename(data)
    } catch (error) {
      logger.error('rename-instance failed', {
        oldFolderName: data.oldFolderName,
        error: (error as Error).message,
      })
      return { success: false, error: (error as Error).message }
    }
  })

  ipc.handle('clone-instance', async (_event, payload) => {
    const { folderName, newName } = (payload ?? {}) as Record<string, unknown>
    const rootPath = options.gameRoot()
    try {
      let clone: LegacyProfile | null = null
      let sourceName = ''
      profileRegistry(rootPath).update((profiles) => {
        const sourceIndex = profiles.findIndex(
          (profile) =>
            profileFolderOf(profile).toLowerCase() === String(folderName || '').toLowerCase(),
        )
        if (sourceIndex === -1) return { result: null }
        const sourceProfile = profiles[sourceIndex]
        sourceName = String(sourceProfile.name || '')
        const name = options.uniqueProfileName(
          profiles,
          String(newName || `${sourceProfile.name || 'Instanz'} (Kopie)`),
        )
        const cloneFolder = options.uniqueProfileFolder(
          rootPath,
          profileFolderSlug(name),
          profiles,
        )
        const sourceDir = join(rootPath, 'profiles', profileFolderOf(sourceProfile))
        const targetDir = join(rootPath, 'profiles', cloneFolder)
        if (existsSync(sourceDir)) {
          cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true })
        } else {
          mkdirSync(targetDir, { recursive: true })
        }
        clone = {
          ...sourceProfile,
          id: randomUUID(),
          name,
          folderName: cloneFolder,
          playTimeMs: 0,
          sessionCount: 0,
          lastPlayedAt: 0,
          lastPlayed: '',
          createdAt: Date.now(),
        }
        return { next: [...profiles, clone], result: clone }
      })
      if (!clone) return { success: false, error: 'Instance not found', code: 'not-found' }
      await options.upsertCoreInstance(clone)
      logger.info('instance cloned', {
        from: sourceName,
        to: (clone as LegacyProfile).name,
        folderName: (clone as LegacyProfile).folderName,
      })
      return { success: true, profile: clone }
    } catch (error) {
      logger.error('clone-instance failed', {
        folderName,
        error: (error as Error).message,
      })
      return { success: false, error: (error as Error).message }
    }
  })
}
