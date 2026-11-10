import { useEffect, useState } from 'react'
import { translations, type LanguageType } from '../lib/translations'
import { mainErrorText } from '../lib/mainErrors'
import {
  buildModpackContentItems,
  mergeOverrideContentItems,
  type ModpackIndexFile,
} from '../lib/modpackContent'
import { modpackLoaderLabel, toModpackVersion, type ModpackLoader } from '../lib/modpackVersions'
import { fromModrinthVersion, pickVersion } from '../lib/modVersions'
import { LAUNCHER_VERSION } from '../lib/version'
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
} from '../lib/backgroundTasks'
import { instanceFolderKeyOf, uniqueInstanceFolder, uniqueInstanceName } from '../lib/instanceFolders'
import { errorMessage, type ContentItem, type Instance } from '../components/instances/instanceModel'
import type { InstallModpackResult } from '../electron'

interface ModrinthVersionList {
  id?: string
  version_number: string
  version_type?: string
  date_published: string
  game_versions?: string[]
  loaders?: string[]
  files?: { url: string; filename: string; primary?: boolean; size?: number }[]
}

export interface ModpackUpdateVersion {
  version_number: string
  date_published: string
  url: string
  mcVersion: string
  loader: ModpackLoader
  versionType: 'release' | 'beta' | 'alpha'
}

interface UseModpackUpdateOptions {
  inst: Instance
  instances: Instance[]
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>
  /** The screen keeps its own copy of the instance; keep it in step with the register. */
  setInst: React.Dispatch<React.SetStateAction<Instance>>
  lang: LanguageType
  addToast: (toast: { type: 'success' | 'error' | 'info' | 'warning'; message: string }) => void
}

/** Version lookup and the three ways to move a modpack instance to another version. */
export function useModpackUpdate({
  inst,
  instances,
  setInstances,
  setInst,
  lang,
  addToast,
}: UseModpackUpdateOptions) {
  const t = translations[lang]
  const [modpackUpdateAvailable, setModpackUpdateAvailable] = useState(false)
  const [modpackCheckingUpdates, setModpackCheckingUpdates] = useState(
    () => Boolean(inst.isModpack && inst.modpackProjectId),
  )
  const [modpackVersions, setModpackVersions] = useState<ModpackUpdateVersion[]>([])
  const [showModpackUpdateModal, setShowModpackUpdateModal] = useState(false)
  const [showModpackUpdateOptions, setShowModpackUpdateOptions] = useState(false)
  const [selectedModpackVersion, setSelectedModpackVersion] = useState('')
  const [modpackUpdateInstalling, setModpackUpdateInstalling] = useState(false)
  const [modpackUpdateProgress, setModpackUpdateProgress] = useState('')

  useEffect(() => {
    if (!inst.isModpack || !inst.modpackProjectId) return
    void (async () => {
      try {
        const res = await fetch(`https://api.modrinth.com/v2/project/${inst.modpackProjectId}/version`, {
          headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
        })
        if (!res.ok) return
        const data = await res.json()
        if (!Array.isArray(data) || data.length === 0) return

        const packVersions = (data as ModrinthVersionList[])
          .map((version) => {
            const summary = toModpackVersion(version)
            return summary ? {
              version_number: summary.versionNumber,
              date_published: summary.datePublished,
              url: summary.url,
              mcVersion: summary.mcVersion,
              loader: summary.loader,
              versionType: summary.versionType,
            } : null
          })
          .filter((version): version is ModpackUpdateVersion => Boolean(version))
          .sort((a, b) => {
            const typeOrder = Number(a.versionType !== 'release') - Number(b.versionType !== 'release')
            return typeOrder || new Date(b.date_published).getTime() - new Date(a.date_published).getTime()
          })

        setModpackVersions(packVersions)

        if (packVersions.length > 0 && packVersions[0].version_number !== inst.modpackVersion) {
          setModpackUpdateAvailable(true)
        }
      } catch (e) {
        console.warn('[Modpack Update] Fehler beim Prüfen', e)
      } finally {
        setModpackCheckingUpdates(false)
      }
    })()
  }, [inst.isModpack, inst.modpackProjectId, inst.modpackVersion])

  const applyToCurrent = (patch: Partial<Instance>) => {
    setInstances(prev => prev.map(i => (i.id === inst.id ? { ...i, ...patch } : i)))
    setInst(prev => ({ ...prev, ...patch }))
  }

  const selectedVersion = () =>
    modpackVersions.find(v => v.version_number === selectedModpackVersion)

  const installPack = (
    folderName: string,
    versionData: ModpackUpdateVersion,
    mode: 'install' | 'update',
  ) =>
    window.electronAPI?.mods.installModpack?.({
      folderName,
      mcVersion: versionData.mcVersion,
      loader: versionData.loader,
      mrpackUrl: versionData.url,
      mode,
    })

  const contentFromInstall = (result: InstallModpackResult | undefined): ContentItem[] =>
    mergeOverrideContentItems(
      buildModpackContentItems((result?.index?.files || []) as ModpackIndexFile[]),
      result?.overrideFiles || [],
    ) as ContentItem[]

  /**
   * Shared lifecycle for every pack move: task bar, error path and resetting the
   * modal. The work function returns a failure message ('' on success), so the
   * task bar and the toasts cannot drift apart between the three flows.
   */
  const runPackTask = async (
    task: { id: string; title: string; detail: string; progress: string },
    fallbackFailure: string,
    work: () => Promise<string>,
  ) => {
    let failure = ''
    setModpackUpdateInstalling(true)
    setModpackUpdateProgress(task.progress)
    beginBackgroundTask({
      id: task.id,
      title: task.title,
      detail: task.detail,
      percent: 2,
    })
    try {
      failure = await work()
    } catch (e) {
      failure = errorMessage(e) || fallbackFailure
      addToast({ type: 'error', message: failure })
    } finally {
      if (failure) failBackgroundTask(task.id, failure)
      else completeBackgroundTask(task.id)
      setModpackUpdateInstalling(false)
      setModpackUpdateProgress('')
      setShowModpackUpdateModal(false)
      setShowModpackUpdateOptions(false)
      setModpackUpdateAvailable(false)
    }
  }

  const handleModpackNewInstance = async () => {
    const versionData = selectedVersion()
    if (!versionData) return

    const newId = `inst_${Date.now()}`
    // The version is part of the folder identity: two versions of the same
    // modpack must never end up in one shared profile directory.
    const folderName = uniqueInstanceFolder(
      `${inst.modpackProjectId || inst.folderName || inst.name}-${versionData.mcVersion}-${versionData.version_number}`,
      instances,
    )
    const nameTaken = instances.some(
      (entry) => entry.name.trim().toLowerCase() === inst.name.trim().toLowerCase(),
    )
    const instanceName = uniqueInstanceName(
      nameTaken ? `${inst.name} (${selectedModpackVersion})` : inst.name,
      instances,
    )
    const taskId = `modpack:${folderName}`

    await runPackTask(
      {
        id: taskId,
        title: lang === 'de'
          ? `${instanceName} ${selectedModpackVersion} wird installiert…`
          : `Installing ${instanceName} ${selectedModpackVersion}…`,
        detail: selectedModpackVersion,
        progress: t.createInstanceProgress,
      },
      t.createInstanceFailed,
      async () => {
        const newInst: Instance = {
          id: newId,
          folderName,
          name: instanceName,
          minecraftVersion: versionData.mcVersion,
          modloader: modpackLoaderLabel(versionData.loader),
          modloaderVersion: '',
          lastPlayed: lang === 'de' ? 'Gerade eben' : 'Just now',
          size: t.installing,
          modCount: 0,
          thumbnail: inst.thumbnail,
          desc: `${inst.name} - ${selectedModpackVersion}`,
          javaVersion: t.automatic,
          installedMods: [],
          content: [],
          ram: inst.ram || 6144,
          isModpack: true,
          modpackProjectId: inst.modpackProjectId,
          modpackSource: inst.modpackSource,
          modpackVersion: selectedModpackVersion,
        }

        setInstances(prev => [newInst, ...prev])

        const result = await installPack(folderName, versionData, 'install')
        if (!result?.success) {
          const failure = mainErrorText(result, lang, t.createInstanceFailed)
          setInstances(prev => prev.filter(instance => instance.id !== newId))
          addToast({ type: 'error', message: failure })
          return failure
        }

        const content = contentFromInstall(result)
        setInstances(prev => prev.map(i =>
          i.id === newId ? {
            ...i,
            folderName: result.folderName || i.folderName,
            minecraftVersion: result.mcVersion || i.minecraftVersion,
            modloader: result.loader ? modpackLoaderLabel(result.loader) : i.modloader,
            modloaderVersion: result.loaderVersion || i.modloaderVersion,
            modCount: content.filter(item => item.type === 'mods').length,
            size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
            content,
            installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
          } : i,
        ))
        addToast({ type: 'success', message: t.modpackNewInstanceCreated })
        return ''
      },
    )
  }

  const handleModpackCleanUpdate = async () => {
    const versionData = selectedVersion()
    if (!versionData) return

    const folderName = instanceFolderKeyOf(inst)
    const taskId = `modpack:${folderName}`

    await runPackTask(
      {
        id: taskId,
        title: lang === 'de'
          ? `${inst.name} ${selectedModpackVersion} wird aktualisiert…`
          : `Updating ${inst.name} ${selectedModpackVersion}…`,
        detail: selectedModpackVersion,
        progress: t.installingModpackProgress,
      },
      t.updateFailedGeneric,
      async () => {
        setModpackUpdateProgress(t.securingWorldsProgress)

        const result = await installPack(folderName, versionData, 'update')
        if (!result?.success) {
          const failure = mainErrorText(result, lang, t.updateFailedGeneric)
          addToast({ type: 'error', message: failure })
          return failure
        }

        const content = contentFromInstall(result)
        applyToCurrent({
          folderName: result.folderName || inst.folderName,
          minecraftVersion: result.mcVersion || versionData.mcVersion,
          modloader: result.loader ? modpackLoaderLabel(result.loader) : modpackLoaderLabel(versionData.loader),
          modloaderVersion: result.loaderVersion || inst.modloaderVersion,
          modCount: content.filter(item => item.type === 'mods').length,
          size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
          installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
          content,
          modpackVersion: selectedModpackVersion,
        })
        addToast({ type: 'success', message: t.modpackUpdatedClean })
        return ''
      },
    )
  }

  const handleModpackBetaCarryOver = async () => {
    const versionData = selectedVersion()
    if (!versionData) return

    const folderName = instanceFolderKeyOf(inst)
    const taskId = `modpack:${folderName}`

    await runPackTask(
      {
        id: taskId,
        title: lang === 'de'
          ? `${inst.name} ${selectedModpackVersion} wird aktualisiert…`
          : `Updating ${inst.name} ${selectedModpackVersion}…`,
        detail: selectedModpackVersion,
        progress: t.carryOverProgress,
      },
      t.betaUpdateFailed,
      async () => {
        const currentMods = (inst.content || []).filter(c => c.type === 'mods' && c.projectId)
        const ownModIds = currentMods.map(m => m.projectId).filter(Boolean)

        const result = await installPack(folderName, versionData, 'update')
        if (!result?.success) {
          const failure = mainErrorText(result, lang, t.betaUpdateFailed)
          addToast({ type: 'error', message: failure })
          return failure
        }

        setModpackUpdateProgress(t.searchingCompatibleProgress)

        const newContent: ContentItem[] = []
        for (const projectId of ownModIds) {
          try {
            const modRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
              headers: { 'User-Agent': `BambooLauncher/${LAUNCHER_VERSION}` },
            })
            if (!modRes.ok) continue
            const modVersions: ModrinthVersionList[] = await modRes.json()

            // Carried-over mods go through the same selector: a version only
            // qualifies when it fits the new Minecraft version and loader.
            const pick = pickVersion(modVersions.map(fromModrinthVersion), {
              category: 'mods',
              minecraftVersion: versionData.mcVersion,
              modloader: versionData.loader,
            })
            if (!pick.version || !pick.file) continue

            const dlResult = await window.electronAPI?.mods.download?.({
              folderName,
              profileName: inst.name,
              versionId: versionData.mcVersion ?? '',
              downloadUrl: pick.file.url,
              filename: pick.file.filename,
              itemType: 'mods',
            })

            if (dlResult?.success) {
              const originalMod = currentMods.find(m => m.projectId === projectId)
              newContent.push({
                id: originalMod?.id || projectId || '',
                name: originalMod?.name || projectId || '',
                fileName: pick.file.filename ?? '',
                version: versionData.mcVersion ?? '',
                type: 'mods',
                enabled: true,
                locked: false,
                iconUrl: originalMod?.iconUrl,
                versionNumber: pick.version.versionNumber,
                projectId,
                source: 'modrinth',
              })
            }
          } catch { console.warn('[Instances] Failed to fetch mod version') }
        }

        const carried = new Set(newContent.map(item => item.fileName))
        const packItems = contentFromInstall(result)
        const content = [
          ...packItems.filter(item => !carried.has(item.fileName)),
          ...newContent,
        ] as ContentItem[]
        applyToCurrent({
          folderName: result.folderName || inst.folderName,
          minecraftVersion: result.mcVersion || versionData.mcVersion,
          modloader: result.loader ? modpackLoaderLabel(result.loader) : modpackLoaderLabel(versionData.loader),
          modloaderVersion: result.loaderVersion || inst.modloaderVersion,
          modCount: content.filter(item => item.type === 'mods').length,
          size: `${content.length} ${lang === 'de' ? 'Inhalte' : 'items'}`,
          installedMods: content.map(item => item.projectId).filter((id): id is string => Boolean(id)),
          content,
          modpackVersion: selectedModpackVersion,
        })

        addToast({ type: 'success', message: t.modpackBetaComplete })
        return ''
      },
    )
  }

  return {
    modpackUpdateAvailable,
    modpackCheckingUpdates,
    modpackVersions,
    showModpackUpdateModal,
    setShowModpackUpdateModal,
    showModpackUpdateOptions,
    setShowModpackUpdateOptions,
    selectedModpackVersion,
    setSelectedModpackVersion,
    modpackUpdateInstalling,
    modpackUpdateProgress,
    handleModpackNewInstance,
    handleModpackCleanUpdate,
    handleModpackBetaCarryOver,
  }
}
