import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { translations, type LanguageType } from '../../lib/translations'
import { describeCurseForgeFailure, type CurseForgeFailure } from '../../lib/curseforge'

export function CurseForgeFailureNotice({
  failure,
  lang,
  title,
  actions,
  className = 'py-24',
}: {
  failure: CurseForgeFailure
  lang: LanguageType
  title?: string
  actions?: React.ReactNode
  className?: string
}) {
  const copy = describeCurseForgeFailure(failure, translations[lang])
  return (
    <div className={`text-center flex flex-col items-center justify-center gap-3 ${className}`}>
      <div className="w-16 h-16 rounded-2xl bg-surface border border-stroke flex items-center justify-center text-ink-secondary">
        <AlertTriangle className="w-8 h-8" />
      </div>
      <p className="text-regular font-medium text-ink">{title ?? copy.title}</p>
      <p className="text-small text-ink-tertiary max-w-md">{copy.body}</p>
      {failure.detail && (
        <p className="text-micro text-ink-tertiary/80 max-w-md break-words font-mono">{failure.detail}</p>
      )}
      {actions && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}
