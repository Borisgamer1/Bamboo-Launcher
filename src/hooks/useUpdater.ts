import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '../electron'

export interface UpdaterState {
  status: UpdateStatus | null
  check: () => Promise<void>
  install: () => Promise<void>
}

export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    const api = window.electronAPI?.updates
    if (!api) return
    let active = true

    api.state?.().then((next) => {
      if (active && next) setStatus((previous) => previous ?? next)
    }).catch(() => {
      // A missing updater is a supported state (development / older build).
    })

    const unsubscribe = api.onStatus?.((next) => {
      if (active && next) setStatus(next)
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
      // The status event carries the failure details; the UI must not crash.
    }
  }, [])

  const install = useCallback(async () => {
    try {
      await window.electronAPI?.updates.install?.()
    } catch {
      // quitAndInstall can tear the process down before the promise settles.
    }
  }, [])

  return { status, check, install }
}
