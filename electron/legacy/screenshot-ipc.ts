import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { deleteScreenshotFile } from '../screenshots'

export interface ScreenshotLogger {
  debug(message: string, data?: Record<string, unknown>): void
}

export interface ScreenshotIpcOptions {
  gameRoot(): string
  profileDirOrNull(rootPath: string, folderName: string): string | null
  openPath(target: string): Promise<string> | void
  logger: ScreenshotLogger
}

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

interface ScreenshotEntry {
  id: string
  title: string
  fileName: string
  source: string
  instance: string
  world: string | null
  date: number
  sizeBytes: number
  sizeStr: string
  dimensions: string
  url: string
  absolutePath: string
  sourceAbsolutePath: string
}

/** Screenshot folders and the central collected copy, kept out of main.js. */
export function registerScreenshotIpc(ipc: IpcRegistrar, options: ScreenshotIpcOptions): void {
  ipc.handle('collect-all-screenshots', async () => {
    const rootPath = options.gameRoot()
    const profilesDir = join(rootPath, 'profiles')
    const globalDir = join(rootPath, 'screenshots')
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true })
    const list: ScreenshotEntry[] = []
    if (!existsSync(profilesDir)) return list

    const safeSegment = (value: unknown): string => {
      const cleaned = String(value || '_').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
      return cleaned || '_'
    }

    const copyAndRegister = (src: string, instanceName: string, worldName: string | null): void => {
      try {
        const stat = statSync(src)
        const originalExt = extname(src).toLowerCase().replace(/^\./, '') || 'png'
        const originalBase = basename(src, extname(src))
        const prefixedBase =
          `${safeSegment(instanceName)}__${safeSegment(worldName)}__${safeSegment(originalBase)}__${stat.mtimeMs}`
        const destination = join(globalDir, `${prefixedBase}.${originalExt}`)
        if (!existsSync(destination) || statSync(destination).size !== stat.size) {
          // Copying is the only write; the source stays untouched.
          copyFileSync(src, destination)
        }
        let width = 0
        let height = 0
        if (originalExt === 'png' && stat.size >= 24) {
          const descriptor = openSync(destination, 'r')
          const header = Buffer.alloc(24)
          try {
            readSync(descriptor, header, 0, 24, 0)
          } catch (error) {
            options.logger.debug('screenshot: header could not be read', {
              destination,
              error: (error as Error).message,
            })
          } finally {
            closeSync(descriptor)
          }
          if (header[0] === 0x89 && header[1] === 0x50) {
            try {
              width = header.readUInt32BE(16)
              height = header.readUInt32BE(20)
            } catch (error) {
              options.logger.debug('screenshot: dimensions could not be parsed', {
                destination,
                error: (error as Error).message,
              })
            }
          }
        }
        list.push({
          id: prefixedBase,
          title: originalBase,
          fileName: basename(src),
          source: worldName ? `${instanceName} / ${worldName}` : instanceName,
          instance: instanceName,
          world: worldName,
          date: stat.mtimeMs,
          sizeBytes: stat.size,
          sizeStr:
            stat.size > 1024 * 1024
              ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
              : `${(stat.size / 1024).toFixed(0)} KB`,
          dimensions: width && height ? `${width}\u00d7${height}` : '?',
          url: `bamboo-file://${encodeURIComponent(destination)}`,
          absolutePath: destination,
          sourceAbsolutePath: src,
        })
      } catch (error) {
        options.logger.debug('screenshot: file could not be collected', {
          src,
          error: (error as Error).message,
        })
      }
    }

    const scanDir = (folder: string, instanceName: string, worldName: string | null): void => {
      if (!existsSync(folder)) return
      let entries: string[]
      try {
        entries = readdirSync(folder)
      } catch {
        return
      }
      for (const name of entries) {
        if (!/\.(png|jpg|jpeg)$/i.test(name)) continue
        try {
          const src = join(folder, name)
          if (!statSync(src).isFile()) continue
          copyAndRegister(src, instanceName, worldName)
        } catch (error) {
          options.logger.debug('screenshot: folder entry skipped', {
            folder,
            error: (error as Error).message,
          })
        }
      }
    }

    let profileEntries
    try {
      profileEntries = readdirSync(profilesDir, { withFileTypes: true })
    } catch {
      return list
    }
    for (const entry of profileEntries) {
      if (!entry.isDirectory()) continue
      const instanceName = entry.name
      const instanceDir = join(profilesDir, instanceName)
      scanDir(join(instanceDir, 'screenshots'), instanceName, null)
      const saves = join(instanceDir, 'saves')
      if (existsSync(saves)) {
        let worldEntries
        try {
          worldEntries = readdirSync(saves, { withFileTypes: true })
        } catch {
          continue
        }
        for (const world of worldEntries) {
          if (!world.isDirectory()) continue
          scanDir(join(saves, world.name, 'screenshots'), instanceName, world.name)
        }
      }
    }
    list.sort((a, b) => b.date - a.date)
    return list
  })

  ipc.handle('delete-screenshot-file', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') return false
    const { absolutePath, sourceAbsolutePath } = payload as Record<string, unknown>
    if (!absolutePath || typeof absolutePath !== 'string') return false
    return deleteScreenshotFile(
      {
        rootPath: options.gameRoot(),
        absolutePath,
        ...(typeof sourceAbsolutePath === 'string' ? { sourceAbsolutePath } : {}),
      },
      options.logger,
    )
  })

  ipc.handle('open-screenshots-folder', async () => {
    const screenshotsDir = join(options.gameRoot(), 'screenshots')
    if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
    await options.openPath(screenshotsDir)
  })
}
