import { translations } from './translations'

export type CurseForgeFailureCode =
  | 'missing-key'
  | 'invalid-key'
  | 'rate-limited'
  | 'http'
  | 'network'
  | 'unavailable'

export interface CurseForgeFailure {
  code: CurseForgeFailureCode
  status?: number
  detail?: string
}

type Dictionary = typeof translations.en

export function toCurseForgeFailure(reply: unknown): CurseForgeFailure | null {
  if (!reply || typeof reply !== 'object' || !('error' in reply)) return null
  const payload = reply as { code?: string; status?: number; detail?: string; error?: string }
  return {
    code: (payload.code as CurseForgeFailureCode) || 'http',
    status: typeof payload.status === 'number' ? payload.status : undefined,
    detail: payload.detail || payload.error,
  }
}

export function canRetryCurseForge(failure: CurseForgeFailure): boolean {
  return failure.code !== 'invalid-key' && failure.code !== 'missing-key'
}

export function describeCurseForgeFailure(
  failure: CurseForgeFailure,
  t: Dictionary,
): { title: string; body: string } {
  const withStatus = (title: string) => (failure.status ? `${title} (${failure.status})` : title)
  switch (failure.code) {
    case 'missing-key':
      return { title: t.cfMissingTitle, body: t.cfMissingBody }
    case 'invalid-key':
      return { title: withStatus(t.cfInvalidTitle), body: t.cfInvalidBody }
    case 'rate-limited':
      return { title: withStatus(t.cfRateLimitTitle), body: t.cfRateLimitBody }
    case 'network':
      return { title: t.cfNetworkTitle, body: t.cfNetworkBody }
    case 'unavailable':
      return { title: t.cfDesktopOnlyTitle, body: t.cfDesktopOnlyBody }
    default:
      return { title: withStatus(t.cfHttpTitle), body: t.cfHttpBody }
  }
}
