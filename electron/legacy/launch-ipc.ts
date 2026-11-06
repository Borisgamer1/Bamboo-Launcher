import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchLegacyInstance, type LegacyLaunchCore } from '../launch/legacy'
import type { LaunchHandle } from '../launch/types'
import type { InstanceLoader } from '../schemas'
import type { Logger } from '../logger'
import { installLoaderViaCore as installLoaderCore } from './loader-install'

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: never[]) => unknown): void
  on(channel: string, listener: (event: IpcEvent, ...args: never[]) => void): void
}

interface IpcEvent {
  reply(channel: string, payload: unknown): void
}

interface LaunchCore extends LegacyLaunchCore {
  loaders: {
    install(
      loader: string,
      options: Record<string, unknown>,
    ): Promise<{ versionId?: string; loaderVersion?: string }>
  }
}

type LaunchValue = string | (LaunchHandle & { launchId?: string })

interface LaunchArgs {
  folderName?: string
  profileName?: string
  version?: string
  modLoader?: string
  loaderVersion?: string
  javaPath?: string
  gameOptions?: Record<string, unknown>
}

export interface LaunchIpcOptions {
  logger: Logger
  resolveGameRoot(): Promise<string>
  profileDirOrNull(rootPath: string, folderName: unknown): string | null
  getCore(): Promise<LaunchCore | null>
  writeFirstRunOptions(directory: string, options: unknown): { created: boolean; path: string }
  applyLauncherGameOptions(directory: string, options: unknown): string[]
  updatePresence(status: string, profileName?: string, extraText?: string): void
  maxConcurrent?: number
}

export interface ActiveLaunches {
  has(folderName: string): boolean
  rename(oldFolderName: string, newFolderName: string): void
}

/** Play-button surface: one handler owns the launch lifecycle and its registry. */
export function registerLaunchIpc(ipc: IpcRegistrar, options: LaunchIpcOptions): ActiveLaunches {
  const logger = options.logger
  const maxConcurrent = options.maxConcurrent ?? 4
  const launches = new Map<string, LaunchValue>()
  let launchCounter = 0

  ipc.on('launch-game', async (event, payload) => {
    const {
      folderName,
      profileName,
      version,
      modLoader,
      loaderVersion: rawLoaderVersion,
      javaPath: profileJavaPath,
      gameOptions,
    } = (payload ?? {}) as LaunchArgs
    let normalizedLoader = String(modLoader || 'vanilla').toLowerCase()
    let loaderVersion = String(rawLoaderVersion || '')
    const emitLaunchFailed = (message: string, code?: string) =>
      event.reply('launch-failed', { folderName, profileName, message, code })
    // One timestamp per launch: a remounted card resumes the same curve instead
    // of starting over, and the synthetic display never runs backwards.
    const launchStartedAt = Date.now()
    const emitLaunchProgress = (percent: number, label: string) => {
      try {
        event.reply('launch-progress', {
          folderName,
          profileName,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          label: String(label || ''),
          startedAt: launchStartedAt,
        })
      } catch (error) {
        logger.debug('launch-game: progress could not be sent', { error: (error as Error).message })
      }
    }

    if (launches.size >= maxConcurrent) {
      event.reply('launch-status', 'Es läuft bereits die maximale Anzahl an Minecraft-Instanzen (4).')
      emitLaunchFailed('Es läuft bereits die maximale Anzahl an Minecraft-Instanzen (4).', 'max-launches')
      return
    }
    if (!folderName || launches.has(folderName)) {
      event.reply('launch-status', `"${profileName}" wird bereits gestartet oder läuft bereits.`)
      emitLaunchFailed(`"${profileName}" wird bereits gestartet oder läuft bereits.`, 'already-running')
      return
    }
    launchCounter++
    const launchId = profileName + '-' + Date.now() + '-' + launchCounter
    launches.set(folderName, launchId)

    logger.info('launch-game: starting', { profileName, folderName, loader: normalizedLoader, version })
    const rootPath = await options.resolveGameRoot()
    const legacyDirectory = options.profileDirOrNull(rootPath, folderName)
    if (!legacyDirectory) {
      launches.delete(folderName)
      emitLaunchFailed('Ungültiger Instanzordner.', 'invalid-folder')
      return
    }
    const packDependencies = (() => {
      try {
        const indexFile = join(legacyDirectory, 'modrinth.index.json')
        if (!existsSync(indexFile)) return {}
        const parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
        return parsed && typeof parsed.dependencies === 'object' && parsed.dependencies ? parsed.dependencies : {}
      } catch (error) {
        logger.debug('launch-game: modpack index unreadable', { folderName, error: (error as Error).message })
        return {}
      }
    })() as Record<string, unknown>
    const packLoader = [
      ['fabric-loader', 'fabric'],
      ['quilt-loader', 'quilt'],
      ['neoforge', 'neoforge'],
      ['forge', 'forge'],
    ].find(([key]) => typeof packDependencies[key] === 'string' && packDependencies[key])
    if (packLoader) {
      // The installed .mrpack is the source of truth. This also repairs profiles
      // whose visible loader label was wrong (e.g. a Quilt pack saved as Fabric).
      normalizedLoader = packLoader[1]
      loaderVersion = String(packDependencies[packLoader[0]] || '')
    }
    const launchVersion = String(packDependencies.minecraft || version || '')
    logger.info('launch-game: resolved pack', {
      folderName,
      loader: normalizedLoader,
      loaderVersion,
      version: launchVersion,
    })
    emitLaunchProgress(3, 'Start wird vorbereitet…')

    const prepareLaunchTarget = async ({ directory }: { directory: string }) => {
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true })

      // Cosmetics live in `<instance>/bamboo/cosmetics`; the game reads that
      // folder itself, so the launch path has nothing to rewrite.
      const seeded = options.writeFirstRunOptions(directory, gameOptions)
      if (seeded.created) {
        logger.debug('launch-game: options.txt seeded', { path: seeded.path })
      } else {
        const applied = options.applyLauncherGameOptions(directory, gameOptions)
        if (applied.length > 0) logger.debug('launch-game: options.txt merged', { applied })
      }
    }

    event.reply('launch-status', 'Starte Minecraft...')
    setImmediate(async () => {
      let finalVersionId = launchVersion
      let gameReadySent = false

      try {
        event.reply('launch-status', 'Profil wird vorbereitet...')
        emitLaunchProgress(8, 'Profil wird vorbereitet…')

        if (normalizedLoader !== 'vanilla') {
          const loaderLabel = loaderVersion ? `${normalizedLoader} ${loaderVersion}` : `Neueste ${normalizedLoader}-Version`
          event.reply('launch-status', `${loaderLabel} wird vorbereitet...`)
          emitLaunchProgress(15, `${loaderLabel} wird vorbereitet…`)
          const loaderPercent: Record<string, number> = { metadata: 20, base: 28, installer: 38, profile: 46, inputs: 52, processors: 58, done: 62 }
          const loaderResult = await installLoaderCore(
            options.getCore,
            normalizedLoader,
            launchVersion,
            loaderVersion,
            (progress) => {
              event.reply('launch-status', progress.message)
              emitLaunchProgress(loaderPercent[progress.phase || ''] || 30, String(progress.message || ''))
            },
          )
          finalVersionId = loaderResult.versionId
          if (loaderResult.loaderVersion) loaderVersion = loaderResult.loaderVersion
        }

        const core = await options.getCore()
        if (!core) throw new Error('Launcher-Core (dist-electron) nicht verfügbar')
        emitLaunchProgress(66, 'Startdateien werden geprüft…')

        const server = gameOptions && gameOptions.joinServer
          ? { host: String(gameOptions.joinServer), port: Number(gameOptions.joinPort) || 25565 }
          : undefined

        options.updatePresence('starting', profileName)
        event.reply('launch-status', 'Minecraft wird gestartet...')
        emitLaunchProgress(80, 'Minecraft wird gestartet…')
        const activeHandle: LaunchHandle & { launchId?: string } = await launchLegacyInstance(core, {
          folderName: String(folderName),
          directory: legacyDirectory,
          name: String(profileName || ''),
          minecraftVersion: launchVersion,
          versionId: finalVersionId,
          loader: normalizedLoader as InstanceLoader,
          loaderVersion: String(loaderVersion || ''),
          // Always send the choice: an empty string means automatic and must be
          // able to replace a stale migrated javaPath.
          javaPath: String(profileJavaPath || ''),
          ...(server ? { server } : {}),
        }, (launchEvent) => {
          if (launchEvent.type === 'status') {
            event.reply('launch-status', launchEvent.message)
            emitLaunchProgress(88, String(launchEvent.message || ''))
          } else if (launchEvent.type === 'ready') {
            if (!gameReadySent) {
              gameReadySent = true
              emitLaunchProgress(100, 'Minecraft ist bereit')
              event.reply('game-ready', profileName)
              const inGameText = `${launchVersion}${normalizedLoader !== 'vanilla' ? ` - ${normalizedLoader}` : ''}`
              options.updatePresence('inGame', profileName, inGameText)
            }
          } else if (launchEvent.type === 'crash-report') {
            event.reply('launch-status', `Crash-Report: ${launchEvent.path}`)
          } else if (launchEvent.type === 'exit') {
            launches.delete(String(folderName))
            options.updatePresence('back')
            event.reply('game-closed', { code: launchEvent.code, profileName, folderName })
          }
        }, { beforeLaunch: prepareLaunchTarget })
        launches.set(String(folderName), activeHandle)
        emitLaunchProgress(94, 'Minecraft lädt…')
        logger.debug('launch-game: start command', { command: activeHandle.plan.displayCommand.join(' ') })
      } catch (error) {
        launches.delete(String(folderName))
        // The presence was switched to "Starting" right before the spawn; without
        // this reset a failed launch leaves it there forever.
        options.updatePresence('back')
        logger.error('launch-game failed', { profileName, folderName, error: (error as Error).message })
        event.reply('launch-status', `Fehler: ${(error as Error).message}`)
        emitLaunchFailed((error as Error).message)
      }
    })
  })

  ipc.handle('get-active-launches', async () => {
    return Array.from(launches.keys())
  })

  ipc.handle('kill-game', async (_event, folderName) => {
    const entry = typeof folderName === 'string' ? launches.get(folderName) : undefined
    if (!entry || typeof entry === 'string' || entry.killed) return false
    await entry.kill()
    return true
  })

  return {
    has(folderName: string) {
      return launches.has(folderName)
    },
    rename(oldFolderName: string, newFolderName: string) {
      const entry = launches.get(oldFolderName)
      if (entry === undefined) return
      launches.delete(oldFolderName)
      launches.set(newFolderName, entry)
    },
  }
}
