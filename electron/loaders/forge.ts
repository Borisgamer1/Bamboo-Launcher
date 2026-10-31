import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { writeJsonFile } from '../atomic'
import { hashFile } from '../download/checksum'
import { runInstallManifest } from '../download/executor'
import type { InstallFile, InstallReport } from '../download/types'
import { coordinatePath, parseMavenCoordinate } from '../version/libraries'
import { resolveVersionModel } from '../version/resolve'
import type { RawVersionJson } from '../version/resolve'
import { LoaderError } from './errors'
import { fetchMavenSha1, fetchContentLength } from './http'
import {
  DEFAULT_FORGE_MAVEN,
  DEFAULT_NEOFORGE_MAVEN,
  forgeArtifactVersion,
  forgeInstallerUrl,
  listLoaderVersions,
  neoforgeInstallerUrl,
  neoforgeProject,
  pickLoaderVersion,
} from './metadata'
import {
  ensureBaseVersion,
  ensureClientJar,
  executorOptions,
  installModelFiles,
  markerPath,
  profilePath,
  readMarker,
  requireLoaderVersion,
  resolveJavaRuntimes,
  writeVersionJson,
} from './common'
import { LoaderTransaction } from './transaction'
import { buildProcessorTasks, resolveProcessors, type ResolvedProcessor } from './profile-postprocess'
import { getJavaPreference } from '../java/selector'
import { describeError, getDefaultLogger } from '../logger'
import { diagnoseProcessorOutputs, runJavaTask, type JavaTaskRunOptions } from './java-task'
import type {
  InstallProfile,
  LoaderInstallMarker,
  LoaderInstallOptions,
  LoaderInstallResult,
  LoaderJavaRuntime,
  LoaderKind,
} from './types'

export type ForgeKind = 'forge' | 'neoforge'

export function forgeVersionId(kind: ForgeKind, minecraftVersion: string, loaderVersion: string): string {
  return kind === 'neoforge' ? `neoforge-${loaderVersion}` : `${minecraftVersion}-forge-${loaderVersion}`
}

export function forgeInstallerRelativePath(
  kind: ForgeKind,
  minecraftVersion: string,
  loaderVersion: string,
): string {
  if (kind === 'forge') {
    const artifact = forgeArtifactVersion(minecraftVersion, loaderVersion)
    return `libraries/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`
  }
  const project = neoforgeProject(minecraftVersion)
  return `libraries/net/neoforged/${project}/${loaderVersion}/${project}-${loaderVersion}-installer.jar`
}

export function forgeInstallerUrlFor(
  kind: ForgeKind,
  minecraftVersion: string,
  loaderVersion: string,
  options: LoaderInstallOptions = { gameRoot: '', minecraftVersion: '' },
): string {
  if (kind === 'forge') {
    return forgeInstallerUrl(minecraftVersion, loaderVersion, options.mavenBase ?? DEFAULT_FORGE_MAVEN)
  }
  return neoforgeInstallerUrl(minecraftVersion, loaderVersion, options.mavenBase ?? DEFAULT_NEOFORGE_MAVEN)
}

export function installerCoordinate(
  kind: ForgeKind,
  minecraftVersion: string,
  loaderVersion: string,
): string {
  if (kind === 'forge') {
    const artifact = forgeArtifactVersion(minecraftVersion, loaderVersion)
    return `net.minecraftforge:forge:${artifact}:installer`
  }
  const project = neoforgeProject(minecraftVersion)
  return `net.neoforged:${project}:${loaderVersion}:installer`
}

export function lzmaCoordinate(
  kind: ForgeKind,
  artifactVersion: string,
  classifier: string,
  minecraftVersion = '',
): string {
  const group = kind === 'forge' ? 'net.minecraftforge' : 'net.neoforged'
  const project = kind === 'forge' ? 'forge' : neoforgeProject(minecraftVersion)
  return `${group}:${project}:${artifactVersion}:${classifier}@lzma`
}

export interface InstallerArchive {
  profile: InstallProfile
  versionJson?: RawVersionJson
  versionInfo?: RawVersionJson
  isLegacy: boolean
  entries: string[]
}

function readZipJson<T>(zip: AdmZip, entryName: string): T | undefined {
  const entry = zip.getEntry(entryName)
  if (!entry || entry.isDirectory) return undefined
  try {
    return JSON.parse(entry.getData().toString('utf8')) as T
  } catch (error) {
    throw new LoaderError('installer', `Ungültiges JSON im Installer: ${entryName}`, { cause: error })
  }
}

export function readInstallerArchive(installerPath: string): InstallerArchive {
  let zip: AdmZip
  try {
    zip = new AdmZip(installerPath)
  } catch (error) {
    throw new LoaderError('installer', `Installer-JAR nicht lesbar: ${installerPath}`, { cause: error })
  }
  const entries = zip.getEntries().map((entry) => entry.entryName)
  const profile = readZipJson<InstallProfile>(zip, 'install_profile.json')
  if (!profile) {
    throw new LoaderError('installer', `install_profile.json fehlt in ${installerPath}`)
  }
  const versionJson = readZipJson<RawVersionJson>(zip, 'version.json')
  const versionInfo = profile.versionInfo as RawVersionJson | undefined
  const hasUniversal = entries.some((name) => name.endsWith('-universal.jar'))
  const hasBundledForgeLibrary = (versionJson?.libraries ?? []).some((library) => {
    const raw = library as RawProfileLibrary
    const artifact = raw.downloads?.artifact
    if (!raw.name || !/^(net\.minecraftforge:forge|net\.minecraftforge:minecraftforge):/.test(raw.name)) {
      return false
    }
    return artifact !== undefined && !artifact.url && Boolean(artifact.path)
  })
  const processors = Array.isArray(profile.processors) ? profile.processors : []
  const isLegacy =
    !versionJson ||
    (processors.length === 0 && (Boolean(versionInfo) || hasUniversal || hasBundledForgeLibrary))
  const result: InstallerArchive = { profile, isLegacy, entries }
  if (versionJson) result.versionJson = versionJson
  if (versionInfo) result.versionInfo = versionInfo
  return result
}

function patchVersionJson(
  raw: RawVersionJson,
  versionId: string,
  minecraftVersion: string,
): RawVersionJson {
  return { ...raw, id: versionId, inheritsFrom: raw.inheritsFrom ?? minecraftVersion }
}

interface RawProfileLibrary {
  name?: string
  downloads?: { artifact?: { path?: string; url?: string; sha1?: string; size?: number } }
}

function libraryInstallFileFromRaw(raw: RawProfileLibrary): InstallFile | undefined {
  const download = raw.downloads?.artifact
  const coordinate = raw.name ? parseMavenCoordinate(raw.name) : undefined
  const path = download?.path ?? (coordinate ? coordinatePath(coordinate) : undefined)
  if (!path || !download?.url) return undefined
  const file: InstallFile = { path: `libraries/${path}`, urls: [download.url], validator: 'zip' }
  if (download.size !== undefined && download.size >= 0) file.size = download.size
  if (download.sha1) file.checksum = { algorithm: 'sha1', value: download.sha1 }
  return file
}

export function profileLibraryFiles(profile: InstallProfile): InstallFile[] {
  const files = new Map<string, InstallFile>()
  for (const library of profile.libraries ?? []) {
    const file = libraryInstallFileFromRaw(library as RawProfileLibrary)
    if (file) files.set(file.path, file)
  }
  return [...files.values()]
}

function coordinateFromBracketReference(reference: string): string | undefined {
  const match = /^\[(.+)\]$/.exec(reference.trim())
  return match?.[1]
}

export function processorInputFiles(
  profile: InstallProfile,
  options: { mavenBase?: string; kind: ForgeKind; gameRoot: string; existing?: Iterable<string> },
): InstallFile[] {
  const files = new Map<string, InstallFile>()
  const known = new Set(options.existing ?? [])
  const maven =
    options.mavenBase ?? (options.kind === 'forge' ? DEFAULT_FORGE_MAVEN : DEFAULT_NEOFORGE_MAVEN)
  const references = new Set<string>()
  for (const processor of profile.processors ?? []) {
    references.add(processor.jar)
    for (const entry of processor.classpath ?? []) references.add(entry)
    for (const arg of processor.args ?? []) {
      const coordinate = coordinateFromBracketReference(arg)
      if (coordinate) references.add(coordinate)
    }
  }
  for (const reference of references) {
    if (!reference || reference.startsWith('/') || reference.includes('{')) continue
    const coordinate = parseMavenCoordinate(reference)
    if (!coordinate) continue
    const path = `libraries/${coordinatePath(coordinate)}`
    if (known.has(path) || files.has(path)) continue
    files.set(path, {
      path,
      urls: [`${maven}/${path.slice('libraries/'.length)}`],
      validator: 'zip',
    })
  }
  return [...files.values()]
}

export interface ForgeInstallSession {
  kind: ForgeKind
  transaction: LoaderTransaction
  profile: InstallProfile
  archive: InstallerArchive
}

export function rewriteProfileData(
  profile: InstallProfile,
  options: {
    kind: ForgeKind
    artifactVersion: string
    minecraftVersion: string
    gameRoot: string
    installerPath: string
    hasClientLzma: boolean
    hasServerLzma: boolean
  },
): InstallProfile {
  const data = { ...(profile.data ?? {}) }
  data.INSTALLER = {
    client: `[${installerCoordinate(options.kind, options.minecraftVersion, options.artifactVersion)}]`,
    server: `[${installerCoordinate(options.kind, options.minecraftVersion, options.artifactVersion)}]`,
  }
  if (data.BINPATCH) {
    const binpatch = { ...data.BINPATCH }
    if (options.hasClientLzma) {
      binpatch.client = `[${lzmaCoordinate(options.kind, options.artifactVersion, 'clientdata')}]`
    }
    if (options.hasServerLzma) {
      binpatch.server = `[${lzmaCoordinate(options.kind, options.artifactVersion, 'serverdata')}]`
    }
    data.BINPATCH = binpatch
  }
  return { ...profile, data }
}

interface ForgeInstallOutcome {
  model: Awaited<ReturnType<typeof resolveVersionModel>>
  report: InstallReport
  processorsRun: number
  alreadyInstalled: boolean
  installerPath: string
  installerSha1?: string
  processorOutputs: string[]
  warnings: string[]
}

async function downloadInstaller(
  kind: ForgeKind,
  options: LoaderInstallOptions,
  minecraftVersion: string,
  loaderVersion: string,
): Promise<{ path: string; sha1?: string; report: InstallReport }> {
  const relative = forgeInstallerRelativePath(kind, minecraftVersion, loaderVersion)
  const url = forgeInstallerUrlFor(kind, minecraftVersion, loaderVersion, options)
  const [sha1, size] = await Promise.all([
    fetchMavenSha1(url, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    fetchContentLength(url, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  ])
  const file: InstallFile = { path: relative, urls: [url], validator: 'zip' }
  if (sha1) file.checksum = { algorithm: 'sha1', value: sha1 }
  if (size !== undefined) file.size = size
  options.onProgress?.({ phase: 'installer', message: 'Installer wird geladen', loader: kind })
  const report = await runInstallManifest(
    { version: 1, tasks: [{ type: 'files', id: `${kind}-installer`, destination: options.gameRoot, files: [file] }] },
    executorOptions(options),
  )
  return { path: join(options.gameRoot, relative), ...(sha1 ? { sha1 } : {}), report }
}

async function fileSha1(file: string): Promise<string | undefined> {
  try {
    return await hashFile('sha1', file)
  } catch (error) {
    getDefaultLogger().child('loaders:forge').debug('installer sha1 unavailable; continuing without it', {
      file,
      error: describeError(error),
    })
    return undefined
  }
}

export async function installForgeLike(
  kind: ForgeKind,
  options: LoaderInstallOptions,
): Promise<LoaderInstallResult> {
  const gameRoot = options.gameRoot
  const minecraftVersion = options.minecraftVersion
  const transaction = new LoaderTransaction(gameRoot, kind)

  let loaderVersion = options.loaderVersion
  if (!loaderVersion) {
    const list = await listLoaderVersions(kind as LoaderKind, {
      minecraftVersion,
      ...(options.mavenBase ? { mavenBase: options.mavenBase } : {}),
      ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    })
    loaderVersion = pickLoaderVersion(list.versions)?.version
  }
  const version = requireLoaderVersion(loaderVersion, kind)
  const versionId = options.versionId ?? forgeVersionId(kind, minecraftVersion, version)

  const outcome = await transaction.run<ForgeInstallOutcome>(async () => {
    if (options.signal?.aborted) throw new LoaderError('aborted', 'Loader-Installation abgebrochen')
    await ensureBaseVersion(gameRoot, minecraftVersion, options)

    const previousMarker = await readMarker(gameRoot, versionId)
    const installerDownload = await downloadInstaller(kind, options, minecraftVersion, version)
    const installerPath = installerDownload.path
    const installerSha1 = installerDownload.sha1 ?? (await fileSha1(installerPath))
    const archive = readInstallerArchive(installerPath)
    const artifactVersion = kind === 'forge' ? forgeArtifactVersion(minecraftVersion, version) : version
    const hasClientLzma = archive.entries.includes('data/client.lzma')
    const hasServerLzma = archive.entries.includes('data/server.lzma')
    const profile = rewriteProfileData(archive.profile, {
      kind,
      artifactVersion,
      minecraftVersion,
      gameRoot,
      installerPath,
      hasClientLzma,
      hasServerLzma,
    })

    const rawVersionJson = archive.versionJson ?? archive.versionInfo
    if (!rawVersionJson) {
      throw new LoaderError('installer', `Installer ${installerPath} enthält keine Versionsdaten`, {
        loader: kind,
      })
    }
    const versionJson = patchVersionJson(rawVersionJson, versionId, minecraftVersion)

    if (hasClientLzma) {
      const target = join(
        gameRoot,
        'libraries',
        coordinatePath(parseMavenCoordinate(lzmaCoordinate(kind, artifactVersion, 'clientdata', minecraftVersion))!),
      )
      options.onProgress?.({ phase: 'profile', message: 'Binpatch-Daten werden entpackt', loader: kind })
      await transaction.extract(installerPath, 'data/client.lzma', target)
    }
    if (hasServerLzma) {
      const target = join(
        gameRoot,
        'libraries',
        coordinatePath(parseMavenCoordinate(lzmaCoordinate(kind, artifactVersion, 'serverdata', minecraftVersion))!),
      )
      await transaction.extract(installerPath, 'data/server.lzma', target)
    }

    if (archive.isLegacy) {
      const forgeLibrary = (versionJson.libraries ?? []).find((library) =>
        /^net\.minecraftforge:(forge|minecraftforge):/.test(String(library.name ?? '')),
      ) as { name?: string } | undefined
      const coordinate = forgeLibrary?.name ? parseMavenCoordinate(forgeLibrary.name) : undefined
      const relative = coordinate
        ? coordinatePath(coordinate)
        : `net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-universal.jar`
      const wanted = relative.endsWith('-universal.jar')
        ? relative
        : `${relative.slice(0, -'.jar'.length)}-universal.jar`
      const universalEntry =
        archive.entries.find((name) => name === `maven/${relative}`) ??
        archive.entries.find((name) => name === `maven/${wanted}`) ??
        archive.entries.find((name) => name === relative) ??
        archive.entries.find((name) => name === wanted) ??
        archive.entries.find((name) => name.endsWith(`/${relative}`)) ??
        archive.entries.find((name) => name.endsWith(`/${wanted}`)) ??
        archive.entries.find((name) => name.endsWith('-universal.jar'))
      if (universalEntry) {
        options.onProgress?.({ phase: 'profile', message: 'Universal-JAR wird entpackt', loader: kind })
        await transaction.extract(installerPath, universalEntry, join(gameRoot, 'libraries', relative))
      }
    }

    options.onProgress?.({ phase: 'profile', message: 'Profil wird geschrieben', loader: kind })
    await writeVersionJson(transaction, gameRoot, versionId, versionJson)
    await transaction.writeJson(profilePath(gameRoot, versionId), profile)

    const profileLibraries = profileLibraryFiles(profile)
    const processorInputs = archive.isLegacy
      ? []
      : processorInputFiles(profile, {
          kind,
          gameRoot,
          existing: profileLibraries.map((file) => file.path),
          ...(options.mavenBase ? { mavenBase: options.mavenBase } : {}),
        })
    const inputs: InstallFile[] = [...profileLibraries, ...processorInputs]
    let inputsReport: InstallReport | undefined
    if (inputs.length > 0) {
      options.onProgress?.({ phase: 'inputs', message: `${inputs.length} Profil-Dateien`, loader: kind })
      inputsReport = await runInstallManifest(
        { version: 1, tasks: [{ type: 'files', id: `${kind}-profile-inputs`, destination: gameRoot, files: inputs }] },
        executorOptions(options),
      )
    }

    let processorsRun = 0
    const processorOutputs: string[] = []
    const warnings: string[] = []
    if (!archive.isLegacy && (profile.processors?.length ?? 0) > 0) {
      const needsClientJar = (profile.processors ?? []).some((processor) =>
        (processor.args ?? []).some((argument) => argument.includes('{MINECRAFT_JAR}')),
      )
      if (needsClientJar) {
        options.onProgress?.({
          phase: 'base',
          message: 'Client-JAR für die Prozessoren wird geprüft',
          loader: kind,
        })
        await ensureClientJar(gameRoot, minecraftVersion, options)
      }
      const javaRuntimes = await resolveJavaRuntimesSafe(options, minecraftVersion, kind, version)
      const resolved = resolveProcessors(profile, {
        gameRoot,
        side: options.side ?? 'client',
        minecraftVersion,
        installerPath,
        javaRuntimes,
      })
      const pending: ResolvedProcessor[] = []
      for (const processor of resolved) {
        for (const output of processor.outputs) processorOutputs.push(output.path)
        if (
          processor.outputs.length > 0 &&
          (await diagnoseProcessorOutputs(processor.outputs)).length === 0
        ) {
          continue
        }
        for (const output of processor.outputs) await transaction.protect(output.path)
        pending.push(processor)
      }
      const tasks = buildProcessorTasks(pending, { id: `${kind}-${version}`, cwd: gameRoot })
      options.onProgress?.({ phase: 'processors', message: `${tasks.length} Prozessor(en)`, loader: kind })
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]
        const jarName = resolved[index]?.jarName ?? task.id
        options.onEvent?.({
          type: 'processor-start',
          jar: jarName,
          index: index + 1,
          total: tasks.length,
        })
        const runOptions: JavaTaskRunOptions = {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.logger ? { logger: options.logger.child('processors') } : {}),
          ...(options.useArgFile !== undefined ? { useArgFile: options.useArgFile } : {}),
          ...(options.processorRunner ? { runCommand: options.processorRunner } : {}),
          ...(options.onEvent
            ? {
                onLog: (line: string, stream: 'stdout' | 'stderr') =>
                  options.onEvent?.({ type: 'processor-log', jar: jarName, line, stream }),
              }
            : {}),
        }
        const result = await runJavaTask(task, runOptions)
        if (result.ran) processorsRun += 1
      }
    }

    const model = await resolveVersionModel(gameRoot, versionId, {
      ...(options.logger ? { logger: options.logger.child('resolve') } : {}),
    })
    const modelReport = await installModelFiles(gameRoot, model, options, `${kind}-${version}`)
    const report: InstallReport = {
      tasks: (inputsReport?.tasks ?? 0) + modelReport.tasks + 1,
      files: (inputsReport?.files ?? 0) + modelReport.files,
      downloadedFiles: (inputsReport?.downloadedFiles ?? 0) + modelReport.downloadedFiles,
      skippedFiles: (inputsReport?.skippedFiles ?? 0) + modelReport.skippedFiles,
      bytes: (inputsReport?.bytes ?? 0) + modelReport.bytes,
      downloadedBytes: (inputsReport?.downloadedBytes ?? 0) + modelReport.downloadedBytes,
      durationMs: (inputsReport?.durationMs ?? 0) + modelReport.durationMs,
    }

    return {
      model,
      report,
      processorsRun,
      alreadyInstalled:
        Boolean(previousMarker) &&
        previousMarker?.loader === kind &&
        previousMarker.loaderVersion === version &&
        report.downloadedFiles === 0,
      installerPath,
      ...(installerSha1 ? { installerSha1 } : {}),
      processorOutputs,
      warnings,
    }
  })

  await writeMarkerDirect(gameRoot, versionId, {
    loader: kind,
    loaderVersion: version,
    minecraftVersion,
    versionId,
    installedAt: new Date().toISOString(),
    installerPath: outcome.installerPath,
    ...(outcome.installerSha1 ? { installerSha1: outcome.installerSha1 } : {}),
    profilePath: profilePath(gameRoot, versionId),
    ...(outcome.processorOutputs.length > 0 ? { processorOutputs: outcome.processorOutputs } : {}),
    ...(options.mavenBase ? { mavenBase: options.mavenBase } : {}),
  })

  return {
    loader: kind,
    versionId,
    minecraftVersion,
    loaderVersion: version,
    model: outcome.model,
    alreadyInstalled: outcome.alreadyInstalled,
    filesReport: outcome.report,
    downloadedBytes: outcome.report.downloadedBytes,
    skippedFiles: outcome.report.skippedFiles,
    processorsRun: outcome.processorsRun,
    processorOutputs: outcome.processorOutputs.length,
    installerPath: outcome.installerPath,
    warnings: outcome.warnings,
  }
}

async function writeMarkerDirect(
  gameRoot: string,
  versionId: string,
  marker: LoaderInstallMarker,
): Promise<void> {
  await writeJsonFile(markerPath(gameRoot, versionId), marker)
}

async function resolveJavaRuntimesSafe(
  options: LoaderInstallOptions,
  minecraftVersion: string,
  kind: ForgeKind,
  loaderVersion: string,
): Promise<LoaderJavaRuntime[]> {
  const runtimes = await resolveJavaRuntimes(options)
  if (runtimes.every((runtime) => runtime.majorVersion === undefined)) return runtimes
  try {
    const preference = getJavaPreference({
      minecraftVersion,
      loader: kind === 'forge' ? 'forge' : 'neoforge',
      javaVersion: {},
    })
    const matching = runtimes.filter(
      (runtime) =>
        runtime.majorVersion === undefined ||
        preference.match({ majorVersion: runtime.majorVersion } as never),
    )
    if (matching.length > 0 && matching.length < runtimes.length) {
      options.logger?.warn('Prozessoren nutzen nur die passenden Java-Runtimes', {
        loader: kind,
        loaderVersion,
        requirement: preference.requirement,
        used: matching.map((runtime) => runtime.majorVersion ?? runtime.path),
        skipped: runtimes.length - matching.length,
      })
      return [...matching, ...runtimes.filter((runtime) => !matching.includes(runtime))]
    }
  } catch (error) {
    // Version parsing failed: keep the unfiltered runtime list.
    const log = options.logger ?? getDefaultLogger().child('loaders:forge')
    log.debug('Java runtime preference could not be parsed; keeping all runtimes', {
      loader: kind,
      loaderVersion,
      error: describeError(error),
    })
  }
  return runtimes
}

