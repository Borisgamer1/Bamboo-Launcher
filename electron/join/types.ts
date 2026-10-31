import type { LaunchEvent } from '../launch/types'
import type { LaunchInstanceRequest } from '../schemas'

export type JoinRejectionCode = 'join.rejected-grammar' | 'join.rejected-size' | 'join.rejected-hash'

export interface JoinPayload {
  v: 1
  host: string
  port: number
  profile?: string
  pack?: string
  sha1?: string
  name?: string
}

export type JoinParseResult =
  | { ok: true; payload: JoinPayload; kind: 'join' | 'invite' }
  | { ok: false; code: JoinRejectionCode; message: string }

export interface JoinQueueEntry {
  payload: JoinPayload
  receivedAt: number
}

export interface JoinQueueFile {
  version: 1
  entries: JoinQueueEntry[]
}

export interface JoinQueueRead {
  entries: JoinQueueEntry[]
  superseded: boolean
}

export interface JoinInstanceSummary {
  id: string
  name: string
  folderName: string
  version: string
  loader: string
  loaderVersion: string
  javaMode: 'auto' | 'pinned'
  javaPath: string
  minMemory: number
  maxMemory: number
  memoryMode: 'auto' | 'explicit'
}

export interface JoinPackSummary {
  url: string
  sha1: string
  size: number
}

export interface JoinOffer {
  id: string
  payload: JoinPayload
  kind: 'launch' | 'create-pack' | 'create-vanilla'
  reason: 'join.profile-exact' | 'join.profile-create-offer'
  instance?: JoinInstanceSummary
  pack?: JoinPackSummary
}

export interface JoinRuntime {
  instances: {
    get(id: string): Promise<{ instance: unknown; directory: string }>
    readFile(id: string): Promise<{
      id: string
      name: string
      version: string
      loader: string
      loaderVersion: string
      javaMode?: 'auto' | 'pinned'
      javaPath: string
      minMemory: number
      maxMemory: number
      memoryMode?: 'auto' | 'explicit'
    }>
  }
  launch(
    request: LaunchInstanceRequest,
    onEvent?: (event: LaunchEvent) => void,
  ): Promise<{ launchId?: string; pid?: number }>
}

export interface JoinPublishResult {
  delivered: number
  rejected?: JoinRejectionCode
  already?: boolean
}

export type JoinReceiveResult =
  | { ok: true; payload: JoinPayload; queued: boolean }
  | { ok: false; code: JoinRejectionCode; message: string }

export type JoinPrepareResult =
  | { ok: true; offer: JoinOffer }
  | { ok: false; code: JoinRejectionCode | 'join.offer-expired' | 'join.launch-failed'; message: string }

export type JoinConfirmResult =
  | {
      ok: true
      offer: JoinOffer
      launchId?: string
      pid?: number
    }
  | {
      ok: false
      code:
        | 'join.offer-expired'
        | 'join.profile-create-offer'
        | 'join.launch-failed'
        | 'join.rejected-grammar'
      message: string
    }
