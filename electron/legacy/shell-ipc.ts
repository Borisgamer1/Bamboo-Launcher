import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  BrowserWindow,
  Clipboard,
  Dialog,
  OpenDialogOptions,
  SaveDialogOptions,
  Shell,
} from 'electron'

export interface ShellIpcLogger {
  debug(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export interface ShellIpcOptions {
  getWindow(): BrowserWindow | null | undefined
  gameRoot(): string
  dialog: Dialog
  shell: Shell
  clipboard: Clipboard
  logger: ShellIpcLogger
}

interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** Window chrome, dialogs and the small file helpers the renderer calls. */
export function registerShellIpc(ipc: IpcRegistrar, options: ShellIpcOptions): void {
  ipc.on('window-minimize', () => options.getWindow()?.minimize())
  ipc.on('window-focus', () => {
    const window = options.getWindow()
    window?.show()
    window?.focus()
  })
  ipc.on('window-close', () => options.getWindow()?.close())
  ipc.on('window-maximize', () => {
    const window = options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipc.handle('window-is-maximized', () => {
    const window = options.getWindow()
    return Boolean(window && !window.isDestroyed() && window.isMaximized())
  })

  // The preload bridge sends one object, not positional arguments.
  ipc.on('renderer-log', (_event, payload) => {
    const { level, message, data } = (payload ?? {}) as {
      level?: string
      message?: unknown
      data?: unknown
    }
    const write = (options.logger as unknown as Record<string, unknown>)[String(level)]
    const log = typeof write === 'function' ? write : options.logger.warn
    ;(log as (text: string, details?: unknown) => void).call(options.logger, `renderer: ${String(message)}`, data)
  })

  ipc.handle('show-open-dialog', async (_event, dialogOptions) =>
    options.dialog.showOpenDialog(dialogOptions as OpenDialogOptions),
  )
  ipc.handle('show-save-dialog', async (_event, dialogOptions) =>
    options.dialog.showSaveDialog(dialogOptions as SaveDialogOptions),
  )

  ipc.handle('show-item-in-folder', async (_event, filePath) => {
    try {
      if (filePath && typeof filePath === 'string' && existsSync(filePath)) {
        options.shell.showItemInFolder(filePath)
      }
    } catch (error) {
      options.logger.error('show-item-in-folder failed', { error: (error as Error).message })
    }
  })

  ipc.handle('read-image-file', async (_event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return null
      const data = readFileSync(filePath)
      const mimeType = MIME_BY_EXTENSION[extname(filePath).toLowerCase()] || 'image/png'
      return `data:${mimeType};base64,${data.toString('base64')}`
    } catch (error) {
      options.logger.error('read-image-file failed', { error: (error as Error).message })
      return null
    }
  })

  ipc.on('copy-to-clipboard', (_event, text) => options.clipboard.writeText(String(text ?? '')))
  ipc.on('open-external-url', (_event, url) => {
    void options.shell.openExternal(String(url ?? ''))
  })
}
