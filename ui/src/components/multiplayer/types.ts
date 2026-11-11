export interface ServerItem {
  id: string
  name: string
  ip: string
  motd: string
  onlinePlayers: number
  maxPlayers: number
  ping: number
  version: string
  icon: string
  isPinging?: boolean
  online?: boolean
  lastJoinedAt?: number
  pinned?: boolean
}
