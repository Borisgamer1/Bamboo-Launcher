import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LaunchError } from './errors'
import type {
  LaunchEvent,
  LaunchExitInfo,
  LaunchHandle,
  LaunchProcessOptions,
} from './types'

const READY_MARKERS = [
  /LWJGL Version:/i,
  /OpenAL initialized/i,
  /Reloading ResourceManager/i,
  /Preparing level/i,
  /Setting user:/i,
]
const CRASH_MARKER = /---- Minecraft Crash Report ----/
const CRASH_PATH = /Crash report saved to:\s*(.+)/i

export function resolveJavaExecutable(javaPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const javaw = join(dirname(javaPath), 'javaw.exe')
    if (existsSync(javaw)) return javaw
  }
  return javaPath
}

async function defaultKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = nodeSpawn('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export function startLaunchProcess(options: LaunchProcessOptions): LaunchHandle {
  const plan = options.plan
  const command = [...plan.command]
  if (options.resolveJavaw !== false) {
    command[0] = resolveJavaExecutable(command[0], options.platform ?? process.platform)
  }
  const spawnImpl = options.spawnImpl ?? nodeSpawn
  const emit = (event: LaunchEvent) => options.onEvent?.(event)

  let child
  try {
    child = spawnImpl(command[0], command.slice(1), {
      cwd: plan.gameDirectory,
      detached: options.detached ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      windowsHide: false,
    })
  } catch (error) {
    throw new LaunchError('spawn', `Spielprozess konnte nicht gestartet werden: ${(error as Error).message}`)
  }
  const pid = child.pid
  if (!pid) {
    throw new LaunchError('spawn', 'Spielprozess erhielt keine PID')
  }
  child.unref?.()

  const startedAt = Date.now()
  const stderrLines: string[] = []
  let ready = false
  let crashReport: string | undefined
  let settled = false
  let killed = false
  let resolveExit!: (info: LaunchExitInfo) => void
  const exit = new Promise<LaunchExitInfo>((resolve) => {
    resolveExit = resolve
  })

  const handleLine = (raw: string, stream: 'stdout' | 'stderr') => {
    const line = raw.replace(/\r$/, '')
    if (!line) return
    if (stream === 'stderr') {
      stderrLines.push(line)
      if (stderrLines.length > 200) stderrLines.shift()
    }
    if (!ready && READY_MARKERS.some((marker) => marker.test(line))) {
      ready = true
      emit({ type: 'ready' })
    }
    if (CRASH_MARKER.test(line)) {
      emit({ type: 'status', message: 'Minecraft-Crash erkannt' })
    }
    const crashMatch = CRASH_PATH.exec(line)
    if (crashMatch?.[1]) {
      crashReport = crashMatch[1].trim()
      emit({ type: 'crash-report', path: crashReport })
    }
    emit({ type: 'log', line, stream })
  }

  const attachLineReader = (stream: NodeJS.ReadableStream | null, kind: 'stdout' | 'stderr') => {
    if (!stream) return
    let buffer = ''
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line, kind)
    })
    stream.on('end', () => {
      if (buffer) handleLine(buffer, kind)
      buffer = ''
    })
  }
  attachLineReader(child.stdout, 'stdout')
  attachLineReader(child.stderr, 'stderr')

  const settle = (partial: Omit<LaunchExitInfo, 'durationMs'>) => {
    if (settled) return
    settled = true
    const info: LaunchExitInfo = { ...partial, durationMs: Date.now() - startedAt }
    if (crashReport) info.crashReport = crashReport
    options.logger?.info('Game process exited', {
      pid,
      code: info.code,
      signal: info.signal,
      durationMs: info.durationMs,
      crashReport: info.crashReport ?? '',
    })
    emit({ type: 'exit', ...info })
    resolveExit(info)
  }

  child.on('error', (error) => {
    settle({ code: null, signal: null, error: (error as Error).message })
  })
  child.on('close', (code, signal) => {
    settle({ code: code ?? null, signal: (signal as NodeJS.Signals | null) ?? null })
  })

  const kill = async (): Promise<void> => {
    if (killed || settled) return
    killed = true
    try {
      if (options.killImpl) await options.killImpl(pid)
      else await defaultKill(pid)
    } catch (error) {
      options.logger?.warn('Killing the game process failed', { pid, error: (error as Error).message })
    }
  }

  const redacted = plan.displayCommand.join(' ')
  options.logger?.info('Game process started', { pid, command: redacted, cwd: plan.gameDirectory })
  emit({ type: 'status', message: `Minecraft gestartet (PID ${pid})` })

  return {
    pid,
    plan,
    exit,
    kill,
    get killed() {
      return killed
    },
    stderrLines,
  }
}

export { defaultKill }
