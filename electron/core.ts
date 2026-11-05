import { join, resolve } from 'node:path'
import { ensureDir } from './atomic'
import { createFileLogger, createNullLogger, describeError, getDefaultLogger, Logger, setDefaultLogger } from './logger'
import { CorePaths, RootSource, resolveCorePaths, setGameRoot } from './paths'
import { SecretBox, TokenStore } from './token-store'
import { SettingsStore } from './settings-store'
import { AccountStore } from './account-store'
import { MicrosoftAuthService, type MicrosoftAuthStatus } from './auth/service'
import { DEFAULT_CLIENT_ID } from './auth/microsoft'
import { InstanceStore } from './instance-store'
import { InstanceManager } from './instances'
import { LoaderService } from './loaders/service'
import { installVersion } from './install/version'
import { MigrationResult, runMigrations } from './migrate'
import { LaunchHandle as LaunchTrackerHandle, LaunchStartInfo, LaunchTracker } from './launch-tracker'
import { JavaManager } from './java'
import { javaMemoRelativePath, resolveJavaMemo } from './java/memo'
import { LaunchService } from './launch'
import { reconcile } from './cosmetics/store'
import { isModernMsAccount } from './launch/args'
import { resolveJvmPreferences } from './launch/jvm'
import type {
  LaunchEvent,
  LaunchHandle as LaunchProcessHandle,
  LaunchInstanceHooks,
} from './launch/types'
import { LaunchInstanceRequestSchema, type LaunchInstanceRequest } from './schemas'
import { analyzeInstance, applyFixAction, undoFixAction } from './logs'
import type { AnalysisResult, FixResult } from './logs/types'
import { VersionResolver } from './version'
import { TelemetryService } from './telemetry'
import {
  StatisticsService,
  StatisticsStore,
  type StatisticsInstanceSummary,
  type StatisticsSummary,
} from './statistics'
import { DISTANCE_KEYS, collectInstanceGameStats, emptyDistanceStats } from './instances/worlds'
import { createSupportBundle, type SupportBundleResult } from './support-bundle'
import type { FetchLike } from './download/http'
import type { FixDeps } from './logs/types'
import { ensureBambooMod } from './cosmetics/mod'
import { readConfig, writeInstanceSync } from './cosmetics/sync'
import { ModrinthClient } from './mods/modrinth'
import { installModrinthProject } from './mods/installer'
import type { ModLoader } from './mods/types'

export interface CoreOptions {
  appDataPath: string
  legacyGameRoot?: string
  safeStorage?: SecretBox
  logger?: Logger
  onAnalysis?: (result: AnalysisResult) => void
  onSessionLost?: (status: MicrosoftAuthStatus) => void
  fetchImpl?: FetchLike
  modrinthBaseUrl?: string
  openPath?: (path: string) => Promise<string | void>
  openUrl?: (url: string) => Promise<void>
  authClientId?: string
  authPort?: number
  authTimeoutMs?: number
}

function modLoaderFor(loader: string): ModLoader | undefined {
  return loader === 'fabric' || loader === 'quilt' || loader === 'forge' || loader === 'neoforge'
    ? loader
    : undefined
}

async function resolveDependencyProject(client: ModrinthClient, query: string): Promise<string | undefined> {
  try {
    const hits = await client.search(query, { limit: 10, facets: ['project_type:mod'] })
    const needle = query.toLowerCase()
    const exact = hits.find(
      (hit) => hit.projectId.toLowerCase() === needle || hit.slug.toLowerCase() === needle,
    )
    const chosen = exact ?? hits[0]
    if (chosen?.projectId) return chosen.projectId
  } catch (error) {
    // Search failed; the exact project lookup below is the fallback.
    getDefaultLogger().child('mods').debug('dependency project search failed; trying exact lookup', { query, error: describeError(error) })
  }
  try {
    const project = await client.project(query)
    return project.id || query
  } catch (error) {
    getDefaultLogger().child('mods').debug('dependency project lookup failed', { query, error: describeError(error) })
    return undefined
  }
}

export type LaunchCoreMode = 'legacy' | 'v2'

export interface CoreStatus {
  appData: string
  gameRoot: string
  rootSource: RootSource
  tokenStoreDegraded: boolean
  schemaVersion: number
  launchCoreMode: LaunchCoreMode
  migration: MigrationResult
  accountCount: number
  instanceCount: number
  telemetryEnabled: boolean
}

const RENDERER_HIDDEN_SETTINGS = ['curseForgeApiKey'] as const

function withoutRendererHiddenSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!RENDERER_HIDDEN_SETTINGS.some((key) => key in settings)) return settings
  const copy = { ...settings }
  for (const key of RENDERER_HIDDEN_SETTINGS) delete copy[key]
  return copy
}

export interface LaunchIdentity {
  name: string
  uuid: string
  type: string
  accessToken?: string
}

export class LauncherCore {
  readonly paths: CorePaths
  readonly logger: Logger
  readonly settings: SettingsStore
  readonly accounts: AccountStore
  readonly auth: MicrosoftAuthService
  readonly instances: InstanceStore
  readonly loaders: LoaderService
  readonly instanceManager: InstanceManager
  readonly tokens: TokenStore
  readonly launches: LaunchTracker
  readonly java: JavaManager
  readonly versions: VersionResolver
  readonly launch: LaunchService
  readonly rootSource: RootSource
  readonly migration: MigrationResult
  readonly launchCoreMode: LaunchCoreMode
  readonly telemetry: TelemetryService
  readonly statistics: StatisticsService
  readonly onAnalysis?: (result: AnalysisResult) => void
  readonly fetchImpl?: FetchLike
  readonly modrinthBaseUrl?: string
  readonly openPath?: (path: string) => Promise<string | void>
  readonly openUrl?: (url: string) => Promise<void>

  private constructor(
    paths: CorePaths,
    rootSource: RootSource,
    logger: Logger,
    settings: SettingsStore,
    accounts: AccountStore,
    auth: MicrosoftAuthService,
    instances: InstanceStore,
    loaders: LoaderService,
    instanceManager: InstanceManager,
    tokens: TokenStore,
    launches: LaunchTracker,
    java: JavaManager,
    versions: VersionResolver,
    launch: LaunchService,
    migration: MigrationResult,
    launchCoreMode: LaunchCoreMode,
    telemetry: TelemetryService,
    statistics: StatisticsService,
    onAnalysis: ((result: AnalysisResult) => void) | undefined,
    fetchImpl: FetchLike | undefined,
    modrinthBaseUrl: string | undefined,
    openPath: ((path: string) => Promise<string | void>) | undefined,
    openUrl: ((url: string) => Promise<void>) | undefined,
  ) {
    this.paths = paths
    this.rootSource = rootSource
    this.logger = logger
    this.settings = settings
    this.accounts = accounts
    this.auth = auth
    this.instances = instances
    this.loaders = loaders
    this.instanceManager = instanceManager
    this.tokens = tokens
    this.launches = launches
    this.java = java
    this.versions = versions
    this.launch = launch
    this.migration = migration
    this.launchCoreMode = launchCoreMode
    this.telemetry = telemetry
    this.statistics = statistics
    this.onAnalysis = onAnalysis
    this.fetchImpl = fetchImpl
    this.modrinthBaseUrl = modrinthBaseUrl
    this.openPath = openPath
    this.openUrl = openUrl
  }

  static async create(options: CoreOptions): Promise<LauncherCore> {
    const appData = resolve(options.appDataPath)
    await ensureDir(appData)
    const logger =
      options.logger ??
      createFileLogger({
        dir: join(appData, 'logs'),
        base: { app: 'bamboo-launcher' },
      })
    setDefaultLogger(logger)

    const resolved = await resolveCorePaths({
      appData,
      legacyGameRoot: options.legacyGameRoot,
      logger: logger.child('paths'),
    })

    const tokens = new TokenStore(resolved.paths.tokensFile, options.safeStorage, logger.child('tokens'))
    const accounts = new AccountStore(resolved.paths.accountsFile, tokens, logger.child('accounts'))
    const auth = new MicrosoftAuthService({
      accounts,
      tokens,
      logger: logger.child('auth'),
      clientId: options.authClientId ?? DEFAULT_CLIENT_ID,
      ...(options.openUrl ? { openUrl: options.openUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.onSessionLost ? { onSessionLost: options.onSessionLost } : {}),
      ...(options.authPort !== undefined ? { port: options.authPort } : {}),
      ...(options.authTimeoutMs !== undefined ? { timeoutMs: options.authTimeoutMs } : {}),
    })
    const settings = new SettingsStore(resolved.paths.settingsFile, logger.child('settings'))
    const instances = new InstanceStore(resolved.paths.instancesFile, logger.child('instances'))

    await Promise.all([accounts.load(), settings.load(), instances.load(), tokens.load()])

    const migration = await runMigrations({
      paths: resolved.paths,
      settings,
      accounts,
      instances,
      logger: logger.child('migrate'),
    })

    // A hardcoded fake Microsoft account from older test builds must not survive into a build that signs in for real.
    for (const entry of await accounts.list()) {
      const legacyFake =
        entry.id === 'temporary-curseforge' || entry.provider === 'curseforge-temporary'
      if (!legacyFake) continue
      await accounts.remove(entry.id)
      logger.info('Veralteter Test-Account entfernt', { accountId: entry.id })
    }

    const settingsData = await settings.get()
    const telemetry = new TelemetryService(join(appData, 'telemetry.json'), {
      enabled: settingsData.telemetryEnabled === true,
      logger: logger.child('telemetry'),
    })
    await telemetry.load()
    if (!telemetry.enabled) await telemetry.setEnabled(false)

    const launchCoreMode: LaunchCoreMode = process.env.LAUNCH_CORE === 'v2' ? 'v2' : 'legacy'
    const statistics = new StatisticsService(
      new StatisticsStore(resolved.paths.statisticsFile, logger.child('statistics')),
      settingsData.statisticsEnabled !== false,
      logger.child('statistics'),
    )
    await statistics.load()
    const launches = new LaunchTracker(logger.child('launch'), telemetry, (session) => {
      void statistics.record(session)
    })
    const java = new JavaManager({
      file: resolved.paths.javaFile,
      gameRoot: resolved.paths.gameRoot,
      logger: logger.child('java'),
    })
    const versions = new VersionResolver({
      gameRoot: resolved.paths.gameRoot,
      cacheDir: resolved.paths.cacheDir,
      logger: logger.child('versions'),
    })
    const launch = new LaunchService({
      gameRoot: () => resolved.paths.gameRoot,
      cacheDir: resolved.paths.cacheDir,
      java,
      launches,
      logger: logger.child('launch'),
    })
    const loaders = new LoaderService({
      gameRoot: () => resolved.paths.gameRoot,
      cacheDir: resolved.paths.cacheDir,
      logger: logger.child('loaders'),
      telemetry,
      java: () =>
        java.list().then((records) =>
          records
            .filter((record) => record.valid)
            .map((record) => ({ path: record.path, majorVersion: record.majorVersion })),
        ),
    })
    const instanceManager = new InstanceManager({
      gameRoot: () => resolved.paths.gameRoot,
      store: instances,
      cacheDir: resolved.paths.cacheDir,
      logger: logger.child('instances'),
      loaderInstaller: (kind, request) => {
        if (kind === 'vanilla') return Promise.reject(new Error('vanilla is not a loader'))
        return loaders.install(kind, {
          minecraftVersion: request.minecraftVersion,
          ...(request.loaderVersion ? { loaderVersion: request.loaderVersion } : {}),
          installBaseVersion: true,
        })
      },
      baseInstaller: (versionId) =>
        installVersion(resolved.paths.gameRoot, versionId, {
          cacheDir: resolved.paths.cacheDir,
          withAssets: true,
          telemetry,
        }),
    })

    logger.info('Core ready', {
      gameRoot: resolved.paths.gameRoot,
      rootSource: resolved.source,
      tokenStoreDegraded: tokens.degraded,
      migrated: migration.migrated,
      launchCoreMode,
    })

    const core = new LauncherCore(
      resolved.paths,
      resolved.source,
      logger,
      settings,
      accounts,
      auth,
      instances,
      loaders,
      instanceManager,
      tokens,
      launches,
      java,
      versions,
      launch,
      migration,
      launchCoreMode,
      telemetry,
      statistics,
      options.onAnalysis,
      options.fetchImpl,
      options.modrinthBaseUrl,
      options.openPath,
      options.openUrl,
    )

    void core.auth.restore()
    return core
  }

  async status(): Promise<CoreStatus> {
    const [accounts, instances] = await Promise.all([this.accounts.list(), this.instances.list()])
    return {
      appData: this.paths.appData,
      gameRoot: this.paths.gameRoot,
      rootSource: this.rootSource,
      tokenStoreDegraded: this.tokens.degraded,
      schemaVersion: 1,
      launchCoreMode: this.launchCoreMode,
      migration: this.migration,
      accountCount: accounts.length,
      instanceCount: instances.length,
      telemetryEnabled: this.telemetry.enabled,
    }
  }

  /** Tokens live in the secret store and the CurseForge key stays in main; the UI blob contains no credentials. */
  async getSettingsForRenderer(): Promise<Record<string, unknown>> {
    const [settings, accounts] = await Promise.all([this.settings.get(), this.accounts.list()])
    return { ...withoutRendererHiddenSettings(settings), accounts }
  }

  async saveSettingsFromRenderer(patch: unknown): Promise<boolean> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('Settings payload must be an object')
    }
    const payload = withoutRendererHiddenSettings({ ...(patch as Record<string, unknown>) })
    delete payload.accounts
    const telemetryRequested = 'telemetryEnabled' in payload ? payload.telemetryEnabled === true : undefined
    const saved = await this.settings.save(payload)
    if (telemetryRequested !== undefined) await this.telemetry.setEnabled(telemetryRequested)
    if ('statisticsEnabled' in payload) this.statistics.setEnabled(saved.statisticsEnabled !== false)
    return true
  }

  /**
   * One source for the Statistics tab: playtime comes from the deletion-safe
   * ledger, world object counters are read from the folders that exist now.
   */
  async getStatisticsSummary(): Promise<StatisticsSummary> {
    const [ledger, instances] = await Promise.all([
      this.statistics.snapshot(),
      this.instanceManager.list(),
    ])

    // Playtime has exactly one owner: the deletion-safe ledger. The instance
    // profile's own playTimeMs is legacy display data and must not feed this
    // aggregate, otherwise a deleted or stale instance changes the total.
    const sessionsByInstance = new Map<string, { playTimeMs: number; sessions: number }>()
    for (const session of ledger.sessions) {
      const current = sessionsByInstance.get(session.instanceId) ?? { playTimeMs: 0, sessions: 0 }
      current.playTimeMs += session.durationMs
      current.sessions += 1
      sessionsByInstance.set(session.instanceId, current)
    }

    const perInstance: StatisticsInstanceSummary[] = instances.map(({ instance, directory }) => {
      const stats = collectInstanceGameStats(join(directory, 'saves'))
      const recorded = sessionsByInstance.get(instance.id)
      return {
        id: instance.id,
        name: instance.name,
        version: instance.version,
        loader: instance.loader,
        playTimeMs: recorded?.playTimeMs ?? 0,
        sessions: recorded?.sessions ?? 0,
        ...stats,
      }
    })
    perInstance.sort((left, right) => left.name.localeCompare(right.name))

    const distance = emptyDistanceStats()
    let blocksMined = 0
    let blocksPlaced = 0
    let mobsKilled = 0
    let deaths = 0
    let jumps = 0
    let worlds = 0
    for (const entry of perInstance) {
      for (const key of DISTANCE_KEYS) distance[key] += entry.distance[key]
      blocksMined += entry.blocksMined
      blocksPlaced += entry.blocksPlaced
      mobsKilled += entry.mobsKilled
      deaths += entry.deaths
      jumps += entry.jumps
      worlds += entry.worlds
    }

    return {
      enabled: this.statistics.enabled,
      playTimeMs: ledger.totals.playTimeMs,
      sessions: ledger.totals.sessions,
      firstPlayedAt: ledger.totals.firstPlayedAt,
      lastPlayedAt: ledger.totals.lastPlayedAt,
      distance,
      blocksMined,
      blocksPlaced,
      mobsKilled,
      deaths,
      jumps,
      instances: perInstance.length,
      worlds,
      perInstance,
      generatedAt: Date.now(),
    }
  }

  async createSupportBundle(destination: string): Promise<SupportBundleResult> {
    return this.telemetry.measure('support', async () =>
      createSupportBundle({
        appData: this.paths.appData,
        gameRoot: this.paths.gameRoot,
        destination,
        telemetry: await this.telemetry.snapshot(),
        logger: this.logger.child('support'),
      }),
    )
  }

  async getPlayerIdentity(): Promise<{ uuid: string | null; username: string | null; type: string } | null> {
    const account = await this.accounts.getSelected()
    if (!account) return null
    return {
      uuid: typeof account.uuid === 'string' && account.uuid.length > 0 ? account.uuid : null,
      username: typeof account.name === 'string' && account.name.length > 0 ? account.name : null,
      type: typeof account.type === 'string' ? account.type : 'offline',
    }
  }

  beginLaunch(info: LaunchStartInfo): LaunchTrackerHandle {
    return this.launches.begin(info)
  }

  async getLaunchIdentity(accountId?: string): Promise<LaunchIdentity | undefined> {
    const account = accountId ? await this.accounts.get(accountId) : await this.accounts.getSelected()
    if (!account) return undefined
    const accessToken = await this.auth.accessTokenFor(account)
    if (isModernMsAccount(account.type) && !accessToken) {
      throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich im Konto-Tab neu an.')
    }
    return {
      name: String(account.name ?? 'Player'),
      uuid: String(account.uuid ?? ''),
      type: String(account.type ?? 'offline'),
      accessToken,
    }
  }

  async launchInstance(
    request: LaunchInstanceRequest,
    onEvent?: (event: LaunchEvent) => void,
    hooks?: LaunchInstanceHooks,
  ): Promise<LaunchProcessHandle & { launchId?: string }> {
    const parsed = LaunchInstanceRequestSchema.parse(request)
    const found = await this.instanceManager.get(parsed.instanceId)
    const file = await this.instanceManager.readFile(parsed.instanceId)
    await hooks?.beforeLaunch?.({ instanceId: parsed.instanceId, directory: found.directory, file })
    // Cosmetics are account-wide: a freshly created instance gets its mirror here.
    try {
      await reconcile(
        join(this.paths.appData, 'cosmetics'),
        (await this.instanceManager.list()).map((entry) => entry.directory),
      )
    } catch {
      // Cosmetics must never block a start.
    }
    try {
      const mod = await ensureBambooMod(found.directory, file.version, file.loader, {
        cacheDir: this.paths.cacheDir,
      })
      // The build owns the pair; the mod only reads bamboo/sync.json.
      await writeInstanceSync(found.directory, await readConfig())
      this.logger.child('cosmetics').debug('bamboo mod state', { result: mod, instance: file.name })
    } catch {
      // A missing mod copy must never block a start either.
    }
    const settings = await this.settings.get()
    const account = await this.getLaunchIdentity()
    if (!account) throw new Error('Kein Account gewählt')

    const pinned = file.javaMode === 'pinned' && file.javaPath.length > 0
    const memo = pinned ? undefined : resolveJavaMemo(this.paths.gameRoot, file.resolvedJava)
    const launchStartedAt = Date.now()
    const jvmPreferences = resolveJvmPreferences({
      memoryMode: file.memoryMode,
      minMemoryMb: file.minMemory,
      maxMemoryMb: file.maxMemory,
      jvmPreset: file.jvmPreset,
      fallbackPreset: settings.jvmPreset,
      extraJvmArgs: file.extraJvmArgs,
    })
    const handle = await this.launch.start({
      versionId: file.versionId || file.version,
      gameDirectory: found.directory,
      instanceId: parsed.instanceId,
      instanceName: file.name,
      account,
      ...(pinned ? { javaPath: file.javaPath } : {}),
      ...(memo ? { resolvedJavaPath: memo.path, resolvedJavaMajor: memo.major } : {}),
      ...(jvmPreferences.minMemoryMb > 0 ? { minMemoryMb: jvmPreferences.minMemoryMb } : {}),
      ...(jvmPreferences.maxMemoryMb > 0 ? { maxMemoryMb: jvmPreferences.maxMemoryMb } : {}),
      memoryMode: jvmPreferences.memoryMode,
      jvmPreset: jvmPreferences.jvmPreset,
      extraJvmArgs: jvmPreferences.extraJvmArgs,
      ...(file.resolution ? { resolution: file.resolution } : {}),
      loader: file.loader,
      loaderVersion: file.loaderVersion,
      repairMissing: true,
      ...(parsed.server ? { server: parsed.server } : {}),
      ...(onEvent ? { onEvent } : {}),
    })

    const launchedPath = handle.plan.javaPath
    const launchedMajor = handle.plan.javaMajorVersion
    if (!pinned && launchedPath && launchedMajor !== undefined) {
      const relativePath = javaMemoRelativePath(this.paths.gameRoot, launchedPath)
      if (relativePath) {
        try {
          await this.instanceManager.updateFile(parsed.instanceId, {
            resolvedJava: { major: launchedMajor, relativePath, at: Date.now() },
          })
        } catch (error) {
          this.logger.warn('resolvedJava memo could not be persisted', {
            id: parsed.instanceId,
            error: (error as Error).message,
          })
        }
      }
    }

    void handle.exit.then(async (exit) => {
      if (exit.code === 0 && !exit.crashReport) return
      try {
        const result = await this.analyze(
          parsed.instanceId,
          handle.launchId,
          launchStartedAt,
          handle.stderrLines ?? [],
        )
        this.onAnalysis?.(result)
      } catch (error) {
        this.logger.warn('Post-exit crash analysis failed', {
          id: parsed.instanceId,
          error: (error as Error).message,
        })
      }
    })
    return handle
  }

  async analyze(
    instanceId: string,
    launchId?: string,
    launchStartedAt?: number,
    stderrLines: string[] = [],
  ): Promise<AnalysisResult> {
    const found = await this.instanceManager.get(instanceId)
    const file = await this.instanceManager.readFile(instanceId)
    return analyzeInstance(
      {
        instanceId,
        instanceDir: found.directory,
        maxMemoryMb: file.maxMemory,
        ...(launchId ? { launchId } : {}),
        ...(launchStartedAt !== undefined ? { launchStartedAt } : {}),
        javaMode: file.javaMode,
        javaPath: file.javaPath,
        memoryMode: file.memoryMode,
        ...(file.resolvedJava ? { resolvedJava: file.resolvedJava } : {}),
        stderrLines,
      },
      { logger: this.logger.child('logs') },
    )
  }

  private fixDeps() {
    return {
      updateFile: (instanceId: string, patch: Parameters<typeof this.instanceManager.updateFile>[1]) =>
        this.instanceManager.updateFile(instanceId, patch),
      locks: this.instanceManager.locks,
      findJava: async (major: number) => {
        const records = await this.java.list()
        return records.find((record) => record.valid !== false && record.majorVersion === major)
      },
      ...(this.openPath ? { openPath: this.openPath } : {}),
      ...(this.openUrl ? { openUrl: this.openUrl } : {}),
      installDependency: async (
        action: Parameters<NonNullable<FixDeps['installDependency']>>[0],
        context: Parameters<NonNullable<FixDeps['installDependency']>>[1],
      ) => {
        const file = await this.instanceManager.readFile(context.instanceId)
        const query = action.projectHint ?? action.modId
        if (!file.version || !query) return undefined
        const client = new ModrinthClient({
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(this.modrinthBaseUrl ? { baseUrl: this.modrinthBaseUrl } : {}),
          logger: this.logger.child('mods'),
        })
        const projectId = await resolveDependencyProject(client, query)
        if (!projectId) return undefined
        const loader = modLoaderFor(file.loader)
        try {
          const installed = await installModrinthProject({
            instanceDir: context.instanceDir,
            projectId,
            minecraftVersion: file.version,
            ...(loader ? { loader } : {}),
            client,
            logger: this.logger.child('mods'),
          })
          const files = [...new Set([...installed.installed, ...installed.dependencies])].map(
            (name) => join(context.instanceDir, 'mods', name),
          )
          return { files }
        } catch (error) {
          this.logger.warn('Dependency install failed', {
            modId: action.modId,
            error: (error as Error).message,
          })
          return undefined
        }
      },
    }
  }

  async applyFix(analysisId: string, actionId: string): Promise<FixResult> {
    return applyFixAction(analysisId, actionId, this.fixDeps(), {
      logger: this.logger.child('logs'),
    })
  }

  async undoFix(undoToken: string): Promise<FixResult> {
    return undoFixAction(undoToken, this.fixDeps(), { logger: this.logger.child('logs') })
  }

  async changeGameRoot(nextRoot: string): Promise<CoreStatus> {
    const previousRoot = this.paths.gameRoot
    const updated = await setGameRoot(this.paths, nextRoot, this.logger.child('paths'))
    this.paths.gameRoot = updated.gameRoot
    await this.instanceManager.relocate(previousRoot, updated.gameRoot)
    return this.status()
  }
}

export async function createCore(options: CoreOptions): Promise<LauncherCore> {
  return LauncherCore.create(options)
}

export { createNullLogger }
