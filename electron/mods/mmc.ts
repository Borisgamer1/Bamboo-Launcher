import AdmZip from 'adm-zip'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeJsonFile } from '../atomic'
import { ContentStore } from '../instances/content-store'
import { INSTANCE_FILE, LINKED_DIRS } from '../instances/layout'
import type { InstanceDescriptor, InstanceManager } from '../instances/manager'
import type { Logger } from '../logger'
import type { InstanceFile, InstanceLoader } from '../schemas'
import { InstanceFileSchema, parseWithDefaults } from '../schemas'
import { ModError } from './errors'

export const MMC_PACK_FILE = 'mmc-pack.json'
export const MMC_CONFIG_FILE = 'instance.cfg'

export interface MmcComponent {
  uid: string
  version: string
  dependencyOnly?: boolean
}

export interface MmcInstanceInfo {
  sourceDir: string
  name: string
  minecraftVersion: string
  loader: InstanceLoader
  loaderVersion: string
  clientDir?: string
  components: MmcComponent[]
  minMemory?: number
  maxMemory?: number
  javaPath?: string
  jvmArgs?: string
}

export interface ImportMmcOptions {
  manager: InstanceManager
  gameRoot: () => string
  sourceDir: string
  name?: string
  logger?: Logger
}

export interface ImportMmcResult {
  instance: InstanceDescriptor
  sourceDir: string
  clientDir?: string
  minecraftVersion: string
  loader: InstanceLoader
  loaderVersion: string
  copied: number
  linked: number
  bytes: number
  components: MmcComponent[]
}

function parseIni(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    values[key] = value
  }
  return values
}

function asNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

function truthy(value: string | undefined): boolean {
  return String(value ?? '').toLowerCase() === 'true' || value === '1'
}

export async function resolveMmcRoot(sourceDir: string): Promise<string> {
  const direct = resolve(sourceDir)
  if (existsSync(join(direct, MMC_PACK_FILE))) return direct
  const entries = await readdir(direct, { withFileTypes: true }).catch(() => [])
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && existsSync(join(direct, entry.name, MMC_PACK_FILE)),
  )
  if (candidates.length === 1) return join(direct, candidates[0].name)
  if (candidates.length > 1) {
    throw new ModError('invalid-mmc', `Multiple MMC instances in ${sourceDir}; pass the instance folder`, {
      sourceDir,
    })
  }
  throw new ModError('invalid-mmc', `${MMC_PACK_FILE} not found in ${sourceDir}`, { sourceDir })
}

export async function readMmcInstance(sourceDir: string): Promise<MmcInstanceInfo> {
  const root = await resolveMmcRoot(sourceDir)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(join(root, MMC_PACK_FILE), 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new ModError('invalid-mmc', `${MMC_PACK_FILE} is unreadable: ${(error as Error).message}`, {
      sourceDir: root,
    })
  }
  const components: MmcComponent[] = Array.isArray(raw.components)
    ? raw.components
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => typeof entry.uid === 'string' && typeof entry.version === 'string')
        .map((entry) => ({
          uid: String(entry.uid),
          version: String(entry.version),
          ...(entry.dependencyOnly === true ? { dependencyOnly: true } : {}),
        }))
    : []
  const minecraft = components.find((component) => component.uid === 'net.minecraft')
  if (!minecraft) {
    throw new ModError('invalid-mmc', 'mmc-pack.json has no net.minecraft component', { sourceDir: root })
  }

  const loaderFor = (uid: string): { loader: InstanceLoader; version: string } | undefined => {
    if (uid === 'net.fabricmc.fabric-loader') return { loader: 'fabric', version: '' }
    if (uid === 'org.quiltmc.quilt-loader' || uid === 'org.quiltmc.quilt_loader') {
      return { loader: 'quilt', version: '' }
    }
    if (uid === 'net.neoforged') return { loader: 'neoforge', version: '' }
    if (uid === 'net.minecraftforge') return { loader: 'forge', version: '' }
    if (uid === 'optifine.OptiFine' || uid === 'net.optifine') return { loader: 'optifine', version: '' }
    return undefined
  }
  const loaderComponent = components.find(
    (component) => !component.dependencyOnly && loaderFor(component.uid),
  )
  const loader = loaderComponent ? loaderFor(loaderComponent.uid)!.loader : 'vanilla'
  const loaderVersion = loaderComponent?.version ?? ''

  const configText = await readFile(join(root, MMC_CONFIG_FILE), 'utf8').catch(() => '')
  const config = parseIni(configText)
  const name = String(config.name ?? '').trim() || basename(root)
  const clientCandidates = [join(root, '.minecraft'), join(root, 'minecraft')]
  const clientDir = clientCandidates.find((candidate) => existsSync(candidate))
  const javaCandidate = truthy(config.OverrideJavaLocation) ? config.JavaPath : undefined
  const javaPath = javaCandidate && existsSync(javaCandidate) ? resolve(javaCandidate) : undefined

  return {
    sourceDir: root,
    name,
    minecraftVersion: minecraft.version,
    loader,
    loaderVersion,
    ...(clientDir ? { clientDir } : {}),
    components,
    ...(truthy(config.OverrideMemory) && asNumber(config.MinMemAlloc)
      ? { minMemory: asNumber(config.MinMemAlloc) }
      : {}),
    ...(truthy(config.OverrideMemory) && asNumber(config.MaxMemAlloc)
      ? { maxMemory: asNumber(config.MaxMemAlloc) }
      : {}),
    ...(javaPath ? { javaPath } : {}),
    ...(config.JvmArgs ? { jvmArgs: config.JvmArgs } : {}),
  }
}

function safeJoin(root: string, relativePath: string): string {
  const target = resolve(root, relativePath)
  const rel = relative(resolve(root), target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ModError('unsafe-path', `Archive entry escapes the instance: ${relativePath}`, {
      relativePath,
    })
  }
  return target
}

export async function extractMmcArchive(archivePath: string): Promise<{ root: string; temp: string }> {
  let zip: AdmZip
  try {
    zip = new AdmZip(archivePath)
  } catch (error) {
    throw new ModError('invalid-mmc', `Archive is not readable: ${(error as Error).message}`, {
      archivePath,
    })
  }
  const temp = await mkdtemp(join(tmpdir(), 'bamboo-mmc-'))
  try {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const target = safeJoin(temp, entry.entryName)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.getData())
    }
    return { root: await resolveMmcRoot(temp), temp }
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function copyTree(source: string, target: string): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  let files = 0
  let bytes = 0
  await mkdir(target, { recursive: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      const nested = await copyTree(from, to)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      files += 1
      bytes += (await stat(from)).size
    }
  }
  return { files, bytes }
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const result: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await walkFiles(full)))
    else if (entry.isFile()) result.push(full)
  }
  return result
}

async function updateUpstream(
  directory: string,
  info: MmcInstanceInfo,
  logger?: Logger,
): Promise<void> {
  const file = join(directory, INSTANCE_FILE)
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  const parsed = parseWithDefaults(InstanceFileSchema, raw, raw as unknown as InstanceFile) as InstanceFile
  const upstream = {
    type: 'mmc',
    format: 'mmc-pack',
    name: info.name,
    minecraftVersion: info.minecraftVersion,
    loader: info.loader,
    loaderVersion: info.loaderVersion,
    components: info.components,
    ...(info.jvmArgs ? { jvmArgs: info.jvmArgs } : {}),
    importedAt: Date.now(),
  }
  await writeJsonFile(file, { ...parsed, upstream }, logger)
}

export async function importMmcInstance(options: ImportMmcOptions): Promise<ImportMmcResult> {
  const info = await readMmcInstance(options.sourceDir)
  const name = String(options.name ?? info.name).trim() || info.name
  const created = await options.manager.create({
    name,
    minecraftVersion: info.minecraftVersion,
    loader: info.loader,
    ...(info.loaderVersion ? { loaderVersion: info.loaderVersion } : {}),
    ...(info.javaPath ? { javaPath: info.javaPath } : {}),
    ...(info.minMemory !== undefined ? { minMemory: info.minMemory } : {}),
    ...(info.maxMemory !== undefined ? { maxMemory: info.maxMemory } : {}),
    group: 'MMC/Prism',
  })
  const lock = await options.manager.locks.acquire(created.directory, {
    operation: 'install',
    instanceId: created.instance.id,
  })
  let copied = 0
  let linked = 0
  let bytes = 0
  try {
    if (info.clientDir) {
      const store = new ContentStore(options.gameRoot(), options.logger?.child('content'))
      const entries = await readdir(info.clientDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.name === INSTANCE_FILE || entry.name === 'instance-lock.json') continue
        const from = join(info.clientDir, entry.name)
        const to = join(created.directory, entry.name)
        if (entry.isDirectory() && (LINKED_DIRS as readonly string[]).includes(entry.name)) {
          for (const file of await walkFiles(from)) {
            const target = join(to, relative(from, file))
            await store.putAndLink(file, target)
            linked += 1
            bytes += (await stat(file)).size
          }
          continue
        }
        if (entry.isDirectory()) {
          const result = await copyTree(from, to)
          copied += result.files
          bytes += result.bytes
        } else if (entry.isFile()) {
          await mkdir(dirname(to), { recursive: true })
          await copyFile(from, to)
          copied += 1
          bytes += (await stat(from)).size
        }
      }
    }
    await updateUpstream(created.directory, info, options.logger)
    options.logger?.info('MMC/Prism instance imported', {
      source: info.sourceDir,
      instanceId: created.instance.id,
      minecraftVersion: info.minecraftVersion,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      copied,
      linked,
      bytes,
    })
    return {
      instance: created,
      sourceDir: info.sourceDir,
      ...(info.clientDir ? { clientDir: info.clientDir } : {}),
      minecraftVersion: info.minecraftVersion,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      copied,
      linked,
      bytes,
      components: info.components,
    }
  } catch (error) {
    await options.manager.locks.releaseAt(created.directory, lock.lock.owner).catch(() => undefined)
    await options.manager.delete(created.instance.id).catch(() => undefined)
    throw error
  } finally {
    await options.manager.locks.releaseAt(created.directory, lock.lock.owner).catch(() => undefined)
  }
}

export async function importMmcArchive(
  options: ImportMmcOptions & { archivePath: string },
): Promise<ImportMmcResult> {
  const extracted = await extractMmcArchive(options.archivePath)
  try {
    return await importMmcInstance({ ...options, sourceDir: extracted.root })
  } finally {
    await rm(extracted.temp, { recursive: true, force: true }).catch(() => undefined)
  }
}
