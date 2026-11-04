export interface ThemeDefinition {
  id: string
  name: string
  desc: { de: string; en: string }
  accentLabel: { de: string; en: string }
  accent: string
  bgImage?: string
  particleShapes?: number[][][]
  particleImage?: string
  particleSize?: number
  particleFrequency?: number
  particleDirection?: string
}

/**
 * Themes ship with the launcher. Backgrounds live in `public/images` and are
 * referenced relative to the document base so they resolve both in the Vite
 * dev server and from `dist/index.html` in a packaged build.
 *
 * Every preset uses the same brightness/blur so switching themes never throws
 * the artwork in your face: bright enough to see the landscape, soft enough to
 * keep text readable.
 */
export const PRESET_BRIGHTNESS = 45
export const PRESET_BLUR = 4

export const LOCAL_THEMES: ThemeDefinition[] = [
  {
    id: 'bamboo',
    name: 'Bamboo Forest',
    desc: {
      de: 'Ruhiges Grün zwischen Bambus und Sonnenlicht.',
      en: 'Calm green between bamboo and sunlight.',
    },
    accentLabel: { de: 'Grün', en: 'Green' },
    accent: '#5fbf6a',
    bgImage: './images/theme_bamboo_green.png',
  },
  {
    id: 'end',
    name: 'End City',
    desc: {
      de: 'Violette Türme über der ewigen Leere.',
      en: 'Violet towers above the endless void.',
    },
    accentLabel: { de: 'Violett', en: 'Purple' },
    accent: '#b06ad4',
    bgImage: './images/theme_end_purple.png',
  },
  {
    id: 'frozen',
    name: 'Snowy Lands',
    desc: {
      de: 'Klares Eisblau mit frischer, kalter Luft.',
      en: 'Crisp ice blue with fresh, cold air.',
    },
    accentLabel: { de: 'Hellblau', en: 'Light blue' },
    accent: '#9fc6e0',
    bgImage: './images/theme_icy_blue.png',
  },
  {
    id: 'nether',
    name: 'Nether Fortress',
    desc: {
      de: 'Glühendes Rot zwischen Basalt und Lava.',
      en: 'Glowing red between basalt and lava.',
    },
    accentLabel: { de: 'Rot', en: 'Red' },
    accent: '#e05252',
    bgImage: './images/theme_nether_red.png',
  },
  {
    id: 'obsidian',
    name: 'Obsidian Portal',
    desc: {
      de: 'Tiefes Nachtblau mit einem Hauch von Amethyst.',
      en: 'Deep midnight blue with a hint of amethyst.',
    },
    accentLabel: { de: 'Dunkelblau', en: 'Dark blue' },
    accent: '#7d74d9',
    bgImage: './images/theme_obsidian.png',
  },
  {
    id: 'warden',
    name: 'Warden Valley',
    desc: {
      de: 'Sculk-Cyan aus den Tiefen des Deep Dark.',
      en: 'Sculk cyan from the depths of the Deep Dark.',
    },
    accentLabel: { de: 'Cyan', en: 'Cyan' },
    accent: '#4fb3ab',
    bgImage: './images/theme_warden_cyan.png',
  },
  {
    id: 'copper',
    name: 'Copper Trials',
    desc: {
      de: 'Warmes Kupferorange aus den Trial Chambers.',
      en: 'Warm copper orange from the Trial Chambers.',
    },
    accentLabel: { de: 'Orange', en: 'Orange' },
    accent: '#d97742',
    bgImage: './images/theme_copper_trials.webp',
  },
  {
    id: 'underwater',
    name: 'Underwater Paradise',
    desc: {
      de: 'Satte Ozeanblau-Töne mit ruhigem Licht.',
      en: 'Rich ocean blues with calm light.',
    },
    accentLabel: { de: 'Blau', en: 'Blue' },
    accent: '#3f8fd0',
    bgImage: './images/theme_underwater.webp',
  },
  {
    id: 'cherry',
    name: 'Cherry Blossom',
    desc: {
      de: 'Sanftes Pink unter blühenden Kirschbäumen.',
      en: 'Soft pink beneath blooming cherry trees.',
    },
    accentLabel: { de: 'Pink', en: 'Pink' },
    accent: '#f2a3b7',
    bgImage: './images/theme_cherry.webp',
  },
]

export const DEFAULT_THEME_ID = 'bamboo'
