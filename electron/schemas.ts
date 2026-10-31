import { z } from 'zod'
import { JVM_PRESET_SELECTIONS, type JvmPresetSelection } from './launch/presets'

export const TOKEN_KEYS = ['token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token'] as const

export interface Account {
  id: string
  name: string
  uuid: string
  type: string
  active: boolean
  [key: string]: unknown
}

export const AccountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().catch('').default(''),
    uuid: z.string().catch('').default(''),
    type: z.string().catch('offline').default('offline'),
    active: z.boolean().catch(false).default(false),
  })
  .catchall(z.unknown())

export interface Settings {
  currentTheme: string
  lang: string
  telemetryEnabled: boolean
  jvmPreset: JvmPresetSelection
  [key: string]: unknown
}

export const SettingsSchema = z
  .object({
    currentTheme: z.string().catch('dark').default('dark'),
    lang: z.string().catch('de').default('de'),
    telemetryEnabled: z.boolean().catch(false).default(false),
    jvmPreset: z.enum(JVM_PRESET_SELECTIONS).catch('auto').default('auto'),
  })
  .catchall(z.unknown())

export interface AccountFile {
  version: 1
  selectedAccountId: string
  accounts: Account[]
}

export const AccountFileSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  selectedAccountId: z.string().catch('').default(''),
  accounts: z.array(AccountSchema).catch([]).default([]),
})

export type InstanceLoader = 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'quilt' | 'optifine'

export const InstanceLaunchPatchSchema = z
  .object({
    javaPath: z.string().max(4096).optional(),
    javaMode: z.enum(['auto', 'pinned']).optional(),
    maxMemory: z.number().int().min(0).max(65536).optional(),
    memoryMode: z.enum(['auto', 'explicit']).optional(),
    extraJvmArgs: z.array(z.string().max(1024)).max(128).optional(),
    resolution: z
      .object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320) })
      .nullable()
      .optional(),
  })
  .strict()

export type InstanceLaunchPatch = z.infer<typeof InstanceLaunchPatchSchema>

export const LaunchInstanceRequestSchema = z.object({
  instanceId: z.string().min(1),
  server: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
})

export type LaunchInstanceRequest = z.infer<typeof LaunchInstanceRequestSchema>

export interface LauncherInstance {
  id: string
  name: string
  folderName: string
  path: string
  version: string
  /** Installed launcher profile to start, e.g. fabric-loader-0.15.11-1.20.1. */
  versionId?: string
  loader: InstanceLoader
  loaderVersion: string
  javaPath: string
  minMemory: number
  maxMemory: number
  managed?: boolean
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export const InstanceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().catch('Unnamed').default('Unnamed'),
    folderName: z.string().catch('').default(''),
    path: z.string().catch('').default(''),
    version: z.string().catch('').default(''),
    versionId: z.string().catch('').default(''),
    loader: z.string().catch('vanilla').default('vanilla'),
    loaderVersion: z.string().catch('').default(''),
    javaPath: z.string().catch('').default(''),
    minMemory: z.number().catch(0).default(0),
    maxMemory: z.number().catch(0).default(0),
    managed: z.boolean().catch(false).default(false),
    createdAt: z.number().catch(0).default(0),
    updatedAt: z.number().catch(0).default(0),
  })
  .catchall(z.unknown())

export interface InstanceIndex {
  version: 1
  selectedInstance: string
  instances: LauncherInstance[]
}

export const InstanceIndexSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  selectedInstance: z.string().catch('').default(''),
  instances: z.array(InstanceSchema).catch([]).default([]),
})

export interface InstanceFile {
  id: string
  name: string
  /** Minecraft version, never a loader profile id. */
  version: string
  /** Installed launcher profile to start; defaults to `version` for vanilla. */
  versionId?: string
  loader: InstanceLoader
  loaderVersion: string
  javaPath: string
  javaMode?: 'auto' | 'pinned'
  resolvedJava?: ResolvedJava
  minMemory: number
  maxMemory: number
  memoryMode?: 'auto' | 'explicit'
  jvmPreset?: JvmPresetSelection
  extraJvmArgs?: string[]
  resolution?: { width: number; height: number }
  icon: string
  group: string
  lastPlayedAt: number
  playTimeMs: number
  upstream?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export const ResolvedJavaSchema = z.object({
  major: z.number().int().positive(),
  relativePath: z.string().min(1),
  at: z.number().catch(0).default(0),
})

export type ResolvedJava = z.infer<typeof ResolvedJavaSchema>

export const InstanceFileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().catch('Unnamed').default('Unnamed'),
    version: z.string().catch('').default(''),
    versionId: z.string().catch('').default(''),
    loader: z.string().catch('vanilla').default('vanilla'),
    loaderVersion: z.string().catch('').default(''),
    javaPath: z.string().catch('').default(''),
    javaMode: z.enum(['auto', 'pinned']).catch('auto').default('auto'),
    resolvedJava: ResolvedJavaSchema.optional().catch(undefined),
    minMemory: z.number().catch(0).default(0),
    maxMemory: z.number().catch(0).default(0),
    memoryMode: z.enum(['auto', 'explicit']).catch('auto').default('auto'),
    jvmPreset: z.enum(JVM_PRESET_SELECTIONS).optional().catch(undefined),
    extraJvmArgs: z.array(z.string()).optional().catch(undefined),
    resolution: z
      .object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320) })
      .optional()
      .catch(undefined),
    icon: z.string().catch('').default(''),
    group: z.string().catch('').default(''),
    lastPlayedAt: z.number().catch(0).default(0),
    playTimeMs: z.number().catch(0).default(0),
    upstream: z.record(z.string(), z.unknown()).optional().catch(undefined),
    createdAt: z.number().catch(0).default(0),
    updatedAt: z.number().catch(0).default(0),
  })
  .catchall(z.unknown())

export const INSTANCE_OPERATIONS = ['install', 'launch', 'duplicate', 'rename', 'delete', 'move', 'fix'] as const

export const InstanceLockSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  owner: z.string().catch('').default(''),
  pid: z.number().int().catch(0).default(0),
  operation: z.enum(INSTANCE_OPERATIONS).catch('launch').default('launch'),
  instanceId: z.string().catch('').default(''),
  createdAt: z.number().catch(0).default(0),
  expiresAt: z.number().catch(0).default(0),
})

export type InstanceLock = z.infer<typeof InstanceLockSchema>

export const JAVA_ARCHITECTURES = ['x64', 'x86', 'arm64'] as const

export const JavaRecordSchema = z
  .object({
    path: z.string().min(1),
    version: z.string().catch('').default(''),
    majorVersion: z.number().int().catch(0).default(0),
    architecture: z.enum(JAVA_ARCHITECTURES).catch('x64').default('x64'),
    vendor: z.string().catch('').default(''),
    source: z.enum(['scan', 'mojang', 'manual']).catch('manual').default('manual'),
    fingerprint: z.string().optional().catch(undefined),
    valid: z.boolean().catch(true).default(true),
    addedAt: z.number().catch(0).default(0),
    validatedAt: z.number().catch(0).default(0),
  })
  .catchall(z.unknown())

export type JavaRecord = z.infer<typeof JavaRecordSchema> & { fingerprint?: string }

export interface JavaIndex {
  version: 1
  records: JavaRecord[]
}

export const JavaIndexSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  records: z.array(JavaRecordSchema).catch([]).default([]),
})

export interface MigrationMeta {
  schemaVersion: 1
  migrationVersion: number
  migratedAt: number
  counts: { accounts: number; instances: number }
}

export const MigrationMetaSchema = z.object({
  schemaVersion: z.literal(1).catch(1).default(1),
  migrationVersion: z.number().catch(0).default(0),
  migratedAt: z.number().catch(0).default(0),
  counts: z
    .object({
      accounts: z.number().catch(0).default(0),
      instances: z.number().catch(0).default(0),
    })
    .catch({ accounts: 0, instances: 0 })
    .default({ accounts: 0, instances: 0 }),
})

export const CURRENT_MIGRATION_VERSION = 1

export function parseWithDefaults<T>(schema: z.ZodTypeAny, value: unknown, fallback: T, onError?: (error: string) => void): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data as T
  onError?.(parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '))
  return fallback
}

export function stripTokenFields<T extends Record<string, unknown>>(value: T): { rest: T; tokens: { accessToken?: string; refreshToken?: string } } {
  const rest: Record<string, unknown> = { ...value }
  const tokens: { accessToken?: string; refreshToken?: string } = {}
  const access = rest.accessToken ?? rest.access_token ?? rest.token
  const refresh = rest.refreshToken ?? rest.refresh_token
  if (typeof access === 'string' && access.length > 0) tokens.accessToken = access
  if (typeof refresh === 'string' && refresh.length > 0) tokens.refreshToken = refresh
  for (const key of TOKEN_KEYS) delete rest[key]
  return { rest: rest as T, tokens }
}
