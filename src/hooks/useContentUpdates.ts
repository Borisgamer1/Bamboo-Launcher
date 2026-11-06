import { useEffect, useRef, useState } from 'react'
import { categoryForTab } from '../lib/contentCategories'
import { formatMessage, type LanguageType, translations } from '../lib/translations'
import {
  decideUpdate,
  type UpdateDecision,
  type VersionCriteria,
} from '../lib/modVersions'
import { instanceFolderKeyOf } from '../lib/instanceFolders'
import { fetchContentVersions } from '../components/instances/contentDetailModel'
import type { ContentItem, Instance, UpdateTarget } from '../components/instances/instanceModel'

interface UseContentUpdatesOptions {
  inst: Instance
  initialInstanceId: string
  activeTab: string
  lang: LanguageType
  /** Live list of the owning screen; the check must not read state through an updater. */
  contentRef: React.RefObject<ContentItem[]>
  setInst: React.Dispatch<React.SetStateAction<Instance>>
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>
  updateTargets: React.RefObject<Map<string, UpdateTarget>>
  updatingAll: React.RefObject<boolean>
  addToast: (toast: { type: 'success' | 'error' | 'info' | 'warning'; message: string }) => void
}

/**
 * Update check for one instance's content: one batched request, then the
 * per-item decision only for what the batch could not resolve.
 */
export function useContentUpdates({
  inst,
  initialInstanceId,
  activeTab,
  lang,
  contentRef,
  setInst,
  setInstances,
  updateTargets,
  updatingAll,
  addToast,
}: UseContentUpdatesOptions): {
  checkingUpdates: boolean
  checkContentUpdates: (options?: { report?: boolean }) => Promise<void>
} {
  const t = translations[lang]
  const [checkingUpdates, setCheckingUpdates] = useState(false)

  const checkContentUpdates = async (options: { report?: boolean } = {}): Promise<void> => {
    const items = contentRef.current?.length ? contentRef.current : (inst.content || [])
    /** id -> result of this run; merged into the live list instead of swapping it. */
    const checks = new Map<string, { updateAvailable: boolean; versionNumber?: string }>()
    const renamed = new Map<string, string>()
    // Worlds are user data on disk, not a store file that gets replaced in place;
    // a newer "world" release is a different world, so it is not an update.
    const itemsToCheck = items.filter(
      (c) => c.projectId && c.source && c.versionNumber && categoryForTab(c.type) !== 'worlds',
    )
    if (itemsToCheck.length === 0) {
      setCheckingUpdates(false)
      return
    }

    setCheckingUpdates(true)

    const folderName = instanceFolderKeyOf(inst)
    try {
      const scanTypes: { type: string; dir: string }[] = [
        { type: 'mods', dir: 'mods' },
        { type: 'resourcepacks', dir: 'resourcepacks' },
        { type: 'shaderpacks', dir: 'shaderpacks' },
        { type: 'datapacks', dir: 'datapacks' },
      ]
      for (const st of scanTypes) {
        const diskFiles = await window.electronAPI?.mods.listContentFiles?.({ folderName, type: st.dir })
        if (!diskFiles || diskFiles.length === 0) continue
        for (let i = 0; i < items.length; i++) {
          const ci = items[i]
          if (ci.type !== st.type) continue
          const slug = ci.name.toLowerCase().replace(/[^a-z0-9]/g, '')
          const projLower = (ci.projectId || '').toLowerCase()
          if (ci.fileName && diskFiles.includes(ci.fileName)) continue
          const match = diskFiles.find(
            (f: string) => f.toLowerCase().includes(slug) || (projLower && f.toLowerCase().includes(projLower)),
          )
          if (match) renamed.set(ci.id, match)
        }
      }
    } catch (e) {
      console.warn('[Update Check] Fehler beim Scannen der Dateien:', e)
    }

    // One request per 64 jars covers everything Modrinth hosts. Only the rest -
    // CurseForge content and jars it no longer knows - needs a version list each.
    const counts = { updates: 0, current: 0, incompatible: 0 }
    let queue = itemsToCheck
    try {
      const batched = await window.electronAPI?.mods.checkUpdates?.({ folderName })
      if (batched) {
        const resolved = new Set(batched.resolved.map((file) => file.toLowerCase()))
        const updates = new Map(batched.updates.map((entry) => [entry.file.toLowerCase(), entry]))
        queue = []
        for (const item of itemsToCheck) {
          const file = String(item.fileName || '').toLowerCase()
          const hit = updates.get(file)
          if (hit) {
            counts.updates += 1
            updateTargets.current.set(item.id, {
              versionNumber: item.versionNumber,
              version: {
                versionNumber: hit.versionNumber,
                versionId: hit.versionId,
                gameVersions: hit.gameVersions,
                loaders: hit.loaders,
                files: [{ url: hit.url, filename: hit.fileName }],
              },
              file: { url: hit.url, filename: hit.fileName },
            })
            checks.set(item.id, { updateAvailable: true, versionNumber: item.versionNumber })
            continue
          }
          if (resolved.has(file)) {
            counts.current += 1
            updateTargets.current.delete(item.id)
            checks.set(item.id, { updateAvailable: false, versionNumber: item.versionNumber })
            continue
          }
          queue.push(item)
        }
      }
    } catch (e) {
      console.warn('[Update Check] Sammelabfrage fehlgeschlagen, prüfe einzeln:', e)
    }

    const batchSize = 5
    for (let i = 0; i < queue.length; i += batchSize) {
      const batch = queue.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const criteria: VersionCriteria = {
              category: categoryForTab(item.type),
              minecraftVersion: inst.minecraftVersion,
              modloader: inst.modloader,
            }
            const versions = await fetchContentVersions(item)
            const decision: UpdateDecision = decideUpdate(item.versionNumber, versions, criteria)
            return { id: item.id, versionNumber: item.versionNumber, decision }
          } catch (e) {
            console.warn('[Update Check] Fehler beim Prüfen von', item.name, e)
            return null
          }
        }),
      )

      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value) continue
        const { id, versionNumber, decision } = result.value
        if (decision.status === 'update-available') {
          counts.updates += 1
          if (decision.pick.version && decision.pick.file) {
            updateTargets.current.set(id, {
              versionNumber,
              version: decision.pick.version,
              file: decision.pick.file,
            })
          }
        } else {
          if (decision.status === 'current') counts.current += 1
          else counts.incompatible += 1
          updateTargets.current.delete(id)
        }
        checks.set(id, { updateAvailable: decision.status === 'update-available', versionNumber })
      }
    }

    // Merge by id into the live list. Swapping in this run's snapshot used to
    // resurrect the old version of anything updated while the check was running.
    const mergeCheck = (current: ContentItem[]) =>
      current.map((item) => {
        const check = checks.get(item.id)
        const newName = renamed.get(item.id)
        if (!check && !newName) return item
        if (check && check.versionNumber !== item.versionNumber) return item
        return {
          ...item,
          ...(newName ? { fileName: newName } : {}),
          ...(check ? { updateAvailable: check.updateAvailable } : {}),
        }
      })
    setInstances((prev) =>
      prev.map((i) => (i.id === inst.id ? { ...i, content: mergeCheck(i.content || []) } : i)),
    )
    setInst((prev) => ({ ...prev, content: mergeCheck(prev.content || []) }))
    setCheckingUpdates(false)
    if (options.report) {
      addToast({
        type: counts.updates > 0 ? 'success' : 'info',
        message: formatMessage(t.updateCheckSummary, counts),
      })
    }
  }

  const checkRef = useRef(checkContentUpdates)
  useEffect(() => {
    checkRef.current = checkContentUpdates
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkRef.current()
    }, 1000)
    const interval = setInterval(() => {
      if (updatingAll.current) return
      void checkRef.current()
    }, 5 * 60 * 1000)
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [initialInstanceId, activeTab, updatingAll])

  return { checkingUpdates, checkContentUpdates }
}
