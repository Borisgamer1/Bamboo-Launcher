import { GameSettingsError } from './errors'

export interface PropertyEntry {
  key: string
  value: string
  rawLine: string
}

export type PropertyLine =
  | { kind: 'entry'; entry: PropertyEntry }
  | { kind: 'raw'; raw: string }

export interface PropertyDocument {
  text: string
  eol: '\n' | '\r\n'
  finalNewline: boolean
  separator: ':' | '='
  lines: PropertyLine[]
  entries: PropertyEntry[]
  values: Record<string, string>
  keys: string[]
}

function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

export function parseProperties(text: string, separator: ':' | '=' = '='): PropertyDocument {
  const eol = detectEol(text)
  const finalNewline = text.endsWith('\n')
  const sourceLines = text.length === 0 ? [] : text.split(/\r?\n/)
  if (finalNewline) sourceLines.pop()

  const lines: PropertyLine[] = []
  const entries: PropertyEntry[] = []
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  const keys: string[] = []
  const seen = new Set<string>()

  for (const rawLine of sourceLines) {
    const trimmed = rawLine.trimStart()
    if (rawLine.trim().length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      lines.push({ kind: 'raw', raw: rawLine })
      continue
    }
    const index = rawLine.indexOf(separator)
    if (index <= 0) {
      lines.push({ kind: 'raw', raw: rawLine })
      continue
    }
    const key = rawLine.slice(0, index).trim()
    if (!key) {
      lines.push({ kind: 'raw', raw: rawLine })
      continue
    }
    const value = rawLine.slice(index + 1).trim()
    const entry: PropertyEntry = { key, value, rawLine }
    lines.push({ kind: 'entry', entry })
    entries.push(entry)
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
    values[key] = value
  }

  return { text, eol, finalNewline, separator, lines, entries, values, keys }
}

function validateKey(key: string): void {
  if (key.length === 0 || /[=:\r\n]/.test(key)) {
    throw new GameSettingsError('invalid-key', `Invalid property key: ${JSON.stringify(key)}`)
  }
}

function validateValue(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new GameSettingsError('invalid-value', `Property ${key} must be a string`)
  }
  if (/[\r\n]/.test(value)) {
    throw new GameSettingsError('invalid-value', `Property ${key} contains a line break`)
  }
  return value
}

export interface MergePropertiesResult {
  text: string
  changed: boolean
  diff: Record<string, string>
  document: PropertyDocument
}

export function mergeProperties(
  originalText: string,
  patch: Record<string, string | undefined>,
  separator: ':' | '=' = '=',
): MergePropertiesResult {
  const document = parseProperties(originalText, separator)
  const diff: Record<string, string> = Object.create(null) as Record<string, string>
  const existing = new Set(document.keys)

  for (const [key, rawValue] of Object.entries(patch)) {
    if (rawValue === undefined) continue
    validateKey(key)
    const value = validateValue(key, rawValue)
    if (!existing.has(key) || document.values[key] !== value) diff[key] = value
  }

  const output: string[] = []
  for (const line of document.lines) {
    if (line.kind === 'raw') {
      output.push(line.raw)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(diff, line.entry.key)) {
      output.push(`${line.entry.key}${separator}${diff[line.entry.key]}`)
    } else {
      output.push(line.entry.rawLine)
    }
  }
  for (const key of Object.keys(diff)) {
    if (existing.has(key)) continue
    output.push(`${key}${separator}${diff[key]}`)
  }

  let text = output.join(document.eol)
  if (document.finalNewline) text += document.eol
  return {
    text,
    changed: Object.keys(diff).length > 0,
    diff,
    document: parseProperties(text, separator),
  }
}
