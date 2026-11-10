import { LOCAL_THEMES, type ThemeDefinition } from '../data/themes'

export type { ThemeDefinition }

class ThemeService {
  getThemes(): ThemeDefinition[] {
    return LOCAL_THEMES
  }

  getTheme(id: string): ThemeDefinition | undefined {
    return LOCAL_THEMES.find((theme) => theme.id === id)
  }

  getDefaultTheme(): ThemeDefinition {
    return LOCAL_THEMES[0]
  }
}

export const themeService = new ThemeService()
export default themeService
