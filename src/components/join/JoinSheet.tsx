import React, { useState } from 'react'
import { AlertTriangle, Boxes, LogIn, Package, Play, Server, ShieldCheck } from 'lucide-react'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import type { LanguageType } from '../../lib/translations'
import type { JoinInstanceSummary, JoinOffer } from '../../electron'

const text = (lang: LanguageType, de: string, en: string) => (lang === 'de' ? de : en)

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface JoinSheetProps {
  open: boolean
  offer: JoinOffer | null
  lang: LanguageType
  offline?: boolean
  onClose: () => void
  onLaunched: (instance: JoinInstanceSummary) => void
  onOpenInstances: () => void
}

export function JoinSheet({
  open,
  offer,
  lang,
  offline,
  onClose,
  onLaunched,
  onOpenInstances,
}: JoinSheetProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const instance = offer?.instance
  const host = offer?.payload.host ?? ''
  const port = offer?.payload.port ?? 25565
  const canLaunch = !!instance && (offer?.kind === 'launch')

  const confirm = async () => {
    if (!offer || !canLaunch) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI?.join.confirm?.(offer.id)
      if (!result) {
        setError(text(lang, 'Der Join-Dienst ist nicht verfügbar.', 'The join service is unavailable.'))
        return
      }
      if ('code' in result) {
        setError(result.message || text(lang, 'Der Join ist fehlgeschlagen.', 'The join failed.'))
        return
      }
      if (!result.offer.instance) {
        setError(text(lang, 'Der Join ist fehlgeschlagen.', 'The join failed.'))
        return
      }
      onLaunched(result.offer.instance)
      onClose()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const javaSummary = instance
    ? instance.javaMode === 'pinned' && instance.javaPath
      ? instance.javaPath
      : text(lang, 'Automatisch', 'Automatic')
    : '—'
  const memorySummary = instance
    ? instance.maxMemory > 0
      ? `${(instance.maxMemory / 1024).toFixed(1).replace('.0', '')} GB`
      : text(lang, 'Automatisch', 'Automatic')
    : '—'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={text(lang, 'Server beitreten', 'Join server')}
      titleId="join-sheet-title"
      closeLabel={text(lang, 'Schließen', 'Close')}
      icon={<ShieldCheck className="h-4 w-4" />}
      tone="accent"
      footer={
        <>
          <button type="button" onClick={onClose} className={dialogButton.secondary}>
            {text(lang, 'Abbrechen', 'Cancel')}
          </button>
          {canLaunch ? (
            <button
              type="button"
              data-autofocus
              onClick={confirm}
              disabled={busy}
              className={dialogButton.accent}
            >
              <Play className="mr-1 inline h-3 w-3 fill-current" />
              {busy ? text(lang, 'Startet …', 'Starting …') : text(lang, 'Beitreten', 'Join')}
            </button>
          ) : (
            <button
              type="button"
              data-autofocus
              onClick={() => {
                onOpenInstances()
                onClose()
              }}
              className={dialogButton.accent}
            >
              <Boxes className="mr-1 inline h-3 w-3" />
              {text(lang, 'Zu den Instanzen', 'Open instances')}
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-stroke bg-root/35 p-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-accent" />
            <span className="font-mono text-small font-medium text-ink">
              {host}:{port}
            </span>
            {offer?.payload.name && (
              <span className="truncate text-mini text-ink-tertiary">· {offer.payload.name}</span>
            )}
          </div>
          <p className="m-0 mt-1.5 text-mini text-ink-secondary">
            {text(
              lang,
              'Ein Klick startet die bestehende Instanz mit dieser Server-Adresse. Der Launcher prüft keinen Serverstatus.',
              'One click launches the existing instance with this server address. The launcher does not check server status.',
            )}
          </p>
        </div>

        {instance ? (
          <div className="rounded-xl border border-stroke bg-root/35 p-3">
            <p className="m-0 text-small font-medium text-ink">{instance.name}</p>
            <p className="m-0 mt-0.5 text-mini text-ink-secondary">
              {instance.version}
              {instance.loader && instance.loader !== 'vanilla' ? ` · ${instance.loader} ${instance.loaderVersion}` : ''}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-mini">
              <div>
                <span className="block text-micro uppercase tracking-label text-ink-tertiary">Java</span>
                <span className="block truncate font-mono text-ink" title={javaSummary}>{javaSummary}</span>
              </div>
              <div>
                <span className="block text-micro uppercase tracking-label text-ink-tertiary">RAM</span>
                <span className="block text-ink">{memorySummary}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-warning/25 bg-warning/8 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div>
                <p className="m-0 text-small font-medium text-ink">
                  {text(lang, 'Keine passende Instanz', 'No matching instance')}
                </p>
                <p className="m-0 mt-1 text-mini leading-5 text-ink-secondary">
                  {offer?.kind === 'create-pack'
                    ? text(
                        lang,
                        'Der Link verweist auf ein Modpack. Erstelle zuerst eine Instanz aus dem Pack; der Link installiert nichts automatisch.',
                        'The link points to a modpack. Create an instance from the pack first; the link installs nothing automatically.',
                      )
                    : text(
                        lang,
                        'Der Link nennt keine fertige Instanz. Erstelle zuerst eine Vanilla-Instanz mit der passenden Minecraft-Version.',
                        'The link names no existing instance. Create a vanilla instance with the matching Minecraft version first.',
                      )}
                </p>
              </div>
            </div>
          </div>
        )}

        {offer?.pack && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-stroke bg-root/35 px-3 py-2.5 text-mini">
            <span className="flex min-w-0 items-center gap-2 text-ink-secondary">
              <Package className="h-4 w-4 shrink-0 text-info" />
              <span className="truncate font-mono">{offer.pack.url}</span>
            </span>
            <span className="shrink-0 text-ink-tertiary">{formatSize(offer.pack.size)}</span>
          </div>
        )}

        {offline && (
          <div className="flex items-start gap-2 rounded-xl border border-info/25 bg-info/8 px-3 py-2.5 text-mini text-ink-secondary">
            <LogIn className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
            <span>
              {text(lang, 'Offline-Modus: Der Beitritt ist erlaubt.', 'Offline mode: joining is allowed.')}
            </span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/25 bg-danger/8 px-3 py-2.5 text-mini text-ink-secondary">
            <p className="m-0 font-medium text-ink">{text(lang, 'Beitritt nicht möglich', 'Could not join')}</p>
            <p className="m-0 mt-1">{error}</p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
