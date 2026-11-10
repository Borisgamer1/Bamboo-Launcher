import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { LAUNCHER_VERSION } from '../lib/version'
import {
  buildModpackContentItems,
  mergeOverrideContentItems,
  type ModpackIndexFile,
} from '../lib/modpackContent'
import {
  modpackLoaderLabel,
  toModpackVersion,
  type ModrinthVersionLike,
} from '../lib/modpackVersions'
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  updateBackgroundTask,
} from '../lib/backgroundTasks'
import { instanceFolderKeyOf } from '../lib/instanceFolders'
import {
  errorMessage,
  type ContentItem,
  type Instance,
} from '../components/instances/instanceModel'
import type { LanguageType } from '../lib/translations'

interface UseUpdateAllModpacksOptions {
  instances: Instance[]
  setInstances: Dispatch<SetStateAction<Instance[]>>
  lang: LanguageType
  addToast: (toast: {
    type: 'success' | 'error' | 'info' | 'warning'
    message: string
  }) => void
}

async function latestPackVersion(projectId: string) {
  const response = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
    headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
  })
  if (!response.ok) return undefined
  const data: unknown = await response.json()
  if (!Array.isArray(data) || data.length === 0) return undefined

  return (data as ModrinthVersionLike[])
    .map((version) => toModpackVersion(version))
    .filter((version): version is NonNullable<typeof version> => Boolean(version))
    .sort((a, b) => {
      const typeOrder =
        Number(a.versionType !== 'release') - Number(b.versionType !== 'release')
      return typeOrder || new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime()
    })[0]
}

/**
 * Checks every Modrinth pack and updates the ones with a newer version.
 * CurseForge packs are skipped: their files need the API key flow that the
 * single-pack update already handles explicitly.
 */
export function useUpdateAllModpacks({
  instances,
  setInstances,
  lang,
  addToast,
}: UseUpdateAllModpacksOptions) {
  const [updating, setUpdating] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const packs = instances.filter(
    (instance) => instance.isModpack && instance.modpackProjectId && instance.modpackSource !== 'curseforge',
  )
  const skipped = instances.filter(
    (instance) =>
      instance.isModpack &&
      (!instance.modpackProjectId || instance.modpackSource === 'curseforge'),
  ).length

  const updateAll = async () => {
    if (updating) return
    if (packs.length === 0) {
      addToast({
        type: 'info',
        message:
          lang === 'de'
            ? 'Keine Modrinth-Modpacks zum Prüfen. CurseForge-Packs werden einzeln aktualisiert.'
            : 'No Modrinth packs to check. CurseForge packs are updated individually.',
      })
      return
    }

    const taskId = 'modpack:all'
    setUpdating(true)
    setProgress({ done: 0, total: packs.length })
    beginBackgroundTask({
      id: taskId,
      title: lang === 'de' ? 'Modpacks werden aktualisiert…' : 'Updating modpacks…',
      detail: lang === 'de' ? `${packs.length} Packs werden geprüft` : `Checking ${packs.length} packs`,
      percent: 0,
    })

    let updated = 0
    let current = 0
    let failed = 0

    for (let index = 0; index < packs.length; index += 1) {
      const instance = packs[index]
      updateBackgroundTask(taskId, {
        percent: Math.round((index / packs.length) * 100),
        detail: instance.name,
      })

      try {
        const latest = await latestPackVersion(instance.modpackProjectId!)
        if (!latest) {
          failed += 1
        } else if (latest.versionNumber === instance.modpackVersion) {
          current += 1
        } else {
          const result = await window.electronAPI?.mods.installModpack?.({
            folderName: instanceFolderKeyOf(instance),
            mcVersion: latest.mcVersion,
            loader: latest.loader,
            mrpackUrl: latest.url,
            mode: 'update',
          })
          if (!result?.success) {
            failed += 1
          } else {
            const content = mergeOverrideContentItems(
              buildModpackContentItems((result.index?.files || []) as ModpackIndexFile[]),
              result.overrideFiles || [],
            ) as ContentItem[]
            setInstances((previous) =>
              previous.map((entry) =>
                entry.id === instance.id
                  ? {
                      ...entry,
                      folderName: result.folderName || entry.folderName,
                      minecraftVersion: result.mcVersion || entry.minecraftVersion,
                      modloader: result.loader
                        ? modpackLoaderLabel(result.loader)
                        : entry.modloader,
                      modloaderVersion: result.loaderVersion || entry.modloaderVersion,
                      modCount: content.filter((item) => item.type === 'mods').length,
                      size:
                        lang === 'de'
                          ? `${content.length} Inhalte`
                          : `${content.length} items`,
                      content,
                      modpackVersion: latest.versionNumber,
                    }
                  : entry,
              ),
            )
            updated += 1
          }
        }
      } catch (error) {
        console.warn('[Modpack Update] Batch failed for', instance.name, errorMessage(error))
        failed += 1
      }

      setProgress({ done: index + 1, total: packs.length })
      updateBackgroundTask(taskId, {
        percent: Math.round(((index + 1) / packs.length) * 100),
        detail: instance.name,
      })
    }

    setUpdating(false)
    setProgress(null)

    if (failed === packs.length) {
      failBackgroundTask(taskId, lang === 'de' ? 'Kein Pack konnte geprüft werden.' : 'No pack could be checked.')
      addToast({
        type: 'error',
        message:
          lang === 'de'
            ? 'Kein Pack konnte aktualisiert werden.'
            : 'No pack could be updated.',
      })
      return
    }

    completeBackgroundTask(taskId)
    const parts =
      lang === 'de'
        ? [
            `${updated} aktualisiert`,
            `${current} aktuell`,
            failed > 0 ? `${failed} fehlgeschlagen` : '',
            skipped > 0 ? `${skipped} übersprungen` : '',
          ]
        : [
            `${updated} updated`,
            `${current} up to date`,
            failed > 0 ? `${failed} failed` : '',
            skipped > 0 ? `${skipped} skipped` : '',
          ]
    addToast({
      type: failed > 0 ? 'warning' : 'success',
      message: parts.filter(Boolean).join(' · '),
    })
  }

  return { updating, progress, updateAll }
}
