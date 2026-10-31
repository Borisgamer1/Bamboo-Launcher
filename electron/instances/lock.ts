import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describeError, getDefaultLogger, type Logger } from '../logger'
import { InstanceLock, INSTANCE_OPERATIONS, InstanceLockSchema, parseWithDefaults } from '../schemas'
import { InstanceError } from './errors'
import { INSTANCE_LOCK_FILE } from './layout'

export type InstanceOperation = (typeof INSTANCE_OPERATIONS)[number]

export interface AcquireLockOptions {
  operation: InstanceOperation
  instanceId: string
  ttlMs?: number
  owner?: string
  pid?: number
}

export interface InstanceLockHandle {
  readonly lock: InstanceLock
  readonly file: string
  readonly dir: string
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by another user; any other
    // failure is treated as a dead holder so an orphaned lock cannot block forever.
    getDefaultLogger().child('instances:lock').debug('process liveness probe failed', {
      pid,
      error: describeError(error),
    })
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function lockFile(dir: string): string {
  return join(dir, INSTANCE_LOCK_FILE)
}

export class InstanceLocks {
  readonly #logger?: Logger

  constructor(logger?: Logger) {
    this.#logger = logger
  }

  async read(dir: string): Promise<InstanceLock | undefined> {
    let text: string
    try {
      text = await readFile(lockFile(dir), 'utf8')
    } catch (error) {
      // No lock file is the normal unlocked state; other read failures are recorded.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        getDefaultLogger().child('instances:lock').debug('instance lock unreadable', {
          dir,
          error: describeError(error),
        })
      }
      return undefined
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      return parseWithDefaults(InstanceLockSchema, raw, {
        version: 1,
        owner: '',
        pid: 0,
        operation: 'launch',
        instanceId: '',
        createdAt: 0,
        expiresAt: 0,
      } as InstanceLock)
    } catch (error) {
      // A corrupt lock is treated as absent; it is replaced on the next acquire.
      this.#logger?.warn('Instance lock file is corrupt; treating it as absent', {
        dir,
        error: describeError(error),
      })
      return undefined
    }
  }

  isStale(lock: InstanceLock | undefined, now = Date.now()): boolean {
    if (!lock) return false
    if (lock.expiresAt > 0 && lock.expiresAt <= now) return true
    if (lock.pid > 0 && !processIsAlive(lock.pid)) return true
    return lock.pid <= 0 && lock.expiresAt <= 0
  }

  async acquire(dir: string, options: AcquireLockOptions): Promise<InstanceLockHandle> {
    const file = lockFile(dir)
    const now = Date.now()
    const owner = options.owner ?? `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
    const lock: InstanceLock = {
      version: 1,
      owner,
      pid: options.pid ?? process.pid,
      operation: options.operation,
      instanceId: options.instanceId,
      createdAt: now,
      expiresAt: now + (options.ttlMs ?? DEFAULT_TTL_MS),
    }
    const payload = `${JSON.stringify(lock, null, 2)}\n`

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle
      try {
        handle = await open(file, 'wx')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        const existing = await this.read(dir)
        if (existing && this.isStale(existing)) {
          this.#logger?.warn('Taking over stale instance lock', {
            dir,
            owner: existing.owner,
            pid: existing.pid,
            operation: existing.operation,
          })
          await rm(file, { force: true })
          continue
        }
        throw new InstanceError('locked', `Instance is busy: ${dir}`, {
          dir,
          operation: options.operation,
          heldBy: existing ?? null,
        })
      }
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return { lock, file, dir }
    }
    throw new InstanceError('locked', `Instance lock could not be acquired: ${dir}`, {
      dir,
      operation: options.operation,
    })
  }

  async release(handle: InstanceLockHandle): Promise<void> {
    await this.releaseAt(handle.dir, handle.lock.owner)
  }

  async releaseAt(dir: string, owner: string): Promise<void> {
    const current = await this.read(dir)
    if (current && current.owner !== owner) return
    await rm(lockFile(dir), { force: true }).catch((error) => {
      this.#logger?.debug('Instance lock file could not be removed on release', {
        dir,
        error: describeError(error),
      })
    })
  }
}
