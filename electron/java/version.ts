
export interface MinecraftVersionNumber {
  raw: string
  major: number
  minor: number
  patch: number
}

export function parseMinecraftVersion(version: string): MinecraftVersionNumber | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) return undefined
  return {
    raw: version.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  }
}

export function parseJavaMajorVersion(value: string): number | undefined {
  const clean = value.trim().replace(/^"|"$/g, '')
  if (!clean) return undefined
  if (/^1\.\d+/.test(clean)) {
    const major = Number(clean.split('.')[1])
    return Number.isFinite(major) ? major : undefined
  }
  const match = /^(\d+)/.exec(clean)
  if (!match) return undefined
  const major = Number(match[1])
  return Number.isFinite(major) ? major : undefined
}

export type JavaArchitecture = 'x64' | 'x86' | 'arm64'

export function normalizeArchitecture(value: string | undefined): JavaArchitecture {
  const arch = (value ?? '').toLowerCase()
  if (arch.includes('aarch64') || arch.includes('arm64')) return 'arm64'
  if (/^(x86|i[3-6]86|ia32)$/.test(arch)) return 'x86'
  return 'x64'
}

export interface ReleaseFileInfo {
  version?: string
  majorVersion?: number
  architecture?: JavaArchitecture
  vendor?: string
}

export function parseReleaseFile(content: string): ReleaseFileInfo {
  const fields: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim())
    if (match) fields[match[1]] = match[2]
  }
  const version = fields.JAVA_VERSION ?? fields.IMPLEMENTOR_VERSION
  const majorVersion = version ? parseJavaMajorVersion(version) : undefined
  const info: ReleaseFileInfo = {}
  if (version) info.version = version
  if (majorVersion !== undefined) info.majorVersion = majorVersion
  if (fields.OS_ARCH) info.architecture = normalizeArchitecture(fields.OS_ARCH)
  const vendor = fields.IMPLEMENTOR ?? fields.JAVA_VENDOR
  if (vendor) info.vendor = vendor
  return info
}

export interface JavaVersionOutput {
  version?: string
  majorVersion?: number
  architecture?: JavaArchitecture
  vendor?: string
}

export function parseJavaVersionOutput(output: string): JavaVersionOutput {
  const props: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z0-9_.]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) props[match[1]] = match[2]
  }

  let version = props['java.version'] ?? props['java.runtime.version']
  if (!version) {
    const banner = /(?:openjdk|java) version "([^"]+)"/i.exec(output)
    if (banner) version = banner[1]
  }

  const majorVersion = version ? parseJavaMajorVersion(version) : undefined
  const result: JavaVersionOutput = {}
  if (version) result.version = version
  if (majorVersion !== undefined) result.majorVersion = majorVersion
  if (props['os.arch']) result.architecture = normalizeArchitecture(props['os.arch'])
  const vendor = props['java.vendor'] ?? props['java.vm.vendor']
  if (vendor) result.vendor = vendor
  return result
}
