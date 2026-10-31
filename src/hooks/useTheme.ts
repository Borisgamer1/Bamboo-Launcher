import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { themeService } from '../services/themeService'
import type { ThemeDefinition } from '../services/themeService'

export interface ThemeState {
  themeId: string
  setThemeId: Dispatch<SetStateAction<string>>
  availableThemes: ThemeDefinition[]
  currentTheme: ThemeDefinition
  theme: string
}

export function useTheme(): ThemeState {
  const [themeId, setThemeId] = useState(() => localStorage.getItem('bamboo-theme') || 'bamboo')
  const availableThemes = themeService.getThemes()
  const currentTheme =
    themeService.getTheme(themeId) ||
    availableThemes.find((entry) => entry.id === themeId) ||
    themeService.getDefaultTheme()
  const theme = currentTheme.id

  useEffect(() => {
    localStorage.setItem('bamboo-theme', themeId)
    const root = document.documentElement
    const accent = currentTheme.accent || '#7cd98b'
    root.style.setProperty('--accent', accent)
    root.style.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 85%, white)`)
    root.style.setProperty('--accent-press', `color-mix(in srgb, ${accent} 82%, black)`)
    root.style.setProperty('--accent-contrast', '#0b0d0b')
  }, [themeId, currentTheme.accent])

  return { themeId, setThemeId, availableThemes, currentTheme, theme }
}
