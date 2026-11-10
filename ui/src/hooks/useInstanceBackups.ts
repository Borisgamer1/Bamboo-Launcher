import { useCallback, useEffect, useState } from 'react'
import type { InstanceBackup } from '../electron'

interface UseInstanceBackupsOptions {
  folderKey: string
  active: boolean
}

/** Snapshots of worlds and configs, newest first. */
export function useInstanceBackups({
  folderKey,
  active,
}: UseInstanceBackupsOptions): {
  backups: InstanceBackup[] | null
  path: string
  loading: boolean
  refresh: () => Promise<void>
} {
  const [backups, setBackups] = useState<InstanceBackup[] | null>(null)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI?.instances.listBackups?.(folderKey)
      setBackups(result?.success ? result.backups ?? [] : [])
      setPath(result?.path ?? '')
    } catch (error) {
      console.warn('[Backups] Sicherungen konnten nicht gelesen werden:', error)
      setBackups([])
    } finally {
      setLoading(false)
    }
  }, [folderKey])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  return { backups, path, loading, refresh }
}
