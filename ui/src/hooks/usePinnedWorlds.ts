import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'bamboo-pinned-worlds'

function readPinnedWorlds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** Pins live next to the launcher, not in the save folder. */
export function usePinnedWorlds(): {
  pinned: string[]
  togglePinned: (key: string) => void
} {
  const [pinned, setPinned] = useState<string[]>(readPinnedWorlds)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned))
    } catch {
      // A full storage must not break the start page.
    }
  }, [pinned])

  const togglePinned = useCallback((key: string) => {
    setPinned((prev) => prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key])
  }, [])

  return { pinned, togglePinned }
}
