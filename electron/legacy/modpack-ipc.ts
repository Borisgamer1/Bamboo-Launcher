import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { Logger } from '../logger'

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void
}

interface IpcEvent {
  sender: { send(channel: string, payload: unknown): void }
}

interface InstallerProgress {
  phase?: string
  done?: number
  total?: number
  file?: string
}

interface InstallerResult {
  installed: unknown[]
  updated: unknown[]
}

export interface ModpackIpcOptions {
  logger: Logger
  gameRoot(): string
  readProfiles(rootPath: string): unknown[]
  uniqueProfileFolder(rootPath: string, folderName: string, profiles: unknown[]): string
  installLoader(
    loader: string,
    mcVersion: string,
    loaderVersion: string,
    onProgress: (progress: { phase?: string; message?: string }) => void,
  ): Promise<{ versionId: string; loaderVersion: string }>
  markInstanceSizeDirty(folderName: string): void
}

/** Every `overrides/` + `client-overrides/` file must exist after install. */
function verifyOverrideFiles(
  archivePath: string,
  instanceDir: string,
): { checked: number; missing: string[]; present: string[] } {
  const zip = new AdmZip(archivePath)
  const prefixes = ['overrides/', 'client-overrides/']
  const root = resolve(instanceDir)
  const missing: string[] = []
  const present: string[] = []
  let checked = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const normalized = String(entry.entryName || '').replace(/\\/g, '/')
    const prefix = prefixes.find((candidate) => normalized.startsWith(candidate))
    if (!prefix) continue
    const relative = normalized.slice(prefix.length)
    if (!relative) continue
    checked += 1
    const target = resolve(root, relative)
    if (!target.startsWith(root + sep) || !existsSync(target)) missing.push(relative)
    else present.push(relative)
  }
  return { checked, missing, present }
}

export function registerModpackIpc(ipc: IpcRegistrar, options: ModpackIpcOptions): void {
  const logger = options.logger

  ipc.handle(
    'install-modpack-mrpack',
    async (event, rawPayload) => {
      const { folderName, mcVersion, loader, mrpackUrl, mode = 'install' } = (rawPayload ?? {}) as {
        folderName?: string
        mcVersion?: string
        loader?: string
        mrpackUrl?: string
        mode?: string
      }
      const emitProgress = (percent: number, label: string): void => {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)))
        const message = String(label || '')
        try {
          event.sender.send('modpack-install-progress', {
            folderName,
            percent: clamped,
            label: message,
          })
          // Same operation, second consumer: the footer bar is mounted in App and
          // therefore keeps its progress when the mod browser is left behind.
          event.sender.send('background-task-progress', {
            id: `modpack:${folderName}`,
            percent: clamped,
            label: message,
          })
        } catch (error) {
          logger.debug('install-modpack: progress could not be sent', {
            error: (error as Error).message,
          })
        }
      }
      const rootPath = options.gameRoot()
      const requestedFolder = basename(String(folderName || ''))
      if (
        !requestedFolder ||
        requestedFolder !== String(folderName) ||
        requestedFolder === '.' ||
        requestedFolder === '..'
      ) {
        return { success: false, error: 'Ungültiger Instanzordner', code: 'invalid-folder' }
      }
      // `update` targets the existing folder; `install` must never reuse another
      // instance's directory even when the display name is identical.
      const profileFolder =
        mode === 'update'
          ? requestedFolder
          : options.uniqueProfileFolder(rootPath, requestedFolder, options.readProfiles(rootPath))
      const gameDir = join(rootPath, 'profiles', profileFolder)
      if (!existsSync(gameDir)) mkdirSync(gameDir, { recursive: true })
      const tempDir = join(rootPath, 'cache', 'mrpack-tmp-' + Date.now())
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true })
      let usedTar = false
      try {
        emitProgress(2, 'Modpack wird vorbereitet…')
        const mrpackPath = join(tempDir, 'modpack.mrpack')
        logger.debug('install-modpack: downloading mrpack', { folderName, mcVersion, loader })
        const res = await fetch(String(mrpackUrl))
        if (!res.ok) throw new Error('mrpack download fehlgeschlagen ' + res.status)
        const buf = await res.arrayBuffer()
        writeFileSync(mrpackPath, Buffer.from(buf))
        emitProgress(8, 'Modpack wird entpackt…')
        const extractDir = join(tempDir, 'extracted')
        if (!existsSync(extractDir)) mkdirSync(extractDir, { recursive: true })
        try {
          // adm-zip ships no complete typings; only these calls are used.
          const zip = new AdmZip(mrpackPath) as unknown as {
            extractAllTo(target: string, overwrite: boolean): void
          }
          zip.extractAllTo(extractDir, true)
        } catch (admError) {
          try {
            const { extractMrpackWithTar } = await import('../mods/tar.js')
            await extractMrpackWithTar(mrpackPath, extractDir)
            usedTar = true
            logger.debug('install-modpack: used tar fallback', {
              error: (admError as Error).message,
            })
          } catch (tarError) {
            logger.error('install-modpack: extraction failed', {
              admError: (admError as Error).message,
              tarError: (tarError as Error).message,
            })
            throw new Error(`mrpack konnte nicht entpackt werden: ${(tarError as Error).message}`, {
              cause: tarError,
            })
          }
        }
        const indexJson = join(extractDir, 'modrinth.index.json')
        if (!existsSync(indexJson)) throw new Error('modrinth.index.json nicht gefunden')
        const index = JSON.parse(readFileSync(indexJson, 'utf8'))
        const files = Array.isArray(index.files) ? index.files : []
        const dependencies = index.dependencies || {}
        const loaderDependencies: Array<[string, string]> = [
          ['fabric-loader', 'fabric'],
          ['quilt-loader', 'quilt'],
          ['neoforge', 'neoforge'],
          ['forge', 'forge'],
        ]
        const dependencyEntry = loaderDependencies.find(
          ([key]) => typeof dependencies[key] === 'string' && dependencies[key],
        )
        const packLoader = dependencyEntry ? dependencyEntry[1] : String(loader || '').toLowerCase()
        const normLoader = ['fabric', 'quilt', 'forge', 'neoforge'].includes(packLoader)
          ? packLoader
          : 'vanilla'
        const packMcVersion = String(dependencies.minecraft || mcVersion || '')
        const requestedLoaderVersion = dependencyEntry
          ? String(dependencies[dependencyEntry[0]] || '')
          : ''
        const downloadable = files.filter((file: { env?: { client?: string }; downloads?: string[] }) => {
          const envClient = file.env?.client || 'required'
          return envClient !== 'unsupported' && Boolean(file.downloads?.[0])
        })
        emitProgress(13, 'Modpack-Dateien werden übernommen…')

        let archiveForInstall = mrpackPath
        if (usedTar) {
          const repacked = join(tempDir, 'repacked.mrpack')
          const repack = new AdmZip() as unknown as {
            addLocalFolder(dir: string): void
            writeZip(target: string): void
          }
          repack.addLocalFolder(extractDir)
          repack.writeZip(repacked)
          archiveForInstall = repacked
        }

        // The core installer is the single owner of hash checks, override order,
        // stale-file cleanup and the modpack lock. The legacy handler used to
        // reimplement all four and could leave a pack that installs but cannot run.
        const { installModpack } = await import('../mods/index.js')
        const installResult = (await installModpack({
          instanceDir: gameDir,
          archivePath: archiveForInstall,
          ...(packMcVersion ? { minecraftVersion: packMcVersion } : {}),
          onProgress: (progress: InstallerProgress) => {
            const total = Math.max(1, Number(progress.total) || downloadable.length || 1)
            const done = Math.min(Number(progress.done) || 0, total)
            if (progress.phase === 'files') {
              emitProgress(
                16 + Math.round((done / total) * 54),
                `Lade ${Math.min(done + 1, total)}/${total}: ${String(progress.file || '').split('/').pop()}`,
              )
            } else if (progress.phase === 'overrides') {
              emitProgress(
                70 + Math.round((done / total) * 8),
                `Override ${Math.min(done + 1, total)}/${total}: ${String(progress.file || '').split('/').pop()}`,
              )
            }
          },
        })) as InstallerResult

        // Overrides are the pack author's own files (configs, resource packs, UI
        // data). Verify each one actually landed instead of trusting the archive.
        const overrideCheck = verifyOverrideFiles(archiveForInstall, gameDir)
        if (overrideCheck.missing.length > 0) {
          throw new Error(
            `${overrideCheck.missing.length} von ${overrideCheck.checked} Override-Dateien fehlen nach der Installation ` +
              `(z. B. ${overrideCheck.missing.slice(0, 3).join(', ')})`,
          )
        }
        logger.info('install-modpack: overrides verified', {
          folderName,
          profileFolder,
          checked: overrideCheck.checked,
        })
        emitProgress(78, 'Loader wird eingerichtet…')
        const modCount = installResult.installed.length + installResult.updated.length

        let loaderInstalled = false
        let loaderError = ''
        let installedLoaderVersion = ''
        let installedVersionId = ''
        try {
          if (normLoader !== 'vanilla' && packMcVersion) {
            emitProgress(82, `Lade ${normLoader} ${requestedLoaderVersion || ''}…`)
            const loaderPercent: Record<string, number> = {
              metadata: 84,
              base: 86,
              installer: 88,
              profile: 90,
              inputs: 92,
              processors: 94,
              done: 96,
            }
            logger.info('install-modpack: installing loader', {
              loader: normLoader,
              mcVersion: packMcVersion,
              requestedLoaderVersion,
            })
            const loaderResult = await options.installLoader(
              normLoader,
              packMcVersion,
              requestedLoaderVersion,
              (progress) => emitProgress(loaderPercent[progress.phase || ''] || 88, progress.message || ''),
            )
            installedLoaderVersion = loaderResult.loaderVersion
            installedVersionId = loaderResult.versionId
            loaderInstalled = true
            logger.info('install-modpack: loader installed', {
              loader: normLoader,
              mcVersion: packMcVersion,
              installedLoaderVersion,
              installedVersionId,
            })
          }
        } catch (e) {
          loaderError = (e as Error).message
          logger.warn('install-modpack: loader installation failed', { error: (e as Error).message })
        }
        if (loaderError) {
          return {
            success: false,
            error: `Loader-Installation fehlgeschlagen: ${loaderError}`,
            code: 'loader-install-failed',
            modCount,
            index,
            loaderInstalled,
          }
        }
        emitProgress(100, 'Modpack fertig')
        options.markInstanceSizeDirty(profileFolder)
        return {
          success: true,
          modCount,
          index,
          loaderInstalled,
          loader: normLoader,
          mcVersion: packMcVersion,
          loaderVersion: installedLoaderVersion,
          versionId: installedVersionId,
          folderName: profileFolder,
          overrideFiles: overrideCheck.present,
        }
      } catch (err) {
        logger.error('install-modpack failed', { error: (err as Error).message })
        return { success: false, error: (err as Error).message, code: 'modpack-failed' }
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch (error) {
          logger.debug('install-modpack: temp cleanup failed', { error: (error as Error).message })
        }
      }
    },
  )
}
