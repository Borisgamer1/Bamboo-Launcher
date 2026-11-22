import { useCallback, useEffect, useState } from 'react'

/** Global Bamboo Client switch, persisted by the Rust core in `client.json`. */
export function useClientMode() {
  const [clientMode, setClientMode] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI?.client
      .state()
      .then((state) => {
        if (!cancelled && state) setClientMode(state.enabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const setClientEnabled = useCallback((enabled: boolean) => {
    // Optimistic: the switch must not wait for disk I/O.
    setClientMode(enabled)
    void window.electronAPI?.client
      .setEnabled(enabled)
      .then((state) => {
        if (state) setClientMode(state.enabled)
      })
      .catch(() => setClientMode((current) => current))
  }, [])

  return { clientMode, setClientEnabled }
}
