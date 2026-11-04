import React, { useEffect, useRef, useState } from 'react'
import { Focus, Loader2, RotateCw } from 'lucide-react'
import type { LanguageType } from '../../lib/translations'
import { CosmeticViewer } from './cosmeticViewer'
import type { CosmeticEntry } from './cosmeticCatalog'

interface CosmeticStageProps {
  skinUrl: string | null
  variant: 'classic' | 'slim'
  equipped: CosmeticEntry[]
  capeUrl: string | null
  lang: LanguageType
}

const STAGE_BUTTON =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-root/75 text-ink-secondary backdrop-blur-sm transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:border-stroke-strong hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

/**
 * The equipped player, rendered from the same bundle the game reads.
 */
export const CosmeticStage: React.FC<CosmeticStageProps> = ({
  skinUrl,
  variant,
  equipped,
  capeUrl,
  lang,
}) => {
  const de = lang === 'de'
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<CosmeticViewer | null>(null)
  const [view, setView] = useState<'front' | 'back'>('back')
  const equippedRef = useRef(equipped)
  const equippedKey = equipped
    .map((entry) => `${entry.id}:${entry.transform.position.join(',')}:${entry.transform.rotation.join(',')}:${entry.transform.scale.join(',')}`)
    .join('|')

  useEffect(() => {
    equippedRef.current = equipped
  })

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const viewer = new CosmeticViewer(host, canvas)
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      if (viewerRef.current === viewer) viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    viewerRef.current?.setVariant(variant)
  }, [variant])

  useEffect(() => {
    viewerRef.current?.setView(view)
  }, [view])

  useEffect(() => {
    void viewerRef.current?.setSkin(skinUrl)
  }, [skinUrl])

  useEffect(() => {
    viewerRef.current?.setEquipped(equippedRef.current)
  }, [equippedKey, variant])

  useEffect(() => {
    void viewerRef.current?.setCape(capeUrl)
  }, [capeUrl])

  return (
    <div ref={hostRef} className="relative h-[320px] w-full overflow-hidden bg-root">
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.28))]"
        aria-hidden
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-10 block h-full w-full cursor-grab active:cursor-grabbing"
        aria-label={de ? '3D-Vorschau deines Skins mit Cosmetics' : '3D preview of your skin with cosmetics'}
      />

      {skinUrl ? null : (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
          <Loader2 className="h-4 w-4 animate-spin text-ink-tertiary" aria-hidden />
          <p className="m-0 text-micro text-ink-tertiary">
            {de ? 'Skin wird geladen' : 'Loading skin'}
          </p>
        </div>
      )}

      <div className="absolute inset-x-3 bottom-3 z-20 flex items-end justify-between gap-3">
        <p className="m-0 text-micro leading-4 text-ink-quaternary">
          {de ? 'Ziehen · Zoomen' : 'Drag · zoom'}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={STAGE_BUTTON}
            onClick={() => setView((current) => (current === 'back' ? 'front' : 'back'))}
            aria-label={view === 'back' ? (de ? 'Vorderansicht' : 'Front view') : (de ? 'Rückansicht' : 'Back view')}
            title={view === 'back' ? (de ? 'Vorderansicht' : 'Front view') : (de ? 'Rückansicht' : 'Back view')}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className={STAGE_BUTTON}
            onClick={() => viewerRef.current?.resetCamera()}
            aria-label={de ? 'Kamera zurücksetzen' : 'Reset camera'}
            title={de ? 'Kamera zurücksetzen' : 'Reset camera'}
          >
            <Focus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
