import { DEFAULT_GAME_OPTIONS, normalizeGameOptions, parseJvmArgs, type GameOptionValue } from './gameOptions'
import { localeFor } from './translations'
import {
  DEFAULT_KEYBINDS,
  normalizeKeybinds,
  normalizeKeyboardLayout,
  type KeyboardLayoutId,
} from './keybinds'

export const SETTINGS_VERSION = 1 as const

export interface InstanceWindowDefaults {
  mode: 'default' | 'custom'
  width: number
  height: number
  fullscreen: boolean
}

export interface LauncherPreferences {
  version: typeof SETTINGS_VERSION
  instanceDefaults: {
    ramMb: number
    minRamMb: number
    javaPath: string
    jvmArgs: string
    minecraftLanguage: string
    window: InstanceWindowDefaults
  }
  keybinds: Record<string, string>
  keybindLayout: KeyboardLayoutId
  gameOptions: Record<string, GameOptionValue>
  behavior: {
    minimizeOnLaunch: boolean
    focusOnGameClose: boolean
    showPlaytime: boolean
    confirmDelete: boolean
  }
}

export const RAM_MIN_MB = 1024
export const RAM_MAX_MB = 16384
export const RAM_STEP_MB = 256

export const DEFAULT_PREFERENCES: LauncherPreferences = {
  version: SETTINGS_VERSION,
  instanceDefaults: {
    ramMb: 4096,
    minRamMb: 1024,
    javaPath: '',
    jvmArgs: '',
    minecraftLanguage: 'de_de',
    window: {
      mode: 'default',
      width: 1280,
      height: 720,
      fullscreen: false,
    },
  },
  keybinds: { ...DEFAULT_KEYBINDS },
  keybindLayout: 'full',
  gameOptions: { ...DEFAULT_GAME_OPTIONS },
  behavior: {
    minimizeOnLaunch: false,
    focusOnGameClose: true,
    showPlaytime: true,
    confirmDelete: true,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizePreferences(value: unknown): LauncherPreferences {
  const source = isRecord(value) ? value : {}
  const instanceDefaults = isRecord(source.instanceDefaults) ? source.instanceDefaults : {}
  const windowDefaults = isRecord(instanceDefaults.window) ? instanceDefaults.window : {}
  const behavior = isRecord(source.behavior) ? source.behavior : {}

  const maxRam = numberInRange(instanceDefaults.ramMb, DEFAULT_PREFERENCES.instanceDefaults.ramMb, RAM_MIN_MB, RAM_MAX_MB)
  const minRam = Math.min(
    numberInRange(instanceDefaults.minRamMb, DEFAULT_PREFERENCES.instanceDefaults.minRamMb, 512, RAM_MAX_MB),
    maxRam,
  )
  const windowMode = windowDefaults.mode === 'custom' ? 'custom' : 'default'

  return {
    version: SETTINGS_VERSION,
    instanceDefaults: {
      ramMb: maxRam,
      minRamMb: minRam,
      javaPath: stringOr(instanceDefaults.javaPath, ''),
      jvmArgs: stringOr(instanceDefaults.jvmArgs, ''),
      minecraftLanguage: stringOr(instanceDefaults.minecraftLanguage, 'de_de'),
      window: {
        mode: windowMode,
        width: numberInRange(windowDefaults.width, 1280, 320, 7680),
        height: numberInRange(windowDefaults.height, 720, 240, 4320),
        fullscreen: bool(windowDefaults.fullscreen, false),
      },
    },
    keybinds: normalizeKeybinds(source.keybinds),
    keybindLayout: normalizeKeyboardLayout(source.keybindLayout),
    gameOptions: normalizeGameOptions(source.gameOptions),
    behavior: {
      minimizeOnLaunch: bool(behavior.minimizeOnLaunch, DEFAULT_PREFERENCES.behavior.minimizeOnLaunch),
      focusOnGameClose: bool(behavior.focusOnGameClose, DEFAULT_PREFERENCES.behavior.focusOnGameClose),
      showPlaytime: bool(behavior.showPlaytime, DEFAULT_PREFERENCES.behavior.showPlaytime),
      confirmDelete: bool(behavior.confirmDelete, DEFAULT_PREFERENCES.behavior.confirmDelete),
    },
  }
}

export function savedJvmArgs(preferences: LauncherPreferences): string[] {
  return parseJvmArgs(preferences.instanceDefaults.jvmArgs)
}

export function formatPlaytime(ms: number | undefined, lang: 'de' | 'en'): string {
  const locale = localeFor(lang)
  const totalMs = Math.max(0, ms || 0)
  const totalMinutes = Math.floor(totalMs / 60000)
  if (totalMinutes < 1) {
    if (totalMs <= 0) return lang === 'de' ? 'Noch keine Spielzeit' : 'No playtime yet'
    return lang === 'de' ? 'Unter 1 Min.' : 'Under 1 min'
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const hourUnit = lang === 'de' ? 'Std.' : 'h'
  const minuteUnit = lang === 'de' ? 'Min.' : 'm'
  if (hours <= 0) return `${minutes.toLocaleString(locale)} ${minuteUnit}`
  if (minutes === 0) return `${hours.toLocaleString(locale)} ${hourUnit}`
  return `${hours.toLocaleString(locale)} ${hourUnit} ${minutes.toLocaleString(locale)} ${minuteUnit}`
}

export function formatDate(timestamp: number | undefined, lang: 'de' | 'en'): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  try {
    return new Intl.DateTimeFormat(localeFor(lang), {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toLocaleDateString()
  }
}
