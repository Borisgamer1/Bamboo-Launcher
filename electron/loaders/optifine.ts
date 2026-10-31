import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { runInstallManifest } from '../download/executor'
import type { InstallFile } from '../download/types'
import { resolveVersionModel } from '../version/resolve'
import { LoaderError } from './errors'
import {
  DEFAULT_OPTIFINE_MIRROR,
  listLoaderVersions,
  optifineInstallerUrl,
  pickLoaderVersion,
} from './metadata'
import {
  ensureBaseVersion,
  ensureClientJar,
  executorOptions,
  hasVersionJson,
  installModelFiles,
  readMarker,
  resolveJavaRuntimes,
  writeMarker,
  writeVersionJson,
} from './common'
import { LoaderTransaction } from './transaction'
import { buildProcessorTasks, resolveProcessors } from './profile-postprocess'
import { diagnoseProcessorOutput, runJavaTask } from './java-task'
import type {
  InstallProfile,
  LoaderInstallOptions,
  LoaderInstallResult,
  LoaderVersionEntry,
  ProcessorOutput,
} from './types'

export function optifineVersionId(minecraftVersion: string, edition: string): string {
  return `${minecraftVersion}-OptiFine_${edition}`
}

export function normalizeOptifineEdition(value: string, minecraftVersion: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith(`${minecraftVersion}_`)) return trimmed.slice(minecraftVersion.length + 1)
  const filename = /OptiFine_(?:\d[^_]*)_(.+)\.jar$/i.exec(trimmed)
  if (filename?.[1]) return filename[1]
  return trimmed
}

export function optifinePatchedJarPath(gameRoot: string, minecraftVersion: string, edition: string): string {
  const base = `optifine/Optifine/${minecraftVersion}_${edition}/Optifine-${minecraftVersion}_${edition}.jar`
  return join(gameRoot, 'libraries', base)
}

export function optifineLaunchWrapperPath(gameRoot: string, version: string): string {
  return join(gameRoot, 'libraries', `optifine/launchwrapper-of/${version}/launchwrapper-of-${version}.jar`)
}

export function generateOptifineVersionJson(
  minecraftVersion: string,
  edition: string,
  launchWrapperVersion: string | undefined,
): Record<string, unknown> {
  const id = optifineVersionId(minecraftVersion, edition)
  const now = new Date().toISOString()
  const linked: Array<Record<string, unknown>> = []
  if (launchWrapperVersion) {
    linked.push({
      name: `optifine:launchwrapper-of:${launchWrapperVersion}`,
      downloads: {
        artifact: {
          path: `optifine/launchwrapper-of/${launchWrapperVersion}/launchwrapper-of-${launchWrapperVersion}.jar`,
          url: '',
        },
      },
    })
  } else {
    linked.push({
      name: 'net.minecraft:launchwrapper:1.12',
      downloads: {
        artifact: {
          path: 'net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar',
          url: 'https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar',
        },
      },
    })
  }
  linked.push({
    name: `optifine:Optifine:${minecraftVersion}_${edition}`,
    downloads: {
      artifact: {
        path: `optifine/Optifine/${minecraftVersion}_${edition}/Optifine-${minecraftVersion}_${edition}.jar`,
        url: '',
      },
    },
  })
  return {
    id,
    inheritsFrom: minecraftVersion,
    time: now,
    releaseTime: now,
    type: 'release',
    minimumLauncherVersion: 21,
    mainClass: 'net.minecraft.launchwrapper.Launch',
    arguments: {
      game: ['--tweakClass', 'optifine.OptiFineTweaker'],
      jvm: [],
    },
    libraries: linked,
  }
}

async function pickOptifineEntry(
  options: LoaderInstallOptions,
): Promise<{ entry: LoaderVersionEntry; edition: string }> {
  const mirror = options.optifineMirror ?? DEFAULT_OPTIFINE_MIRROR
  if (options.loaderVersion) {
    const edition = normalizeOptifineEdition(options.loaderVersion, options.minecraftVersion)
    const parts = edition.split('_')
    const type = parts.slice(0, 2).join('_')
    const patch = parts.slice(2).join('_')
    if (type && patch) return { entry: { version: edition, type, patch }, edition }
  }
  const list = await listLoaderVersions('optifine', {
    minecraftVersion: options.minecraftVersion,
    optifineMirror: mirror,
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const picked = pickLoaderVersion(list.versions, options.loaderVersion)
  if (!picked?.type || !picked.patch) {
    throw new LoaderError('metadata', `OptiFine-Eintrag unvollständig für ${options.minecraftVersion}`)
  }
  return { entry: picked, edition: `${picked.type}_${picked.patch}` }
}

async function patchedJarValid(file: string): Promise<boolean> {
  return (await diagnoseProcessorOutput({ path: file, validator: 'zip' })) === undefined
}

export async function installOptifine(options: LoaderInstallOptions): Promise<LoaderInstallResult> {
  const gameRoot = options.gameRoot
  const minecraftVersion = options.minecraftVersion
  const { entry, edition } = await pickOptifineEntry(options)
  const versionId = options.versionId ?? optifineVersionId(minecraftVersion, edition)
  const installerUrl =
    options.installerUrl ??
    optifineInstallerUrl(minecraftVersion, entry, options.optifineMirror ?? DEFAULT_OPTIFINE_MIRROR)
  const transaction = new LoaderTransaction(gameRoot, 'optifine')

  const outcome = await transaction.run<{
    model: Awaited<ReturnType<typeof resolveVersionModel>>
    report: Awaited<ReturnType<typeof installModelFiles>>
    processorsRun: number
    alreadyInstalled: boolean
    installerPath: string
  }>(async () => {
    if (options.signal?.aborted) throw new LoaderError('aborted', 'Loader-Installation abgebrochen')
    await ensureBaseVersion(gameRoot, minecraftVersion, options)

    const installerRelative = `versions/${versionId}/OptiFine_${minecraftVersion}_${edition}.jar`
    const installerPath = join(gameRoot, installerRelative)
    const installerFile: InstallFile = {
      path: installerRelative,
      urls: [installerUrl],
      validator: 'zip',
    }
    await runInstallManifest(
      {
        version: 1,
        tasks: [{ type: 'files', id: 'optifine-installer', destination: gameRoot, files: [installerFile] }],
      },
      executorOptions(options),
    )

    let launchWrapperVersion: string | undefined
    try {
      const zip = new AdmZip(installerPath)
      const text = zip.getEntry('launchwrapper-of.txt')
      if (text && !text.isDirectory) launchWrapperVersion = text.getData().toString('utf8').trim() || undefined
      if (launchWrapperVersion) {
        const wrapperEntry = zip.getEntry(`launchwrapper-of-${launchWrapperVersion}.jar`)
        if (wrapperEntry && !wrapperEntry.isDirectory) {
          await transaction.write(
            optifineLaunchWrapperPath(gameRoot, launchWrapperVersion),
            wrapperEntry.getData(),
          )
        }
      }
    } catch (error) {
      throw new LoaderError('installer', `OptiFine-Installer nicht lesbar: ${installerPath}`, { cause: error })
    }

    const marker = await readMarker(gameRoot, versionId)
    const jsonExists = await hasVersionJson(gameRoot, versionId)
    const repeat =
      jsonExists &&
      marker?.loader === 'optifine' &&
      marker.loaderVersion === entry.version &&
      marker.minecraftVersion === minecraftVersion
    if (!repeat) {
      await writeVersionJson(
        transaction,
        gameRoot,
        versionId,
        generateOptifineVersionJson(minecraftVersion, edition, launchWrapperVersion),
      )
    }

    const patchedJar = optifinePatchedJarPath(gameRoot, minecraftVersion, edition)
    const model = await resolveVersionModel(gameRoot, versionId, {
      ...(options.logger ? { logger: options.logger.child('resolve') } : {}),
    })

    let processorsRun = 0
    if (!repeat || !(await patchedJarValid(patchedJar))) {
      options.onProgress?.({ phase: 'base', message: 'Client-JAR für den Patcher wird geprüft', loader: 'optifine' })
      await ensureClientJar(gameRoot, minecraftVersion, options)
      await transaction.protect(patchedJar)
      await transaction.ensureDir(dirname(patchedJar))
      const javaRuntimes = await resolveJavaRuntimes(options)
      const profileLike: InstallProfile = {
        profile: 'optifine',
        version: versionId,
        json: 'version.json',
        path: '',
        minecraft: minecraftVersion,
        processors: [
          {
            jar: installerPath,
            classpath: [],
            args: [
              join(gameRoot, 'versions', minecraftVersion, `${minecraftVersion}.jar`),
              installerPath,
              patchedJar,
            ],
          },
        ],
      }
      const resolved = resolveProcessors(profileLike, {
        gameRoot,
        side: 'client',
        minecraftVersion,
        installerPath,
        javaRuntimes,
      })
      for (const processor of resolved) processor.mainClass = 'optifine.Patcher'
      const outputs: ProcessorOutput[] = [{ path: patchedJar, validator: 'zip' }]
      const tasks = buildProcessorTasks(resolved, { id: 'optifine-patcher', cwd: gameRoot })
      for (const task of tasks) task.outputs = outputs
      for (const task of tasks) {
        const result = await runJavaTask(task, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.logger ? { logger: options.logger.child('patcher') } : {}),
          ...(options.processorRunner ? { runCommand: options.processorRunner } : {}),
          ...(options.onEvent
            ? {
                onLog: (line: string, stream: 'stdout' | 'stderr') =>
                  options.onEvent?.({ type: 'processor-log', jar: 'optifine.Patcher', line, stream }),
              }
            : {}),
        })
        if (result.ran) processorsRun += 1
      }
    }

    options.onProgress?.({ phase: 'inputs', message: 'OptiFine-Bibliotheken werden geprüft', loader: 'optifine' })
    const report = await installModelFiles(gameRoot, model, options, `optifine-${edition}`)
    await writeMarker(transaction, gameRoot, versionId, {
      loader: 'optifine',
      loaderVersion: entry.version,
      minecraftVersion,
      versionId,
      installedAt: new Date().toISOString(),
      installerPath,
      optifineEdition: edition,
      processorOutputs: [patchedJar],
      ...(options.optifineMirror ? { optifineMirror: options.optifineMirror } : {}),
    })
    return {
      model,
      report,
      processorsRun,
      alreadyInstalled: repeat && report.downloadedFiles === 0,
      installerPath,
    }
  })

  return {
    loader: 'optifine',
    versionId,
    minecraftVersion,
    loaderVersion: entry.version,
    model: outcome.model,
    alreadyInstalled: outcome.alreadyInstalled,
    filesReport: outcome.report,
    downloadedBytes: outcome.report.downloadedBytes,
    skippedFiles: outcome.report.skippedFiles,
    processorsRun: outcome.processorsRun,
    processorOutputs: 1,
    installerPath: outcome.installerPath,
    warnings: [],
  }
}
