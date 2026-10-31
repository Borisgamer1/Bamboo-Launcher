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
