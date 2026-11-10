import { useEffect, useState } from 'react'
import {
  applyLauncherFont,
  readLauncherFont,
  saveLauncherFont,
  type LauncherFont,
} from '../lib/launcherFont'

export interface LauncherFontState {
  launcherFont: LauncherFont
  setLauncherFont: (font: LauncherFont) => void
}

function readStoredFont(): LauncherFont {
  try {
    return readLauncherFont(window.localStorage)
  } catch {
    return 'normal'
  }
}

export function useLauncherFont(): LauncherFontState {
  const [launcherFont, setLauncherFont] = useState<LauncherFont>(readStoredFont)

  useEffect(() => {
    applyLauncherFont(launcherFont)
    try {
      saveLauncherFont(launcherFont, window.localStorage)
    } catch {
      // The choice still applies for this session.
    }
  }, [launcherFont])

  return { launcherFont, setLauncherFont }
}
