import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  version?: string
  percent?: number
  message?: string
  checkedAt?: number
}

export interface UpdaterLogger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

interface SetupAutoUpdaterOptions {
  logger: UpdaterLogger
  initialDelayMs?: number
  intervalMs?: number
}

const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let started = false
let checking = false
let promptedVersion: string | null = null
let status: UpdateStatus = {
  state: 'disabled',
  currentVersion: app.getVersion(),
}

function publish(next: Partial<UpdateStatus> & { state: UpdateState }): void {
  status = { ...status, ...next, currentVersion: app.getVersion() }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('bamboo:updates:status', status)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function checkForUpdates(logger: UpdaterLogger): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  if (checking) return status
  checking = true
  publish({ state: 'checking', message: undefined, percent: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    const message = errorMessage(error)
    logger.warn('update check failed', { error: message })
    publish({ state: 'error', message, checkedAt: Date.now() })
  } finally {
    checking = false
  }
  return status
}

async function promptRestart(info: UpdateInfo, logger: UpdaterLogger): Promise<void> {
  if (promptedVersion === info.version) return
  promptedVersion = info.version

  const german = app.getLocale().toLowerCase().startsWith('de')
  const options = {
    type: 'info' as const,
    title: 'Bamboo Launcher Update',
    message: german
      ? `Version ${info.version} wurde heruntergeladen.`
      : `Version ${info.version} has been downloaded.`,
    detail: german
      ? 'Beim Beenden wird das Update automatisch installiert. Du kannst den Launcher jetzt neu starten, um das Update sofort abzuschließen.'
      : 'The update installs automatically when you quit. You can restart the launcher now to finish the update immediately.',
    buttons: german ? ['Jetzt neu starten', 'Später'] : ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }

  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)

  if (result.response === 0) {
    logger.info('installing downloaded update', { version: info.version })
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  } else {
    logger.info('update deferred until quit', { version: info.version })
  }
}

/**
 * Wires electron-updater once per process. The update source comes from the
 * generated app-update.yml (electron-builder's `build.publish` config), so no
 * repository token or feed URL is embedded in the app.
 */
export function setupAutoUpdater(options: SetupAutoUpdaterOptions): void {
  if (started) return
  started = true

  ipcMain.handle('bamboo:updates:state', () => status)
  ipcMain.handle('bamboo:updates:check', () => checkForUpdates(options.logger))
  ipcMain.handle('bamboo:updates:install', () => {
    if (!app.isPackaged) return false
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })

  if (!app.isPackaged) {
    status = {
      state: 'disabled',
      currentVersion: app.getVersion(),
      message: 'Updates werden nur in der installierten App geprüft.',
    }
    options.logger.info('auto-update disabled outside a packaged build')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    publish({ state: 'checking', message: undefined, percent: undefined })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    options.logger.info('update available', { version: info.version })
    publish({ state: 'available', version: info.version, percent: 0 })
  })
  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    options.logger.info('launcher is up to date', { version: info.version })
    publish({ state: 'not-available', version: info.version, checkedAt: Date.now() })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish({
      state: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    options.logger.info('update downloaded', { version: info.version })
    publish({ state: 'downloaded', version: info.version, percent: 100 })
    void promptRestart(info, options.logger).catch((error) => {
      options.logger.warn('update prompt failed', { error: errorMessage(error) })
    })
  })
  autoUpdater.on('error', (error: Error) => {
    options.logger.warn('auto-updater error', { error: errorMessage(error) })
    publish({ state: 'error', message: errorMessage(error), checkedAt: Date.now() })
  })

  publish({ state: 'idle' })

  const firstCheck = setTimeout(() => {
    void checkForUpdates(options.logger)
  }, options.initialDelayMs ?? FIRST_CHECK_DELAY_MS)
  firstCheck.unref()

  const interval = setInterval(() => {
    void checkForUpdates(options.logger)
  }, options.intervalMs ?? CHECK_INTERVAL_MS)
  interval.unref()

  options.logger.info('auto-updater started', { intervalHours: (options.intervalMs ?? CHECK_INTERVAL_MS) / 3_600_000 })
}
