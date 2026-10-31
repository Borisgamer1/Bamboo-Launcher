import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  Check,
  Coffee,
  Download,
  ExternalLink,
  Gamepad2,
  Info,
  Keyboard,
  Languages,
  Layers,
  MemoryStick,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { ThemeDefinition } from '../services/themeService'
import type { LanguageType } from '../lib/translations'
import {
  DEFAULT_PREFERENCES,
  RAM_MAX_MB,
  RAM_MIN_MB,
  RAM_STEP_MB,
  formatPlaytime,
  normalizePreferences,
  type LauncherPreferences,
} from '../lib/launcherPreferences'
import {
  DEFAULT_GAME_OPTIONS,
  GAME_OPTIONS,
  MINECRAFT_LANGUAGES,
} from '../lib/gameOptions'
import { ALL_KEYBIND_ACTIONS, DEFAULT_KEYBINDS, keybindConflicts } from '../lib/keybinds'
import {
  SETTINGS_TARGET_EVENT,
  clearSettingsTarget,
  readSettingsTarget,
} from '../lib/settingsNavigation'
import { KeybindsPanel } from './settings/KeybindsPanel'
import { AccountsPanel } from './settings/AccountsPanel'
import { GameOptionsPanel } from './settings/GameOptionsPanel'
import {
  Badge,
  Button,
  ConfirmButton,
  SelectField,
  Segmented,
  SettingsCard,
  SettingsRow,
  Slider,
  TextField,
  Toggle,
  type Lang,
} from './settings/SettingsPrimitives'
import { cx, t } from './settings/settingsUtils'
import { useToast } from './Toast'
import type { AccountSession } from '../lib/accountSession'
import type { UpdateStatus } from '../electron'
import { LAUNCHER_VERSION } from '../lib/version'

type TabId = 'general' | 'appearance' | 'game' | 'language' | 'advanced' | 'about' | 'accounts'

type GamePanelId = 'java' | 'game' | 'controls' | 'defaults'

type LegacySectionId =
  | 'accounts'
  | 'general'
  | 'appearance'
  | 'themes'
  | 'language'
  | 'java'
  | 'game'
  | 'controls'
  | 'defaults'
  | 'advanced'
  | 'about'

interface TabItem {
  id: TabId
  label: { de: string; en: string }
  description: { de: string; en: string }
  icon: React.ElementType
  keywords: string
}

const TABS: TabItem[] = [
  {
    id: 'general',
    label: { de: 'Allgemein', en: 'General' },
    description: { de: 'Start und Verhalten des Launchers', en: 'Launcher startup and behavior' },
    icon: SlidersHorizontal,
    keywords: 'start verhalten behavior minimize focus playtime',
  },
  {
    id: 'appearance',
    label: { de: 'Darstellung', en: 'Appearance' },
    description: { de: 'Themes, Hintergrund und Effekte', en: 'Themes, background and effects' },
    icon: Palette,
    keywords: 'theme hintergrund particles blur akzent accent design',
  },
  {
    id: 'game',
    label: { de: 'Spiel', en: 'Game' },
    description: { de: 'Java, Spieloptionen, Steuerung und Instanz-Standards', en: 'Java, game options, controls and instance defaults' },
    icon: Gamepad2,
    keywords: 'ram memory java jvm video audio sound keybind tasten keyboard instanz default vollbild fullscreen sprache minecraft',
  },
  {
    id: 'language',
    label: { de: 'Sprache', en: 'Language' },
    description: { de: 'Launcher- und Minecraft-Sprache', en: 'Launcher and Minecraft language' },
    icon: Languages,
    keywords: 'sprache language deutsch english deutschland german minecraft options.txt',
  },
  {
    id: 'advanced',
    label: { de: 'Erweitert', en: 'Advanced' },
    description: { de: 'Sichern, Importieren und Zurücksetzen', en: 'Backup, import and reset' },
    icon: Wrench,
    keywords: 'erweitert advanced export import backup sichern zurücksetzen reset sicherheit security tokens',
  },
  {
    id: 'about',
    label: { de: 'Über', en: 'About' },
    description: { de: 'Version, Plattform und Datenquellen', en: 'Version, platform and data sources' },
    icon: Info,
    keywords: 'über about version plattform platform electron react datenquellen modrinth curseforge',
  },
  {
    id: 'accounts',
    label: { de: 'Konto', en: 'Accounts' },
    description: { de: 'Microsoft-Anmeldung und Sitzung', en: 'Microsoft sign-in and session' },
    icon: UserRound,
    keywords: 'konto account microsoft login anmelden abmelden uuid sitzung session profil',
  },
]

interface GamePanel {
  id: GamePanelId
  label: { de: string; en: string }
  description: { de: string; en: string }
  icon: React.ElementType
}

const GAME_PANELS: GamePanel[] = [
  {
    id: 'java',
    label: { de: 'Java & Speicher', en: 'Java & memory' },
    description: { de: 'RAM, Java-Pfad und JVM-Argumente', en: 'RAM, Java path and JVM arguments' },
    icon: Coffee,
  },
  {
    id: 'game',
    label: { de: 'Spieloptionen', en: 'Game options' },
    description: { de: 'Video, Audio, Sprache, Chat und mehr', en: 'Video, audio, language, chat and more' },
    icon: Gamepad2,
  },
  {
    id: 'controls',
    label: { de: 'Steuerung', en: 'Controls' },
    description: { de: 'Tastenbelegung im Tastatur-Layout', en: 'Keybinds in a keyboard layout' },
    icon: Keyboard,
  },
  {
    id: 'defaults',
    label: { de: 'Instanz-Standards', en: 'Instance defaults' },
    description: { de: 'Was neue Instanzen erben', en: 'What new instances inherit' },
    icon: Boxes,
  },
]

const TAB_COPY: Record<TabId, { title: { de: string; en: string }; desc: { de: string; en: string } }> = {
  general: {
    title: { de: 'Allgemein', en: 'General' },
    desc: {
      de: 'Start und Verhalten des Launchers.',
      en: 'Launcher startup and behavior.',
    },
  },
  appearance: {
    title: { de: 'Darstellung', en: 'Appearance' },
    desc: {
      de: 'Themes, Hintergrund und Effekte – alles an einem Ort, live und ohne Neustart.',
      en: 'Themes, background and effects – all in one place, live without a restart.',
    },
  },
  game: {
    title: { de: 'Spiel', en: 'Game' },
    desc: {
      de: 'Alles, was im Spiel landet: Java und RAM, Spieloptionen, Steuerung und die Standards für neue Instanzen.',
      en: 'Everything that reaches the game: Java and RAM, game options, controls and the defaults for new instances.',
    },
  },
  language: {
    title: { de: 'Sprache', en: 'Language' },
    desc: {
      de: 'Sprache der Oberfläche und die Sprache, die neue Instanzen im Spiel verwenden.',
      en: 'The interface language and the language new instances use in-game.',
    },
  },
  advanced: {
    title: { de: 'Erweitert', en: 'Advanced' },
    desc: {
      de: 'Sichere deine Konfiguration, stelle sie wieder her oder setze sie auf den Standard zurück.',
      en: 'Back up your configuration, restore it or reset it to defaults.',
    },
  },
  about: {
    title: { de: 'Über Bamboo', en: 'About Bamboo' },
    desc: {
      de: 'Version, Plattform und die Datenquellen, aus denen Bamboo seine Inhalte bezieht.',
      en: 'Version, platform and the data sources Bamboo uses for its content.',
    },
  },
  accounts: {
    title: { de: 'Konto', en: 'Accounts' },
    desc: {
      de: 'Melde dich mit deinem Microsoft-Konto an, um online zu spielen. Die Sitzung bleibt über Neustarts hinweg erhalten.',
      en: 'Sign in with your Microsoft account to play online. The session survives restarts.',
    },
  },
}

function resolveLegacySection(requested: string | null): { tab: TabId; panel: GamePanelId } {
  const legacy = requested as LegacySectionId | null
  switch (legacy) {
    case 'appearance':
    case 'themes':
      return { tab: 'appearance', panel: 'java' }
    case 'language':
      return { tab: 'language', panel: 'java' }
    case 'advanced':
      return { tab: 'advanced', panel: 'java' }
    case 'about':
      return { tab: 'about', panel: 'java' }
    case 'java':
      return { tab: 'game', panel: 'java' }
    case 'game':
      return { tab: 'game', panel: 'game' }
    case 'controls':
      return { tab: 'game', panel: 'controls' }
    case 'defaults':
      return { tab: 'game', panel: 'defaults' }
    case 'accounts':
      return { tab: 'accounts', panel: 'java' }
    default:
      return { tab: 'general', panel: 'java' }
  }
}

export interface SettingsViewProps {
  lang: LanguageType
  setLang: (lang: LanguageType) => void
  themeId: string
  setThemeId: (themeId: string) => void
  themes: ThemeDefinition[]
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
  totalPlaytimeMs?: number
  initialSection?: TabId
  accountSession: AccountSession
  updateStatus?: UpdateStatus | null
  onCheckForUpdates?: () => void
  onInstallUpdate?: () => void
}

function themeBackground(theme: ThemeDefinition): string | undefined {
  return theme.bgImage
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`
}

export function SettingsView({
  lang,
  setLang,
  themeId,
  setThemeId,
  themes,
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
  totalPlaytimeMs = 0,
  initialSection = 'general',
  accountSession,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
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
            ? t(L, 'Du verwendest die neueste Version.', 'You are on the latest version.')
            : updateStatus?.state === 'error'
              ? t(L, 'Update-Prüfung fehlgeschlagen. Später erneut versuchen.', 'Update check failed. Try again later.')
              : updateStatus?.state === 'disabled'
                ? t(L, 'Updates werden nur in der installierten App geprüft.', 'Updates are checked in the installed app only.')
                : t(L, 'Updates werden automatisch alle 6 Stunden geprüft.', 'Updates are checked automatically every 6 hours.')
  const [initialView] = useState(() => resolveLegacySection(readSettingsTarget() ?? initialSection))
  const [tab, setTab] = useState<TabId>(initialView.tab)
  const [gamePanel, setGamePanel] = useState<GamePanelId>(initialView.panel)

  useEffect(() => {
    const applyRequestedSection = () => {
      const requested = readSettingsTarget()
      if (!requested) return
      clearSettingsTarget()
      const next = resolveLegacySection(requested)
      setTab(next.tab)
      setGamePanel(next.panel)
    }
    applyRequestedSection()
    window.addEventListener(SETTINGS_TARGET_EVENT, applyRequestedSection)
    return () => window.removeEventListener(SETTINGS_TARGET_EVENT, applyRequestedSection)
  }, [])
  const openTab = (next: TabId) => setTab(next)
  const openGame = (panel: GamePanelId) => {
    setGamePanel(panel)
    setTab('game')
  }
  const [navQuery, setNavQuery] = useState('')
  const [javaVersions, setJavaVersions] = useState<{ path: string; version: number; verStr: string }[]>([])
  const [scanningJava, setScanningJava] = useState(false)
  const [themeQuery, setThemeQuery] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
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

  const filteredTabs = useMemo(() => {
    const query = navQuery.trim().toLocaleLowerCase()
    if (!query) return TABS
    return TABS.filter((item) =>
      `${item.label.de} ${item.label.en} ${item.description.de} ${item.keywords}`
        .toLocaleLowerCase()
        .includes(query),
    )
  }, [navQuery])

  const totalPlaytime = totalPlaytimeMs
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

  const copy = TAB_COPY[tab]
  const activeGamePanel = GAME_PANELS.find((panel) => panel.id === gamePanel) ?? GAME_PANELS[0]

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-hairline bg-root/35 px-5 pb-4 pt-5 min-[900px]:px-7">
        <div className="mx-auto flex w-full max-w-[1200px] items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent shadow-[var(--inset-rim)]">
            <Settings2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-micro font-medium uppercase tracking-label text-accent">
              Bamboo Launcher
            </p>
            <h1 className="m-0 mt-0.5 text-title2 font-semibold tracking-tight text-ink">
              {t(L, 'Einstellungen', 'Settings')}
            </h1>
            <p className="m-0 mt-0.5 text-small text-ink-secondary">
              {t(
                L,
                'Alles, was deinen Launcher und deine Instanzen ausmacht – an einem Ort.',
                'Everything that shapes your launcher and your instances – in one place.',
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 pt-1">
            <span
              className={cx(
                'inline-flex items-center gap-1.5 text-micro font-medium transition-opacity',
                saveState === 'idle' ? 'text-ink-tertiary' : saveState === 'saved' ? 'text-success' : 'text-ink-secondary',
              )}
            >
              {saveState === 'saved' ? <Check className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              {saveState === 'saved'
                ? t(L, 'Gespeichert', 'Saved')
                : saveState === 'saving'
                  ? t(L, 'Wird gespeichert …', 'Saving …')
                  : t(L, 'Automatisch gespeichert', 'Autosaved')}
            </span>
            <Badge>v{LAUNCHER_VERSION}</Badge>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-5 py-5 min-[900px]:flex-row min-[900px]:gap-7 min-[900px]:px-7">
          <aside className="w-full shrink-0 min-[900px]:w-[218px]">
            <div className="min-[900px]:sticky min-[900px]:top-0 flex flex-col gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
                <input
                  type="search"
                  value={navQuery}
                  onChange={(event) => setNavQuery(event.target.value)}
                  placeholder={t(L, 'Einstellungen suchen …', 'Search settings …')}
                  aria-label={t(L, 'Einstellungen suchen', 'Search settings')}
                  className="h-8 w-full rounded-lg border border-stroke bg-root/45 pl-8 pr-2 text-mini text-ink outline-none placeholder:text-ink-quaternary transition-colors focus:border-accent/50"
                />
              </div>

              <nav className="flex flex-row gap-2 overflow-x-auto pb-1 min-[900px]:flex-col min-[900px]:gap-0.5 min-[900px]:overflow-visible min-[900px]:pb-0">
                {filteredTabs.map((item) => {
                  const Icon = item.icon
                  const active = item.id === tab
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openTab(item.id)}
                      aria-current={active ? 'page' : undefined}
                      title={item.description[L]}
                      className={cx(
                        'group relative flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2 text-small font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer',
                        active
                          ? 'bg-accent/12 text-accent'
                          : 'text-ink-secondary hover:bg-hover hover:text-ink',
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
                      )}
                      <Icon className={cx('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-ink-tertiary')} />
                      <span className="truncate">{item.label[L]}</span>
                      {item.id === 'game' && keybindConflictCount > 0 && (
                        <span className="ml-auto hidden h-4 min-w-4 items-center justify-center rounded-full bg-danger/15 px-1 text-[10px] font-semibold text-danger min-[900px]:inline-flex">
                          {keybindConflictCount}
                        </span>
                      )}
                    </button>
                  )
                })}
                {filteredTabs.length === 0 && (
                  <p className="px-2 py-4 text-mini text-ink-tertiary">
                    {t(L, 'Kein Bereich gefunden.', 'No section found.')}
                  </p>
                )}
              </nav>

              <div className="hidden rounded-xl border border-hairline bg-root/30 px-3 py-2.5 min-[900px]:block">
                <p className="m-0 text-micro font-medium uppercase tracking-label text-ink-tertiary">
                  {t(L, 'Spielzeit', 'Playtime')}
                </p>
                <p className="m-0 mt-1 text-small font-medium text-ink">
                  {formatPlaytime(totalPlaytime, L)}
                </p>
                <p className="m-0 mt-0.5 text-micro text-ink-quaternary">
                  {t(L, 'Über alle Instanzen', 'Across all instances')}
                </p>
              </div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            <div className="mb-4">
              <h2 className="m-0 text-title3 font-semibold tracking-tight text-ink">{copy.title[L]}</h2>
              <p className="m-0 mt-1 max-w-[70ch] text-small text-ink-secondary">{copy.desc[L]}</p>
            </div>

            {tab === 'accounts' && (
              <AccountsPanel lang={L} session={accountSession} />
            )}

            {tab === 'general' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Start & Verhalten', 'Startup & behavior')}
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
              <div className="flex flex-col gap-4">
                <SectionHeading
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  title={t(L, 'Themes', 'Themes')}
                  desc={t(
                    L,
                    'Jedes Theme bringt eine eigene Akzentfarbe, Hintergrund und Partikel mit.',
                    'Every theme ships its own accent color, background and particles.',
                  )}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{themes.length} Themes</Badge>
                  <span className="text-mini text-ink-tertiary">
                    {t(L, 'Themes werden lokal mit dem Launcher ausgeliefert.', 'Themes ship locally with the launcher.')}
                  </span>
                  <div className="relative ml-auto">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
                    <input
                      type="search"
                      value={themeQuery}
                      onChange={(event) => setThemeQuery(event.target.value)}
                      placeholder={t(L, 'Themes suchen …', 'Search themes …')}
                      className="h-8 w-48 rounded-lg border border-stroke bg-root/45 pl-8 pr-2 text-mini text-ink outline-none placeholder:text-ink-quaternary focus:border-accent/50"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {themes
                    .filter((theme) =>
                      `${theme.name} ${theme.desc} ${theme.accentLabel}`
                        .toLocaleLowerCase()
                        .includes(themeQuery.trim().toLocaleLowerCase()),
                    )
                    .map((theme) => {
                      const active = theme.id === themeId
                      const bg = themeBackground(theme)
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          onClick={() => setThemeId(theme.id)}
                          className={cx(
                            'group relative overflow-hidden rounded-[var(--r-xl)] border text-left transition-[border-color,transform,box-shadow] duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                            active
                              ? 'border-accent/60 shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,transparent)]'
                              : 'border-stroke hover:-translate-y-px hover:border-rim',
                          )}
                        >
                          <div className="relative h-[104px] overflow-hidden bg-root">
                            {bg ? (
                              <img
                                src={bg}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover opacity-70 transition-transform duration-500 group-hover:scale-[1.03]"
                                onError={(event) => {
                                  (event.target as HTMLImageElement).style.display = 'none'
                                }}
                              />
                            ) : (
                              <div
                                className="h-full w-full"
                                style={{
                                  background: `radial-gradient(circle at 25% 20%, ${theme.accent}55, transparent 55%), linear-gradient(135deg, ${theme.accent}22, transparent 70%)`,
                                }}
                              />
                            )}
                            <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/20 to-transparent" />
                            <span
                              className="absolute left-3 top-3 h-5 w-5 rounded-full border-2 border-white/30 shadow-lg"
                              style={{ backgroundColor: theme.accent }}
                            />
                            {active && (
                              <span className="absolute right-3 top-3 inline-flex h-5 items-center gap-1 rounded-full bg-accent px-2 text-[10px] font-semibold text-accent-contrast">
                                <Check className="h-3 w-3" />
                                {t(L, 'Aktiv', 'Active')}
                              </span>
                            )}
                          </div>
                          <div className="px-3 pb-3 pt-1">
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="m-0 truncate text-small font-medium text-ink">{theme.name}</h3>
                              <span className="shrink-0 text-micro text-ink-quaternary">{theme.accentLabel}</span>
                            </div>
                            <p className="m-0 mt-0.5 line-clamp-2 min-h-8 text-micro leading-4 text-ink-secondary">
                              {theme.desc || t(L, 'Bamboo Theme', 'Bamboo theme')}
                            </p>
                          </div>
                        </button>
                      )
                    })}
                </div>

                {themes.length === 0 && (
                  <div className="rounded-xl border border-dashed border-stroke px-4 py-10 text-center">
                    <Sparkles className="mx-auto h-5 w-5 text-ink-tertiary" />
                    <p className="m-0 mt-2 text-small font-medium text-ink">
                      {t(L, 'Noch keine Themes geladen', 'No themes loaded yet')}
                    </p>
                    <p className="m-0 mt-1 text-mini text-ink-secondary">
                      {t(L, 'Sobald die Content-Sammlung synchronisiert ist, erscheinen sie hier.', 'They appear here once the content collection has synced.')}
                    </p>
                  </div>
                )}
                <SettingsCard
                  title={t(L, 'Hintergrund', 'Background')}
                  description={t(
                    L,
                    'Das Theme-Bild liegt hinter allen Ansichten.',
                    'The theme artwork sits behind every view.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Theme-Hintergrund anzeigen', 'Show theme background')}
                    description={t(L, 'Blendet das Hintergrundbild des aktiven Themes ein.', 'Shows the active theme artwork.')}
                    control={<Toggle checked={showBgImage} onChange={setShowBgImage} label={t(L, 'Hintergrund', 'Background')} />}
                  />
                  <SettingsRow
                    title={t(L, 'Helligkeit', 'Brightness')}
                    description={t(L, 'Wie stark das Hintergrundbild durchscheint.', 'How strongly the background shows through.')}
                    control={
                      <div className="w-[240px] max-w-[42vw]">
                        <Slider
                          min={0}
                          max={100}
                          value={bgBrightness}
                          disabled={!showBgImage}
                          onChange={setBgBrightness}
                          formatValue={(value) => `${value} %`}
                        />
                      </div>
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Unschärfe', 'Blur')}
                    description={t(L, 'Weichzeichnet das Hintergrundbild für mehr Lesbarkeit.', 'Softens the artwork for better readability.')}
                    control={
                      <div className="w-[240px] max-w-[42vw]">
                        <Slider
                          min={0}
                          max={20}
                          value={bgBlur}
                          disabled={!showBgImage}
                          onChange={setBgBlur}
                          formatValue={(value) => `${value} px`}
                        />
                      </div>
                    }
                  />
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Effekte', 'Effects')}
                  description={t(L, 'Kleine Details, die den Launcher lebendig machen.', 'Small details that bring the launcher to life.')}
                >
                  <SettingsRow
                    title={t(L, 'Partikel', 'Particles')}
                    description={t(L, 'Schwebende Partikel in der Akzentfarbe des Themes.', 'Floating particles in the theme accent color.')}
                    control={<Toggle checked={showParticles} onChange={setShowParticles} label={t(L, 'Partikel', 'Particles')} />}
                  />
                  <SettingsRow
                    title={t(L, 'Atmosphärischer Glow', 'Atmospheric glow')}
                    description={t(L, 'Farbige Lichtstimmung über dem Hintergrund.', 'Colored light wash on top of the background.')}
                    control={<Toggle checked={showGlow} onChange={setShowGlow} label={t(L, 'Glow', 'Glow')} />}
                  />
                </SettingsCard>

                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                    onClick={() => {
                      setShowBgImage(true)
                      setShowParticles(true)
                      setShowGlow(true)
                      setBgBrightness(35)
                      setBgBlur(0)
                      addToast({ type: 'success', message: t(L, 'Darstellung zurückgesetzt.', 'Appearance reset.') })
                    }}
                  >
                    {t(L, 'Darstellung zurücksetzen', 'Reset appearance')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'language' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Launcher-Sprache', 'Launcher language')}
                  description={t(L, 'Gilt sofort für die gesamte Oberfläche.', 'Applies to the whole interface immediately.')}
                >
                  <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
                    {[
                      { id: 'de' as const, title: 'Deutsch', desc: t(L, 'Deutsche Oberfläche', 'German interface'), flag: 'DE' },
                      { id: 'en' as const, title: 'English', desc: t(L, 'Englische Oberfläche', 'English interface'), flag: 'EN' },
                    ].map((option) => {
                      const active = lang === option.id
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setLang(option.id)}
                          className={cx(
                            'flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors duration-[var(--t-quick)] cursor-pointer',
                            active
                              ? 'border-accent/45 bg-accent/8'
                              : 'border-stroke bg-root/30 hover:border-rim hover:bg-hover',
                          )}
                        >
                          <span
                            className={cx(
                              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-micro font-semibold',
                              active ? 'border-accent/30 bg-accent/15 text-accent' : 'border-stroke bg-raised text-ink-secondary',
                            )}
                          >
                            {option.flag}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-small font-medium text-ink">{option.title}</span>
                            <span className="block text-micro text-ink-secondary">{option.desc}</span>
                          </span>
                          {active && <Check className="h-4 w-4 shrink-0 text-accent" />}
                        </button>
                      )
                    })}
                  </div>
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Minecraft-Sprache', 'Minecraft language')}
                  description={t(
                    L,
                    'Wird beim Start in die options.txt der Instanz übernommen – auch bei bestehenden Instanzen.',
                    'Applied to the instance options.txt on every launch, including existing instances.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Spielsprache', 'In-game language')}
                    description={t(L, 'Die Sprache von Menüs, Untertiteln und Meldungen im Spiel.', 'The language of in-game menus, subtitles and messages.')}
                    control={
                      <SelectField
                        value={preferences.instanceDefaults.minecraftLanguage}
                        onChange={(value) =>
                          updatePreferences((current) => ({
                            ...current,
                            instanceDefaults: { ...current.instanceDefaults, minecraftLanguage: value },
                          }))
                        }
                        options={MINECRAFT_LANGUAGES.map((entry) => ({
                          value: entry.code,
                          label: entry.name,
                        }))}
                        className="w-52"
                        ariaLabel={t(L, 'Minecraft-Sprache', 'Minecraft language')}
                      />
                    }
                  />
                </SettingsCard>
              </div>
            )}

            {tab === 'game' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-1 rounded-xl border border-stroke bg-surface/50 p-1">
                  {GAME_PANELS.map((panel) => {
                    const Icon = panel.icon
                    const active = panel.id === gamePanel
                    return (
                      <button
                        key={panel.id}
                        type="button"
                        onClick={() => openGame(panel.id)}
                        aria-pressed={active}
                        className={cx(
                          'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-mini font-medium transition-colors duration-[var(--t-quick)] cursor-pointer',
                          active ? 'bg-accent/12 text-accent' : 'text-ink-secondary hover:bg-hover hover:text-ink',
                        )}
                      >
                        <Icon className={cx('h-3.5 w-3.5', active ? 'text-accent' : 'text-ink-tertiary')} />
                        {panel.label[L]}
                      </button>
                    )
                  })}
                </div>
                <p className="m-0 px-1 text-mini text-ink-secondary">{activeGamePanel.description[L]}</p>
              </div>
            )}

            {tab === 'game' && gamePanel === 'java' && (
              <div className="mt-4 flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Arbeitsspeicher', 'Memory')}
                  description={t(L, 'Standard-RAM für neue Instanzen.', 'Default RAM for new instances.')}
                  action={<Badge tone="accent">{gb(preferences.instanceDefaults.ramMb)}</Badge>}
                >
                  <SettingsRow
                    title={t(L, 'Maximaler RAM (-Xmx)', 'Maximum RAM (-Xmx)')}
                    description={
                      preferences.instanceDefaults.ramMb > 12288
                        ? t(L, 'Über 12 GB können bei modded Minecraft GC-Lags verursachen.', 'Above 12 GB can cause GC stalls in modded Minecraft.')
                        : t(L, 'Empfohlen: 4–8 GB für Modpacks, 2–4 GB für Vanilla.', 'Recommended: 4–8 GB for modpacks, 2–4 GB for vanilla.')
                    }
                    badge={
                      preferences.instanceDefaults.ramMb < 2048 ? (
                        <Badge tone="warning">{t(L, 'Sehr wenig', 'Very low')}</Badge>
                      ) : undefined
                    }
                    control={
                      <div className="w-[300px] max-w-[46vw]">
                        <Slider
                          min={RAM_MIN_MB}
                          max={RAM_MAX_MB}
                          step={RAM_STEP_MB}
                          value={preferences.instanceDefaults.ramMb}
                          onChange={(value) =>
                            updatePreferences((current) => ({
                              ...current,
                              instanceDefaults: {
                                ...current.instanceDefaults,
                                ramMb: value,
                                minRamMb: Math.min(current.instanceDefaults.minRamMb, value),
                              },
                            }))
                          }
                          formatValue={gb}
                          minLabel="1 GB"
                          maxLabel="16 GB"
                        />
                      </div>
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Minimaler RAM (-Xms)', 'Minimum RAM (-Xms)')}
                    description={t(L, 'Startgröße der Java-Heap. Meist reicht 1 GB.', 'Initial Java heap size. Usually 1 GB is enough.')}
                    control={
                      <div className="w-[300px] max-w-[46vw]">
                        <Slider
                          min={512}
                          max={preferences.instanceDefaults.ramMb}
                          step={256}
                          value={preferences.instanceDefaults.minRamMb}
                          onChange={(value) =>
                            updatePreferences((current) => ({
                              ...current,
                              instanceDefaults: { ...current.instanceDefaults, minRamMb: value },
                            }))
                          }
                          formatValue={gb}
                        />
                      </div>
                    }
                  />
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Java', 'Java')}
                  description={t(L, 'Wird für neue Instanzen verwendet, sofern sie auf „Automatisch“ stehen.', 'Used for new instances that are set to “Automatic”.')}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Search className="h-3 w-3" />}
                      onClick={() => scanJava(true)}
                      disabled={scanningJava}
                    >
                      {scanningJava ? t(L, 'Suche …', 'Scanning …') : t(L, 'Java suchen', 'Find Java')}
                    </Button>
                  }
                >
                  <SettingsRow
                    title={t(L, 'Java-Installation', 'Java installation')}
                    description={t(L, 'Der Launcher erkennt fehlende Versionen und schlägt die passende Java-Version vor.', 'The launcher detects missing versions and suggests the right Java runtime.')}
                    control={
                      <SelectField
                        value={preferences.instanceDefaults.javaPath}
                        onChange={(value) =>
                          updatePreferences((current) => ({
                            ...current,
                            instanceDefaults: { ...current.instanceDefaults, javaPath: value },
                          }))
                        }
                        options={[
                          { value: '', label: t(L, 'Automatisch (empfohlen)', 'Automatic (recommended)') },
                          ...javaVersions.map((entry) => ({
                            value: entry.path,
                            label: `Java ${entry.verStr || entry.version} — ${entry.path}`,
                          })),
                          ...(preferences.instanceDefaults.javaPath &&
                          !javaVersions.some((entry) => entry.path === preferences.instanceDefaults.javaPath)
                            ? [{ value: preferences.instanceDefaults.javaPath, label: preferences.instanceDefaults.javaPath }]
                            : []),
                        ]}
                        className="w-[280px] max-w-[46vw]"
                        ariaLabel={t(L, 'Java-Installation', 'Java installation')}
                      />
                    }
                  />
                  <SettingsRow
                    title={t(L, 'JVM-Argumente', 'JVM arguments')}
                    description={t(L, 'Optional. Werden an jeden Start angehängt, z. B. -XX:+UseG1GC.', 'Optional. Appended to every launch, e.g. -XX:+UseG1GC.')}
                    control={
                      <TextField
                        value={preferences.instanceDefaults.jvmArgs}
                        onChange={(value) =>
                          updatePreferences((current) => ({
                            ...current,
                            instanceDefaults: { ...current.instanceDefaults, jvmArgs: value },
                          }))
                        }
                        placeholder="-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
                        mono
                        className="w-[300px] max-w-[46vw]"
                        ariaLabel={t(L, 'JVM-Argumente', 'JVM arguments')}
                      />
                    }
                  />
                </SettingsCard>

                <Button
                  variant="ghost"
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                  onClick={() =>
                    updatePreferences((current) => ({
                      ...current,
                      instanceDefaults: { ...DEFAULT_PREFERENCES.instanceDefaults },
                    }))
                  }
                  className="self-end"
                >
                  {t(L, 'Java & Speicher zurücksetzen', 'Reset Java & memory')}
                </Button>
              </div>
            )}

            {tab === 'game' && gamePanel === 'game' && (
              <div className="mt-4 flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Spielsprache', 'In-game language')}
                  description={t(
                    L,
                    'Gilt für Menüs, Untertitel und Meldungen im Spiel.',
                    'Applies to in-game menus, subtitles and messages.',
                  )}
                >
                  <SettingsRow
                    icon={<Languages className="h-3.5 w-3.5" />}
                    title={t(L, 'Minecraft-Sprache', 'Minecraft language')}
                    description={t(
                      L,
                      'Wird beim Start in die options.txt der Instanz übernommen – auch bei bestehenden Instanzen.',
                      'Applied to the instance options.txt on every launch, including existing instances.',
                    )}
                    control={
                      <SelectField
                        value={preferences.instanceDefaults.minecraftLanguage}
                        onChange={(value) =>
                          updatePreferences((current) => ({
                            ...current,
                            instanceDefaults: { ...current.instanceDefaults, minecraftLanguage: value },
                          }))
                        }
                        options={MINECRAFT_LANGUAGES.map((entry) => ({
                          value: entry.code,
                          label: entry.name,
                        }))}
                        className="w-52"
                        ariaLabel={t(L, 'Minecraft-Sprache', 'Minecraft language')}
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
                    'Diese Werte gelten als Standard. Angepasste Werte werden beim Start in die options.txt übernommen – Werte auf Standard lassen dem Spiel freie Hand.',
                    'These are the defaults. Customised values are applied to options.txt on every launch; values left at their default stay under your control in-game.',
                  )}
                />
              </div>
            )}

            {tab === 'game' && gamePanel === 'controls' && (
              <div className="mt-4">
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
                  <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-stroke bg-root/30 px-3 py-2.5 text-mini leading-5 text-ink-secondary">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary" />
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

            {tab === 'game' && gamePanel === 'defaults' && (
              <div className="mt-4 flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Neue Instanzen', 'New instances')}
                  description={t(L, 'Wird beim Erstellen einer Instanz übernommen.', 'Applied when an instance is created.')}
                >
                  <SettingsRow
                    icon={<MemoryStick className="h-3.5 w-3.5" />}
                    title={t(L, 'Arbeitsspeicher', 'Memory')}
                    description={gb(preferences.instanceDefaults.ramMb)}
                    control={
                      <Button variant="secondary" size="sm" onClick={() => openGame('java')}>
                        {t(L, 'Ändern', 'Change')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    icon={<Coffee className="h-3.5 w-3.5" />}
                    title={t(L, 'Java', 'Java')}
                    description={
                      preferences.instanceDefaults.javaPath
                        ? preferences.instanceDefaults.javaPath.split(/[\\/]/).pop() || preferences.instanceDefaults.javaPath
                        : t(L, 'Automatisch (empfohlen)', 'Automatic (recommended)')
                    }
                    control={
                      <Button variant="secondary" size="sm" onClick={() => openGame('java')}>
                        {t(L, 'Ändern', 'Change')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    icon={<Languages className="h-3.5 w-3.5" />}
                    title={t(L, 'Minecraft-Sprache', 'Minecraft language')}
                    description={
                      MINECRAFT_LANGUAGES.find((entry) => entry.code === preferences.instanceDefaults.minecraftLanguage)?.name ||
                      preferences.instanceDefaults.minecraftLanguage
                    }
                    control={
                      <Button variant="secondary" size="sm" onClick={() => openGame('game')}>
                        {t(L, 'Ändern', 'Change')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Im Vollbild starten', 'Start in fullscreen')}
                    description={t(L, 'Neue Instanzen starten direkt im Vollbildmodus.', 'New instances start in fullscreen mode.')}
                    control={
                      <Toggle
                        checked={preferences.instanceDefaults.window.fullscreen}
                        onChange={(value) =>
                          updatePreferences((current) => ({
                            ...current,
                            instanceDefaults: {
                              ...current.instanceDefaults,
                              window: { ...current.instanceDefaults.window, fullscreen: value },
                            },
                          }))
                        }
                        label={t(L, 'Vollbild', 'Fullscreen')}
                      />
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Fensterauflösung', 'Window resolution')}
                    description={t(
                      L,
                      'Standard nutzt die Auflösung des Desktops.',
                      'Default uses the desktop resolution.',
                    )}
                    control={
                      <div className="flex flex-col items-end gap-2">
                        <Segmented
                          value={preferences.instanceDefaults.window.mode}
                          onChange={(mode) =>
                            updatePreferences((current) => ({
                              ...current,
                              instanceDefaults: {
                                ...current.instanceDefaults,
                                window: { ...current.instanceDefaults.window, mode },
                              },
                            }))
                          }
                          size="sm"
                          options={[
                            { value: 'default', label: t(L, 'Desktop', 'Desktop') },
                            { value: 'custom', label: t(L, 'Benutzerdefiniert', 'Custom') },
                          ]}
                        />
                        {preferences.instanceDefaults.window.mode === 'custom' && (
                          <div className="flex items-center gap-1.5">
                            <TextField
                              value={String(preferences.instanceDefaults.window.width)}
                              onChange={(value) => {
                                const parsed = Number.parseInt(value, 10)
                                if (!Number.isFinite(parsed)) return
                                updatePreferences((current) => ({
                                  ...current,
                                  instanceDefaults: {
                                    ...current.instanceDefaults,
                                    window: {
                                      ...current.instanceDefaults.window,
                                      width: Math.max(320, Math.min(7680, parsed)),
                                    },
                                  },
                                }))
                              }}
                              inputClassName="w-16 text-center"
                              ariaLabel={t(L, 'Breite', 'Width')}
                            />
                            <span className="text-micro text-ink-quaternary">×</span>
                            <TextField
                              value={String(preferences.instanceDefaults.window.height)}
                              onChange={(value) => {
                                const parsed = Number.parseInt(value, 10)
                                if (!Number.isFinite(parsed)) return
                                updatePreferences((current) => ({
                                  ...current,
                                  instanceDefaults: {
                                    ...current.instanceDefaults,
                                    window: {
                                      ...current.instanceDefaults.window,
                                      height: Math.max(240, Math.min(4320, parsed)),
                                    },
                                  },
                                }))
                              }}
                              inputClassName="w-16 text-center"
                              ariaLabel={t(L, 'Höhe', 'Height')}
                            />
                          </div>
                        )}
                      </div>
                    }
                  />
                </SettingsCard>

                <SettingsCard title={t(L, 'Was Instanzen erben', 'What instances inherit')}>
                  <SettingsRow
                    icon={<Keyboard className="h-3.5 w-3.5" />}
                    title={t(L, 'Tastenbelegung', 'Keybinds')}
                    description={t(
                      L,
                      `${ALL_KEYBIND_ACTIONS.length} Aktionen · ${keybindConflictCount} Konflikte`,
                      `${ALL_KEYBIND_ACTIONS.length} actions · ${keybindConflictCount} conflicts`,
                    )}
                    control={
                      <Button variant="secondary" size="sm" onClick={() => openGame('controls')}>
                        {t(L, 'Bearbeiten', 'Edit')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    icon={<Gamepad2 className="h-3.5 w-3.5" />}
                    title={t(L, 'Spieloptionen', 'Game options')}
                    description={t(
                      L,
                      `${GAME_OPTIONS.filter((option) => preferences.gameOptions[option.key] !== option.defaultValue).length} von ${GAME_OPTIONS.length} angepasst`,
                      `${GAME_OPTIONS.filter((option) => preferences.gameOptions[option.key] !== option.defaultValue).length} of ${GAME_OPTIONS.length} customized`,
                    )}
                    control={
                      <Button variant="secondary" size="sm" onClick={() => openGame('game')}>
                        {t(L, 'Bearbeiten', 'Edit')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    icon={<Monitor className="h-3.5 w-3.5" />}
                    title={t(L, 'Fenster & Vollbild', 'Window & fullscreen')}
                    description={t(
                      L,
                      preferences.instanceDefaults.window.mode === 'custom'
                        ? `${preferences.instanceDefaults.window.width} × ${preferences.instanceDefaults.window.height}`
                        : t(L, 'Desktop-Auflösung', 'Desktop resolution'),
                      preferences.instanceDefaults.window.mode === 'custom'
                        ? `${preferences.instanceDefaults.window.width} × ${preferences.instanceDefaults.window.height}`
                        : 'Desktop resolution',
                    )}
                    control={
                      <Badge tone={preferences.instanceDefaults.window.fullscreen ? 'accent' : 'neutral'}>
                        {preferences.instanceDefaults.window.fullscreen ? t(L, 'Vollbild', 'Fullscreen') : t(L, 'Fenster', 'Window')}
                      </Badge>
                    }
                  />
                </SettingsCard>

                <div className="flex justify-end">
                  <ConfirmButton
                    onConfirm={() => {
                      updatePreferences((current) => ({
                        ...current,
                        instanceDefaults: { ...DEFAULT_PREFERENCES.instanceDefaults },
                        keybinds: { ...DEFAULT_KEYBINDS },
                        gameOptions: { ...DEFAULT_GAME_OPTIONS },
                      }))
                      addToast({ type: 'success', message: t(L, 'Instanz-Standards zurückgesetzt.', 'Instance defaults reset.') })
                    }}
                    confirmLabel={t(L, 'Wirklich zurücksetzen?', 'Really reset?')}
                    variant="secondary"
                    icon={<RotateCcw className="h-3 w-3" />}
                  >
                    {t(L, 'Alle Instanz-Standards zurücksetzen', 'Reset all instance defaults')}
                  </ConfirmButton>
                </div>
              </div>
            )}

            {tab === 'advanced' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Sichern & Wiederherstellen', 'Backup & restore')}
                  description={t(L, 'Die Datei enthält nur Launcher-Einstellungen – keine Konten oder Tokens.', 'The file only contains launcher settings – no accounts or tokens.')}
                >
                  <SettingsRow
                    icon={<Download className="h-3.5 w-3.5" />}
                    title={t(L, 'Einstellungen exportieren', 'Export settings')}
                    description={t(L, 'Als lesbare JSON-Datei speichern.', 'Save as a readable JSON file.')}
                    control={
                      <Button variant="secondary" size="sm" onClick={exportPreferences} icon={<Download className="h-3 w-3" />}>
                        {t(L, 'Exportieren', 'Export')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    icon={<Upload className="h-3.5 w-3.5" />}
                    title={t(L, 'Einstellungen importieren', 'Import settings')}
                    description={t(L, 'Eine zuvor exportierte Datei auswählen.', 'Choose a previously exported file.')}
                    control={
                      <>
                        <input
                          ref={importRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            if (file) void importPreferences(file)
                            event.target.value = ''
                          }}
                        />
                        <Button variant="secondary" size="sm" onClick={() => importRef.current?.click()} icon={<Upload className="h-3 w-3" />}>
                          {t(L, 'Importieren', 'Import')}
                        </Button>
                      </>
                    }
                  />
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Zurücksetzen', 'Reset')}
                  description={t(L, 'Setzt RAM, Java, Keybinds, Spieloptionen und Verhalten auf den Launcher-Standard zurück.', 'Restores RAM, Java, keybinds, game options and behavior to launcher defaults.')}
                >
                  <SettingsRow
                    title={t(L, 'Alle Launcher-Einstellungen zurücksetzen', 'Reset all launcher settings')}
                    description={t(L, 'Themes, Sprache und Darstellung bleiben erhalten.', 'Themes, language and appearance stay untouched.')}
                    control={
                      <ConfirmButton
                        onConfirm={() => {
                          setPreferences({ ...DEFAULT_PREFERENCES, keybinds: { ...DEFAULT_KEYBINDS }, gameOptions: { ...DEFAULT_GAME_OPTIONS } })
                          addToast({ type: 'success', message: t(L, 'Einstellungen zurückgesetzt.', 'Settings reset.') })
                        }}
                        confirmLabel={t(L, 'Wirklich zurücksetzen?', 'Really reset?')}
                        icon={<RotateCcw className="h-3 w-3" />}
                      >
                        {t(L, 'Zurücksetzen', 'Reset')}
                      </ConfirmButton>
                    }
                  />
                </SettingsCard>

                <SettingsCard title={t(L, 'Sicherheit', 'Security')}>
                  <SettingsRow
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                    title={t(L, 'Tokens bleiben im Betriebssystem-Tresor', 'Tokens stay in the OS secret store')}
                    description={t(
                      L,
                      'Microsoft-Tokens werden niemals in settings.json oder in Exporten gespeichert.',
                      'Microsoft tokens are never written to settings.json or exports.',
                    )}
                    control={<Badge tone="success">{t(L, 'Aktiv', 'Active')}</Badge>}
                  />
                </SettingsCard>
              </div>
            )}

            {tab === 'about' && (
              <div className="flex flex-col gap-4">
                <div className="overflow-hidden rounded-[var(--r-xl)] border border-stroke bg-surface/65">
                  <div className="relative flex items-center gap-4 border-b border-hairline bg-gradient-to-br from-accent/12 via-transparent to-transparent px-5 py-5">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10">
                      <Layers className="h-7 w-7 text-accent" />
                    </div>
                    <div>
                      <h3 className="m-0 text-title3 font-semibold text-ink">Bamboo Launcher</h3>
                      <p className="m-0 mt-1 text-small text-ink-secondary">
                        {t(L, 'Ein moderner, schneller Minecraft-Launcher.', 'A modern, fast Minecraft launcher.')}
                      </p>
                    </div>
                    <Badge tone="accent" className="ml-auto">
                      v{LAUNCHER_VERSION}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-px bg-hairline sm:grid-cols-3">
                    {[
                      { label: t(L, 'Plattform', 'Platform'), value: navigator.userAgent.includes('Windows') ? 'Windows' : 'Desktop' },
                      { label: t(L, 'Electron', 'Electron'), value: '30' },
                      { label: t(L, 'Oberfläche', 'Interface'), value: 'React 19' },
                    ].map((entry) => (
                      <div key={entry.label} className="bg-surface px-4 py-3">
                        <p className="m-0 text-micro font-medium uppercase tracking-label text-ink-tertiary">{entry.label}</p>
                        <p className="m-0 mt-1 text-small font-medium text-ink">{entry.value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <SettingsCard title={t(L, 'Updates', 'Updates')}>
                  <SettingsRow
                    icon={<RefreshCw className={updateBusy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
                    title={t(L, 'Launcher-Updates', 'Launcher updates')}
                    description={updateSummary}
                    control={
                      updateReady ? (
                        <Button variant="ghost" size="sm" onClick={() => void onInstallUpdate?.()}>
                          {t(L, 'Neu starten', 'Restart now')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
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

                <SettingsCard title={t(L, 'Datenquellen', 'Data sources')}>
                  <SettingsRow
                    title="Modrinth"
                    description={t(L, 'Mods, Modpacks und Projektdaten.', 'Mods, modpacks and project metadata.')}
                    control={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<ExternalLink className="h-3 w-3" />}
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
                        icon={<ExternalLink className="h-3 w-3" />}
                        onClick={() => window.electronAPI?.system.openExternal?.('https://www.curseforge.com/minecraft')}
                      >
                        curseforge.com
                      </Button>
                    }
                  />
                </SettingsCard>

                <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-stroke bg-root/30 px-3 py-2.5 text-mini leading-5 text-ink-secondary">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary" />
                  <span>
                    {t(
                      L,
                      'Bamboo ist ein Community-Projekt und steht in keiner offiziellen Verbindung zu Mojang, Microsoft, Modrinth oder CurseForge.',
                      'Bamboo is a community project and is not affiliated with Mojang, Microsoft, Modrinth or CurseForge.',
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionHeading({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode
  title: string
  desc?: string
}) {
  return (
    <div className="flex items-start gap-2.5 pt-1">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-stroke bg-root/40 text-ink-tertiary">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="m-0 text-small font-semibold tracking-tight text-ink">{title}</h3>
        {desc ? <p className="m-0 mt-0.5 text-mini leading-5 text-ink-secondary">{desc}</p> : null}
      </div>
    </div>
  )
}
