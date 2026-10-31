import { mkdtemp, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitInstalledFile } from '../content-state'
import { CurseForgeClient, curseForgeFileIdFromUrl } from '../curseforge'
import { installModrinthProject, type ContentFolder } from '../installer'
import { ModrinthClient, modrinthVersionIdFromCdnUrl } from '../modrinth'
import { installWorldArchive, type InstalledWorld } from '../../instances/world-install'
import { resolveFileInside } from '../paths'
import { legacyGameRoot } from '../../paths'
import {
  asRecord,
  downloadFolder,
  instanceIndex,
  legacyInstanceDir,
  type LegacyBridgeOptions,
  type LegacyPayload,
} from './shared'

export interface LegacyModInstallResult {
  success: true
  path: string
  size: number
  /** Set for world installs: the folders this install created inside `saves`. */
  worlds?: InstalledWorld[]
}

/** `itemType` values that mean "this archive is a world", not instance content. */
export function isWorldItemType(itemType: unknown): boolean {
  return itemType === 'world' || itemType === 'worlds'
}

export async function installLegacyMod(
  payload: LegacyPayload | undefined,
  options: LegacyBridgeOptions = {},
): Promise<LegacyModInstallResult> {
  const data = asRecord(payload)
  const rootPath = options.rootPath ?? legacyGameRoot()
  const folderName = typeof data.folderName === 'string' ? data.folderName : ''
  const filename = typeof data.filename === 'string' ? data.filename : ''
  const downloadUrl = typeof data.downloadUrl === 'string' ? data.downloadUrl : ''
  const curseforgeFileId =
    typeof data.curseforgeFileId === 'number' && Number.isFinite(data.curseforgeFileId)
      ? data.curseforgeFileId
      : undefined
  if (!folderName || !filename || (!downloadUrl && curseforgeFileId === undefined)) {
    throw new Error(
      'Unvollständige Download-Daten: folderName, filename und downloadUrl (oder curseforgeFileId) fehlen',
    )
  }
  const instanceDir = legacyInstanceDir(rootPath, folderName)
  const preferredName =
    typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : undefined
  const taskId = typeof data.taskId === 'string' && data.taskId.trim() !== '' ? data.taskId.trim() : ''

  // Worlds are folders with level.dat inside `saves`; they must never be placed
  // as an archive in a content folder, so they take their own path here.
  if (isWorldItemType(data.itemType)) {
    return installWorld({
      options,
      instanceDir,
      filename,
      downloadUrl,
      ...(curseforgeFileId !== undefined ? { curseforgeFileId } : {}),
      ...(preferredName ? { preferredName } : {}),
      ...(taskId ? { taskId } : {}),
    })
  }

  const folder = downloadFolder(data.itemType)
  resolveFileInside(instanceDir, folder, filename)

  const modrinthVersionId = downloadUrl ? modrinthVersionIdFromCdnUrl(downloadUrl) : undefined
  if (!modrinthVersionId) {
    const curseForgeFileId = curseforgeFileId ?? (downloadUrl ? curseForgeFileIdFromUrl(downloadUrl) : undefined)
    if (curseForgeFileId) {
      return installCurseForgeFile({
        options,
        instanceDir,
        folder,
        filename,
        fileId: curseForgeFileId,
      })
    }
    throw new Error(
      'Download ohne prüfbaren Hash abgebrochen: Die URL ist weder Modrinth-CDN noch CurseForge-CDN',
    )
  }

  const client = new ModrinthClient({
    ...(options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    logger: options.logger,
  })
  const version = await client.version(modrinthVersionId)
  const result = await installModrinthProject({
    instanceDir,
    projectId: version.projectId,
    minecraftVersion: typeof data.versionId === 'string' ? data.versionId : '',
    client,
    folder,
    version,
    withDependencies: false,
    index: instanceIndex(instanceDir, options.logger),
    logger: options.logger,
  })
  const installedName =
    result.installed[0] ?? result.skipped[0] ?? version.files.find((file) => file.primary)?.filename
  if (!installedName) throw new Error('Installation lieferte keine Datei')
  const installedPath = resolveFileInside(instanceDir, folder, installedName)
  const info = await stat(installedPath)
  return { success: true, path: installedPath, size: info.size }
}

interface WorldInstallInput {
  options: LegacyBridgeOptions
  instanceDir: string
  filename: string
  downloadUrl: string
  curseforgeFileId?: number
  preferredName?: string
  taskId?: string
}

/**
 * Downloads a world archive with the same hash verification as any other
 * content, then hands it to the world installer (which extracts it into
 * `saves/<world>`). The archive itself is transient and removed afterwards.
 */
async function installWorld(input: WorldInstallInput): Promise<LegacyModInstallResult> {
  const { options, instanceDir, filename } = input
  const taskId = input.taskId
  const emitTask = (percent: number | null, label: string) => {
    if (!taskId || !options.onBackgroundTask) return
    options.onBackgroundTask({ id: taskId, percent, label })
  }
  emitTask(2, `Welt wird heruntergeladen: ${filename}`)
  const workDir = await mkdtemp(join(tmpdir(), 'bamboo-world-'))
  try {
    let archivePath: string
    let bytes = 0
    const modrinthVersionId = input.downloadUrl ? modrinthVersionIdFromCdnUrl(input.downloadUrl) : undefined
    if (modrinthVersionId) {
      const client = new ModrinthClient({
        ...(options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        logger: options.logger,
      })
      const version = await client.version(modrinthVersionId)
      const file =
        version.files.find((entry) => entry.filename === filename) ??
        version.files.find((entry) => entry.primary) ??
        version.files[0]
      if (!file) throw new Error('Welt-Version ohne herunterladbare Datei')
      archivePath = join(workDir, basename(file.filename))
      const download = await client.downloadVersion(version, archivePath)
      bytes = download.bytes
    } else if (input.curseforgeFileId !== undefined) {
      const { client, file } = await curseForgeFile({
        options,
        fileId: input.curseforgeFileId,
        filename: input.filename,
      })
      archivePath = join(workDir, basename(file.fileName || filename))
      const download = await client.download(file, archivePath)
      bytes = download?.bytes ?? 0
    } else {
      throw new Error('Welt-Download ohne prüfbaren Hash abgebrochen')
    }

    emitTask(5, 'Welt wird entpackt…')
    const installed = await installWorldArchive({
      instanceDir,
      archivePath,
      ...(input.preferredName ? { preferredName: input.preferredName } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      onProgress: ({ done, total }) => {
        emitTask(
          total > 0 ? 5 + (done / total) * 94 : null,
          `Welt wird installiert: ${done}/${total || '?'} Dateien`,
        )
      },
    })
    const first = installed.worlds[0]
    emitTask(100, `Welt installiert: ${first?.folderName || filename}`)
    return {
      success: true,
      path: first.path,
      size: bytes,
      worlds: installed.worlds,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface CurseForgeFileInput {
  options: LegacyBridgeOptions
  fileId: number
  filename: string
}

/** The verified CurseForge file record, or an explicit error (never a silent pick). */
async function curseForgeFile(input: CurseForgeFileInput) {
  const { options } = input
  if (!options.curseforgeApiKey) {
    throw new Error(
      'CurseForge-Download kann ohne API-Key nicht verifiziert werden. Bitte in den Einstellungen hinterlegen.',
    )
  }
  const client = new CurseForgeClient({
    apiKey: options.curseforgeApiKey,
    ...(options.curseforgeBaseUrl ? { baseUrl: options.curseforgeBaseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    logger: options.logger,
  })
  const [file] = await client.filesByIds([input.fileId])
  if (!file) {
    throw new Error(`CurseForge-Datei ${input.fileId} wurde nicht gefunden; Download abgebrochen`)
  }
  if (file.fileName && file.fileName.toLowerCase() !== input.filename.toLowerCase()) {
    throw new Error(
      `CurseForge-Dateiname stimmt nicht mit der Anfrage überein (${file.fileName} statt ${input.filename})`,
    )
  }
  if (!file.hashes.find((hash) => hash.algo === 1)?.value) {
    throw new Error(
      `CurseForge liefert für Datei ${input.fileId} keinen SHA-1-Hash; Download ohne Prüfung abgebrochen`,
    )
  }
  return { client, file }
}

interface CurseForgeInstallInput {
  options: LegacyBridgeOptions
  instanceDir: string
  folder: ContentFolder
  filename: string
  fileId: number
}

async function installCurseForgeFile(
  input: CurseForgeInstallInput,
): Promise<LegacyModInstallResult> {
  const { options, instanceDir, folder, filename, fileId } = input
  const { client, file } = await curseForgeFile({ options, fileId, filename })
  const destination = resolveFileInside(instanceDir, folder, filename)
  await client.download(file, destination)
  await commitInstalledFile({
    instanceDir,
    path: `${folder}/${filename}`,
    record: {
      projectId: String(file.modId),
      versionId: String(file.id),
      versionNumber: file.displayName,
      name: file.fileName || filename,
      source: 'curseforge',
    },
    index: instanceIndex(instanceDir, options.logger),
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const info = await stat(destination)
  return { success: true, path: destination, size: info.size }
}
