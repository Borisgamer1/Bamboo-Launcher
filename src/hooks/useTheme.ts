import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { themeService } from '../services/themeService'
import type { ThemeDefinition } from '../services/themeService'
import { DEFAULT_THEME_ID } from '../data/themes'

export type ThemeMode = 'preset' | 'custom'

export const DEFAULT_CUSTOM_ACCENT = '#5fbf6a'
export const THEME_MODE_STORAGE_KEY = 'bamboo-theme-mode'
export const CUSTOM_ACCENT_STORAGE_KEY = 'bamboo-custom-accent'
export const CUSTOM_BG_STORAGE_KEY = 'bamboo-custom-bg'

export interface ThemeState {
  themeId: string
  setThemeId: Dispatch<SetStateAction<string>>
  mode: ThemeMode
  setMode: Dispatch<SetStateAction<ThemeMode>>
  customAccent: string
  setCustomAccent: Dispatch<SetStateAction<string>>
  customBg: string
  setCustomBg: Dispatch<SetStateAction<string>>
  availableThemes: ThemeDefinition[]
  currentTheme: ThemeDefinition
  theme: string
}

function readMode(): ThemeMode {
  return localStorage.getItem(THEME_MODE_STORAGE_KEY) === 'custom' ? 'custom' : 'preset'
}

function readAccent(): string {
  const saved = localStorage.getItem(CUSTOM_ACCENT_STORAGE_KEY)
  return saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved : DEFAULT_CUSTOM_ACCENT
}

function readBg(): string {
  return localStorage.getItem(CUSTOM_BG_STORAGE_KEY) || ''
}

export function useTheme(): ThemeState {
  const [themeId, setThemeId] = useState(() => localStorage.getItem('bamboo-theme') || DEFAULT_THEME_ID)
  const [mode, setMode] = useState<ThemeMode>(readMode)
  const [customAccent, setCustomAccent] = useState<string>(readAccent)
  const [customBg, setCustomBg] = useState<string>(readBg)
  const availableThemes = themeService.getThemes()
  const presetTheme =
    themeService.getTheme(themeId) ||
    availableThemes.find((entry) => entry.id === themeId) ||
    themeService.getDefaultTheme()

  const currentTheme: ThemeDefinition =
    mode === 'custom'
      ? {
          id: 'custom',
          name: 'Custom',
          desc: { de: 'Deine eigene Farbe und dein eigenes Hintergrundbild.', en: 'Your own accent and background.' },
          accentLabel: { de: 'Benutzerdefiniert', en: 'Custom' },
          accent: customAccent,
          ...(customBg ? { bgImage: customBg } : {}),
        }
      : presetTheme

  useEffect(() => {
    localStorage.setItem('bamboo-theme', themeId)
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode)
    localStorage.setItem(CUSTOM_ACCENT_STORAGE_KEY, customAccent)
    try {
      localStorage.setItem(CUSTOM_BG_STORAGE_KEY, customBg)
    } catch {
      // A very large background image may not fit; the accent still applies.
    }
    const root = document.documentElement
    const accent = currentTheme.accent || DEFAULT_CUSTOM_ACCENT
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 85%, white)`)
    root.style.setProperty('--accent-press', `color-mix(in srgb, ${accent} 82%, black)`)
    root.style.setProperty('--accent-contrast', '#0b0d0b')
  }, [themeId, mode, customAccent, customBg, currentTheme.accent])

  return {
    themeId,
    setThemeId,
    mode,
    setMode,
    customAccent,
    setCustomAccent,
    customBg,
    setCustomBg,
    availableThemes,
    currentTheme,
    theme: currentTheme.id,
  }
}
