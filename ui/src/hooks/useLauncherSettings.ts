import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  normalizePreferences,
  type LauncherPreferences,
} from '../lib/launcherPreferences'
import type { LanguageType } from '../lib/translations'
import {
  DEFAULT_ONBOARDING,
  normalizeOnboarding,
  type OnboardingState,
} from '../lib/onboarding'

export interface LauncherSettingsState {
  preferences: LauncherPreferences
  setPreferences: Dispatch<SetStateAction<LauncherPreferences>>
  lang: LanguageType
  setLang: Dispatch<SetStateAction<LanguageType>>
  statisticsEnabled: boolean
  setStatisticsEnabled: (enabled: boolean) => void
  onboarding: OnboardingState
  saveOnboarding: (patch: Partial<OnboardingState>) => void
  settingsLoaded: boolean
}

interface UseLauncherSettingsOptions {
  setThemeId: (themeId: string) => void
}

export function useLauncherSettings({ setThemeId }: UseLauncherSettingsOptions): LauncherSettingsState {
  const [preferences, setPreferences] = useState<LauncherPreferences>(() => normalizePreferences(undefined))
  const [lang, setLang] = useState<LanguageType>('de')
  const [statisticsEnabled, setStatisticsEnabledState] = useState(true)
  const [onboarding, setOnboarding] = useState<OnboardingState>(DEFAULT_ONBOARDING)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // First-run state is written immediately: a launcher closed right after the
  // tour must not show it again.
  const saveOnboarding = useCallback((patch: Partial<OnboardingState>) => {
    setOnboarding((current) => {
      const next = normalizeOnboarding({ ...current, ...patch })
      void window.electronAPI?.settings
        .save?.({ onboarding: next })
        .catch(() => console.warn('[Bamboo] Failed to save onboarding state'))
      return next
    })
  }, [])

  // Save this flag on its own so main stops (or starts) recording immediately
  // instead of waiting for the debounced full settings pass.
  const setStatisticsEnabled = useCallback((enabled: boolean) => {
    setStatisticsEnabledState(enabled)
    void (async () => {
      try {
        await window.electronAPI?.settings.save?.({ statisticsEnabled: enabled })
      } catch {
        console.warn('[Bamboo] Failed to save statistics setting')
      }
    })()
  }, [])

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
          if (typeof settings.statisticsEnabled === 'boolean') {
            setStatisticsEnabledState(settings.statisticsEnabled)
          }
          setOnboarding(normalizeOnboarding(settings.onboarding))
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

  return {
    preferences,
    setPreferences,
    lang,
    setLang,
    statisticsEnabled,
    setStatisticsEnabled,
    onboarding,
    saveOnboarding,
    settingsLoaded,
  }
}
