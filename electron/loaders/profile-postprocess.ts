import { join } from 'node:path'
import { coordinatePath, parseMavenCoordinate } from '../version/libraries'
import { findMainClass, classpathDelimiter, type JavaCommand, type JavaTaskSpec } from './java-task'
import type { InstallProfile, LoaderJavaRuntime, PostProcessor, ProcessorOutput } from './types'

export interface ResolvedProcessor {
  jarPath: string
  jarName: string
  classpathPaths: string[]
  args: string[]
  outputs: ProcessorOutput[]
  mainClass?: string
  javaRuntimes: LoaderJavaRuntime[]
}

export interface ProcessorResolutionOptions {
  gameRoot: string
  side?: 'client' | 'server'
  minecraftVersion?: string
  minecraftJar?: string
  javaRuntimes: LoaderJavaRuntime[]
  installerPath?: string
}

function libraryPathForReference(reference: string, gameRoot: string): string {
  const name = reference.slice(1, -1)
  const coordinate = parseMavenCoordinate(name)
  if (!coordinate) return reference
  return join(gameRoot, 'libraries', coordinatePath(coordinate))
}

export function resolveLibraryReference(value: string, gameRoot: string): string {
  const trimmed = value.trim().replace(/^'(.*)'$/s, '$1')
  if (/^\[.+\]$/.test(trimmed)) return libraryPathForReference(trimmed, gameRoot)
  if (/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[^\\/\s]+$/.test(trimmed)) {
    const coordinate = parseMavenCoordinate(trimmed)
    if (coordinate) return join(gameRoot, 'libraries', coordinatePath(coordinate))
  }
  return trimmed
}

function isDirectoryReference(value: string, gameRoot: string): boolean {
  if (/[\\/]$/.test(value)) return true
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = gameRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized === root || normalized === `${root}/libraries`
}

export interface ProcessorVariables {
  [key: string]: { client: string; server: string }
}

export function resolveProcessorVariables(
  profile: InstallProfile,
  options: { gameRoot: string; minecraftJar?: string; installerPath?: string; minecraftVersion?: string },
): ProcessorVariables {
  const minecraftVersion = options.minecraftVersion ?? profile.minecraft
  const jarPath =
    options.minecraftJar ??
    join(options.gameRoot, 'versions', minecraftVersion, `${minecraftVersion}.jar`)
  const variables: ProcessorVariables = {
    SIDE: { client: 'client', server: 'server' },
    MINECRAFT_JAR: { client: jarPath, server: jarPath },
    ROOT: { client: options.gameRoot, server: options.gameRoot },
    MINECRAFT_VERSION: { client: minecraftVersion, server: minecraftVersion },
    LIBRARY_DIR: {
      client: join(options.gameRoot, 'libraries'),
      server: join(options.gameRoot, 'libraries'),
    },
  }
  if (options.installerPath) {
    variables.INSTALLER = { client: options.installerPath, server: options.installerPath }
  }
  for (const [key, entry] of Object.entries(profile.data ?? {})) {
    variables[key] = {
      client: resolveLibraryReference(entry.client ?? '', options.gameRoot),
      server: resolveLibraryReference(entry.server ?? '', options.gameRoot),
    }
  }
  return variables
}

function substituteValue(
  value: string,
  variables: ProcessorVariables,
  side: 'client' | 'server',
  gameRoot: string,
): string {
  const quoted = value.trim().replace(/^'(.*)'$/s, '$1')
  const replaced = quoted.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key: string) => {
    const entry = variables[key]
    return entry ? entry[side] ?? '' : match
  })
  return resolveLibraryReference(replaced, gameRoot)
}

function impliedOutputs(
  processor: PostProcessor,
  args: string[],
  variables: ProcessorVariables,
  side: 'client' | 'server',
  gameRoot: string,
): ProcessorOutput[] {
  const outputs = new Map<string, ProcessorOutput>()
  const declared = processor.outputs ?? {}
  for (const [rawKey, rawChecksum] of Object.entries(declared)) {
    const key = substituteValue(rawKey, variables, side, gameRoot)
    if (!key || isDirectoryReference(key, gameRoot)) continue
    const checksumValue = rawChecksum.trim().replace(/^'(.*)'$/s, '$1')
    const output: ProcessorOutput = {
      path: key,
      validator: /\.(jar|zip)$/i.test(key) ? 'zip' : /\.json$/i.test(key) ? 'json' : 'file',
    }
    if (/^[a-f0-9]{40}$/i.test(checksumValue)) output.checksum = { algorithm: 'sha1', value: checksumValue }
    outputs.set(key, output)
  }
  for (const flag of ['--output', '--out-jar']) {
    let index = args.indexOf(flag)
    while (index !== -1) {
      const value = args[index + 1]
      if (value && !value.startsWith('--') && !outputs.has(value) && !isDirectoryReference(value, gameRoot)) {
        outputs.set(value, {
          path: value,
          validator: /\.(jar|zip)$/i.test(value) ? 'zip' : /\.json$/i.test(value) ? 'json' : 'file',
        })
      }
      index = args.indexOf(flag, index + 1)
    }
  }
  return [...outputs.values()]
}

export function resolveProcessors(
  profile: InstallProfile,
  options: ProcessorResolutionOptions,
): ResolvedProcessor[] {
  const side = options.side ?? 'client'
  const variables = resolveProcessorVariables(profile, {
    gameRoot: options.gameRoot,
    ...(options.minecraftJar ? { minecraftJar: options.minecraftJar } : {}),
    ...(options.installerPath ? { installerPath: options.installerPath } : {}),
    ...(options.minecraftVersion ? { minecraftVersion: options.minecraftVersion } : {}),
  })

  const result: ResolvedProcessor[] = []
  for (const processor of profile.processors ?? []) {
    if (processor.sides && !processor.sides.includes(side)) continue
    const jarPath = resolveLibraryReference(processor.jar, options.gameRoot)
    const jarName = jarPath.replace(/\\/g, '/').split('/').pop() ?? processor.jar
    const classpathPaths = (processor.classpath ?? []).map((entry) =>
      resolveLibraryReference(entry, options.gameRoot),
    )
    const args = (processor.args ?? []).map((raw) =>
      substituteValue(raw, variables, side, options.gameRoot),
    )
    result.push({
      jarPath,
      jarName,
      classpathPaths,
      args,
      outputs: impliedOutputs(processor, args, variables, side, options.gameRoot),
      javaRuntimes: options.javaRuntimes,
    })
  }
  return result
}

export interface ProcessorTaskOptions {
  id: string
  cwd?: string
  useArgFile?: boolean
}

export function buildProcessorTasks(
  processors: ResolvedProcessor[],
  options: ProcessorTaskOptions,
): JavaTaskSpec[] {
  const delimiter = classpathDelimiter()
  return processors.map((processor, index) => {
    const mainClass = processor.mainClass ?? findMainClass(processor.jarPath)
    const classpath = [...processor.classpathPaths, processor.jarPath].join(delimiter)
    const strategies: JavaCommand[][] = processor.javaRuntimes.map((runtime) => [
      {
        executable: runtime.path,
        args: ['-cp', classpath, mainClass, ...processor.args],
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
    ])
    return {
      id: `${options.id}:processor-${index + 1}`,
      strategies,
      outputs: processor.outputs,
      skipIfOutputsValid: processor.outputs.length > 0,
      label: processor.jarName,
    }
  })
}

export { substituteValue as substituteProcessorVariable }
