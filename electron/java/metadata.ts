import { join } from 'node:path'
import { readJsonFile } from '../atomic'
import type { Logger } from '../logger'

export interface JavaVersionMetadata {
  component?: string
  majorVersion?: number
}

export interface VersionJavaMetadata {
  javaVersion?: JavaVersionMetadata
  compatibleJavaMajors?: number[]
  chain: string[]
}

export const JAVA_COMPONENTS_BY_MAJOR: Readonly<Record<number, readonly string[]>> = {
  8: ['jre-legacy'],
  16: ['java-runtime-alpha'],
  17: ['java-runtime-gamma', 'java-runtime-beta'],
  21: ['java-runtime-delta'],
  25: ['java-runtime-epsilon'],
}

const COMPONENT_MAJOR: Readonly<Record<string, number>> = {
  'jre-legacy': 8,
  'java-runtime-alpha': 16,
  'java-runtime-beta': 17,
  'java-runtime-gamma': 17,
  'java-runtime-gamma-snapshot': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
}

export function majorFromComponent(component: string | undefined): number | undefined {
  if (!component) return undefined
  return COMPONENT_MAJOR[component]
}

export function componentsForMajor(major: number): string[] {
  const known = JAVA_COMPONENTS_BY_MAJOR[major]
  return known ? [...known] : []
}

function asMajor(value: unknown): number | undefined {
  const major = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(major) || major <= 0) return undefined
  return Math.trunc(major)
}

export function readVersionJavaMetadata(json: unknown): Omit<VersionJavaMetadata, 'chain'> {
  if (!json || typeof json !== 'object') return {}
  const raw = json as Record<string, unknown>
  const result: Omit<VersionJavaMetadata, 'chain'> = {}

  const javaVersion = raw.javaVersion
  if (javaVersion && typeof javaVersion === 'object') {
    const entry = javaVersion as Record<string, unknown>
    const metadata: JavaVersionMetadata = {}
    if (typeof entry.component === 'string' && entry.component.length > 0) metadata.component = entry.component
    const major = asMajor(entry.majorVersion) ?? majorFromComponent(metadata.component)
    if (major !== undefined) metadata.majorVersion = major
    if (metadata.component || metadata.majorVersion !== undefined) result.javaVersion = metadata
  } else if (typeof javaVersion === 'string') {
    const major = majorFromComponent(javaVersion)
    result.javaVersion = major === undefined ? { component: javaVersion } : { component: javaVersion, majorVersion: major }
  }

  const compatible = raw.compatibleJavaMajors
  if (Array.isArray(compatible)) {
    const majors = compatible.map(asMajor).filter((value): value is number => value !== undefined)
    if (majors.length > 0) result.compatibleJavaMajors = [...new Set(majors)].sort((a, b) => a - b)
  }

  return result
}

export interface LoadVersionMetadataOptions {
  versionsDir: string
  versionId: string
  logger?: Logger
  maxDepth?: number
}

export async function loadVersionJavaMetadata(options: LoadVersionMetadataOptions): Promise<VersionJavaMetadata> {
  const depthLimit = options.maxDepth ?? 8
  const chain: string[] = []
  let current: string | undefined = options.versionId
  let javaVersion: JavaVersionMetadata | undefined
  let compatibleJavaMajors: number[] | undefined

  while (current && chain.length < depthLimit) {
    if (chain.includes(current)) {
      options.logger?.warn('Circular inheritsFrom while reading Java metadata', { chain: [...chain, current] })
      break
    }
    chain.push(current)
    const file = join(options.versionsDir, current, `${current}.json`)
    const json = await readJsonFile<Record<string, unknown>>(file, options.logger)
    if (!json) break
    const metadata = readVersionJavaMetadata(json)
    if (!javaVersion && metadata.javaVersion) javaVersion = metadata.javaVersion
    if (!compatibleJavaMajors && metadata.compatibleJavaMajors) compatibleJavaMajors = metadata.compatibleJavaMajors
    const parent = json.inheritsFrom
    current = typeof parent === 'string' && parent.length > 0 ? parent : undefined
  }

  const result: VersionJavaMetadata = { chain }
  if (javaVersion) result.javaVersion = javaVersion
  if (compatibleJavaMajors) result.compatibleJavaMajors = compatibleJavaMajors
  return result
}
