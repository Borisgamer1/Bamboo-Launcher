import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile } from '../atomic'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { type AssetIndexInfo, type ResolvedAssets, resolveAssets } from './assets'
import { type LibraryModel, type RawLibrary, resolveLibraries } from './libraries'
import {
  type FeatureSet,
  type LaunchArgument,
  type PlatformInfo,
  currentPlatform,
} from './rules'

export type VersionResolveErrorCode =
  | 'missing-version'
  | 'invalid-version'
  | 'circular-inheritance'
  | 'inherit-depth'
  | 'missing-main-class'

export class VersionResolveError extends Error {
  readonly code: VersionResolveErrorCode
  readonly versionId: string

  constructor(code: VersionResolveErrorCode, versionId: string, message: string) {
    super(message)
    this.name = 'VersionResolveError'
    this.code = code
    this.versionId = versionId
  }
}

export interface RawDownload {
  sha1?: string
  size?: number
  url?: string
}

export interface RawVersionJson {
  id?: string
  inheritsFrom?: string
  mainClass?: string
  type?: string
  time?: string
  releaseTime?: string
  minimumLauncherVersion?: number
  assets?: string
  assetIndex?: AssetIndexInfo
  downloads?: Record<string, RawDownload | undefined>
  javaVersion?: { component?: string; majorVersion?: number }
  compatibleJavaMajors?: number[]
  arguments?: { game?: LaunchArgument[]; jvm?: LaunchArgument[] }
  minecraftArguments?: string
  libraries?: RawLibrary[]
  logging?: unknown
  jar?: string
  clientVersion?: string
  _minecraftVersion?: string
}

export interface ResolvedArguments {
  game: LaunchArgument[]
  jvm: LaunchArgument[]
}

export interface ResolvedVersionModel {
  id: string
  mainClass: string
  type: string
  time: string
  releaseTime: string
  minimumLauncherVersion: number
  chain: string[]
  minecraftVersion: string
  jarVersion: string
  clientJar: string
  libraries: LibraryModel[]
  natives: LibraryModel[]
  classpath: string[]
  nativeDirectory: string
  assets: ResolvedAssets
  assetIndex?: AssetIndexInfo
  javaVersion: { component?: string; majorVersion?: number }
  compatibleJavaMajors?: number[]
  arguments: ResolvedArguments
  downloads: Record<string, RawDownload>
  logging?: unknown
  skippedLibraries: string[]
}

export interface LoadChainOptions {
  maxDepth?: number
  logger?: Logger
}

export async function loadVersionChain(
  gameRoot: string,
  versionId: string,
  options: LoadChainOptions = {},
): Promise<RawVersionJson[]> {
  const maxDepth = options.maxDepth ?? 8
  const chain: RawVersionJson[] = []
  const ids: string[] = []
  let current: string | undefined = versionId

  while (current) {
    if (ids.includes(current)) {
      throw new VersionResolveError(
        'circular-inheritance',
        versionId,
        `Circular inheritsFrom chain: ${[...ids, current].join(' -> ')}`,
      )
    }
    if (ids.length >= maxDepth) {
      throw new VersionResolveError(
        'inherit-depth',
        versionId,
        `inheritsFrom chain exceeds ${maxDepth} entries: ${[...ids, current].join(' -> ')}`,
      )
    }
    ids.push(current)
    const file = join(gameRoot, 'versions', current, `${current}.json`)
    const json = await readJsonFile<unknown>(file, options.logger)
    if (json === undefined) {
      throw new VersionResolveError('missing-version', versionId, `Version JSON not found: ${file}`)
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new VersionResolveError('invalid-version', versionId, `Version JSON is not an object: ${file}`)
    }
    const versionJson = json as RawVersionJson
    chain.push(versionJson)
    current = typeof versionJson.inheritsFrom === 'string' && versionJson.inheritsFrom.length > 0
      ? versionJson.inheritsFrom
      : undefined
  }

  return chain
}

const LEGACY_JVM_ARGUMENTS: LaunchArgument[] = [
  {
    rules: [{ action: 'allow', os: { name: 'windows' } }],
    value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump',
  },
  {
    rules: [{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }],
    value: ['-Dos.name=Windows 10', '-Dos.version=10.0'],
  },
  '-Djava.library.path=${natives_directory}',
  '-Dminecraft.launcher.brand=${launcher_name}',
  '-Dminecraft.launcher.version=${launcher_version}',
  '-cp',
  '${classpath}',
]

function normalizeArguments(raw: RawVersionJson): { args: ResolvedArguments; replace: boolean } {
  if (!raw.arguments && typeof raw.minecraftArguments === 'string') {
    return {
      args: { game: raw.minecraftArguments.split(' ').filter(Boolean), jvm: [...LEGACY_JVM_ARGUMENTS] },
      replace: true,
    }
  }
  return {
    args: { game: [...(raw.arguments?.game ?? [])], jvm: [...(raw.arguments?.jvm ?? [])] },
    replace: false,
  }
}

export interface ResolveVersionOptions {
  platform?: PlatformInfo
  features?: FeatureSet
  maxDepth?: number
  logger?: Logger
}

export async function resolveVersionModel(
  gameRoot: string,
  versionId: string,
  options: ResolveVersionOptions = {},
): Promise<ResolvedVersionModel> {
  const logger = options.logger
  const platform = options.platform ?? currentPlatform()
  const features = options.features ?? {}
  const chain = await loadVersionChain(gameRoot, versionId, { maxDepth: options.maxDepth, logger })

  let mainClass = ''
  let type = ''
  let time = ''
  let releaseTime = ''
  let minimumLauncherVersion = 0
  let assetsField = 'legacy'
  let assetIndex: AssetIndexInfo | undefined
  let javaVersion: { component?: string; majorVersion?: number } = { component: 'jre-legacy', majorVersion: 8 }
  let compatibleJavaMajors: number[] | undefined
  let jar: string | undefined
  let logging: unknown
  const argumentsMerged: ResolvedArguments = { game: [], jvm: [] }
  const downloads: Record<string, RawDownload> = {}
  const rawLibraries: RawLibrary[] = []

  for (const raw of [...chain].reverse()) {
    if (raw.mainClass) mainClass = raw.mainClass
    if (raw.type) type = raw.type
    if (raw.releaseTime) releaseTime = raw.releaseTime
    if (raw.time) time = raw.time
    if (typeof raw.minimumLauncherVersion === 'number') {
      minimumLauncherVersion = Math.max(minimumLauncherVersion, raw.minimumLauncherVersion)
    }
    if (raw.assets) assetsField = raw.assets
    if (raw.assetIndex) assetIndex = raw.assetIndex
    if (raw.javaVersion) javaVersion = raw.javaVersion
    if (raw.compatibleJavaMajors) compatibleJavaMajors = raw.compatibleJavaMajors
    if (raw.jar) jar = raw.jar
    if (raw.logging) logging = raw.logging
    if (raw.libraries) rawLibraries.push(...raw.libraries)
    if (raw.downloads) {
      for (const [key, download] of Object.entries(raw.downloads)) {
        if (download) downloads[key] = download
      }
    }

    const normalized = normalizeArguments(raw)
    if (normalized.replace) {
      argumentsMerged.game = [...normalized.args.game]
      argumentsMerged.jvm = [...normalized.args.jvm]
    } else {
      argumentsMerged.game.push(...normalized.args.game)
      argumentsMerged.jvm.push(...normalized.args.jvm)
    }
  }

  if (!mainClass) {
    throw new VersionResolveError('missing-main-class', versionId, `Version ${versionId} has no mainClass`)
  }

  const base = chain[chain.length - 1]
  const minecraftVersion = base.clientVersion ?? base._minecraftVersion ?? base.id ?? versionId
  const jarVersion = jar ?? minecraftVersion
  const clientJar = join(gameRoot, 'versions', jarVersion, `${jarVersion}.jar`)
  const resolvedLibraries = resolveLibraries(rawLibraries, platform, features, gameRoot, logger)
  const classpath = [...resolvedLibraries.libraries.map((library) => library.absolutePath), clientJar]

  const indexId = assetIndex?.id ?? assetsField
  const assets = await resolveAssets({
    gameRoot,
    indexId,
    assetsField,
    indexInfo: assetIndex,
    logger,
  })

  const model: ResolvedVersionModel = {
    id: versionId,
    mainClass,
    type,
    time,
    releaseTime,
    minimumLauncherVersion,
    chain: chain.map((raw, index) => raw.id ?? (index === 0 ? versionId : 'unknown')),
    minecraftVersion,
    jarVersion,
    clientJar,
    libraries: resolvedLibraries.libraries,
    natives: resolvedLibraries.natives,
    classpath,
    nativeDirectory: join(gameRoot, 'versions', versionId, `${versionId}-natives`),
    assets,
    javaVersion,
    arguments: argumentsMerged,
    downloads,
    skippedLibraries: resolvedLibraries.skipped,
  }
  if (compatibleJavaMajors) model.compatibleJavaMajors = compatibleJavaMajors
  if (assetIndex) model.assetIndex = assetIndex
  if (logging !== undefined) model.logging = logging
  return model
}

export async function listInstalledVersions(gameRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(gameRoot, 'versions'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (error) {
    getDefaultLogger().child('version').debug('installed versions directory unreadable', { gameRoot, error: describeError(error) })
    return []
  }
}
