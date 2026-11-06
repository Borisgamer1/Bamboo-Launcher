import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react'
import type { VersionMap } from '../../lib/versionApi'
import { formatMessage, translations, type LanguageType } from '../../lib/translations'
import type { Instance } from '../InstancesView'
import { LOADERS, loaderMapKey, type TargetLoader } from './version-switch-loaders'

interface VersionSwitchSelectPanelProps {
  instance: Instance
  versionMap: VersionMap | null
  versionsLoading?: boolean
  lang: LanguageType
  targetMc: string
  targetLoader: TargetLoader
  effectiveLoaderVersion: string
  loaderVersions: string[]
  minecraftVersions: string[]
  sameTarget: boolean
  loaderVersionMissing: boolean
  onMcChange: (mc: string) => void
  onLoaderChange: (loader: TargetLoader) => void
  onLoaderVersionChange: (version: string) => void
}

export function VersionSwitchSelectPanel({
  instance,
  versionMap,
  versionsLoading,
  lang,
  targetMc,
  targetLoader,
  effectiveLoaderVersion,
  loaderVersions,
  minecraftVersions,
  sameTarget,
  loaderVersionMissing,
  onMcChange,
  onLoaderChange,
  onLoaderVersionChange,
}: VersionSwitchSelectPanelProps) {
  const t = translations[lang]
  const de = lang === 'de'

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-hairline bg-root/40 p-3">
          <p className="m-0 text-micro font-medium uppercase tracking-label text-ink-tertiary">
            {t.instanceVersionCurrent}
          </p>
          <p className="m-0 mt-1 text-regular font-medium text-ink">
            {instance.minecraftVersion}
          </p>
          <p className="m-0 text-micro text-ink-secondary">
            {instance.modloader}
            {instance.modloaderVersion ? ` ${instance.modloaderVersion}` : ''}
          </p>
        </div>
        <div className="rounded-xl border border-accent/20 bg-accent/5 p-3">
          <p className="m-0 text-micro font-medium uppercase tracking-label text-accent">
            {t.instanceVersionTarget}
          </p>
          <p className="m-0 mt-1 text-regular font-medium text-ink">
            {targetMc || '—'}
          </p>
          <p className="m-0 text-micro text-ink-secondary">
            {targetLoader}
            {effectiveLoaderVersion ? ` ${effectiveLoaderVersion}` : ''}
          </p>
        </div>
      </div>

      {versionsLoading && !versionMap && (
        <p className="m-0 flex items-center gap-2 text-small text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t.instanceVersionLoadingVersions}
        </p>
      )}

      {!versionsLoading && minecraftVersions.length === 0 && (
        <p className="m-0 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-3 text-small text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t.instanceVersionNoVersions}
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-micro font-medium text-ink-secondary">
          {t.instanceVersionMinecraft}
        </span>
        <select
          value={targetMc}
          onChange={(event) => onMcChange(event.target.value)}
          disabled={minecraftVersions.length === 0}
          className="w-full cursor-pointer rounded-xl border border-stroke bg-surface/40 px-3 py-2.5 text-regular text-ink outline-none transition-colors focus:theme-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          {minecraftVersions.map((version) => (
            <option key={version} value={version} className="bg-root">
              {version}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-micro font-medium text-ink-secondary">
          {t.instanceVersionLoader}
        </span>
        <select
          value={targetLoader}
          onChange={(event) => onLoaderChange(event.target.value as TargetLoader)}
          className="w-full cursor-pointer rounded-xl border border-stroke bg-surface/40 px-3 py-2.5 text-regular text-ink outline-none transition-colors focus:theme-border"
        >
          {LOADERS.map((loader) => {
            const key = loaderMapKey(loader)
            const available = loader === 'Vanilla'
              || Boolean(key && versionMap?.[key]?.[targetMc]?.length)
            return (
              <option key={loader} value={loader} disabled={!available} className="bg-root">
                {loader === 'Vanilla' ? t.instanceVersionVanilla : loader}
                {!available ? ` — ${formatMessage(t.instanceVersionLoaderUnavailable, { mc: targetMc })}` : ''}
              </option>
            )
          })}
        </select>
      </label>

      {targetLoader !== 'Vanilla' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-micro font-medium text-ink-secondary">
            {t.instanceVersionLoaderVersion}
          </span>
          <select
            value={effectiveLoaderVersion}
            onChange={(event) => onLoaderVersionChange(event.target.value)}
            disabled={loaderVersions.length === 0}
            className="w-full cursor-pointer rounded-xl border border-stroke bg-surface/40 px-3 py-2.5 text-regular text-ink outline-none transition-colors focus:theme-border disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loaderVersions.length === 0 && (
              <option value="">{t.instanceVersionLoaderUnavailableShort}</option>
            )}
            {loaderVersions.map((version) => (
              <option key={version} value={version} className="bg-root">
                {version}
              </option>
            ))}
          </select>
        </label>
      )}

      {loaderVersionMissing && (
        <p className="m-0 flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 p-3 text-small text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {targetLoader}: {formatMessage(t.instanceVersionLoaderUnavailable, {
            mc: targetMc,
            loader: targetLoader,
          })}. {de ? 'Wähle einen anderen Loader oder Vanilla.' : 'Choose another loader or Vanilla.'}
        </p>
      )}

      {sameTarget && (
        <p className="m-0 text-small text-ink-secondary">{t.instanceVersionSame}</p>
      )}

      <p className="m-0 flex items-start gap-2 rounded-xl border border-hairline bg-root/30 p-3 text-micro text-ink-secondary">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        {t.instanceVersionWorldsNote}
      </p>
    </div>
  )
}

