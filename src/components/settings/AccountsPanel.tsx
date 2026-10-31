import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, LogIn, LogOut, RefreshCw, UserRound } from 'lucide-react'
import type { AccountSession } from '../../lib/accountSession'
import {
  Badge,
  Button,
  ConfirmButton,
  SettingsCard,
  type Lang,
} from './SettingsPrimitives'
import { cx, t } from './settingsUtils'

type Busy = 'login' | 'refresh' | 'signout' | null

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

export function AccountsPanel({
  lang,
  session,
}: {
  lang: Lang
  session: AccountSession
}) {
  const status = session.status
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const successTimer = useRef<number | undefined>(undefined)

  const announceSuccess = (message: string) => {
    setSuccess(message)
    window.clearTimeout(successTimer.current)
    successTimer.current = window.setTimeout(() => setSuccess(''), 8000)
  }

  useEffect(() => () => window.clearTimeout(successTimer.current), [])

  const { reload } = session
  useEffect(() => {
    void reload()
  }, [reload])

  const signIn = async () => {
    setError('')
    setSuccess('')
    setBusy('login')
    try {
      const next = await window.electronAPI?.auth.login?.()
      if (next) session.apply(next)
      if (next?.signedIn) {
        announceSuccess(
          t(
            lang,
            'Erfolgreich mit Microsoft angemeldet.',
            'Successfully signed in with Microsoft.',
          ),
        )
      }
    } catch (err) {
      const message = readableError(err)
      if (!/abgebrochen|aborted|cancel/i.test(message)) setError(message)
    } finally {
      setBusy(null)
    }
  }

  const cancelLogin = async () => {
    try {
      await window.electronAPI?.auth.cancel?.()
    } catch {
      // Cancelling is best-effort; the pending login promise reports its own outcome.
    }
  }

  const refreshSession = async () => {
    setError('')
    setBusy('refresh')
    try {
      const next = await window.electronAPI?.auth.refresh?.(status?.account?.id)
      if (next) session.apply(next)
      if (next?.signedIn) {
        announceSuccess(t(lang, 'Sitzung aktualisiert.', 'Session refreshed.'))
      } else if (next) {
        setError(
          t(
            lang,
            'Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich erneut an.',
            'Your Microsoft session expired. Please sign in again.',
          ),
        )
      }
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(null)
    }
  }

  const signOut = async () => {
    setError('')
    setSuccess('')
    setBusy('signout')
    try {
      const next = await window.electronAPI?.auth.signOut?.(status?.account?.id)
      if (next) session.apply(next)
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(null)
    }
  }

  const account = status?.account ?? null
  const signedIn = Boolean(status?.signedIn && account)
  const loginPending = busy === 'login'

  if (session.unavailable) {
    return (
      <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-warning/30 bg-warning/10 px-3 py-2.5 text-mini leading-5 text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="m-0 font-medium">{t(lang, 'Microsoft-Anmeldung nicht verfügbar', 'Microsoft sign-in unavailable')}</p>
          <p className="m-0 mt-1 text-ink-secondary">
            {t(
              lang,
              'Der Launcher-Core wurde nicht geladen. Starte den Launcher neu, um dich anzumelden.',
              'The launcher core failed to load. Restart the launcher to sign in.',
            )}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-danger/30 bg-danger/10 px-3 py-2.5 text-mini leading-5 text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-success/30 bg-success/10 px-3 py-2.5 text-mini leading-5 text-success">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {signedIn && account ? (
        <section className="overflow-hidden rounded-[var(--r-xl)] border border-stroke bg-surface/65">
          <div className="flex items-center gap-4 px-4 py-4">
            <img
              src={account.avatar}
              alt={account.name}
              width={56}
              height={56}
              className="h-14 w-14 shrink-0 rounded-xl border border-stroke bg-root object-cover [image-rendering:pixelated]"
              onError={(event) => {
                ;(event.target as HTMLImageElement).style.visibility = 'hidden'
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 truncate text-title3 font-semibold text-ink">{account.name}</h3>
                <Badge tone="success">{t(lang, 'Angemeldet', 'Signed in')}</Badge>
                <Badge tone="accent">Microsoft</Badge>
              </div>
              <p className="m-0 mt-1 flex flex-wrap items-center gap-1.5 text-mini text-ink-secondary">
                <span className="text-ink-tertiary">UUID</span>
                <span className="font-mono text-micro text-ink">{account.uuid}</span>
              </p>
            </div>
          </div>

          {status?.tokenStoreDegraded && (
            <div className="flex items-start gap-2 border-t border-hairline px-4 py-2.5 text-mini leading-5 text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t(
                  lang,
                  'Der Betriebssystem-Tresor ist nicht verfügbar – die Sitzung gilt nur bis zum Beenden des Launchers.',
                  'The OS secret store is unavailable – the session lasts only until the launcher closes.',
                )}
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-4 py-3">
            {account && (
              <Button
                variant="secondary"
                icon={<RefreshCw className={cx('h-3.5 w-3.5', busy === 'refresh' && 'animate-spin')} />}
                onClick={() => void refreshSession()}
                disabled={busy !== null}
              >
                {busy === 'refresh'
                  ? t(lang, 'Wird erneuert …', 'Refreshing …')
                  : t(lang, 'Sitzung aktualisieren', 'Refresh session')}
              </Button>
            )}
            <ConfirmButton
              onConfirm={() => void signOut()}
              confirmLabel={t(lang, 'Wirklich abmelden?', 'Really sign out?')}
              icon={<LogOut className="h-3 w-3" />}
            >
              {busy === 'signout'
                ? t(lang, 'Wird abgemeldet …', 'Signing out …')
                : t(lang, 'Abmelden', 'Sign out')}
            </ConfirmButton>
          </div>
        </section>
      ) : (
        <SettingsCard
          title={t(lang, 'Microsoft-Konto', 'Microsoft account')}
          description={t(
            lang,
            'Für Online-Spiel, Realms und dein Minecraft-Profil.',
            'For online play, Realms and your Minecraft profile.',
          )}
        >
          <div className="flex flex-col items-center gap-3 px-4 py-9 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
              <UserRound className="h-6 w-6" />
            </div>
            <div>
              <p className="m-0 text-small font-medium text-ink">
                {t(lang, 'Noch kein Konto angemeldet', 'No account signed in yet')}
              </p>
              <p className="m-0 mt-1 max-w-[52ch] text-mini leading-5 text-ink-secondary">
                {t(
                  lang,
                  'Bamboo öffnet deinen Browser für die Anmeldung bei Microsoft.',
                  'Bamboo opens your browser for Microsoft sign-in.',
                )}
              </p>
            </div>

            {loginPending ? (
              <div className="flex flex-col items-center gap-2">
                <span className="inline-flex items-center gap-2 text-mini font-medium text-accent">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
                  {t(lang, 'Warte auf Bestätigung im Browser …', 'Waiting for confirmation in the browser …')}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void cancelLogin()}>
                  {t(lang, 'Abbrechen', 'Cancel')}
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                icon={<LogIn className="h-3.5 w-3.5" />}
                onClick={() => void signIn()}
                disabled={busy !== null}
              >
                {t(lang, 'Mit Microsoft anmelden', 'Sign in with Microsoft')}
              </Button>
            )}
          </div>
        </SettingsCard>
      )}
    </div>
  )
}
