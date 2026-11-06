import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Download,
  Loader2,
  PackageX,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { VersionSwitchSelectPanel } from './VersionSwitchSelectPanel'
import { loaderMapKey, type TargetLoader } from './version-switch-loaders'
import { useToast } from '../Toast'
import {
  installItemTypeFor,
  type ContentCategory,
} from '../../lib/contentCategories'
import { instanceFolderKeyOf as instanceFolderKey } from '../../lib/instanceFolders'
import { mainErrorText } from '../../lib/mainErrors'
import {
  isVersionCompatible,
  pickVersion,
  versionFileFor,
  type StoreFile,
  type StoreVersion,
  type VersionMissReason,
} from '../../lib/modVersions'
import {
  beginBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  updateBackgroundTask,
} from '../../lib/backgroundTasks'
import { formatMessage, translations, type LanguageType } from '../../lib/translations'
import type { VersionMap } from '../../lib/versionApi'
import type { DownloadModPayload } from '../../electron'
import type { ContentItem, Instance } from '../InstancesView'
import { fetchContentVersions } from './contentDetailModel'

type Stage = 'select' | 'checking' | 'review' | 'running' | 'done' | 'error'

type RemoveReason =
  | 'metadata'
  | 'no-loader'
  | VersionMissReason

interface CheckEntry {
  item: ContentItem
  status: 'keep' | 'switch' | 'remove'
  reason?: RemoveReason
  next?: StoreVersion
  nextFile?: StoreFile
  /** Version that will be present after the switch (installed or picked). */
  resolved?: StoreVersion
  /** Provider could not be asked; the item is kept exactly as it is. */
  unverified?: boolean
}

export interface InstanceVersionSwitchSummary {
  minecraftVersion: string
  modloader: TargetLoader
  modloaderVersion: string
  content: ContentItem[]
  modCount: number
  installedMods: string[]
}

export interface InstanceVersionSwitchModalProps {
  open: boolean
  instance: Instance | null
  versionMap: VersionMap | null
  versionsLoading?: boolean
  lang: LanguageType
  onClose: () => void
  onApplied: (instanceId: string, summary: InstanceVersionSwitchSummary) => void
}

const SWITCHABLE_TYPES: ContentCategory[] = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks']
const SHADER_LOADER_ALWAYS_INCOMPATIBLE = new Set<ContentCategory>(['mods', 'shaderpacks'])

function isSwitchable(item: ContentItem): boolean {
  return SWITCHABLE_TYPES.includes(item.type)
}

function categoryLabel(type: ContentItem['type'], de: boolean): string {
  if (type === 'resourcepacks') return de ? 'Ressourcenpaket' : 'Resource pack'
  if (type === 'shaderpacks') return de ? 'Shader' : 'Shader'
  if (type === 'datapacks') return de ? 'Datenpaket' : 'Data pack'
  return de ? 'Mod' : 'Mod'
}

function catalogKey(item: ContentItem): string {
  return `${item.source || 'modrinth'}:${item.projectId || ''}`
}

/**
 * Mods can pin exact versions of other mods (Voxy requires a specific Sodium
 * build). Resolve those pins after every item has a candidate, so a compatible
 * but newer version of the dependency is not installed next to a mod that
 * refuses it. Pins only ever point at versions that are themselves compatible
 * with the target Minecraft version and loader.
 */
function applyDependencyPins(
  entries: CheckEntry[],
  catalog: Map<string, StoreVersion[]>,
  targetMc: string,
  targetLoader: TargetLoader,
): CheckEntry[] {
  const result = entries.map((entry) => ({ ...entry }))
  const byProject = new Map<string, CheckEntry>()
  for (const entry of result) {
    if (entry.item.projectId && isSwitchable(entry.item) && entry.status !== 'remove') {
      byProject.set(entry.item.projectId, entry)
    }
  }

  let changed = true
  for (let pass = 0; pass < 4 && changed; pass += 1) {
    changed = false
    for (const source of result) {
      if (source.status === 'remove' || !source.resolved) continue
      for (const dependency of source.resolved.dependencies || []) {
        if (dependency.dependencyType !== 'required') continue
        if (!dependency.projectId || !dependency.versionId) continue
        const target = byProject.get(dependency.projectId)
        if (!target || target.status === 'remove') continue
        if (target.resolved?.versionId === dependency.versionId) continue

        const versions = catalog.get(catalogKey(target.item)) || []
        const pinned = versions.find((version) => version.versionId === dependency.versionId)
        const file = pinned ? versionFileFor(pinned, target.item.type) : null
        if (!pinned || !file) continue
        const compatible = isVersionCompatible(pinned, {
          category: target.item.type,
          minecraftVersion: targetMc,
          modloader: targetLoader,
        })
        if (!compatible) continue

        target.status = 'switch'
        target.reason = undefined
        target.next = pinned
        target.nextFile = file
        target.resolved = pinned
        changed = true
      }
    }
  }
  return result
}

export const InstanceVersionSwitchModal: React.FC<InstanceVersionSwitchModalProps> = ({
  open,
  instance,
  versionMap,
  versionsLoading,
  lang,
  onClose,
  onApplied,
}) => {
  const t = translations[lang]
  const de = lang === 'de'
  const { addToast } = useToast()

  const [stage, setStage] = useState<Stage>('select')
  const [targetMc, setTargetMc] = useState(instance?.minecraftVersion || '')
  const [targetLoader, setTargetLoader] = useState<TargetLoader>(instance?.modloader || 'Vanilla')
  const [targetLoaderVersion, setTargetLoaderVersion] = useState(instance?.modloaderVersion || '')
  const [entries, setEntries] = useState<CheckEntry[]>([])
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [error, setError] = useState('')
  const [appliedSummary, setAppliedSummary] = useState<{
    removed: number
    switched: number
    failed: string[]
    loaderVersion: string
  } | null>(null)

  const runIdRef = useRef(0)

  const minecraftVersions = versionMap?.minecraftVersions || []

  const loaderVersions = useMemo(() => {
    if (!versionMap || targetLoader === 'Vanilla') return []
    const key = loaderMapKey(targetLoader)
    if (!key) return []
    return versionMap[key]?.[targetMc] || []
  }, [versionMap, targetLoader, targetMc])

  // Derived, not stored in an effect: when the version map arrives after the
  // modal opens, the first available loader build becomes the selection without
  // a cascading re-render.
  const effectiveLoaderVersion = targetLoader === 'Vanilla'
    ? ''
    : (loaderVersions.includes(targetLoaderVersion) ? targetLoaderVersion : (loaderVersions[0] || ''))

  useEffect(() => {
    if (stage !== 'running' || !instance) return
    const taskId = `version-switch:${instanceFolderKey(instance)}`
    const unsubscribe = window.electronAPI?.tasks.onProgress?.((data) => {
      if (!data || data.id !== taskId) return
      if (data.label) setProgressLabel(data.label)
      const percent = data.percent
      if (typeof percent === 'number' && Number.isFinite(percent)) {
        // Main reports 0-100 for the base install. Map it into the first phase
        // of the whole switch so the modal's bar never jumps backwards.
        setProgress((current) => Math.max(current, Math.min(48, 4 + Math.round(percent * 0.44))))
      }
    })
    return () => unsubscribe?.()
  }, [stage, instance])

  const sameTarget = Boolean(instance) && targetMc === instance?.minecraftVersion
    && targetLoader === instance?.modloader
    && effectiveLoaderVersion === (instance?.modloaderVersion || '')

  const loaderVersionMissing = targetLoader !== 'Vanilla' && loaderVersions.length === 0
  const canCheck = Boolean(instance) && Boolean(targetMc) && !sameTarget
    && (targetLoader === 'Vanilla' || Boolean(effectiveLoaderVersion))

  const handleLoaderChange = (loader: TargetLoader) => {
    setTargetLoader(loader)
    if (loader === 'Vanilla') {
      setTargetLoaderVersion('')
      return
    }
    const key = loaderMapKey(loader)
    const versions = key && versionMap ? versionMap[key]?.[targetMc] || [] : []
    setTargetLoaderVersion(versions[0] || '')
  }

  const handleMcChange = (mc: string) => {
    setTargetMc(mc)
    if (targetLoader === 'Vanilla') return
    const key = loaderMapKey(targetLoader)
    const versions = key && versionMap ? versionMap[key]?.[mc] || [] : []
    // Keep the chosen loader even when this Minecraft version has no build for
    // it. Silently falling back to Vanilla would turn a version change into a
    // removal of every mod and shader.
    if (!versions.includes(targetLoaderVersion)) setTargetLoaderVersion(versions[0] || '')
  }

  const reasonText = (entry: CheckEntry): string => {
    switch (entry.reason) {
      case 'metadata':
        return t.instanceVersionReasonMetadata
      case 'no-loader':
        return t.instanceVersionReasonNoLoader
      case 'no-versions':
        return t.installMissNoVersions
      case 'mc-version':
        return formatMessage(t.installMissMcVersion, { mc: targetMc })
      case 'loader':
        return formatMessage(t.installMissLoader, {
          loader: targetLoader === 'Vanilla' ? 'Vanilla' : `${targetLoader} ${effectiveLoaderVersion}`.trim(),
        })
      default:
        return t.installMissNoFile
    }
  }

  const checkOne = async (
    item: ContentItem,
    catalog: Map<string, StoreVersion[]>,
  ): Promise<CheckEntry> => {
    if (!isSwitchable(item)) return { item, status: 'keep' }
    if (!item.projectId || !item.source || !item.versionNumber) {
      return { item, status: 'remove', reason: 'metadata' }
    }
    if (targetLoader === 'Vanilla' && SHADER_LOADER_ALWAYS_INCOMPATIBLE.has(item.type)) {
      return { item, status: 'remove', reason: 'no-loader' }
    }

    try {
      const key = catalogKey(item)
      let versions = catalog.get(key)
      if (!versions) {
        versions = await fetchContentVersions(
          { projectId: item.projectId, source: item.source },
          { strict: true },
        )
        catalog.set(key, versions)
      }
      const criteria = {
        category: item.type,
        minecraftVersion: targetMc,
        modloader: targetLoader,
        // Pin the newest stable release: beta mods such as Voxy declare exact
        // dependency ranges that the newest beta of another mod can break.
        preferStable: true,
      }
      const installed = versions.find((version) => version.versionNumber === item.versionNumber)
      const installedFile = installed ? versionFileFor(installed, item.type) : null
      if (installed && installedFile && isVersionCompatible(installed, criteria)) {
        return { item, status: 'keep', resolved: installed }
      }

      const pick = pickVersion(versions, criteria)
      if (pick.version && pick.file) {
        return { item, status: 'switch', next: pick.version, nextFile: pick.file, resolved: pick.version }
      }
      return { item, status: 'remove', reason: pick.reason || 'file' }
    } catch {
      // A failed request is not evidence that the item has no version. Keep
      // it and tell the user instead of deleting content because the network
      // was down.
      return { item, status: 'keep', unverified: true }
    }
  }

  const analyze = async () => {
    if (!instance) return
    const runId = ++runIdRef.current
    setStage('checking')
    setProgress(0)
    setProgressLabel(t.instanceVersionChecking)
    // Worlds and any unknown entry stay in the list untouched; only known
    // switchable categories are checked against the target version.
    const items = instance.content || []
    const nextEntries: CheckEntry[] = []
    const catalog = new Map<string, StoreVersion[]>()
    const batchSize = 5

    for (let index = 0; index < items.length; index += batchSize) {
      if (runId !== runIdRef.current) return
      const batch = items.slice(index, index + batchSize)
      const checked = await Promise.all(batch.map((item) => checkOne(item, catalog)))
      nextEntries.push(...checked)
      const done = Math.min(items.length, index + batch.length)
      setProgress(items.length === 0 ? 100 : Math.round((done / items.length) * 100))
      setProgressLabel(formatMessage(t.instanceVersionCheckingCount, { done, total: items.length }))
    }

    if (runId !== runIdRef.current) return
    setEntries(applyDependencyPins(nextEntries, catalog, targetMc, targetLoader))
    setProgress(100)
    setStage('review')
  }

  const runApply = async (planned: CheckEntry[]) => {
    if (!instance) return
    const folderName = instanceFolderKey(instance)
    const taskId = `version-switch:${folderName}`
    const loaderLabel = targetLoader === 'Vanilla'
      ? 'Vanilla'
      : `${targetLoader} ${effectiveLoaderVersion}`.trim()

    setStage('running')
    setProgress(4)
    setProgressLabel(formatMessage(t.instanceVersionStepInstall, {
      mc: targetMc,
      loader: loaderLabel,
    }))
    setError('')
    beginBackgroundTask({
      id: taskId,
      title: formatMessage(t.instanceVersionTaskTitle, { name: instance.name }),
      detail: formatMessage(t.instanceVersionStepInstall, { mc: targetMc, loader: loaderLabel }),
      percent: 4,
    })

    try {
      const versionResult = await window.electronAPI?.instances.changeVersion?.({
        folderName,
        mcVersion: targetMc,
        loader: targetLoader.toLowerCase(),
        loaderVersion: targetLoader === 'Vanilla' ? '' : effectiveLoaderVersion,
      })
      if (!versionResult?.success) {
        throw new Error(versionResult?.error || t.instanceVersionFailed)
      }
      const appliedLoaderVersion = targetLoader === 'Vanilla'
        ? ''
        : (versionResult.loaderVersion || effectiveLoaderVersion)

      setProgress(50)
      updateBackgroundTask(taskId, {
        percent: 50,
        detail: t.instanceVersionStepContent,
      })

      const total = planned.filter((entry) => entry.status !== 'keep').length
      let done = 0
      let removedCount = 0
      let switchedCount = 0
      const failed: string[] = []
      const nextContent: ContentItem[] = []

      for (const entry of planned) {
        if (entry.status === 'keep') {
          nextContent.push(entry.item)
          continue
        }

        if (entry.status === 'remove') {
          let removalSucceeded = true
          try {
            if (entry.item.fileName) {
              const deleted = await window.electronAPI?.mods.deleteContentFile?.({
                folderName,
                fileName: entry.item.fileName,
                type: entry.item.type,
              })
              // The handler returns false for a rejected/unsafe path instead of
              // throwing; a false result must not count as a completed removal.
              if (deleted !== true) throw new Error(t.instanceVersionFailed)
            }
          } catch (removalError) {
            removalSucceeded = false
            console.warn('[VersionSwitch] Content could not be removed:', entry.item.name, removalError)
            failed.push(entry.item.name)
            nextContent.push(entry.item)
          }
          if (removalSucceeded) removedCount += 1
          done += 1
        } else if (entry.status === 'switch' && entry.next && entry.nextFile) {
          try {
            const payload: DownloadModPayload = {
              folderName,
              profileName: instance.name,
              versionId: targetMc,
              filename: entry.nextFile.filename,
              itemType: installItemTypeFor(entry.item.type),
            }
            const curseForgeFileId = entry.item.source === 'curseforge'
              ? Number(entry.next.versionId)
              : NaN
            if (Number.isFinite(curseForgeFileId) && curseForgeFileId > 0) {
              payload.curseforgeFileId = curseForgeFileId
            } else if (entry.nextFile.url) {
              payload.downloadUrl = entry.nextFile.url
            } else {
              throw new Error(t.instanceVersionFailed)
            }

            // New file first, old file only after it landed. A failed download
            // must never leave the instance without the working content.
            const result = await window.electronAPI?.mods.download?.(payload)
            if (!result?.success) {
              throw new Error(mainErrorText(result, lang, t.instanceVersionFailed))
            }
            if (entry.item.fileName && entry.item.fileName !== entry.nextFile.filename) {
              await window.electronAPI?.mods.deleteContentFile?.({
                folderName,
                fileName: entry.item.fileName,
                type: entry.item.type,
              })
            }
            nextContent.push({
              ...entry.item,
              fileName: entry.nextFile.filename,
              version: targetMc,
              versionNumber: entry.next.versionNumber,
              updateAvailable: false,
            })
            switchedCount += 1
          } catch (switchError) {
            console.warn('[VersionSwitch] Content could not be switched:', entry.item.name, switchError)
            failed.push(entry.item.name)
            nextContent.push(entry.item)
          }
          done += 1
        }

        const percent = total === 0 ? 90 : 50 + Math.round((done / total) * 45)
        setProgress(percent)
        updateBackgroundTask(taskId, {
          percent,
          detail: formatMessage(t.instanceVersionStepContentCount, { done, total }),
        })
        setProgressLabel(formatMessage(t.instanceVersionStepContentCount, { done, total }))
      }

      const normalizedContent = nextContent.map((item) => (
        item.updateAvailable ? { ...item, updateAvailable: false } : item
      ))
      const modCount = normalizedContent.filter((item) => item.type === 'mods').length
      const installedMods = [...new Set(
        normalizedContent.map((item) => item.projectId).filter((id): id is string => Boolean(id)),
      )]

      onApplied(instance.id, {
        minecraftVersion: targetMc,
        modloader: targetLoader,
        modloaderVersion: appliedLoaderVersion,
        content: normalizedContent,
        modCount,
        installedMods,
      })

      setAppliedSummary({
        removed: removedCount,
        switched: switchedCount,
        failed,
        loaderVersion: appliedLoaderVersion,
      })
      setProgress(100)
      setProgressLabel(t.instanceVersionDone)
      completeBackgroundTask(taskId, t.instanceVersionDone)
      setStage('done')
      addToast({
        type: failed.length > 0 ? 'warning' : 'success',
        message: formatMessage(t.instanceVersionDoneToast, { name: instance.name, mc: targetMc }),
      })
    } catch (applyError) {
      const message = applyError instanceof Error ? applyError.message : String(applyError)
      setError(message)
      setProgressLabel(message)
      failBackgroundTask(taskId, message)
      setStage('error')
    }
  }

  const handleClose = () => {
    if (stage === 'checking' || stage === 'running') return
    onClose()
  }

  const removals = entries.filter((entry) => entry.status === 'remove')
  const switches = entries.filter((entry) => entry.status === 'switch')
  const keeps = entries.filter((entry) => entry.status === 'keep' && !entry.unverified && isSwitchable(entry.item))
  const unverified = entries.filter((entry) => entry.unverified)

  const footer = (() => {
    if (stage === 'select') {
      return (
        <>
          <button type="button" onClick={handleClose} className={dialogButton.secondary}>
            {t.instanceVersionCancel}
          </button>
          <button
            type="button"
            onClick={() => void analyze()}
            disabled={!canCheck}
            className={dialogButton.accent}
          >
            {t.instanceVersionCheck}
          </button>
        </>
      )
    }
    if (stage === 'review') {
      return (
        <>
          <button type="button" onClick={handleClose} className={dialogButton.secondary}>
            {t.instanceVersionCancel}
          </button>
          <button
            type="button"
            onClick={() => void runApply(entries)}
            className={removals.length > 0 ? dialogButton.danger : dialogButton.accent}
          >
            {removals.length > 0
              ? formatMessage(t.instanceVersionContinueRemove, { count: removals.length })
              : t.instanceVersionContinue}
          </button>
        </>
      )
    }
    if (stage === 'done') {
      return (
        <button type="button" onClick={handleClose} className={dialogButton.accent}>
          {t.instanceVersionClose}
        </button>
      )
    }
    if (stage === 'error') {
      return (
        <>
          <button type="button" onClick={handleClose} className={dialogButton.secondary}>
            {t.instanceVersionClose}
          </button>
          <button
            type="button"
            onClick={() => void runApply(entries)}
            className={dialogButton.accent}
          >
            {t.instanceVersionRetry}
          </button>
        </>
      )
    }
    return undefined
  })()

  const title = instance
    ? formatMessage(t.instanceVersionSwitchTitle, { name: instance.name })
    : t.instanceVersionSwitch

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={title}
      titleId="instance-version-switch-title"
      closeLabel={t.close}
      icon={<ArrowRightLeft className="h-4 w-4" />}
      tone="accent"
      widthClassName="w-[560px]"
      footer={footer}
    >
      {!instance ? null : stage === 'select' && (
        <VersionSwitchSelectPanel
          instance={instance}
          versionMap={versionMap}
          versionsLoading={versionsLoading}
          lang={lang}
          targetMc={targetMc}
          targetLoader={targetLoader}
          effectiveLoaderVersion={effectiveLoaderVersion}
          loaderVersions={loaderVersions}
          minecraftVersions={minecraftVersions}
          sameTarget={sameTarget}
          loaderVersionMissing={loaderVersionMissing}
          onMcChange={handleMcChange}
          onLoaderChange={handleLoaderChange}
          onLoaderVersionChange={setTargetLoaderVersion}
        />
      )}

      {stage === 'checking' && (
        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <div className="min-w-0">
              <p className="m-0 text-regular font-medium text-ink">{t.instanceVersionChecking}</p>
              <p className="m-0 mt-0.5 truncate text-micro text-ink-secondary">{progressLabel}</p>
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-selected">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {stage === 'review' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-hairline bg-root/30 p-3 text-center">
              <p className="m-0 text-large font-semibold text-ink">{switches.length}</p>
              <p className="m-0 text-micro text-ink-secondary">{t.instanceVersionSwitchCount}</p>
            </div>
            <div className="rounded-xl border border-hairline bg-root/30 p-3 text-center">
              <p className="m-0 text-large font-semibold text-ink">{keeps.length}</p>
              <p className="m-0 text-micro text-ink-secondary">{t.instanceVersionKeepCount}</p>
            </div>
            <div className={`rounded-xl border p-3 text-center ${removals.length > 0 ? 'border-danger/25 bg-danger/8' : 'border-hairline bg-root/30'}`}>
              <p className={`m-0 text-large font-semibold ${removals.length > 0 ? 'text-danger' : 'text-ink'}`}>
                {removals.length}
              </p>
              <p className="m-0 text-micro text-ink-secondary">{t.instanceVersionRemoveCount}</p>
            </div>
          </div>

          {removals.length > 0 ? (
            <>
              <div>
                <p className="m-0 flex items-center gap-2 text-regular font-medium text-ink">
                  <AlertTriangle className="h-4 w-4 text-danger" />
                  {formatMessage(t.instanceVersionReviewBody, {
                    count: removals.length,
                    mc: targetMc,
                    loader: targetLoader,
                  })}
                </p>
                <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-danger/20 bg-danger/5 p-2 custom-scrollbar">
                  {removals.map((entry) => (
                    <div
                      key={`${entry.item.type}:${entry.item.id}:${entry.item.fileName}`}
                      className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-danger/5"
                    >
                      <div className="min-w-0">
                        <p className="m-0 truncate text-small font-medium text-ink">{entry.item.name}</p>
                        <p className="m-0 text-micro text-ink-secondary">
                          {categoryLabel(entry.item.type, de)}
                          {entry.item.versionNumber ? ` · ${entry.item.versionNumber}` : ''}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md bg-danger/10 px-1.5 py-0.5 text-micro text-danger">
                        {reasonText(entry)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="m-0 mt-2 text-micro text-ink-tertiary">{t.instanceVersionRemoveNote}</p>
              </div>
            </>
          ) : (
            <p className="m-0 flex items-center gap-2 rounded-xl border border-success/20 bg-success/10 p-3 text-small text-success">
              <Check className="h-4 w-4" />
              {t.instanceVersionNoRemovals}
            </p>
          )}

          {unverified.length > 0 && (
            <p className="m-0 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-3 text-micro text-warning">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {formatMessage(t.instanceVersionUnverified, { count: unverified.length })}
            </p>
          )}

          {switches.length > 0 && (
            <p className="m-0 text-micro text-ink-secondary">
              {formatMessage(t.instanceVersionSwitchSummary, { count: switches.length })}
            </p>
          )}
          <p className="m-0 flex items-start gap-2 rounded-xl border border-hairline bg-root/30 p-3 text-micro text-ink-secondary">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            {t.instanceVersionWorldsNote}
          </p>
        </div>
      )}

      {stage === 'running' && (
        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center gap-3">
            <Download className="h-5 w-5 animate-pulse text-accent" />
            <div className="min-w-0">
              <p className="m-0 text-regular font-medium text-ink">{t.instanceVersionRunning}</p>
              <p className="m-0 mt-0.5 truncate text-micro text-ink-secondary">{progressLabel}</p>
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-selected">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="m-0 text-micro text-ink-tertiary">{t.instanceVersionDoNotClose}</p>
        </div>
      )}

      {stage === 'done' && appliedSummary && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-xl border border-success/20 bg-success/10 p-3">
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div>
              <p className="m-0 text-regular font-medium text-ink">{t.instanceVersionDone}</p>
              <p className="m-0 mt-0.5 text-small text-ink-secondary">
                {formatMessage(t.instanceVersionDoneBody, {
                  name: instance?.name ?? '',
                  mc: targetMc,
                  loader: targetLoader === 'Vanilla'
                    ? 'Vanilla'
                    : `${targetLoader} ${appliedSummary.loaderVersion}`.trim(),
                })}
              </p>
            </div>
          </div>
          {appliedSummary.switched > 0 && (
            <p className="m-0 text-small text-ink-secondary">
              {formatMessage(t.instanceVersionDoneSwitched, { count: appliedSummary.switched })}
            </p>
          )}
          {appliedSummary.removed > 0 && (
            <p className="m-0 flex items-center gap-2 text-small text-ink-secondary">
              <Trash2 className="h-3.5 w-3.5 text-danger" />
              {formatMessage(t.instanceVersionDoneRemoved, { count: appliedSummary.removed })}
            </p>
          )}
          {unverified.length > 0 && (
            <p className="m-0 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-3 text-small text-warning">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {formatMessage(t.instanceVersionUnverified, { count: unverified.length })}
            </p>
          )}
          {appliedSummary.failed.length > 0 && (
            <div className="rounded-xl border border-warning/20 bg-warning/10 p-3">
              <p className="m-0 flex items-start gap-2 text-small text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {formatMessage(t.instanceVersionDoneFailed, { count: appliedSummary.failed.length })}
              </p>
              <p className="m-0 mt-1 break-words text-micro text-warning/90">
                {appliedSummary.failed.join(', ')}
              </p>
            </div>
          )}
          <p className="m-0 flex items-start gap-2 text-micro text-ink-tertiary">
            <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" />
            {t.instanceVersionWorldsNote}
          </p>
        </div>
      )}

      {stage === 'error' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-xl border border-danger/20 bg-danger/10 p-3">
            <PackageX className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="m-0 text-regular font-medium text-ink">{t.instanceVersionFailed}</p>
              <p className="m-0 mt-0.5 break-words text-small text-ink-secondary">{error}</p>
            </div>
          </div>
          <p className="m-0 text-micro text-ink-tertiary">{t.instanceVersionRetryHint}</p>
        </div>
      )}
    </Dialog>
  )
}
