import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldAlert, Wrench } from 'lucide-react'
import type { DoctorFinding, DoctorReport } from '../../electron'
import type { LanguageType } from '../../lib/translations'

/**
 * Der Instanz-Doktor direkt in den Einstellungen.
 *
 * Die Fälle, die er findet, sind alle gleich gebaut: etwas liegt im Ordner und
 * wird im Spiel nicht geladen. Deshalb steht zu jedem Fund der nächste Schritt
 * daneben – und wo der Launcher selbst helfen kann, ein Knopf.
 */
export function InstanceDoctorPanel({ folderName, lang }: { folderName: string; lang: LanguageType }) {
  const de = lang === 'de'
  const api = window.electronAPI?.instances
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!api?.doctor || !folderName) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.doctor(folderName)
      if (next && next.error) setError(next.error)
      else setReport(next ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [api, folderName])

  useEffect(() => {
    void run()
  }, [run])

  const fix = async (action: string) => {
    if (!api?.doctorFix) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.doctorFix({ folderName, action })
      if (next && next.error) setError(next.error)
      else setReport(next ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const findings: DoctorFinding[] = report?.findings ?? []
  const version = [report?.minecraftVersion, report?.fabric ? 'Fabric' : null].filter(Boolean).join(' · ')

  return (
    <section className="rounded-[var(--r-lg)] border border-hairline bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="m-0 text-small font-medium text-ink">{de ? 'Zustand der Instanz' : 'Instance health'}</h3>
          <p className="m-0 mt-0.5 text-micro text-ink-tertiary">
            {version || (de ? 'Wird geprüft' : 'Checking')}
            {findings.length > 0
              ? de
                ? ` · ${findings.length} ${
                    findings.length === 1 ? 'Hinweis' : 'Hinweise'
                  }`
                : ` · ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`
              : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          aria-label={de ? 'Neu prüfen' : 'Check again'}
          title={de ? 'Neu prüfen' : 'Check again'}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary transition-colors duration-[var(--t-quick)] hover:bg-hover hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </header>

      {error ? (
        <p role="alert" className="m-0 border-b border-hairline px-3.5 py-2 text-micro text-danger">
          {error}
        </p>
      ) : null}

      {!report && busy ? (
        <p className="m-0 px-3.5 py-4 text-micro text-ink-tertiary">{de ? 'Prüfe Instanz …' : 'Checking instance …'}</p>
      ) : findings.length === 0 ? (
        <p className="m-0 flex items-center gap-2 px-3.5 py-3 text-micro text-ink-secondary">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          {de
            ? 'Nichts auffällig: Version, Mods und Pakete sehen richtig aus.'
            : 'Nothing suspicious: version, mods and packs look right.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-hairline p-0">
          {findings.map((finding) => (
            <li key={finding.code + finding.title} className="flex items-start gap-2.5 px-3.5 py-2.5">
              {finding.severity === 'error' ? (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              ) : finding.severity === 'warning' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="m-0 text-small font-medium text-ink">{finding.title}</p>
                <p className="m-0 mt-0.5 text-micro leading-5 text-ink-tertiary">{finding.detail}</p>
                {finding.action === 'resource-packs' ? (
                  <button
                    type="button"
                    onClick={() => void fix('resource-packs')}
                    disabled={busy}
                    className="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-accent/30 bg-accent/[0.08] px-2 text-micro font-medium text-accent transition-colors duration-[var(--t-quick)] hover:bg-accent/[0.14] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Wrench className="h-3.5 w-3.5" aria-hidden />
                    {de ? 'Jetzt auswählen' : 'Select now'}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
