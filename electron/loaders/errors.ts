export type LoaderErrorCode =
  | 'invalid'
  | 'metadata'
  | 'version-not-found'
  | 'installer'
  | 'profile'
  | 'processor'
  | 'java'
  | 'aborted'
  | 'rollback'
  | 'diagnose'

export class LoaderError extends Error {
  readonly code: LoaderErrorCode
  readonly loader?: string
  readonly versionId?: string
  readonly details?: string[]

  constructor(
    code: LoaderErrorCode,
    message: string,
    options: {
      loader?: string
      versionId?: string
      details?: string[]
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'LoaderError'
    this.code = code
    this.loader = options.loader
    this.versionId = options.versionId
    this.details = options.details
  }
}

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'AbortError' ||
        (error as { code?: string }).code === 'ABORT_ERR'),
  )
}
