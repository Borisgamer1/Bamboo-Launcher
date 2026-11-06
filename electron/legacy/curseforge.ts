import { readFileSync } from 'node:fs'
import type { FetchLike } from '../download/http'
import { CURSEFORGE_CLASS_IDS } from '../shared/curseforgeClassIds'
import {
  CURSEFORGE_MINECRAFT_GAME_ID,
  CURSEFORGE_SEARCH_LIMIT,
} from '../mods/curseforge'
import { CurseForgeHttp, type CurseForgeRequestOptions } from '../mods/curseforge-http'

export type CurseForgeFailure = {
  error: string
  code: 'missing-key' | 'invalid-key' | 'rate-limited' | 'http' | 'network'
  status?: number
  detail?: string
}

export const CURSEFORGE_KEY_MISSING: CurseForgeFailure = {
  error: 'Kein CurseForge API-Key gesetzt',
  code: 'missing-key',
}

const CURSEFORGE_MAX_PAGE_SIZE = 50

export interface LegacyCurseForgeOptions {
  keyPath: string
  logger?: { debug(message: string, data?: unknown): void; warn(message: string, data?: unknown): void }
  fetchImpl?: FetchLike
}

export interface LegacyCurseForge {
  readApiKey(): string
  headers(): Record<string, string> | null
  request(url: string, options?: CurseForgeRequestOptions, attempts?: number): Promise<Response>
  register(ipc: CurseForgeIpc): void
}

export interface CurseForgeIpc {
  handle(channel: string, listener: (event: unknown, ...args: never[]) => unknown): void
}

function clampCurseForgeSearchPage(pageSize: unknown, index: unknown): { pageSize: number; index: number } {
  const requestedPageSize = Number(pageSize)
  const safePageSize = Math.min(
    CURSEFORGE_MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedPageSize) ? Math.trunc(requestedPageSize) : 20),
  )
  const requestedIndex = Number(index)
  const safeIndex = Math.min(
    CURSEFORGE_SEARCH_LIMIT - safePageSize,
    Math.max(0, Number.isFinite(requestedIndex) ? Math.trunc(requestedIndex) : 0),
  )
  return { pageSize: safePageSize, index: safeIndex }
}

export async function curseForgeFailure(res: Response): Promise<CurseForgeFailure> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300).trim()
  } catch {
    // The response body is optional.
  }
  const code = res.status === 401 || res.status === 403
    ? 'invalid-key'
    : res.status === 429
      ? 'rate-limited'
      : 'http'
  return {
    error: `CurseForge API-Fehler: ${res.status}${detail ? ` — ${detail}` : ''}`,
    code,
    status: res.status,
    detail,
  }
}

export interface SearchHandlerDependencies {
  curseForgeHeaders: () => Record<string, string> | null
  curseForgeFetch: (url: string, options?: CurseForgeRequestOptions) => Promise<Response>
  curseForgeFailure: (response: Response) => Promise<CurseForgeFailure>
  shellLog: { warn(message: string, data?: unknown): void; debug(message: string, data?: unknown): void }
}

/**
 * The renderer calls numeric class ids, so both spellings have to resolve to
 * the same class id. Exported for the regression test.
 */
export function createCurseForgeSearchHandler(dependencies: SearchHandlerDependencies) {
  return async (
    _event: unknown,
    payload: {
      query?: string
      sortBy?: string
      modFilter?: string
      gameVersion?: string
      modLoaderType?: number
      index?: number
      pageSize?: number
    } = {},
  ) => {
    const { query, sortBy = '6', modFilter, gameVersion, modLoaderType, index = 0, pageSize = 20 } = payload
    const headers = dependencies.curseForgeHeaders()
    if (!headers) return { ...CURSEFORGE_KEY_MISSING }
    const numericClassId = typeof modFilter === 'string' && /^\d+$/.test(modFilter)
      ? Number(modFilter)
      : undefined
    const knownClassId = modFilter
      ? (CURSEFORGE_CLASS_IDS as Record<string, number>)[modFilter]
      : undefined
    const classId = knownClassId || numericClassId || (modFilter ? 6 : undefined)
    const page = clampCurseForgeSearchPage(pageSize, index)
    const params = new URLSearchParams({
      gameId: String(CURSEFORGE_MINECRAFT_GAME_ID),
      pageSize: String(page.pageSize),
    })
    if (classId) params.set('classId', String(classId))
    if (query) params.set('searchFilter', query)
    if (sortBy) params.set('sortField', sortBy)
    params.set('sortOrder', 'desc')
    if (page.index > 0) params.set('index', String(page.index))
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (modLoaderType !== undefined && modLoaderType !== null) {
      params.set('modLoaderType', String(modLoaderType))
    }
    try {
      const res = await dependencies.curseForgeFetch(
        `https://api.curseforge.com/v1/mods/search?${params.toString()}`,
        { headers },
      )
      if (!res.ok) {
        const failure = await dependencies.curseForgeFailure(res)
        dependencies.shellLog.warn('curseforge: search failed', {
          status: res.status,
          code: failure.code,
        })
        return failure
      }
      const data = (await res.json()) as { data?: unknown[]; pagination?: { totalCount?: number } }
      return { data: data.data || [], pagination: data.pagination || { totalCount: 0 } }
    } catch (error) {
      const message = (error as Error).message
      return { error: `CurseForge nicht erreichbar: ${message}`, code: 'network', detail: message }
    }
  }
}

export function createLegacyCurseForge(options: LegacyCurseForgeOptions): LegacyCurseForge {
  const log = options.logger
  const readApiKey = (): string => {
    try {
      return readFileSync(options.keyPath, 'utf8').trim()
    } catch {
      // No bundled key is a supported state; the UI reports missing-key explicitly.
      return ''
    }
  }
  const headers = (): Record<string, string> | null => {
    const apiKey = readApiKey()
    return apiKey ? { Accept: 'application/json', 'x-api-key': apiKey } : null
  }
  const request = async (
    url: string,
    requestOptions: CurseForgeRequestOptions = {},
    attempts = 4,
  ): Promise<Response> => {
    const apiKey = readApiKey()
    if (!apiKey) throw new Error(CURSEFORGE_KEY_MISSING.error)
    return new CurseForgeHttp({
      apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }).request(url, requestOptions, attempts)
  }

  return {
    readApiKey,
    headers,
    request,
    register(ipc) {
      ipc.handle('curseforge-search', createCurseForgeSearchHandler({
        curseForgeHeaders: headers,
        curseForgeFetch: request,
        curseForgeFailure,
        shellLog: {
          warn: (message, data) => log?.warn(message, data),
          debug: (message, data) => log?.debug?.(message, data),
        },
      }))

      ipc.handle('curseforge-project', async (_event, rawModId) => {
        const modId = String(rawModId)
        const currentHeaders = headers()
        if (!currentHeaders) return { ...CURSEFORGE_KEY_MISSING }
        try {
          const [modRes, descRes] = await Promise.all([
            request(`https://api.curseforge.com/v1/mods/${modId}`, { headers: currentHeaders }),
            request(`https://api.curseforge.com/v1/mods/${modId}/description`, { headers: currentHeaders }),
          ])
          if (!modRes.ok) {
            const failure = await curseForgeFailure(modRes)
            log?.warn('curseforge: project lookup failed', {
              modId,
              status: modRes.status,
              code: failure.code,
            })
            return failure
          }
          const modData = ((await modRes.json()) as { data?: Record<string, unknown> }).data ?? {}
          let fullDescription = ''
          if (descRes.ok) {
            try {
              const descData = (await descRes.json()) as {
                data?: { body?: string }
                body?: string
              }
              fullDescription = descData?.data?.body || descData?.body || ''
              log?.debug('curseforge: description loaded', {
                modId,
                length: fullDescription.length,
              })
            } catch (error) {
              log?.warn('curseforge: description parse failed', {
                modId,
                error: (error as Error).message,
              })
            }
          } else {
            log?.warn('curseforge: description unavailable', { modId, status: descRes.status })
          }
          if (!fullDescription && modData.summary) {
            fullDescription = '<p>' + String(modData.summary).replace(/\n/g, '<br>') + '</p>'
          }
          return {
            ...modData,
            fullDescription,
            description: fullDescription || modData.summary || '',
          }
        } catch (error) {
          const message = (error as Error).message
          return { error: `CurseForge nicht erreichbar: ${message}`, code: 'network', detail: message }
        }
      })

      ipc.handle('curseforge-files', async (_event, rawModId, gameVersion, modLoaderType) => {
        const modId = String(rawModId)
        const currentHeaders = headers()
        if (!currentHeaders) return { ...CURSEFORGE_KEY_MISSING }
        try {
          let url = `https://api.curseforge.com/v1/mods/${modId}/files?pageSize=100&sortField=2&sortOrder=desc`
          if (gameVersion) url += `&gameVersion=${encodeURIComponent(String(gameVersion))}`
          if (modLoaderType !== undefined && modLoaderType !== null) {
            url += `&modLoaderType=${String(modLoaderType)}`
          }
          const res = await request(url, { headers: currentHeaders })
          if (!res.ok) {
            const failure = await curseForgeFailure(res)
            log?.warn('curseforge: file list failed', {
              modId,
              status: res.status,
              code: failure.code,
            })
            return failure
          }
          const data = (await res.json()) as { data?: unknown[] }
          return data.data || []
        } catch (error) {
          const message = (error as Error).message
          return { error: `CurseForge nicht erreichbar: ${message}`, code: 'network', detail: message }
        }
      })
    },
  }
}
