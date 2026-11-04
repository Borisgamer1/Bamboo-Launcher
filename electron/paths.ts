import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { readTextFile, writeTextFileAtomic } from './atomic'
import { describeError, getDefaultLogger, type Logger } from './logger'

export function legacyGameRoot(): string {
  const fromEnv = process.env.BAMBOO_GAME_ROOT
  if (fromEnv) return fromEnv
  return process.platform === 'win32' ? 'C:\\BambooLaufwerk' : join(homedir(), 'BambooLaufwerk')
}

export interface CorePaths {
  appData: string
  gameRoot: string
  rootPointer: string
  logsDir: string
  backupsDir: string
  settingsFile: string
  accountsFile: string
  tokensFile: string
  instancesFile: string
  statisticsFile: string
  javaFile: string
  cacheDir: string
  metaFile: string
}

export type RootSource = 'pointer' | 'legacy' | 'default' | 'recreated' | 'fallback'

export interface ResolvedPaths {
  paths: CorePaths
  source: RootSource
  recreated: boolean
}

export interface ResolvePathsOptions {
  appData: string
  legacyGameRoot?: string
  logger: Logger
}

function buildPaths(appData: string, gameRoot: string): CorePaths {
  return {
    appData,
    gameRoot,
    rootPointer: join(appData, 'root'),
    logsDir: join(appData, 'logs'),
    backupsDir: join(appData, 'backups'),
    settingsFile: join(appData, 'settings.json'),
    accountsFile: join(appData, 'accounts.json'),
    tokensFile: join(appData, 'accounts.tokens.json'),
    instancesFile: join(appData, 'instances.json'),
    statisticsFile: join(appData, 'statistics.json'),
    javaFile: join(appData, 'java.json'),
    cacheDir: join(appData, 'cache'),
    metaFile: join(appData, 'migration.json'),
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isDirectory()
  } catch (error) {
    // A missing path is an expected probe result during root resolution.
    getDefaultLogger().child('paths').debug('directory probe failed; treated as absent', {
      target,
      error: describeError(error),
    })
    return false
  }
}

async function ensureDirectory(target: string): Promise<boolean> {
  try {
    await mkdir(target, { recursive: true })
    return true
  } catch (error) {
    // The caller reports an unusable root; the failed mkdir is recorded here.
    getDefaultLogger().child('paths').debug('directory could not be created', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function resolveCorePaths(options: ResolvePathsOptions): Promise<ResolvedPaths> {
  const appData = resolve(options.appData)
  await ensureDirectory(appData)
  await ensureDirectory(join(appData, 'logs'))
  await ensureDirectory(join(appData, 'backups'))

  const pointerFile = join(appData, 'root')
  const pointerRaw = (await readTextFile(pointerFile))?.trim() ?? ''
  const pointer = pointerRaw.length > 0 && isAbsolute(pointerRaw) ? resolve(pointerRaw) : ''

  if (pointer) {
    if (await isDirectory(pointer)) {
      return { paths: buildPaths(appData, pointer), source: 'pointer', recreated: false }
    }
    const recreated = await ensureDirectory(pointer)
    if (recreated) {
      options.logger.warn('Configured game root was missing and has been recreated', { gameRoot: pointer })
      return { paths: buildPaths(appData, pointer), source: 'recreated', recreated: true }
    }
    options.logger.error('Configured game root is unusable; falling back to appData/game', { gameRoot: pointer })
  }

  const legacy = options.legacyGameRoot ? resolve(options.legacyGameRoot) : ''
  if (legacy && (await isDirectory(legacy))) {
    await writeTextFileAtomic(pointerFile, `${legacy}\n`, options.logger)
    options.logger.info('Adopted legacy game root', { gameRoot: legacy })
    return { paths: buildPaths(appData, legacy), source: 'legacy', recreated: false }
  }

  const fallbackRoot = join(appData, 'game')
  if (await ensureDirectory(fallbackRoot)) {
    await writeTextFileAtomic(pointerFile, `${fallbackRoot}\n`, options.logger)
    return { paths: buildPaths(appData, fallbackRoot), source: 'default', recreated: false }
  }

  options.logger.error('No writable game root available; launcher state stays in appData')
  return { paths: buildPaths(appData, appData), source: 'fallback', recreated: false }
}

export async function setGameRoot(paths: CorePaths, nextRoot: string, logger: Logger): Promise<CorePaths> {
  if (!isAbsolute(nextRoot)) throw new Error('Game root must be an absolute path')
  const resolved = resolve(nextRoot)
  await mkdir(resolved, { recursive: true })
  await writeTextFileAtomic(paths.rootPointer, `${resolved}\n`, logger)
  logger.info('Game root changed', { gameRoot: resolved })
  return { ...paths, gameRoot: resolved }
}
