import type { Bilingual } from './keybinds'

export type GameOptionKind = 'slider' | 'toggle' | 'select'
export type GameOptionValue = string | number | boolean

export interface GameOptionChoice {
  value: string | number
  label: Bilingual
}

export type GameOptionCategory = 'video' | 'audio' | 'controls' | 'chat' | 'accessibility'

export interface GameOptionDef {
  key: string
  category: GameOptionCategory
  kind: GameOptionKind
  label: Bilingual
  description?: Bilingual
  min?: number
  max?: number
  step?: number
  unit?: string
  choices?: GameOptionChoice[]
  defaultValue: GameOptionValue
}

const choice = (value: string | number, de: string, en: string): GameOptionChoice => ({
  value,
  label: { de, en },
})

export const GAME_OPTION_CATEGORIES: { id: GameOptionCategory; label: Bilingual; icon: string }[] = [
  { id: 'video', label: { de: 'Video', en: 'Video' }, icon: 'monitor' },
  { id: 'audio', label: { de: 'Audio', en: 'Audio' }, icon: 'volume' },
  { id: 'controls', label: { de: 'Steuerung', en: 'Controls' }, icon: 'gamepad' },
  { id: 'chat', label: { de: 'Chat', en: 'Chat' }, icon: 'message' },
  { id: 'accessibility', label: { de: 'Barrierefreiheit', en: 'Accessibility' }, icon: 'eye' },
]

export const GAME_OPTIONS: GameOptionDef[] = [
  {
    key: 'renderDistance',
    category: 'video',
    kind: 'slider',
    min: 2,
    max: 32,
    step: 1,
    unit: 'Chunks',
    defaultValue: 12,
    label: { de: 'Sichtweite', en: 'Render distance' },
  },
  {
    key: 'simulationDistance',
    category: 'video',
    kind: 'slider',
    min: 5,
    max: 32,
    step: 1,
    unit: 'Chunks',
    defaultValue: 12,
    label: { de: 'Simulationsweite', en: 'Simulation distance' },
  },
  {
    key: 'fov',
    category: 'video',
    kind: 'slider',
    min: 30,
    max: 110,
    step: 1,
    unit: '°',
    defaultValue: 70,
    label: { de: 'Sichtfeld (FOV)', en: 'Field of view' },
  },
  {
    key: 'guiScale',
    category: 'video',
    kind: 'select',
    defaultValue: 0,
    label: { de: 'GUI-Skalierung', en: 'GUI scale' },
    choices: [
      choice(0, 'Automatisch', 'Auto'),
      choice(1, 'Klein', 'Small'),
      choice(2, 'Normal', 'Normal'),
      choice(3, 'Groß', 'Large'),
      choice(4, 'Sehr groß', 'Huge'),
    ],
  },
  {
    key: 'maxFramerate',
    category: 'video',
    kind: 'slider',
    min: 30,
    max: 260,
    step: 10,
    unit: 'FPS',
    defaultValue: 120,
    label: { de: 'Maximale Bildrate', en: 'Max framerate' },
  },
  {
    key: 'vsync',
    category: 'video',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'VSync', en: 'VSync' },
  },
  {
    key: 'graphicsMode',
    category: 'video',
    kind: 'select',
    defaultValue: 'fancy',
    label: { de: 'Grafikqualität', en: 'Graphics quality' },
    choices: [
      choice('fast', 'Schnell', 'Fast'),
      choice('fancy', 'Schön', 'Fancy'),
      choice('fabulous', 'Fabelhaft', 'Fabulous'),
    ],
  },
  {
    key: 'particles',
    category: 'video',
    kind: 'select',
    defaultValue: 0,
    label: { de: 'Partikel', en: 'Particles' },
    choices: [
      choice(0, 'Alle', 'All'),
      choice(1, 'Reduziert', 'Decreased'),
      choice(2, 'Minimal', 'Minimal'),
    ],
  },
  {
    key: 'mipmapLevels',
    category: 'video',
    kind: 'slider',
    min: 0,
    max: 4,
    step: 1,
    defaultValue: 4,
    label: { de: 'Mipmap-Stufen', en: 'Mipmap levels' },
  },
  {
    key: 'gamma',
    category: 'video',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 50,
    label: { de: 'Helligkeit', en: 'Brightness' },
  },
  {
    key: 'entityDistanceScaling',
    category: 'video',
    kind: 'slider',
    min: 50,
    max: 500,
    step: 10,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Entity-Sichtweite', en: 'Entity distance' },
  },
  {
    key: 'biomeBlendRadius',
    category: 'video',
    kind: 'slider',
    min: 0,
    max: 7,
    step: 1,
    unit: 'Blöcke',
    defaultValue: 2,
    label: { de: 'Biom-Übergang', en: 'Biome blend' },
  },
  {
    key: 'entityShadows',
    category: 'video',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Entity-Schatten', en: 'Entity shadows' },
  },
  {
    key: 'fovEffectScale',
    category: 'video',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'FOV-Effekte', en: 'FOV effects' },
  },
  {
    key: 'screenEffectScale',
    category: 'video',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Bildschirm-Effekte', en: 'Screen effects' },
  },
  {
    key: 'vignette',
    category: 'video',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Vignette', en: 'Vignette' },
  },
  {
    key: 'renderClouds',
    category: 'video',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Wolken', en: 'Clouds' },
  },

  {
    key: 'soundCategory_master',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Gesamtlautstärke', en: 'Master volume' },
  },
  {
    key: 'soundCategory_music',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Musik', en: 'Music' },
  },
  {
    key: 'soundCategory_record',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Plattenspieler / Notenblöcke', en: 'Jukebox / Note blocks' },
  },
  {
    key: 'soundCategory_weather',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Wetter', en: 'Weather' },
  },
  {
    key: 'soundCategory_block',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Blöcke', en: 'Blocks' },
  },
  {
    key: 'soundCategory_hostile',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Feindliche Kreaturen', en: 'Hostile creatures' },
  },
  {
    key: 'soundCategory_neutral',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Freundliche Kreaturen', en: 'Friendly creatures' },
  },
  {
    key: 'soundCategory_player',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Spieler', en: 'Players' },
  },
  {
    key: 'soundCategory_ambient',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Umgebung', en: 'Ambient' },
  },
  {
    key: 'soundCategory_voice',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Stimme / Sprache', en: 'Voice / Speech' },
  },
  {
    key: 'soundCategory_ui',
    category: 'audio',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'UI-Geräusche', en: 'UI sounds' },
  },
  {
    key: 'directionalAudio',
    category: 'audio',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Richtungsaudio', en: 'Directional audio' },
    description: { de: 'Für Kopfhörer.', en: 'For headphones.' },
  },
  {
    key: 'showSubtitles',
    category: 'audio',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Untertitel für Geräusche', en: 'Sound subtitles' },
  },

  {
    key: 'mouseSensitivity',
    category: 'controls',
    kind: 'slider',
    // Minecrafts Regler reicht bis 200 %; 100 % ist der Standardwert (0,5).
    min: 0,
    max: 200,
    step: 1,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Mausempfindlichkeit', en: 'Mouse sensitivity' },
  },
  {
    key: 'invertYMouse',
    category: 'controls',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Maus-Y umkehren', en: 'Invert mouse Y' },
  },
  {
    key: 'autoJump',
    category: 'controls',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Automatisches Springen', en: 'Auto-jump' },
  },
  {
    key: 'rawMouseInput',
    category: 'controls',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Rohe Mauseingabe', en: 'Raw mouse input' },
    description: { de: 'Ohne Mausbeschleunigung.', en: 'No pointer acceleration.' },
  },
  {
    key: 'bobView',
    category: 'controls',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Kamerawackeln', en: 'View bobbing' },
  },
  {
    key: 'toggleCrouch',
    category: 'controls',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Schleichen umschalten', en: 'Toggle sneak' },
  },
  {
    key: 'toggleSprint',
    category: 'controls',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Sprinten umschalten', en: 'Toggle sprint' },
  },
  {
    key: 'mainHand',
    category: 'controls',
    kind: 'select',
    defaultValue: 'right',
    label: { de: 'Haupthand', en: 'Main hand' },
    choices: [choice('right', 'Rechts', 'Right'), choice('left', 'Links', 'Left')],
  },
  {
    key: 'attackIndicator',
    category: 'controls',
    kind: 'select',
    defaultValue: 1,
    label: { de: 'Angriffsanzeige', en: 'Attack indicator' },
    choices: [
      choice(0, 'Aus', 'Off'),
      choice(1, 'Fadenkreuz', 'Crosshair'),
      choice(2, 'Hotbar', 'Hotbar'),
    ],
  },

  {
    key: 'chatVisibility',
    category: 'chat',
    kind: 'select',
    defaultValue: 0,
    label: { de: 'Chat-Sichtbarkeit', en: 'Chat visibility' },
    choices: [
      choice(0, 'Vollständig', 'Full'),
      choice(1, 'Nur Befehle', 'Commands only'),
      choice(2, 'Versteckt', 'Hidden'),
    ],
  },
  {
    key: 'chatOpacity',
    category: 'chat',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Chat-Deckkraft', en: 'Chat opacity' },
  },
  {
    key: 'chatScale',
    category: 'chat',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Chat-Größe', en: 'Chat size' },
  },
  {
    key: 'chatWidth',
    category: 'chat',
    kind: 'slider',
    min: 20,
    max: 200,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Chat-Breite', en: 'Chat width' },
  },
  {
    key: 'chatLineSpacing',
    category: 'chat',
    kind: 'slider',
    min: 0,
    max: 20,
    step: 1,
    defaultValue: 0,
    label: { de: 'Zeilenabstand', en: 'Line spacing' },
  },
  {
    key: 'textBackgroundOpacity',
    category: 'chat',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 50,
    label: { de: 'Hintergrund-Deckkraft', en: 'Background opacity' },
  },
  {
    key: 'chatColors',
    category: 'chat',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Chat-Farben', en: 'Chat colors' },
  },
  {
    key: 'chatLinks',
    category: 'chat',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Links im Chat', en: 'Chat links' },
  },
  {
    key: 'autoSuggestions',
    category: 'chat',
    kind: 'toggle',
    defaultValue: true,
    label: { de: 'Befehlsvorschläge', en: 'Command suggestions' },
  },

  {
    key: 'narrator',
    category: 'accessibility',
    kind: 'select',
    defaultValue: 0,
    label: { de: 'Erzähler', en: 'Narrator' },
    choices: [
      choice(0, 'Aus', 'Off'),
      choice(1, 'Alle', 'All'),
      choice(2, 'Chat', 'Chat'),
      choice(3, 'System', 'System'),
    ],
  },
  {
    key: 'highContrast',
    category: 'accessibility',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Hoher Kontrast', en: 'High contrast' },
  },
  {
    key: 'highContrastBlockOutline',
    category: 'accessibility',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Kontrastreiche Blockumrisse', en: 'High contrast block outline' },
  },
  {
    key: 'damageTiltStrength',
    category: 'accessibility',
    kind: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Kamera-Kippen bei Schaden', en: 'Damage tilt' },
  },
  {
    key: 'menuBackgroundBlurriness',
    category: 'accessibility',
    kind: 'slider',
    min: 0,
    max: 10,
    step: 1,
    defaultValue: 0,
    label: { de: 'Menü-Hintergrundunschärfe', en: 'Menu background blur' },
  },
  {
    key: 'forceUnicodeFont',
    category: 'accessibility',
    kind: 'toggle',
    defaultValue: false,
    label: { de: 'Unicode-Schrift erzwingen', en: 'Force Unicode font' },
  },
  {
    key: 'notificationDisplayTime',
    category: 'accessibility',
    kind: 'slider',
    min: 10,
    max: 200,
    step: 10,
    unit: '%',
    defaultValue: 100,
    label: { de: 'Anzeigedauer von Hinweisen', en: 'Notification duration' },
  },
]

export const GAME_OPTION_BY_KEY: Record<string, GameOptionDef> = Object.fromEntries(
  GAME_OPTIONS.map((option) => [option.key, option]),
)

export const DEFAULT_GAME_OPTIONS: Record<string, GameOptionValue> = Object.fromEntries(
  GAME_OPTIONS.map((option) => [option.key, option.defaultValue]),
)

export function normalizeGameOptions(value: unknown): Record<string, GameOptionValue> {
  const result: Record<string, GameOptionValue> = { ...DEFAULT_GAME_OPTIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in GAME_OPTION_BY_KEY)) continue
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = raw
    }
  }
  return result
}

export function gameOptionsForCategory(category: GameOptionCategory): GameOptionDef[] {
  return GAME_OPTIONS.filter((option) => option.category === category)
}

export function resetGameOptionsForCategory(
  values: Record<string, GameOptionValue>,
  category: GameOptionCategory,
): Record<string, GameOptionValue> {
  const next = { ...values }
  for (const option of gameOptionsForCategory(category)) next[option.key] = option.defaultValue
  return next
}

export interface MinecraftLanguage {
  code: string
  name: string
}

export const MINECRAFT_LANGUAGES: MinecraftLanguage[] = [
  { code: 'de_de', name: 'Deutsch' },
  { code: 'en_us', name: 'English (US)' },
  { code: 'en_gb', name: 'English (UK)' },
  { code: 'fr_fr', name: 'Français' },
  { code: 'es_es', name: 'Español (España)' },
  { code: 'es_mx', name: 'Español (México)' },
  { code: 'it_it', name: 'Italiano' },
  { code: 'nl_nl', name: 'Nederlands' },
  { code: 'pl_pl', name: 'Polski' },
  { code: 'pt_br', name: 'Português (Brasil)' },
  { code: 'pt_pt', name: 'Português (Portugal)' },
  { code: 'ru_ru', name: 'Русский' },
  { code: 'tr_tr', name: 'Türkçe' },
  { code: 'uk_ua', name: 'Українська' },
  { code: 'zh_cn', name: '简体中文' },
  { code: 'zh_tw', name: '繁體中文' },
  { code: 'ja_jp', name: '日本語' },
  { code: 'ko_kr', name: '한국어' },
  { code: 'sv_se', name: 'Svenska' },
  { code: 'da_dk', name: 'Dansk' },
  { code: 'fi_fi', name: 'Suomi' },
  { code: 'nb_no', name: 'Norsk bokmål' },
  { code: 'cs_cz', name: 'Čeština' },
  { code: 'hu_hu', name: 'Magyar' },
  { code: 'ro_ro', name: 'Română' },
  { code: 'el_gr', name: 'Ελληνικά' },
  { code: 'bg_bg', name: 'Български' },
  { code: 'ar_sa', name: 'العربية' },
  { code: 'he_il', name: 'עברית' },
  { code: 'hi_in', name: 'हिन्दी' },
  { code: 'id_id', name: 'Bahasa Indonesia' },
  { code: 'vi_vn', name: 'Tiếng Việt' },
  { code: 'th_th', name: 'ไทย' },
]

export function parseJvmArgs(value: string): string[] {
  const result: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token) result.push(token)
  }
  return result
}
