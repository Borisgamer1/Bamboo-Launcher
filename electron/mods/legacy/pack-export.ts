import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ModrinthClient } from '../modrinth'
import { exportModpack, type ExportFileReference } from '../export'
import { legacyGameRoot } from '../../paths'
import { describeError, getDefaultLogger } from '../../logger'
import { instanceLoaderKey, normalizeDependencies } from './pack-format'
import {
  asRecord,
  legacyInstanceDir,
  profileSlug,
  type LegacyBridgeOptions,
  type LegacyPayload,
} from './shared'

export interface LegacyExportResult {
  success: boolean
  filePath?: string
  fileName?: string
  fileSize?: number
  error?: string
}

function contentReference(path: string): boolean {
  return /^(mods|resourcepacks|shaderpacks|datapacks)\//.test(path.replace(/\\/g, '/'))
}

export async function exportLegacyProfile(
  payload: LegacyPayload | undefined,
  options: LegacyBridgeOptions = {},
): Promise<LegacyExportResult> {
  const data = asRecord(payload)
  const rootPath = options.rootPath ?? legacyGameRoot()
  const folderName = typeof data.folderName === 'string' ? data.folderName : ''
  const instanceName = typeof data.instanceName === 'string' ? data.instanceName : 'instance'
  if (!folderName) return { success: false, error: 'folderName fehlt' }
  const instanceDir = legacyInstanceDir(rootPath, folderName)
  if (!(await stat(instanceDir).catch(() => undefined))) {
    return { success: false, error: `Instanz nicht gefunden: ${instanceDir}` }
  }

  const index = asRecord(data.mrpackIndex)
  const manifest = asRecord(data.manifest)
  const instance = asRecord(manifest.instance)
  const dependencies = normalizeDependencies(index.dependencies)
  if (!dependencies.minecraft && typeof instance.minecraftVersion === 'string') {
    dependencies.minecraft = instance.minecraftVersion
  }
  const loaderKey = instanceLoaderKey(instance.modloader)
  const loaderVersion = typeof instance.modloaderVersion === 'string' ? instance.modloaderVersion : ''
  if (loaderKey && !dependencies[loaderKey] && loaderVersion) {
    dependencies[loaderKey] = loaderVersion
  }
  const selection = asRecord(data.options)
  const exclude: string[] = []
  const allow: string[] = []
  if (selection.includeMods === false) exclude.push('mods')
  if (selection.includeResourcepacks === false) exclude.push('resourcepacks')
  if (selection.includeShaderpacks === false) exclude.push('shaderpacks')
  if (selection.includeDatapacks === false) exclude.push('datapacks')
  if (selection.includeConfig === false) exclude.push('config')
  if (selection.includeWorlds === true) allow.push('saves')
  if (selection.includeScreenshots === true) allow.push('screenshots')

  const fileName =
    (typeof data.suggestedFileName === 'string' && data.suggestedFileName) ||
    `${profileSlug(instanceName)}.mrpack`
  const destination =
    (typeof data.savePath === 'string' && data.savePath) || join(rootPath, 'cache', fileName)

  const client = new ModrinthClient({
    ...(options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    logger: options.logger,
  })
  const references = new Map<string, ExportFileReference | undefined>()
  const resolveFile = async (input: {
    path: string
    sha1: string
  }): Promise<ExportFileReference | undefined> => {
    if (!contentReference(input.path)) return undefined
    if (references.has(input.sha1)) return references.get(input.sha1)
    let reference: ExportFileReference | undefined
    try {
      const version = await client.versionFile(input.sha1)
      const file = version?.files.find((entry) => entry.primary) ?? version?.files[0]
      if (version && file?.url && file.hashes?.sha1?.toLowerCase() === input.sha1.toLowerCase()) {
        reference = { downloads: [file.url] }
      }
    } catch (error) {
      // Unresolvable file: export continues without a download reference.
      const log = options.logger ?? getDefaultLogger().child('mods:legacy-export')
      log.debug('legacy export: file has no resolvable download reference', {
        path: input.path,
        sha1: input.sha1,
        error: describeError(error),
      })
    }
    references.set(input.sha1, reference)
    return reference
  }

  try {
    const result = await exportModpack({
      instanceDir,
      destination,
      name:
        (typeof index.name === 'string' && index.name) ||
        (typeof instance.name === 'string' && instance.name) ||
        instanceName,
      ...(typeof index.versionId === 'string' ? { versionId: index.versionId } : {}),
      ...(typeof index.summary === 'string' ? { summary: index.summary } : {}),
      dependencies,
      resolveFile,
      exclude,
      allow,
      logger: options.logger,
    })
    const info = await stat(result.archive)
    return {
      success: true,
      filePath: result.archive,
      fileName: basename(result.archive),
      fileSize: info.size,
    }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}
