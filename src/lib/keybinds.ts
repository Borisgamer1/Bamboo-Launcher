
export type Bilingual = { de: string; en: string }

export interface KeybindAction {
  id: string
  label: Bilingual
  defaultToken: string
}

export interface KeybindGroup {
  id: string
  label: Bilingual
  actions: KeybindAction[]
}

const action = (id: string, de: string, en: string, defaultToken: string): KeybindAction => ({
  id,
  label: { de, en },
  defaultToken,
})

export const KEYBIND_GROUPS: KeybindGroup[] = [
  {
    id: 'movement',
    label: { de: 'Bewegung', en: 'Movement' },
    actions: [
      action('key.forward', 'Vorwärts', 'Walk forward', 'key.keyboard.w'),
      action('key.left', 'Links', 'Strafe left', 'key.keyboard.a'),
      action('key.back', 'Rückwärts', 'Walk backward', 'key.keyboard.s'),
      action('key.right', 'Rechts', 'Strafe right', 'key.keyboard.d'),
      action('key.jump', 'Springen', 'Jump', 'key.keyboard.space'),
      action('key.sneak', 'Schleichen', 'Sneak', 'key.keyboard.left.shift'),
      action('key.sprint', 'Sprinten', 'Sprint', 'key.keyboard.left.control'),
    ],
  },
  {
    id: 'gameplay',
    label: { de: 'Spiel', en: 'Gameplay' },
    actions: [
      action('key.attack', 'Angreifen / Abbauen', 'Attack / Destroy', 'key.mouse.left'),
      action('key.use', 'Benutzen / Platzieren', 'Use / Place', 'key.mouse.right'),
      action('key.pickItem', 'Block auswählen', 'Pick block', 'key.mouse.middle'),
      action('key.drop', 'Item fallen lassen', 'Drop item', 'key.keyboard.q'),
      action('key.inventory', 'Inventar', 'Inventory', 'key.keyboard.e'),
      action('key.swapOffhand', 'Zweithand tauschen', 'Swap offhand', 'key.keyboard.f'),
      action('key.saveToolbarActivator', 'Hotbar speichern', 'Save hotbar', 'key.keyboard.c'),
      action('key.loadToolbarActivator', 'Hotbar laden', 'Load hotbar', 'key.keyboard.x'),
    ],
  },
  {
    id: 'inventory',
    label: { de: 'Inventar', en: 'Inventory' },
    actions: Array.from({ length: 9 }, (_, index) =>
      action(
        `key.hotbar.${index + 1}`,
        `Hotbar ${index + 1}`,
        `Hotbar ${index + 1}`,
        `key.keyboard.${index + 1}`,
      ),
    ),
  },
  {
    id: 'multiplayer',
    label: { de: 'Mehrspieler', en: 'Multiplayer' },
    actions: [
      action('key.chat', 'Chat öffnen', 'Open chat', 'key.keyboard.t'),
      action('key.command', 'Befehl eingeben', 'Open command', 'key.keyboard.slash'),
      action('key.playerlist', 'Spielerliste', 'Player list', 'key.keyboard.tab'),
      action('key.socialInteractions', 'Soziale Interaktionen', 'Social interactions', 'key.keyboard.p'),
      action('key.advancements', 'Fortschritte', 'Advancements', 'key.keyboard.l'),
    ],
  },
  {
    id: 'interface',
    label: { de: 'Oberfläche', en: 'Interface' },
    actions: [
      action('key.togglePerspective', 'Perspektive wechseln', 'Toggle perspective', 'key.keyboard.f5'),
      action('key.fullscreen', 'Vollbild', 'Fullscreen', 'key.keyboard.f11'),
      action('key.screenshot', 'Screenshot', 'Screenshot', 'key.keyboard.f2'),
    ],
  },
]

export const ALL_KEYBIND_ACTIONS = KEYBIND_GROUPS.flatMap((group) => group.actions)

export const DEFAULT_KEYBINDS: Record<string, string> = Object.fromEntries(
  ALL_KEYBIND_ACTIONS.map((entry) => [entry.id, entry.defaultToken]),
)

export function actionById(id: string): KeybindAction | undefined {
  return ALL_KEYBIND_ACTIONS.find((entry) => entry.id === id)
}

const MODIFIER_LABELS: Record<string, Bilingual> = {
  control: { de: 'Strg', en: 'Ctrl' },
  ctrl: { de: 'Strg', en: 'Ctrl' },
  shift: { de: 'Shift', en: 'Shift' },
  alt: { de: 'Alt', en: 'Alt' },
  meta: { de: 'Meta', en: 'Meta' },
  super: { de: 'Super', en: 'Super' },
}

const TOKEN_LABELS: Record<string, Bilingual> = {
  escape: { de: 'Esc', en: 'Esc' },
  minus: { de: '-', en: '-' },
  equal: { de: '=', en: '=' },
  backspace: { de: 'Backspace', en: 'Backspace' },
  tab: { de: 'Tab', en: 'Tab' },
  enter: { de: 'Enter', en: 'Enter' },
  'left.control': { de: 'Linke Strg', en: 'Left Ctrl' },
  'right.control': { de: 'Rechte Strg', en: 'Right Ctrl' },
  semicolon: { de: ';', en: ';' },
  apostrophe: { de: "'", en: "'" },
  'grave.accent': { de: '`', en: '`' },
  'left.shift': { de: 'Linke Shift', en: 'Left Shift' },
  'right.shift': { de: 'Rechte Shift', en: 'Right Shift' },
  backslash: { de: '\\', en: '\\' },
  comma: { de: ',', en: ',' },
  period: { de: '.', en: '.' },
  slash: { de: '/', en: '/' },
  'left.alt': { de: 'Linke Alt', en: 'Left Alt' },
  'right.alt': { de: 'Rechte Alt', en: 'Right Alt' },
  space: { de: 'Leertaste', en: 'Space' },
  'caps.lock': { de: 'Caps Lock', en: 'Caps Lock' },
  'num.lock': { de: 'Num Lock', en: 'Num Lock' },
  'scroll.lock': { de: 'Scroll Lock', en: 'Scroll Lock' },
  'print.screen': { de: 'Druck', en: 'Print Screen' },
  pause: { de: 'Pause', en: 'Pause' },
  home: { de: 'Pos 1', en: 'Home' },
  end: { de: 'Ende', en: 'End' },
  'page.up': { de: 'Bild ↑', en: 'Page Up' },
  'page.down': { de: 'Bild ↓', en: 'Page Down' },
  insert: { de: 'Einfg', en: 'Insert' },
  delete: { de: 'Entf', en: 'Delete' },
  up: { de: '↑', en: '↑' },
  down: { de: '↓', en: '↓' },
  left: { de: '←', en: '←' },
  right: { de: '→', en: '→' },
  'left.win': { de: 'Linke Win', en: 'Left Win' },
  'right.win': { de: 'Rechte Win', en: 'Right Win' },
  menu: { de: 'Menü', en: 'Menu' },
  'left.bracket': { de: '[', en: '[' },
  'right.bracket': { de: ']', en: ']' },
}

/** Physical-key labels from the OS layout (QWERTZ shows Z on the Y key). */
export const DETECTED_KEY_LABELS = new Map<string, string>()

export async function detectKeyboardLabels(): Promise<boolean> {
  const keyboard = (navigator as Navigator & {
    keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> }
  }).keyboard
  if (!keyboard?.getLayoutMap) return false
  try {
    const map = await keyboard.getLayoutMap()
    map.forEach((label, code) => {
      const match = /^Key([A-Z])$/.exec(code)
      if (match && typeof label === 'string' && label.length > 0 && label.length <= 2) {
        DETECTED_KEY_LABELS.set(match[1].toLowerCase(), label.toUpperCase())
      }
    })
    return DETECTED_KEY_LABELS.size > 0
  } catch {
    return false
  }
}

export function detectedKeyLabel(key: KeyboardKey): string {
  const identifier = key.token?.replace(/^key\.keyboard\./, '') ?? ''
  return (identifier.length === 1 && DETECTED_KEY_LABELS.get(identifier)) || key.label
}

export function formatKeyToken(token: string | undefined, lang: 'de' | 'en' = 'de'): string {
  if (!token || token === 'key.keyboard.unknown' || token === 'unknown') {
    return lang === 'de' ? 'Nicht belegt' : 'Unbound'
  }

  const [rawKey, rawModifier] = token.split(':')
  const modifiers = rawModifier
    ? rawModifier
        .split(/[+:]/)
        .filter(Boolean)
        .map((part) => MODIFIER_LABELS[part.toLowerCase()]?.[lang] ?? part)
    : []

  let label: string
  if (rawKey.startsWith('key.keyboard.')) {
    const identifier = rawKey.slice('key.keyboard.'.length)
    const direct = TOKEN_LABELS[identifier]
    if (direct) {
      label = direct[lang]
    } else if (/^[a-z]$/.test(identifier)) {
      label = DETECTED_KEY_LABELS.get(identifier) || identifier.toUpperCase()
    } else if (/^[0-9]$/.test(identifier)) {
      label = identifier
    } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(identifier)) {
      label = identifier.toUpperCase()
    } else if (identifier.startsWith('keypad.')) {
      label = `${lang === 'de' ? 'Ziffernblock' : 'Numpad'} ${identifier.slice('keypad.'.length)}`
    } else {
      label = identifier
        .split('.')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    }
  } else if (rawKey === 'key.mouse.left') {
    label = lang === 'de' ? 'Linke Maus' : 'Left Mouse'
  } else if (rawKey === 'key.mouse.right') {
    label = lang === 'de' ? 'Rechte Maus' : 'Right Mouse'
  } else if (rawKey === 'key.mouse.middle') {
    label = lang === 'de' ? 'Mittlere Maus' : 'Middle Mouse'
  } else if (rawKey.startsWith('key.mouse.')) {
    label = `${lang === 'de' ? 'Maus' : 'Mouse'} ${rawKey.slice('key.mouse.'.length)}`
  } else if (rawKey.startsWith('scancode.')) {
    label = `Scancode ${rawKey.slice('scancode.'.length)}`
  } else {
    label = rawKey
  }

  return [...modifiers, label].join(' + ')
}

export function keyTokenFromEvent(event: Pick<KeyboardEvent, 'code'>): string | null {
  const code = event.code
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return `key.keyboard.${letter[1].toLowerCase()}`
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return `key.keyboard.${digit[1]}`
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (functionKey) return `key.keyboard.f${functionKey[1]}`
  const numpadDigit = /^Numpad([0-9])$/.exec(code)
  if (numpadDigit) return `key.keyboard.keypad.${numpadDigit[1]}`

  const map: Record<string, string> = {
    Escape: 'escape',
    Minus: 'minus',
    Equal: 'equal',
    Backspace: 'backspace',
    Tab: 'tab',
    BracketLeft: 'left.bracket',
    BracketRight: 'right.bracket',
    Enter: 'enter',
    ControlLeft: 'left.control',
    ControlRight: 'right.control',
    Semicolon: 'semicolon',
    Quote: 'apostrophe',
    Backquote: 'grave.accent',
    ShiftLeft: 'left.shift',
    ShiftRight: 'right.shift',
    Backslash: 'backslash',
    Comma: 'comma',
    Period: 'period',
    Slash: 'slash',
    AltLeft: 'left.alt',
    AltRight: 'right.alt',
    Space: 'space',
    CapsLock: 'caps.lock',
    NumLock: 'num.lock',
    ScrollLock: 'scroll.lock',
    NumpadAdd: 'keypad.add',
    NumpadSubtract: 'keypad.subtract',
    NumpadMultiply: 'keypad.multiply',
    NumpadDivide: 'keypad.divide',
    NumpadDecimal: 'keypad.decimal',
    NumpadComma: 'keypad.decimal',
    NumpadEnter: 'keypad.enter',
    NumpadEqual: 'keypad.equal',
    PrintScreen: 'print.screen',
    Pause: 'pause',
    Home: 'home',
    End: 'end',
    PageUp: 'page.up',
    PageDown: 'page.down',
    Insert: 'insert',
    Delete: 'delete',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    MetaLeft: 'left.win',
    MetaRight: 'right.win',
    ContextMenu: 'menu',
  }
  const identifier = map[code]
  return identifier ? `key.keyboard.${identifier}` : null
}

export function keyTokenFromMouseButton(button: number): string | null {
  if (!Number.isInteger(button) || button < 0 || button > 15) return null
  if (button === 0) return 'key.mouse.left'
  if (button === 1) return 'key.mouse.middle'
  if (button === 2) return 'key.mouse.right'
  return `key.mouse.${button + 1}`
}

export function normalizeKeybinds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_KEYBINDS }
  const result: Record<string, string> = {}
  for (const [key, token] of Object.entries(value as Record<string, unknown>)) {
    if (typeof token === 'string' && token.length > 0) result[key] = token
  }
  return { ...DEFAULT_KEYBINDS, ...result }
}

export function mergeKeybinds(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> {
  return { ...DEFAULT_KEYBINDS, ...(base || {}), ...(override || {}) }
}

export function keybindConflicts(values: Record<string, string>): Map<string, string[]> {
  const byToken = new Map<string, string[]>()
  for (const entry of ALL_KEYBIND_ACTIONS) {
    const token = values[entry.id]
    if (!token || token === 'key.keyboard.unknown') continue
    const normalized = token.trim().toLowerCase()
    byToken.set(normalized, [...(byToken.get(normalized) || []), entry.id])
  }
  const conflicts = new Map<string, string[]>()
  for (const ids of byToken.values()) {
    if (ids.length < 2) continue
    for (const id of ids) conflicts.set(id, ids.filter((other) => other !== id))
  }
  return conflicts
}

export interface KeyboardKey {
  id: string
  label: string
  width?: number
  col?: number
  token?: string
}

interface KeyDefinition {
  label: string
  token: string
  width?: number
}

const KEY_DEFS: Record<string, KeyDefinition> = {
  esc: { label: 'Esc', token: 'key.keyboard.escape', width: 1.25 },
  print: { label: 'Prt', token: 'key.keyboard.print.screen' },
  scroll: { label: 'Scr', token: 'key.keyboard.scroll.lock' },
  pause: { label: 'Pau', token: 'key.keyboard.pause' },
  grave: { label: '`', token: 'key.keyboard.grave.accent' },
  minus: { label: '-', token: 'key.keyboard.minus' },
  equal: { label: '=', token: 'key.keyboard.equal' },
  backspace: { label: 'Backspace', token: 'key.keyboard.backspace', width: 2 },
  tab: { label: 'Tab', token: 'key.keyboard.tab', width: 1.5 },
  backslash: { label: '\\', token: 'key.keyboard.backslash', width: 1.5 },
  caps: { label: 'Caps', token: 'key.keyboard.caps.lock', width: 1.8 },
  enter: { label: 'Enter', token: 'key.keyboard.enter', width: 2.2 },
  lshift: { label: 'Shift', token: 'key.keyboard.left.shift', width: 2.4 },
  rshift: { label: 'Shift', token: 'key.keyboard.right.shift', width: 2.6 },
  lctrl: { label: 'Ctrl', token: 'key.keyboard.left.control', width: 1.35 },
  rctrl: { label: 'Ctrl', token: 'key.keyboard.right.control', width: 1.35 },
  lwin: { label: 'Win', token: 'key.keyboard.left.win', width: 1.2 },
  rwin: { label: 'Win', token: 'key.keyboard.right.win', width: 1.2 },
  lalt: { label: 'Alt', token: 'key.keyboard.left.alt', width: 1.2 },
  ralt: { label: 'Alt', token: 'key.keyboard.right.alt', width: 1.2 },
  menu: { label: 'Menü', token: 'key.keyboard.menu', width: 1.2 },
  space: { label: 'Space', token: 'key.keyboard.space', width: 6.2 },
  semicolon: { label: ';', token: 'key.keyboard.semicolon' },
  quote: { label: "'", token: 'key.keyboard.apostrophe' },
  comma: { label: ',', token: 'key.keyboard.comma' },
  period: { label: '.', token: 'key.keyboard.period' },
  slash: { label: '/', token: 'key.keyboard.slash' },
  lbracket: { label: '[', token: 'key.keyboard.left.bracket' },
  rbracket: { label: ']', token: 'key.keyboard.right.bracket' },
  insert: { label: 'Ins', token: 'key.keyboard.insert' },
  home: { label: 'Home', token: 'key.keyboard.home' },
  pageup: { label: 'PgU', token: 'key.keyboard.page.up' },
  delete: { label: 'Del', token: 'key.keyboard.delete' },
  end: { label: 'End', token: 'key.keyboard.end' },
  pagedown: { label: 'PgD', token: 'key.keyboard.page.down' },
  up: { label: '↑', token: 'key.keyboard.up' },
  down: { label: '↓', token: 'key.keyboard.down' },
  left: { label: '←', token: 'key.keyboard.left' },
  right: { label: '→', token: 'key.keyboard.right' },
  numlock: { label: 'Num', token: 'key.keyboard.num.lock' },
  numdiv: { label: '/', token: 'key.keyboard.keypad.divide' },
  nummul: { label: '×', token: 'key.keyboard.keypad.multiply' },
  numminus: { label: '−', token: 'key.keyboard.keypad.subtract' },
  numplus: { label: '+', token: 'key.keyboard.keypad.add' },
  numenter: { label: 'Ent', token: 'key.keyboard.keypad.enter' },
  numdot: { label: '.', token: 'key.keyboard.keypad.decimal' },
  num0: { label: '0', token: 'key.keyboard.keypad.0', width: 2 },
}

for (const digit of '0123456789') {
  KEY_DEFS[digit] = { label: digit, token: `key.keyboard.${digit}` }
}
for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
  KEY_DEFS[letter] = { label: letter.toUpperCase(), token: `key.keyboard.${letter}` }
}
for (let index = 1; index <= 12; index += 1) {
  KEY_DEFS[`f${index}`] = { label: `F${index}`, token: `key.keyboard.f${index}` }
}
for (const digit of '123456789') {
  KEY_DEFS[`num${digit}`] = { label: digit, token: `key.keyboard.keypad.${digit}` }
}

type KeySpec = string | [string, { col?: number; width?: number }]

function key(id: string, extra: { col?: number; width?: number } = {}): KeyboardKey {
  const definition = KEY_DEFS[id]
  if (!definition) throw new Error(`Unknown keyboard key: ${id}`)
  return {
    id,
    label: definition.label,
    token: definition.token,
    ...(definition.width !== undefined ? { width: definition.width } : {}),
    ...extra,
  }
}

function row(start: number, specs: KeySpec[]): KeyboardKey[] {
  let cursor = start
  return specs.map((spec) => {
    const [id, extra] = typeof spec === 'string' ? [spec, {}] : spec
    if (extra.col !== undefined) cursor = extra.col
    const placed = key(id, extra)
    const withColumn = { ...placed, col: cursor }
    cursor += placed.width ?? 1
    return withColumn
  })
}

export type KeyboardLayoutId = 'full' | 'tkl' | 'compact'

export interface KeyboardLayout {
  id: KeyboardLayoutId
  label: Bilingual
  description: Bilingual
  rows: KeyboardKey[][]
}

const NAV_COL = 15.5
const PAD_COL = 19.25
const ARROW_COL = 16
const ARROW_UP_COL = ARROW_COL + 1

const FUNCTION_ROW: KeySpec[] = [
  'esc',
  ['f1', { col: 2 }], 'f2', 'f3', 'f4',
  ['f5', { col: 6.5 }], 'f6', 'f7', 'f8',
  ['f9', { col: 11 }], 'f10', 'f11', 'f12',
]
const NUMBER_ROW: KeySpec[] = ['grave', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'minus', 'equal', 'backspace']
const TOP_ROW: KeySpec[] = ['tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'lbracket', 'rbracket', 'backslash']
const HOME_ROW: KeySpec[] = ['caps', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'semicolon', 'quote', 'enter']
const BOTTOM_ROW: KeySpec[] = ['lshift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'comma', 'period', 'slash', 'rshift']
const MODIFIER_ROW: KeySpec[] = ['lctrl', 'lwin', 'lalt', 'space', 'ralt', 'rwin', 'menu', 'rctrl']

const FULL_LAYOUT_ROWS: KeyboardKey[][] = [
  row(0, [...FUNCTION_ROW, ['print', { col: NAV_COL }], 'scroll', 'pause']),
  row(0, [...NUMBER_ROW, ['insert', { col: NAV_COL }], 'home', 'pageup', ['numlock', { col: PAD_COL }], 'numdiv', 'nummul', 'numminus']),
  row(0, [...TOP_ROW, ['delete', { col: NAV_COL }], 'end', 'pagedown', ['num7', { col: PAD_COL }], 'num8', 'num9', 'numplus']),
  row(0, [...HOME_ROW, ['num4', { col: PAD_COL }], 'num5', 'num6']),
  row(0, [...BOTTOM_ROW, ['up', { col: ARROW_UP_COL }], ['num1', { col: PAD_COL }], 'num2', 'num3', 'numenter']),
  row(0, [...MODIFIER_ROW, ['left', { col: ARROW_COL }], 'down', 'right', ['num0', { col: PAD_COL }], ['numdot', { col: PAD_COL + 2 }]]),
]

const TKL_ROWS: KeyboardKey[][] = [
  row(0, [...FUNCTION_ROW, ['print', { col: NAV_COL }], 'scroll', 'pause']),
  row(0, [...NUMBER_ROW, ['insert', { col: NAV_COL }], 'home', 'pageup']),
  row(0, [...TOP_ROW, ['delete', { col: NAV_COL }], 'end', 'pagedown']),
  row(0, [...HOME_ROW]),
  row(0, [...BOTTOM_ROW, ['up', { col: ARROW_UP_COL }]]),
  row(0, [...MODIFIER_ROW, ['left', { col: ARROW_COL }], 'down', 'right']),
]

const COMPACT_ROWS: KeyboardKey[][] = [
  row(0, [...FUNCTION_ROW, ['delete', { col: NAV_COL }]]),
  row(0, [...NUMBER_ROW, ['home', { col: NAV_COL }]]),
  row(0, [...TOP_ROW, ['pageup', { col: NAV_COL }]]),
  row(0, [...HOME_ROW, ['end', { col: NAV_COL }]]),
  row(0, [...BOTTOM_ROW, ['up', { col: ARROW_UP_COL }]]),
  row(0, [...MODIFIER_ROW, ['left', { col: ARROW_COL }], 'down', 'right']),
]

export const KEYBOARD_LAYOUTS: KeyboardLayout[] = [
  {
    id: 'full',
    label: { de: '100 %', en: '100%' },
    description: { de: 'Vollformat mit Nummernblock', en: 'Full-size with numpad' },
    rows: FULL_LAYOUT_ROWS,
  },
  {
    id: 'tkl',
    label: { de: 'TKL', en: 'TKL' },
    description: { de: 'Ohne Nummernblock', en: 'Tenkeyless, no numpad' },
    rows: TKL_ROWS,
  },
  {
    id: 'compact',
    label: { de: '75 %', en: '75%' },
    description: { de: 'Kompakt, ohne Nummernblock', en: 'Compact, no numpad' },
    rows: COMPACT_ROWS,
  },
]

export const KEYBOARD_ROWS: KeyboardKey[][] = FULL_LAYOUT_ROWS

export function normalizeKeyboardLayout(value: unknown): KeyboardLayoutId {
  return value === 'tkl' || value === 'compact' || value === 'full' ? value : 'full'
}

export function keyboardLayout(id: KeyboardLayoutId | unknown): KeyboardLayout {
  const normalized = normalizeKeyboardLayout(id)
  return KEYBOARD_LAYOUTS.find((layout) => layout.id === normalized) || KEYBOARD_LAYOUTS[0]
}

export function layoutTokens(layout: KeyboardLayout): Set<string> {
  const tokens = new Set<string>([
    'key.mouse.left',
    'key.mouse.middle',
    'key.mouse.right',
    ...Array.from({ length: 13 }, (_, index) => `key.mouse.${index + 4}`),
  ])
  for (const row of layout.rows) {
    for (const key of row) if (key.token) tokens.add(key.token)
  }
  return tokens
}

export function layoutKeyLabel(layout: KeyboardLayout, token: string | undefined): string | null {
  if (!token) return null
  for (const row of layout.rows) {
    for (const key of row) if (key.token === token) return key.label
  }
  return null
}

export function keybindPatch(values: Record<string, string>): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const [id, token] of Object.entries(values)) {
    if (!token) continue
    patch[`key_${id}`] = token
  }
  return patch
}
