import { join } from 'node:path'
import { readTextFile } from '../atomic'
import { GameSettingsError } from './errors'
import { writeGameFile } from './fileio'
import { mergeProperties, parseProperties } from './properties'

export const SERVER_PROPERTY_ALLOWLIST = [
  'allow-flight',
  'allow-nether',
  'broadcast-console-to-ops',
  'broadcast-rcon-to-ops',
  'difficulty',
  'enable-command-block',
  'enable-query',
  'enable-rcon',
  'enable-status',
  'enforce-whitelist',
  'entity-broadcast-range-percentage',
  'force-gamemode',
  'function-permission-level',
  'gamemode',
  'generate-structures',
  'hardcore',
  'hide-online-players',
  'level-name',
  'level-seed',
  'level-type',
  'log-ips',
  'max-players',
  'max-tick-time',
  'max-world-size',
  'motd',
  'network-compression-threshold',
  'online-mode',
  'op-permission-level',
  'player-idle-timeout',
  'prevent-proxy-connections',
  'pvp',
  'query.port',
  'rate-limit',
  'require-resource-pack',
  'resource-pack',
  'resource-pack-prompt',
  'resource-pack-sha1',
  'rcon.port',
  'server-ip',
  'server-port',
  'simulation-distance',
  'spawn-animals',
  'spawn-monsters',
  'spawn-npcs',
  'spawn-protection',
  'sync-chunk-writes',
  'view-distance',
  'white-list',
] as const

export type ServerPropertyKey = (typeof SERVER_PROPERTY_ALLOWLIST)[number]
const ALLOWED = new Set<string>(SERVER_PROPERTY_ALLOWLIST)

export interface ServerPropertiesRead {
  file: string
  values: Record<string, string>
  keys: string[]
  ignored: string[]
}

function serverFile(serverDir: string): string {
  return join(serverDir, 'server.properties')
}

export async function readServerProperties(
  serverDir: string,
  keys: readonly string[] = SERVER_PROPERTY_ALLOWLIST,
): Promise<ServerPropertiesRead> {
  const file = serverFile(serverDir)
  const text = (await readTextFile(file)) ?? ''
  const document = parseProperties(text, '=')
  const wanted = new Set(keys)
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  const present: string[] = []
  const ignored: string[] = []
  for (const key of document.keys) {
    if (wanted.has(key) && ALLOWED.has(key)) {
      values[key] = document.values[key]
      present.push(key)
    } else {
      ignored.push(key)
    }
  }
  return { file, values, keys: present, ignored }
}

export async function writeServerProperties(
  serverDir: string,
  patch: Record<string, string | undefined>,
): Promise<{ file: string; changed: boolean; diff: Record<string, string> }> {
  const rejected = Object.keys(patch).filter((key) => !ALLOWED.has(key))
  if (rejected.length > 0) {
    throw new GameSettingsError(
      'server-allowlist',
      `Server property not in allowlist: ${rejected.join(', ')}`,
    )
  }
  const file = serverFile(serverDir)
  const text = (await readTextFile(file)) ?? ''
  const merged = mergeProperties(text, patch, '=')
  let output = merged.text
  if (text.length === 0 && output.length > 0 && !output.endsWith('\n')) output += '\n'
  if (merged.changed) await writeGameFile(file, output)
  return { file, changed: merged.changed, diff: merged.diff }
}

export async function readEula(serverDir: string): Promise<boolean | undefined> {
  const file = join(serverDir, 'eula.txt')
  const text = await readTextFile(file)
  if (text === undefined) return undefined
  const document = parseProperties(text, '=')
  const value = document.values.eula
  if (value === undefined) return undefined
  return /^true$/i.test(value)
}

export async function writeEula(serverDir: string, accepted: boolean): Promise<string> {
  const file = join(serverDir, 'eula.txt')
  const text = (await readTextFile(file)) ?? ''
  const merged = mergeProperties(text, { eula: String(accepted) }, '=')
  let output = merged.text
  if (!output.endsWith('\n')) output += '\n'
  await writeGameFile(file, output)
  return file
}
