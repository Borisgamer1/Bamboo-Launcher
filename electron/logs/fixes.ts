import { mkdir, open, readFile, rename, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../atomic'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { InstanceError } from '../instances/errors'
import type { InstanceLocks } from '../instances/lock'
import type { InstanceFile } from '../schemas'
import { getAnalysis } from './analyze'
import type { AnalysisContext, FixAction, FixDeps, FixResult } from './types'

interface DisabledEntry {
  jar: string
  from: string
  to: string
  at: string
}

interface UndoRecord {
  instanceId: string
  instanceDir: string
  changed: string[]
  requiresRestart: boolean
  undo: () => Promise<string[]>
}

const undoRecords = new Map<string, UndoRecord>()
let undoCounter = 0

type LockHandle = Awaited<ReturnType<InstanceLocks['acquire']>>

function errorCode(error: unknown): 'EACCES' | 'ENOENT' {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'ENOENT'
  return 'EACCES'
}

function failure(error: unknown): FixResult {
  return {
    ok: false,
    code: errorCode(error),
    message: (error as Error).message,
  }
}

function token(): string {
  undoCounter += 1
  return `undo-${Date.now()}-${undoCounter}`
}

function success(
  context: AnalysisContext,
  changed: string[],
  requiresRestart: boolean,
  undo: () => Promise<string[]>,
): FixResult {
  const undoToken = token()
  undoRecords.set(undoToken, {
    instanceId: context.instanceId,
    instanceDir: context.instanceDir,
    changed,
    requiresRestart,
    undo,
  })
  return { ok: true, changed, undoToken, requiresRestart }
}

async function lock(
  deps: FixDeps,
  context: AnalysisContext,
): Promise<{ handle: LockHandle } | FixResult> {
  try {
    return {
      handle: await deps.locks.acquire(context.instanceDir, {
        operation: 'fix',
        instanceId: context.instanceId,
      }),
    }
  } catch (error) {
    if (error instanceof InstanceError && error.code === 'locked') {
      return { ok: false, code: 'LOCKED', message: error.message }
    }
    return failure(error)
  }
}

async function readIndex(targetDir: string): Promise<DisabledEntry[]> {
  const raw = await readJsonFile<unknown>(join(targetDir, 'index.json'))
  if (Array.isArray(raw)) return raw as DisabledEntry[]
  if (raw && typeof raw === 'object') {
    const entries = (raw as { entries?: unknown }).entries
    if (Array.isArray(entries)) return entries as DisabledEntry[]
  }
  return []
}

async function writeIndex(targetDir: string, entries: DisabledEntry[], logger?: Logger): Promise<void> {
  await writeJsonFile(join(targetDir, 'index.json'), { version: 1, entries }, logger)
}

async function assertIndexWritable(targetDir: string): Promise<void> {
  const file = join(targetDir, 'index.json')
  let handle
  try {
    handle = await open(file, 'r+')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  } finally {
    await handle?.close()
  }
}

async function uniqueDisabledPath(
  targetDir: string,
  jar: string,
): Promise<{ path: string; stamp: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let directory = join(targetDir, stamp)
  let index = 2
  for (;;) {
    const path = join(directory, jar)
    try {
      await readFile(path)
      directory = join(targetDir, `${stamp}-${index}`)
      index += 1
    } catch (error) {
      // A missing file means the slot is free; anything else is worth a debug line.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        getDefaultLogger().child('logs').debug('disabled-slot probe failed; trying the next slot', { path, error: describeError(error) })
      }
      await mkdir(directory, { recursive: true })
      return { path, stamp }
    }
  }
}

async function disableMod(
  action: Extract<FixAction, { kind: 'disable-mod' }>,
  context: AnalysisContext,
  logger?: Logger,
): Promise<FixResult> {
  const jar = basename(action.jar)
  if (!jar || jar === '.' || jar === '..') {
    return { ok: false, code: 'INVALID', message: `Ungültiger JAR-Name: ${action.jar}` }
  }
  const source = join(context.instanceDir, 'mods', jar)
  const target = await uniqueDisabledPath(action.targetDir, jar)
  const entries = await readIndex(action.targetDir)
  const entry: DisabledEntry = {
    jar,
    from: source,
    to: target.path,
    at: new Date().toISOString(),
  }

  try {
    await assertIndexWritable(action.targetDir)
    await writeIndex(action.targetDir, [...entries, entry], logger)
  } catch (error) {
    await rmdir(dirname(target.path)).catch(() => undefined)
    return failure(error)
  }
  try {
    await rename(source, target.path)
  } catch (error) {
    await writeIndex(action.targetDir, entries, logger).catch(() => undefined)
    await rmdir(dirname(target.path)).catch(() => undefined)
    return failure(error)
  }

  return success(context, [source, target.path], true, async () => {
    const remaining = entries.filter((item) => item.to !== target.path)
    try {
      await assertIndexWritable(action.targetDir)
      await writeIndex(action.targetDir, remaining, logger)
      await rename(target.path, source)
    } catch (error) {
      await writeIndex(action.targetDir, [...entries, entry], logger).catch(() => undefined)
      throw error
    }
    return [source, target.path]
  })
}

async function switchJava(
  action: Extract<FixAction, { kind: 'switch-java' }>,
  context: AnalysisContext,
  deps: FixDeps,
): Promise<FixResult> {
  const java = await deps.findJava?.(action.major)
  if (!java) {
    return {
      ok: false,
      code: 'ENOENT',
      message: `Keine installierte Java-${action.major}-Runtime gefunden`,
    }
  }
  const previous: Partial<InstanceFile> = {
    javaMode: context.javaMode ?? 'auto',
    javaPath: context.javaPath ?? '',
    resolvedJava: context.resolvedJava,
  }
  try {
    await deps.updateFile(context.instanceId, {
      javaMode: 'pinned',
      javaPath: java.path,
      resolvedJava: undefined,
    })
  } catch (error) {
    return failure(error)
  }
  return success(context, ['javaMode', 'javaPath', 'resolvedJava'], true, async () => {
    await deps.updateFile(context.instanceId, previous)
    return ['javaMode', 'javaPath', 'resolvedJava']
  })
}

async function raiseHeap(
  action: Extract<FixAction, { kind: 'raise-heap' }>,
  context: AnalysisContext,
  deps: FixDeps,
): Promise<FixResult> {
  const previous: Partial<InstanceFile> = {
    maxMemory: context.maxMemoryMb,
    memoryMode: context.memoryMode ?? 'auto',
  }
  try {
    await deps.updateFile(context.instanceId, {
      maxMemory: action.toMb,
      memoryMode: 'explicit',
    })
  } catch (error) {
    return failure(error)
  }
  return success(context, ['maxMemory', 'memoryMode'], true, async () => {
    await deps.updateFile(context.instanceId, previous)
    return ['maxMemory', 'memoryMode']
  })
}

async function installDependency(
  action: Extract<FixAction, { kind: 'install-dependency' }>,
  context: AnalysisContext,
  deps: FixDeps,
  logger?: Logger,
): Promise<FixResult> {
  if (!deps.installDependency) {
    return { ok: false, code: 'ENOENT', message: 'Kein Dependency-Installer verfügbar' }
  }
  const installed = await deps.installDependency(action, context)
  if (!installed) {
    return { ok: false, code: 'ENOENT', message: `Abhängigkeit ${action.modId} konnte nicht aufgelöst werden` }
  }
  if (installed.files.length === 0) {
    return { ok: true, changed: [], requiresRestart: false }
  }
  const targetDir = join(context.instanceDir, 'mods-disabled')
  return success(context, installed.files, true, async () => {
    const moved: Array<{ from: string; to: string }> = []
    try {
      for (const file of installed.files) {
        const target = await uniqueDisabledPath(targetDir, basename(file))
        await rename(file, target.path)
        moved.push({ from: file, to: target.path })
      }
    } catch (error) {
      for (const entry of moved.reverse()) {
        await rename(entry.to, entry.from).catch(() => undefined)
      }
      throw error
    }
    for (const entry of moved) {
      logger?.info('Installed dependency moved to mods-disabled on undo', {
        file: entry.from,
        target: entry.to,
      })
    }
    return moved.flatMap((entry) => [entry.from, entry.to])
  })
}

export async function applyFixAction(
  analysisId: string,
  actionId: string,
  deps: FixDeps,
  options: { logger?: Logger } = {},
): Promise<FixResult> {
  const record = getAnalysis(analysisId)
  if (!record) return { ok: false, code: 'INVALID', message: 'Analyse ist nicht mehr verfügbar' }
  const action = record.result.findings
    .flatMap((finding) => finding.actions)
    .find((item) => item.id === actionId)
  if (!action) return { ok: false, code: 'INVALID', message: 'Aktion ist nicht mehr verfügbar' }

  if (action.kind === 'open-path') {
    if (!deps.openPath) {
      return { ok: false, code: 'ENOENT', message: 'Kein Open-Handler für Pfade verfügbar' }
    }
    try {
      const error = await deps.openPath(action.path)
      if (error) return { ok: false, code: 'EACCES', message: String(error) }
    } catch (error) {
      return failure(error)
    }
    return { ok: true, changed: [action.path], requiresRestart: false }
  }
  if (action.kind === 'open-url') {
    if (!deps.openUrl) {
      return { ok: false, code: 'ENOENT', message: 'Kein Open-Handler für URLs verfügbar' }
    }
    try {
      await deps.openUrl(action.url)
    } catch (error) {
      return failure(error)
    }
    return { ok: true, changed: [action.url], requiresRestart: false }
  }

  const locked = await lock(deps, record.context)
  if ('ok' in locked) return locked
  try {
    switch (action.kind) {
      case 'disable-mod':
        return await disableMod(action, record.context, options.logger)
      case 'switch-java':
        return await switchJava(action, record.context, deps)
      case 'raise-heap':
        return await raiseHeap(action, record.context, deps)
      case 'install-dependency':
        return await installDependency(action, record.context, deps, options.logger)
    }
  } catch (error) {
    return failure(error)
  } finally {
    await deps.locks.release(locked.handle).catch(() => undefined)
  }
}

export async function undoFixAction(
  undoToken: string,
  deps: FixDeps,
  options: { logger?: Logger } = {},
): Promise<FixResult> {
  const record = undoRecords.get(undoToken)
  if (!record) return { ok: false, code: 'INVALID', message: 'Undo-Token ist nicht mehr verfügbar' }
  const locked = await lock(deps, {
    instanceId: record.instanceId,
    instanceDir: record.instanceDir,
    maxMemoryMb: 0,
  })
  if ('ok' in locked) return locked
  try {
    const changed = await record.undo()
    undoRecords.delete(undoToken)
    options.logger?.info('Fix undone', { instanceId: record.instanceId })
    return {
      ok: true,
      changed,
      requiresRestart: record.requiresRestart,
    }
  } catch (error) {
    return failure(error)
  } finally {
    await deps.locks.release(locked.handle).catch(() => undefined)
  }
}
