import { AlertTriangle, FolderOpen } from 'lucide-react'
import type { LaunchPreflightPrompt } from '../hooks/useLaunchController'
import type { LanguageType } from '../lib/translations'
import { Dialog } from './Dialog'
import { dialogButton, useLastDefined } from './dialogSupport'

interface LaunchPreflightDialogProps {
  prompt: LaunchPreflightPrompt | null
  busy: boolean
  lang: LanguageType
  onCancel: () => void
  onConfirm: () => void
  onDisable: (files: string[]) => void
}

/**
 * Hält den Start an, wenn die Prüfung vor dem Start etwas gefunden hat. Jeder
 * Befund lässt sich direkt beheben (Datei deaktivieren) oder bewusst
 * übergehen; der Launcher entscheidet nichts stillschweigend.
 */
export function LaunchPreflightDialog({
  prompt,
  busy,
  lang,
  onCancel,
  onConfirm,
  onDisable,
}: LaunchPreflightDialogProps) {
  // Der Dialog schließt animiert; ohne den letzten Stand wäre der Inhalt in
  // dieser Zeit leer.
  const shown = useLastDefined(prompt)
  const errors = shown?.issues.filter((issue) => issue.severity === 'error').length ?? 0
  const title = lang === 'de' ? 'Startprüfung' : 'Pre-launch check'

  return (
    <Dialog
      open={!!prompt}
      onClose={onCancel}
      title={title}
      titleId="preflight-dialog-title"
      closeLabel={lang === 'de' ? 'Schließen' : 'Close'}
      icon={<AlertTriangle className="h-4 w-4" />}
      tone={errors > 0 ? 'danger' : 'info'}
      widthClassName="w-[560px]"
      footer={
        <>
          <button
            type="button"
            className={`${dialogButton.secondary} mr-auto inline-flex items-center gap-1.5`}
            onClick={() => window.electronAPI?.instances.openFolder?.(shown?.folderName ?? '')}
            disabled={!shown || busy}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {lang === 'de' ? 'Mods-Ordner' : 'Mods folder'}
          </button>
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            disabled={busy}
            className={dialogButton.secondary}
          >
            {lang === 'de' ? 'Abbrechen' : 'Cancel'}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={dialogButton.accent}>
            {lang === 'de' ? 'Trotzdem starten' : 'Start anyway'}
          </button>
        </>
      }
    >
      {shown && (
        <div className="space-y-3">
          <p className="m-0 text-small text-ink-secondary">
            {lang === 'de'
              ? `${shown.checkedMods} Mods in „${shown.name}“ geprüft. Diese Punkte würden den Start wahrscheinlich verhindern:`
              : `${shown.checkedMods} mods checked in “${shown.name}”. These findings would likely prevent the game from starting:`}
          </p>

          {shown.issues.map((issue, index) => (
            <div
              key={`${issue.kind}-${issue.title}-${index}`}
              className="rounded-xl border border-hairline bg-root/50 p-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    issue.severity === 'error' ? 'text-danger' : 'text-warning'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-small font-medium text-ink">{issue.title}</p>
                  <p className="m-0 mt-1 break-words text-micro leading-5 text-ink-tertiary">
                    {issue.detail}
                  </p>
                  {issue.disable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => onDisable(issue.disable)}
                      disabled={busy}
                      className="mt-2 h-7 rounded-lg border border-stroke bg-surface px-2.5 text-micro font-medium text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy
                        ? (lang === 'de' ? 'Wird deaktiviert …' : 'Disabling …')
                        : issue.disable.length > 1
                          ? (lang === 'de'
                              ? `${issue.disable.length} Dateien deaktivieren`
                              : `Disable ${issue.disable.length} files`)
                          : (lang === 'de' ? 'Datei deaktivieren' : 'Disable file')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          <p className="m-0 text-micro text-ink-quaternary">
            {lang === 'de'
              ? 'Deaktivieren benennt die Datei in „.disabled“ um; sie bleibt im Ordner und lässt sich zurückholen.'
              : 'Disabling renames the file to “.disabled”; it stays in the folder and can be restored.'}
          </p>
        </div>
      )}
    </Dialog>
  )
}
