import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ServerItem } from '../components/MultiplayerView'

export interface ServersState {
  servers: ServerItem[]
  setServers: Dispatch<SetStateAction<ServerItem[]>>
}

const SERVERS_STORAGE_KEY = 'bamboo-servers'
const DEFAULT_SERVER_ICON =
  'https://api.mineatar.io/face/c06f89064c8a49119c29ea1dbd1aab82?scale=8'

/** Only the durable fields belong in storage; ping state is refreshed on load. */
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
        isPinging: true,
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
      JSON.stringify(servers.map(({ id, name, ip, icon }) => ({ id, name, ip, icon }))),
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

  return { servers, setServers }
}
