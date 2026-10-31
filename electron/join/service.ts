import { basename, join } from 'node:path'
import { hashBuffer } from '../download/checksum'
import { downloadBuffer, type FetchLike } from '../download/http'
import type { LaunchEvent } from '../launch/types'
import type { Logger } from '../logger'
import { buildInviteUrl, buildJoinUrl, parseJoinUrl, validateJoinPayload } from './grammar'
import { JoinQueue, PENDING_JOIN_FILE } from './queue'
import type {
  JoinConfirmResult,
  JoinOffer,
  JoinPackSummary,
  JoinParseResult,
  JoinPayload,
  JoinPrepareResult,
  JoinPublishResult,
  JoinReceiveResult,
  JoinRuntime,
} from './types'

export interface JoinServiceOptions {
  appDataPath: string
  deliver: (payload: JoinPayload) => void
  runtime: () => Promise<JoinRuntime>
  logger?: Logger
  fetchImpl?: FetchLike
  readPack?: (url: string) => Promise<Buffer>
  now?: () => number
  maxEntries?: number
  ttlMs?: number
  queue?: JoinQueue
}

type PackCheck =
  | { ok: true; pack?: JoinPackSummary }
  | { ok: false; code: 'join.rejected-hash'; message: string }

export class JoinService {
  readonly #deliver: (payload: JoinPayload) => void
  readonly #runtime: () => Promise<JoinRuntime>
  readonly #logger?: Logger
  readonly #fetchImpl?: FetchLike
  readonly #readPack?: (url: string) => Promise<Buffer>
  readonly #queue: JoinQueue
  readonly #offers = new Map<string, JoinOffer>()
  #offerCounter = 0
  #uiReady = false

  constructor(options: JoinServiceOptions) {
    this.#deliver = options.deliver
    this.#runtime = options.runtime
    this.#logger = options.logger
    this.#fetchImpl = options.fetchImpl
    this.#readPack = options.readPack
    this.#queue =
      options.queue ??
      new JoinQueue({
        file: join(options.appDataPath, PENDING_JOIN_FILE),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
        ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
      })
  }

  async receive(raw: unknown): Promise<JoinReceiveResult> {
    const parsed = parseJoinUrl(raw)
    if (!parsed.ok) {
      this.#logger?.warn('Join link rejected', { code: parsed.code, message: parsed.message })
      return parsed
    }
    try {
      await this.#queue.enqueue(parsed.payload)
    } catch (error) {
      this.#logger?.warn('Join link could not be queued', {
        error: (error as Error).message,
      })
      return {
        ok: false,
        code: 'join.rejected-grammar',
        message: 'Link konnte nicht gespeichert werden',
      }
    }
    if (!this.#uiReady) return { ok: true, payload: parsed.payload, queued: true }
    const published = await this.#publish()
    return { ok: true, payload: parsed.payload, queued: published.delivered === 0 }
  }

  async uiReady(): Promise<JoinPublishResult> {
    if (this.#uiReady) return { delivered: 0, already: true }
    this.#uiReady = true
    return this.#publish()
  }

  async prepare(input: unknown): Promise<JoinPrepareResult> {
    const parsed = validateJoinPayload(input)
    if (!parsed.ok) return parsed
    const payload = parsed.payload
    const pack = await this.#checkPack(payload)
    if (!pack.ok) {
      this.#logger?.warn('Join pack rejected', { code: pack.code, message: pack.message })
      return pack
    }

    const runtime = await this.#runtime()
    let instance: JoinOffer['instance']
    if (payload.profile) {
      try {
        const found = await runtime.instances.get(payload.profile)
        const file = await runtime.instances.readFile(payload.profile)
        instance = {
          id: file.id || payload.profile,
          name: file.name,
          folderName: basename(found.directory),
          version: file.version,
          loader: file.loader,
          loaderVersion: file.loaderVersion,
          javaMode: file.javaMode ?? (file.javaPath ? 'pinned' : 'auto'),
          javaPath: file.javaPath,
          minMemory: file.minMemory,
          maxMemory: file.maxMemory,
          memoryMode: file.memoryMode ?? (file.maxMemory > 0 ? 'explicit' : 'auto'),
        }
        this.#logger?.info('Join profile resolved', {
          profile: payload.profile,
          directory: found.directory,
          reason: 'join.profile-exact',
        })
      } catch {
        this.#logger?.info('Join profile not found; offering creation', {
          profile: payload.profile,
          reason: 'join.profile-create-offer',
        })
      }
    }

    const kind = instance ? 'launch' : payload.pack ? 'create-pack' : 'create-vanilla'
    const offer: JoinOffer = {
      id: `join-offer-${Date.now()}-${++this.#offerCounter}`,
      payload,
      kind,
      reason: instance ? 'join.profile-exact' : 'join.profile-create-offer',
      ...(instance ? { instance } : {}),
      ...(pack.pack ? { pack: pack.pack } : {}),
    }
    this.#offers.set(offer.id, offer)
    while (this.#offers.size > 32) {
      const oldest = this.#offers.keys().next().value
      if (!oldest) break
      this.#offers.delete(oldest)
    }
    return { ok: true, offer }
  }

  async confirm(
    offerId: unknown,
    onEvent?: (event: LaunchEvent) => void,
  ): Promise<JoinConfirmResult> {
    if (typeof offerId !== 'string' || offerId.length === 0) {
      return { ok: false, code: 'join.offer-expired', message: 'Join-Angebot ist nicht mehr verfügbar' }
    }
    const offer = this.#offers.get(offerId)
    this.#offers.delete(offerId)
    if (!offer) {
      return { ok: false, code: 'join.offer-expired', message: 'Join-Angebot ist nicht mehr verfügbar' }
    }
    if (!offer.instance) {
      return {
        ok: false,
        code: 'join.profile-create-offer',
        message: 'Für diesen Link muss zuerst eine Instanz erstellt werden',
      }
    }
    try {
      const runtime = await this.#runtime()
      const handle = await runtime.launch(
        {
          instanceId: offer.instance.id,
          server: { host: offer.payload.host, port: offer.payload.port },
        },
        onEvent,
      )
      this.#logger?.info('Join handed to launch', {
        instanceId: offer.instance.id,
        host: offer.payload.host,
        port: offer.payload.port,
      })
      return {
        ok: true,
        offer,
        ...(handle.launchId ? { launchId: handle.launchId } : {}),
        ...(typeof handle.pid === 'number' ? { pid: handle.pid } : {}),
      }
    } catch (error) {
      this.#logger?.warn('Join launch failed', {
        instanceId: offer.instance.id,
        error: (error as Error).message,
      })
      return { ok: false, code: 'join.launch-failed', message: (error as Error).message }
    }
  }

  buildInviteUrl(input: unknown): string {
    return buildInviteUrl(input)
  }

  buildJoinUrl(input: unknown): string {
    return buildJoinUrl(input)
  }

  async #publish(): Promise<JoinPublishResult> {
    const flushed = await this.#queue.flush()
    if (flushed.rejected) {
      this.#logger?.warn('Pending join queue rejected', { code: flushed.rejected })
    }
    let delivered = 0
    for (const entry of flushed.entries) {
      try {
        this.#deliver(entry.payload)
        delivered += 1
      } catch (error) {
        this.#logger?.warn('Join payload delivery failed', {
          error: (error as Error).message,
        })
      }
    }
    return {
      delivered,
      ...(flushed.rejected ? { rejected: flushed.rejected } : {}),
    }
  }

  async #checkPack(payload: JoinPayload): Promise<PackCheck> {
    if (!payload.pack || !payload.sha1) return { ok: true }
    try {
      const buffer = this.#readPack
        ? await this.#readPack(payload.pack)
        : (
            await downloadBuffer({
              urls: [payload.pack],
              checksum: { algorithm: 'sha1', value: payload.sha1 },
              retry: { attempts: 1 },
              ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
            })
          ).buffer
      const actual = hashBuffer('sha1', buffer)
      if (actual.toLowerCase() !== payload.sha1.toLowerCase()) {
        return {
          ok: false,
          code: 'join.rejected-hash',
          message: 'Pack-Manifest wurde ersetzt (SHA-1 stimmt nicht)',
        }
      }
      return {
        ok: true,
        pack: { url: payload.pack, sha1: payload.sha1, size: buffer.length },
      }
    } catch (error) {
      return {
        ok: false,
        code: 'join.rejected-hash',
        message: `Pack konnte nicht geprüft werden: ${(error as Error).message}`,
      }
    }
  }
}

export type { JoinParseResult }
