export type LaunchErrorCode =
  | 'model'
  | 'java'
  | 'java-invalid'
  | 'precheck'
  | 'natives'
  | 'assets'
  | 'lock-timeout'
  | 'spawn'
  | 'killed'

export class LaunchError extends Error {
  readonly code: LaunchErrorCode
  readonly details: string[]
  readonly reason?: string

  constructor(code: LaunchErrorCode, message: string, details: string[] = [], reason?: string) {
    super(message)
    this.name = 'LaunchError'
    this.code = code
    this.details = details
    if (reason !== undefined) this.reason = reason
  }
}
