import { readdir, stat } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { installVersion } from '../install/version'
import type { JavaManager } from '../java/manager'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { LaunchTracker } from '../launch-tracker'
import type { JavaRecord } from '../schemas'
import { VersionResolveError, resolveVersionModel } from '../version/resolve'
import { LaunchError } from './errors'
import { resolveJvmPlan, resolveJvmPreferences } from './jvm'
import { prepareLaunch } from './prepare'
import { startLaunchProcess } from './process'
import type {
  LaunchEvent,
  LaunchHandle,
  LaunchPreparation,
  LaunchPlan,
  SpawnLike,
} from './types'

export interface LaunchServiceOptions {
  gameRoot: () => string
  cacheDir?: string
  java: JavaManager
  launches: LaunchTracker
  logger?: Logger
  totalMemMb?: () => number
  installImpl?: typeof installVersion
}

export interface StartLaunchRequest
  extends Omit<LaunchPreparation, 'gameRoot' | 'model' | 'javaPath' | 'jvm'> {
  javaPath?: string
  resolvedJavaPath?: string
  resolvedJavaMajor?: number
  preferredJavaPath?: string
  dryRun?: boolean
  repairMissing?: boolean
  track?: boolean
  loaderVersion?: string
  instanceId?: string
  instanceName?: string
  onEvent?: (event: LaunchEvent) => void
  spawnImpl?: SpawnLike
  killImpl?: (pid: number) => Promise<void> | void
  env?: NodeJS.ProcessEnv
  detached?: boolean
}

export interface JavaChoice {
  path: string
  majorVersion?: number
  javaArch?: JavaRecord['architecture']
  javaVendor?: string
  source: 'manual' | 'memo' | 'matched' | 'downloaded' | 'would-download'
  requirement: string
}

export interface PreparedLaunch {
  plan: LaunchPlan
  java: JavaChoice
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

async function countModJars(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).length
  } catch (error) {
    // An instance without a mods folder legitimately has zero mods.
    getDefaultLogger().child('launch').debug('mods folder unavailable; treating mod count as zero', {
      directory,
      error: describeError(error),
    })
    return 0
  }
}

export class LaunchService {
  readonly #getGameRoot: () => string
  readonly #cacheDir?: string
  readonly #java: JavaManager
  readonly #launches: LaunchTracker
  readonly #logger?: Logger
  readonly #totalMemMb: () => number
  readonly #install: typeof installVersion

  constructor(options: LaunchServiceOptions) {
    this.#getGameRoot = options.gameRoot
    this.#cacheDir = options.cacheDir
    this.#java = options.java
    this.#launches = options.launches
    this.#logger = options.logger
    this.#totalMemMb = options.totalMemMb ?? (() => Math.floor(totalmem() / (1024 * 1024)))
    this.#install = options.installImpl ?? installVersion
  }

  async prepare(request: StartLaunchRequest): Promise<PreparedLaunch> {
    const gameRoot = this.#getGameRoot()
    const model = await resolveVersionModel(gameRoot, request.versionId, { logger: this.#logger })
    const selectionRequest = {
      minecraftVersion: model.minecraftVersion,
      loader: request.loader,
      javaVersion: model.javaVersion,
      ...(model.compatibleJavaMajors ? { compatibleJavaMajors: model.compatibleJavaMajors } : {}),
      ...(request.preferredJavaPath ? { preferredPath: request.preferredJavaPath } : {}),
    }
    const selection = await this.#java.select(selectionRequest)

    let javaPath: string | undefined
    let javaMajorVersion: number | undefined
    let javaRecord: JavaRecord | undefined
    let source: JavaChoice['source'] | undefined
    if (request.javaPath) {
      if (request.dryRun) {
        javaPath = request.javaPath
        source = 'manual'
      } else {
        const record = await this.#java.test(request.javaPath)
        if (!record) {
          throw new LaunchError('java-invalid', `Die gewählte Java-Runtime ist nicht nutzbar: ${request.javaPath}`)
        }
        if (!selection.preference.match(record)) {
          throw new LaunchError(
            'java-invalid',
            `Die gewählte Java-Runtime passt nicht: Java ${record.majorVersion} gewählt, benötigt ${selection.preference.requirement}`,
          )
        }
        javaPath = record.path
        javaMajorVersion = record.majorVersion
        javaRecord = record
        source = 'manual'
      }
    } else if (
      request.resolvedJavaPath &&
      request.resolvedJavaMajor !== undefined &&
      (await isFile(request.resolvedJavaPath))
    ) {
      javaPath = request.resolvedJavaPath
      javaMajorVersion = request.resolvedJavaMajor
      source = 'memo'
    } else if (selection.java && (selection.quality === 'matched' || selection.quality === 'may-incompatible')) {
      javaPath = selection.java.path
      javaMajorVersion = selection.java.majorVersion
      javaRecord = selection.java
      source = 'matched'
    } else if (request.dryRun) {
      javaPath = selection.java?.path ?? '<java (java.ensure würde installieren)>'
      javaMajorVersion = selection.java?.majorVersion
      javaRecord = selection.java
      source = 'would-download'
    } else {
      const ensured = await this.#java.ensure(selectionRequest)
      if (!ensured.record) {
        throw new LaunchError('java', 'Java-Download lieferte keine nutzbare Runtime')
      }
      javaPath = ensured.record.path
      javaMajorVersion = ensured.record.majorVersion
      javaRecord = ensured.record
      source = 'downloaded'
    }

    if (!javaPath) {
      throw new LaunchError(
        'java',
        `Keine passende Java-Runtime gefunden (Anforderung ${selection.preference.requirement})`,
      )
    }
    if (!request.dryRun && !(await isFile(javaPath))) {
      throw new LaunchError('java-invalid', `Java-Executable existiert nicht: ${javaPath}`, [], 'java.runtime-vanished')
    }

    const modCount = await countModJars(join(request.gameDirectory, 'mods'))
    const preferences = resolveJvmPreferences({
      memoryMode: request.memoryMode,
      minMemoryMb: request.minMemoryMb,
      maxMemoryMb: request.maxMemoryMb,
      jvmPreset: request.jvmPreset,
      extraJvmArgs: request.extraJvmArgs,
    })
    const jvm = resolveJvmPlan({
      memoryMode: preferences.memoryMode,
      minMemoryMb: preferences.minMemoryMb,
      maxMemoryMb: preferences.maxMemoryMb,
      ...(javaMajorVersion !== undefined ? { javaMajor: javaMajorVersion } : {}),
      ...(javaRecord ? { javaArch: javaRecord.architecture } : {}),
      ...(javaRecord?.vendor ? { javaVendor: javaRecord.vendor } : {}),
      jvmPreset: preferences.jvmPreset,
      extraJvmArgs: preferences.extraJvmArgs,
      modCount,
      totalMemMb: this.#totalMemMb(),
      ...(request.loader ? { loader: request.loader } : {}),
    })

    const plan = await prepareLaunch({
      ...request,
      gameRoot,
      model,
      javaPath,
      ...(javaMajorVersion !== undefined ? { javaMajorVersion } : {}),
      jvm,
    })
    for (const dropped of jvm.dropped ?? []) {
      this.#logger?.debug('jvm.arg-dropped', {
        argument: dropped.argument,
        source: dropped.source,
      })
    }
    this.#logger?.info('JVM plan resolved', {
      presetId: jvm.presetId,
      heapMb: jvm.heapMb,
      xmsMb: jvm.xmsMb,
      downgrades: jvm.downgrades,
    })
    return {
      plan,
      java: {
        path: javaPath,
        ...(javaMajorVersion !== undefined ? { majorVersion: javaMajorVersion } : {}),
        ...(javaRecord ? { javaArch: javaRecord.architecture } : {}),
        ...(javaRecord?.vendor ? { javaVendor: javaRecord.vendor } : {}),
        source: source ?? 'matched',
        requirement: selection.preference.requirement,
      },
    }
  }

  async #repairMissingFiles(request: StartLaunchRequest, onEvent?: (event: LaunchEvent) => void): Promise<void> {
    const gameRoot = this.#getGameRoot()
    let target = request.versionId
    try {
      const model = await resolveVersionModel(gameRoot, request.versionId, { logger: this.#logger })
      target = model.minecraftVersion
    } catch (error) {
      if (!(error instanceof VersionResolveError) || error.code !== 'missing-version') throw error
    }
    onEvent?.({
      type: 'status',
      message: `Fehlende Dateien für ${target} werden über die Download-Engine geholt…`,
    })
    await this.#install(gameRoot, target, {
      cacheDir: this.#cacheDir ?? join(gameRoot, 'cache'),
      logger: this.#logger,
    })
  }

  async start(request: StartLaunchRequest): Promise<LaunchHandle & { launchId?: string }> {
    let prepared: PreparedLaunch
    let repaired = false
    try {
      prepared = await this.prepare(request)
    } catch (error) {
      const missingVersionJson =
        error instanceof VersionResolveError && error.code === 'missing-version'
      const repairable =
        missingVersionJson || (error instanceof LaunchError && error.code === 'natives')
      if (request.repairMissing && repairable && !repaired) {
        repaired = true
        request.onEvent?.({
          type: 'status',
          message: missingVersionJson
            ? `Version ${request.versionId} fehlt lokal und wird nachinstalliert…`
            : 'Fehlende Dateien werden nachinstalliert…',
        })
        await this.#repairMissingFiles(request, request.onEvent)
        prepared = await this.prepare({ ...request, repairMissing: false })
      } else {
        this.#logFailedAttempt(request, (error as Error).message)
        throw error
      }
    }
    let plan = prepared.plan
    const needsRepair = (candidate: LaunchPlan): boolean =>
      !candidate.precheck.clientJar ||
      (candidate.model.assets.count > 0 && !candidate.precheck.assetIndex) ||
      candidate.precheck.librariesMissing.length > 0 ||
      candidate.precheck.nativesMissing.length > 0
    if (needsRepair(plan) && request.repairMissing && !repaired) {
      await this.#repairMissingFiles(request, request.onEvent)
      prepared = await this.prepare({ ...request, repairMissing: false })
      plan = prepared.plan
    }
    if (!plan.precheck.clientJar) {
      const error = new LaunchError('precheck', `Client-JAR fehlt: ${plan.model.clientJar}`)
      this.#logFailedAttempt(request, error.message)
      throw error
    }
    if (plan.precheck.librariesMissing.length > 0) {
      const error = new LaunchError(
        'precheck',
        `${plan.precheck.librariesMissing.length} Bibliothek(en) fehlen (z. B. ${plan.precheck.librariesMissing[0]})`,
      )
      this.#logFailedAttempt(request, error.message)
      throw error
    }
    if (plan.precheck.nativesMissing.length > 0) {
      const error = new LaunchError(
        'precheck',
        `${plan.precheck.nativesMissing.length} Native-Archiv(e) fehlen (z. B. ${plan.precheck.nativesMissing[0]})`,
      )
      this.#logFailedAttempt(request, error.message)
      throw error
    }
    if (plan.model.assets.count > 0 && !plan.precheck.assetIndex) {
      const error = new LaunchError('precheck', `Asset-Index fehlt: ${plan.model.assets.objectsFile}`)
      this.#logFailedAttempt(request, error.message)
      throw error
    }

    const trackerHandle =
      request.track === false
        ? undefined
        : this.#launches.begin({
            version: plan.model.id,
            loader: request.loader ?? 'vanilla',
            loaderVersion: request.loaderVersion ?? '',
            instancePath: plan.gameDirectory,
            ...(request.instanceId ? { instanceId: request.instanceId } : {}),
            ...(request.instanceName ? { instanceName: request.instanceName } : {}),
            javaPath: plan.javaPath,
            gameRoot: this.#getGameRoot(),
            account: request.account.name,
            jvm: {
              presetId: plan.jvm.presetId,
              heapMb: plan.jvm.heapMb,
              downgrades: [...plan.jvm.downgrades],
            },
          })

    try {
      const handle = startLaunchProcess({
        plan,
        ...(request.spawnImpl ? { spawnImpl: request.spawnImpl } : {}),
        ...(request.killImpl ? { killImpl: request.killImpl } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.detached !== undefined ? { detached: request.detached } : {}),
        ...(this.#logger ? { logger: this.#logger } : {}),
        onEvent: (event) => {
          if (event.type === 'exit') {
            trackerHandle?.finish({ exitCode: event.code, error: event.error })
          }
          request.onEvent?.(event)
        },
      })
      return Object.assign(handle, trackerHandle ? { launchId: trackerHandle.launchId } : {})
    } catch (error) {
      trackerHandle?.finish({ error: (error as Error).message })
      throw error
    }
  }

  #logFailedAttempt(request: StartLaunchRequest, message: string): void {
    if (request.track === false) return
    this.#launches
      .begin({
        version: request.versionId,
        loader: request.loader ?? 'vanilla',
        loaderVersion: request.loaderVersion ?? '',
        instancePath: request.gameDirectory,
        ...(request.instanceId ? { instanceId: request.instanceId } : {}),
        ...(request.instanceName ? { instanceName: request.instanceName } : {}),
        javaPath: request.javaPath ?? '',
        gameRoot: this.#getGameRoot(),
        account: request.account.name,
      })
      .finish({ error: message })
  }
}
