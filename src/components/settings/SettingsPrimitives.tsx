import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cx } from './settingsUtils'

export type { Lang } from './settingsUtils'

export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cx('rounded-[var(--r-xl)] border border-stroke bg-surface/65 overflow-hidden', className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-4 py-3.5">
          <div className="min-w-0">
            {title && <h3 className="m-0 text-small font-medium text-ink">{title}</h3>}
            {description && <p className="m-0 mt-0.5 text-mini leading-5 text-ink-secondary">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div>{children}</div>
    </section>
  )
}

export function SettingsRow({
  title,
  description,
  control,
  icon,
  badge,
  onClick,
  className,
  compact,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  icon?: React.ReactNode
  badge?: React.ReactNode
  onClick?: () => void
  className?: string
  compact?: boolean
}) {
  const content = (
    <>
      {icon && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stroke bg-root/40 text-ink-secondary">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small font-medium text-ink">{title}</span>
          {badge}
        </div>
        {description && (
          <p className="m-0 mt-0.5 max-w-[62ch] text-mini leading-5 text-ink-secondary">{description}</p>
        )}
      </div>
      {control && <div className="flex shrink-0 items-center justify-end gap-2">{control}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cx(
          'flex w-full items-start gap-3 border-t border-hairline px-4 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] first:border-t-0 hover:bg-hover cursor-pointer',
          compact ? 'py-2.5' : 'py-3.5',
          className,
        )}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      className={cx(
        'flex items-start gap-3 border-t border-hairline px-4 first:border-t-0',
        compact ? 'py-2.5' : 'py-3.5',
        className,
      )}
    >
      {content}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-[var(--t-base)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer',
        checked ? 'border-accent/60 bg-accent' : 'border-stroke-strong bg-raised',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span
        className={cx(
          'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-[#f4f6f4] shadow-[0_1px_2px_rgb(0_0_0/35%)] transition-[left,background-color] duration-[var(--t-base)] ease-[var(--ease-out)]',
          checked ? 'left-[18px]' : 'left-[2px]',
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  value: T
  options: { value: T; label: string; icon?: React.ReactNode }[]
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div
      className={cx(
        'inline-flex items-center gap-0.5 rounded-lg border border-stroke bg-root/50 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer',
              size === 'sm' ? 'h-6 px-2 text-micro' : 'h-7 px-2.5 text-mini',
              active
                ? 'bg-accent/15 text-accent'
                : 'text-ink-secondary hover:bg-hover hover:text-ink',
            )}
          >
            {option.icon}
            <span className="whitespace-nowrap">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  formatValue,
  minLabel,
  maxLabel,
  disabled,
  className,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
  minLabel?: string
  maxLabel?: string
  disabled?: boolean
  className?: string
}) {
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <div className={cx('w-full', className)}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label="slider"
          onChange={(event) => onChange(Number(event.target.value))}
          className="settings-range flex-1"
          style={{ '--range-progress': `${percent}%` } as React.CSSProperties}
        />
        <span className="w-16 shrink-0 text-right text-mini font-medium tabular-nums text-ink">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      {(minLabel || maxLabel) && (
        <div className="mt-1 flex justify-between text-micro text-ink-quaternary">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  )
}

export function SelectField<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  return (
    <div className={cx('relative', className)}>
      <select
        aria-label={ariaLabel}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value
          const match = options.find((option) => String(option.value) === raw)
          onChange((match ? match.value : raw) as T)
        }}
        className={cx(
          'h-8 w-full appearance-none rounded-lg border border-stroke bg-root/50 pl-2.5 pr-8 text-mini font-medium text-ink outline-none transition-colors duration-[var(--t-quick)] hover:border-rim focus:border-accent/60 cursor-pointer',
          disabled && 'cursor-not-allowed opacity-40',
        )}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)} className="bg-surface text-ink">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary" />
    </div>
  )
}

export function TextField({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  className,
  inputClassName,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  className?: string
  inputClassName?: string
  ariaLabel?: string
}) {
  return (
    <div className={cx('w-full', className)}>
      <input
        type="text"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          'h-8 w-full rounded-lg border border-stroke bg-root/50 px-2.5 text-mini text-ink outline-none transition-colors duration-[var(--t-quick)] placeholder:text-ink-quaternary hover:border-rim focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-40',
          mono && 'font-mono',
          inputClassName,
        )}
      />
    </div>
  )
}

export function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  className,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
  className?: string
}) {
  const clamp = (next: number) => Math.max(min, Math.min(max, next))
  return (
    <div
      className={cx(
        'inline-flex h-8 items-center overflow-hidden rounded-lg border border-stroke bg-root/50',
        className,
      )}
    >
      <button
        type="button"
        aria-label="decrease"
        onClick={() => onChange(clamp(value - step))}
        className="flex h-full w-7 items-center justify-center text-ink-secondary transition-colors hover:bg-hover hover:text-ink cursor-pointer"
      >
        <Minus className="h-3 w-3" />
      </button>
      <div className="flex h-full min-w-14 items-center justify-center border-x border-stroke px-2 text-mini font-medium tabular-nums text-ink">
        {value}
        {suffix && <span className="ml-1 text-micro text-ink-tertiary">{suffix}</span>}
      </div>
      <button
        type="button"
        aria-label="increase"
        onClick={() => onChange(clamp(value + step))}
        className="flex h-full w-7 items-center justify-center text-ink-secondary transition-colors hover:bg-hover hover:text-ink cursor-pointer"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  icon,
  className,
  type = 'button',
}: {
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  icon?: React.ReactNode
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[color,background-color,border-color,opacity,transform] duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer',
        size === 'sm' ? 'h-7 px-2.5 text-micro' : 'h-8 px-3 text-mini',
        variant === 'primary' && 'bg-accent text-accent-contrast hover:bg-accent-hover active:bg-accent-press',
        variant === 'secondary' && 'border border-stroke bg-root/40 text-ink hover:border-rim hover:bg-hover',
        variant === 'ghost' && 'text-ink-secondary hover:bg-hover hover:text-ink',
        variant === 'danger' && 'border border-danger/25 bg-danger/10 text-danger hover:bg-danger/20',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  variant = 'danger',
  size = 'sm',
  icon,
}: {
  children: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  variant?: 'danger' | 'secondary'
  size?: 'sm' | 'md'
  icon?: React.ReactNode
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!armed) return
    timer.current = window.setTimeout(() => setArmed(false), 3500)
    return () => window.clearTimeout(timer.current)
  }, [armed])

  return (
    <Button
      variant={armed ? 'danger' : variant}
      size={size}
      icon={armed ? <Check className="h-3.5 w-3.5" /> : icon}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center rounded-md border px-1.5 text-micro font-medium whitespace-nowrap',
        tone === 'neutral' && 'border-stroke bg-hover text-ink-secondary',
        tone === 'accent' && 'border-accent/25 bg-accent/10 text-accent',
        tone === 'success' && 'border-success/25 bg-success/10 text-success',
        tone === 'warning' && 'border-warning/25 bg-warning/10 text-warning',
        tone === 'danger' && 'border-danger/25 bg-danger/10 text-danger',
        tone === 'info' && 'border-info/25 bg-info/10 text-info',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-[var(--r-lg)] border border-stroke bg-root/35 px-3 py-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="m-0 text-micro font-medium uppercase tracking-label text-ink-tertiary">{label}</p>
        <p className="m-0 mt-0.5 truncate text-small font-medium text-ink">{value}</p>
        {hint && <p className="m-0 mt-0.5 truncate text-micro text-ink-quaternary">{hint}</p>}
      </div>
    </div>
  )
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-dashed border-stroke px-4 py-6 text-center text-mini text-ink-tertiary">
      {children}
    </div>
  )
}
