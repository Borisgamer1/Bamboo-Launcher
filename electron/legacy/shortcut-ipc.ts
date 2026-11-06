import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pngToIco, shortcutCoverPlan, shortcutIconFileName } from '../shared/shortcutIcon'
import type { Logger } from '../logger'

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: never[]) => unknown): void
}

interface Profile {
  name?: unknown
  thumbnail?: unknown
  icon?: unknown
}

interface ShortcutApp {
  getPath(name: 'desktop' | 'userData'): string
  getAppPath(): string
  isPackaged: boolean
  execPath: string
}

interface ShortcutShell {
  writeShortcutLink(
    path: string,
    operation: 'create' | 'update',
    options: Record<string, unknown>,
  ): boolean
}

interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  crop(rect: { x: number; y: number; width: number; height: number }): NativeImageLike
  resize(options: { width: number; height: number; quality: string }): { toPNG(): Buffer }
}

interface NativeImageFactory {
  createFromDataURL(value: string): NativeImageLike
  createFromBuffer(buffer: Buffer): NativeImageLike
  createFromPath(filePath: string): NativeImageLike
  createEmpty(): NativeImageLike
}

export interface ShortcutIpcOptions {
  gameRoot(): string
  readProfiles(rootPath: string): Profile[]
  profileFolderOf(profile: Profile): string
  logger: Logger
  shell: ShortcutShell
  nativeImage: NativeImageFactory
  app: ShortcutApp
  platform: NodeJS.Platform
}

function resolveBundledInstanceCover(file: string, app: ShortcutApp): string {
  const roots = [
    join(app.getAppPath(), 'dist'),
    join(app.getAppPath(), 'public'),
    join(__dirname, '..', '..', 'dist'),
    join(__dirname, '..', '..', 'public'),
  ]
  for (const root of roots) {
    const candidate = join(root, 'instance-covers', file)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** Windows shortcuts need an .ico; the instance cover becomes a 256 px PNG icon. */
function createShortcutIcon(
  profile: Profile,
  folderName: string,
  options: ShortcutIpcOptions,
): string {
  const { app, logger, nativeImage } = options
  const coverImage = (value: unknown): NativeImageLike => {
    const source = shortcutCoverPlan(value)
    try {
      if (source.kind === 'data-url') return nativeImage.createFromDataURL(source.value)
      if (source.kind === 'bundled') {
        const file = resolveBundledInstanceCover(source.file, app)
        // Read through fs so the image also loads when the app runs from an asar.
        return file ? nativeImage.createFromBuffer(readFileSync(file)) : nativeImage.createEmpty()
      }
      if (source.kind === 'file') {
        return existsSync(source.path) ? nativeImage.createFromPath(source.path) : nativeImage.createEmpty()
      }
    } catch (error) {
      logger.debug('shortcut icon cover unreadable', { kind: source.kind, error: (error as Error).message })
    }
    return nativeImage.createEmpty()
  }

  let image = coverImage(profile?.thumbnail || profile?.icon || '')
  // A broken cover still gets an instance image (the bundled default), never the logo.
  if (image.isEmpty()) image = coverImage('')
  if (image.isEmpty()) return ''
  // Crop the cover to a centred square before scaling, so the shortcut icon is
  // never squashed when the source image has a 16:9 or 4:3 aspect ratio.
  const size = image.getSize()
  const side = Math.min(size.width, size.height)
  if (side > 0 && size.width !== size.height) {
    image = image.crop({
      x: Math.max(0, Math.round((size.width - side) / 2)),
      y: Math.max(0, Math.round((size.height - side) / 2)),
      width: side,
      height: side,
    })
  }
  const png = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG()
  if (!png || png.length === 0) return ''
  const directory = join(app.getPath('userData'), 'shortcut-icons')
  mkdirSync(directory, { recursive: true })
  // Content-addressed name: changing the cover changes the path, so Windows
  // cannot keep showing the cached old icon on the shortcut.
  const base = shortcutIconFileName(folderName).replace(/\.ico$/, '')
  const digest = createHash('sha1').update(png).digest('hex').slice(0, 10)
  const iconPath = join(directory, `${base}-${digest}.ico`)
  writeFileSync(iconPath, pngToIco(png))
  return iconPath
}

/** Creates a Windows shortcut that starts one instance through the launcher. */
export function registerShortcutIpc(ipc: IpcRegistrar, options: ShortcutIpcOptions): void {
  const { app, logger, shell } = options

  ipc.handle('create-desktop-shortcut', async (_event, payload) => {
    const { folderName, instanceName } = (payload ?? {}) as { folderName?: unknown; instanceName?: unknown }
    try {
      if (options.platform !== 'win32') {
        return {
          success: false,
          error: 'Desktop-Verknüpfungen werden derzeit nur unter Windows erstellt.',
          code: 'shortcut-win-only',
        }
      }
      const rootPath = options.gameRoot()
      const profiles = options.readProfiles(rootPath)
      const folderOf = (profile: Profile) => options.profileFolderOf(profile).toLowerCase()
      const profile = profiles.find((entry) => folderOf(entry) === String(folderName || '').toLowerCase())
      if (!profile) return { success: false, error: 'Instanz nicht gefunden', code: 'not-found' }
      const safeLabel = String(instanceName || profile.name || 'Minecraft')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 60) || 'Minecraft'
      // Two instances may share a display name. Include the unique folder in the
      // shortcut name then, so creating the second shortcut cannot overwrite the first.
      const sharedName = profiles.some((entry) =>
        options.profileFolderOf(entry) !== options.profileFolderOf(profile) &&
        String(entry.name || '').trim().toLowerCase() === String(profile.name || '').trim().toLowerCase(),
      )
      const shortcutLabel = sharedName ? `${safeLabel} (${options.profileFolderOf(profile)})` : safeLabel
      const shortcutPath = join(app.getPath('desktop'), `${shortcutLabel} - Bamboo Launcher.lnk`)
      const launchArgs = `--bamboo-instance="${options.profileFolderOf(profile)}"`
      const args = app.isPackaged ? launchArgs : `"${app.getAppPath()}" ${launchArgs}`
      const iconPath = createShortcutIcon(profile, options.profileFolderOf(profile), options)
      if (!iconPath) {
        return {
          success: false,
          error: 'Das Instanzbild konnte nicht als Verknüpfungs-Icon gespeichert werden.',
          code: 'shortcut-icon-failed',
        }
      }
      const operation = existsSync(shortcutPath) ? 'update' : 'create'
      const created = shell.writeShortcutLink(shortcutPath, operation, {
        target: app.execPath,
        args,
        description: `${safeLabel} mit Bamboo Launcher starten`,
        icon: iconPath,
        iconIndex: 0,
      })
      if (!created) return { success: false, error: 'Verknüpfung konnte nicht erstellt werden.', code: 'shortcut-failed' }
      logger.info('desktop shortcut created', {
        shortcutPath,
        folderName,
        icon: basename(iconPath),
      })
      return { success: true, path: shortcutPath }
    } catch (error) {
      logger.error('create-desktop-shortcut failed', { folderName, error: (error as Error).message })
      return { success: false, error: (error as Error).message }
    }
  })
}
