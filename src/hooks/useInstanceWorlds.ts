import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldSummary } from '../electron'

interface UseInstanceWorldsOptions {
  folderKey: string
  active: boolean
  onDetected?: (count: number) => void
}

async function readWorlds(folderKey: string): Promise<WorldSummary[]> {
  try {
    const list = await window.electronAPI?.instances.listWorlds?.(folderKey)
    return Array.isArray(list) ? list : []
  } catch (error) {
    console.warn('[Instances] Welten konnten nicht gelesen werden:', error)
    return []
  }
}

/** Worlds live on disk (saves/<world>/level.dat), not in the profile content list. */
export function useInstanceWorlds({
  folderKey,
  active,
  onDetected,
}: UseInstanceWorldsOptions): {
  worlds: WorldSummary[] | null
  refresh: () => Promise<WorldSummary[]>
} {
  // The key keeps a previous instance's list from flashing after a switch.
  const [state, setState] = useState<{ key: string; list: WorldSummary[] } | null>(null)
  const onDetectedRef = useRef(onDetected)
  useEffect(() => {
    onDetectedRef.current = onDetected
  })

  const refresh = useCallback(async (): Promise<WorldSummary[]> => {
    const list = await readWorlds(folderKey)
    setState({ key: folderKey, list })
    onDetectedRef.current?.(list.length)
    return list
  }, [folderKey])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void readWorlds(folderKey).then((list) => {
      if (cancelled) return
      setState({ key: folderKey, list })
      onDetectedRef.current?.(list.length)
    })
    return () => {
      cancelled = true
    }
  }, [active, folderKey])

  return { worlds: state?.key === folderKey ? state.list : null, refresh }
}
