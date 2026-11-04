/**
 * A mutex that holds inside one process and between processes: an in-process FIFO
 * per target plus an exclusive `<target>.lock` file that records the holding
 * process. The holder is only ever displaced when it is gone or the lock is older
 * than `staleMs`, so a killed writer cannot leave an instance unwritable.
 *
 * The lock file sits next to the guarded file rather than inside it, so an
 * interrupted process can never leave the guarded file half-written by the lock.
 */
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describeError, getDefaultLogger, type Logger } from './logger'

/** A recorded holder that is no longer running can never release its lock. */
function holderIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A probe that fails for a reason other than "no such process" is treated as alive,
    // so an unreadable process table never causes a live lock to be stolen.
    getDefaultLogger().child('file-lock').debug('holder liveness probe failed', {
      pid,
      error: describeError(error),
    })
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export interface FileLockOptions {
  /** How long to wait for another holder before giving up. */
  timeoutMs?: number
  /** A lock file older than this is treated as abandoned and removed. */
  staleMs?: number
  sleep?: (ms: number) => Promise<void>
  logger?: Logger
  /** Error thrown when the lock is still held after `timeoutMs`. */
  busy?: (target: string) => Error
}

export class FileLock {
  readonly #timeoutMs: number
  readonly #staleMs: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #logger?: Logger
  readonly #busy: (target: string) => Error
  readonly #queues = new Map<string, Promise<void>>()

  constructor(options: FileLockOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#staleMs = options.staleMs ?? 30_000
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#logger = options.logger
    this.#busy = options.busy ?? ((target) => new Error(`Lock is held: ${target}`))
  }

  async with<T>(target: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(target) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.#queues.set(target, tail)
    await previous

    const lockFile = `${target}.lock`
    try {
      await mkdir(dirname(lockFile), { recursive: true })
      await this.#acquire(lockFile, target)
      try {
        return await task()
      } finally {
        await rm(lockFile, { force: true }).catch((error) => {
          getDefaultLogger().child('file-lock').debug('lock file could not be removed after task', {
            lockFile,
            error: describeError(error),
          })
        })
      }
    } finally {
      release()
      if (this.#queues.get(target) === tail) this.#queues.delete(target)
    }
  }

  async #acquire(lockFile: string, target: string): Promise<void> {
    const deadline = Date.now() + this.#timeoutMs
    for (;;) {
      try {
        const handle = await open(lockFile, 'wx')
        // Recording the holder lets a crash be recognised as a crash instead of
        // being mistaken for a slow writer and waited out.
        await handle.writeFile(String(process.pid))
        await handle.close()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (await this.#abandoned(lockFile)) {
        await rm(lockFile, { force: true }).catch((error) => {
          getDefaultLogger().child('file-lock').debug('abandoned lock could not be removed', {
            lockFile,
            error: describeError(error),
          })
        })
        continue
      }
      if (Date.now() >= deadline) throw this.#busy(target)
      await this.#sleep(20)
    }
  }

  /**
   * True when the lock file is gone, its recorded holder is dead, or it is older
   * than `staleMs`. A holder that is still running is never stolen from, however
   * long it takes.
   */
  async #abandoned(lockFile: string): Promise<boolean> {
    const info = await stat(lockFile).catch(() => undefined)
    if (!info) return true
    let holderText = ''
    try {
      holderText = await readFile(lockFile, 'utf8')
    } catch (error) {
      // An unreadable holder record is judged by the lock's age below.
      getDefaultLogger().child('file-lock').debug('lock holder record unreadable', {
        lockFile,
        error: describeError(error),
      })
    }
    const holder = Number.parseInt(holderText, 10)
    if (Number.isSafeInteger(holder) && holder > 0) {
      if (holderIsAlive(holder)) return false
      this.#logger?.warn('Removing a lock whose process is gone', { lockFile, holder })
      return true
    }
    if (Date.now() - info.mtimeMs > this.#staleMs) {
      this.#logger?.warn('Removing a stale lock', { lockFile })
      return true
    }
    return false
  }
}
