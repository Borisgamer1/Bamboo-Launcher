import { app, dialog, ipcMain, safeStorage, shell } from 'electron'
import { createCore, LauncherCore } from './core'
import type { MicrosoftAuthStatus } from './auth/service'
import { registerIpc } from './ipc'
import { legacyGameRoot } from './paths'
import type { SecretBox } from './token-store'
import type { AnalysisResult } from './logs/types'
import { describeError, getDefaultLogger } from './logger'

const safeStorageBox: SecretBox = {
  isEncryptionAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (error) {
      getDefaultLogger().child('index').debug('safeStorage encryption probe failed', { error: describeError(error) })
      return false
    }
  },
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
}

async function ensureBootstrapGameRoot(core: LauncherCore): Promise<void> {
  if (core.rootSource !== 'default') return
  if (process.env.BAMBOO_SKIP_BOOTSTRAP === '1') return
  try {
    const result = await dialog.showOpenDialog({
      title: 'Minecraft-Spielordner wählen',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Diesen Ordner verwenden',
    })
    const chosen = result.canceled ? '' : result.filePaths[0]
    if (chosen) await core.changeGameRoot(chosen)
    else core.logger.info('Game root selection cancelled; using default', { gameRoot: core.paths.gameRoot })
  } catch (error) {
    core.logger.warn('Game root selection failed; using default', { error: (error as Error).message })
  }
}

let corePromise: Promise<LauncherCore> | null = null

export function initializeCore(
  options: {
    onAnalysis?: (result: AnalysisResult) => void
    onSessionLost?: (status: MicrosoftAuthStatus) => void
  } = {},
): Promise<LauncherCore> {
  if (!corePromise) {
    corePromise = createCore({
      appDataPath: app.getPath('userData'),
      legacyGameRoot: legacyGameRoot(),
      safeStorage: safeStorageBox,
      ...(options.onAnalysis ? { onAnalysis: options.onAnalysis } : {}),
      ...(options.onSessionLost ? { onSessionLost: options.onSessionLost } : {}),
      openPath: (target) => shell.openPath(target),
      openUrl: (url) => shell.openExternal(url),
    })
      .then(async (core) => {
        registerIpc(ipcMain, core)
        await ensureBootstrapGameRoot(core)
        return core
      })
      .catch((error) => {
        corePromise = null
        throw error
      })
  }
  return corePromise
}

export { createCore } from './core'
export type { CoreStatus, LaunchIdentity } from './core'
export { registerIpc } from './ipc'
