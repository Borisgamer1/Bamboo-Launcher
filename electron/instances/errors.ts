export type InstanceErrorCode =
  | 'not-found'
  | 'exists'
  | 'locked'
  | 'invalid-name'
  | 'invalid-request'
  | 'not-managed'
  | 'outside-root'
  | 'move-failed'

export class InstanceError extends Error {
  readonly code: InstanceErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: InstanceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'InstanceError'
    this.code = code
    if (details) this.details = details
  }
}
