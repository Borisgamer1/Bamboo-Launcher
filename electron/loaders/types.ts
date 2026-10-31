import type { FetchLike, RetryOptions } from '../download/http'
import type { InstallReport } from '../download/types'
import type { Logger } from '../logger'
import type { TelemetryService } from '../telemetry'
import type { ResolvedVersionModel } from '../version/resolve'

export type LoaderKind = 'fabric' | 'quilt' | 'neoforge' | 'forge' | 'forge-legacy' | 'optifine'

export const LOADER_KINDS: readonly LoaderKind[] = [
  'fabric',
  'quilt',
  'neoforge',
  'forge',
  'forge-legacy',
  'optifine',
]

export type LoaderSide = 'client' | 'server'

export interface LoaderVersionEntry {
  version: string
  stable?: boolean
  gameVersion?: string
  type?: string
  patch?: string
  filename?: string
  installerUrl?: string
}

export interface LoaderVersionList {
  loader: LoaderKind
  minecraftVersion?: string
  versions: LoaderVersionEntry[]
  source: 'network' | 'cache' | 'mirror'
}

export interface LoaderJavaRuntime {
  path: string
  majorVersion?: number
}

export type LoaderJavaOption =
  | LoaderJavaRuntime
  | LoaderJavaRuntime[]
  | (() =>
      | LoaderJavaRuntime
      | LoaderJavaRuntime[]
      | Promise<LoaderJavaRuntime | LoaderJavaRuntime[]>)

export interface LoaderInstallOptions {
  gameRoot: string
  minecraftVersion: string
  loaderVersion?: string
  versionId?: string
  side?: LoaderSide
  installBaseVersion?: boolean
  installAssets?: boolean
  fetchImpl?: FetchLike
  retry?: RetryOptions
  signal?: AbortSignal
  logger?: Logger
  cacheDir?: string
  mavenBase?: string
  metaBase?: string
  optifineMirror?: string
  installerUrl?: string
  java?: LoaderJavaOption
  javaPath?: string
  useArgFile?: boolean
  processorRunner?: (
    command: { executable: string; args: string[]; cwd?: string },
    context: { signal?: AbortSignal },
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>
  onProgress?: (progress: LoaderProgress) => void
  onEvent?: (event: LoaderEvent) => void
  telemetry?: TelemetryService
}

export interface LoaderProgress {
  phase: 'metadata' | 'base' | 'installer' | 'profile' | 'inputs' | 'processors' | 'done'
  message: string
  loader: LoaderKind
  percent?: number
}

export type LoaderEvent =
  | { type: 'status'; message: string }
  | { type: 'processor-start'; jar: string; index: number; total: number }
  | { type: 'processor-log'; jar: string; line: string; stream: 'stdout' | 'stderr' }
  | { type: 'processor-retry'; jar: string; strategy: number; error: string }

export interface LoaderInstallResult {
  loader: LoaderKind
  versionId: string
  minecraftVersion: string
  loaderVersion: string
  model: ResolvedVersionModel
  alreadyInstalled: boolean
  filesReport?: InstallReport
  downloadedBytes: number
  skippedFiles: number
  processorsRun: number
  processorOutputs: number
  installerPath?: string
  warnings: string[]
}

export interface PostProcessor {
  jar: string
  classpath: string[]
  args: string[]
  outputs?: Record<string, string>
  sides?: Array<'client' | 'server'>
}

export interface InstallProfile {
  spec?: number
  profile: string
  version: string
  json: string
  path: string
  minecraft: string
  data?: Record<string, { client: string; server: string }>
  processors?: PostProcessor[]
  libraries?: Array<{ name: string; [key: string]: unknown }>
  versionInfo?: Record<string, unknown>
}

export const POST_PROCESS_BATCH_PROTOCOL = 'isolated-classloader-v1'

export interface ProcessorOutput {
  path: string
  checksum?: { algorithm: 'sha1'; value: string }
  validator: 'file' | 'zip' | 'json'
}

export interface ProcessorOutputIssue {
  processor: string
  file: string
  expectedChecksum?: string
  actualChecksum?: string
  reason: 'missing' | 'size' | 'checksum' | 'corrupt'
}

export interface LoaderInstallIssue {
  versionId: string
  loader?: LoaderKind
  clientJar?: string
  missingLibraries: string[]
  corruptLibraries: string[]
  missingAssetIndex?: string
  missingAssets: number
  profile?: InstallProfile
  processorIssues: ProcessorOutputIssue[]
  details: string[]
}

export interface LoaderRepairResult {
  versionId: string
  issueBefore: LoaderInstallIssue
  issueAfter?: LoaderInstallIssue
  filesReport?: InstallReport
  processorsRun: number
  repaired: string[]
  downloadedBytes: number
}

export interface ResolvedLoaderInstall {
  loader: LoaderKind
  versionId: string
  minecraftVersion: string
  loaderVersion: string
}

export interface LoaderInstallMarker {
  loader: LoaderKind
  loaderVersion: string
  minecraftVersion: string
  versionId: string
  installedAt: string
  installerPath?: string
  installerSha1?: string
  profilePath?: string
  processorOutputs?: string[]
  mavenBase?: string
  metaBase?: string
  optifineMirror?: string
  optifineEdition?: string
}
