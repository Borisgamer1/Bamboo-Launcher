import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ServerItem } from '../components/multiplayer/types'

export interface ServersState {
  servers: ServerItem[]
  setServers: Dispatch<SetStateAction<ServerItem[]>>
  markJoined: (id: string) => void
  togglePinned: (id: string) => void
}

const SERVERS_STORAGE_KEY = 'bamboo-servers'
const DEFAULT_SERVER_ICON =
  'https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8'

/**
 * Only the durable fields belong in storage. A restored server starts with no
 * status at all; it is looked up when the user explicitly refreshes the list.
 */
function readSavedServers(): ServerItem[] {
  try {
    const raw = localStorage.getItem(SERVERS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return []
      const saved = entry as Record<string, unknown>
      const name = typeof saved.name === 'string' ? saved.name.trim() : ''
      const ip = typeof saved.ip === 'string' ? saved.ip.trim() : ''
      if (!name || !ip) return []
      return [{
        id: typeof saved.id === 'string' && saved.id ? saved.id : `saved_${index}`,
        name,
        ip,
        motd: '',
        onlinePlayers: 0,
        maxPlayers: 0,
        ping: 0,
        version: '',
        icon: typeof saved.icon === 'string' && saved.icon ? saved.icon : DEFAULT_SERVER_ICON,
        isPinging: false,
        lastJoinedAt: typeof saved.lastJoinedAt === 'number' ? saved.lastJoinedAt : undefined,
        pinned: saved.pinned === true,
      }]
    })
  } catch {
    return []
  }
}

function writeSavedServers(servers: ServerItem[]): void {
  try {
    localStorage.setItem(
      SERVERS_STORAGE_KEY,
      JSON.stringify(servers.map(({ id, name, ip, icon, lastJoinedAt, pinned }) => ({
        id,
        name,
        ip,
        icon,
        ...(lastJoinedAt ? { lastJoinedAt } : {}),
        ...(pinned ? { pinned: true } : {}),
      }))),
    )
  } catch {
    // A full or unavailable localStorage must not break the server list.
  }
}

export function useServers(): ServersState {
  const [servers, setServers] = useState<ServerItem[]>(readSavedServers)

  useEffect(() => {
    writeSavedServers(servers)
  }, [servers])

  const markJoined = useCallback((id: string) => {
    setServers((prev) => prev.map((server) =>
      server.id === id ? { ...server, lastJoinedAt: Date.now() } : server,
    ))
  }, [])

  const togglePinned = useCallback((id: string) => {
    setServers((prev) => prev.map((server) =>
      server.id === id ? { ...server, pinned: !server.pinned } : server,
    ))
  }, [])

  return { servers, setServers, markJoined, togglePinned }
}
