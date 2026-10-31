import { join } from 'node:path'
import type { Logger } from '../logger'
import { type FeatureSet, type PlatformInfo, type Rule, evaluateRules } from './rules'

export interface LibraryDownload {
  path?: string
  url?: string
  sha1?: string
  size?: number
}

export interface RawLibrary {
  name: string
  url?: string
  sha1?: string
  size?: number
  downloads?: {
    artifact?: LibraryDownload
    classifiers?: Record<string, LibraryDownload>
  }
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
}

export interface MavenCoordinate {
  groupId: string
  artifactId: string
  version: string
  classifier?: string
  extension: string
}

export interface LibraryModel {
  name: string
  groupId: string
  artifactId: string
  version: string
  classifier?: string
  path: string
  absolutePath: string
  url: string
  sha1?: string
  size?: number
  isNative: boolean
  extractExclude?: string[]
}

export function parseMavenCoordinate(name: string): MavenCoordinate | undefined {
  const value = name.trim()
  if (!value) return undefined
  const at = value.lastIndexOf('@')
  const extension = at === -1 ? 'jar' : value.slice(at + 1)
  const body = at === -1 ? value : value.slice(0, at)
  const parts = body.split(':')
  if (parts.length < 3) return undefined
  const [groupId, artifactId, version, classifier] = parts
  if (!groupId || !artifactId || !version) return undefined
  const coordinate: MavenCoordinate = { groupId, artifactId, version, extension }
  if (classifier) coordinate.classifier = classifier
  return coordinate
}

export function coordinatePath(coordinate: MavenCoordinate): string {
  const filename = `${coordinate.artifactId}-${coordinate.version}${coordinate.classifier ? `-${coordinate.classifier}` : ''}.${coordinate.extension}`
  return `${coordinate.groupId.replace(/\./g, '/')}/${coordinate.artifactId}/${coordinate.version}/${filename}`
}

export function libraryKey(coordinate: MavenCoordinate): string {
  return `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.classifier ?? ''}`
}

function versionTokens(value: string): (string | number)[] {
  const matches = value.toLowerCase().match(/\d+|[a-z]+/g)
  return matches ? matches.map((token) => (/^\d+$/.test(token) ? Number(token) : token)) : []
}

export function compareMavenVersions(a: string, b: string): number {
  const left = versionTokens(a)
  const right = versionTokens(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return typeof y === 'number' ? -1 : 1
    if (y === undefined) return typeof x === 'number' ? 1 : -1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y ? 1 : -1
    } else if (typeof x === 'string' && typeof y === 'string') {
      const result = x.localeCompare(y)
      if (result !== 0) return result > 0 ? 1 : -1
    } else {
      return typeof x === 'number' ? 1 : -1
    }
  }
  return 0
}

function archSuffix(platform: PlatformInfo): string {
  return platform.arch === 'ia32' ? '32' : platform.arch === 'arm64' ? 'arm64' : '64'
}

function mavenBase(raw: RawLibrary, coordinate: MavenCoordinate): string {
  if (raw.url) return raw.url.endsWith('/') ? raw.url : `${raw.url}/`
  if (coordinate.groupId === 'net.minecraftforge') return 'https://files.minecraftforge.net/maven/'
  return 'https://libraries.minecraft.net/'
}

function downloadUrl(raw: RawLibrary, coordinate: MavenCoordinate, download: LibraryDownload | undefined): string {
  if (download && download.url !== undefined) return download.url
  return `${mavenBase(raw, coordinate)}${download?.path ?? coordinatePath(coordinate)}`
}

function toModel(
  coordinate: MavenCoordinate,
  download: LibraryDownload | undefined,
  raw: RawLibrary,
  gameRoot: string,
  isNative: boolean,
): LibraryModel {
  const path = download?.path || coordinatePath(coordinate)
  const url = downloadUrl(raw, coordinate, download)
  const model: LibraryModel = {
    name: coordinate.classifier
      ? `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}:${coordinate.classifier}`
      : `${coordinate.groupId}:${coordinate.artifactId}:${coordinate.version}`,
    groupId: coordinate.groupId,
    artifactId: coordinate.artifactId,
    version: coordinate.version,
    path,
    absolutePath: join(gameRoot, 'libraries', path),
    url,
    isNative,
  }
  if (coordinate.classifier) model.classifier = coordinate.classifier
  if (download?.sha1) model.sha1 = download.sha1
  if (download?.size !== undefined) model.size = download.size
  if (isNative && raw.extract?.exclude) model.extractExclude = [...raw.extract.exclude]
  return model
}

function upsert(map: Map<string, LibraryModel>, key: string, model: LibraryModel): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, model)
    return
  }
  if (compareMavenVersions(model.version, existing.version) >= 0) map.set(key, model)
}

export interface ResolvedLibrarySet {
  libraries: LibraryModel[]
  natives: LibraryModel[]
  skipped: string[]
}

export function resolveLibraries(
  rawLibraries: RawLibrary[],
  platform: PlatformInfo,
  features: FeatureSet,
  gameRoot: string,
  logger?: Logger,
): ResolvedLibrarySet {
  const libraries = new Map<string, LibraryModel>()
  const natives = new Map<string, LibraryModel>()
  const skipped: string[] = []

  for (const raw of rawLibraries) {
    if (!raw || typeof raw.name !== 'string') {
      skipped.push(String(raw))
      continue
    }
    if (!evaluateRules(raw.rules, platform, features)) continue

    const nativeTemplate = raw.natives?.[platform.name]
    if (nativeTemplate) {
      const classifier = nativeTemplate.replace('${arch}', archSuffix(platform))
      const coordinate = parseMavenCoordinate(`${raw.name}:${classifier}`)
      if (!coordinate) {
        skipped.push(raw.name)
        continue
      }
      const download = raw.downloads?.classifiers?.[classifier]
      upsert(natives, libraryKey(coordinate), toModel(coordinate, download, raw, gameRoot, true))
      continue
    }

    const coordinate = parseMavenCoordinate(raw.name)
    if (!coordinate) {
      skipped.push(raw.name)
      logger?.warn('Skipping library with unparsable Maven coordinate', { name: raw.name })
      continue
    }
    const download: LibraryDownload | undefined =
      raw.downloads?.artifact ??
      (raw.url !== undefined || raw.sha1 !== undefined || raw.size !== undefined
        ? {
            path: coordinatePath(coordinate),
            sha1: raw.sha1,
            size: raw.size,
            ...(raw.url !== undefined ? { url: `${raw.url.replace(/\/$/, '')}/${coordinatePath(coordinate)}` } : {}),
          }
        : undefined)
    upsert(libraries, libraryKey(coordinate), toModel(coordinate, download, raw, gameRoot, false))
  }

  return { libraries: [...libraries.values()], natives: [...natives.values()], skipped }
}
