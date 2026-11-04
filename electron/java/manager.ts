import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadBuffer, DownloadError, type FetchLike } from '../download/http'
import { LaunchError } from '../launch/errors'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import type { JavaRecord } from '../schemas'
import {
  installRuntime,
  type InstalledRuntime,
  type RuntimeInstallProgress,
} from './installer'
import {
  JAVA_RUNTIME_MANIFEST_URL,
  parseRuntimeManifest,
  resolveRuntimeComponent,
  runtimePlatformKey,
  type RuntimeManifest,
} from './manifest'
import { loadVersionJavaMetadata, type VersionJavaMetadata } from './metadata'
import { type JavaExec, type RegistryQuery, discoverJavaExecutables, javaFingerprint, probeJava } from './scan'
import {
  getJavaPreference,
  matchReason,
  selectJavaRecord,
  type JavaPreference,
  type JavaQuality,
  type JavaReason,
  type JavaSelectionRequest,
} from './selector'
import { JavaStore } from './store'

export interface JavaManagerOptions {
  file: string
  gameRoot: string
  logger: Logger
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  execJava?: JavaExec
  registryQuery?: RegistryQuery
  isOnline?: () => boolean
}

export const JAVA_SCAN_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const JAVA_SCAN_CONCURRENCY = 4
export const JAVA_SCAN_LIMIT = 64

export interface JavaScanResult {
  records: JavaRecord[]
  discovered: number
  added: number
  invalidated: number
  probed: number
  skipped: number
  failed: number
}

export interface JavaSelectionResult {
  preference: JavaPreference
  quality: JavaQuality
  java?: JavaRecord
  matched: JavaRecord[]
  noJava: boolean
  reason?: JavaReason
  vanished: string[]
}

export interface EnsureJavaOptions {
  onProgress?: (progress: RuntimeInstallProgress) => void
  signal?: AbortSignal
}

export interface EnsureJavaResult {
  selection: JavaSelectionResult
  installed?: InstalledRuntime
  record?: JavaRecord
  reason?: JavaReason
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    // A vanished runtime path is an expected selection outcome, not a failure.
    getDefaultLogger().child('java').debug('java path probe failed', { path, error: describeError(error) })
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export class JavaManager {
  #store: JavaStore
  #gameRoot: string
  #logger: Logger
  #platform: NodeJS.Platform
  #arch: string
  #env: NodeJS.ProcessEnv
  #fetch: FetchLike
  #execJava?: JavaExec
  #registryQuery?: RegistryQuery
  #isOnline: () => boolean
  #manifestPromise: Promise<RuntimeManifest> | undefined

  constructor(options: JavaManagerOptions) {
    this.#store = new JavaStore(options.file, options.logger.child('store'))
    this.#gameRoot = options.gameRoot
    this.#logger = options.logger
    this.#platform = options.platform ?? process.platform
    this.#arch = options.arch ?? process.arch
    this.#env = options.env ?? process.env
    this.#fetch = options.fetchImpl ?? fetch
    this.#execJava = options.execJava
    this.#registryQuery = options.registryQuery
    this.#isOnline = options.isOnline ?? (() => true)
  }

  async list(): Promise<JavaRecord[]> {
    return this.#store.list()
  }

  async scan(options: { includeRegistry?: boolean; extraPaths?: string[] } = {}): Promise<JavaScanResult> {
    const now = Date.now()
    const existing = await this.#store.list()
    const newestValidation = existing.reduce(
      (newest, record) => Math.max(newest, record.validatedAt ?? 0),
      0,
    )
    const cacheStale = existing.length === 0 || now - newestValidation > JAVA_SCAN_TTL_MS
    const includeRegistry =
      options.includeRegistry ?? (this.#platform === 'win32' && cacheStale)

    const executables = await discoverJavaExecutables({
      platform: this.#platform,
      env: this.#env,
      gameRoot: this.#gameRoot,
      includeRegistry,
      extraPaths: options.extraPaths,
      registryQuery: this.#registryQuery,
      execJava: this.#execJava,
      logger: this.#logger,
    })

    const capped = executables.slice(0, JAVA_SCAN_LIMIT)
    const known = new Map(existing.map((record) => [record.path.toLowerCase(), record]))
    const discovered = new Set(executables.map((executable) => executable.toLowerCase()))
    let added = 0
    let probed = 0
    let skipped = 0
    let failed = 0

    const refreshed = await mapLimit(capped, JAVA_SCAN_CONCURRENCY, async (executable) => {
      const key = executable.toLowerCase()
      const previous = known.get(key)
      const fingerprint = await javaFingerprint(executable)
      if (!fingerprint) {
        failed += 1
        return previous
      }
      if (
        previous &&
        previous.valid !== false &&
        previous.fingerprint === fingerprint &&
        now - (previous.validatedAt ?? 0) < JAVA_SCAN_TTL_MS
      ) {
        skipped += 1
        return previous
      }

      const record = await probeJava(executable, { platform: this.#platform, execJava: this.#execJava })
      if (!record) {
        failed += 1
        return previous
      }
      probed += 1
      if (!previous) added += 1
      return {
        ...record,
        path: previous?.path ?? record.path,
        source: previous?.source ?? record.source,
        addedAt: previous?.addedAt ?? record.addedAt,
        fingerprint,
      }
    })

    const next = new Map(known)
    for (const record of refreshed) {
      if (record) next.set(record.path.toLowerCase(), record)
    }

    let invalidated = 0
    for (const record of existing) {
      const key = record.path.toLowerCase()
      if (discovered.has(key)) continue
      if (await exists(record.path)) continue
      if (record.valid !== false) {
        next.set(key, { ...record, valid: false })
        invalidated += 1
      }
    }

    await this.#store.replaceAll([...next.values()])
    const records = await this.#store.list()
    this.#logger.info('Java scan complete', {
      discovered: executables.length,
      added,
      probed,
      skipped,
      failed,
      invalidated,
      registry: includeRegistry,
      usable: records.filter((record) => record.valid !== false).length,
    })
    return { records, discovered: executables.length, added, invalidated, probed, skipped, failed }
  }

  async select(request: JavaSelectionRequest): Promise<JavaSelectionResult> {
    const preference = getJavaPreference(request)
    const records = await this.#store.list()
    const selection = selectJavaRecord(records, preference, request.preferredPath, this.#arch)
    const vanished: string[] = []
    let java = selection.java
    let quality = selection.quality
    let reason = selection.reason

    if (java && (quality === 'matched' || quality === 'may-incompatible')) {
      const candidates = [
        java,
        ...selection.matched.filter((record) => record.path.toLowerCase() !== java?.path.toLowerCase()),
      ]
      let found: JavaRecord | undefined
      for (const candidate of candidates.slice(0, 3)) {
        if (await isFile(candidate.path)) {
          found = candidate
          break
        }
        vanished.push(candidate.path)
        this.#logger.warn('Java runtime vanished during selection', {
          path: candidate.path,
          reason: 'java.runtime-vanished',
        })
      }
      if (!found) {
        java = undefined
        quality = 'incompatible'
        reason = 'java.runtime-vanished'
      } else if (quality === 'matched') {
        java = found
        reason = matchReason(preference, found, request.preferredPath)
      } else {
        java = found
        reason = 'java.may-incompatible'
      }
    }

    return {
      preference,
      quality,
      ...(java ? { java } : {}),
      matched: selection.matched,
      noJava: records.filter((record) => record.valid !== false).length === 0,
      ...(reason ? { reason } : {}),
      vanished,
    }
  }

  async selectForInstalledVersion(
    versionId: string,
    loader?: string,
  ): Promise<JavaSelectionResult & { metadata: VersionJavaMetadata }> {
    const metadata = await loadVersionJavaMetadata({
      versionsDir: join(this.#gameRoot, 'versions'),
      versionId,
      logger: this.#logger,
    })
    const result = await this.select({
      minecraftVersion: versionId,
      loader,
      javaVersion: metadata.javaVersion,
      compatibleJavaMajors: metadata.compatibleJavaMajors,
    })
    return { ...result, metadata }
  }

  async runtimeManifest(): Promise<RuntimeManifest> {
    if (!this.#manifestPromise) {
      this.#manifestPromise = (async () => {
        try {
          const response = await downloadBuffer({
            urls: [JAVA_RUNTIME_MANIFEST_URL],
            fetchImpl: this.#fetch,
          })
          return parseRuntimeManifest(JSON.parse(response.buffer.toString('utf8')))
        } catch (error) {
          if (error instanceof DownloadError || error instanceof SyntaxError) {
            throw new Error(`Java runtime manifest fetch failed: ${(error as Error).message}`, { cause: error })
          }
          throw error
        }
      })().catch((error) => {
        this.#manifestPromise = undefined
        throw error
      })
    }
    return this.#manifestPromise
  }

  async ensure(request: JavaSelectionRequest, options: EnsureJavaOptions = {}): Promise<EnsureJavaResult> {
    const selection = await this.select(request)
    if (selection.java && (selection.quality === 'matched' || selection.quality === 'may-incompatible')) {
      return { selection, record: selection.java }
    }

    if (!this.#isOnline()) {
      const required = selection.preference.majorVersion
      const valid = (await this.#store.list()).filter((record) => record.valid !== false)
      const nearest = valid
        .slice()
        .sort((a, b) => Math.abs(a.majorVersion - required) - Math.abs(b.majorVersion - required))
        .at(0)?.path
      throw new LaunchError(
        'java',
        `Keine passende Java-Runtime gefunden (Anforderung ${selection.preference.requirement}); offline ist kein Download möglich`,
        nearest ? [nearest] : [],
        'java.no-runtime',
      )
    }

    const component = selection.preference.component
    if (component) {
      const existing = join(
        this.#gameRoot,
        'java',
        component,
        'bin',
        this.#platform === 'win32' ? 'java.exe' : 'java',
      )
      if (await isFile(existing)) {
        const probed = await probeJava(existing, { platform: this.#platform, execJava: this.#execJava })
        if (probed && selection.preference.match(probed)) {
          probed.source = 'mojang'
          const record = await this.#store.upsert(probed)
          return { selection: await this.select(request), record }
        }
      }
    }

    const manifest = await this.runtimeManifest()
    const platform = runtimePlatformKey(this.#platform, this.#arch)
    const resolved = resolveRuntimeComponent(
      manifest,
      platform,
      selection.preference.majorVersion,
      selection.preference.component,
    )
    if (!resolved) {
      throw new LaunchError(
        'java',
        `No Mojang runtime publishes Java ${selection.preference.majorVersion} for ${platform}`,
        [],
        'java.no-runtime',
      )
    }

    const installed = await installRuntime({
      gameRoot: this.#gameRoot,
      component: resolved.component,
      entry: resolved.entry,
      platform: this.#platform,
      fetchImpl: this.#fetch,
      signal: options.signal,
      onProgress: options.onProgress,
      logger: this.#logger,
    })

    const probed = await probeJava(installed.javaPath, { platform: this.#platform, execJava: this.#execJava })
    if (!probed) {
      throw new LaunchError('java', `Downloaded runtime ${resolved.component} could not be probed`, [], 'java.no-runtime')
    }
    if (!selection.preference.match(probed)) {
      throw new LaunchError(
        'java',
        `Downloaded Java ${probed.majorVersion} does not satisfy ${selection.preference.requirement}`,
        [],
        'java.no-runtime',
      )
    }
    probed.source = 'mojang'
    this.#logger.info('Java runtime downloaded', { component: resolved.component, path: probed.path })
    const record = await this.#store.upsert(probed)
    return { selection: await this.select(request), installed, record, reason: 'java.downloaded' }
  }

  async test(path: string): Promise<JavaRecord | undefined> {
    if (!(await exists(path))) {
      await this.#store.setValid(path, false)
      return undefined
    }
    const record = await probeJava(path, { platform: this.#platform, execJava: this.#execJava })
    if (!record) return undefined
    return this.#store.upsert(record)
  }
}
