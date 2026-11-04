import React from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, X } from 'lucide-react'
import type { LanguageType } from '../../lib/translations'
import { dialogButton } from '../dialogSupport'
import { copyFor } from './onboardingCopy'

interface WelcomeScreenProps {
  lang: LanguageType
  onStart: () => void
  onSkip: () => void
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ lang, onStart, onSkip }) => {
  const copy = copyFor(lang)

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-root/70 backdrop-blur-2xl px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px] text-center"
      >
        <img
          src="./images/bamboo-logo.png"
          alt="Bamboo Launcher"
          className="mx-auto mb-5 h-14 w-14 rounded-2xl object-cover shadow-lg"
        />
        <p className="text-micro font-medium uppercase tracking-[0.14em] text-ink-tertiary">Bamboo Launcher</p>
        <h1 className="mt-2 text-title1 font-semibold text-ink">{copy.welcomeTitle}</h1>
        <p className="mx-auto mt-3 max-w-[320px] text-regular leading-relaxed text-ink-secondary">{copy.welcomeBody}</p>

        <div className="mt-7 flex flex-col items-center gap-2">
          <button onClick={onStart} className={`${dialogButton.accent} h-9 px-5 inline-flex items-center gap-2`} data-autofocus>
            {copy.start}
            <ArrowRight className="h-4 w-4" />
          </button>
          <button onClick={onSkip} className="rounded-lg px-3 py-1.5 text-small font-medium text-ink-tertiary hover:text-ink transition-colors cursor-pointer">
            {copy.skip}
          </button>
        </div>
        <p className="mt-4 text-mini text-ink-tertiary">{copy.duration}</p>
      </motion.div>

      <button
        onClick={onSkip}
        aria-label={copy.skip}
        className="absolute right-4 top-4 rounded-lg p-2 text-ink-tertiary hover:bg-hover hover:text-ink transition-colors cursor-pointer"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
