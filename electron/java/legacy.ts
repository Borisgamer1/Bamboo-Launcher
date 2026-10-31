import type { JavaRecord } from '../schemas'

export interface LegacyJavaVersion {
  path: string
  version: number
  verStr: string
  majorVersion: number
  arch: JavaRecord['architecture']
  vendor: string
  source: JavaRecord['source']
}

export function toLegacyJavaVersion(record: JavaRecord): LegacyJavaVersion {
  return {
    path: record.path,
    version: record.majorVersion,
    verStr: record.version.length > 0 ? record.version : String(record.majorVersion),
    majorVersion: record.majorVersion,
    arch: record.architecture,
    vendor: record.vendor,
    source: record.source,
  }
}

export function usableJavaRecords(records: readonly JavaRecord[]): JavaRecord[] {
  return records
    .filter((record) => record.valid !== false)
    .slice()
    .sort((left, right) => right.majorVersion - left.majorVersion || left.path.localeCompare(right.path))
}

export function toLegacyJavaVersions(records: readonly JavaRecord[]): LegacyJavaVersion[] {
  return usableJavaRecords(records).map(toLegacyJavaVersion)
}
