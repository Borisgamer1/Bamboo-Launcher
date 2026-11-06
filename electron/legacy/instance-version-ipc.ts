import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { installVersion } from '../install/version'
import type { Logger } from '../logger'
import { profileFolderOf, profileRegistry } from '../instances/profile-registry'
import { sendBackgroundTaskProgress } from '../ipc-progress'

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void
}

interface IpcEvent {
  sender: { send(channel: string, payload: unknown): void }
}

interface CoreInstance {
  id: string
}

interface InstanceVersionCore {
  instanceManager: {
    findByFolder(folderName: string): Promise<{ instance: CoreInstance } | undefined>
    updateFile(id: string, values: Record<string, unknown>): Promise<unknown>
  }
}

export interface InstanceVersionIpcOptions {
  logger: Logger
  resolveGameRoot(): Promise<string>
  getCore(): Promise<InstanceVersionCore | null>
  /** Loader install is owned by the core; main injects its bridge. */
  installLoader(
    loader: string,
    minecraftVersion: string,
    loaderVersion: string,
    onProgress?: (progress: { phase?: string; message?: string }) => void,
  ): Promise<{ versionId: string; loaderVersion: string }>
}

function loaderDisplayName(loader: unknown): string {
  const map: Record<string, string> = {
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    quilt: 'Quilt',
    forge: 'Forge',
    neoforge: 'Neoforge',
  }
  return map[String(loader || '').toLowerCase()] || 'Vanilla'
}

/**
 * `modrinth.index.json` is the launch-time source of truth for modpacks: the
 * launch handler prefers its dependencies over the renderer's labels. A version
 * switch that only rewrites profiles.json would therefore keep starting the old
 * pack version.
 */
function updateModpackIndexDependencies(
  instanceDir: string,
  mcVersion: string,
  loader: string,
  loaderVersion: string,
  logger: Logger,
): boolean {
  const indexFile = join(instanceDir, 'modrinth.index.json')
  if (!existsSync(indexFile)) return false
  try {
    const index = JSON.parse(readFileSync(indexFile, 'utf8')) as Record<string, unknown>
    if (!index || typeof index !== 'object' || Array.isArray(index)) return false
    const current =
      index.dependencies && typeof index.dependencies === 'object'
        ? { ...(index.dependencies as Record<string, unknown>) }
        : {}
    delete current['fabric-loader']
    delete current['quilt-loader']
    delete current.forge
    delete current.neoforge
    current.minecraft = String(mcVersion)
    if (loader !== 'vanilla' && loaderVersion) {
      const key = loader === 'fabric' ? 'fabric-loader' : loader === 'quilt' ? 'quilt-loader' : loader
      current[key] = String(loaderVersion)
    }
    index.dependencies = current
    writeFileSync(indexFile, JSON.stringify(index, null, 2))
    return true
  } catch (error) {
    logger.warn('change-instance-version: modpack index not updated', {
      indexFile,
      error: (error as Error).message,
    })
    return false
  }
}

/**
 * Copied legacy profiles carry the source instance's `instance.json`, which can
 * still name the old Minecraft version and loader profile. The core store entry
 * for such a folder is only created on first launch, so a version switch must
 * also rewrite the file directly when no store record exists yet.
 */
function updateLegacyInstanceMetadata(
  instanceDir: string,
  values: { mcVersion: string; versionId: string; loader: string; loaderVersion: string },
  logger: Logger,
): boolean {
  const file = join(instanceDir, 'instance.json')
  if (!existsSync(file)) return false
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    parsed.version = String(values.mcVersion || '')
    parsed.versionId = String(values.versionId || '')
    parsed.loader = String(values.loader || 'vanilla')
    parsed.loaderVersion = String(values.loaderVersion || '')
    parsed.updatedAt = Date.now()
    writeFileSync(file, JSON.stringify(parsed, null, 2))
    return true
  } catch (error) {
    logger.warn('change-instance-version: legacy instance file not updated', {
      instanceDir,
      error: (error as Error).message,
    })
    return false
  }
}

/** Repairing a loader install and switching an instance version share the same steps. */
export function registerInstanceVersionIpc(
  ipc: IpcRegistrar,
  options: InstanceVersionIpcOptions,
): void {
  const logger = options.logger

  ipc.handle('repair-profile', async (event, payload) => {
    const { loader, loaderVersion, mcVersion, folderName } = (payload ?? {}) as {
      loader?: string
      loaderVersion?: string
      mcVersion?: string
      folderName?: string
    }
    const normalizedLoader = String(loader || '').toLowerCase()
    const taskId = folderName ? `repair:${folderName}` : ''

    const sendProgress = (msg: string, percent?: number) => {
      try {
        event.sender.send('repair-progress', msg)
        if (taskId) {
          sendBackgroundTaskProgress(event, {
            id: taskId,
            percent: typeof percent === 'number' ? percent : null,
            label: String(msg || ''),
          }, logger, 'repair-profile')
        }
      } catch (error) {
        logger.debug('repair-profile: progress could not be sent', { error: (error as Error).message })
      }
    }

    if (!mcVersion) return { success: false, error: 'Minecraft-Version fehlt', code: 'missing-version' }
    sendProgress('Starte Reparatur...', 2)

    if (normalizedLoader === 'vanilla') {
      const rootPath = await options.resolveGameRoot()
      await installVersion(rootPath, mcVersion, {
        cacheDir: join(rootPath, 'cache'),
        withAssets: true,
      })
    } else {
      await options.installLoader(normalizedLoader, mcVersion, loaderVersion ?? '', (progress) => {
        if (progress && progress.message) sendProgress(progress.message)
      })
    }

    sendProgress('Reparatur abgeschlossen!', 100)
    logger.info('profile repaired', {
      loader: normalizedLoader,
      loaderVersion: loaderVersion || '',
      mcVersion,
    })
    return { success: true }
  })

  ipc.handle('change-instance-version', async (event, payload) => {
    const { folderName, mcVersion, loader, loaderVersion } = (payload ?? {}) as {
      folderName?: string
      mcVersion?: string
      loader?: string
      loaderVersion?: string
    }
    const requestedFolder = basename(String(folderName || ''))
    if (!requestedFolder || requestedFolder !== String(folderName) || requestedFolder === '.' || requestedFolder === '..') {
      return { success: false, error: 'Ungültiger Instanzordner', code: 'invalid-folder' }
    }
    const normalizedLoader = String(loader || 'vanilla').toLowerCase()
    if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(normalizedLoader)) {
      return { success: false, error: 'Unbekannter Modloader', code: 'unknown-loader' }
    }
    const targetMc = String(mcVersion || '')
    if (!targetMc) return { success: false, error: 'Minecraft-Version fehlt', code: 'missing-version' }

    const taskId = `version-switch:${requestedFolder}`
    const emitProgress = (percent: number, label: string) => {
      sendBackgroundTaskProgress(event, {
        id: taskId,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        label: String(label || ''),
      }, logger, 'change-instance-version')
    }

    emitProgress(2, 'Zielversion wird vorbereitet…')
    let versionId = targetMc
    let installedLoaderVersion = ''

    try {
      const rootPath = await options.resolveGameRoot()
      if (normalizedLoader === 'vanilla') {
        await installVersion(rootPath, targetMc, {
          cacheDir: join(rootPath, 'cache'),
          withAssets: true,
        })
      } else {
        const result = await options.installLoader(
          normalizedLoader,
          targetMc,
          loaderVersion || '',
          (progress) => {
            const percentMap: Record<string, number> = {
              metadata: 8,
              base: 18,
              installer: 28,
              profile: 36,
              inputs: 40,
              processors: 44,
              done: 48,
            }
            emitProgress(percentMap[progress?.phase ?? ''] || 24, progress?.message || 'Loader wird installiert…')
          },
        )
        versionId = result.versionId || versionId
        installedLoaderVersion = result.loaderVersion || String(loaderVersion || '')
      }

      emitProgress(54, 'Instanzdaten werden aktualisiert…')

      const profileUpdated = profileRegistry(rootPath).update((profiles) => {
        let updated = false
        const next = profiles.map((profile) => {
          if (!profile || typeof profile !== 'object') return profile
          if (profileFolderOf(profile) !== requestedFolder) return profile
          updated = true
          return {
            ...profile,
            version: targetMc,
            loader: loaderDisplayName(normalizedLoader),
            loaderVersion: installedLoaderVersion,
          }
        })
        return { next: updated ? next : undefined, result: updated }
      })
      if (!profileUpdated) {
        logger.warn('change-instance-version: profile not found in profiles.json', {
          folderName: requestedFolder,
        })
      }

      // Keep the core instance file/index in sync even when the visible instance
      // list lives in the legacy profiles.json.
      const instanceDir = join(rootPath, 'profiles', requestedFolder)
      try {
        const core = await options.getCore()
        const found = core ? await core.instanceManager.findByFolder(requestedFolder) : undefined
        if (core && found) {
          await core.instanceManager.updateFile(found.instance.id, {
            version: targetMc,
            versionId,
            loader: normalizedLoader,
            loaderVersion: installedLoaderVersion,
          })
        } else {
          updateLegacyInstanceMetadata(
            instanceDir,
            {
              mcVersion: targetMc,
              versionId,
              loader: normalizedLoader,
              loaderVersion: installedLoaderVersion,
            },
            logger,
          )
        }
      } catch (error) {
        logger.warn('change-instance-version: core instance file not updated', {
          folderName: requestedFolder,
          error: (error as Error).message,
        })
      }

      updateModpackIndexDependencies(
        instanceDir,
        targetMc,
        normalizedLoader,
        installedLoaderVersion,
        logger,
      )

      emitProgress(100, 'Version gewechselt')
      logger.info('instance version changed', {
        folderName: requestedFolder,
        mcVersion: targetMc,
        loader: normalizedLoader,
        loaderVersion: installedLoaderVersion,
        versionId,
      })
      return {
        success: true,
        mcVersion: targetMc,
        loader: normalizedLoader,
        loaderVersion: installedLoaderVersion,
        versionId,
      }
    } catch (error) {
      logger.error('change-instance-version failed', {
        folderName: requestedFolder,
        error: (error as Error).message,
      })
      return { success: false, error: (error as Error).message }
    }
  })
}
