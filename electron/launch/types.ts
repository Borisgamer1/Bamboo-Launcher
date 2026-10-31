import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { Logger } from '../logger'
import type { FeatureSet, PlatformInfo } from '../version/rules'
import type { ResolvedVersionModel } from '../version/resolve'
import type { InstanceFile } from '../schemas'
import type { JvmPlan, JvmPresetSelection } from './jvm'

export interface BeforeLaunchContext {
  instanceId: string
  directory: string
  file: InstanceFile
}

export interface LaunchInstanceHooks {
  beforeLaunch?: (context: BeforeLaunchContext) => void | Promise<void>
}

export interface LaunchAccount {
  name: string
  uuid: string
  accessToken?: string
  type?: string
}

export interface LaunchPreparation {
  gameRoot: string
  versionId: string
  gameDirectory: string
  account: LaunchAccount
  model?: ResolvedVersionModel
  javaPath: string
  javaMajorVersion?: number
  loader?: string
  versionType?: string
  minMemoryMb?: number
  maxMemoryMb?: number
  memoryMode?: 'auto' | 'explicit'
  jvmPreset?: JvmPresetSelection
  extraJvmArgs?: string[]
  jvm: JvmPlan
  extraGameArgs?: string[]
  demo?: boolean
  resolution?: { width: number; height: number }
  server?: { host: string; port?: number }
  world?: string
  features?: FeatureSet
  platform?: PlatformInfo
  nativesDirectory?: string
  extractNatives?: boolean
  linkLegacyAssets?: boolean
  logger?: Logger
}

export interface NativesResult {
  directory: string
  extracted: number
  skipped: number
  files: number
  cacheHit: boolean
  lockWaitMs: number
}

export interface LegacyAssetsResult {
  directory?: string
  candidates: number
  linked: number
  skipped: number
  missing: number
}

export interface PrecheckResult {
  ok: boolean
  clientJar: boolean
  libraries: number
  librariesMissing: string[]
  natives: number
  nativesMissing: string[]
  assetIndex: boolean
  legacyAssetsReady: boolean
}

export interface LaunchPlan {
  versionId: string
  model: ResolvedVersionModel
  javaPath: string
  javaMajorVersion?: number
  gameDirectory: string
  command: string[]
  displayCommand: string[]
  natives: NativesResult
  legacyAssets: LegacyAssetsResult
  precheck: PrecheckResult
  warnings: string[]
  jvm: JvmPlan
}

export interface LaunchExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  crashReport?: string
  error?: string
}

export type LaunchEvent =
  | { type: 'status'; message: string }
  | { type: 'log'; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'ready' }
  | { type: 'crash-report'; path: string }
  | ({ type: 'exit' } & LaunchExitInfo)

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface LaunchProcessOptions {
  plan: LaunchPlan
  onEvent?: (event: LaunchEvent) => void
  spawnImpl?: SpawnLike
  killImpl?: (pid: number) => Promise<void> | void
  logger?: Logger
  env?: NodeJS.ProcessEnv
  detached?: boolean
  resolveJavaw?: boolean
  platform?: NodeJS.Platform
}

export interface LaunchHandle {
  pid: number
  plan: LaunchPlan
  exit: Promise<LaunchExitInfo>
  kill(): Promise<void>
  readonly killed: boolean
  readonly stderrLines: string[]
}
