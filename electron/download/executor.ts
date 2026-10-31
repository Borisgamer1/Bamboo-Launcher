import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checksumMatches, hashFile } from './checksum'
import {
  DownloadError,
  requestBuffer,
  type FetchLike,
  type RetryOptions,
} from './http'
import { applyMaterializeTask } from './materialize'
import { resolveInside } from './paths'
import { describeError, getDefaultLogger } from '../logger'
import type { TelemetryService } from '../telemetry'
import type {
  InstallFile,
  InstallFilesTask,
  InstallJavaTask,
  InstallManifest,
  InstallProgress,
  InstallReport,
  InstallTask,
} from './types'

export interface ExecutorOptions {
  signal?: AbortSignal
  fetchImpl?: FetchLike
  retry?: RetryOptions
  maxConcurrency?: number
  maxPerHost?: number
  onProgress?: (progress: InstallProgress) => void
  writeFileImpl?: (file: string, data: Buffer) => Promise<void>
  installJava?: (task: InstallJavaTask, context: { signal: AbortSignal }) => Promise<void>
  telemetry?: TelemetryService
}

interface ProgressState {
  completedFiles: number
  totalFiles: number
  downloadedFiles: number
  skippedFiles: number
  bytes: number
  totalBytes: number
  downloadedBytes: number
}

class HostLimiter {
  readonly #max: number
  readonly #hosts = new Map<string, { active: number; waiters: (() => void)[] }>()

  constructor(max: number) {
    this.#max = Math.max(1, max)
  }

  async acquire(url: string): Promise<string> {
    const host = new URL(url).host
    const slot = this.#hosts.get(host) ?? { active: 0, waiters: [] }
    this.#hosts.set(host, slot)
    if (slot.active < this.#max) {
      slot.active += 1
      return host
    }
    await new Promise<void>((resolve) => slot.waiters.push(resolve))
    return host
  }

  release(host: string): void {
    const slot = this.#hosts.get(host)
    if (!slot) return
    const next = slot.waiters.shift()
    if (next) next()
    else slot.active = Math.max(0, slot.active - 1)
  }
}

function assertAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DownloadError('aborted', 'Install aborted')
}

async function isValidZip(target: string): Promise<boolean> {
  try {
    const handle = await open(target, 'r')
    try {
      const magic = Buffer.alloc(4)
      const { bytesRead } = await handle.read(magic, 0, 4, 0)
      return bytesRead === 4 && magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04
    } finally {
      await handle.close()
    }
  } catch (error) {
    getDefaultLogger().child('download').debug('zip probe failed; treating file as invalid', {
      target,
      error: describeError(error),
    })
    return false
  }
}

async function isValidJson(target: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(target, 'utf8'))
    return true
  } catch (error) {
    getDefaultLogger().child('download').debug('json probe failed; treating file as invalid', {
      target,
      error: describeError(error),
    })
    return false
  }
}

export async function isFileValid(
  target: string,
  file: Pick<InstallFile, 'size' | 'checksum' | 'validator' | 'trustExistingSize'>,
): Promise<boolean> {
  try {
    const info = await stat(target)
    if (!info.isFile()) return false
    if (file.size !== undefined && info.size !== file.size) return false
    if (file.trustExistingSize && file.size !== undefined) return true
    if (file.checksum) {
      return checksumMatches(file.checksum, await hashFile(file.checksum.algorithm, target))
    }
    if (file.validator === 'zip') return isValidZip(target)
    if (file.validator === 'json') return isValidJson(target)
    return false
  } catch (error) {
    getDefaultLogger().child('download').debug('file validation failed; treating file as missing', {
      target,
      error: describeError(error),
    })
    return false
  }
}

function validateManifest(manifest: InstallManifest): InstallTask[] {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.tasks)) {
    throw new DownloadError('invalid', 'Unsupported install manifest')
  }
  const byId = new Map<string, InstallTask>()
  for (const task of manifest.tasks) {
    if (!task.id) throw new DownloadError('invalid', 'Install task is missing an id')
    if (byId.has(task.id)) throw new DownloadError('invalid', `Duplicate install task id: ${task.id}`)
    byId.set(task.id, task)
  }
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const task of manifest.tasks) {
    const deps = task.dependsOn ?? []
    indegree.set(task.id, deps.length)
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new DownloadError('invalid', `Unknown dependency ${dep} of install task ${task.id}`)
      }
      const list = dependents.get(dep) ?? []
      list.push(task.id)
      dependents.set(dep, list)
    }
  }
  const queue = manifest.tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id)
  const order: InstallTask[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(byId.get(id)!)
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 1) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (order.length !== manifest.tasks.length) {
    const cyclic = manifest.tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id)
    throw new DownloadError('invalid', `Cyclic install task dependencies: ${cyclic.join(', ')}`)
  }
  return order
}

async function runPool<T>(
  items: T[],
  limit: number,
  controller: AbortController,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  let firstError: unknown
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      if (controller.signal.aborted) {
        if (controller.signal.reason instanceof Error) firstError ??= controller.signal.reason
        return
      }
      const current = index
      index += 1
      if (current >= items.length) return
      try {
        await worker(items[current])
      } catch (error) {
        firstError ??= error
        controller.abort(error)
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError) throw firstError
}

export async function runInstallManifest(
  manifest: InstallManifest,
  options: ExecutorOptions = {},
): Promise<InstallReport> {
  if (!options.telemetry) return runInstallManifestInternal(manifest, options)
  const started = Date.now()
  try {
    const report = await runInstallManifestInternal(manifest, options)
    options.telemetry.record('download', { ok: true, durationMs: Date.now() - started })
    return report
  } catch (error) {
    options.telemetry.record('download', {
      ok: false,
      code: (error as { code?: string }).code,
      durationMs: Date.now() - started,
    })
    throw error
  }
}

async function runInstallManifestInternal(
  manifest: InstallManifest,
  options: ExecutorOptions = {},
): Promise<InstallReport> {
  const started = Date.now()
  const order = validateManifest(manifest)
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 4)
  const limiter = new HostLimiter(options.maxPerHost ?? 6)

  const externalSignal = options.signal
  const controller = new AbortController()
  const abortFromExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternal()
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true })
  }

  const tempFiles = new Set<string>()
  const state: ProgressState = {
    completedFiles: 0,
    totalFiles: 0,
    downloadedFiles: 0,
    skippedFiles: 0,
    bytes: 0,
    totalBytes: 0,
    downloadedBytes: 0,
  }
  for (const task of order) {
    if (task.type !== 'files') continue
    state.totalFiles += task.files.length
    for (const file of task.files) state.totalBytes += file.size ?? 0
  }

  const emit = (progress: Omit<InstallProgress, keyof ProgressState | 'bytesPerSecond'>) => {
    const elapsedSeconds = Math.max(1, Date.now() - started) / 1000
    options.onProgress?.({
      ...progress,
      completedFiles: state.completedFiles,
      totalFiles: state.totalFiles,
      downloadedFiles: state.downloadedFiles,
      skippedFiles: state.skippedFiles,
      bytes: state.bytes,
      totalBytes: state.totalBytes,
      downloadedBytes: state.downloadedBytes,
      bytesPerSecond: Math.round(state.bytes / elapsedSeconds),
    })
  }

  const handleFile = async (task: InstallFilesTask, file: InstallFile): Promise<void> => {
    assertAborted(controller.signal)
    const target = resolveInside(task.destination, file.path)
    if (!file.replace && (await isFileValid(target, file))) {
      state.skippedFiles += 1
      state.completedFiles += 1
      state.bytes += file.size ?? 0
      emit({ phase: 'file-skip', taskId: task.id, taskType: 'files', currentFile: file.path })
      return
    }
    assertAborted(controller.signal)
    if (file.urls.length === 0 || !file.urls[0]) {
      throw new DownloadError('invalid', `No URL for ${file.path}`)
    }
    emit({ phase: 'file-start', taskId: task.id, taskType: 'files', currentFile: file.path })
    const host = await limiter.acquire(file.urls[0])
    try {
      const response = await requestBuffer({
        urls: file.urls,
        size: file.size,
        checksum: file.checksum,
        fetchImpl: options.fetchImpl,
        retry: options.retry,
        signal: controller.signal,
      })
      await mkdir(path.dirname(target), { recursive: true })
      const temp = `${target}.bamboo-${randomBytes(6).toString('hex')}.part`
      tempFiles.add(temp)
      try {
        await (options.writeFileImpl ?? writeFile)(temp, response.buffer)
        if (file.executable && process.platform !== 'win32') await chmod(temp, 0o755)
        // The previous file contents are never truncated in place.
        await rename(temp, target)
        tempFiles.delete(temp)
      } finally {
        if (tempFiles.delete(temp)) await rm(temp, { force: true }).catch(() => undefined)
      }
      state.downloadedFiles += 1
      state.completedFiles += 1
      state.bytes += response.buffer.length
      state.downloadedBytes += response.buffer.length
      emit({ phase: 'file-done', taskId: task.id, taskType: 'files', currentFile: file.path })
    } finally {
      limiter.release(host)
    }
  }

  try {
    for (const task of order) {
      assertAborted(controller.signal)
      emit({ phase: 'task-start', taskId: task.id, taskType: task.type })
      if (task.type === 'files') {
        const limit = Math.min(maxConcurrency, task.concurrency ?? maxConcurrency)
        await runPool(task.files, limit, controller, async (file) => handleFile(task, file))
      } else if (task.type === 'java') {
        if (!options.installJava) {
          throw new DownloadError('invalid', `No Java installer registered for task ${task.id}`)
        }
        await options.installJava(task, { signal: controller.signal })
      } else {
        await applyMaterializeTask(task, { signal: controller.signal })
      }
      emit({ phase: 'task-done', taskId: task.id, taskType: task.type })
    }
    assertAborted(controller.signal)
    emit({ phase: 'done' })
  } catch (error) {
    if (
      externalSignal?.aborted &&
      !(error instanceof DownloadError && error.code === 'aborted')
    ) {
      throw new DownloadError('aborted', 'Install aborted', { cause: error })
    }
    throw error
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    if (controller.signal.aborted) {
      for (const temp of tempFiles) {
        await rm(temp, { force: true }).catch(() => undefined)
      }
      tempFiles.clear()
    }
  }

  return {
    tasks: order.length,
    files: state.totalFiles,
    downloadedFiles: state.downloadedFiles,
    skippedFiles: state.skippedFiles,
    bytes: state.bytes,
    downloadedBytes: state.downloadedBytes,
    durationMs: Date.now() - started,
  }
}

