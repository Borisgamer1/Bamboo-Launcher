import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pointer, X } from 'lucide-react'
import type { LanguageType } from '../../lib/translations'
import { dialogButton } from '../dialogSupport'
import { buildTourStations, copyFor } from './onboardingCopy'

const BUBBLE_WIDTH = 340
const MARGIN = 16
/** A gated step never strands the user: after this long, a quiet skip appears. */
const SKIP_AFTER_MS = 8000

interface Box {
  top: number
  left: number
  width: number
  height: number
}

interface TourOverlayProps {
  lang: LanguageType
  hasInstances: boolean
  onDone: () => void
  onExit: () => void
}

function visibleBox(selector: string): Box | null {
  // Wide layouts render the sidebar, narrow ones the bottom nav; both carry the
  // same anchor, so the first one with a real box wins.
  const target = Array.from(document.querySelectorAll(selector)).find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  })
  if (!target) return null
  const rect = target.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/**
 * A spotlight over the real launcher. It never navigates: steps that change the
 * page are gated on the user clicking the highlighted control, so the tutorial
 * teaches by doing. The dim layer ignores pointer events.
 */
export const TourOverlay: React.FC<TourOverlayProps> = ({ lang, hasInstances, onDone, onExit }) => {
  const copy = copyFor(lang)
  // Fixed for this run: creating an instance mid-tour must not shift the list
  // under the user's feet.
  const [stations] = useState(() => buildTourStations({ hasInstances }))
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [stuckIndex, setStuckIndex] = useState(-1)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [bubbleHeight, setBubbleHeight] = useState(0)
  const advancing = useRef(false)

  const station = stations[index]
  const last = index === stations.length - 1
  const gated = station.advance === 'click'

  const goNext = () => {
    if (advancing.current) return
    advancing.current = true
    if (last) onDone()
    else setIndex(index + 1)
    window.setTimeout(() => { advancing.current = false }, 250)
  }

  useEffect(() => {
    const measure = () => setBox(visibleBox(station.target))
    measure()
    const timer = window.setInterval(measure, 200)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [station.target])

  // The highlighted control is the ticket forward.
  useEffect(() => {
    if (station.advance !== 'click') return
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest(station.target)) goNext()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  })

  const stuck = stuckIndex === index
  useEffect(() => {
    if (station.advance !== 'click') return
    const timer = window.setTimeout(() => setStuckIndex(index), SKIP_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [station.advance, index])

  useLayoutEffect(() => {
    setBubbleHeight(bubbleRef.current?.offsetHeight ?? 0)
  }, [index, lang, box, stuck])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth

  const placement = (() => {
    if (!box) {
      return {
        left: Math.max(MARGIN, viewportWidth / 2 - BUBBLE_WIDTH / 2),
        top: Math.max(MARGIN, viewportHeight - bubbleHeight - 32),
      }
    }
    const rightRoom = viewportWidth - box.left - box.width
    const left = rightRoom > BUBBLE_WIDTH + MARGIN * 2
      ? box.left + box.width + MARGIN
      : Math.max(MARGIN, box.left - BUBBLE_WIDTH - MARGIN)
    const top = Math.min(
      Math.max(MARGIN, box.top - 8),
      Math.max(MARGIN, viewportHeight - bubbleHeight - MARGIN),
    )
    return { left, top }
  })()

  return (
    <div className="fixed inset-0 z-[95] pointer-events-none">
      {box && (
        <>
          <div
            className="absolute rounded-xl transition-[left,top,width,height] duration-300 ease-out"
            style={{
              left: box.left - 4,
              top: box.top - 4,
              width: box.width + 8,
              height: box.height + 8,
              boxShadow: '0 0 0 9999px rgba(4, 8, 6, 0.74)',
            }}
          />
          <div
            className="tour-ring absolute rounded-xl transition-[left,top,width,height] duration-300 ease-out"
            style={{
              left: box.left - 4,
              top: box.top - 4,
              width: box.width + 8,
              height: box.height + 8,
            }}
          />
        </>
      )}
      {!box && <div className="absolute inset-0 bg-[rgba(4,8,6,0.74)]" />}

      <div
        ref={bubbleRef}
        className="absolute pointer-events-auto rounded-2xl border border-rim bg-surface p-4 shadow-[var(--shadow-menu)] transition-[left,top] duration-300 ease-out"
        style={{ left: placement.left, top: placement.top, width: BUBBLE_WIDTH }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-micro font-medium uppercase tracking-[0.12em] text-ink-tertiary">
            {copy.step(index + 1, stations.length)}
          </span>
          <button
            onClick={onExit}
            aria-label={copy.quit}
            className="rounded-md p-1 text-ink-tertiary hover:bg-hover hover:text-ink transition-colors cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <h2 className="mt-2 text-title3 font-semibold text-ink">{station.title[lang]}</h2>
        <p className="mt-1.5 text-small leading-relaxed text-ink-secondary">{station.body[lang]}</p>

        {station.hint && (
          <p className={`mt-3 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-mini font-medium ${
            gated ? 'bg-accent/12 text-accent' : 'bg-hover text-ink-secondary'
          }`}>
            <Pointer className="h-3 w-3" />
            {station.hint[lang]}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-hover">
            <div
              className="tour-progress h-full rounded-full bg-accent"
              style={{ width: `${((index + 1) / stations.length) * 100}%` }}
            />
          </div>
          {index > 0 && (
            <button onClick={() => setIndex(index - 1)} className={dialogButton.secondary}>
              {copy.back}
            </button>
          )}
          {!gated && (
            <button onClick={goNext} className={dialogButton.accent} data-autofocus>
              {copy.next}
            </button>
          )}
          {gated && stuck && (
            <button
              onClick={goNext}
              className="rounded-lg px-2 py-1 text-mini font-medium text-ink-tertiary underline underline-offset-2 hover:text-ink transition-colors cursor-pointer"
            >
              {copy.skipStep}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
