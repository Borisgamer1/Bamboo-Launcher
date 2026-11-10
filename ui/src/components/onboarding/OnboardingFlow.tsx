import React, { useState } from 'react'
import { motion } from 'framer-motion'
import type { LanguageType } from '../../lib/translations'
import { dialogButton } from '../dialogSupport'
import { copyFor } from './onboardingCopy'
import { JavaScanPanel } from './JavaScanPanel'
import { TourOverlay } from './TourOverlay'
import { WelcomeScreen } from './WelcomeScreen'

type Step = 'welcome' | 'tour' | 'java' | 'done'

interface OnboardingFlowProps {
  lang: LanguageType
  /** "tour" restarts the tour from the About tab without the welcome screen. */
  initialStep?: 'welcome' | 'tour'
  /** A launcher with instances is not taught to create its first one. */
  hasInstances: boolean
  onFinish: () => void
}

export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({
  lang,
  initialStep = 'welcome',
  hasInstances,
  onFinish,
}) => {
  const copy = copyFor(lang)
  const [step, setStep] = useState<Step>(initialStep)

  if (step === 'welcome') {
    return <WelcomeScreen lang={lang} onStart={() => setStep('tour')} onSkip={onFinish} />
  }

  if (step === 'tour') {
    // "Weiter" on the last station leads into the Java check; closing the tour
    // means the user is done with being shown around.
    return (
      <TourOverlay
        lang={lang}
        hasInstances={hasInstances}
        onDone={() => setStep('java')}
        onExit={onFinish}
      />
    )
  }

  if (step === 'java') {
    return <JavaScanPanel lang={lang} onContinue={() => setStep('done')} />
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-root/70 backdrop-blur-2xl px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[360px] text-center"
      >
        <h2 className="text-title2 font-semibold text-ink">{copy.doneTitle}</h2>
        <p className="mt-2 text-regular leading-relaxed text-ink-secondary">{copy.doneBody}</p>
        <button onClick={onFinish} className={`${dialogButton.accent} mt-6 h-9 px-5`} data-autofocus>
          {copy.doneAction}
        </button>
      </motion.div>
    </div>
  )
}
