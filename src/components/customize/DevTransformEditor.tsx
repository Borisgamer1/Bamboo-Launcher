import React from 'react'
import { Copy, RotateCcw } from 'lucide-react'
import type { LanguageType } from '../../lib/translations'
import type { CosmeticEntry, CosmeticTransform } from './cosmeticCatalog'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface DevTransformEditorProps {
  entry: CosmeticEntry
  transform: CosmeticTransform
  saveState: SaveState
  lang: LanguageType
  onChange: (patch: Partial<CosmeticTransform>) => void
  onReset: () => void
}

const RANGES = {
  position: { min: -32, max: 32, step: 0.25, unit: 'px' },
  rotation: { min: -180, max: 180, step: 1, unit: '°' },
  scale: { min: 0.25, max: 3, step: 0.05, unit: '×' },
} as const

const AXES = ['X', 'Y', 'Z'] as const

const Slider: React.FC<{
  label: 'X' | 'Y' | 'Z'
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
}> = ({ label, value, min, max, step, unit, onChange }) => {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="grid grid-cols-[12px_minmax(0,1fr)_52px] items-center gap-2">
      <span className="text-micro font-medium text-ink-quaternary">{label}</span>
      <input
        type="range"
        className="settings-range w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--range-progress' as string]: `${progress}%` }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="text-right text-micro tabular-nums text-ink-secondary">
        {Number.isInteger(value) ? value : value.toFixed(2)}
        <span className="ml-0.5 text-ink-quaternary">{unit}</span>
      </span>
    </label>
  )
}

/**
 * Development-only placement editor. The values are the bundle's attachment
 * transform, so the preview and the in-game renderer read the same numbers.
 */
export const DevTransformEditor: React.FC<DevTransformEditorProps> = ({
  entry,
  transform,
  saveState,
  lang,
  onChange,
  onReset,
}) => {
  const de = lang === 'de'
  const scale = transform.scale[0]

  const updateAxis = (key: 'position' | 'rotation', axis: number, value: number) => {
    const next = [...transform[key]] as [number, number, number]
    next[axis] = value
    onChange({ [key]: next })
  }

  const copy = () => {
    const attachment = {
      bone: transform.bone,
      position: transform.position,
      rotation: transform.rotation,
      scale: transform.scale,
    }
    void navigator.clipboard?.writeText(JSON.stringify(attachment, null, 2))
  }

  return (
    <section className="mt-2 rounded-[12px] border border-hairline bg-surface/70">
      <header className="flex items-center justify-between gap-3 px-3 pb-1 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-micro font-medium text-ink-secondary">{entry.name}</span>
          <span className="rounded-[4px] border border-hairline px-1 py-px text-[10px] leading-3 text-ink-quaternary">
            DEV
          </span>
        </div>
        <span
          className={`text-[10px] leading-3 ${
            saveState === 'error' ? 'text-danger' : 'text-ink-quaternary'
          }`}
          aria-live="polite"
        >
          {saveState === 'saving'
            ? de
              ? 'Speichert'
              : 'Saving'
            : saveState === 'saved'
              ? de
                ? 'Gespeichert'
                : 'Saved'
              : saveState === 'error'
                ? de
                  ? 'Fehler'
                  : 'Error'
                : ''}
        </span>
      </header>

      <div className="flex flex-col gap-2.5 border-t border-hairline px-3 py-2.5">
        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-ink-tertiary">{de ? 'Position' : 'Position'}</span>
          {AXES.map((axis, index) => (
            <Slider
              key={`position-${axis}`}
              label={axis}
              value={transform.position[index]}
              min={RANGES.position.min}
              max={RANGES.position.max}
              step={RANGES.position.step}
              unit={RANGES.position.unit}
              onChange={(value) => updateAxis('position', index, value)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-ink-tertiary">{de ? 'Rotation' : 'Rotation'}</span>
          {AXES.map((axis, index) => (
            <Slider
              key={`rotation-${axis}`}
              label={axis}
              value={transform.rotation[index]}
              min={RANGES.rotation.min}
              max={RANGES.rotation.max}
              step={RANGES.rotation.step}
              unit={RANGES.rotation.unit}
              onChange={(value) => updateAxis('rotation', index, value)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-micro text-ink-tertiary">{de ? 'Größe' : 'Size'}</span>
          <Slider
            label="X"
            value={scale}
            min={RANGES.scale.min}
            max={RANGES.scale.max}
            step={RANGES.scale.step}
            unit={RANGES.scale.unit}
            onChange={(value) => onChange({ scale: [value, value, value] })}
          />
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-1.5">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-micro text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Copy className="h-3 w-3" aria-hidden />
          {de ? 'Kopieren' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-micro text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          {de ? 'Zurücksetzen' : 'Reset'}
        </button>
      </footer>
    </section>
  )
}
