export type GameSettingsErrorCode =
  | 'invalid-key'
  | 'invalid-value'
  | 'unsafe-path'
  | 'hardlink-conflict'
  | 'hardlink-unsupported'
  | 'server-allowlist'
  | 'options-missing'

export class GameSettingsError extends Error {
  readonly code: GameSettingsErrorCode

  constructor(code: GameSettingsErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'GameSettingsError'
    this.code = code
  }
}
