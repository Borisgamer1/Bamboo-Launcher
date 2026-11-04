import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Account } from '../components/TopBar'
import type { Instance } from '../components/InstancesView'
import type { LanguageType } from '../lib/translations'
import type { LauncherPreferences } from '../lib/launcherPreferences'
import type { ToastMessage } from '../components/Toast'
import { savedJvmArgs } from '../lib/launcherPreferences'
import { mergeKeybinds } from '../lib/keybinds'
import { parseJvmArgs } from '../lib/gameOptions'
import { instanceFolderKeyOf } from '../lib/instanceFolders'
import type { LaunchProgress } from '../electron'

export interface RunningInstance {
  name: string
  folderName: string
  startedAt: number
}

interface UseLaunchControllerOptions {
  instances: Instance[]
  setInstances: Dispatch<SetStateAction<Instance[]>>
  setActiveInstance: Dispatch<SetStateAction<string>>
  activeAccount: Account
  preferences: LauncherPreferences
  lang: LanguageType
  addToast: (toast: Omit<ToastMessage, 'id'>) => void
  clearAnalyses: (folderName: string, instanceId: string) => void
}

export interface LaunchControllerState {
  runningInstances: RunningInstance[]
  isLaunching: boolean
  launchingFolder: string
  launchProgress: Record<string, LaunchProgress>
  launchGame: (instanceId?: string) => void
  stopGame: (name: string, folderName?: string) => void
  addRunningInstance: (name: string, folderName?: string) => void
}

export function useLaunchController({
  instances,
  setInstances,
  setActiveInstance,
  activeAccount,
  preferences,
  lang,
  addToast,
  clearAnalyses,
}: UseLaunchControllerOptions): LaunchControllerState {
  const [runningInstances, setRunningInstances] = useState<RunningInstance[]>([])
  const [launchProgress, setLaunchProgress] = useState<Record<string, LaunchProgress>>({})
  const launchStartRef = useRef<Map<string, number>>(new Map())
  const [isLaunching, setIsLaunching] = useState(false)
  const [launchingFolder, setLaunchingFolder] = useState('')
  const launchInFlight = useRef(false)

  const endLaunch = useCallback(() => {
    launchInFlight.current = false
    setIsLaunching(false)
    setLaunchingFolder('')
  }, [])

  const addRunningInstance = useCallback((name: string, folderName?: string) => {
    const folder = folderName || instanceFolderKeyOf({ name })
    setRunningInstances((prev) => [...prev, { name, folderName: folder, startedAt: Date.now() }])
  }, [])

  const launchGame = (instanceId?: string) => {
    const instance = instanceId ? instances.find((entry) => entry.id === instanceId) : null
    const target = instance || instances[0]
    if (!target || isLaunching || launchInFlight.current) return

    if (!activeAccount.id) {
      addToast({
        type: 'warning',
        message: lang === 'de'
          ? 'Kein Account ausgewählt – Account in den Einstellungen hinzufügen'
          : 'No account selected – add an account in Settings',
      })
      return
    }

    launchInFlight.current = true
    setActiveInstance(target.name)
    setIsLaunching(true)

    const folderName = instanceFolderKeyOf(target)
    setLaunchingFolder(folderName)
    clearAnalyses(folderName, target.id)

    const windowDefaults = preferences.instanceDefaults.window
    const fullscreen = target.fullscreen ?? windowDefaults.fullscreen
    const windowMode = target.windowMode || windowDefaults.mode
    const resolution = !fullscreen && windowMode === 'custom'
      ? {
          width: target.windowWidth || windowDefaults.width,
          height: target.windowHeight || windowDefaults.height,
        }
      : undefined
    const jvmArgs = target.jvmArgs && target.jvmArgs.trim()
      ? parseJvmArgs(target.jvmArgs)
      : savedJvmArgs(preferences)
    const keyBindings = mergeKeybinds(preferences.keybinds, target.keybinds)

    const payload = {
      folderName,
      profileName: target.name,
      version: target.minecraftVersion,
      ram: target.ram || 4096,
      modLoader: target.modloader === 'Vanilla' ? 'vanilla' : target.modloader.toLowerCase(),
      loaderVersion: target.modloaderVersion || '',
      javaPath: target.javaVersion === 'Automatisch'
        ? preferences.instanceDefaults.javaPath || ''
        : (target.javaVersion || ''),
      authData: {
        type: activeAccount.type === 'Microsoft' ? 'microsoft' : 'offline',
        name: activeAccount.username,
        uuid: activeAccount.uuid,
      },
      gameOptions: {
        ...preferences.gameOptions,
        _mcVersion: target.minecraftVersion,
        lang: preferences.instanceDefaults.minecraftLanguage,
        fullscreen,
        keyBindings,
      },
      extraJvmArgs: jvmArgs,
      resolution,
    }

    launchStartRef.current.set(folderName, Date.now())
    setLaunchProgress((prev) => {
      if (!(folderName in prev)) return prev
      const next = { ...prev }
      delete next[folderName]
      return next
    })

    try {
      window.electronAPI?.launch.start?.(payload)
      window.electronAPI?.launch.onReady?.(() => {
        endLaunch()
        if (preferences.behavior.minimizeOnLaunch) window.electronAPI?.window.minimize?.()
      })
    } catch {
      console.warn('[Bamboo] Launch failed')
      endLaunch()
    }

    setRunningInstances((prev) => [...prev, { name: target.name, folderName, startedAt: Date.now() }])
  }

  useEffect(() => {
    const unsubscribe = window.electronAPI?.launch.onProgress?.((data) => {
      setLaunchProgress((prev) => ({ ...prev, [data.folderName]: data }))
      setIsLaunching(true)
      setLaunchingFolder(data.folderName)
    })
    return () => { unsubscribe?.() }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.launch.onClosed?.((data) => {
      setRunningInstances((prev) => prev.filter((entry) =>
        data.folderName ? entry.folderName !== data.folderName : entry.name !== data.profileName,
      ))
      setLaunchProgress((prev) => {
        if (!(data.folderName in prev)) return prev
        const next = { ...prev }
        delete next[data.folderName]
        return next
      })
      endLaunch()

      const startedAt = launchStartRef.current.get(data.folderName)
      const elapsed = startedAt ? Math.max(0, Date.now() - startedAt) : 0
      if (startedAt) launchStartRef.current.delete(data.folderName)

      setInstances((prev) => prev.map((instance) => {
        const instanceFolder = instanceFolderKeyOf(instance)
        const matches = data.folderName
          ? instanceFolder === data.folderName
          : instance.name === data.profileName
        if (!matches) return instance
        return {
          ...instance,
          playTimeMs: (instance.playTimeMs || 0) + elapsed,
          sessionCount: (instance.sessionCount || 0) + 1,
          lastPlayedAt: Date.now(),
        }
      }))

      if (preferences.behavior.focusOnGameClose) window.electronAPI?.window.focus?.()
    })
    return () => { unsubscribe?.() }
  }, [endLaunch, preferences.behavior.focusOnGameClose, setInstances])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.launch.onFailed?.((data) => {
      setRunningInstances((prev) => prev.filter((entry) =>
        data.folderName ? entry.folderName !== data.folderName : entry.name !== data.profileName,
      ))
      setLaunchProgress((prev) => {
        if (!(data.folderName in prev)) return prev
        const next = { ...prev }
        delete next[data.folderName]
        return next
      })
      launchStartRef.current.delete(data.folderName)
      endLaunch()
      addToast({
        type: 'error',
        message: data.message || (lang === 'de' ? 'Launch fehlgeschlagen' : 'Launch failed'),
      })
    })
    return () => { unsubscribe?.() }
  }, [addToast, endLaunch, lang])

  const stopGame = (name: string, folderName?: string) => {
    const folder = folderName || instanceFolderKeyOf({ name })
    window.electronAPI?.launch.stop?.({ folderName: folder, profileName: name })
    setRunningInstances((prev) => prev.filter((entry) =>
      folderName ? entry.folderName !== folder : entry.name !== name,
    ))
  }

  return {
    runningInstances,
    isLaunching,
    launchingFolder,
    launchProgress,
    launchGame,
    stopGame,
    addRunningInstance,
  }
}
