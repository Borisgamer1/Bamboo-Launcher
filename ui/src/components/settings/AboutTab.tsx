import { ExternalLink } from 'lucide-react'
import { LAUNCHER_VERSION } from '../../lib/version'
import { Button, SettingsCard, SettingsRow, type Lang } from './SettingsPrimitives'
import { t } from './settingsUtils'

function platformName(): string {
  const agent = navigator.userAgent
  if (agent.includes('Windows')) return 'Windows'
  if (agent.includes('Mac')) return 'macOS'
  if (agent.includes('Linux')) return 'Linux'
  return 'Desktop'
}

export interface AboutTabProps {
  lang: Lang
  updateSummary: string
  updateReady: boolean
  updateBusy: boolean
  updateDisabled: boolean
  onCheckForUpdates?: () => void
  onInstallUpdate?: () => void
  onRestartTour?: () => void
  onOpenChangelog?: () => void
}

/** Version, updates, tour and data sources. */
export function AboutTab({
  lang: L,
  updateSummary,
  updateReady,
  updateBusy,
  updateDisabled,
  onCheckForUpdates,
  onInstallUpdate,
  onRestartTour,
  onOpenChangelog,
}: AboutTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <section className="overflow-hidden rounded-[var(--r-xl)] border border-hairline bg-canvas">
        <div className="flex flex-wrap items-center gap-5 px-5 py-5">
          <img
            src="./images/bamboo-logo.png"
            alt=""
            className="h-14 w-14 shrink-0 rounded-lg border border-hairline object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2.5">
              <h3 className="m-0 text-title3 font-medium text-ink">Bamboo Launcher</h3>
              <span className="font-mono text-micro tabular-nums text-ink-quaternary">v{LAUNCHER_VERSION}</span>
            </div>
            <p className="m-0 mt-1 text-small text-ink-secondary">
              {t(
                L,
                'Minecraft-Profile, Mods und Konten an einem Ort.',
                'Minecraft profiles, mods and accounts in one place.',
              )}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 border-t border-hairline sm:grid-cols-3">
          {[
            { label: t(L, 'Plattform', 'Platform'), value: platformName() },
            { label: t(L, 'Kern', 'Core'), value: 'Rust' },
            { label: t(L, 'Oberfläche', 'Interface'), value: 'Tauri 2 · React 19' },
          ].map((entry, index) => (
            <div
              key={entry.label}
              className={`px-5 py-3${index > 0 ? ' border-t border-hairline sm:border-l sm:border-t-0' : ''}`}
            >
              <p className="m-0 text-micro text-ink-tertiary">{entry.label}</p>
              <p className="m-0 mt-0.5 text-small font-medium text-ink">{entry.value}</p>
            </div>
          ))}
        </div>
      </section>

      <SettingsCard title={t(L, 'Updates', 'Updates')}>
        <SettingsRow
          title={t(L, 'Launcher-Updates', 'Launcher updates')}
          description={updateSummary}
          control={
            updateDisabled ? null : updateReady ? (
              <Button variant="primary" size="sm" onClick={() => void onInstallUpdate?.()}>
                {t(L, 'Neu starten', 'Restart now')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void onCheckForUpdates?.()}
                disabled={!onCheckForUpdates || updateBusy}
              >
                {t(L, 'Prüfen', 'Check')}
              </Button>
            )
          }
        />
      </SettingsCard>

      <SettingsCard title={t(L, 'Einführung', 'Introduction')}>
        <SettingsRow
          title={t(L, 'Tour erneut starten', 'Start the tour again')}
          description={t(L, 'Führt durch die wichtigsten Bereiche des Launchers.', 'Walks through the launcher’s main areas.')}
          control={
            <Button variant="ghost" size="sm" onClick={() => onRestartTour?.()} disabled={!onRestartTour}>
              {t(L, 'Starten', 'Start')}
            </Button>
          }
        />
        <SettingsRow
          title={t(L, 'Was ist neu', "What's new")}
          description={t(L, 'Änderungen der aktuellen Version.', 'Changes in the current version.')}
          control={
            <Button variant="ghost" size="sm" onClick={() => onOpenChangelog?.()} disabled={!onOpenChangelog}>
              {t(L, 'Ansehen', 'View')}
            </Button>
          }
        />
      </SettingsCard>

      <SettingsCard title={t(L, 'Datenquellen', 'Data sources')}>
        <SettingsRow
          title="Modrinth"
          description={t(L, 'Mods, Modpacks und Projektdaten.', 'Mods, modpacks and project metadata.')}
          control={
            <Button
              variant="ghost"
              size="sm"
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => window.electronAPI?.system.openExternal?.('https://modrinth.com')}
            >
              modrinth.com
            </Button>
          }
        />
        <SettingsRow
          title="CurseForge"
          description={t(L, 'Zusätzliche Mods, Modpacks und Weltinhalte.', 'Additional mods, modpacks and world content.')}
          control={
            <Button
              variant="ghost"
              size="sm"
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => window.electronAPI?.system.openExternal?.('https://www.curseforge.com/minecraft')}
            >
              curseforge.com
            </Button>
          }
        />
      </SettingsCard>

      <div className="flex flex-col items-center gap-1 border-t border-hairline pb-1 pt-4 text-center">
        <p className="m-0 text-small font-medium text-ink-secondary">Made by Borisgamer</p>
        <p className="m-0 text-micro text-ink-quaternary">© 2026 Bamboo Launcher</p>
      </div>
    </div>
  )
}
