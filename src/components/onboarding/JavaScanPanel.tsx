import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Coffee, TriangleAlert } from 'lucide-react'
import type { JavaVersion } from '../../electron'
import type { LanguageType } from '../../lib/translations'
import { dialogButton } from '../dialogSupport'
import { copyFor } from './onboardingCopy'

type ScanState = 'scanning' | 'found' | 'none' | 'error'

interface JavaScanPanelProps {
  lang: LanguageType
  onContinue: () => void
}

const MIN_SCAN_MS = 900

/** Real scan through the launcher's Java resolver, with a floor so it never flickers. */
export const JavaScanPanel: React.FC<JavaScanPanelProps> = ({ lang, onContinue }) => {
  const copy = copyFor(lang)
  const [state, setState] = useState<ScanState>('scanning')
  const [versions, setVersions] = useState<JavaVersion[]>([])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const started = Date.now()
      let found: JavaVersion[] = []
      let failed = false
      try {
        const api = window.electronAPI?.java
        if (!api) failed = true
        else found = (await api.versions(true)) ?? []
      } catch {
        failed = true
      }
      const elapsed = Date.now() - started
      if (elapsed < MIN_SCAN_MS) await new Promise((resolve) => setTimeout(resolve, MIN_SCAN_MS - elapsed))
      if (cancelled) return
      setVersions(found)
      setState(failed ? 'error' : found.length > 0 ? 'found' : 'none')
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-root/70 backdrop-blur-2xl px-6">
      <div className="w-full max-w-[400px]">
        <div className="rounded-2xl border border-rim bg-surface p-5 shadow-[var(--shadow-menu)]">
          <div className="flex items-center gap-2 text-ink">
            <Coffee className="h-4 w-4 text-accent" />
            <h2 className="text-title3 font-semibold">{copy.javaTitle}</h2>
          </div>

          {state === 'scanning' && (
            <>
              <p className="mt-2 text-small text-ink-secondary">{copy.javaScanning}</p>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-hover">
                <motion.div
                  className="h-full w-1/3 rounded-full bg-accent"
                  animate={{ x: ['-100%', '300%'] }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                />
              </div>
            </>
          )}

          {state === 'found' && (
            <>
              <p className="mt-2 text-small text-ink-secondary">{copy.javaFound}</p>
              <ul className="mt-3 flex flex-col gap-1.5">
                {versions.slice(0, 4).map((java) => (
                  <li
                    key={java.path}
                    className="flex items-center gap-2 rounded-lg border border-stroke bg-root px-2.5 py-1.5 text-small text-ink"
                  >
                    <Check className="h-3.5 w-3.5 text-accent" />
                    <span className="font-medium">Java {java.majorVersion ?? java.version}</span>
                    <span className="truncate text-mini text-ink-tertiary">
                      {[java.vendor, java.arch].filter(Boolean).join(' · ') || java.verStr}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {(state === 'none' || state === 'error') && (
            <p className="mt-2 flex items-start gap-2 text-small text-ink-secondary">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-info" />
              {state === 'none' ? copy.javaNone : copy.javaFailed}
            </p>
          )}

          <div className="mt-5 flex justify-end">
            <button
              onClick={onContinue}
              disabled={state === 'scanning'}
              className={`${dialogButton.accent} disabled:opacity-40 disabled:cursor-not-allowed`}
              data-autofocus
            >
              {copy.next}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
