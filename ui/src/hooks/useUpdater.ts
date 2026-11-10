import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '../electron'

export interface UpdaterState {
  status: UpdateStatus | null
  check: () => Promise<void>
  install: () => Promise<void>
}

/**
 * One click from "check" to "restart": the core downloads and verifies the
 * package while it reports progress here, and `install` applies it and
 * relaunches.
 */
export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    const api = window.electronAPI?.updates
    if (!api) return
    let active = true

    api
      .state?.()
      .then((next) => {
        if (active && next) setStatus((previous) => previous ?? next)
      })
      .catch(() => {
        // A missing updater is a supported state (development build).
      })

    const unsubscribe = api.onStatus?.((next) => {
      if (active) setStatus(next)
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const check = useCallback(async () => {
    try {
      const next = await window.electronAPI?.updates.check?.()
      if (next) setStatus(next)
    } catch {
      // The core reports failures as a status; a rejected call keeps the last
      // known status instead of clearing it.
    }
  }, [])

  const install = useCallback(async () => {
    try {
      await window.electronAPI?.updates.install?.()
    } catch {
      // Installing tears the process down on Windows before the promise settles.
    }
  }, [])

  return { status, check, install }
}
