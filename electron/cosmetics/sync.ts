/**
 * Cosmetics sync status.
 *
 * The relay itself belongs to the mod: players publish their loadout there and
 * read each other's once a minute. The launcher never sends a loadout; it only
 * reports whether that relay is reachable, so the cosmetics tab can say whether
 * other players will see what is equipped.
 */

const RELAY = 'https://bamboo-cosmetics-relay.borisgamer301.workers.dev/'

export interface CosmeticSyncStatus {
  relay: string
  online: boolean
  error?: string
}

export async function syncStatus(): Promise<CosmeticSyncStatus> {
  try {
    const response = await fetch(RELAY, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) {
      return { relay: RELAY, online: false, error: `HTTP ${response.status}` }
    }
    return { relay: RELAY, online: true }
  } catch (error) {
    return {
      relay: RELAY,
      online: false,
      error: error instanceof Error ? error.message : 'unbekannt',
    }
  }
}
