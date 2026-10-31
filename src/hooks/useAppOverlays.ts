import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isDialogOpen } from '../components/dialogSupport'
import { useHotkeys } from '../lib/useHotkeys'

export interface AppOverlaysState {
  showExitModal: boolean
  setShowExitModal: Dispatch<SetStateAction<boolean>>
  paletteOpen: boolean
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
}

export function useAppOverlays(): AppOverlaysState {
  const [showExitModal, setShowExitModal] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useHotkeys((event) => {
    if (event.repeat) return
    if (!(event.ctrlKey || event.metaKey)) return
    const isToggle = event.key.toLowerCase() === 'k' || (event.ctrlKey && event.code === 'Space')
    if (!isToggle) return
    if (isDialogOpen()) return
    event.preventDefault()
    setPaletteOpen((open) => !open)
  })

  return { showExitModal, setShowExitModal, paletteOpen, setPaletteOpen }
}
