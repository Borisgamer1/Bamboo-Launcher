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
import type { LaunchProgress, PreflightIssue } from '../electron-api'
import { mainErrorText } from '../lib/mainErrors'

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
  /** Reads the crash log after a non-zero exit and stores the result. */
  analyzeAfterCrash: (folderName: string, instanceId: string) => Promise<unknown>
}

export interface LaunchPreflightPrompt {
  folderName: string
  instanceId: string
  name: string
  server?: { host: string; port?: number }
  checkedMods: number
  issues: PreflightIssue[]
}

export interface LaunchControllerState {
  runningInstances: RunningInstance[]
  isLaunching: boolean
  launchingFolder: string
  launchProgress: Record<string, LaunchProgress>
  launchGame: (instanceId?: string, server?: { host: string; port?: number }) => boolean
  stopGame: (name: string, folderName?: string) => void
  /** Start findings waiting for the user's decision, if any. */
  preflight: LaunchPreflightPrompt | null
  preflightBusy: boolean
  confirmPreflight: () => void
  cancelPreflight: () => void
  disablePreflight: (files: string[]) => void
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
  analyzeAfterCrash,
}: UseLaunchControllerOptions): LaunchControllerState {
  const [runningInstances, setRunningInstances] = useState<RunningInstance[]>([])
  const [launchProgress, setLaunchProgress] = useState<Record<string, LaunchProgress>>({})
  const launchStartRef = useRef<Map<string, number>>(new Map())
  const [isLaunching, setIsLaunching] = useState(false)
  const [launchingFolder, setLaunchingFolder] = useState('')
  // Pro Instanz, nicht global: Eine zweite Instanz darf starten, während die
  // erste noch lädt.
  const launchesInFlight = useRef<Set<string>>(new Set())
  // Die Prüfung läuft vor dem Start; ein zweiter Klick soll sie nicht doppelt
  // auslösen und den Start nicht zweimal anstoßen.
  const checksInFlight = useRef<Set<string>>(new Set())
  const [preflight, setPreflight] = useState<LaunchPreflightPrompt | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)

  const endLaunch = useCallback((folderName?: string) => {
    if (folderName) launchesInFlight.current.delete(folderName)
    else launchesInFlight.current.clear()
    setIsLaunching(launchesInFlight.current.size > 0)
    setLaunchingFolder('')
  }, [])

  const startTarget = (
    target: Instance,
    server?: { host: string; port?: number },
  ): boolean => {
    const folderName = instanceFolderKeyOf(target)
    if (launchesInFlight.current.has(folderName)) return false

    if (!activeAccount.id) {
      addToast({
        type: 'warning',
        message: lang === 'de'
          ? 'Kein Account ausgewählt – Account in den Einstellungen hinzufügen'
          : 'No account selected – add an account in Settings',
      })
      return false
    }

    launchesInFlight.current.add(folderName)
    setActiveInstance(target.name)
    setIsLaunching(true)
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
        ...(server ? { joinServer: server.host, joinPort: server.port ?? 25565 } : {}),
      },
      extraJvmArgs: jvmArgs,
      resolution,
    }

    launchStartRef.current.set(folderName, Date.now())
    // Der Balken muss ab dem ersten Moment sichtbar sein; ohne Startwert
    // blieb er bei schnellen Starts komplett unsichtbar.
    setLaunchProgress((prev) => ({
      ...prev,
      [folderName]: {
        folderName,
        profileName: target.name,
        percent: 4,
        label: lang === 'de' ? 'Start wird vorbereitet' : 'Preparing launch',
        startedAt: Date.now(),
      },
    }))

    try {
      window.electronAPI?.launch.start?.(payload)
    } catch {
      console.warn('[Bamboo] Launch failed')
      endLaunch(folderName)
      return false
    }

    setRunningInstances((prev) => [...prev, { name: target.name, folderName, startedAt: Date.now() }])
    return true
  }

  /**
   * Prüft die Mods vor dem Start. Die Prüfung ist eine Hilfe, kein Tor: Ist sie
   * nicht verfügbar oder schlägt sie fehl, startet das Spiel wie bisher. Nur
   * bei Befunden hält der Start an und wartet auf „Trotzdem starten“.
   */
  const launchGame = (instanceId?: string, server?: { host: string; port?: number }): boolean => {
    const instance = instanceId ? instances.find((entry) => entry.id === instanceId) : null
    const target = instance || instances[0]
    if (!target) return false
    const folderName = instanceFolderKeyOf(target)
    if (launchesInFlight.current.has(folderName)) return false
    if (checksInFlight.current.has(folderName)) return false

    if (!activeAccount.id) {
      addToast({
        type: 'warning',
        message: lang === 'de'
          ? 'Kein Account ausgewählt – Account in den Einstellungen hinzufügen'
          : 'No account selected – add an account in Settings',
      })
      return false
    }

    const check = window.electronAPI?.instances.preflight
    if (!check) return startTarget(target, server)

    checksInFlight.current.add(folderName)
    void check(folderName)
      .then((report) => {
        checksInFlight.current.delete(folderName)
        if (report?.issues?.length) {
          setPreflight({
            folderName,
            instanceId: target.id,
            name: target.name,
            server,
            checkedMods: report.checkedMods ?? 0,
            issues: report.issues,
          })
          return
        }
        startTarget(target, server)
      })
      .catch(() => {
        checksInFlight.current.delete(folderName)
        startTarget(target, server)
      })
    return true
  }

  const confirmPreflight = () => {
    const prompt = preflight
    if (!prompt) return
    const target =
      instances.find((entry) => entry.id === prompt.instanceId) ||
      instances.find((entry) => instanceFolderKeyOf(entry) === prompt.folderName)
    setPreflight(null)
    if (!target) {
      addToast({
        type: 'error',
        message: lang === 'de' ? 'Instanz nicht gefunden.' : 'Instance not found.',
      })
      return
    }
    startTarget(target, prompt.server)
  }

  const cancelPreflight = () => {
    if (!preflightBusy) setPreflight(null)
  }

  const disablePreflight = (files: string[]) => {
    const prompt = preflight
    if (!prompt || files.length === 0 || preflightBusy) return
    setPreflightBusy(true)
    void (async () => {
      try {
        const result = await window.electronAPI?.instances.preflightDisable?.(
          prompt.folderName,
          files,
        )
        if (!result?.success) {
          addToast({
            type: 'error',
            message: lang === 'de'
              ? 'Dateien konnten nicht deaktiviert werden.'
              : 'Could not disable the files.',
          })
          return
        }
        if (result.failed?.length) {
          addToast({
            type: 'warning',
            message: lang === 'de'
              ? `${result.failed.length} Datei(en) konnten nicht umbenannt werden.`
              : `${result.failed.length} file(s) could not be renamed.`,
          })
        }

        let report
        try {
          report = await window.electronAPI?.instances.preflight?.(prompt.folderName)
        } catch {
          report = undefined
        }

        const startIfClean = (issues: PreflightIssue[]) => {
          if (issues.length > 0) {
            setPreflight({ ...prompt, checkedMods: report?.checkedMods ?? prompt.checkedMods, issues })
            return
          }
          const target =
            instances.find((entry) => entry.id === prompt.instanceId) ||
            instances.find((entry) => instanceFolderKeyOf(entry) === prompt.folderName)
          setPreflight(null)
          if (target) startTarget(target, prompt.server)
        }

        if (report) {
          startIfClean(report.issues ?? [])
          return
        }
        // Ohne zweite Prüfung den erledigten Befund ausblenden, nicht den
        // ganzen Dialog schließen: andere Befunde bleiben sichtbar.
        startIfClean(prompt.issues.filter((issue) =>
          issue.disable.length === 0 || !issue.disable.every((file) => files.includes(file)),
        ))
      } finally {
        setPreflightBusy(false)
      }
    })()
  }

  // One subscription for the whole controller; subscribing inside launchGame
  // added a listener per start and never removed it.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.launch.onReady?.((profileName) => {
      const ready = instances.find((entry) => entry.name === profileName)
      endLaunch(ready ? instanceFolderKeyOf(ready) : undefined)
      if (preferences.behavior.minimizeOnLaunch) window.electronAPI?.window.minimize?.()
    })
    return () => { unsubscribe?.() }
  }, [endLaunch, instances, preferences.behavior.minimizeOnLaunch])

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
      endLaunch(data.folderName)

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

      // Ein normaler Ausstieg (Code 0) braucht keine Analyse. Bei allem anderen
      // liest der Kern den Log und die Karte bekommt ihren "Beheben"-Hinweis.
      if (data.code !== 0) {
        const key = data.folderName || instanceFolderKeyOf({ name: data.profileName })
        void analyzeAfterCrash(key, key)
      }
    })
    return () => { unsubscribe?.() }
  }, [analyzeAfterCrash, endLaunch, preferences.behavior.focusOnGameClose, setInstances])

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
      endLaunch(data.folderName)
      addToast({
        type: 'error',
        message: mainErrorText({ error: data.message, code: data.code }, lang, lang === 'de' ? 'Launch fehlgeschlagen' : 'Launch failed'),
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
    preflight,
    preflightBusy,
    confirmPreflight,
    cancelPreflight,
    disablePreflight,
  }
}
