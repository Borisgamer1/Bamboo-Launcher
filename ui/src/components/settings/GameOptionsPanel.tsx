import React, { useMemo, useState } from 'react'
import { translations } from '../../lib/translations';
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
        <div className="flex items-start gap-2.5 px-1 text-mini leading-5 text-ink-tertiary">
          <Monitor className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{note}</span>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-hairline">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          {GAME_OPTION_CATEGORIES.map((entry) => {
            const Icon = CATEGORY_ICONS[entry.icon] || Monitor
            const active = entry.id === category
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setCategory(entry.id)}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 border-b-2 px-2.5 text-mini font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] ${
                  active
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-secondary hover:text-ink'
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-ink-tertiary'}`} />
                {entry.label[lang]}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-3 pb-2">
          {changedCount > 0 && (
            <span className="font-mono text-micro tabular-nums text-ink-tertiary">
              {t(lang, `${changedCount} angepasst`, `${changedCount} customized`)}
            </span>
          )}
          <ConfirmButton
            onConfirm={() => onReplace(resetGameOptionsForCategory(values, category))}
            confirmLabel={translations[lang].common.resetConfirm}
            variant="secondary"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
          >
            {translations[lang].common.reset}
          </ConfirmButton>
        </div>
      </div>

      <SettingsCard
        title={activeCategory?.label[lang]}
        action={
          categoryChanged > 0 ? (
            <span className="font-mono text-micro tabular-nums text-warning">
              {t(lang, `${categoryChanged} geändert`, `${categoryChanged} changed`)}
            </span>
          ) : (
            <span className="font-mono text-micro tabular-nums text-ink-quaternary">
              {t(lang, 'Standard', 'Default')}
            </span>
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
        <div className="w-[280px] max-w-[46vw]">
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
