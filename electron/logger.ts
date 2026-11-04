/** Structured JSONL logger with rotation and secret redaction. */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  child(tag: string): Logger
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEY = /(token|secret|password|passphrase|api[_-]?key|authorization|cookie|session)/i
const MASK = '[redacted]'

function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > 6) return '[depth-limit]'
  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => redactValue(entry, depth + 1, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) && entry !== undefined && entry !== null && entry !== ''
      ? MASK
      : redactValue(entry, depth + 1, seen)
  }
  return output
}

export function redact(data: unknown): unknown {
  return redactValue(data)
}

export function createNullLogger(): Logger {
  const noop = () => undefined
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  return logger
}

let defaultLogger: Logger | null = null

/** Modules without a logger in their constructor share the core's logger. */
export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger
}

export function getDefaultLogger(): Logger {
  return defaultLogger ?? createNullLogger()
}

/** Stable one-line detail for logs; never throws on odd thrown values. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export interface FileLoggerOptions {
  dir: string
  fileName?: string
  maxBytes?: number
  maxFiles?: number
  level?: LogLevel
  mirror?: Pick<Console, 'log' | 'warn' | 'error'>
  base?: Record<string, unknown>
}

function resolveLevel(explicit?: LogLevel): LogLevel {
  const fromEnv = (process.env.BAMBOO_LOG_LEVEL || '').toLowerCase()
  if (fromEnv === 'debug' || fromEnv === 'info' || fromEnv === 'warn' || fromEnv === 'error') return fromEnv
  return explicit ?? 'info'
}

export function createFileLogger(options: FileLoggerOptions): Logger {
  const level = resolveLevel(options.level)
  const threshold = LEVEL_WEIGHT[level]
  const fileName = options.fileName ?? 'main.log'
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const maxFiles = Math.max(1, options.maxFiles ?? 3)
  const file = join(options.dir, fileName)
  const base = options.base ?? {}

  try {
    mkdirSync(options.dir, { recursive: true })
  } catch {
    // Log directory unavailable: logging degrades, it must not crash the app.
  }

  const rotate = () => {
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < maxBytes) return
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const from = index === 1 ? file : `${file}.${index - 1}`
        const to = `${file}.${index}`
        if (!existsSync(from)) continue
        if (existsSync(to)) unlinkSync(to)
        renameSync(from, to)
      }
    } catch {
      // Rotation is best effort; the next append still works.
    }
  }

  const write = (entryLevel: LogLevel, tag: string, message: string, data?: unknown) => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      tag,
      msg: message,
      pid: process.pid,
      ...base,
    }
    if (data !== undefined) record.data = redact(data)
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      line = JSON.stringify({ ...record, data: '[unserializable]' })
    }
    try {
      rotate()
      appendFileSync(file, `${line}\n`, 'utf8')
    } catch {
      // A failed write must not break the caller's logging path.
    }
    const mirror = options.mirror
    if (mirror) {
      const text = `[${entryLevel}] [${tag}] ${message}`
      if (entryLevel === 'error') mirror.error(text, data ?? '')
      else if (entryLevel === 'warn') mirror.warn(text, data ?? '')
      else mirror.log(text, data ?? '')
    }
  }

  const make = (tag: string): Logger => ({
    debug: (message, data) => write('debug', tag, message, data),
    info: (message, data) => write('info', tag, message, data),
    warn: (message, data) => write('warn', tag, message, data),
    error: (message, data) => write('error', tag, message, data),
    child: (childTag) => make(tag ? `${tag}:${childTag}` : childTag),
  })

  return make('core')
}
