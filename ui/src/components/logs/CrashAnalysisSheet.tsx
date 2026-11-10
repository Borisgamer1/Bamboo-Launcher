import React, { useEffect, useState } from 'react'
import { translations } from '../../lib/translations';
import {
  AlertTriangle,
  ClipboardCopy,
  FileWarning,
  Package,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  ShieldAlert,
} from 'lucide-react'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { useToast } from '../Toast'
import type { LanguageType } from '../../lib/translations'
import type {
  LogAnalysisFinding,
  LogAnalysisResult,
  LogFixAction,
  LogFixResult,
} from '../../electron'

const text = (lang: LanguageType, de: string, en: string) => (lang === 'de' ? de : en)

const isWrite = (action: LogFixAction) =>
  action.kind === 'switch-java' ||
  action.kind === 'raise-heap' ||
  action.kind === 'disable-mod' ||
  action.kind === 'install-dependency'

function actionLabel(action: LogFixAction, lang: LanguageType): string {
  switch (action.kind) {
    case 'switch-java':
      return text(lang, `Java ${action.major} verwenden`, `Use Java ${action.major}`)
    case 'raise-heap':
      return text(lang, `RAM auf ${action.toMb} MB erhöhen`, `Raise heap to ${action.toMb} MB`)
    case 'disable-mod':
      return text(lang, `Mod deaktivieren: ${action.jar}`, `Disable mod: ${action.jar}`)
    case 'install-dependency':
      return text(lang, `Abhängigkeit installieren: ${action.modId}`, `Install dependency: ${action.modId}`)
    case 'open-path':
      return translations[lang].common.openFolder
    case 'open-url':
      return text(lang, 'Herstellerseite öffnen', 'Open vendor page')
  }
}

const confidenceLabel = (finding: LogAnalysisFinding, lang: LanguageType) => {
  if (finding.confidence === 'certain') return text(lang, 'Sicher', 'Certain')
  if (finding.confidence === 'likely') return text(lang, 'Wahrscheinlich', 'Likely')
  return text(lang, 'Möglich', 'Possible')
}

export interface CrashAnalysisSheetProps {
  open: boolean
  analysis: LogAnalysisResult | null
  instanceName: string
  folderName?: string
  lang: LanguageType
  onClose: () => void
  onReanalyze?: () => Promise<LogAnalysisResult | null>
}

export function CrashAnalysisSheet({
  open,
  analysis,
  instanceName,
  folderName,
  lang,
  onClose,
  onReanalyze,
}: CrashAnalysisSheetProps) {
  const { addToast } = useToast()
  const [busy, setBusy] = useState<
    'apply' | 'undo' | 'reanalyze' | 'log' | 'bundle' | 'report' | null
  >(null)
  const [result, setResult] = useState<LogFixResult | null>(null)
  const [undoToken, setUndoToken] = useState<string | null>(null)
  const [stale, setStale] = useState(!analysis)

  // Eine beim Öffnen angestoßene Analyse trifft später ein; dann ist der
  // Stand nicht mehr veraltet und die Neu-Analyse-Schaltfläche verschwindet.
  useEffect(() => {
    if (analysis) setStale(false)
  }, [analysis])

  const findings = analysis?.findings ?? []
  const primary = findings.find((finding) => finding.actions.some(isWrite))
  const lowConfidence =
    findings.length === 0 || findings.every((finding) => finding.confidence === 'possible')

  const apply = async (action: LogFixAction) => {
    if (!analysis) {
      setStale(true)
      return
    }
    setBusy('apply')
    try {
      const reply = await window.electronAPI?.logs.applyFix?.(analysis.id, action.id)
      if (!reply) {
        setResult({
          ok: false,
          code: 'INVALID',
          message: text(lang, 'Die Analyse ist nicht mehr verfügbar.', 'This analysis is no longer available.'),
        })
        setStale(true)
        return
      }
      setResult(reply)
      if ('changed' in reply) {
        if (reply.undoToken) setUndoToken(reply.undoToken)
        setStale(false)
      } else if (reply.code === 'INVALID') {
        setStale(true)
      }
    } finally {
      setBusy(null)
    }
  }

  const undo = async () => {
    if (!undoToken) return
    setBusy('undo')
    try {
      const reply = await window.electronAPI?.logs.undoFix?.(undoToken)
      if (!reply) {
        setResult({
          ok: false,
          code: 'INVALID',
          message: text(lang, 'Die Aktion kann nicht mehr rückgängig gemacht werden.', 'This action can no longer be undone.'),
        })
        setStale(true)
        return
      }
      setResult(reply)
      if ('changed' in reply) setUndoToken(null)
      else if (reply.code === 'INVALID') setStale(true)
    } finally {
      setBusy(null)
    }
  }

  const reanalyze = async () => {
    setBusy('reanalyze')
    try {
      const next = await onReanalyze?.()
      if (!next) {
        setStale(true)
        return
      }
      setResult(null)
      setUndoToken(null)
      setStale(false)
    } finally {
      setBusy(null)
    }
  }

  const copyEvidence = () => {
    const evidence = findings.flatMap((finding) => finding.evidence).slice(0, 3).join('\n')
    if (!evidence) return
    window.electronAPI?.system.copy?.(evidence)
  }

  const copyLog = async () => {
    setBusy('log')
    try {
      const log = await window.electronAPI?.logs.readLatest?.(folderName ?? '')
      if (!log) {
        addToast({
          type: 'warning',
          message: text(lang, 'Kein Log zum Kopieren gefunden.', 'No log available to copy.'),
        })
        return
      }
      window.electronAPI?.system.copy?.(log)
      addToast({
        type: 'success',
        message: text(lang, 'Log kopiert.', 'Log copied.'),
      })
    } catch (error) {
      addToast({ type: 'error', message: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const saveSupportBundle = async (): Promise<boolean> => {
    const target = await window.electronAPI?.dialogs.save?.({
      title: text(lang, 'Support-Bundle speichern', 'Save support bundle'),
      defaultPath: `bamboo-support-${folderName || 'instance'}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (!target || target.canceled || !target.filePath) return false
    const reply = await window.electronAPI?.logs.createSupportBundle?.(target.filePath)
    if (!reply?.file) {
      throw new Error(
        text(lang, 'Support-Bundle wurde nicht erstellt.', 'Support bundle was not created.'),
      )
    }
    addToast({
      type: 'success',
      message: text(
        lang,
        `Support-Bundle gespeichert: ${reply.file}`,
        `Support bundle saved: ${reply.file}`,
      ),
    })
    return true
  }

  const createBundle = async () => {
    setBusy('bundle')
    try {
      await saveSupportBundle()
    } catch (error) {
      addToast({ type: 'error', message: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const reportAnalysis = async () => {
    if (!analysis) {
      setStale(true)
      return
    }
    setBusy('report')
    try {
      if (!(await saveSupportBundle())) return
      const summary = [
        `Bamboo crash report — ${instanceName}`,
        `analysis: ${analysis.id}`,
        ...findings.map(
          (finding) =>
            `${finding.ruleId} (${finding.confidence}): ${finding.detail}` +
            (finding.evidence.length > 0
              ? `\n  ${finding.evidence.slice(0, 3).join('\n  ')}`
              : ''),
        ),
      ].join('\n')
      window.electronAPI?.system.copy?.(summary)
      addToast({
        type: 'info',
        message: text(
          lang,
          'Zusammenfassung kopiert. Bitte das ZIP mitsenden.',
          'Summary copied. Attach the ZIP when reporting.',
        ),
      })
    } catch (error) {
      addToast({ type: 'error', message: (error as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={primary?.title || text(lang, 'Crash-Analyse', 'Crash analysis')}
      titleId="crash-analysis-dialog-title"
      closeLabel={translations[lang].common.close}
      icon={<ShieldAlert className="h-4 w-4" />}
      tone="danger"
      footer={
        <>
          {undoToken && (
            <button type="button" onClick={undo} disabled={!!busy} className={dialogButton.secondary}>
              <RotateCcw className="mr-1 inline h-3 w-3" />
              {text(lang, 'Rückgängig', 'Undo')}
            </button>
          )}
          {findings.length > 0 && (
            <button type="button" onClick={copyEvidence} className={dialogButton.secondary}>
              <ClipboardCopy className="mr-1 inline h-3 w-3" />
              {text(lang, 'Evidenz kopieren', 'Copy evidence')}
            </button>
          )}
          {stale && onReanalyze && (
            <button
              type="button"
              onClick={reanalyze}
              disabled={!!busy}
              className={dialogButton.accent}
            >
              <RefreshCw className={`mr-1 inline h-3 w-3 ${busy === 'reanalyze' ? 'animate-spin' : ''}`} />
              {text(lang, 'Neu analysieren', 'Analyze again')}
            </button>
          )}
          <button type="button" onClick={onClose} className={dialogButton.secondary}>
            {translations[lang].common.close}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 text-mini font-medium uppercase tracking-label text-ink-tertiary">
              {instanceName}
            </p>
            <p className="m-0 mt-1 text-small text-ink-secondary">
              {text(
                lang,
                'Die Analyse läuft nach dem Absturz inline. Es wird nichts automatisch geändert.',
                'Analysis runs inline after the crash. Nothing is changed automatically.',
              )}
            </p>
          </div>
          {analysis?.truncated && (
            <span className="shrink-0 rounded-md border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-micro text-warning">
              {text(lang, 'Log gekürzt', 'Log truncated')}
            </span>
          )}
        </div>

        {stale && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/8 px-3 py-2.5 text-mini text-ink-secondary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              {text(
                lang,
                'Diese Analyse ist veraltet. Nach einem Neustart oder einer neuen Analyse sind alte IDs ungültig.',
                'This analysis is stale. After a restart or a new analysis, old IDs are invalid.',
              )}
            </span>
          </div>
        )}

        {findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-stroke bg-root/30 px-3 py-4 text-small text-ink-secondary">
            <Search className="h-4 w-4 shrink-0 text-ink-tertiary" />
            {text(lang, 'Keine Ursache mit ausreichender Sicherheit erkannt.', 'No cause found with enough confidence.')}
          </div>
        ) : (
          findings.map((finding) => {
            const canFix = finding.confidence !== 'possible'
            return (
              <section key={finding.ruleId} className="rounded-xl border border-stroke bg-root/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="m-0 text-small font-semibold text-ink">{finding.title}</h4>
                  <span className="rounded-md border border-stroke bg-hover px-1.5 py-0.5 text-micro text-ink-secondary">
                    {confidenceLabel(finding, lang)}
                  </span>
                  <span className="text-micro text-ink-quaternary">{finding.ruleId}</span>
                </div>
                <p className="m-0 mt-1.5 text-small leading-5 text-ink-secondary">{finding.detail}</p>

                {finding.evidence.length > 0 && (
                  <pre className="mt-2 max-h-28 overflow-auto rounded-lg border border-stroke bg-root/60 p-2 font-mono text-mini leading-4 text-ink-secondary custom-scrollbar">
                    {finding.evidence.slice(0, 3).join('\n')}
                  </pre>
                )}

                {finding.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {finding.actions.map((action) => {
                      const write = isWrite(action)
                      if (write && !canFix) return null
                      return (
                        <button
                          key={action.id}
                          type="button"
                          onClick={() => apply(action)}
                          disabled={!!busy}
                          className={write && canFix ? dialogButton.accent : dialogButton.secondary}
                        >
                          {actionLabel(action, lang)}
                        </button>
                      )
                    })}
                  </div>
                )}

                {!canFix && finding.actions.some(isWrite) && (
                  <p className="m-0 mt-2 text-mini text-ink-tertiary">
                    {text(
                      lang,
                      'Die Zuordnung ist unsicher; deshalb gibt es keinen automatischen Fix.',
                      'The attribution is uncertain, so there is no automatic fix.',
                    )}
                  </p>
                )}
              </section>
            )
          })
        )}

        <div className="flex flex-wrap gap-2 border-t border-hairline pt-3">
          <button
            type="button"
            onClick={copyLog}
            disabled={!!busy}
            className={dialogButton.secondary}
          >
            <ScrollText className="mr-1 inline h-3 w-3" />
            {text(lang, 'Log kopieren', 'Copy log')}
          </button>
          <button
            type="button"
            onClick={createBundle}
            disabled={!!busy}
            className={dialogButton.secondary}
          >
            <Package className="mr-1 inline h-3 w-3" />
            {text(lang, 'Support-Bundle', 'Support bundle')}
          </button>
          {lowConfidence && (
            <button
              type="button"
              onClick={reportAnalysis}
              disabled={!!busy}
              className={dialogButton.secondary}
            >
              <FileWarning className="mr-1 inline h-3 w-3" />
              {text(lang, 'Analyse melden', 'Report analysis')}
            </button>
          )}
        </div>

        {result && (
          <div
            className={`rounded-xl border px-3 py-2.5 text-mini ${
              'changed' in result
                ? 'border-success/25 bg-success/8 text-ink-secondary'
                : 'border-danger/25 bg-danger/8 text-ink-secondary'
            }`}
          >
            {'changed' in result ? (
              <>
                <p className="m-0 font-medium text-ink">
                  {text(lang, 'Aktion ausgeführt.', 'Action applied.')}
                </p>
                <p className="m-0 mt-1 font-mono text-micro text-ink-tertiary">
                  {result.changed.join(' · ') || '—'}
                </p>
                {result.requiresRestart && (
                  <p className="m-0 mt-1">
                    {text(lang, 'Die Instanz muss neu gestartet werden.', 'The instance must be restarted.')}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="m-0 font-medium text-ink">
                  {text(lang, `Aktion nicht möglich (${result.code}).`, `Action failed (${result.code}).`)}
                </p>
                <p className="m-0 mt-1">{result.message}</p>
              </>
            )}
          </div>
        )}

        {analysis && analysis.reasons.length > 0 && (
          <p className="m-0 font-mono text-micro text-ink-quaternary">{analysis.reasons.join(' · ')}</p>
        )}
      </div>
    </Dialog>
  )
}
