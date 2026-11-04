import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { resolveVersionModel } from '../version/resolve'
import { installVersion } from '../install/version'
import type { InstallReport } from '../download/types'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { LoaderError } from './errors'
import { installForgeLike } from './forge'
import { installOptifine } from './optifine'
import {
  installModelFiles,
  libraryFileIsValid,
  markerPath,
  pathExists,
  profilePath,
  readJsonSafe,
  readMarker,
  resolveJavaRuntimes,
  versionJsonPath,
} from './common'
import { buildProcessorTasks, resolveProcessors, type ResolvedProcessor } from './profile-postprocess'
import { diagnoseProcessorOutputs, runJavaTask } from './java-task'
import type {
  InstallProfile,
  LoaderInstallIssue,
  LoaderInstallOptions,
  LoaderKind,
  LoaderRepairResult,
  ProcessorOutputIssue,
} from './types'

export interface DiagnoseOptions {
  gameRoot: string
  versionId: string
  side?: 'client' | 'server'
  checkAssets?: boolean
  logger?: Logger
}

export function loaderKindFromVersion(versionId: string, markerLoader?: LoaderKind): LoaderKind | undefined {
  if (markerLoader) return markerLoader
  const id = versionId.toLowerCase()
  if (id.includes('neoforge')) return 'neoforge'
  if (id.includes('forge')) return 'forge'
  if (id.includes('fabric')) return 'fabric'
  if (id.includes('quilt')) return 'quilt'
  if (id.includes('optifine')) return 'optifine'
  return undefined
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch (error) {
    getDefaultLogger().child('loaders:diagnose').debug('file probe failed; treating as missing', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function loadProfile(
  gameRoot: string,
  versionId: string,
): Promise<InstallProfile | undefined> {
  return readJsonSafe<InstallProfile>(profilePath(gameRoot, versionId))
}

export interface ProfileProcessors {
  profile: InstallProfile
  processors: ResolvedProcessor[]
  runtime: { path: string; majorVersion?: number }
}

async function processorInputsPresent(processor: ResolvedProcessor): Promise<boolean> {
  for (const file of [processor.jarPath, ...processor.classpathPaths]) {
    if (!(await pathExists(file))) return false
  }
  const outputs = new Set(processor.outputs.map((output) => output.path))
  for (const argument of processor.args) {
    if (!isAbsolute(argument)) continue
    if (outputs.has(argument)) continue
    if (!/\.(jar|zip|lzma|txt|dat|json)$/i.test(argument)) continue
    if (!(await pathExists(argument))) return false
  }
  return true
}

export async function resolveStoredProcessors(
  gameRoot: string,
  versionId: string,
  options: { side?: 'client' | 'server'; javaRuntimes: Array<{ path: string; majorVersion?: number }> },
): Promise<ProfileProcessors | undefined> {
  const profile = await loadProfile(gameRoot, versionId)
  if (!profile || !Array.isArray(profile.processors) || profile.processors.length === 0) return undefined
  const marker = await readMarker(gameRoot, versionId)
  const processors = resolveProcessors(profile, {
    gameRoot,
    side: options.side ?? 'client',
    minecraftVersion: profile.minecraft,
    ...(marker?.installerPath ? { installerPath: marker.installerPath } : {}),
    javaRuntimes: options.javaRuntimes,
  })
  return { profile, processors, runtime: options.javaRuntimes[0] ?? { path: 'java' } }
}

async function processorIssues(
  gameRoot: string,
  versionId: string,
  options: { side?: 'client' | 'server'; javaPath?: string },
): Promise<{ issues: ProcessorOutputIssue[]; processors: ResolvedProcessor[] }> {
  const resolved = await resolveStoredProcessors(gameRoot, versionId, {
    ...(options.side ? { side: options.side } : {}),
    javaRuntimes: [{ path: options.javaPath ?? 'java' }],
  })
  if (!resolved) return { issues: [], processors: [] }
  const issues: ProcessorOutputIssue[] = []
  for (const processor of resolved.processors) {
    const found = await diagnoseProcessorOutputs(processor.outputs)
    issues.push(...found)
  }
  return { issues, processors: resolved.processors }
}

export async function diagnoseInstallation(options: DiagnoseOptions): Promise<LoaderInstallIssue> {
  const { gameRoot, versionId } = options
  const details: string[] = []
  const issue: LoaderInstallIssue = {
    versionId,
    missingLibraries: [],
    corruptLibraries: [],
    missingAssets: 0,
    processorIssues: [],
    details,
  }
  const marker = await readMarker(gameRoot, versionId)
  const kind = loaderKindFromVersion(versionId, marker?.loader)
  if (kind) issue.loader = kind

  if (!(await fileExists(versionJsonPath(gameRoot, versionId)))) {
    details.push(`Version-JSON fehlt: ${versionJsonPath(gameRoot, versionId)}`)
    return issue
  }

  let model
  try {
    model = await resolveVersionModel(gameRoot, versionId, {
      ...(options.logger ? { logger: options.logger } : {}),
    })
  } catch (error) {
    details.push(`Version nicht auflösbar: ${(error as Error).message}`)
    return issue
  }

  if (!(await fileExists(model.clientJar))) {
    issue.clientJar = model.clientJar
    details.push(`Client-JAR fehlt: ${model.clientJar}`)
  }

  for (const library of [...model.libraries, ...model.natives]) {
    if (!(await libraryFileIsValid(library))) {
      let exists: boolean
      try {
        exists = (await stat(library.absolutePath)).isFile()
      } catch (error) {
        getDefaultLogger().child('loaders:diagnose').debug('library probe failed; reporting as missing', {
          file: library.absolutePath,
          error: describeError(error),
        })
        exists = false
      }
      if (exists) issue.corruptLibraries.push(library.absolutePath)
      else issue.missingLibraries.push(library.absolutePath)
    }
  }
  if (issue.missingLibraries.length > 0) {
    details.push(`${issue.missingLibraries.length} Bibliothek(en) fehlen`)
  }
  if (issue.corruptLibraries.length > 0) {
    details.push(`${issue.corruptLibraries.length} Bibliothek(en) beschädigt`)
  }

  if ((options.checkAssets ?? true) && model.assets.count > 0) {
    if (!(await fileExists(model.assets.objectsFile))) {
      issue.missingAssetIndex = model.assets.objectsFile
      details.push(`Asset-Index fehlt: ${model.assets.objectsFile}`)
    } else {
      let missing = 0
      const limit = 20_000
      for (let index = 0; index < model.assets.objects.length && index < limit; index += 1) {
        const object = model.assets.objects[index]
        if (!(await fileExists(object.absolutePath))) missing += 1
      }
      issue.missingAssets = missing
      if (missing > 0) details.push(`${missing} Asset-Objekt(e) fehlen`)
    }
  }

  const processors = await processorIssues(gameRoot, versionId, {
    ...(options.side ? { side: options.side } : {}),
  })
  if (processors.issues.length > 0) {
    issue.processorIssues = processors.issues
    details.push(`${processors.issues.length} Prozessor-Ausgabe(n) fehlen oder sind beschädigt`)
  }

  if (kind === 'forge' || kind === 'neoforge') {
    const profile = await loadProfile(gameRoot, versionId)
    if (profile) issue.profile = profile
  }
  if (issue.processorIssues.length > 0 && issue.profile === undefined) {
    const profile = await loadProfile(gameRoot, versionId)
    if (profile) issue.profile = profile
  }
  return issue
}

export interface RepairOptions extends Omit<LoaderInstallOptions, 'minecraftVersion'> {
  versionId: string
  repairBase?: boolean
  repairProcessors?: boolean
  processorRunner?: LoaderInstallOptions['processorRunner']
}

export async function repairInstallation(options: RepairOptions): Promise<LoaderRepairResult> {
  const { gameRoot, versionId } = options
  const issueBefore = await diagnoseInstallation({
    gameRoot,
    versionId,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const repaired: string[] = []
  let downloadedBytes = 0
  let processorsRun = 0

  const marker = await readMarker(gameRoot, versionId)
  const kind = loaderKindFromVersion(versionId, marker?.loader)
  const minecraftVersion = marker?.minecraftVersion
  const model = await resolveVersionModel(gameRoot, versionId)

  const needsBase =
    options.repairBase !== false &&
    (issueBefore.clientJar !== undefined ||
      issueBefore.missingAssetIndex !== undefined ||
      issueBefore.missingAssets > 0 ||
      (kind !== undefined && issueBefore.missingLibraries.length > 0))
  if (needsBase && minecraftVersion) {
    options.onEvent?.({ type: 'status', message: 'Basis-Version wird repariert…' })
    const baseReport = await installVersion(gameRoot, minecraftVersion, {
      cacheDir: options.cacheDir ?? join(gameRoot, 'cache'),
      withAssets: issueBefore.missingAssetIndex !== undefined || issueBefore.missingAssets > 0,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.logger ? { logger: options.logger.child('base') } : {}),
    })
    downloadedBytes += baseReport.downloadedBytes
    if (baseReport.downloadedBytes > 0) repaired.push('base')
  }

  const modelReport = await installModelFiles(
    gameRoot,
    model,
    { ...options, minecraftVersion: model.minecraftVersion },
    `${versionId}:repair`,
  )
  const filesReport: InstallReport = modelReport
  downloadedBytes += modelReport.downloadedBytes
  if (modelReport.downloadedFiles > 0) repaired.push('libraries')

  if (options.repairProcessors !== false && issueBefore.processorIssues.length > 0) {
    const invalidFiles = new Set(issueBefore.processorIssues.map((entry) => entry.file))
    const javaRuntimes = await resolveJavaRuntimes({ ...options, minecraftVersion: model.minecraftVersion })
    const resolved = await resolveStoredProcessors(gameRoot, versionId, {
      javaRuntimes,
      ...(options.side ? { side: options.side } : {}),
    })
    if (resolved) {
      const selected = resolved.processors.filter((processor) =>
        processor.outputs.some((output) => invalidFiles.has(output.path)),
      )
      const inputsPresent = (
        await Promise.all(selected.map((processor) => processorInputsPresent(processor)))
      ).every(Boolean)
      if (!inputsPresent && minecraftVersion) {
        options.onEvent?.({
          type: 'status',
          message: 'Vorgelagerte Prozessor-Dateien fehlen – die Prozessor-Kette wird erneut ausgeführt…',
        })
        options.logger?.warn('Reparatur benötigt die vollständige Prozessor-Kette', {
          versionId,
          loader: kind,
          selected: selected.map((processor) => processor.jarName),
        })
        const chainOptions = {
          ...options,
          gameRoot,
          installBaseVersion: false,
          ...(!options.mavenBase && marker?.mavenBase ? { mavenBase: marker.mavenBase } : {}),
          ...(!options.metaBase && marker?.metaBase ? { metaBase: marker.metaBase } : {}),
          ...(!options.optifineMirror && marker?.optifineMirror ? { optifineMirror: marker.optifineMirror } : {}),
        }
        if (kind === 'forge' || kind === 'neoforge') {
          const chain = await installForgeLike(kind, {
            ...chainOptions,
            minecraftVersion,
            versionId,
            ...(marker?.loaderVersion ? { loaderVersion: marker.loaderVersion } : {}),
          })
          processorsRun += chain.processorsRun
        } else if (kind === 'optifine') {
          const chain = await installOptifine({
            ...chainOptions,
            minecraftVersion,
            versionId,
            ...(marker?.loaderVersion ? { loaderVersion: marker.loaderVersion } : {}),
          })
          processorsRun += chain.processorsRun
        }
      } else {
        const tasks = buildProcessorTasks(selected, { id: `${versionId}:repair-processors`, cwd: gameRoot })
        for (let index = 0; index < tasks.length; index += 1) {
          const task = tasks[index]
          const processor = selected[index]
          task.outputs = processor.outputs.filter((output) => invalidFiles.has(output.path))
          const result = await runJavaTask(task, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.logger ? { logger: options.logger.child('processors') } : {}),
            ...(options.processorRunner ? { runCommand: options.processorRunner } : {}),
          })
          if (result.ran) processorsRun += 1
        }
      }
      if (processorsRun > 0) repaired.push(`processors:${processorsRun}`)
    }
  }

  const issueAfter = await diagnoseInstallation({
    gameRoot,
    versionId,
    ...(options.logger ? { logger: options.logger } : {}),
  })

  return {
    versionId,
    issueBefore,
    ...(Object.keys(issueAfter).length > 0 ? { issueAfter } : {}),
    ...(filesReport ? { filesReport } : {}),
    processorsRun,
    repaired,
    downloadedBytes,
  }
}

export function storedProfilePath(gameRoot: string, versionId: string): string {
  return profilePath(gameRoot, versionId)
}

export function storedMarkerPath(gameRoot: string, versionId: string): string {
  return markerPath(gameRoot, versionId)
}

export { LoaderError }
