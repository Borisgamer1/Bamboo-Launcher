import type React from 'react'
import {
  BarChart3,
  Coffee,
  Gamepad2,
  Info,
  Keyboard,
  Languages,
  Palette,
  SlidersHorizontal,
  UserRound,
  Wrench,
} from 'lucide-react'

export type TabId = 'general' | 'appearance' | 'java' | 'gameOptions' | 'keybinds' | 'language' | 'advanced' | 'statistics' | 'about' | 'accounts'

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

export interface TabItem {
  id: TabId
  label: { de: string; en: string }
  description: { de: string; en: string }
  icon: React.ElementType
  keywords: string
}

export const TABS: TabItem[] = [
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
export const SETTINGS_GROUPS: SettingsGroup[] = [
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

export const TAB_COPY: Record<TabId, { title: { de: string; en: string }; desc: { de: string; en: string } }> = {
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

export function resolveLegacySection(requested: string | null): TabId {
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
