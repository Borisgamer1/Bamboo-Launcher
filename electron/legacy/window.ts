import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, Shell } from 'electron'
import type { Logger } from '../logger'

interface IpcWindowEvents {
  on(channel: string, listener: (...args: never[]) => void): void
  once(channel: string, listener: (...args: never[]) => void): void
  removeListener(channel: string, listener: (...args: never[]) => void): void
}

interface ProtocolLike {
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response>): void
}

interface NetLike {
  fetch(url: string): Promise<Response>
}

interface MenuLike {
  setApplicationMenu(menu: null): void
}

interface AppLike {
  isPackaged: boolean
}

export interface MainWindowOptions {
  app: AppLike
  BrowserWindow: new (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
  protocol: ProtocolLike
  net: NetLike
  Menu: MenuLike
  shell: Pick<Shell, 'openExternal'>
  ipc: IpcWindowEvents
  logger: Logger
  /** `<gameRoot>/window-state.json`; the launcher remembers its last bounds. */
  statePath(): string
  preloadPath: string
  iconPath: string
  rendererEntry: string
  devServerUrl: string
}

interface SavedBounds {
  width?: number
  height?: number
  x?: number
  y?: number
  isMaximized?: boolean
}

function loadWindowState(options: MainWindowOptions): SavedBounds {
  try {
    const statePath = options.statePath()
    if (existsSync(statePath)) {
      const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
      // A hand-edited file may hold null, a string or bad numbers; trusting it
      // crashes the BrowserWindow constructor before any window exists.
      if (parsed && typeof parsed === 'object') {
        const state = parsed as SavedBounds
        const size = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) ? value : undefined
        return {
          width: size(state.width),
          height: size(state.height),
          x: size(state.x),
          y: size(state.y),
          isMaximized: state.isMaximized === true,
        }
      }
    }
  } catch (error) {
    options.logger.debug('window state unreadable; using defaults', { error: (error as Error).message })
  }
  return {}
}

function saveWindowState(options: MainWindowOptions, state: SavedBounds): void {
  try {
    const statePath = options.statePath()
    const dir = dirname(statePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(statePath, JSON.stringify(state))
  } catch (error) {
    options.logger.debug('window state could not be saved', { error: (error as Error).message })
  }
}

/** Frameless main window plus the save/restore and flush-before-close handling. */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { logger, ipc } = options

  options.protocol.handle('bamboo-file', (request) => {
    const urlPath = request.url.replace('bamboo-file://', '')
    const decodedPath = decodeURIComponent(urlPath)
    return options.net.fetch(pathToFileURL(decodedPath).toString())
  })

  options.Menu.setApplicationMenu(null)

  const saved = loadWindowState(options)

  const window = new options.BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 800,
    x: saved.x,
    y: saved.y,
    minWidth: 1024, minHeight: 700,
    frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#121212', show: false,
    icon: options.iconPath,
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  window.setMenuBarVisibility(false)

  window.webContents.setWindowOpenHandler(({ url }) => {
    options.shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i') || (input.meta && input.alt && input.key.toLowerCase() === 'i')) {
      window.webContents.toggleDevTools()
    }
  })

  // A packaged build must never depend on (or trust) a local dev server.
  if (options.app.isPackaged) {
    void window.loadFile(options.rendererEntry)
  } else {
    window.loadURL(options.devServerUrl).catch(() => {
      void window.loadFile(options.rendererEntry)
    })
  }

  if (saved.isMaximized) window.maximize()

  window.once('ready-to-show', () => {
    window.show()
  })

  // Test hook: launch a known instance without clicking through the UI. It is
  // inert unless the local test process opts in.
  if (process.env.BAMBOO_AUTOPLAY) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const payload = JSON.stringify({
          folderName: process.env.BAMBOO_AUTOPLAY_FOLDER || 'furry-smp',
          profileName: process.env.BAMBOO_AUTOPLAY_NAME || 'Furry SMP',
          version: process.env.BAMBOO_AUTOPLAY_VERSION || '26.3',
          modLoader: 'fabric',
          loaderVersion: '0.20.1',
        })
        window.webContents.executeJavaScript(
          `window.electronAPI.launch.start(${payload})`,
        ).catch((error) => logger.error('autoplay failed', { error: (error as Error).message }))
      }, 2500)
    })
  }

  const saveBounds = () => {
    if (!window.isMaximized()) {
      saveWindowState(options, window.getBounds())
    }
  }
  window.on('resize', saveBounds)
  window.on('move', saveBounds)
  window.on('maximize', () => {
    saveWindowState(options, { isMaximized: true })
    if (!window.isDestroyed()) window.webContents.send('window-maximized-change', true)
  })
  window.on('unmaximize', () => {
    saveWindowState(options, window.getBounds())
    if (!window.isDestroyed()) window.webContents.send('window-maximized-change', false)
  })

  let allowClose = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  const finishClose = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    ipc.removeListener('app:flush-before-close-done', finishClose)
    allowClose = true
    if (!window.isDestroyed()) window.close()
  }
  window.on('close', (event) => {
    const state = window.isMaximized()
      ? { isMaximized: true }
      : window.getBounds()
    saveWindowState(options, state)

    if (allowClose) return
    event.preventDefault()
    if (closeTimer) return

    ipc.once('app:flush-before-close-done', finishClose)
    closeTimer = setTimeout(finishClose, 2500)
    try {
      window.webContents.send('app:flush-before-close')
    } catch {
      finishClose()
    }
  })
  window.on('closed', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    ipc.removeListener('app:flush-before-close-done', finishClose)
  })

  return window
}
