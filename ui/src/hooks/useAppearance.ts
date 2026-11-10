import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

function readBoolean(key: string, fallback: boolean): boolean {
  const saved = localStorage.getItem(key)
  return saved !== null ? saved !== 'false' : fallback
}

function readInteger(key: string, fallback: number): number {
  const saved = localStorage.getItem(key)
  return saved !== null ? parseInt(saved) : fallback
}

export interface AppearanceState {
  showBgImage: boolean
  setShowBgImage: Dispatch<SetStateAction<boolean>>
  showParticles: boolean
  setShowParticles: Dispatch<SetStateAction<boolean>>
  showGlow: boolean
  setShowGlow: Dispatch<SetStateAction<boolean>>
  mainColor: string
  bgBrightness: number
  setBgBrightness: Dispatch<SetStateAction<number>>
  bgBlur: number
  setBgBlur: Dispatch<SetStateAction<number>>
}

export function useAppearance(): AppearanceState {
  const [showBgImage, setShowBgImage] = useState(() => readBoolean('bamboo-showBgImage', true))
  const [showParticles, setShowParticles] = useState(() => readBoolean('bamboo-showParticles', true))
  const [showGlow, setShowGlow] = useState(() => readBoolean('bamboo-showGlow', true))
  // No renderer control changes this value today; it is read once and only
  // re-written by the persistence pass.
  const [mainColor] = useState(() => localStorage.getItem('bamboo-mainColor') || '')
  const [bgBrightness, setBgBrightness] = useState(() => readInteger('bamboo-bgBrightness', 45))
  const [bgBlur, setBgBlur] = useState(() => readInteger('bamboo-bgBlur', 4))

  useEffect(() => { localStorage.setItem('bamboo-showBgImage', String(showBgImage)) }, [showBgImage])
  useEffect(() => { localStorage.setItem('bamboo-showParticles', String(showParticles)) }, [showParticles])
  useEffect(() => { localStorage.setItem('bamboo-showGlow', String(showGlow)) }, [showGlow])
  useEffect(() => { localStorage.setItem('bamboo-mainColor', mainColor) }, [mainColor])
  useEffect(() => { localStorage.setItem('bamboo-bgBrightness', String(bgBrightness)) }, [bgBrightness])
  useEffect(() => { localStorage.setItem('bamboo-bgBlur', String(bgBlur)) }, [bgBlur])

  return {
    showBgImage,
    setShowBgImage,
    showParticles,
    setShowParticles,
    showGlow,
    setShowGlow,
    mainColor,
    bgBrightness,
    setBgBrightness,
    bgBlur,
    setBgBlur,
  }
}
