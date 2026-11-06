export type ModErrorCode =
  | 'not-a-modpack'
  | 'invalid-manifest'
  | 'unsafe-path'
  | 'missing-api-key'
  | 'provider-error'
  | 'distribution-blocked'
  | 'pagination-limit'
  | 'no-matching-version'
  | 'invalid-mmc'
  | 'no-lock'
  | 'format-mismatch'
  | 'loader-mismatch'
  | 'aborted'
  | 'resolution-limit'
  | 'resolver-disabled'
  | 'version-project-mismatch'
  | 'stale-update'
  | 'content-changed'
  | 'store-missing'
  | 'store-locked'
  | 'ledger-locked'

/** A provider list is either a list or a malformed answer, never a raw TypeError. */
export function providerList<T>(value: unknown, provider: string, what: string): T[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ModError('provider-error', `${provider} returned ${what} that is not a list`)
  }
  return value as T[]
}

export class ModError extends Error {
  readonly code: ModErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ModErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ModError'
    this.code = code
    if (details) this.details = details
  }
}
