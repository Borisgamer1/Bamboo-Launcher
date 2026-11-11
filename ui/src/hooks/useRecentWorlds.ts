import { useEffect, useState } from 'react'
import type { Instance } from '../components/InstancesView'
import type { WorldSummary } from '../electron'
import { instanceFolderKeyOf } from '../lib/instanceFolders'
import { worldKey } from '../lib/quickPlay'

export interface RecentWorld {
  key: string
  world: WorldSummary
  instance: Instance
}

const MAX_INSTANCES = 12

/**
 * Reads saves from the instances that were played most recently. Pinned
 * instances are always included, so a favourite world never drops out just
 * because its profile is old.
 */
export function useRecentWorlds(
  instances: Instance[],
  pinned: string[],
): { worlds: RecentWorld[]; loading: boolean } {
  const [worlds, setWorlds] = useState<RecentWorld[]>([])
  const [loading, setLoading] = useState(true)
  const signature = instances
    .map((instance) => `${instance.id}:${instance.lastPlayedAt ?? 0}`)
    .join('|') + `#${pinned.join(',')}`

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const ordered = [...instances].sort(
      (left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0),
    )
    const pinnedFolders = new Set(pinned.map((key) => key.split('/')[0]))
    const targets = ordered.filter(
      (instance, index) =>
        index < MAX_INSTANCES || pinnedFolders.has(instanceFolderKeyOf(instance)),
    )

    void Promise.all(targets.map(async (instance) => {
      try {
        const list = await window.electronAPI?.instances.listWorlds?.(instanceFolderKeyOf(instance))
        return (list ?? []).flatMap((world) => {
          const key = worldKey(instanceFolderKeyOf(instance), world.folderName)
          return [{ key, world, instance }]
        })
      } catch {
        return []
      }
    })).then((groups) => {
      if (cancelled) return
      setWorlds(groups.flat())
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [signature, instances, pinned])

  return { worlds, loading }
}
