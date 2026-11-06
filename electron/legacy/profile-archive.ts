import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { Logger } from '../logger'
import { sendBackgroundTaskProgress } from '../ipc-progress'

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void
}

interface IpcEvent {
  sender: { send(channel: string, payload: unknown): void }
}

interface ArchiveBridge {
  exportLegacyProfile?(payload: Record<string, unknown>): Promise<unknown>
  previewLegacyProfile?(filePath: string, options: { curseforgeApiKey: string }): Promise<unknown>
  importLegacyProfile?(
    payload: Record<string, unknown>,
    options: {
      curseforgeApiKey: string
      onBackgroundTask: (progress: unknown) => void
    },
  ): Promise<unknown>
}

interface ArchiveManifest {
  instance?: {
    name?: string
    minecraftVersion?: string
    modloader?: string
    modloaderVersion?: string
    description?: string
  }
  contents?: { icon?: string }
}

export interface ProfileArchiveIpcOptions {
  logger: Logger
  gameRoot(): string
  profileDirOrNull(rootPath: string, folderName: string): string | null
  readApiKey(): string
  getBridge(): ArchiveBridge | null
}

/** Zip export plus the two import handlers; .mrpack export stays in the bridge. */
export function registerProfileArchiveIpc(
  ipc: IpcRegistrar,
  options: ProfileArchiveIpcOptions,
): void {
  const logger = options.logger

  ipc.handle('export-profile', async (_event, rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>
    const rootPath = options.gameRoot()
    const format = payload.format
    const instanceName = payload.instanceName as string | undefined
    const folderName = payload.folderName as string | undefined
    const manifest = payload.manifest as ArchiveManifest | undefined
    const selectedContent = (payload.options ?? {}) as Record<string, boolean>
    const suggestedFileName = payload.suggestedFileName as string | undefined
    const savePath = payload.savePath as string | undefined

    if (format === 'mrpack') {
      // One implementation: the core writes the mrpack. Falling through to a
      // zip branch here would ship a second, unchecked pack writer.
      const bridge = options.getBridge()
      if (!bridge || typeof bridge.exportLegacyProfile !== 'function') {
        return { success: false, error: 'Modpack-Export nicht verfügbar (Core fehlt).', code: 'export-unavailable' }
      }
      return bridge.exportLegacyProfile(payload)
    }

    if (!manifest || !folderName) {
      return { success: false, error: 'Ungültige Exportdaten: Manifest oder Ordnername fehlt', code: 'export-invalid' }
    }

    const tmpDir = join(rootPath, 'cache', `export-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

      const gameDir = options.profileDirOrNull(rootPath, folderName)
      if (!gameDir) return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }

      const gameDirExists = existsSync(gameDir)
      logger.debug('export-profile: collecting', { gameDir, gameDirExists, format, folderName })

      let collectedAnything = false
      const collectedTypes: string[] = []

      const collectDir = (srcSubDir: string, destSubDir: string): boolean => {
        const src = join(gameDir, srcSubDir)
        if (!existsSync(src) || !statSync(src).isDirectory()) return false
        if (readdirSync(src).length === 0) return false
        // Configs and worlds are trees, not flat folders. Copying only the files
        // directly below the source silently dropped every world and nested config.
        const destination = join(tmpDir, destSubDir)
        mkdirSync(join(tmpDir), { recursive: true })
        cpSync(src, destination, { recursive: true })
        return true
      }

      const include = (key: string): boolean => selectedContent[key] !== false
      if (include('includeMods') && collectDir('mods', 'mods')) { collectedAnything = true; collectedTypes.push('mods') }
      if (include('includeResourcepacks') && collectDir('resourcepacks', 'resourcepacks')) { collectedAnything = true; collectedTypes.push('resourcepacks') }
      if (include('includeShaderpacks') && collectDir('shaderpacks', 'shaderpacks')) { collectedAnything = true; collectedTypes.push('shaderpacks') }
      if (include('includeDatapacks') && collectDir('datapacks', 'datapacks')) { collectedAnything = true; collectedTypes.push('datapacks') }
      if (include('includeConfig') && collectDir('config', 'config')) { collectedAnything = true; collectedTypes.push('config') }
      if (include('includeScreenshots') && collectDir('screenshots', 'screenshots')) { collectedAnything = true; collectedTypes.push('screenshots') }
      if (include('includeWorlds') && collectDir('saves', 'worlds')) { collectedAnything = true; collectedTypes.push('worlds') }

      logger.debug('export-profile: content collected', { types: collectedTypes, total: collectedTypes.length })

      if (!collectedAnything && gameDirExists) {
        logger.warn('export-profile: profile folder has no content directories', { gameDir })
      }
      if (!gameDirExists) {
        logger.warn('export-profile: profile folder missing; creating it', { gameDir })
        mkdirSync(gameDir, { recursive: true })
      }

      const iconData = manifest.contents?.icon
      if (typeof iconData === 'string') {
        try {
          if (iconData.startsWith('data:image/')) {
            const b64 = iconData.split(',')[1]
            if (b64) writeFileSync(join(tmpDir, 'icon.png'), Buffer.from(b64, 'base64'))
          }
        } catch (error) {
          logger.debug('export-profile: icon could not be written', { error: (error as Error).message })
        }
      }

      // adm-zip ships no complete typings; the writer needs only these two calls.
      const zip = new AdmZip() as unknown as { addLocalFolder(dir: string): void; toBuffer(): Buffer }
      zip.addLocalFolder(tmpDir)

      const fileName =
        suggestedFileName ||
        `${(instanceName || 'export').replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`
      const exportPath = savePath || join(rootPath, 'cache', fileName)
      writeFileSync(exportPath, zip.toBuffer())

      rmSync(tmpDir, { recursive: true, force: true })
      const stats = statSync(exportPath)

      return {
        success: true,
        filePath: exportPath,
        fileName,
        fileSize: stats.size,
      }
    } catch (error) {
      logger.error('export-profile failed', { folderName, format, error: (error as Error).message })
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
      return { success: false, error: (error as Error).message }
    }
  })

  ipc.handle('import-preview', async (_event, rawPath) => {
    const bridge = options.getBridge()
    if (!bridge || typeof bridge.previewLegacyProfile !== 'function') {
      return { error: 'Import-Kern nicht verfügbar', code: 'import-unavailable' }
    }
    try {
      return await bridge.previewLegacyProfile(String(rawPath ?? ''), {
        curseforgeApiKey: options.readApiKey(),
      })
    } catch (error) {
      logger.error('profile archive could not be read', { error: (error as Error).message })
      return {
        error: `Fehler beim Lesen der Datei: ${(error as Error).message}`,
        code: 'import-read-failed',
      }
    }
  })

  ipc.handle('import-profile', async (event, rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>
    const bridge = options.getBridge()
    if (!bridge || typeof bridge.importLegacyProfile !== 'function') {
      return { success: false, error: 'Import-Kern nicht verfügbar', code: 'import-unavailable' }
    }
    try {
      return await bridge.importLegacyProfile(payload, {
        curseforgeApiKey: options.readApiKey(),
        onBackgroundTask: (progress) => sendBackgroundTaskProgress(event, progress, logger, 'import-profile'),
      })
    } catch (error) {
      logger.error('import-profile failed', { error: (error as Error).message })
      return { success: false, error: (error as Error).message, code: 'import-failed' }
    }
  })
}
