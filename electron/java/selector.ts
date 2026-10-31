import type { JavaRecord } from '../schemas'
import { componentsForMajor, type JavaVersionMetadata } from './metadata'
import { normalizeArchitecture, parseMinecraftVersion, type JavaArchitecture } from './version'

export const JAVA_FORWARD_COMPAT_THRESHOLD = 16

export type JavaQuality = 'matched' | 'may-incompatible' | 'incompatible'

export type JavaReason =
  | 'java.exact-major'
  | 'java.preferred-path'
  | 'java.forward-compat'
  | 'java.may-incompatible'
  | 'java.arch-mismatch'
  | 'java.runtime-vanished'
  | 'java.no-runtime'
  | 'java.forge-pin'
  | 'java.neoforge-pin'
  | 'java.allowlist'
  | 'java.version-json'
  | 'java.mc-fallback'
  | 'java.unknown-version'
  | 'java.manifest-stale'
  | 'java.downloaded'

export type JavaRequirementReason = Extract<
  JavaReason,
  | 'java.forge-pin'
  | 'java.neoforge-pin'
  | 'java.allowlist'
  | 'java.version-json'
  | 'java.mc-fallback'
  | 'java.unknown-version'
>

export interface JavaPreference {
  match: (java: JavaRecord) => boolean
  okay: (java: JavaRecord) => boolean
  requirement: string
  majorVersion: number
  component?: string
  reason: JavaRequirementReason
}

export function normalizeHostArchitecture(arch: string | undefined): JavaArchitecture {
  return normalizeArchitecture(arch)
}

export function archCompatible(java: JavaRecord, hostArch: string | undefined = process.arch): boolean {
  const host = normalizeHostArchitecture(hostArch)
  const runtime = java.architecture
  if (host === 'x64') return runtime === 'x64' || (runtime === 'x86' && java.majorVersion <= 8)
  if (host === 'arm64') return runtime === 'arm64' || runtime === 'x64'
  return runtime === host
}

export interface JavaSelectionRequest {
  minecraftVersion: string
  loader?: string
  javaVersion?: JavaVersionMetadata
  compatibleJavaMajors?: number[]
  preferredPath?: string
}

function defaultComponent(major: number): string | undefined {
  return componentsForMajor(major)[0]
}

export function isForgePinnedVersion(version: ReturnType<typeof parseMinecraftVersion>): boolean {
  if (!version) return false
  return (
    version.major === 1 &&
    (version.minor === 18 || version.minor === 19 || (version.minor === 20 && version.patch <= 4))
  )
}

export function getJavaPreference(request: JavaSelectionRequest): JavaPreference {
  const explicit = request.javaVersion?.majorVersion
  const hint = request.javaVersion?.component
  const loader = (request.loader ?? '').toLowerCase()
  const mc = parseMinecraftVersion(request.minecraftVersion)
  const forgeFamily = loader === 'forge' || loader === 'neoforge'

  if (forgeFamily && isForgePinnedVersion(mc)) {
    const match = (java: JavaRecord) => java.majorVersion === 17
    return {
      match,
      okay: match,
      requirement: '=17',
      majorVersion: 17,
      component: 'java-runtime-gamma',
      reason: loader === 'neoforge' ? 'java.neoforge-pin' : 'java.forge-pin',
    }
  }

  if (request.compatibleJavaMajors && request.compatibleJavaMajors.length > 0) {
    const majors = [...new Set(request.compatibleJavaMajors)].sort((a, b) => a - b)
    const majorVersion = explicit !== undefined && majors.includes(explicit) ? explicit : majors[majors.length - 1]
    const match = (java: JavaRecord) => majors.includes(java.majorVersion)
    return {
      match,
      okay: match,
      requirement: majors.map((major) => `=${major}`).join(' || '),
      majorVersion,
      component: hint ?? defaultComponent(majorVersion),
      reason: 'java.allowlist',
    }
  }

  if (explicit !== undefined) {
    const forward = explicit >= JAVA_FORWARD_COMPAT_THRESHOLD
    const match = forward
      ? (java: JavaRecord) => java.majorVersion >= explicit
      : (java: JavaRecord) => java.majorVersion === explicit
    return {
      match,
      okay: legacyOkay(mc?.major === 1 ? mc.minor : undefined, explicit),
      requirement: `${forward ? '>=' : '='}${explicit}`,
      majorVersion: explicit,
      component: hint ?? defaultComponent(explicit),
      reason: 'java.version-json',
    }
  }

  const minor = mc?.major === 1 ? mc.minor : undefined
  if (mc && mc.major >= 26) {
    return {
      match: (java) => java.majorVersion >= 25,
      okay: () => true,
      requirement: '>=25',
      majorVersion: 25,
      component: 'java-runtime-epsilon',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor <= 16) {
    const match = (java: JavaRecord) => java.majorVersion === 8
    return {
      match,
      okay: (java) => java.majorVersion >= 8 && java.majorVersion <= 11,
      requirement: '=8',
      majorVersion: 8,
      component: 'jre-legacy',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor === 17) {
    return {
      match: (java) => java.majorVersion >= 17,
      okay: () => true,
      requirement: '>=17',
      majorVersion: 17,
      component: 'java-runtime-alpha',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor === 18) {
    return {
      match: (java) => java.majorVersion >= 17,
      okay: () => true,
      requirement: '>=17',
      majorVersion: 17,
      component: 'java-runtime-gamma',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor === 19) {
    return {
      match: (java) => java.majorVersion >= 17,
      okay: () => true,
      requirement: '>=17',
      majorVersion: 17,
      component: 'java-runtime-gamma',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor === 20) {
    const modern = mc !== undefined && mc.patch >= 5
    return {
      match: (java) => java.majorVersion >= (modern ? 21 : 17),
      okay: () => true,
      requirement: modern ? '>=21' : '>=17',
      majorVersion: modern ? 21 : 17,
      component: modern ? 'java-runtime-delta' : 'java-runtime-gamma',
      reason: 'java.mc-fallback',
    }
  }
  if (minor !== undefined && minor >= 21) {
    return {
      match: (java) => java.majorVersion >= 21,
      okay: () => true,
      requirement: '>=21',
      majorVersion: 21,
      component: 'java-runtime-delta',
      reason: 'java.mc-fallback',
    }
  }
  return {
    match: (java) => java.majorVersion >= 17,
    okay: () => true,
    requirement: '>=17',
    majorVersion: 17,
    component: 'java-runtime-alpha',
    reason: 'java.unknown-version',
  }
}

function legacyOkay(minor: number | undefined, requiredMajor: number): (java: JavaRecord) => boolean {
  if (minor !== undefined && minor < 13) {
    return (java) => java.majorVersion >= 8 && java.majorVersion <= 11
  }
  if (requiredMajor >= JAVA_FORWARD_COMPAT_THRESHOLD) return () => true
  return (java) => java.majorVersion === requiredMajor
}

function isOpenJ9(java: JavaRecord): boolean {
  const haystack = `${java.path} ${java.vendor ?? ''}`.toLowerCase()
  return haystack.includes('openj9') || haystack.includes('semeru') || haystack.includes('ibm')
}

function compareCandidates(requiredMajor: number, a: JavaRecord, b: JavaRecord): number {
  const openA = isOpenJ9(a) ? 1 : 0
  const openB = isOpenJ9(b) ? 1 : 0
  if (openA !== openB) return openA - openB

  const exactA = a.majorVersion === requiredMajor ? 0 : 1
  const exactB = b.majorVersion === requiredMajor ? 0 : 1
  if (exactA !== exactB) return exactA - exactB

  const distance = (major: number) => (major >= requiredMajor ? major - requiredMajor : 1000 + (requiredMajor - major))
  const byDistance = distance(a.majorVersion) - distance(b.majorVersion)
  if (byDistance !== 0) return byDistance

  if (a.majorVersion !== b.majorVersion) return a.majorVersion - b.majorVersion
  return a.path.localeCompare(b.path)
}

export interface JavaSelection {
  java?: JavaRecord
  quality: JavaQuality
  matched: JavaRecord[]
  reason?: JavaReason
  archMismatch: number
}

export function matchReason(
  preference: JavaPreference,
  chosen: JavaRecord,
  preferredPath?: string,
): JavaReason {
  if (preferredPath && chosen.path.toLowerCase() === preferredPath.toLowerCase()) {
    return 'java.preferred-path'
  }
  if (preference.requirement.startsWith('>=') && chosen.majorVersion > preference.majorVersion) {
    return 'java.forward-compat'
  }
  return 'java.exact-major'
}

export function selectJavaRecord(
  records: JavaRecord[],
  preference: JavaPreference,
  preferredPath?: string,
  hostArch: string | undefined = process.arch,
): JavaSelection {
  const validRecords = records.filter((record) => record.valid !== false)
  const valid = validRecords.filter((record) => archCompatible(record, hostArch))
  const archMismatch = validRecords.length - valid.length
  const matched = valid.filter(preference.match).sort((a, b) => compareCandidates(preference.majorVersion, a, b))

  if (matched.length > 0) {
    const preferred = preferredPath
      ? matched.find((record) => record.path.toLowerCase() === preferredPath.toLowerCase())
      : undefined
    const chosen = preferred ?? matched[0]
    return {
      java: chosen,
      quality: 'matched',
      matched,
      reason: matchReason(preference, chosen, preferredPath),
      archMismatch,
    }
  }

  const fine = valid.filter(preference.okay).sort((a, b) => compareCandidates(preference.majorVersion, a, b))
  if (fine.length > 0) {
    return { java: fine[0], quality: 'may-incompatible', matched: [], reason: 'java.may-incompatible', archMismatch }
  }

  return {
    quality: 'incompatible',
    matched: [],
    ...(valid.length === 0 && archMismatch > 0 ? { reason: 'java.arch-mismatch' as const } : {}),
    archMismatch,
  }
}
