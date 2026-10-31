/** Machine-specific roots and secrets are redacted before text is attached to a support request. */
import { homedir, tmpdir } from 'node:os'

export function sanitizeSupportText(
  input: string,
  options: { appData: string; gameRoot: string },
): string {
  let text = input
  const replacements = [
    [options.appData, '<appData>'],
    [options.gameRoot, '<gameRoot>'],
    [homedir(), '<home>'],
    [tmpdir(), '<temp>'],
    [process.env.APPDATA ?? '', '<appData>'],
    [process.env.LOCALAPPDATA ?? '', '<localAppData>'],
    [process.env.USERPROFILE ?? '', '<home>'],
  ]
    .filter(([from]) => from.length > 0)
    .sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of replacements) text = text.split(from).join(to)

  text = text.replace(
    /("(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|x-api-key|client[_-]?secret|secret[_-]?key|private[_-]?key|secret|password|passphrase|authorization|cookie|session[_-]?token)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  )
  text = text.replace(/("(?:account|accountName|player|playerName|username)"\s*:\s*)"[^"]*"/gi, '$1"<account>"')
  // CurseForge keys are bcrypt strings; redact the shape itself so a key is removed even when a log line does not name it.
  text = text.replace(/\$2[aby]\$\d{2}\$[A-Za-z0-9./]{20,}/g, '[redacted]')
  text = text.replace(/((?:x-api-key|api[_-]?key|apikey)\s*:\s*)[^\s"',}]+/gi, '$1[redacted]')
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  text = text.replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [redacted]')
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
  text = text.replace(
    /([?&](?:access_token|refresh_token|token|api_key|apikey|key|sig|signature|code|client_secret)=)[^&\s"']+/gi,
    '$1[redacted]',
  )
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD))=([^\s"']+)/gi,
    '$1=[redacted]',
  )
  text = text.replace(/"([A-Za-z]:[\\/][^"]*)"/g, '"<path>"')
  text = text.replace(/'([A-Za-z]:[\\/][^']*)'/g, "'<path>'")
  text = text.replace(/"(\/(?:home|Users|root)\/[^"]*)"/g, '"<path>"')
  text = text.replace(/'(\/(?:home|Users|root)\/[^']*)'/g, "'<path>'")
  text = text.replace(/(?<![A-Za-z0-9:/])[A-Za-z]:[\\/][^"'\r\n]*/g, '<path>')
  text = text.replace(/(?<!\\)\\\\[^"'\r\n]+/g, '<path>')
  text = text.replace(/(?<![A-Za-z0-9:/])\/(?:home|Users|root)\/[^"'\r\n]*/g, '<path>')
  return text
}
