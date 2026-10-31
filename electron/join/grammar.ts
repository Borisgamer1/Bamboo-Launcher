import { isIP } from 'node:net'
import type { JoinParseResult, JoinPayload, JoinRejectionCode } from './types'
import { describeError, getDefaultLogger } from '../logger'

export const MAX_JOIN_URL_BYTES = 2048
export const DEFAULT_JOIN_PORT = 25565
export const JOIN_SCHEME = 'bamboo-launcher'

const DNS_HOST =
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SHA1 = /^[a-f0-9]{40}$/i
const PACK_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'mediafilez.forgecdn.net',
])
const PACK_KEYS = new Set(['v', 'host', 'port', 'profile', 'pack', 'sha1', 'name'])

function reject(code: JoinRejectionCode, message: string): JoinParseResult {
  return { ok: false, code, message }
}

function grammar(message: string): JoinParseResult {
  return reject('join.rejected-grammar', message)
}

function displayName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('name must be a string')
  if ([...value].length > 64) throw new Error('name is longer than 64 characters')
  return value
}

function portValue(value: unknown): number {
  if (value === undefined) return DEFAULT_JOIN_PORT
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('port out of range')
    return value
  }
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error('port must be an integer without leading zeros')
  }
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('port out of range')
  return port
}

function validHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false
  if (value.startsWith('[') || value.endsWith(']')) {
    if (!value.startsWith('[') || !value.endsWith(']')) return false
    return isIP(value.slice(1, -1)) === 6
  }
  if (isIP(value) === 6) return false
  if (isIP(value) === 4) return true
  const labels = value.split('.')
  if (labels.length === 4 && labels.every((label) => /^\d+$/.test(label))) return false
  if (labels.some((label) => label.toLowerCase().startsWith('xn--'))) return false
  return DNS_HOST.test(value)
}

function validPackUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    getDefaultLogger().child('join').debug('pack URL is not a valid URL', { error: describeError(error) })
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.hash) return false
  return PACK_HOSTS.has(parsed.hostname.toLowerCase())
}

function normalize(input: unknown, kind: 'join' | 'invite'): JoinParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return grammar('payload must be an object')
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!PACK_KEYS.has(key)) return grammar(`unknown parameter: ${key}`)
  }
  if (raw.v !== 1 && raw.v !== '1') return grammar('v must be 1')

  const hostValue = typeof raw.host === 'string' ? raw.host : ''
  if (!validHost(hostValue)) return grammar('invalid host')
  const host = hostValue.toLowerCase()

  let port: number
  let name: string | undefined
  try {
    port = portValue(raw.port)
    name = displayName(raw.name)
  } catch (error) {
    return grammar((error as Error).message)
  }

  let profile: string | undefined
  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string' || !PROFILE_ID.test(raw.profile)) {
      return grammar('invalid profile id')
    }
    profile = raw.profile
  }

  const pack = typeof raw.pack === 'string' && raw.pack.length > 0 ? raw.pack : undefined
  const sha1 = typeof raw.sha1 === 'string' && raw.sha1.length > 0 ? raw.sha1 : undefined
  if (raw.pack !== undefined && !pack) return grammar('invalid pack URL')
  if (raw.sha1 !== undefined && !sha1) return grammar('invalid sha1')
  if ((pack && !sha1) || (sha1 && !pack)) return grammar('pack and sha1 must be used together')
  if (pack && !validPackUrl(pack)) return grammar('pack URL is not allowed')
  if (sha1 && !SHA1.test(sha1)) return grammar('sha1 must be 40 hex characters')

  const payload: JoinPayload = {
    v: 1,
    host,
    port,
    ...(profile ? { profile } : {}),
    ...(pack ? { pack } : {}),
    ...(sha1 ? { sha1: sha1.toLowerCase() } : {}),
    ...(name !== undefined ? { name } : {}),
  }
  return { ok: true, payload, kind }
}

export function validateJoinPayload(input: unknown): JoinParseResult {
  return normalize(input, 'join')
}

export function parseJoinUrl(raw: unknown): JoinParseResult {
  if (typeof raw !== 'string' || raw.length === 0) return grammar('empty link')
  if (Buffer.byteLength(raw, 'utf8') > MAX_JOIN_URL_BYTES) {
    return reject('join.rejected-size', 'link is longer than 2048 bytes')
  }
  if (raw.split('?').length > 2) return grammar('more than one query separator')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return grammar('not a URL')
  }
  if (parsed.protocol.toLowerCase() !== `${JOIN_SCHEME}:`) return grammar('wrong scheme')
  if (parsed.username || parsed.password) return grammar('userinfo is not allowed')
  if (parsed.pathname !== '') return grammar('path is not allowed')
  if (parsed.hash) return grammar('fragment is not allowed')
  if (parsed.port) return grammar('port belongs in the query')

  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'join') {
    const keys = [...parsed.searchParams.keys()]
    if (new Set(keys).size !== keys.length) return grammar('duplicate parameter')
    const values: Record<string, string> = {}
    for (const [key, value] of parsed.searchParams) values[key] = value
    return normalize(values, 'join')
  }
  if (hostname === 'invite') {
    const keys = [...parsed.searchParams.keys()]
    if (keys.length !== 1 || keys[0] !== 'data') return grammar('invite accepts only data')
    const data = parsed.searchParams.get('data')
    if (!data) return grammar('invite data is missing')
    let decoded: unknown
    try {
      decoded = JSON.parse(data)
    } catch {
      return grammar('invite data is not valid JSON')
    }
    return normalize(decoded, 'invite')
  }
  return grammar('unknown link target')
}

function assertUrlSize(url: string): string {
  if (Buffer.byteLength(url, 'utf8') > MAX_JOIN_URL_BYTES) {
    throw new Error('join.rejected-size: link is longer than 2048 bytes')
  }
  return url
}

export function buildInviteUrl(input: unknown): string {
  const parsed = validateJoinPayload(input)
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`)
  const data = encodeURIComponent(JSON.stringify(parsed.payload))
  return assertUrlSize(`${JOIN_SCHEME}://invite?data=${data}`)
}

export function buildJoinUrl(input: unknown): string {
  const parsed = validateJoinPayload(input)
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`)
  const params = new URLSearchParams({ v: '1', host: parsed.payload.host })
  if (parsed.payload.port !== DEFAULT_JOIN_PORT) params.set('port', String(parsed.payload.port))
  if (parsed.payload.profile) params.set('profile', parsed.payload.profile)
  if (parsed.payload.pack) params.set('pack', parsed.payload.pack)
  if (parsed.payload.sha1) params.set('sha1', parsed.payload.sha1)
  if (parsed.payload.name !== undefined) params.set('name', parsed.payload.name)
  return assertUrlSize(`${JOIN_SCHEME}://join?${params.toString()}`)
}
