import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import type { JavaRecord } from '../schemas'
import {
  type JavaArchitecture,
  normalizeArchitecture,
  parseJavaVersionOutput,
  parseReleaseFile,
} from './version'

const execFileAsync = promisify(execFile)

export type JavaExec = (executable: string, args: string[]) => Promise<string>
export type RegistryQuery = (key: string) => Promise<string>

export interface JavaScanOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  gameRoot?: string
  extraPaths?: string[]
  includeRegistry?: boolean
  registryQuery?: RegistryQuery
  execJava?: JavaExec
  logger?: Logger
}

export interface JavaProbeOptions {
  platform?: NodeJS.Platform
  execJava?: JavaExec
}

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\JavaSoft\\JRE',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JRE',
  'HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK',
  'HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE',
  'HKLM\\SOFTWARE\\Azul Systems\\Zulu',
  'HKLM\\SOFTWARE\\Microsoft\\JDK',
]

function javaExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'java.exe' : 'java'
}

function executableIn(home: string, platform: NodeJS.Platform): string {
  return join(home, 'bin', javaExecutableName(platform))
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch (error) {
    // Missing candidates are the normal case during discovery.
    getDefaultLogger().child('java').debug('java candidate not accessible', { target, error: describeError(error) })
    return false
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch (error) {
    // Optional scan roots often do not exist on a given machine.
    getDefaultLogger().child('java').debug('java scan root unreadable', { dir, error: describeError(error) })
    return []
  }
}

async function defaultRegistryQuery(key: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/s'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    })
    return stdout
  } catch (error) {
    // Registry keys are optional and absent on many installations.
    getDefaultLogger().child('java').debug('registry query failed', { key, error: describeError(error) })
    return ''
  }
}

export function parseRegistryJavaHomes(output: string): string[] {
  const homes: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(JavaHome|Path|InstallationPath)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line)
    if (!match) continue
    const value = match[2].trim()
    if (/^[a-zA-Z]:\\/.test(value)) homes.push(value)
  }
  return homes
}

async function collectFromRoots(roots: string[], platform: NodeJS.Platform): Promise<string[]> {
  const found: string[] = []
  for (const root of roots) {
    for (const child of await listDirectories(root)) {
      const exe = executableIn(child, platform)
      if (await exists(exe)) found.push(exe)
    }
  }
  return found
}

function mojangRuntimeRoots(env: NodeJS.ProcessEnv): string[] {
  const roaming = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [join(roaming, '.minecraft', 'runtime')]
}

async function collectMojangRuntimes(roots: string[], platform: NodeJS.Platform): Promise<string[]> {
  const found: string[] = []
  for (const root of roots) {
    for (const component of await listDirectories(root)) {
      for (const artifact of await listDirectories(component)) {
        const exe = executableIn(artifact, platform)
        if (await exists(exe)) found.push(exe)
      }
    }
  }
  return found
}

async function collectGameRootRuntimes(gameRoot: string, platform: NodeJS.Platform): Promise<string[]> {
  const found: string[] = []
  for (const component of await listDirectories(join(gameRoot, 'java'))) {
    const exe = executableIn(component, platform)
    if (await exists(exe)) found.push(exe)
    for (const nested of await listDirectories(component)) {
      const nestedExe = executableIn(nested, platform)
      if (await exists(nestedExe)) found.push(nestedExe)
    }
  }
  return found
}

export async function javaFingerprint(executable: string): Promise<string | undefined> {
  try {
    const info = await stat(executable)
    if (!info.isFile()) return undefined
    return createHash('sha1')
      .update(`${executable}|${info.size}|${info.mtimeMs}`)
      .digest('hex')
  } catch (error) {
    // An unreadable candidate is skipped; the next scan retries it.
    getDefaultLogger().child('java').debug('java fingerprint unavailable', { executable, error: describeError(error) })
    return undefined
  }
}

function normalizeCandidate(candidate: string, platform: NodeJS.Platform): string {
  const lower = candidate.toLowerCase()
  if (lower.endsWith('java.exe') || lower.endsWith('/java') || lower.endsWith('\\java')) return candidate
  return executableIn(candidate, platform)
}

export async function discoverJavaExecutables(options: JavaScanOptions = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const candidates: string[] = []

  for (const key of ['JAVA_HOME', 'JDK_HOME']) {
    const home = env[key]
    if (home) candidates.push(executableIn(home.replace(/[\\/]+$/, ''), platform))
  }

  const pathDelimiter = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? env.Path ?? '').split(pathDelimiter)) {
    if (dir.trim()) candidates.push(join(dir.trim(), javaExecutableName(platform)))
  }

  const programFiles = env.ProgramFiles ?? (platform === 'win32' ? 'C:\\Program Files' : '')
  const programFilesX86 = env['ProgramFiles(x86)'] ?? ''
  const localAppData = env.LOCALAPPDATA ?? ''
  const userProfile = env.USERPROFILE ?? (platform === 'win32' ? '' : homedir())
  const roots = [
    programFiles && join(programFiles, 'Java'),
    programFiles && join(programFiles, 'Eclipse Adoptium'),
    programFiles && join(programFiles, 'Eclipse Foundation'),
    programFiles && join(programFiles, 'Microsoft'),
    programFiles && join(programFiles, 'Zulu'),
    programFiles && join(programFiles, 'Amazon Corretto'),
    programFiles && join(programFiles, 'BellSoft'),
    programFiles && join(programFiles, 'Semeru'),
    programFiles && join(programFiles, 'AdoptOpenJDK'),
    programFilesX86 && join(programFilesX86, 'Java'),
    programFilesX86 && join(programFilesX86, 'Eclipse Adoptium'),
    localAppData && join(localAppData, 'Programs', 'Eclipse Adoptium'),
    localAppData && join(localAppData, 'Programs', 'Microsoft'),
    userProfile && join(userProfile, '.jdks'),
  ].filter((value): value is string => Boolean(value))

  candidates.push(...(await collectFromRoots(roots, platform)))

  if (options.gameRoot) candidates.push(...(await collectGameRootRuntimes(options.gameRoot, platform)))
  candidates.push(...(await collectMojangRuntimes(mojangRuntimeRoots(env), platform)))

  for (const extra of options.extraPaths ?? []) candidates.push(normalizeCandidate(extra, platform))

  if (platform === 'win32' && options.includeRegistry !== false) {
    const query = options.registryQuery ?? defaultRegistryQuery
    for (const key of REGISTRY_KEYS) {
      const output = await query(key)
      if (!output) continue
      for (const home of parseRegistryJavaHomes(output)) {
        candidates.push(executableIn(home.replace(/[\\/]+$/, ''), platform))
      }
    }
  }

  const seen = new Map<string, string>()
  for (const candidate of candidates) {
    const key = candidate.toLowerCase()
    if (!seen.has(key) && (await exists(candidate))) seen.set(key, candidate)
  }
  options.logger?.debug('Java scan finished', { candidates: seen.size })
  return [...seen.values()]
}

function defaultExecJava(executable: string, args: string[]): Promise<string> {
  return execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  }).then(({ stdout, stderr }) => `${stdout}\n${stderr}`)
}

function guessVendor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.includes('adoptium') || lower.includes('temurin')) return 'Eclipse Adoptium'
  if (lower.includes('zulu')) return 'Azul Zulu'
  if (lower.includes('corretto')) return 'Amazon Corretto'
  if (lower.includes('microsoft')) return 'Microsoft'
  if (lower.includes('semeru') || lower.includes('openj9')) return 'IBM Semeru'
  if (lower.includes('oracle') || lower.includes('jre1.8')) return 'Oracle'
  return 'Unknown'
}

export async function probeJava(executable: string, options: JavaProbeOptions = {}): Promise<JavaRecord | undefined> {
  const home = dirname(dirname(executable))
  let version: string | undefined
  let majorVersion: number | undefined
  let architecture: JavaArchitecture | undefined
  let vendor: string | undefined

  try {
    const release = await readFile(join(home, 'release'), 'utf8')
    const info = parseReleaseFile(release)
    version = info.version
    majorVersion = info.majorVersion
    architecture = info.architecture
    vendor = info.vendor
  } catch (error) {
    // No release file: fall back to reading the version from the executable.
    getDefaultLogger().child('java').debug('java release file unavailable; probing executable', {
      executable,
      error: describeError(error),
    })
  }

  if (majorVersion === undefined) {
    try {
      const output = await (options.execJava ?? defaultExecJava)(executable, ['-XshowSettings:properties', '-version'])
      const info = parseJavaVersionOutput(output)
      version = info.version ?? version
      majorVersion = info.majorVersion
      architecture = info.architecture ?? architecture
      vendor = info.vendor ?? vendor
    } catch (error) {
      // A candidate that cannot report its version is simply not a usable runtime.
      getDefaultLogger().child('java').debug('java version probe failed', { executable, error: describeError(error) })
      return undefined
    }
  }

  if (majorVersion === undefined) return undefined
  const now = Date.now()
  return {
    path: executable,
    version: version ?? String(majorVersion),
    majorVersion,
    architecture: architecture ?? normalizeArchitecture(process.arch),
    vendor: vendor ?? guessVendor(executable),
    source: 'scan',
    valid: true,
    addedAt: now,
    validatedAt: now,
  }
}
