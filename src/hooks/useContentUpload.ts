import { useState } from 'react'
import { categoryForTab, installItemTypeFor } from '../lib/contentCategories'
import { mainErrorText } from '../lib/mainErrors'
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  newBackgroundTaskId,
} from '../lib/backgroundTasks'
import { instanceFolderKeyOf } from '../lib/instanceFolders'
import { formatMessage, translations, type LanguageType } from '../lib/translations'
import { errorMessage, type ContentItem, type Instance } from '../components/instances/instanceModel'

interface UseContentUploadOptions {
  inst: Instance
  detailTab: string
  lang: LanguageType
  addToast: (toast: { type: 'success' | 'error' | 'info' | 'warning'; message: string }) => void
  withUpdatedInstance: (updater: (inst: Instance) => Instance) => void
  refreshWorlds: () => Promise<unknown>
}

/** "Add own file" for the active content tab: pick, upload, append to the list. */
export function useContentUpload({
  inst,
  detailTab,
  lang,
  addToast,
  withUpdatedInstance,
  refreshWorlds,
}: UseContentUploadOptions) {
  const t = translations[lang]
  const [uploadingFile, setUploadingFile] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)

  const handleUploadLocalMod = async () => {
    const folderName = instanceFolderKeyOf(inst)
    const itemType = installItemTypeFor(categoryForTab(detailTab))
    const isWorldUpload = detailTab === 'worlds'
    let backgroundTaskId = ''
    let uploadSucceeded = false
    let uploadFailure = ''

    try {
      const typeFilters: Record<string, { name: string; extensions: string[] }> = {
        mods: { name: 'Mods', extensions: ['jar', 'disabled'] },
        resourcepacks: { name: 'Resource Packs', extensions: ['zip'] },
        shader: { name: 'Shader Packs', extensions: ['zip'] },
        datapacks: { name: 'Data Packs', extensions: ['zip'] },
        worlds: { name: 'World Archives', extensions: ['zip', 'mcworld'] },
      }
      const filterItem = typeFilters[detailTab] || typeFilters.mods
      const result = await window.electronAPI?.dialogs.open?.({
        properties: ['openFile'],
        filters: [filterItem],
      })
      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return

      setUploadingFile(true)
      setUploadProgress(0)

      if (isWorldUpload) {
        const fileNameForTask = result.filePaths[0].split(/[\\/]/).pop() || 'Welt'
        backgroundTaskId = newBackgroundTaskId(`world:${folderName}`)
        beginBackgroundTask({
          id: backgroundTaskId,
          title: lang === 'de' ? `Welt wird installiert: ${fileNameForTask}` : `Installing world: ${fileNameForTask}`,
          detail: lang === 'de' ? 'Archiv wird entpackt' : 'Extracting archive',
          percent: 1,
        })
      }

      const unsub = window.electronAPI?.mods.onUploadProgress?.((data: { percent: number }) => {
        if (data && typeof data.percent === 'number') {
          setUploadProgress(data.percent)
        }
      })

      try {
        const uploadResult = await window.electronAPI?.mods.uploadLocal?.({
          folderName,
          filePath: result.filePaths[0],
          itemType,
          ...(backgroundTaskId ? { taskId: backgroundTaskId } : {}),
        })

        if (uploadResult?.success) {
          uploadSucceeded = true
          setUploadProgress(100)
          const fileName = result.filePaths[0].split(/[\\/]/).pop() || 'unknown'
          const contentType = categoryForTab(detailTab)

          if (contentType === 'worlds') {
            // A world is a folder in saves/, detected from disk - not a content
            // file, so it gets no entry in the instance content list.
            const installed = uploadResult.worlds?.[0]
            await refreshWorlds()
            addToast({
              type: 'success',
              message: installed
                ? installed.renamed
                  ? formatMessage(t.worldInstalledRenamed, { name: installed.folderName })
                  : formatMessage(t.worldInstalled, { name: installed.folderName })
                : formatMessage(t.worldInstalled, { name: fileName }),
            })
            return
          }

          const displayType = detailTab === 'mods' ? 'Mod' : detailTab === 'resourcepacks' ? 'Resource Pack' : detailTab === 'shader' ? 'Shader' : t.fileLabel
          withUpdatedInstance(i => ({
            ...i,
            content: [...(i.content || []), {
              id: fileName,
              name: uploadResult.modName || fileName.replace(/\.(jar|zip|disabled)$/i, ''),
              fileName,
              version: uploadResult.modVersion || t.localVersion,
              ...(uploadResult.modVersion && uploadResult.modVersion !== 'unknown'
                ? { versionNumber: uploadResult.modVersion }
                : {}),
              ...(uploadResult.iconBase64 ? { iconUrl: uploadResult.iconBase64 } : {}),
              type: contentType as ContentItem['type'],
              enabled: true,
              locked: false,
            }],
            modCount: contentType === 'mods' ? (i.modCount || 0) + 1 : i.modCount,
          }))

          addToast({ type: 'success', message: formatMessage(t.uploadSuccess, { type: displayType, file: fileName }) })
        } else {
          uploadFailure = mainErrorText(uploadResult, lang, t.uploadFailed)
          addToast({ type: 'error', message: uploadFailure })
        }
      } finally {
        if (unsub) unsub()
      }
    } catch (e) {
      uploadFailure = errorMessage(e) || t.uploadFailed
      addToast({ type: 'error', message: uploadFailure })
    } finally {
      if (backgroundTaskId) {
        if (uploadSucceeded) completeBackgroundTask(backgroundTaskId)
        else failBackgroundTask(backgroundTaskId, uploadFailure || t.uploadFailed)
      }
      setUploadingFile(false)
      setUploadProgress(0)
    }
  }

  return { uploadingFile, uploadProgress, handleUploadLocalMod }
}
