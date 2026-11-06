import React, { useEffect, useMemo, useRef, useState } from 'react'
import { translations } from '../lib/translations';
import { Info, Search } from 'lucide-react'
import type { ThemeDefinition } from '../services/themeService'
import type { LanguageType } from '../lib/translations'
import {
  formatPlaytime,
  normalizePreferences,
  type LauncherPreferences,
} from '../lib/launcherPreferences'
import { DEFAULT_KEYBINDS, keybindConflicts } from '../lib/keybinds'
import {
  SETTINGS_TARGET_EVENT,
  clearSettingsTarget,
  readSettingsTarget,
} from '../lib/settingsNavigation'
import { KeybindsPanel } from './settings/KeybindsPanel'
import { AccountsPanel } from './settings/AccountsPanel'
import { GameOptionsPanel } from './settings/GameOptionsPanel'
import { AppearanceTab } from './settings/AppearanceTab'
import { JavaTab } from './settings/JavaTab'
import { LanguageTab } from './settings/LanguageTab'
import { AdvancedTab } from './settings/AdvancedTab'
import { AboutTab } from './settings/AboutTab'
import { StatisticsSettingsTab } from './settings/StatisticsSettingsTab'
import {
  SettingsCard,
  SettingsRow,
  Toggle,
  type Lang,
} from './settings/SettingsPrimitives'
import { cx, t } from './settings/settingsUtils'
import {
  SETTINGS_GROUPS,
  TABS,
  TAB_COPY,
  resolveLegacySection,
  type TabId,
  type TabItem,
} from './settings/settingsTabs'
import { useToast } from './Toast'
import { useStatistics } from '../hooks/useStatistics'
import type { AccountSession } from '../lib/accountSession'
import type { ThemeMode } from '../hooks/useTheme'
import type { LauncherFont } from '../lib/launcherFont'
import type { Instance } from './InstancesView'
import type { UpdateStatus } from '../electron'

export interface SettingsViewProps {
  lang: LanguageType
  setLang: (lang: LanguageType) => void
  themeId: string
  setThemeId: (themeId: string) => void
  themes: ThemeDefinition[]
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  customAccent: string
  setCustomAccent: (accent: string) => void
  customBg: string
  setCustomBg: (bg: string) => void
  preferences: LauncherPreferences
  setPreferences: React.Dispatch<React.SetStateAction<LauncherPreferences>>
  showBgImage: boolean
  setShowBgImage: (value: boolean) => void
  showParticles: boolean
  setShowParticles: (value: boolean) => void
  showGlow: boolean
  setShowGlow: (value: boolean) => void
  bgBrightness: number
  setBgBrightness: (value: number) => void
  bgBlur: number
  setBgBlur: (value: number) => void
  launcherFont: LauncherFont
  setLauncherFont: (font: LauncherFont) => void
  statisticsEnabled: boolean
  setStatisticsEnabled: (enabled: boolean) => void
  initialSection?: TabId
  setInstances: React.Dispatch<React.SetStateAction<Instance[]>>
  accountSession: AccountSession
  updateStatus?: UpdateStatus | null
  onCheckForUpdates?: () => void
  onInstallUpdate?: () => void
  onRestartTour?: () => void
  onOpenChangelog?: () => void
}

export function SettingsView({
  lang,
  setLang,
  themeId,
  setThemeId,
  themes,
  mode,
  setMode,
  customAccent,
  setCustomAccent,
  customBg,
  setCustomBg,
  preferences,
  setPreferences,
  showBgImage,
  setShowBgImage,
  showParticles,
  setShowParticles,
  showGlow,
  setShowGlow,
  bgBrightness,
  setBgBrightness,
  bgBlur,
  setBgBlur,
  launcherFont,
  setLauncherFont,
  statisticsEnabled,
  setStatisticsEnabled,
  initialSection = 'general',
  setInstances,
  accountSession,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
  onRestartTour,
  onOpenChangelog,
}: SettingsViewProps) {
  const L = lang as Lang
  const { addToast } = useToast()
  const updateBusy = updateStatus?.state === 'checking' || updateStatus?.state === 'downloading'
  const updateReady = updateStatus?.state === 'downloaded'
  const updateSummary = updateReady
    ? t(L, `Version ${updateStatus?.version ?? ''} ist bereit. Ein Neustart schließt das Update ab.`, `Version ${updateStatus?.version ?? ''} is ready. A restart completes the update.`)
    : updateStatus?.state === 'checking'
      ? t(L, 'Suche nach Updates …', 'Checking for updates …')
      : updateStatus?.state === 'available'
        ? t(L, `Version ${updateStatus.version ?? ''} ist verfügbar, Download startet …`, `Version ${updateStatus.version ?? ''} is available, download starting …`)
        : updateStatus?.state === 'downloading'
          ? t(L, `Version ${updateStatus.version ?? ''} wird geladen … ${updateStatus.percent ?? 0}%`, `Downloading version ${updateStatus.version ?? ''} … ${updateStatus.percent ?? 0}%`)
          : updateStatus?.state === 'not-available'
            ? t(L, 'Keine Updates gefunden.', 'No updates found.')
            : updateStatus?.state === 'error'
              ? t(L, 'Update-Prüfung fehlgeschlagen. Später erneut versuchen.', 'Update check failed. Try again later.')
              : updateStatus?.state === 'disabled'
                ? t(L, 'Updates werden nur in der installierten App geprüft.', 'Updates are checked in the installed app only.')
                : t(L, 'Updates werden automatisch alle 6 Stunden geprüft.', 'Updates are checked automatically every 6 hours.')
  const [tab, setTab] = useState<TabId>(() => resolveLegacySection(readSettingsTarget() ?? initialSection))
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const applyRequestedSection = () => {
      const requested = readSettingsTarget()
      if (!requested) return
      clearSettingsTarget()
      setTab(resolveLegacySection(requested))
      scrollRef.current?.scrollTo({ top: 0 })
    }
    applyRequestedSection()
    window.addEventListener(SETTINGS_TARGET_EVENT, applyRequestedSection)
    return () => window.removeEventListener(SETTINGS_TARGET_EVENT, applyRequestedSection)
  }, [])
  const openTab = (next: TabId) => {
    setTab(next)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const [navQuery, setNavQuery] = useState('')
  const [javaVersions, setJavaVersions] = useState<{ path: string; version: number; verStr: string }[]>([])
  const [scanningJava, setScanningJava] = useState(false)
  const [themeQuery, setThemeQuery] = useState('')
  const [accentDraft, setAccentDraft] = useState(customAccent)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  // The settings sidebar and the tab share one aggregate, so the client stays
  // here and the tab receives its snapshot.
  const statistics = useStatistics()
  const importRef = useRef<HTMLInputElement>(null)
  const firstSignature = useRef(true)

  const signature = useMemo(
    () =>
      JSON.stringify({
        preferences,
        themeId,
        lang,
        showBgImage,
        showParticles,
        showGlow,
        bgBrightness,
        bgBlur,
        launcherFont,
      }),
    [
      preferences,
      themeId,
      lang,
      showBgImage,
      showParticles,
      showGlow,
      bgBrightness,
      bgBlur,
      launcherFont,
    ],
  )

  useEffect(() => {
    if (firstSignature.current) {
      firstSignature.current = false
      return
    }
    setSaveState('saving')
    const timer = window.setTimeout(() => setSaveState('saved'), 1600)
    const clear = window.setTimeout(() => setSaveState('idle'), 4200)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clear)
    }
  }, [signature])

  const updatePreferences = (updater: (current: LauncherPreferences) => LauncherPreferences) => {
    setPreferences((current) => updater(current))
  }

  const applyFullscreen = (value: boolean) => {
    updatePreferences((current) => ({
      ...current,
      instanceDefaults: {
        ...current.instanceDefaults,
        window: { ...current.instanceDefaults.window, fullscreen: value },
      },
    }))
    setInstances((current) =>
      current.map((instance) =>
        instance.fullscreen === value ? instance : { ...instance, fullscreen: value },
      ),
    )
  }

  const filteredTabs = useMemo(() => {
    const query = navQuery.trim().toLocaleLowerCase()
    if (!query) return TABS
    return TABS.filter((item) =>
      `${item.label.de} ${item.label.en} ${item.description.de} ${item.keywords}`
        .toLocaleLowerCase()
        .includes(query),
    )
  }, [navQuery])

  const totalPlaytime = statistics.summary
    ? formatPlaytime(statistics.summary.playTimeMs, L)
    : '—'
  const keybindConflictCount = keybindConflicts(preferences.keybinds).size

  const scanJava = async (force = false) => {
    setScanningJava(true)
    try {
      const result = await window.electronAPI?.java.versions?.(force)
      if (result) setJavaVersions(result)
      if (result && result.length === 0) {
        addToast({ type: 'warning', message: t(L, 'Keine Java-Installation gefunden.', 'No Java installation found.') })
      }
    } catch {
      addToast({ type: 'error', message: t(L, 'Java-Scan fehlgeschlagen.', 'Java scan failed.') })
    } finally {
      setScanningJava(false)
    }
  }

  const exportPreferences = () => {
    const payload = {
      schema: 'bamboo-launcher-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      preferences,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `bamboo-settings-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    addToast({ type: 'success', message: t(L, 'Einstellungen exportiert.', 'Settings exported.') })
  }

  const importPreferences = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { preferences?: unknown }
      const normalized = normalizePreferences(parsed.preferences ?? parsed)
      setPreferences(normalized)
      addToast({ type: 'success', message: t(L, 'Einstellungen importiert.', 'Settings imported.') })
    } catch {
      addToast({ type: 'error', message: t(L, 'Datei konnte nicht gelesen werden.', 'Could not read this file.') })
    }
  }

  const copy =
    tab === 'accounts' && accountSession.account
      ? {
          title: TAB_COPY.accounts.title,
          desc: {
            de: `Angemeldet als ${accountSession.account.username}. Dieses Konto wird für Online-Spiel und Realms verwendet.`,
            en: `Signed in as ${accountSession.account.username}. This account is used for online play and Realms.`,
          },
        }
      : TAB_COPY[tab]
  const tabIndex = TABS.findIndex((entry) => entry.id === tab) + 1

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1240px] flex-col px-5 py-5 min-[900px]:flex-row min-[900px]:gap-10 min-[900px]:px-8 min-[900px]:py-8">
          <aside className="w-full shrink-0 min-[900px]:w-[232px]">
            <div className="flex flex-col gap-5 min-[900px]:sticky min-[900px]:top-0">
              <div className="px-1">
                <span className="text-small font-medium text-ink">
                  {t(L, 'Einstellungen', 'Settings')}
                </span>
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
                <input
                  type="search"
                  value={navQuery}
                  onChange={(event) => setNavQuery(event.target.value)}
                  placeholder={t(L, 'Einstellungen suchen …', 'Search settings …')}
                  aria-label={t(L, 'Einstellungen suchen', 'Search settings')}
                  className="h-9 w-full rounded-md border border-hairline bg-canvas pl-8 pr-2 text-mini text-ink outline-none placeholder:text-ink-quaternary transition-colors hover:border-rim focus:border-accent/50"
                />
              </div>

              <nav className="flex flex-row gap-2 overflow-x-auto pb-1 min-[900px]:flex-col min-[900px]:gap-5 min-[900px]:overflow-visible min-[900px]:pb-0">
                {SETTINGS_GROUPS.map((group) => {
                  const items = group.tabs
                    .map((id) => filteredTabs.find((entry) => entry.id === id))
                    .filter((entry): entry is TabItem => Boolean(entry))
                  if (items.length === 0) return null
                  return (
                    <div
                      key={group.id}
                      className="flex shrink-0 flex-row gap-1 min-[900px]:flex-col min-[900px]:gap-0.5"
                    >
                      <p className="hidden px-2.5 pb-1.5 text-micro font-medium text-ink-tertiary min-[900px]:block">
                        {group.label[L]}
                      </p>
                      {items.map((item) => {
                        const Icon = item.icon
                        const active = item.id === tab
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-tour={`settings-tab-${item.id}`}
                            onClick={() => openTab(item.id)}
                            aria-current={active ? 'page' : undefined}
                            title={item.description[L]}
                            className={cx(
                              'group relative flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-small font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer',
                              active
                                ? 'bg-hover text-ink'
                                : 'text-ink-secondary hover:bg-hover hover:text-ink',
                            )}
                          >
                            {active && (
                              <span className="absolute left-0 top-1/2 h-4 w-px -translate-y-1/2 bg-accent" />
                            )}
                            <Icon className={cx('h-[18px] w-[18px] shrink-0', active ? 'text-accent' : 'text-ink-tertiary')} />
                            <span className="truncate">{item.label[L]}</span>
                            {item.id === 'keybinds' && keybindConflictCount > 0 && (
                              <span className="ml-auto font-mono text-micro tabular-nums text-danger">
                                {keybindConflictCount}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
                {filteredTabs.length === 0 && (
                  <p className="px-2.5 py-4 text-mini text-ink-tertiary">
                    {t(L, 'Kein Bereich gefunden.', 'No section found.')}
                  </p>
                )}
              </nav>

              <div className="hidden border-t border-hairline pt-4 min-[900px]:block">
                <p className="m-0 text-micro text-ink-tertiary">
                  {translations[L].common.playtime}
                </p>
                <p className="m-0 mt-1 font-mono text-small font-medium tabular-nums text-ink">
                  {totalPlaytime}
                </p>
                <p className="m-0 mt-0.5 text-micro text-ink-quaternary">
                  {t(L, 'Aus dem globalen Ledger', 'From the global ledger')}
                </p>
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1 pb-10">
            <header className="mb-6 border-b border-hairline pb-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-micro tabular-nums text-ink-quaternary">
                      {String(tabIndex).padStart(2, '0')}
                    </span>
                    <h1 className="m-0 text-title2 font-medium tracking-[-0.02em] text-ink">{copy.title[L]}</h1>
                  </div>
                  <p className="m-0 mt-1 max-w-[70ch] text-small leading-5 text-ink-secondary">{copy.desc[L]}</p>
                </div>
                <span
                  className={cx(
                    'flex shrink-0 items-center gap-2 text-micro font-medium',
                    saveState === 'idle' ? 'text-ink-tertiary' : saveState === 'saved' ? 'text-accent' : 'text-ink-secondary',
                  )}
                >
                  <span className={cx('h-1.5 w-1.5 rounded-full', saveState === 'saved' ? 'bg-accent' : 'bg-current')} />
                  {saveState === 'saved'
                    ? t(L, 'Gespeichert', 'Saved')
                    : saveState === 'saving'
                      ? t(L, 'Wird gespeichert …', 'Saving …')
                      : t(L, 'Automatisch gesichert', 'Autosaved')}
                </span>
              </div>
            </header>

            {tab === 'accounts' && (
              <AccountsPanel lang={L} session={accountSession} />
            )}

            {tab === 'general' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Beim Start', 'On launch')}
                  description={t(
                    L,
                    'Was passiert, wenn Minecraft startet oder beendet wird.',
                    'What happens when Minecraft starts or exits.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Launcher beim Spielstart minimieren', 'Minimize launcher when the game starts')}
                    description={t(
                      L,
                      'Bamboo wandert in die Taskleiste, während Minecraft läuft.',
                      'Bamboo moves to the taskbar while Minecraft is running.',
                    )}
                    control={
                      <Toggle
                        checked={preferences.behavior.minimizeOnLaunch}
                        onChange={(value) =>
                          updatePreferences((current) => ({ ...current, behavior: { ...current.behavior, minimizeOnLaunch: value } }))
                        }
                        label={t(L, 'Launcher minimieren', 'Minimize launcher')}
                      />
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Launcher nach dem Spiel wieder fokussieren', 'Refocus the launcher after the game closes')}
                    description={t(
                      L,
                      'Holt Bamboo nach dem Beenden von Minecraft automatisch nach vorne.',
                      'Brings Bamboo back to the foreground after Minecraft exits.',
                    )}
                    control={
                      <Toggle
                        checked={preferences.behavior.focusOnGameClose}
                        onChange={(value) =>
                          updatePreferences((current) => ({ ...current, behavior: { ...current.behavior, focusOnGameClose: value } }))
                        }
                        label={t(L, 'Launcher fokussieren', 'Focus launcher')}
                      />
                    }
                  />
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Verhalten', 'Behavior')}
                  description={t(
                    L,
                    'Was Bamboo im Alltag zeigt und vor dem Löschen bestätigt.',
                    'What Bamboo shows day to day and confirms before deleting.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Spielzeit anzeigen', 'Show playtime')}
                    description={t(
                      L,
                      'Zeigt die gesammelte Spielzeit in Instanz-Karten und Statistiken.',
                      'Shows accumulated playtime on instance cards and statistics.',
                    )}
                    control={
                      <Toggle
                        checked={preferences.behavior.showPlaytime}
                        onChange={(value) =>
                          updatePreferences((current) => ({ ...current, behavior: { ...current.behavior, showPlaytime: value } }))
                        }
                        label={t(L, 'Spielzeit anzeigen', 'Show playtime')}
                      />
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Vor dem Löschen einer Instanz nachfragen', 'Ask before deleting an instance')}
                    description={t(
                      L,
                      'Empfohlen. Ohne Bestätigung wird der Instanzordner sofort entfernt.',
                      'Recommended. Without confirmation the instance folder is removed immediately.',
                    )}
                    control={
                      <Toggle
                        checked={preferences.behavior.confirmDelete}
                        onChange={(value) =>
                          updatePreferences((current) => ({ ...current, behavior: { ...current.behavior, confirmDelete: value } }))
                        }
                        label={t(L, 'Löschen bestätigen', 'Confirm deletion')}
                      />
                    }
                  />
                </SettingsCard>
              </div>
            )}

            {tab === 'appearance' && (
              <AppearanceTab
                lang={L}
                themes={themes}
                themeId={themeId}
                setThemeId={setThemeId}
                mode={mode}
                setMode={setMode}
                themeQuery={themeQuery}
                setThemeQuery={setThemeQuery}
                customAccent={customAccent}
                setCustomAccent={setCustomAccent}
                accentDraft={accentDraft}
                setAccentDraft={setAccentDraft}
                customBg={customBg}
                setCustomBg={setCustomBg}
                showBgImage={showBgImage}
                setShowBgImage={setShowBgImage}
                bgBrightness={bgBrightness}
                setBgBrightness={setBgBrightness}
                bgBlur={bgBlur}
                setBgBlur={setBgBlur}
                showParticles={showParticles}
                setShowParticles={setShowParticles}
                showGlow={showGlow}
                setShowGlow={setShowGlow}
                launcherFont={launcherFont}
                setLauncherFont={setLauncherFont}
                addToast={addToast}
              />
            )}

            {tab === 'language' && (
              <LanguageTab
                lang={L}
                onLauncherLanguage={setLang}
                preferences={preferences}
                updatePreferences={updatePreferences}
              />
            )}

            {tab === 'java' && (
              <JavaTab
                lang={L}
                preferences={preferences}
                updatePreferences={updatePreferences}
                javaVersions={javaVersions}
                scanningJava={scanningJava}
                onScan={() => { void scanJava(true); }}
              />
            )}

            {tab === 'gameOptions' && (
              <div className="flex flex-col gap-4">
                <SettingsCard title={t(L, 'Fenster', 'Window')}>
                  <SettingsRow
                    title={t(L, 'Im Vollbild starten', 'Start in fullscreen')}
                    description={t(L, 'Gilt beim ersten Start einer Instanz.', 'Applies to an instance’s first launch.')}
                    control={
                      <Toggle
                        checked={preferences.instanceDefaults.window.fullscreen}
                        onChange={applyFullscreen}
                        label={t(L, 'Vollbild', 'Fullscreen')}
                      />
                    }
                  />
                </SettingsCard>
                <GameOptionsPanel
                  lang={L}
                  values={preferences.gameOptions}
                  onChange={(key, value) =>
                    updatePreferences((current) => ({
                      ...current,
                      gameOptions: { ...current.gameOptions, [key]: value },
                    }))
                  }
                  onReplace={(values) => updatePreferences((current) => ({ ...current, gameOptions: values }))}
                  note={t(
                    L,
                    'Wird beim ersten Start einer Instanz übernommen. Spätere Änderungen im Spiel bleiben erhalten.',
                    'Applied on an instance’s first launch. Later in-game changes are kept.',
                  )}
                />
              </div>
            )}

            {tab === 'keybinds' && (
              <div>
              <KeybindsPanel
                key={preferences.keybindLayout}
                lang={L}
                layout={preferences.keybindLayout}
                onLayoutChange={(layout) =>
                  updatePreferences((current) => ({ ...current, keybindLayout: layout }))
                }
                values={preferences.keybinds}
                onSet={(actionId, token) =>
                  updatePreferences((current) => ({
                    ...current,
                    keybinds: { ...current.keybinds, [actionId]: token },
                  }))
                }
                onClear={(actionId) =>
                  updatePreferences((current) => ({
                    ...current,
                    keybinds: {
                      ...current.keybinds,
                      [actionId]: DEFAULT_KEYBINDS[actionId] || 'key.keyboard.unknown',
                    },
                  }))
                }
                onResetAll={() =>
                  updatePreferences((current) => ({ ...current, keybinds: { ...DEFAULT_KEYBINDS } }))
                }
                isCustom={(actionId) => preferences.keybinds[actionId] !== DEFAULT_KEYBINDS[actionId]}
                note={t(
                  L,
                  'Belegte Tasten sind grün. Teilen sich mehrere Aktionen eine Taste, wird sie rot – das ist in Minecraft erlaubt, kann aber im Spiel zu Überraschungen führen.',
                  'Bound keys are green. If several actions share a key it turns red – Minecraft allows it, but it can be surprising in-game.',
                )}
                footer={
                  <div className="flex items-start gap-2.5 px-1 text-mini leading-5 text-ink-tertiary">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t(
                        L,
                        'Die Belegung wird beim Anlegen der Instanz in ihre options.txt geschrieben.',
                        'Bindings are written into the instance options.txt when the instance is created.',
                      )}
                    </span>
                  </div>
                }
              />
              </div>
            )}

            {tab === 'advanced' && (
              <AdvancedTab
                lang={L}
                setPreferences={setPreferences}
                importRef={importRef}
                onExport={exportPreferences}
                onImport={importPreferences}
                onReset={() => addToast({ type: 'success', message: t(L, 'Einstellungen zurückgesetzt.', 'Settings reset.') })}
              />
            )}

            {tab === 'statistics' && (
              <StatisticsSettingsTab
                lang={lang}
                statistics={statistics}
                statisticsEnabled={statisticsEnabled}
                setStatisticsEnabled={setStatisticsEnabled}
              />
            )}

            {tab === 'about' && (
              <AboutTab
                lang={L}
                updateSummary={updateSummary}
                updateReady={updateReady}
                updateBusy={updateBusy}
                onCheckForUpdates={onCheckForUpdates}
                onInstallUpdate={onInstallUpdate}
                onRestartTour={onRestartTour}
                onOpenChangelog={onOpenChangelog}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

