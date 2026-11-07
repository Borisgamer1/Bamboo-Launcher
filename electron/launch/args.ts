import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseMinecraftVersion } from '../java/version'
import { currentPlatform, resolveLaunchArguments } from '../version/rules'
import type { ResolvedVersionModel } from '../version/resolve'
import { mergeJvmArgumentLayers } from './jvm'
import type { LaunchPreparation } from './types'

export const LAUNCHER_NAME = 'Bamboo Launcher'
export const LAUNCHER_VERSION = '0.2.4'
export const LAUNCH_CLIENT_ID = 'bamboo-launcher'

export type PlaceholderValues = Record<string, string | number>

export function toMcPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function formatArgument(template: string, values: PlaceholderValues): string {
  return template.replace(/\$\{(.*?)\}/g, (match, name: string) => {
    if (!(name in values)) return match
    const value = values[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  return hash.toString('hex')
}

export function isModernMsAccount(type: string | undefined): boolean {
  return /microsoft|msa/i.test(type ?? '')
}

interface LoggingClient {
  argument?: string
  file?: { id?: string }
}

export function loggingArgument(model: ResolvedVersionModel, gameRoot: string): string | undefined {
  const client = (model.logging as { client?: LoggingClient } | undefined)?.client
  if (!client?.argument || !client.file?.id) return undefined
  const file = join(gameRoot, 'assets', 'log_configs', client.file.id)
  if (!existsSync(file)) return undefined
  return client.argument.replace('${path}', toMcPath(file))
}

export function supportsQuickPlay(minecraftVersion: string): boolean {
  const parsed = parseMinecraftVersion(minecraftVersion)
  if (!parsed) return false
  if (parsed.major > 1) return true
  return parsed.major === 1 && parsed.minor >= 20
}

export interface BuiltCommand {
  command: string[]
  values: PlaceholderValues
  features: Record<string, boolean>
  classpathEntries: string[]
  quickPlay: boolean
}

export function hasClasspathArgument(jvmArgs: readonly string[]): boolean {
  return jvmArgs.some(
    (argument) =>
      argument === '-cp' ||
      argument === '-classpath' ||
      argument === '--class-path' ||
      argument.startsWith('-cp=') ||
      argument.startsWith('-classpath='),
  )
}

export function buildLaunchCommand(preparation: LaunchPreparation): BuiltCommand {
  const model = preparation.model
  if (!model) throw new Error('buildLaunchCommand requires a resolved model')
  const platform = preparation.platform ?? currentPlatform()
  const features: Record<string, boolean> = { ...(preparation.features ?? {}) }
  if (preparation.demo) features.is_demo_user = true
  if (preparation.resolution) features.has_custom_resolution = true

  const classpathEntries = [
    ...model.libraries.filter((library) => !library.isNative).map((library) => library.absolutePath),
    model.clientJar,
  ]
  const delimiter = platform.name === 'windows' ? ';' : ':'
  const libraryDirectory = join(preparation.gameRoot, 'libraries')
  const nativesDirectory = preparation.nativesDirectory ?? model.nativeDirectory
  const account = preparation.account
  const uuid = (account.uuid || '').replace(/-/g, '') || offlineUuid(account.name || 'Player')
  const accessToken = account.accessToken && account.accessToken.length > 0 ? account.accessToken : '0'
  const userType = isModernMsAccount(account.type) ? 'msa' : 'legacy'
  const resolution = preparation.resolution

  const values: PlaceholderValues = {
    natives_directory: toMcPath(nativesDirectory),
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    game_directory: toMcPath(preparation.gameDirectory),
    classpath: classpathEntries.map(toMcPath).join(delimiter),
    library_directory: toMcPath(libraryDirectory),
    classpath_separator: delimiter,
    version_name: model.id,
    auth_player_name: account.name || 'Player',
    auth_uuid: uuid,
    auth_access_token: accessToken,
    auth_session: accessToken,
    user_type: userType,
    version_type: preparation.versionType ?? (model.type || 'release'),
    user_properties: '{}',
    clientid: LAUNCH_CLIENT_ID,
    auth_xuid: '',
    resolution_width: resolution ? String(resolution.width) : '',
    resolution_height: resolution ? String(resolution.height) : '',
    assets_root: toMcPath(join(preparation.gameRoot, 'assets')),
    assets_index_name: model.assets.id,
  }

  const jvm = preparation.jvm
  if (!jvm) throw new Error('buildLaunchCommand requires a resolved JVM plan')

  const command: string[] = [preparation.javaPath]
  const jvmArgs = resolveLaunchArguments(model.arguments.jvm, platform, features).map((argument) =>
    formatArgument(argument, values),
  )
  for (let index = 0; index < jvmArgs.length; index += 1) {
    if (!jvmArgs[index].startsWith('-DignoreList=')) continue
    const baseJar = model.clientJar.replace(/\\/g, '/').split('/').pop()
    if (baseJar && !jvmArgs[index].slice('-DignoreList='.length).split(',').includes(baseJar)) {
      jvmArgs[index] = `${jvmArgs[index]},${baseJar}`
    }
  }
  const merged = mergeJvmArgumentLayers(
    [
      { args: jvm.args, source: 'plan' },
      { args: jvmArgs, source: 'version-json' },
    ],
    { keepHighPriorityCollector: true, dropLowXms: true },
  )
  for (const dropped of merged.droppedArgs) {
    preparation.logger?.debug('jvm.arg-dropped', {
      argument: dropped.argument,
      source: dropped.source,
    })
  }
  command.push(...merged.args)
  if (!merged.args.some((argument) => argument.startsWith('-DlibraryDirectory='))) {
    command.push(`-DlibraryDirectory=${toMcPath(libraryDirectory)}`)
  }
  if (!hasClasspathArgument(merged.args)) {
    command.push('-cp', String(values.classpath))
  }
  const logging = loggingArgument(model, preparation.gameRoot)
  if (logging) command.push(logging)

  command.push(model.mainClass)

  const gameArgs = resolveLaunchArguments(model.arguments.game, platform, features).map((argument) =>
    formatArgument(argument, values),
  )
  command.push(...gameArgs)

  const quickPlay = supportsQuickPlay(model.minecraftVersion)
  if (preparation.server?.host) {
    if (quickPlay) {
      command.push('--quickPlayMultiplayer', `${preparation.server.host}:${preparation.server.port ?? 25565}`)
    } else {
      command.push('--server', preparation.server.host)
      if (preparation.server.port) command.push('--port', String(preparation.server.port))
    }
  } else if (preparation.world && quickPlay) {
    command.push('--quickPlaySingleplayer', preparation.world)
  }

  // Test hook for the local renderer: open a world without clicking through
  // the title screen. It is inert in normal launches.
  const quickWorld = process.env.BAMBOO_QUICK_PLAY_WORLD
  if (quickWorld && quickPlay) command.push('--quickPlaySingleplayer', quickWorld)
  if (preparation.demo && !command.includes('--demo')) command.push('--demo')
  if (preparation.extraGameArgs && preparation.extraGameArgs.length > 0) {
    command.push(...preparation.extraGameArgs.filter(Boolean))
  }

  return { command, values, features, classpathEntries, quickPlay }
}

export function redactCommand(command: readonly string[]): string[] {
  const redacted = [...command]
  for (let index = 0; index < redacted.length; index += 1) {
    const current = redacted[index].toLowerCase()
    if ((current === '--accesstoken' || current === '--session') && index + 1 < redacted.length) {
      redacted[index + 1] = '****'
    } else if (current.startsWith('--accesstoken=') || current.startsWith('--session=')) {
      redacted[index] = `${redacted[index].split('=')[0]}=****`
    } else if (/token=/.test(current)) {
      redacted[index] = redacted[index].replace(/=.*$/, '=****')
    }
  }
  return redacted
}

export function quoteArgument(argument: string): string {
  if (argument === '') return '""'
  if (!/[\s"&|<>^()%!]/.test(argument)) return argument
  const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  return `"${escaped}"`
}

export function formatCommandLine(command: readonly string[]): string {
  return command.map(quoteArgument).join(' ')
}
