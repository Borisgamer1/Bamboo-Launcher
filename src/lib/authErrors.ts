/**
 * The auth core reports its errors in German, and Electron's IPC rejection
 * carries only the message. Map the known messages for the English UI; unknown
 * text stays as it is so a new error is never hidden.
 */
const PATTERNS: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
  [
    /AADSTS50011/,
    'Microsoft rejected the redirect URI (AADSTS50011). The Azure app registration behind the client ID must list the launcher redirect URI exactly as a public client (no secret).',
  ],
  [/Microsoft\/Xbox ist nicht erreichbar/, 'Microsoft/Xbox is unreachable. Check your connection.'],
  [
    /Microsoft-Anmeldung fehlgeschlagen \(HTTP (\d+)\)/,
    (match) => `Microsoft sign-in failed (HTTP ${match[1]}).`,
  ],
  [
    /Microsoft-Anmeldung fehlgeschlagen \((.+)\)/,
    (match) => `Microsoft sign-in failed (${match[1]}).`,
  ],
  [
    /Microsoft-Sitzung ist abgelaufen/,
    'Your Microsoft session expired. Please sign in again.',
  ],
  [/Anmeldung wurde abgebrochen/, 'Sign-in was cancelled.'],
  [/Xbox Live hat kein gültiges Token/, 'Xbox Live returned no valid token.'],
  [/Xbox Live hat die Anmeldung abgelehnt/, 'Xbox Live rejected the sign-in.'],
  [
    /Minecraft hat die App-Registrierung abgelehnt/,
    'Minecraft rejected the app registration (HTTP 403). New Azure apps must be approved for the Minecraft API: https://aka.ms/mce-reviewappid',
  ],
  [
    /Minecraft hat kein Access-Token geliefert \(HTTP (\d+)\)/,
    (match) => `Minecraft returned no access token (HTTP ${match[1]}).`,
  ],
  [/kein Minecraft-Java-Profil/, 'This account has no Minecraft Java profile.'],
  [/Minecraft-Profil konnte nicht gelesen/, 'The Minecraft profile could not be read.'],
  [/anderen Anmelde-Sitzung/, 'The response belongs to a different sign-in session.'],
  [/keinen Autorisierungscode/, 'Microsoft returned no authorization code.'],
  [
    /Microsoft-Anmeldung abgelehnt \((.+)\)/,
    (match) => `Microsoft sign-in denied (${match[1]}).`,
  ],
  [/lokale Anmelde-Listener/, 'The local sign-in listener could not start.'],
  [/Zeitüberschreitung/, 'Timed out: the sign-in did not finish.'],
  [/Es läuft bereits eine Anmeldung/, 'A sign-in is already running.'],
  [/keinen Browser öffnen/, 'The launcher cannot open a browser.'],
  [/Browser konnte nicht geöffnet/, 'The browser could not be opened.'],
  [/Sitzung wurde zwischenzeitlich abgemeldet/, 'The session was signed out in the meantime.'],
  [/Kein Microsoft-Konto angemeldet/, 'No Microsoft account is signed in.'],
  [/Die Sitzung ist abgelaufen/, 'The session expired. Please sign in again.'],
  [/Dieses Xbox-Konto wurde gesperrt/, 'This Xbox account is locked.'],
  [
    /kein Xbox-Profil/,
    'This Microsoft account has no Xbox profile. Create one at xbox.com first.',
  ],
  [/in der Region dieses Kontos nicht verfügbar/, 'Xbox Live is not available in this account region.'],
  [/Bestätigung durch einen Erwachsenen/, 'This account needs approval from an adult.'],
  [/Kinderkonto/, 'This is a child account and must join an Xbox family.'],
]

export function authErrorText(message: string, lang: string): string {
  if (lang !== 'en') return message
  for (const [pattern, replacement] of PATTERNS) {
    const match = message.match(pattern)
    if (match) return typeof replacement === 'string' ? replacement : replacement(match)
  }
  return message
}
