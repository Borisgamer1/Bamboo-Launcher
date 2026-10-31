import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CurseForgeClient } from '../curseforge'
import { ModrinthClient } from '../modrinth'
import {
  loaderFromCurseForgeId,
  installModpack,
  planCurseForgeContent,
  readCurseForgeManifest,
  readModpackFormat,
  readMrpackManifest,
} from '../modpack'
import { ModError } from '../errors'
import { withZip, type ZipArchive, type ZipEntryInfo } from '../zip'
import { legacyGameRoot } from '../../paths'
import { describeError, getDefaultLogger } from '../../logger'
import { loaderInfo, normalizeDependencies } from './pack-format'
import {
  asRecord,
  isEnabled,
  legacyInstanceDir,
  profileSlug,
  type LegacyBridgeOptions,
  type LegacyPayload,
} from './shared'

export interface LegacyPreviewResult {
  format: 'mrpack' | 'zip'
  title: string
  minecraftVersion: string
  modloader: string
  modloaderVersion: string
  description: string
  author: string
  fileSize: number
  totalFiles: number
  modCount: number
  resourcepackCount: number
  shaderCount: number
  datapackCount: number
  worldCount: number
  hasIcon: boolean
  hasBanner: boolean
  hasConfig: boolean
  hasScreenshots: boolean
  worlds?: string[]
  isModpack: boolean
}

export interface LegacyImportResult {
  success: boolean
  instanceId?: string
  instanceName?: string
  modsInstalled?: number
  resourcepacksInstalled?: number
  shaderpacksInstalled?: number
  datapacksInstalled?: number
  worldsImported?: number
  /** The exact record written to profiles.json; the renderer maps this once. */
  profile?: LegacyPayload
  error?: string
}

type ArchiveKind = 'mrpack' | 'curseforge' | 'profile' | 'content'

interface ArchiveInfo {
  kind: ArchiveKind
  manifest?: LegacyPayload
}

interface ArchiveMetadata {
  name: string
  versionId: string
  minecraftVersion: string
  loader: string
  loaderVersion: string
  description: string
  author: string
  isModpack: boolean
  modpackSource?: 'modrinth' | 'curseforge'
  modpackVersion?: string
  ram: number
  javaPath: string
}

const METADATA_FILES = new Set([
  'modrinth.index.json',
  'curseforge.manifest.json',
  'modpack.lock.json',
  'manifest.json',
  'overrides',
  'client-overrides',
])

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined))
}

async function readProfiles(file: string): Promise<LegacyPayload[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.map(asRecord) : []
  } catch (error) {
    getDefaultLogger().child('mods:legacy-import').warn(
      'legacy import: profiles.json is unreadable; continuing without existing names',
      { file, error: describeError(error) },
    )
    return []
  }
}

async function uniqueProfileFolder(
  rootPath: string,
  base: string,
  profiles: LegacyPayload[],
): Promise<string> {
  const used = new Set(
    profiles
      .map((profile) => profileSlug(String(profile.folderName || profile.name || '')))
      .filter(Boolean)
      .map((folder) => folder.toLowerCase()),
  )
  const slug = profileSlug(base)
  let candidate = slug
  let index = 2
  while (used.has(candidate.toLowerCase()) || (await exists(legacyInstanceDir(rootPath, candidate)))) {
    candidate = `${slug}-${index}`
    index += 1
  }
  return candidate
}

async function detectArchive(archivePath: string): Promise<ArchiveInfo> {
  let format: 'mrpack' | 'curseforge' | undefined
  try {
    format = await readModpackFormat(archivePath)
  } catch (error) {
    if (!(error instanceof ModError) || error.code !== 'not-a-modpack') throw error
  }
  if (format) return { kind: format }

  return withZip(archivePath, async (zip) => {
    if (zip.has('manifest.json')) {
      let raw: LegacyPayload
      try {
        raw = asRecord(JSON.parse((await zip.read('manifest.json')).toString('utf8')))
      } catch (error) {
        throw new Error(`manifest.json ist ungültig: ${(error as Error).message}`, { cause: error })
      }
      return { kind: 'profile', manifest: raw }
    }
    const hasContent = zip.entries.some((entry) =>
      /^(mods|resourcepacks|shaderpacks|datapacks)\//.test(entry.name),
    )
    if (hasContent) return { kind: 'content' }
    throw new Error('Unbekanntes ZIP-Format. Keine Mods, Modpack- oder Profildaten gefunden.')
  })
}

async function extractArchive(
  archivePath: string,
  destination: string,
  report: (percent: number, label: string) => void,
  start: number,
  end: number,
): Promise<void> {
  await withZip(archivePath, (zip) =>
    zip.extractAll(destination, (relative, done, total) => {
      const percent = start + Math.round((done / Math.max(1, total)) * (end - start))
      report(percent, `Entpacke ${basename(relative)}`)
    }),
  )
}

function archiveIconEntry(zip: ZipArchive, manifest?: LegacyPayload): ZipEntryInfo | undefined {
  const overridePrefix = asRecord(manifest).overrides
  const prefixes =
    typeof overridePrefix === 'string' && overridePrefix
      ? [overridePrefix.replace(/\\/g, '/').replace(/\/+$/, ''), 'overrides', 'client-overrides']
      : ['overrides', 'client-overrides']
  const candidates = ['icon.png', 'icon.jpg', ...prefixes.map((prefix) => `${prefix}/icon.png`)]
  for (const candidate of candidates) {
    const entry = zip.entries.find((item) => item.name === candidate)
    if (!entry || entry.isDirectory || entry.size === 0) continue
    return entry
  }
  return undefined
}

function manifestIconData(manifest?: LegacyPayload): string {
  const icon = asRecord(asRecord(manifest).contents).icon
  return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : ''
}

async function dataUrlFromArchive(archivePath: string, manifest?: LegacyPayload): Promise<string> {
  try {
    return await withZip(archivePath, async (zip) => {
      const entry = archiveIconEntry(zip, manifest)
      if (entry) {
        const icon = await zip.read(entry.name, { maxBytes: 8 * 1024 * 1024 })
        return `data:image/png;base64,${icon.toString('base64')}`
      }
      return manifestIconData(manifest)
    })
  } catch (error) {
    getDefaultLogger().child('mods:legacy-import').debug(
      'legacy import: archive icon unreadable',
      { archivePath, error: describeError(error) },
    )
  }
  return ''
}

function displayLoader(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === 'fabric') return 'Fabric'
  if (normalized === 'quilt') return 'Quilt'
  if (normalized === 'forge') return 'Forge'
  if (normalized === 'neoforge') return 'Neoforge'
  return 'Vanilla'
}

function loaderFromCfId(id: string | undefined): { loader: string; version: string } {
  const raw = String(id ?? '')
  const [name, ...rest] = raw.split('-')
  return { loader: displayLoader(loaderFromCurseForgeId(name)), version: rest.join('-') }
}

async function archiveMetadata(
  archivePath: string,
  info: ArchiveInfo,
  manifest: LegacyPayload | undefined,
): Promise<ArchiveMetadata> {
  const fallbackName = basename(archivePath, archivePath.toLowerCase().endsWith('.mrpack') ? '.mrpack' : '.zip')
  const settings = asRecord(manifest?.settings)
  const ram = typeof settings.ram === 'number' && settings.ram > 0 ? settings.ram : 4096

  if (info.kind === 'mrpack') {
    const index = await readMrpackManifest(archivePath)
    const dependencies = normalizeDependencies(index.dependencies)
    const loader = loaderInfo(dependencies)
    return {
      name: index.name || fallbackName,
      versionId: index.versionId ?? '',
      minecraftVersion: dependencies.minecraft || '',
      loader: loader.loader,
      loaderVersion: loader.version,
      description: index.summary ?? '',
      author: index.author ?? '',
      isModpack: true,
      modpackSource: 'modrinth',
      ...(index.versionId ? { modpackVersion: index.versionId } : {}),
      ram,
      javaPath: '',
    }
  }

  if (info.kind === 'curseforge') {
    const curseforge = await readCurseForgeManifest(archivePath)
    const primary =
      curseforge.minecraft?.modLoaders?.find((loader) => loader.primary) ??
      curseforge.minecraft?.modLoaders?.[0]
    const loader = loaderFromCfId(primary?.id)
    const packVersion = curseforge.version ?? curseforge.versionId ?? ''
    return {
      name: curseforge.name || fallbackName,
      versionId: packVersion,
      minecraftVersion: String(curseforge.minecraft?.version ?? ''),
      loader: loader.loader,
      loaderVersion: loader.version,
      description: '',
      author: curseforge.author ?? '',
      isModpack: true,
      modpackSource: 'curseforge',
      ...(packVersion ? { modpackVersion: packVersion } : {}),
      ram,
      javaPath: '',
    }
  }

  const profile = asRecord(manifest?.profile ?? manifest?.instance)
  const meta = asRecord(manifest?.meta)
  const instance = asRecord(manifest?.instance)
  return {
    name: String(profile.name || instance.name || fallbackName),
    versionId: '',
    minecraftVersion: String(profile.minecraftVersion || instance.minecraftVersion || ''),
    loader: displayLoader(String(profile.modLoader || profile.modloader || instance.modloader || 'Vanilla')),
    loaderVersion: String(profile.loaderVersion || instance.modloaderVersion || ''),
    description: String(profile.description || instance.description || meta.description || ''),
    author: String(meta.author || instance.author || profile.author || ''),
    isModpack: Boolean(instance.isModpack || meta.isModpack),
    ...(typeof profile.modpackSource === 'string'
      ? { modpackSource: profile.modpackSource as 'modrinth' | 'curseforge' }
      : {}),
    ...(typeof profile.modpackVersion === 'string' ? { modpackVersion: profile.modpackVersion } : {}),
    ram,
    javaPath: String(profile.javaPath || ''),
  }
}

interface ContentCounts {
  mods: number
  resourcepacks: number
  shaderpacks: number
  datapacks: number
  worlds: number
}

const CONTENT_TYPES: Array<{
  folder: string
  type: string
  directories: 'only' | 'allowed' | 'never'
  count: keyof ContentCounts
}> = [
  { folder: 'mods', type: 'mods', directories: 'never', count: 'mods' },
  { folder: 'resourcepacks', type: 'resourcepacks', directories: 'allowed', count: 'resourcepacks' },
  { folder: 'shaderpacks', type: 'shaderpacks', directories: 'allowed', count: 'shaderpacks' },
  { folder: 'datapacks', type: 'datapacks', directories: 'allowed', count: 'datapacks' },
  { folder: 'saves', type: 'worlds', directories: 'only', count: 'worlds' },
]

function contentName(fileName: string): string {
  return fileName
    .replace(/\.(jar|zip|disabled|mcworld)$/i, '')
    .replace(/[-_]/g, ' ')
    .trim() || fileName
}

interface ContentChild {
  name: string
  isDirectory: boolean
}

type ContentChildren = Record<string, ContentChild[]>

const CONTENT_FOLDERS = new Set(CONTENT_TYPES.map((entry) => entry.folder))

/** The one content-counting rule for real installs and archive previews. */
function contentFromChildren(children: ContentChildren): {
  content: LegacyPayload[]
  counts: ContentCounts
} {
  const content: LegacyPayload[] = []
  const counts: ContentCounts = {
    mods: 0,
    resourcepacks: 0,
    shaderpacks: 0,
    datapacks: 0,
    worlds: 0,
  }
  for (const entry of CONTENT_TYPES) {
    for (const item of (children[entry.folder] ?? []).sort((left, right) => left.name.localeCompare(right.name))) {
      if (item.isDirectory && entry.directories === 'never') continue
      if (!item.isDirectory && entry.directories === 'only') continue
      counts[entry.count] += 1
      content.push({
        id: `import:${entry.type}:${item.name.toLowerCase()}`,
        name: contentName(item.name),
        fileName: item.name,
        version: '',
        type: entry.type,
        enabled: true,
        locked: true,
      })
    }
  }
  return { content, counts }
}

function contentChildrenFromPaths(paths: Iterable<string>): ContentChildren {
  const all = [...paths]
  const hasSaves = all.some((path) => path.replace(/\\/g, '/').startsWith('saves/'))
  const children: ContentChildren = {}
  for (const raw of all) {
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length < 2) continue
    // The installer prefers `saves/` over `worlds/`; previews must do the same.
    if (parts[0] === 'worlds' && hasSaves) continue
    const folder = parts[0] === 'worlds' ? 'saves' : parts[0]
    if (!CONTENT_FOLDERS.has(folder)) continue
    const name = parts[1]
    if (!name) continue
    const list = (children[folder] ??= [])
    const existing = list.find((item) => item.name === name)
    if (existing) existing.isDirectory ||= parts.length > 2
    else list.push({ name, isDirectory: parts.length > 2 })
  }
  return children
}

async function scanContent(instanceDir: string): Promise<{
  content: LegacyPayload[]
  counts: ContentCounts
}> {
  const children: ContentChildren = {}
  for (const entry of CONTENT_TYPES) {
    const entries = await readdir(join(instanceDir, entry.folder), { withFileTypes: true }).catch(() => [])
    children[entry.folder] = entries.map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
    }))
  }
  return contentFromChildren(children)
}

function archiveFilePaths(zip: ZipArchive, prefix = ''): string[] {
  const base = prefix.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = base ? `${base}/` : ''
  return zip.entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .filter((path) => path.startsWith(normalized))
    .map((path) => path.slice(normalized.length))
    .filter(Boolean)
}

async function previewContentPaths(
  archivePath: string,
  info: ArchiveInfo,
  options: LegacyBridgeOptions,
): Promise<string[]> {
  if (info.kind === 'mrpack') {
    const index = await readMrpackManifest(archivePath)
    return withZip(archivePath, async (zip) => [
      ...index.files
        .filter((file) => file.env?.client !== 'unsupported')
        .map((file) => file.path.replace(/\\/g, '/')),
      ...archiveFilePaths(zip, 'overrides'),
      ...archiveFilePaths(zip, 'client-overrides'),
    ])
  }
  if (info.kind === 'curseforge') {
    const manifest = await readCurseForgeManifest(archivePath)
    const primary =
      manifest.minecraft?.modLoaders?.find((loader) => loader.primary) ??
      manifest.minecraft?.modLoaders?.[0]
    const client = options.curseforgeApiKey
      ? new CurseForgeClient({
          apiKey: options.curseforgeApiKey,
          ...(options.curseforgeBaseUrl ? { baseUrl: options.curseforgeBaseUrl } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          logger: options.logger,
        })
      : undefined
    const plan = await planCurseForgeContent(manifest, client, {
      minecraftVersion: String(manifest.minecraft?.version ?? ''),
      loader: loaderFromCurseForgeId(primary?.id),
    })
    return withZip(archivePath, async (zip) => [
      ...plan.files.map((entry) => entry.path),
      ...archiveFilePaths(zip, manifest.overrides || 'overrides'),
    ])
  }
  return withZip(archivePath, async (zip) => archiveFilePaths(zip))
}

/**
 * Reads pack metadata and counts from the archive without extracting it.
 * The counts use the same `contentFromChildren` rule as `scanContent`, so the
 * preview cannot drift from what `importLegacyProfile` actually installs.
 */
export async function previewLegacyProfile(
  archivePath: string,
  options: LegacyBridgeOptions = {},
): Promise<LegacyPreviewResult> {
  if (!archivePath || !(await exists(archivePath))) {
    throw new Error('Datei nicht gefunden')
  }
  const info = await detectArchive(archivePath)
  const manifest = info.manifest
  const metadata = await archiveMetadata(archivePath, info, manifest)
  const paths = [...new Set(await previewContentPaths(archivePath, info, options))]
  const scanned = contentFromChildren(contentChildrenFromPaths(paths))
  const contents = asRecord(manifest?.contents)
  const hasPath = (folder: string): boolean =>
    paths.some((path) => path === folder || path.startsWith(`${folder}/`))
  const hasCount = (count: unknown): boolean => typeof count === 'number' && count > 0

  return {
    format: info.kind === 'mrpack' ? 'mrpack' : 'zip',
    title: metadata.name,
    minecraftVersion: metadata.minecraftVersion,
    modloader: metadata.loader,
    modloaderVersion: metadata.loaderVersion,
    description: metadata.description,
    author: metadata.author,
    fileSize: (await stat(archivePath)).size,
    totalFiles: paths.length,
    modCount: scanned.counts.mods,
    resourcepackCount: scanned.counts.resourcepacks,
    shaderCount: scanned.counts.shaderpacks,
    datapackCount: scanned.counts.datapacks,
    worldCount: scanned.counts.worlds,
    hasIcon: Boolean(await dataUrlFromArchive(archivePath, manifest)),
    hasBanner: Boolean(contents.banner),
    hasConfig: hasPath('config') || hasCount(asRecord(contents.config).count),
    hasScreenshots: hasPath('screenshots') || hasCount(asRecord(contents.screenshots).count),
    ...(scanned.counts.worlds > 0
      ? {
          worlds: scanned.content
            .filter((entry) => entry.type === 'worlds')
            .map((entry) => String(entry.fileName)),
        }
      : {}),
    isModpack: metadata.isModpack,
  }
}

async function countFiles(source: string): Promise<number> {
  const info = await stat(source).catch(() => undefined)
  if (!info) return 0
  if (info.isFile()) return 1
  if (!info.isDirectory()) return 0
  let total = 0
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    total += await countFiles(join(source, entry.name))
  }
  return total
}

async function copyTree(
  source: string,
  destination: string,
  onFile: (fileName: string) => void,
): Promise<void> {
  const info = await stat(source).catch(() => undefined)
  if (!info) return
  if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    onFile(basename(source))
    return
  }
  if (!info.isDirectory()) return
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    await copyTree(join(source, entry.name), join(destination, entry.name), onFile)
  }
}

async function copySelectedContent(
  staging: string,
  gameDir: string,
  data: LegacyPayload,
  report: (percent: number, label: string) => void,
  start: number,
  end: number,
): Promise<void> {
  const contentEnabled = new Set<string>()
  if (isEnabled(data.installMods)) contentEnabled.add('mods')
  if (isEnabled(data.installResourcepacks)) contentEnabled.add('resourcepacks')
  if (isEnabled(data.installShaderpacks)) contentEnabled.add('shaderpacks')
  if (isEnabled(data.installDatapacks)) contentEnabled.add('datapacks')

  const roots: Array<{ source: string; target: string }> = []
  for (const folder of contentEnabled) {
    const source = join(staging, folder)
    if (await exists(source)) roots.push({ source, target: join(gameDir, folder) })
  }

  if (isEnabled(data.installWorlds)) {
    const source = (await exists(join(staging, 'saves')))
      ? join(staging, 'saves')
      : (await exists(join(staging, 'worlds')))
        ? join(staging, 'worlds')
        : ''
    if (source) roots.push({ source, target: join(gameDir, 'saves') })
  }

  if (isEnabled(data.installScreenshots)) {
    const source = join(staging, 'screenshots')
    if (await exists(source)) roots.push({ source, target: join(gameDir, 'screenshots') })
  }

  if (isEnabled(data.installConfig)) {
    const handled = new Set([
      ...CONTENT_TYPES.map((entry) => entry.folder),
      'saves',
      'worlds',
      'screenshots',
      ...METADATA_FILES,
    ])
    for (const entry of await readdir(staging, { withFileTypes: true }).catch(() => [])) {
      if (handled.has(entry.name)) continue
      roots.push({ source: join(staging, entry.name), target: join(gameDir, entry.name) })
    }
  }

  let total = 0
  for (const root of roots) total += await countFiles(root.source)
  let copied = 0
  report(start, 'Installiere Dateien…')
  for (const root of roots) {
    await copyTree(root.source, root.target, (fileName) => {
      copied += 1
      const percent = start + Math.round((copied / Math.max(1, total)) * (end - start))
      report(percent, `Kopiere ${fileName}`)
    })
  }
}

export async function importLegacyProfile(
  payload: LegacyPayload | undefined,
  options: LegacyBridgeOptions = {},
): Promise<LegacyImportResult> {
  const data = asRecord(payload)
  const rootPath = options.rootPath ?? legacyGameRoot()
  const filePath = typeof data.filePath === 'string' ? data.filePath : ''
  if (!filePath || !(await exists(filePath))) {
    return { success: false, error: 'Datei nicht gefunden' }
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId : ''
  let lastPercent = -1
  const report = (percent: number, label: string): void => {
    if (!taskId || !options.onBackgroundTask) return
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    if (clamped <= lastPercent) return
    lastPercent = clamped
    options.onBackgroundTask({ id: taskId, percent: clamped, label })
  }

  const staging = join(
    rootPath,
    'cache',
    `import-core-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  try {
    report(1, 'Import wird vorbereitet…')
    const info = await detectArchive(filePath)
    const manifest = info.manifest
    const metadata = await archiveMetadata(filePath, info, manifest)

    await mkdir(staging, { recursive: true })
    if (info.kind === 'mrpack' || info.kind === 'curseforge') {
      const client =
        info.kind === 'curseforge' && options.curseforgeApiKey
          ? new CurseForgeClient({
              apiKey: options.curseforgeApiKey,
              ...(options.curseforgeBaseUrl ? { baseUrl: options.curseforgeBaseUrl } : {}),
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
              logger: options.logger,
            })
          : undefined
      const modrinth =
        info.kind === 'curseforge'
          ? new ModrinthClient({
              ...(options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {}),
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
              logger: options.logger,
            })
          : undefined
      await installModpack({
        instanceDir: staging,
        archivePath: filePath,
        ...(client ? { curseforge: client } : {}),
        ...(modrinth ? { modrinth } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onProgress: (progress) => {
          const total = Math.max(1, Number(progress.total) || 1)
          const done = Math.min(Math.max(0, Number(progress.done) || 0), total)
          if (progress.phase === 'files') {
            report(6 + Math.round((done / total) * 62), `Lade Datei ${Math.min(done + 1, total)}/${total}`)
          } else if (progress.phase === 'overrides') {
            report(68 + Math.round((done / total) * 14), `Installiere Override ${Math.min(done + 1, total)}/${total}`)
          }
        },
      })
      report(84, 'Modpack-Dateien installiert')
    } else {
      await extractArchive(filePath, staging, report, 4, 52)
    }

    const profilesPath = join(rootPath, 'profiles.json')
    const profiles = await readProfiles(profilesPath)
    const requestedName =
      (typeof data.targetInstanceName === 'string' && data.targetInstanceName) ||
      metadata.name ||
      basename(filePath)
    const takenNames = profiles.map((profile) => String(profile.name ?? '').toLowerCase())
    let finalName = requestedName
    if (takenNames.includes(requestedName.toLowerCase())) {
      let count = 1
      while (takenNames.includes(`${requestedName} (${count})`.toLowerCase())) count += 1
      finalName = `${requestedName} (${count})`
    }
    const folderName = await uniqueProfileFolder(rootPath, finalName, profiles)
    const gameDir = legacyInstanceDir(rootPath, folderName)
    await mkdir(gameDir, { recursive: true })

    await copySelectedContent(
      staging,
      gameDir,
      data,
      report,
      info.kind === 'mrpack' || info.kind === 'curseforge' ? 86 : 56,
      98,
    )

    for (const metadataFile of ['modrinth.index.json', 'curseforge.manifest.json', 'modpack.lock.json']) {
      const source = join(staging, metadataFile)
      if (await exists(source)) {
        await copyFile(source, join(gameDir, metadataFile))
      }
    }

    const scanned = await scanContent(gameDir)
    const thumbnail = await dataUrlFromArchive(filePath, manifest)
    const newProfile: LegacyPayload = {
      id: randomUUID(),
      name: finalName,
      folderName,
      thumbnail,
      color: '#4CAF50',
      version: metadata.minecraftVersion || '1.21',
      loader: metadata.loader,
      loaderVersion: metadata.loaderVersion,
      lastPlayed: '',
      size: `${scanned.content.length} Inhalte`,
      mods: scanned.counts.mods,
      resourcePacks: scanned.counts.resourcepacks,
      shaderPacks: scanned.counts.shaderpacks,
      playTimeMs: 0,
      sessionCount: 0,
      lastPlayedAt: 0,
      createdAt: Date.now(),
      ram: metadata.ram,
      javaPath: metadata.javaPath,
      installedMods: scanned.content
        .filter((entry) => entry.type === 'mods')
        .map((entry) => String(entry.id)),
      content: scanned.content,
      desc: metadata.description,
      minecraftVersion: metadata.minecraftVersion,
      modloader: metadata.loader,
      modloaderVersion: metadata.loaderVersion,
      isModpack: metadata.isModpack,
      ...(metadata.modpackSource ? { modpackSource: metadata.modpackSource } : {}),
      ...(metadata.modpackVersion ? { modpackVersion: metadata.modpackVersion } : {}),
    }

    profiles.push(newProfile)
    await mkdir(rootPath, { recursive: true })
    await writeFile(profilesPath, JSON.stringify(profiles, null, 2), 'utf8')
    report(100, 'Import abgeschlossen')

    return {
      success: true,
      instanceId: String(newProfile.id),
      instanceName: finalName,
      modsInstalled: scanned.counts.mods,
      resourcepacksInstalled: scanned.counts.resourcepacks,
      shaderpacksInstalled: scanned.counts.shaderpacks,
      datapacksInstalled: scanned.counts.datapacks,
      worldsImported: scanned.counts.worlds,
      profile: newProfile,
    }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
