import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  normalizePreferences,
  type LauncherPreferences,
} from '../lib/launcherPreferences'
import type { LanguageType } from '../lib/translations'

export interface LauncherSettingsState {
  preferences: LauncherPreferences
  setPreferences: Dispatch<SetStateAction<LauncherPreferences>>
  lang: LanguageType
  setLang: Dispatch<SetStateAction<LanguageType>>
  settingsLoaded: boolean
}

interface UseLauncherSettingsOptions {
  setThemeId: (themeId: string) => void
}

export function useLauncherSettings({ setThemeId }: UseLauncherSettingsOptions): LauncherSettingsState {
  const [preferences, setPreferences] = useState<LauncherPreferences>(() => normalizePreferences(undefined))
  const [lang, setLang] = useState<LanguageType>('de')
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (attempt = 0) => {
      try {
        const settings = await window.electronAPI?.settings.get?.()
        if (cancelled) return
        if (settings) {
          if (typeof settings.currentTheme === 'string') {
            setThemeId(settings.currentTheme)
          }
          if (typeof settings.lang === 'string' && (settings.lang === 'de' || settings.lang === 'en')) {
            setLang(settings.lang)
          }
          if (settings.preferences) {
            setPreferences(normalizePreferences(settings.preferences))
          }
          setSettingsLoaded(true)
          return
        }
      } catch {
        console.warn('[Bamboo] Failed to load settings')
      }
      if (!cancelled && attempt < 60) {
        timer = setTimeout(() => { void load(attempt + 1) }, 250)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [setThemeId])

  return { preferences, setPreferences, lang, setLang, settingsLoaded }
}
