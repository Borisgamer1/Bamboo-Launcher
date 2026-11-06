import type { Instance } from '../components/InstancesView'
import type { ModrinthHit, ModrinthVersion } from '../components/mods/modDetailModel'
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
} from '../lib/backgroundTasks'
import { uniqueInstanceFolder, uniqueInstanceName } from '../lib/instanceFolders'
import { mainErrorText } from '../lib/mainErrors'
import {
  buildModpackContentItems,
  mergeOverrideContentItems,
  resolveModpackContentMetadata,
  type ModpackIndexFile,
} from '../lib/modpackContent'
import { modpackLoaderLabel, pickModpackVersion, type ModpackLoader } from '../lib/modpackVersions'
import type { LanguageType } from '../lib/translations'

function createInstanceId(): string {
  return `inst-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

interface UseModpackInstallOptions {
  lang: LanguageType
  instances: Instance[]
  setInstances?: React.Dispatch<React.SetStateAction<Instance[]>>
  setInstallingModId: (id: string | null) => void
  setInstallProgress: (percent: number) => void
  addToast: (toast: { type: 'success' | 'error' | 'warning' | 'info'; message: string }) => void
}

async function getLatestModpackVersion(
  mod: ModrinthHit,
  preferredGameVersion?: string,
): Promise<{ url: string; mcVersion: string; loader: ModpackLoader; versionNumber: string } | null> {
  try {
    const res = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version`)
    if (!res.ok) return null
    const data = (await res.json()) as ModrinthVersion[]
    const latest = pickModpackVersion(data, {
      ...(preferredGameVersion ? { gameVersion: preferredGameVersion } : {}),
    })
    if (!latest) return null
    return {
      url: latest.url,
      mcVersion: latest.mcVersion,
      loader: latest.loader,
      versionNumber: latest.versionNumber,
    }
  } catch {
    return null
  }
}

/** A modpack is a whole instance: create it, install the pack, resolve its metadata. */
export function useModpackInstall({
  lang,
  instances,
  setInstances,
  setInstallingModId,
  setInstallProgress,
  addToast,
}: UseModpackInstallOptions): (mod: ModrinthHit, preferredGameVersion?: string) => Promise<void> {
  return async (mod, preferredGameVersion) => {
    setInstallingModId(mod.project_id)
    setInstallProgress(3)
    const newId = createInstanceId()
    let addedInstance = false
    let unsubscribeProgress: (() => void) | undefined
    let backgroundTaskId = ''
    let installFailure = ''
    try {
      const versionInfo = await getLatestModpackVersion(mod, preferredGameVersion)
      if (!versionInfo) {
        addToast({
          type: 'error',
          message:
            lang === 'de'
              ? `Keine gültige Modpack-Version für ${mod.title}${preferredGameVersion ? ` und Minecraft ${preferredGameVersion}` : ''} gefunden`
              : `No valid modpack version found for ${mod.title}${preferredGameVersion ? ` and Minecraft ${preferredGameVersion}` : ''}`,
        })
        return
      }
      // Same modpack, second version (or a second copy) gets its own folder and
      // a name that names the version, so both instances stay distinguishable.
      const folderName = uniqueInstanceFolder(
        `${mod.slug}-${versionInfo.mcVersion}-${versionInfo.versionNumber}`,
        instances,
      )
      const nameTaken = instances.some(
        (instance) => instance.name.trim().toLowerCase() === mod.title.trim().toLowerCase(),
      )
      const instanceName = nameTaken
        ? uniqueInstanceName(`${mod.title} (${versionInfo.versionNumber})`, instances)
        : mod.title
      backgroundTaskId = `modpack:${folderName}`
      beginBackgroundTask({
        id: backgroundTaskId,
        title:
          lang === 'de'
            ? `${mod.title} ${versionInfo.versionNumber} wird installiert…`
            : `Installing ${mod.title} ${versionInfo.versionNumber}…`,
        detail: versionInfo.versionNumber,
        percent: 3,
      })
      setInstallProgress(6)
      const newInst: Instance = {
        id: newId,
        folderName,
        name: instanceName,
        minecraftVersion: versionInfo.mcVersion,
        modloader: modpackLoaderLabel(versionInfo.loader),
        modloaderVersion: '',
        lastPlayed: 'Gerade eben',
        size: 'Modpack wird installiert...',
        modCount: 0,
        thumbnail: mod.icon_url || '',
        desc: mod.description,
        javaVersion: 'Automatisch',
        installedMods: [],
        content: [],
        ram: 6144,
        isModpack: true,
        modpackProjectId: mod.project_id,
        modpackSource: 'modrinth',
        modpackVersion: versionInfo.versionNumber,
      }
      if (setInstances) {
        setInstances((prev) => [newInst, ...prev])
        addedInstance = true
      }
      unsubscribeProgress = window.electronAPI?.mods.onModpackProgress?.((data) => {
        if (data?.folderName === folderName && Number.isFinite(data.percent)) {
          setInstallProgress(Math.max(0, Math.min(100, Math.round(data.percent))))
        }
      })
      const result = await window.electronAPI?.mods.installModpack?.({
        folderName,
        mcVersion: versionInfo.mcVersion,
        loader: versionInfo.loader,
        mrpackUrl: versionInfo.url,
        mode: 'install',
      })
      if (!result?.success) {
        if (addedInstance && setInstances) {
          setInstances((prev) => prev.filter((instance) => instance.id !== newId))
        }
        installFailure = mainErrorText(
          result,
          lang,
          lang === 'de' ? 'Modpack-Installation fehlgeschlagen' : 'Modpack installation failed',
        )
        addToast({
          type: 'error',
          message: installFailure,
        })
        return
      }

      let defaultRam = 6144
      try {
        const settings = await window.electronAPI?.settings.get?.()
        if (settings?.defaultRam && typeof settings.defaultRam === 'number') {
          defaultRam = settings.defaultRam
        }
      } catch {
        // Fall back to the default RAM when settings cannot be read.
      }
      const fileList = (result.index?.files || []) as ModpackIndexFile[]
      const contentItems = mergeOverrideContentItems(
        buildModpackContentItems(fileList),
        result.overrideFiles || [],
      )
      const installedSlugs = contentItems
        .map((item) => item.projectId)
        .filter((slug): slug is string => Boolean(slug))
      if (setInstances) {
        setInstances((prev) =>
          prev.map((instance) =>
            instance.id === newId
              ? {
                  ...instance,
                  ...(result.loader ? { modloader: modpackLoaderLabel(result.loader) } : {}),
                  folderName: result.folderName || instance.folderName,
                  minecraftVersion: result.mcVersion || instance.minecraftVersion,
                  modloaderVersion: result.loaderVersion || instance.modloaderVersion || '',
                  modCount: contentItems.filter((item) => item.type === 'mods').length,
                  size: `${contentItems.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
                  content: contentItems,
                  installedMods: installedSlugs,
                  ram: defaultRam,
                }
              : instance,
          ),
        )
      }
      setInstallProgress(100)

      // Project pages, icons and versions arrive after the pack is usable, so a
      // slow metadata lookup never delays or fails the installation.
      void resolveModpackContentMetadata(fileList)
        .then((metadata) => {
          if (!setInstances || Object.keys(metadata).length === 0) return
          const enriched = mergeOverrideContentItems(
            buildModpackContentItems(fileList, metadata),
            result.overrideFiles || [],
          )
          const enrichedSlugs = enriched
            .map((item) => item.projectId)
            .filter((slug): slug is string => Boolean(slug))
          setInstances((prev) =>
            prev.map((instance) =>
              instance.id === newId
                ? {
                    ...instance,
                    content: enriched,
                    installedMods: enrichedSlugs,
                    modCount: enriched.filter((item) => item.type === 'mods').length,
                  }
                : instance,
            ),
          )
        })
        .catch(() => {
          // File-name entries remain a complete, usable fallback.
        })
      addToast({
        type: 'success',
        message: lang === 'de' ? `${mod.title} wurde installiert.` : `${mod.title} was installed.`,
      })
    } catch (e) {
      if (addedInstance && setInstances) {
        setInstances((prev) => prev.filter((instance) => instance.id !== newId))
      }
      installFailure = e instanceof Error ? e.message : 'Modpack-Installation fehlgeschlagen'
      addToast({ type: 'error', message: installFailure })
    } finally {
      if (backgroundTaskId) {
        if (installFailure) failBackgroundTask(backgroundTaskId, installFailure)
        else completeBackgroundTask(backgroundTaskId)
      }
      unsubscribeProgress?.()
      setInstallingModId(null)
      setInstallProgress(0)
    }
  }
}
