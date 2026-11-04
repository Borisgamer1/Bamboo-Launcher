import { describeError, getDefaultLogger } from '../logger'
import { GameSettingsError } from './errors'

export type OptionPrimitive = string | number | boolean | null
export type OptionValue = OptionPrimitive | OptionPrimitive[]

export interface OptionEntry {
  key: string
  value: OptionValue
  rawValue: string
  rawLine: string
  quoted: boolean
}

export type OptionLine =
  | { kind: 'entry'; entry: OptionEntry }
  | { kind: 'raw'; raw: string }

export interface OptionDocument {
  text: string
  eol: '\n' | '\r\n'
  finalNewline: boolean
  lines: OptionLine[]
  entries: OptionEntry[]
  values: Record<string, OptionValue>
  keys: string[]
}

export interface MergeOptionsOptions {
  eol?: '\n' | '\r\n'
  finalNewline?: boolean
}

export interface MergeOptionsResult {
  text: string
  changed: boolean
  diff: Record<string, OptionValue>
  document: OptionDocument
}

const INTEGER_PATTERN = /^[-+]?\d+$/
const FLOAT_PATTERN = /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const BOOLEAN_PATTERN = /^(true|false)$/

export function encodeUnicodeEscapes(value: string): string {
  return value.replace(/[\u007f-\uffff]/g, (char) => {
    const code = char.charCodeAt(0)
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

export function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

function jsonStringifyUnicode(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
    const code = char.charCodeAt(0)
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

function decodeJsonString(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : undefined
  } catch (error) {
    // Malformed quoted values fall back to the loose decoder below.
    getDefaultLogger().child('settings').debug('options.txt quoted value is not JSON', {
      raw: raw.slice(0, 120),
      error: describeError(error),
    })
    return undefined
  }
}

function parseLooseArray(raw: string): OptionPrimitive[] {
  const matches = [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)]
  if (matches.length > 0) {
    const values: OptionPrimitive[] = []
    for (const match of matches) {
      const decoded = decodeJsonString(`"${match[1]}"`)
      values.push(decoded ?? decodeUnicodeEscapes(match[1]))
    }
    return values
  }
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!inner.trim()) return []
  return inner
    .split(',')
    .map((part) => decodeUnicodeEscapes(part.trim().replace(/^['"]|['"]$/g, '')))
    .filter((part) => part.length > 0)
}

function sanitizeArray(value: unknown[]): OptionPrimitive[] {
  const result: OptionPrimitive[] = []
  for (const entry of value) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      result.push(entry)
    } else {
      result.push(String(entry))
    }
  }
  return result
}

function parseValue(rawValue: string): { value: OptionValue; quoted: boolean } {
  const trimmed = rawValue.trim()
  if (trimmed.length === 0) return { value: '', quoted: false }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const decoded = decodeJsonString(trimmed)
    if (decoded !== undefined) return { value: decoded, quoted: true }
    return { value: decodeUnicodeEscapes(trimmed.slice(1, -1)), quoted: true }
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) return { value: sanitizeArray(parsed), quoted: false }
    } catch (error) {
      // Non-JSON arrays are common in options.txt; the loose parser is the fallback.
      getDefaultLogger().child('settings').debug('options.txt array is not JSON; parsing loosely', {
        raw: trimmed.slice(0, 120),
        error: describeError(error),
      })
      return { value: parseLooseArray(trimmed), quoted: false }
    }
  }

  if (INTEGER_PATTERN.test(trimmed)) {
    const integer = Number.parseInt(trimmed, 10)
    if (Number.isSafeInteger(integer)) return { value: integer, quoted: false }
  }
  if (FLOAT_PATTERN.test(trimmed)) {
    const float = Number.parseFloat(trimmed)
    if (Number.isFinite(float)) return { value: float, quoted: false }
  }
  if (BOOLEAN_PATTERN.test(trimmed)) {
    return { value: trimmed === 'true', quoted: false }
  }
  return { value: decodeUnicodeEscapes(trimmed), quoted: false }
}

function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

export function parseOptions(text: string): OptionDocument {
  const eol = detectEol(text)
  const finalNewline = text.endsWith('\n')
  const sourceLines = text.length === 0 ? [] : text.split(/\r?\n/)
  if (finalNewline) sourceLines.pop()

  const lines: OptionLine[] = []
  const entries: OptionEntry[] = []
  const values: Record<string, OptionValue> = Object.create(null) as Record<string, OptionValue>
  const keys: string[] = []
  const seen = new Set<string>()

  for (const rawLine of sourceLines) {
    const colon = rawLine.indexOf(':')
    if (colon <= 0) {
      lines.push({ kind: 'raw', raw: rawLine })
      continue
    }
    const key = rawLine.slice(0, colon).trim()
    if (key.length === 0) {
      lines.push({ kind: 'raw', raw: rawLine })
      continue
    }
    const rawValue = rawLine.slice(colon + 1)
    const parsed = parseValue(rawValue)
    const entry: OptionEntry = {
      key,
      value: parsed.value,
      rawValue,
      rawLine,
      quoted: parsed.quoted,
    }
    lines.push({ kind: 'entry', entry })
    entries.push(entry)
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
    values[key] = parsed.value
  }

  return { text, eol, finalNewline, lines, entries, values, keys }
}

function isPrimitive(value: unknown): value is OptionPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function validateValue(key: string, value: unknown): OptionValue {
  if (Array.isArray(value)) {
    if (!value.every(isPrimitive)) {
      throw new GameSettingsError('invalid-value', `Option ${key} contains a non-primitive array value`)
    }
    return [...value]
  }
  if (!isPrimitive(value)) {
    throw new GameSettingsError('invalid-value', `Option ${key} has an unsupported value type`)
  }
  return value
}

function validateKey(key: string): void {
  if (key.length === 0 || /[:\r\n]/.test(key)) {
    throw new GameSettingsError('invalid-key', `Invalid options.txt key: ${JSON.stringify(key)}`)
  }
}

function stringNeedsQuotes(value: string): boolean {
  if (value.length === 0) return false
  if (/^(true|false)$/.test(value)) return true
  if (INTEGER_PATTERN.test(value) || FLOAT_PATTERN.test(value)) return true
  if (value.startsWith('[') && value.endsWith(']')) return true
  if (value.startsWith('"')) return true
  if (/["\\\r\n]/.test(value)) return true
  return value !== value.trim()
}

function formatValue(value: OptionValue, quoteString = false): string {
  if (Array.isArray(value)) return jsonStringifyUnicode(value)
  if (typeof value === 'string') {
    return quoteString || stringNeedsQuotes(value)
      ? jsonStringifyUnicode(value)
      : encodeUnicodeEscapes(value)
  }
  return String(value)
}

function formatEntry(key: string, value: OptionValue, quoteString = false): string {
  return `${key}:${formatValue(value, quoteString)}`
}

function valuesEqual(a: OptionValue, b: OptionValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => valuesEqual(entry, b[index] as OptionPrimitive))
  }
  return a === b
}

export function mergeOptions(
  originalText: string,
  patch: Record<string, OptionValue | undefined>,
  options: MergeOptionsOptions = {},
): MergeOptionsResult {
  const document = parseOptions(originalText)
  const eol = document.text.length > 0 ? document.eol : (options.eol ?? '\n')
  const finalNewline =
    options.finalNewline ?? (document.text.length > 0 ? document.finalNewline : true)
  const diff: Record<string, OptionValue> = Object.create(null) as Record<string, OptionValue>
  const existing = new Set(document.keys)

  for (const [key, rawValue] of Object.entries(patch)) {
    if (rawValue === undefined) continue
    validateKey(key)
    const value = validateValue(key, rawValue)
    if (!existing.has(key) || !valuesEqual(document.values[key] as OptionValue, value)) {
      diff[key] = value
    }
  }

  const output: string[] = []
  for (const line of document.lines) {
    if (line.kind === 'raw') {
      output.push(line.raw)
      continue
    }
    const key = line.entry.key
    if (Object.prototype.hasOwnProperty.call(diff, key)) {
      output.push(formatEntry(key, diff[key], line.entry.quoted))
    } else {
      output.push(line.entry.rawLine)
    }
  }

  for (const key of Object.keys(diff)) {
    if (existing.has(key)) continue
    output.push(formatEntry(key, diff[key]))
  }

  let text = output.join(eol)
  if (finalNewline) text += eol
  return {
    text,
    changed: Object.keys(diff).length > 0,
    diff,
    document: parseOptions(text),
  }
}

export function getOption(text: string, key: string): OptionValue | undefined {
  return parseOptions(text).values[key]
}

export function stringifyOptions(
  document: OptionDocument,
  patch: Record<string, OptionValue | undefined> = {},
): string {
  return mergeOptions(document.text, patch).text
}
