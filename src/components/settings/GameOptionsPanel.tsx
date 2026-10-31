import React, { useMemo, useState } from 'react'
import {
  Eye,
  Gamepad2,
  MessageSquare,
  Monitor,
  RotateCcw,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import {
  GAME_OPTION_CATEGORIES,
  GAME_OPTIONS,
  gameOptionsForCategory,
  resetGameOptionsForCategory,
  type GameOptionCategory,
  type GameOptionDef,
  type GameOptionValue,
} from '../../lib/gameOptions'
import {
  Badge,
  ConfirmButton,
  SettingsCard,
  SettingsRow,
  SelectField,
  Slider,
  Toggle,
  type Lang,
} from './SettingsPrimitives'
import { t } from './settingsUtils'

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  monitor: Monitor,
  volume: Volume2,
  gamepad: Gamepad2,
  message: MessageSquare,
  eye: Eye,
}

interface GameOptionsPanelProps {
  lang: Lang
  values: Record<string, GameOptionValue>
  onChange: (key: string, value: GameOptionValue) => void
  onReplace: (values: Record<string, GameOptionValue>) => void
  note?: string
}

export function GameOptionsPanel({ lang, values, onChange, onReplace, note }: GameOptionsPanelProps) {
  const [category, setCategory] = useState<GameOptionCategory>('video')
  const options = gameOptionsForCategory(category)
  const activeCategory = GAME_OPTION_CATEGORIES.find((entry) => entry.id === category)

  const changedCount = useMemo(
    () => GAME_OPTIONS.filter((option) => values[option.key] !== option.defaultValue).length,
    [values],
  )

  const categoryChanged = options.filter((option) => values[option.key] !== option.defaultValue).length

  return (
    <div className="flex flex-col gap-4">
      {note && (
        <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-info/20 bg-info/8 px-3 py-2.5 text-mini leading-5 text-ink-secondary">
          <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <span>{note}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-stroke bg-root/40 p-1">
          {GAME_OPTION_CATEGORIES.map((entry) => {
            const Icon = CATEGORY_ICONS[entry.icon] || Monitor
            const active = entry.id === category
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setCategory(entry.id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-mini font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer ${
                  active
                    ? 'bg-accent/12 text-accent'
                    : 'text-ink-secondary hover:bg-hover hover:text-ink'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {entry.label[lang]}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          {changedCount > 0 && (
            <Badge tone="accent">
              {t(lang, `${changedCount} angepasst`, `${changedCount} customized`)}
            </Badge>
          )}
          <ConfirmButton
            onConfirm={() => onReplace(resetGameOptionsForCategory(values, category))}
            confirmLabel={t(lang, 'Wirklich?', 'Really?')}
            variant="secondary"
            icon={<RotateCcw className="h-3 w-3" />}
          >
            {t(lang, 'Vanilla', 'Vanilla')}
          </ConfirmButton>
        </div>
      </div>

      <SettingsCard
        title={activeCategory?.label[lang]}
        description={t(
          lang,
          'Diese Werte werden beim Start in die options.txt der Instanz übernommen – auch bei bestehenden Instanzen.',
          'These values are applied to the instance options.txt on every launch, including existing instances.',
        )}
        action={
          categoryChanged > 0 ? (
            <Badge tone="warning">
              {t(lang, `${categoryChanged} geändert`, `${categoryChanged} changed`)}
            </Badge>
          ) : (
            <Badge>{t(lang, 'Vanilla', 'Vanilla')}</Badge>
          )
        }
      >
        {options.map((option) => (
          <GameOptionRow
            key={option.key}
            option={option}
            value={values[option.key]}
            lang={lang}
            onChange={(value) => onChange(option.key, value)}
          />
        ))}
      </SettingsCard>
    </div>
  )
}

function GameOptionRow({
  option,
  value,
  lang,
  onChange,
}: {
  option: GameOptionDef
  value: GameOptionValue | undefined
  lang: Lang
  onChange: (value: GameOptionValue) => void
}) {
  if (option.kind === 'toggle') {
    return (
      <SettingsRow
        title={option.label[lang]}
        description={option.description?.[lang]}
        control={
          <Toggle
            checked={value === true}
            onChange={onChange}
            label={option.label[lang]}
          />
        }
      />
    )
  }

  if (option.kind === 'select') {
    return (
      <SettingsRow
        title={option.label[lang]}
        description={option.description?.[lang]}
        control={
          <SelectField
            value={String(value ?? option.defaultValue)}
            options={(option.choices || []).map((choice) => ({
              value: String(choice.value),
              label: choice.label[lang],
            }))}
            onChange={(next) => {
              const original = option.choices?.find((choice) => String(choice.value) === next)
              onChange(original ? original.value : next)
            }}
            ariaLabel={option.label[lang]}
            className="w-44"
          />
        }
      />
    )
  }

  const numeric = typeof value === 'number' ? value : Number(value ?? option.defaultValue)
  return (
    <SettingsRow
      title={option.label[lang]}
      description={option.description?.[lang]}
      control={
        <div className="w-[260px] max-w-[46vw]">
          <Slider
            min={option.min ?? 0}
            max={option.max ?? 100}
            step={option.step ?? 1}
            value={Number.isFinite(numeric) ? numeric : Number(option.defaultValue)}
            onChange={onChange}
            formatValue={(next) =>
              option.key === 'maxFramerate' && next === option.max
                ? '∞'
                : `${next}${option.unit ? ` ${option.unit}` : ''}`
            }
          />
        </div>
      }
    />
  )
}
