import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BambooApi } from '../electron-api'

export interface Account {
  id: string
  username: string
  type: 'Microsoft' | 'Offline'
  avatar: string
  online: boolean
  uuid?: string
  active?: boolean
}

export class AuthUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthUnavailableError'
  }
}

const MISSING_HANDLER = /No handler registered/i

function missingHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return MISSING_HANDLER.test(message)
}

export async function readAuthStatus(
  api: BambooApi['auth'] | undefined,
): Promise<MicrosoftAuthStatus | null> {
  if (typeof api?.status !== 'function') {
    throw new AuthUnavailableError('The auth bridge is not available.')
  }
  try {
    return (await api.status()) ?? null
  } catch (error) {
    if (missingHandler(error)) throw new AuthUnavailableError('The auth handlers are not registered.')
    return null
  }
}

export function accountFromStatus(status: MicrosoftAuthStatus | null): Account | null {
  if (!status?.signedIn || !status.account) return null
  const { id, name, uuid, avatar } = status.account
  return {
    id,
    username: name,
    type: 'Microsoft',
    avatar,
    online: true,
    uuid,
    active: true,
  }
}

export interface AccountSession {
  status: MicrosoftAuthStatus | null
  account: Account | null
  unavailable: boolean
  apply: (status: MicrosoftAuthStatus) => void
  reload: () => Promise<void>
}

/**
 * Last known auth status.
 *
 * The real status costs a keyring read plus a token check; until it arrives the
 * start page showed "no account" and no 3D figure. The cached copy renders that
 * part immediately, the fresh answer replaces it a moment later.
 */
const STATUS_CACHE_KEY = 'bamboo-auth-status'

function readCachedStatus(): MicrosoftAuthStatus | null {
  try {
    const raw = localStorage.getItem(STATUS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MicrosoftAuthStatus
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeCachedStatus(status: MicrosoftAuthStatus | null): void {
  try {
    if (status) localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status))
    else localStorage.removeItem(STATUS_CACHE_KEY)
  } catch {
    /* cache is best effort */
  }
}

export function useAccountSession(): AccountSession {
  const [status, setStatus] = useState<MicrosoftAuthStatus | null>(() => readCachedStatus())
  const [unavailable, setUnavailable] = useState(false)

  const reload = useCallback(async () => {
    try {
      const next = await readAuthStatus(window.electronAPI?.auth)
      if (!next) return
      setStatus(next)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    }
  }, [])

  useEffect(() => {
    let active = true
    readAuthStatus(window.electronAPI?.auth)
      .then((next) => {
        if (!active || !next) return
        setStatus(next)
        setUnavailable(false)
      })
      .catch(() => {
        if (active) setUnavailable(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.auth.onStatus?.((next) => {
      setStatus(next)
      setUnavailable(false)
    })
    return () => unsubscribe?.()
  }, [])

  const apply = useCallback((next: MicrosoftAuthStatus) => {
    setStatus(next)
    writeCachedStatus(next)
    setUnavailable(false)
  }, [])

  useEffect(() => {
    writeCachedStatus(status)
  }, [status])
  const account = useMemo(() => accountFromStatus(status), [status])

  return { status, account, unavailable, apply, reload }
}
