import { useCallback, useEffect, useRef } from 'react'
import type { Instance } from '../components/InstancesView'
import type { LanguageType } from '../lib/translations'
import type { LauncherPreferences } from '../lib/launcherPreferences'
import { profileFromInstance } from './useInstances'

interface UsePersistenceOptions {
  instances: Instance[]
  themeId: string
  lang: LanguageType
  preferences: LauncherPreferences
  settingsLoaded: boolean
  profilesLoaded: boolean
  legacyCoversDetected: boolean
  showBgImage: boolean
  showParticles: boolean
  showGlow: boolean
  mainColor: string
  bgBrightness: number
  bgBlur: number
}

export function usePersistence(options: UsePersistenceOptions): () => Promise<void> {
  const saveAllRef = useRef(options)
  useEffect(() => {
    saveAllRef.current = options
  })
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const migratedLegacyCoversRef = useRef(false)

  const saveAllData = useCallback((): Promise<void> => {
    const run = async () => {
      const snapshot = saveAllRef.current

      localStorage.setItem('bamboo-showBgImage', String(snapshot.showBgImage))
      localStorage.setItem('bamboo-showParticles', String(snapshot.showParticles))
      localStorage.setItem('bamboo-showGlow', String(snapshot.showGlow))
      localStorage.setItem('bamboo-mainColor', snapshot.mainColor)
      localStorage.setItem('bamboo-bgBrightness', String(snapshot.bgBrightness))
      localStorage.setItem('bamboo-bgBlur', String(snapshot.bgBlur))

      if (!snapshot.settingsLoaded) return

      await window.electronAPI?.settings.save?.({
        currentTheme: snapshot.themeId,
        lang: snapshot.lang,
        preferences: snapshot.preferences,
      })

      if (snapshot.profilesLoaded) {
        const profiles = snapshot.instances.map(profileFromInstance)
        await window.electronAPI?.instances.saveProfiles?.(profiles)
      }
    }

    const task = saveQueueRef.current.then(run, run).catch((error) => {
      console.warn('[App] Save failed:', error)
    })
    saveQueueRef.current = task
    return task
  }, [])

  useEffect(() => {
    if (!options.settingsLoaded) return
    if (
      options.legacyCoversDetected &&
      options.profilesLoaded &&
      !migratedLegacyCoversRef.current
    ) {
      migratedLegacyCoversRef.current = true
      void saveAllData()
      return
    }
    const timer = setTimeout(() => { void saveAllData() }, 1500)
    return () => clearTimeout(timer)
  }, [
    options.instances,
    options.themeId,
    options.lang,
    options.preferences,
    options.settingsLoaded,
    options.profilesLoaded,
    options.legacyCoversDetected,
    saveAllData,
  ])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.settings.onFlushBeforeClose?.(() => {
      void saveAllData().finally(() => window.electronAPI?.settings.flushBeforeCloseComplete?.())
    })
    return () => { unsubscribe?.() }
  }, [saveAllData])

  return saveAllData
}
