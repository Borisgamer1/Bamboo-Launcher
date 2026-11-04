import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Check,
  Coffee,
  Download,
  ExternalLink,
  Gamepad2,
  Info,
  Keyboard,
  Languages,
  Palette,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
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
  MINECRAFT_LANGUAGES,
} from '../lib/gameOptions'
import { DEFAULT_KEYBINDS, keybindConflicts } from '../lib/keybinds'
import { prepareInstanceCover } from '../lib/instanceCovers'
import { PRESET_BLUR, PRESET_BRIGHTNESS } from '../data/themes'
import {
  SETTINGS_TARGET_EVENT,
  clearSettingsTarget,
  readSettingsTarget,
} from '../lib/settingsNavigation'
import { KeybindsPanel } from './settings/KeybindsPanel'
import { AccountsPanel } from './settings/AccountsPanel'
import { GameOptionsPanel } from './settings/GameOptionsPanel'
import { FontSettingsCard } from './settings/FontSettingsCard'
import { StatisticsSettingsTab } from './settings/StatisticsSettingsTab'
import {
  Button,
  ConfirmButton,
  Segmented,
  SelectField,
  SettingsCard,
  SettingsRow,
  Slider,
  TextField,
  Toggle,
  type Lang,
} from './settings/SettingsPrimitives'
import { cx, t } from './settings/settingsUtils'
import { useToast } from './Toast'
import { useStatistics } from '../hooks/useStatistics'
import type { AccountSession } from '../lib/accountSession'
import type { ThemeMode } from '../hooks/useTheme'
import type { LauncherFont } from '../lib/launcherFont'
import type { Instance } from './InstancesView'
import type { UpdateStatus } from '../electron'
import { LAUNCHER_VERSION } from '../lib/version'

type TabId = 'general' | 'appearance' | 'java' | 'gameOptions' | 'keybinds' | 'language' | 'advanced' | 'statistics' | 'about' | 'accounts'

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
  | 'statistics'
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
    id: 'java',
    label: { de: 'Java & Speicher', en: 'Java & memory' },
    description: { de: 'Arbeitsspeicher, Java-Pfad und JVM-Argumente', en: 'Memory, Java path and JVM arguments' },
    icon: Coffee,
    keywords: 'ram memory java jvm speicher arbeitsspeicher',
  },
  {
    id: 'gameOptions',
    label: { de: 'Spieloptionen', en: 'Game options' },
    description: { de: 'Video, Audio, Steuerung, Chat und Barrierefreiheit', en: 'Video, audio, controls, chat and accessibility' },
    icon: Gamepad2,
    keywords: 'video audio sound grafik spieloptionen options maus mausempfindlichkeit mouse sensitivity fov sichtweite chat',
  },
  {
    id: 'keybinds',
    label: { de: 'Tastenbelegungen', en: 'Key-Binds' },
    description: { de: 'Tastenbelegung im Tastatur-Layout', en: 'Keybindings in the keyboard layout' },
    icon: Keyboard,
    keywords: 'steuerung controls keybinds tasten keyboard tastatur belegung',
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
    id: 'statistics',
    label: { de: 'Statistiken', en: 'Statistics' },
    description: { de: 'Spielzeit, Blöcke und Distanz', en: 'Playtime, blocks and distance' },
    icon: BarChart3,
    keywords: 'statistiken statistics spielzeit playtime blöcke blocks distanz distance gelaufen mined placed sessions ledger',
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

interface SettingsGroup {
  id: string
  label: { de: string; en: string }
  tabs: TabId[]
}

/** Sidebar grouping only: the tab order, labels and contents stay untouched. */
const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'launcher',
    label: { de: 'Launcher', en: 'Launcher' },
    tabs: ['general', 'appearance'],
  },
  {
    id: 'in-game',
    label: { de: 'In-Game', en: 'In-Game' },
    tabs: ['java', 'gameOptions', 'keybinds', 'language', 'accounts'],
  },
  {
    id: 'advanced',
    label: { de: 'Erweitert', en: 'Advanced' },
    tabs: ['advanced', 'statistics', 'about'],
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
  java: {
    title: { de: 'Java & Speicher', en: 'Java & memory' },
    desc: {
      de: 'Arbeitsspeicher und Java.',
      en: 'Memory and Java.',
    },
  },
  gameOptions: {
    title: { de: 'Spieloptionen', en: 'Game options' },
    desc: {
      de: 'Video, Audio, Steuerung, Chat und Barrierefreiheit.',
      en: 'Video, audio, controls, chat and accessibility.',
    },
  },
  keybinds: {
    title: { de: 'Tastenbelegungen', en: 'Key-Binds' },
    desc: {
      de: 'Tastenbelegung im gewählten Tastatur-Layout.',
      en: 'Keybindings in the selected keyboard layout.',
    },
  },
  language: {
    title: { de: 'Sprache', en: 'Language' },
    desc: {
      de: 'Oberfläche und Spiel.',
      en: 'Interface and game.',
    },
  },
  advanced: {
    title: { de: 'Erweitert', en: 'Advanced' },
    desc: {
      de: 'Sichere deine Konfiguration, stelle sie wieder her oder setze sie auf den Standard zurück.',
      en: 'Back up your configuration, restore it or reset it to defaults.',
    },
  },
  statistics: {
    title: { de: 'Statistiken', en: 'Statistics' },
    desc: {
      de: 'Deine gesamte Spielzeit, Blöcke und Distanz – auch nach dem Löschen einer Instanz.',
      en: 'Your total playtime, blocks and distance – even after deleting an instance.',
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

function resolveLegacySection(requested: string | null): TabId {
  const legacy = requested as LegacySectionId | null
  switch (legacy) {
    case 'appearance':
    case 'themes':
      return 'appearance'
    case 'language':
      return 'language'
    case 'advanced':
      return 'advanced'
    case 'statistics':
      return 'statistics'
    case 'about':
      return 'about'
    case 'java':
      return 'java'
    case 'game':
      return 'gameOptions'
    case 'controls':
      return 'keybinds'
    case 'defaults':
      return 'java'
    case 'accounts':
      return 'accounts'
    default:
      return 'general'
  }
}

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
  const [uploadingBackground, setUploadingBackground] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  // The settings sidebar and the tab share one aggregate, so the client stays
  // here and the tab receives its snapshot.
  const statistics = useStatistics()
  const importRef = useRef<HTMLInputElement>(null)
  const backgroundInputRef = useRef<HTMLInputElement>(null)
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

  const updateCustomAccent = (value: string) => {
    const next = value.startsWith('#') ? value : `#${value}`
    setAccentDraft(next)
    if (/^#[0-9a-f]{6}$/i.test(next)) setCustomAccent(next.toLowerCase())
  }

  const readBackgroundFile = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })

  const handleBackgroundFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !file.type.startsWith('image/')) return

    setUploadingBackground(true)
    try {
      const dataUrl = await readBackgroundFile(file)
      if (!dataUrl) {
        addToast({ type: 'error', message: t(L, 'Bild konnte nicht geladen werden.', 'Could not load the image.') })
        return
      }
      setCustomBg(await prepareInstanceCover(dataUrl))
      setShowBgImage(true)
    } finally {
      setUploadingBackground(false)
    }
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
                  {t(L, 'Spielzeit', 'Playtime')}
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
              <div className="flex flex-col gap-6">
                <FontSettingsCard lang={lang} value={launcherFont} onChange={setLauncherFont} />

                <section>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 className="m-0 text-small font-medium text-ink">{t(L, 'Themes', 'Themes')}</h3>
                      <p className="m-0 mt-0.5 max-w-[62ch] text-mini leading-5 text-ink-secondary">
                        {t(
                          L,
                          'Jedes Theme bringt eine eigene Akzentfarbe, einen Hintergrund und Partikel mit.',
                          'Every theme ships its own accent color, background and particles.',
                        )}
                      </p>
                    </div>
                    <Segmented<ThemeMode>
                      value={mode}
                      onChange={setMode}
                      className="self-start"
                      options={[
                        { value: 'preset', label: t(L, 'Presets', 'Presets') },
                        { value: 'custom', label: t(L, 'Eigene Farben', 'Custom') },
                      ]}
                    />
                  </div>

                {mode === 'preset' ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-micro text-ink-tertiary">
                        {themes.length} Themes · {t(L, 'lokal mit dem Launcher ausgeliefert', 'shipped locally with the launcher')}
                      </span>
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
                        <input
                          type="search"
                          value={themeQuery}
                          onChange={(event) => setThemeQuery(event.target.value)}
                          placeholder={t(L, 'Themes suchen …', 'Search themes …')}
                          className="h-8 w-52 rounded-md border border-hairline bg-canvas pl-8 pr-2 text-mini text-ink outline-none placeholder:text-ink-quaternary transition-colors hover:border-rim focus:border-accent/50"
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
                                  'group overflow-hidden rounded-[10px] border bg-canvas text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                                  active ? 'border-accent/50' : 'border-hairline hover:border-rim',
                                )}
                              >
                                <div className="relative h-[124px] overflow-hidden bg-root">
                                  {bg ? (
                                    <img
                                      src={bg}
                                      alt=""
                                      loading="lazy"
                                      className="h-full w-full object-cover"
                                      onError={(event) => {
                                        (event.target as HTMLImageElement).style.display = 'none'
                                      }}
                                    />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                      <span
                                        className="h-8 w-8 rounded-full"
                                        style={{ backgroundColor: theme.accent }}
                                      />
                                    </div>
                                  )}
                                  <span
                                    className="absolute inset-x-0 top-0 h-[3px]"
                                    style={{ backgroundColor: theme.accent }}
                                  />
                                  {active && (
                                    <span className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-root/85 ring-1 ring-white/15">
                                      <Check className="h-3.5 w-3.5 text-accent" />
                                    </span>
                                  )}
                                </div>
                                <div className="px-3.5 py-2.5">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <h3 className="m-0 truncate text-small font-medium text-ink">{theme.name}</h3>
                                    <span className="shrink-0 font-mono text-micro text-ink-quaternary">{theme.accent}</span>
                                  </div>
                                  <p className="m-0 mt-0.5 line-clamp-2 min-h-8 text-micro leading-4 text-ink-secondary">
                                    {theme.desc?.[L] || t(L, 'Bamboo Theme', 'Bamboo theme')}
                                  </p>
                                </div>
                              </button>
                            )
                          })}
                      </div>

                      {themes.length === 0 && (
                        <div className="rounded-lg border border-hairline bg-canvas px-5 py-8 text-center">
                          <p className="m-0 text-small font-medium text-ink">
                            {t(L, 'Noch keine Themes geladen', 'No themes loaded yet')}
                          </p>
                          <p className="m-0 mt-1 text-mini text-ink-secondary">
                            {t(L, 'Sobald die Content-Sammlung synchronisiert ist, erscheinen sie hier.', 'They appear here once the content collection has synced.')}
                          </p>
                        </div>
                      )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">                    <SettingsCard
                      title={t(L, 'Eigenes Farbschema', 'Custom scheme')}
                      description={t(L, 'Eigene Akzentfarbe für die gesamte Oberfläche.', 'Your own accent color for the whole interface.')}
                    >
                    <SettingsRow
                      title={t(L, 'Akzentfarbe', 'Accent color')}
                      description={t(L, 'Wird sofort übernommen und gespeichert.', 'Applied and saved immediately.')}
                      control={
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={customAccent}
                            onChange={(event) => {
                              setCustomAccent(event.target.value)
                              setAccentDraft(event.target.value)
                            }}
                            aria-label={t(L, 'Akzentfarbe wählen', 'Choose accent color')}
                            className="h-9 w-10 cursor-pointer rounded-md border border-hairline bg-root p-0.5"
                          />
                          <TextField
                            value={accentDraft}
                            onChange={updateCustomAccent}
                            mono
                            className="w-28"
                            ariaLabel={t(L, 'Akzentfarbe als Hex-Wert', 'Accent color as hex value')}
                          />
                        </div>
                      }
                    />
                    <SettingsRow
                      title={t(L, 'Hintergrundbild', 'Background image')}
                      description={
                        customBg
                          ? t(L, 'Eigenes Bild ist aktiv.', 'Your own image is active.')
                          : t(L, 'PNG, JPG oder WebP.', 'PNG, JPG or WebP.')
                      }
                      control={
                        <div className="flex items-center gap-2">
                          {customBg && (
                            <img
                              src={customBg}
                              alt=""
                              className="h-9 w-16 rounded-md border border-hairline object-cover"
                            />
                          )}
                          <input
                            ref={backgroundInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleBackgroundFile}
                            aria-label={t(L, 'Hintergrundbild auswählen', 'Choose background image')}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Upload className="h-3 w-3" />}
                            onClick={() => backgroundInputRef.current?.click()}
                            disabled={uploadingBackground}
                          >
                            {uploadingBackground
                              ? t(L, 'Lädt …', 'Loading …')
                              : customBg
                                ? t(L, 'Ändern', 'Change')
                                : t(L, 'Bild wählen', 'Choose image')}
                          </Button>
                          {customBg && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<Trash2 className="h-3 w-3" />}
                              onClick={() => setCustomBg('')}
                            >
                              {t(L, 'Entfernen', 'Remove')}
                            </Button>
                          )}
                        </div>
                      }
                    />
                    </SettingsCard>

                    <SettingsCard
                      title={t(L, 'Hintergrund', 'Background')}
                  description={t(
                    L,
                    'Dein Hintergrundbild liegt hinter allen Ansichten.',
                    'Your background image sits behind every view.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Hintergrundbild anzeigen', 'Show background image')}
                    description={t(L, 'Blendet dein eigenes Hintergrundbild ein.', 'Shows your own background image.')}
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
                      setBgBrightness(PRESET_BRIGHTNESS)
                      setBgBlur(PRESET_BLUR)
                      addToast({ type: 'success', message: t(L, 'Darstellung zurückgesetzt.', 'Appearance reset.') })
                    }}
                  >
                    {t(L, 'Darstellung zurücksetzen', 'Reset appearance')}
                  </Button>
                </div>
                  </div>
                )}
                </section>
              </div>
            )}

            {tab === 'language' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Launcher-Sprache', 'Launcher language')}
                  description={t(L, 'Gilt sofort für alle Ansichten.', 'Applies to every view immediately.')}
                >
                  {[
                    { id: 'de' as const, title: 'Deutsch', tag: 'DE' },
                    { id: 'en' as const, title: 'English', tag: 'EN' },
                  ].map((option) => {
                    const active = lang === option.id
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setLang(option.id)}
                        className="flex w-full items-center gap-4 border-t border-hairline px-5 py-3.5 text-left transition-colors duration-[var(--t-quick)] hover:bg-hover first:border-t-0 cursor-pointer"
                      >
                        <span className="w-6 shrink-0 font-mono text-micro tabular-nums text-ink-tertiary">
                          {option.tag}
                        </span>
                        <span className="min-w-0 flex-1 text-small font-medium text-ink">{option.title}</span>
                        {active && <Check className="h-4 w-4 shrink-0 text-accent" />}
                      </button>
                    )
                  })}
                </SettingsCard>

                <SettingsCard
                  title={t(L, 'Minecraft-Sprache', 'Minecraft language')}
                  description={t(
                    L,
                    'Wird beim ersten Start einer Instanz in die options.txt geschrieben.',
                    'Written to options.txt on an instance’s first launch.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Spielsprache', 'In-game language')}
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

            {tab === 'java' && (
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Arbeitsspeicher', 'Memory')}
                  description={t(L, 'Gilt als Standard für neue Instanzen.', 'The default for new instances.')}
                >
                  <SettingsRow
                    title={t(L, 'Maximaler RAM (-Xmx)', 'Maximum RAM (-Xmx)')}
                    description={
                      preferences.instanceDefaults.ramMb > 12288
                        ? t(L, 'Über 12 GB kann GC-Lags verursachen.', 'Above 12 GB can cause GC stalls.')
                        : t(L, '4–8 GB empfohlen.', '4–8 GB recommended.')
                    }
                    badge={
                      preferences.instanceDefaults.ramMb < 2048 ? (
                        <span className="text-micro text-warning">{t(L, 'Sehr wenig', 'Very low')}</span>
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
                    description={t(L, 'Meist reicht 1 GB.', 'Usually 1 GB is enough.')}
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
                    description={t(L, 'Optional, z. B. -XX:+UseG1GC.', 'Optional, e.g. -XX:+UseG1GC.')}
                    control={
                      <div className="w-[420px] max-w-[46vw]">
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
                          ariaLabel={t(L, 'JVM-Argumente', 'JVM arguments')}
                        />
                      </div>
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
              <div className="flex flex-col gap-4">
                <SettingsCard
                  title={t(L, 'Sicherung', 'Backup')}
                  description={t(
                    L,
                    'Einstellungen als JSON-Datei sichern und wieder einlesen.',
                    'Save settings as a JSON file and read them back in.',
                  )}
                >
                  <SettingsRow
                    title={t(L, 'Einstellungen exportieren', 'Export settings')}
                    description={t(
                      L,
                      'Enthält Profilwerte, Tastenbelegung und Spieloptionen.',
                      'Includes profile values, keybinds and game options.',
                    )}
                    control={
                      <Button variant="secondary" size="sm" onClick={exportPreferences} icon={<Download className="h-3.5 w-3.5" />}>
                        {t(L, 'Exportieren', 'Export')}
                      </Button>
                    }
                  />
                  <SettingsRow
                    title={t(L, 'Einstellungen importieren', 'Import settings')}
                    description={t(L, 'Liest eine zuvor exportierte Datei ein.', 'Reads a previously exported file.')}
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
                        <Button variant="secondary" size="sm" onClick={() => importRef.current?.click()} icon={<Upload className="h-3.5 w-3.5" />}>
                          {t(L, 'Importieren', 'Import')}
                        </Button>
                      </>
                    }
                  />
                </SettingsCard>

                <div className="flex items-start gap-3 px-1">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary" />
                  <p className="m-0 text-mini leading-5 text-ink-secondary">
                    {t(
                      L,
                      'Microsoft-Tokens bleiben im OS-Tresor. Exporte enthalten keine Konten oder Tokens.',
                      'Microsoft tokens stay in the OS secret store. Exports contain no accounts or tokens.',
                    )}
                  </p>
                </div>

                <SettingsCard
                  title={t(L, 'Zurücksetzen', 'Reset')}
                  description={t(
                    L,
                    'RAM, Java, Tastenbelegung, Spieloptionen und Verhalten zurücksetzen.',
                    'Reset RAM, Java, keybinds, game options and behavior.',
                  )}
                  className="border-danger/25"
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
                        icon={<RotateCcw className="h-3.5 w-3.5" />}
                      >
                        {t(L, 'Zurücksetzen', 'Reset')}
                      </ConfirmButton>
                    }
                  />
                </SettingsCard>
              </div>
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
                      { label: t(L, 'Plattform', 'Platform'), value: navigator.userAgent.includes('Windows') ? 'Windows' : 'Desktop' },
                      { label: 'Electron', value: '30' },
                      { label: t(L, 'Oberfläche', 'Interface'), value: 'React 19' },
                    ].map((entry, index) => (
                      <div
                        key={entry.label}
                        className={cx('px-5 py-3', index > 0 && 'border-t border-hairline sm:border-l sm:border-t-0')}
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
                      updateReady ? (
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
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

