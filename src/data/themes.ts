export interface ThemeDefinition {
  id: string
  name: string
  desc: string
  accentLabel: string
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
 */
export const LOCAL_THEMES: ThemeDefinition[] = [
  {
    id: 'bamboo',
    name: 'Bamboo Forest',
    desc: 'Green accent with a bamboo forest background.',
    accentLabel: 'Green',
    accent: '#7cd98b',
    bgImage: './images/bamboo_forest.png',
  },
  {
    id: 'cherry',
    name: 'Cherry Blossom',
    desc: 'Pink accent with a cherry blossom background.',
    accentLabel: 'Pink',
    accent: '#f2a7c3',
    bgImage: './images/cherry_blossom.png',
  },
  {
    id: 'frozen',
    name: 'Frozen Ice',
    desc: 'Ice-blue accent with a glacier background.',
    accentLabel: 'Ice blue',
    accent: '#8fd3f4',
    bgImage: './images/frozen_ice.png',
  },
  {
    id: 'nether',
    name: 'Nether Amber',
    desc: 'Amber accent with a warm Nether background.',
    accentLabel: 'Amber',
    accent: '#ff8a5c',
    bgImage: './images/nether_amber.png',
  },
  {
    id: 'end',
    name: 'The End',
    desc: 'Purple accent with a dark, minimal palette.',
    accentLabel: 'Purple',
    accent: '#b39ddb',
  },
  {
    id: 'warden',
    name: 'Warden',
    desc: 'Teal accent based on deep dark sculk colors.',
    accentLabel: 'Teal',
    accent: '#4fd1c5',
  },
  {
    id: 'copper',
    name: 'Copper',
    desc: 'Copper accent with warm metallic tones.',
    accentLabel: 'Copper',
    accent: '#d98e5f',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    desc: 'Violet accent with obsidian and amethyst tones.',
    accentLabel: 'Violet',
    accent: '#9184f0',
  },
]
