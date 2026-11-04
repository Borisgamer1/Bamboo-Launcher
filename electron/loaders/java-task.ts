import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { hashFile } from '../download/checksum'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { LoaderError, isAbortError } from './errors'
import type { ProcessorOutput, ProcessorOutputIssue } from './types'

export const ARG_FILE_THRESHOLD = 16_000

export interface JavaCommand {
  executable: string
  args: string[]
  cwd?: string
}

export type JavaTaskStrategy = JavaCommand[]

export interface JavaTaskSpec {
  id: string
  strategies: JavaTaskStrategy[]
  outputs: ProcessorOutput[]
  skipIfOutputsValid: boolean
  label?: string
}

export interface JavaTaskRunOptions {
  signal?: AbortSignal
  logger?: Logger
  useArgFile?: boolean
  argFileThreshold?: number
  timeoutMs?: number
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
  runCommand?: (command: JavaCommand, context: { signal?: AbortSignal }) => Promise<JavaCommandResult>
}

export interface JavaCommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface JavaTaskResult {
  ran: boolean
  strategy: number
  commands: number
  outputs: number
  durationMs: number
}

export function classpathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':'
}

export function findMainClass(jarPath: string): string {
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch (error) {
    throw new LoaderError('processor', `Prozessor-JAR nicht lesbar: ${jarPath}`, { cause: error })
  }
  const manifest = zip.getEntry('META-INF/MANIFEST.MF')
  if (!manifest) {
    throw new LoaderError('processor', `Prozessor-JAR ohne MANIFEST.MF: ${jarPath}`)
  }
  const text = manifest.getData().toString('utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = /^Main-Class:\s*(.+?)\s*$/.exec(line)
    if (match?.[1]) return match[1]
  }
  throw new LoaderError('processor', `Prozessor-JAR ohne Main-Class: ${jarPath}`)
}

async function isZipFile(target: string): Promise<boolean> {
  try {
    const handle = await open(target, 'r')
    try {
      const magic = Buffer.alloc(4)
      const { bytesRead } = await handle.read(magic, 0, 4, 0)
      return (
        bytesRead === 4 &&
        magic[0] === 0x50 &&
        magic[1] === 0x4b &&
        magic[2] === 0x03 &&
        magic[3] === 0x04
      )
    } finally {
      await handle.close()
    }
  } catch (error) {
    getDefaultLogger().child('loaders:java-task').debug('zip probe failed; treating output as invalid', {
      target,
      error: describeError(error),
    })
    return false
  }
}

function zipHasEntries(target: string): boolean {
  try {
    const zip = new AdmZip(target)
    return zip.getEntries().some((entry) => !entry.isDirectory)
  } catch (error) {
    getDefaultLogger().child('loaders:java-task').debug('zip entries unreadable; treating output as corrupt', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function diagnoseProcessorOutput(
  output: ProcessorOutput,
): Promise<ProcessorOutputIssue | undefined> {
  const reasonFor = (
    reason: ProcessorOutputIssue['reason'],
    actualChecksum?: string,
  ): ProcessorOutputIssue => ({
    processor: output.path,
    file: output.path,
    ...(output.checksum ? { expectedChecksum: output.checksum.value } : {}),
    ...(actualChecksum ? { actualChecksum } : {}),
    reason,
  })

  let info
  try {
    info = await stat(output.path)
  } catch (error) {
    getDefaultLogger().child('loaders:java-task').debug('processor output probe failed; reporting missing', {
      file: output.path,
      error: describeError(error),
    })
    return reasonFor('missing')
  }
  if (!info.isFile()) return reasonFor('missing')

  if (output.checksum) {
    const actual = await hashFile(output.checksum.algorithm, output.path)
    if (actual.toLowerCase() !== output.checksum.value.toLowerCase()) {
      return reasonFor('checksum', actual)
    }
  }

  if (output.validator === 'zip' && !(await isZipFile(output.path))) {
    return reasonFor('corrupt')
  }
  if (output.validator === 'zip' && !zipHasEntries(output.path)) {
    return reasonFor('corrupt')
  }
  if (output.validator === 'json') {
    try {
      JSON.parse(await readFile(output.path, 'utf8'))
    } catch (error) {
      getDefaultLogger().child('loaders:java-task').debug('processor output json unreadable; reporting corrupt', {
        file: output.path,
        error: describeError(error),
      })
      return reasonFor('corrupt')
    }
  }
  return undefined
}

export async function diagnoseProcessorOutputs(
  outputs: ProcessorOutput[],
): Promise<ProcessorOutputIssue[]> {
  const issues: ProcessorOutputIssue[] = []
  for (const output of outputs) {
    const issue = await diagnoseProcessorOutput(output)
    if (issue) issues.push(issue)
  }
  return issues
}

export async function outputsAreValid(outputs: ProcessorOutput[]): Promise<boolean> {
  if (outputs.length === 0) return false
  return (await diagnoseProcessorOutputs(outputs)).length === 0
}

export function formatArgFile(args: readonly string[]): string {
  const lines = args.map((argument) => {
    if (argument.includes('\n') || argument.includes('\r')) {
      throw new LoaderError('invalid', 'Argument mit Zeilenumbruch kann nicht in eine Argfile geschrieben werden')
    }
    return `"${argument.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  })
  return `${lines.join('\n')}\n`
}

async function runCommandSpawn(
  command: JavaCommand,
  options: { signal?: AbortSignal; timeoutMs: number; onLog?: JavaTaskRunOptions['onLog'] },
): Promise<JavaCommandResult> {
  return new Promise<JavaCommandResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      ...(command.cwd ? { cwd: command.cwd } : {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new LoaderError('processor', `Prozessor-Timeout nach ${options.timeoutMs} ms: ${command.executable}`))
    }, Math.max(1, options.timeoutMs))
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new LoaderError('aborted', 'Loader-Installation abgebrochen'))
    }
    if (options.signal) {
      if (options.signal.aborted) {
        abort()
        return
      }
      options.signal.addEventListener('abort', abort, { once: true })
    }
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) options.onLog?.(line, stream)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      reject(
        new LoaderError('processor', `Prozessor konnte nicht gestartet werden: ${error.message}`, {
          cause: error,
        }),
      )
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr })
    })
  })
}

async function executeStrategy(
  strategy: JavaTaskStrategy,
  options: JavaTaskRunOptions,
): Promise<{ commands: number; result: JavaCommandResult }> {
  let last: JavaCommandResult = { code: null, stdout: '', stderr: '' }
  let index = 0
  for (const command of strategy) {
    if (options.signal?.aborted) throw new LoaderError('aborted', 'Loader-Installation abgebrochen')
    index += 1
    const threshold = options.argFileThreshold ?? ARG_FILE_THRESHOLD
    const argumentLength = command.args.reduce((total, argument) => total + argument.length + 1, 0)
    const useArgFile = options.useArgFile === true || argumentLength > threshold
    let tempDir: string | undefined
    let executed = command
    if (useArgFile) {
      tempDir = await mkdtemp(path.join(tmpdir(), 'bamboo-argfile-'))
      const argFile = path.join(tempDir, `args-${randomBytes(4).toString('hex')}.txt`)
      await writeFile(argFile, formatArgFile(command.args), 'utf8')
      executed = { ...command, args: [`@${argFile}`] }
    }
    try {
      const result = options.runCommand
        ? await options.runCommand(executed, options.signal ? { signal: options.signal } : {})
        : await runCommandSpawn(executed, {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
            ...(options.onLog ? { onLog: options.onLog } : {}),
          })
      last = result
      if (result.code !== 0) {
        const output = `${result.stderr}\n${result.stdout}`.trim()
        throw new LoaderError(
          'processor',
          `Prozessor endete mit Exit-Code ${result.code ?? 'null'}${output ? `: ${output.slice(0, 2000)}` : ''}`,
        )
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return { commands: index, result: last }
}

export async function runJavaTask(
  spec: JavaTaskSpec,
  options: JavaTaskRunOptions = {},
): Promise<JavaTaskResult> {
  const started = Date.now()
  if (spec.skipIfOutputsValid && (await outputsAreValid(spec.outputs))) {
    return { ran: false, strategy: -1, commands: 0, outputs: spec.outputs.length, durationMs: 0 }
  }

  const errors: string[] = []
  for (let index = 0; index < spec.strategies.length; index += 1) {
    const strategy = spec.strategies[index]
    if (strategy.length === 0) continue
    try {
      const executed = await executeStrategy(strategy, options)
      if (spec.outputs.length > 0) {
        const issues = await diagnoseProcessorOutputs(spec.outputs)
        if (issues.length > 0) {
          const summary = issues
            .map((issue) => `${issue.file} (${issue.reason})`)
            .join(', ')
          errors.push(`Strategie ${index + 1}: Ausgaben ungültig: ${summary}`)
          options.logger?.warn('Prozessor-Ausgaben ungültig, nächste Strategie', {
            id: spec.id,
            summary,
          })
          if (options.signal?.aborted) throw new LoaderError('aborted', 'Loader-Installation abgebrochen')
          continue
        }
      }
      options.logger?.info('Prozessor-Task erfolgreich', {
        id: spec.id,
        strategy: index + 1,
        commands: executed.commands,
        outputs: spec.outputs.length,
      })
      return {
        ran: true,
        strategy: index,
        commands: executed.commands,
        outputs: spec.outputs.length,
        durationMs: Date.now() - started,
      }
    } catch (error) {
      if (error instanceof LoaderError && error.code === 'aborted') throw error
      if (isAbortError(error)) throw new LoaderError('aborted', 'Loader-Installation abgebrochen', { cause: error })
      errors.push(`Strategie ${index + 1}: ${(error as Error).message}`)
      options.logger?.warn('Prozessor-Strategie fehlgeschlagen', {
        id: spec.id,
        strategy: index + 1,
        error: (error as Error).message,
      })
    }
  }

  throw new LoaderError('processor', `Prozessor-Task ${spec.id} fehlgeschlagen`, {
    details: errors,
    cause: errors[0],
  })
}

export { isZipFile }
