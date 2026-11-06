import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { curseForgeFingerprint } from '../mods/fingerprint'
import type { LegacyCurseForge } from './curseforge'
import { sendBackgroundTaskProgress } from '../ipc-progress'
import { listInstanceWorlds } from '../instances/worlds'
import { installWorldArchive } from '../instances/world-install'
import type { Logger } from '../logger'

// Only the one function used here; importing the bridge's module types would
// drag the whole legacy pack-import surface into this file.
interface ContentBridge {
  removeLegacyContent(payload: unknown): Promise<boolean>
}

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: never[]) => unknown): void
}

interface IpcEvent {
  sender: { send(channel: string, payload: unknown): void }
}

interface ContentFileEntry {
  fileName?: unknown
  type?: unknown
}

interface JarMetadata {
  modName?: string
  modVersion?: string
  modLoader?: string
  mcVersion?: string | null
  iconBase64?: string | null
}

export interface ContentIpcOptions {
  gameRoot(): string
  profileDirOrNull(rootPath: string, folderName: unknown): string | null
  isInsideDirectory(parent: string, child: string): boolean
  downloadFolder(type: unknown): string
  logger: Logger
  markInstanceSizeDirty(folderName: string): void
  inspectJarMetadata(filePath: string): JarMetadata
  getBridge(): ContentBridge | null
  appVersion(): string
  curseForge: Pick<LegacyCurseForge, 'headers' | 'request'>
}

function hashFileSha1(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Content files: hash, identify, list, upload and delete inside one instance. */
export function registerContentIpc(ipc: IpcRegistrar, options: ContentIpcOptions): void {
  const logger = options.logger

  ipc.handle('delete-content-file', async (_event, payload) => {
    // The core owns content removal (containment check + empty-folder cleanup).
    // The legacy copy here used a raw prefix test and shipped in the app image
    // anyway, so two implementations of one delete existed.
    const modsBridge = options.getBridge()
    if (!modsBridge || typeof modsBridge.removeLegacyContent !== 'function') {
      return false
    }
    const result = await modsBridge.removeLegacyContent(payload)
    if (result) options.markInstanceSizeDirty((payload as { folderName?: string } | null)?.folderName ?? '')
    return result
  })

  ipc.handle('hash-content-files', async (_event, payload = {}) => {
    const { folderName, files } = (payload ?? {}) as { folderName?: string; files?: ContentFileEntry[] }
    const profilesDir = path.resolve(options.gameRoot(), 'profiles')
    const profileDir = path.resolve(profilesDir, String(folderName || ''))
    if (!folderName || !options.isInsideDirectory(profilesDir, profileDir) || !Array.isArray(files)) return {}
    const result: Record<string, string> = {}
    const entries = files
      .filter((file) => file && typeof file.fileName === 'string' && file.fileName.length > 0)
      .slice(0, 500)
    for (let index = 0; index < entries.length; index += 4) {
      const batch = entries.slice(index, index + 4)
      await Promise.all(batch.map(async (file) => {
        try {
          const fileName = String(file.fileName)
          const dir = path.resolve(profileDir, options.downloadFolder(file.type))
          if (!options.isInsideDirectory(profileDir, dir)) return
          const filePath = path.resolve(dir, path.basename(fileName))
          if (!options.isInsideDirectory(dir, filePath) || !existsSync(filePath)) return
          result[fileName] = await hashFileSha1(filePath)
        } catch (error) {
          logger.debug('hash-content-files: file could not be hashed', {
            file: file.fileName,
            error: (error as Error).message,
          })
        }
      }))
    }
    return result
  })

  // Identify locally added files through their content, not their file name:
  // Modrinth matches the SHA-1 of the exact released file, CurseForge matches its
  // Murmur2 fingerprint. Only an exact file match is accepted, so a mod that was
  // repacked or edited stays local instead of being labelled with a wrong project.
  ipc.handle('identify-content-files', async (_event, payload = {}) => {
    const { folderName, files } = (payload ?? {}) as { folderName?: string; files?: ContentFileEntry[] }
    const profilesDir = path.resolve(options.gameRoot(), 'profiles')
    const profileDir = path.resolve(profilesDir, String(folderName || ''))
    if (!folderName || !options.isInsideDirectory(profilesDir, profileDir) || !Array.isArray(files)) return {}
    const entries = files
      .filter((file) => file && typeof file.fileName === 'string' && file.fileName.length > 0)
      .slice(0, 100)

    const sha1ByFile = new Map<string, string>()
    const fingerprintByFile = new Map<string, number>()
    for (const entry of entries) {
      const fileName = String(entry.fileName)
      try {
        const dir = path.resolve(profileDir, options.downloadFolder(entry.type))
        if (!options.isInsideDirectory(profileDir, dir)) continue
        const filePath = path.resolve(dir, path.basename(fileName))
        if (!options.isInsideDirectory(dir, filePath) || !existsSync(filePath)) continue
        const buffer = readFileSync(filePath)
        sha1ByFile.set(fileName, createHash('sha1').update(buffer).digest('hex'))
        fingerprintByFile.set(fileName, curseForgeFingerprint(buffer) >>> 0)
      } catch (error) {
        logger.debug('identify-content-files: unreadable', {
          file: entry.fileName,
          error: (error as Error).message,
        })
      }
    }

    const result: Record<string, {
      source: string
      projectId: string
      name: string
      iconUrl: string
      versionNumber: string
    }> = {}
    const userAgent = `BambooLauncher/${options.appVersion()}`
    const hashes = [...new Set(sha1ByFile.values())]
    const versionsByHash = new Map<string, Record<string, unknown>>()
    for (let index = 0; index < hashes.length; index += 100) {
      try {
        const res = await fetch('https://api.modrinth.com/v2/version_files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
          body: JSON.stringify({ hashes: hashes.slice(index, index + 100), algorithm: 'sha1' }),
        })
        if (!res.ok) continue
        const data = await res.json()
        for (const [hash, version] of Object.entries(data || {})) {
          if (version && typeof version === 'object') versionsByHash.set(hash, version as Record<string, unknown>)
        }
      } catch (error) {
        logger.debug('identify-content-files: Modrinth hashes failed', { error: (error as Error).message })
      }
    }

    const projectIds = [...new Set(
      [...versionsByHash.values()].map((version) => version.project_id).filter(Boolean),
    )]
    const projectsById = new Map<string, Record<string, unknown>>()
    for (let index = 0; index < projectIds.length; index += 50) {
      try {
        const res = await fetch(
          `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds.slice(index, index + 50)))}`,
          { headers: { 'User-Agent': userAgent } },
        )
        if (!res.ok) continue
        const data = await res.json()
        for (const project of Array.isArray(data) ? data : []) {
          if (project && project.id) projectsById.set(String(project.id), project as Record<string, unknown>)
        }
      } catch (error) {
        logger.debug('identify-content-files: Modrinth projects failed', { error: (error as Error).message })
      }
    }

    for (const [fileName, hash] of sha1ByFile) {
      const version = versionsByHash.get(hash)
      const project = version && projectsById.get(String(version.project_id))
      if (!project || !project.slug) continue
      result[fileName] = {
        source: 'modrinth',
        projectId: String(project.slug),
        name: String(project.title || ''),
        iconUrl: String(project.icon_url || ''),
        versionNumber: String(version?.version_number || ''),
      }
    }

    const cfHeaders = options.curseForge.headers()
    const unmatched = entries.filter((entry) => !result[String(entry.fileName)] && fingerprintByFile.has(String(entry.fileName)))
    if (cfHeaders && unmatched.length > 0) {
      try {
        const fingerprints = [...new Set(unmatched.map((entry) => fingerprintByFile.get(String(entry.fileName))))]
        const res = await options.curseForge.request('https://api.curseforge.com/v1/fingerprints', {
          method: 'POST',
          headers: { ...cfHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprints }),
        })
        if (res.ok) {
          const payload = (await res.json()) as { data?: { exactMatches?: unknown } }
          const matches = (Array.isArray(payload.data?.exactMatches) ? payload.data.exactMatches : []) as Array<{
            file?: { modId?: unknown; fileName?: unknown; displayName?: unknown }
          }>
          const modIds = [...new Set(
            matches.map((match) => Number(match && match.file && match.file.modId)).filter((id) => id > 0),
          )].slice(0, 50)
          const modsById = new Map<number, Record<string, unknown>>()
          if (modIds.length > 0) {
            const modsRes = await options.curseForge.request('https://api.curseforge.com/v1/mods', {
              method: 'POST',
              headers: { ...cfHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ modIds }),
            })
            if (modsRes.ok) {
              const payload = (await modsRes.json()) as { data?: Array<Record<string, unknown>> }
              for (const mod of Array.isArray(payload.data) ? payload.data : []) {
                if (mod && mod.id) modsById.set(Number(mod.id), mod)
              }
            }
          }
          for (const match of matches) {
            const file = match && match.file
            const mod = file ? modsById.get(Number(file.modId)) : undefined
            if (!file || !mod) continue
            const fileName = String(file.fileName || '')
            if (!fileName || result[fileName]) continue
            const logo = (mod.logo as { thumbnailUrl?: string; url?: string } | undefined)
            result[fileName] = {
              source: 'curseforge',
              projectId: String(mod.id),
              name: String(mod.name || ''),
              iconUrl: logo?.thumbnailUrl || logo?.url || '',
              versionNumber: String(file.displayName || file.fileName || ''),
            }
          }
        }
      } catch (error) {
        logger.debug('identify-content-files: CurseForge fingerprints failed', { error: (error as Error).message })
      }
    }
    return result
  })

  ipc.handle('list-content-files', async (_event, payload) => {
    const { folderName, type } = (payload ?? {}) as { folderName?: string; type?: string }
    const profilesDir = path.join(options.gameRoot(), 'profiles')
    if (!folderName) {
      logger.warn('list-content-files: missing folderName')
      return []
    }
    const dir = path.resolve(profilesDir, folderName, options.downloadFolder(type))
    if (!options.isInsideDirectory(profilesDir, dir)) {
      logger.warn('list-content-files: path escapes profiles directory', { dir })
      return []
    }
    if (!existsSync(dir)) {
      return []
    }
    try {
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
      logger.debug('list-content-files: listed', { dir, count: files.length })
      return files
    } catch (error) {
      logger.error('list-content-files failed', { dir, error: (error as Error).message })
      return []
    }
  })

  ipc.handle('list-instance-worlds', async (_event, folderName) => {
    const profilesDir = path.resolve(options.gameRoot(), 'profiles')
    if (!folderName) {
      logger.warn('list-instance-worlds: missing folderName')
      return []
    }
    const savesDir = path.resolve(profilesDir, String(folderName), 'saves')
    if (!options.isInsideDirectory(profilesDir, savesDir)) {
      logger.warn('list-instance-worlds: path escapes profiles directory', { savesDir })
      return []
    }
    try {
      const worlds = listInstanceWorlds(savesDir)
      logger.debug('list-instance-worlds: listed', { folderName, count: worlds.length, savesDir })
      return worlds
    } catch (error) {
      logger.error('list-instance-worlds failed', { folderName, error: (error as Error).message })
      return []
    }
  })

  ipc.handle('upload-local-mod', async (event, payload) => {
    const { folderName, filePath, itemType, taskId } = (payload ?? {}) as {
      folderName?: string
      filePath?: string
      itemType?: string
      taskId?: string
    }
    const instanceDir = options.profileDirOrNull(options.gameRoot(), folderName)
    if (!instanceDir) return { success: false, error: 'Ungültiger Instanzordner.', code: 'invalid-folder' }
    const emitTaskProgress = (percent: unknown, label: unknown) => {
      if (!taskId) return
      sendBackgroundTaskProgress(event, {
        id: taskId,
        percent: typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : null,
        label: String(label || ''),
      }, logger, 'upload-local-mod')
    }
    // A world archive is not content: it is extracted into saves/<world>, which is
    // exactly where the game reads it and where the Worlds tab detects it.
    if (itemType === 'world' || itemType === 'worlds') {
      try {
        const archivePath = String(filePath || '')
        const fileName = path.basename(archivePath)
        const preferredName = fileName.replace(/\.(zip|mcworld)$/i, '')
        emitTaskProgress(2, `Welt wird entpackt: ${fileName}`)
        const result = await installWorldArchive({
          instanceDir,
          archivePath,
          preferredName,
          onProgress: ({ done, total }) => {
            emitTaskProgress(
              total > 0 ? 4 + (done / total) * 92 : null,
              `Welt wird installiert: ${done}/${total || '?'} Dateien`,
            )
          },
        })
        const worlds = result.worlds.map((world) => ({
          folderName: world.folderName,
          path: world.path,
          renamed: world.renamed,
          files: world.files,
        }))
        emitTaskProgress(100, `Welt installiert: ${worlds[0]?.folderName || fileName}`)
        logger.info('upload-local-mod: world installed', { folderName, worlds })
        return {
          success: true,
          fileName,
          destPath: worlds[0] ? worlds[0].path : instanceDir,
          itemType: 'saves',
          worlds,
        }
      } catch (error) {
        logger.error('upload-local-mod failed', { folderName, itemType, error: (error as Error).message })
        return {
          success: false,
          fileName: filePath ? path.basename(filePath) : '',
          error: (error as Error).message,
          code: 'upload-failed',
        }
      }
    }
    // Every pack type uses the shared mapping, so "shader"/"resourcepack"/
    // "datapack" never become literal folder names.
    const subDir = options.downloadFolder(itemType)
    try {
      const sourcePath = String(filePath || '')
      const fileName = path.basename(sourcePath)
      const destDir = path.join(instanceDir, subDir)
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      const destPath = path.join(destDir, fileName)
      copyFileSync(sourcePath, destPath)
      let modName = fileName.replace(/\.(jar|zip|disabled)$/i, '').replace(/-\d+\.\d+[^/]*$/i, '')
      let modVersion = (fileName.match(/-([\d.]+)/) || [])[1] || 'unknown'
      let modLoader = 'unknown'
      const mcVersion: string | null = null
      let iconBase64: string | null = null
      if (fileName.endsWith('.jar')) {
        try {
          const meta = options.inspectJarMetadata(sourcePath)
          if (meta.modName) modName = meta.modName
          if (meta.modVersion) modVersion = meta.modVersion
          if (meta.modLoader) modLoader = meta.modLoader
          if (meta.iconBase64) iconBase64 = meta.iconBase64
        } catch (error) {
          logger.debug('upload-local-mod: metadata unreadable', { destPath, error: (error as Error).message })
        }
      }
      if (modLoader === 'unknown') {
        if (fileName.includes('-fabric')) modLoader = 'fabric'
        else if (fileName.includes('-forge')) modLoader = 'forge'
        else if (fileName.includes('-neoforge')) modLoader = 'neoforge'
      }
      emitTaskProgress(100, `Datei installiert: ${fileName}`)
      options.markInstanceSizeDirty(String(folderName))
      return { success: true, fileName, destPath, modName, modVersion, modLoader, mcVersion, iconBase64, itemType: subDir }
    } catch (error) {
      return {
        success: false,
        fileName: filePath ? path.basename(filePath) : '',
        error: (error as Error).message,
      }
    }
  })
}
