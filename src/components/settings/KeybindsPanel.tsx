import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Keyboard,
  MousePointer2,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import {
  ALL_KEYBIND_ACTIONS,
  DEFAULT_KEYBINDS,
  KEYBIND_GROUPS,
  KEYBOARD_LAYOUTS,
  actionById,
  formatKeyToken,
  keyboardLayout,
  keyTokenFromEvent,
  keyTokenFromMouseButton,
  keybindConflicts,
  layoutTokens,
  type KeyboardKey,
  type KeyboardLayoutId,
} from '../../lib/keybinds'
import {
  Button,
  ConfirmButton,
  Segmented,
  type Lang,
} from './SettingsPrimitives'
import { cx, t } from './settingsUtils'

interface KeybindsPanelProps {
  lang: Lang
  values: Record<string, string>
  onSet: (actionId: string, token: string) => void
  onClear: (actionId: string) => void
  onResetAll: () => void
  isCustom?: (actionId: string) => boolean
  layout: KeyboardLayoutId
  onLayoutChange: (layout: KeyboardLayoutId) => void
  note?: string
  footer?: React.ReactNode
}

interface RecordingState {
  actionId: string
  label: string
}

const KEY_UNIT = 33
const KEY_MIN_UNIT = 24
const KEY_GAP = 4

function keycapClass(unbound = false): string {
  return cx(
    'inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1.5 font-mono text-micro font-medium tracking-tight transition-colors',
    unbound
      ? 'border-dashed border-stroke-strong bg-transparent text-ink-quaternary'
      : 'border-stroke-strong bg-raised text-ink',
  )
}

function tokenActions(values: Record<string, string>): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const action of ALL_KEYBIND_ACTIONS) {
    const token = values[action.id]
    if (!token || token === 'key.keyboard.unknown') continue
    map.set(token, [...(map.get(token) || []), action.id])
  }
  return map
}

function keyState(actions: string[] | undefined): 'unused' | 'bound' | 'shared' {
  if (!actions || actions.length === 0) return 'unused'
  return actions.length > 1 ? 'shared' : 'bound'
}

function overlayKeyLabel(key: KeyboardKey): string {
  return key.label
}

export function KeybindsPanel({
  lang,
  values,
  onSet,
  onClear,
  onResetAll,
  isCustom,
  layout,
  onLayoutChange,
  note,
  footer,
}: KeybindsPanelProps) {
  const activeLayout = useMemo(() => keyboardLayout(layout), [layout])
  const availableTokens = useMemo(() => layoutTokens(activeLayout), [activeLayout])
  const boardColumns = useMemo(() => {
    let max = 0
    for (const row of activeLayout.rows) {
      for (const key of row) {
        const right = (key.col ?? 0) + (key.width ?? 1)
        if (right > max) max = right
      }
    }
    return max
  }, [activeLayout])
  const boardRef = useRef<HTMLDivElement>(null)
  const [unit, setUnit] = useState(KEY_UNIT)

  useEffect(() => {
    const element = boardRef.current
    if (!element) return
    const fit = () => {
      const available = element.clientWidth - 32
      if (available <= 0 || boardColumns <= 0) return
      const next = Math.floor((available - (boardColumns - 1) * KEY_GAP) / boardColumns)
      setUnit(Math.max(KEY_MIN_UNIT, Math.min(KEY_UNIT, next)))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [boardColumns])

  const boardWidth = boardColumns * unit + (boardColumns - 1) * KEY_GAP
  const [search, setSearch] = useState('')
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const [hoveredToken, setHoveredToken] = useState<string | null>(null)
  const [selectedToken, setSelectedToken] = useState<string | null>(null)

  const conflicts = useMemo(() => keybindConflicts(values), [values])
  const byToken = useMemo(() => tokenActions(values), [values])
  const boundCount = ALL_KEYBIND_ACTIONS.filter((action) => {
    const token = values[action.id]
    return !!token && token !== 'key.keyboard.unknown'
  }).length
  const sharedKeys = [...byToken.values()].filter((actions) => actions.length > 1).length

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return KEYBIND_GROUPS
    return KEYBIND_GROUPS.map((group) => ({
      ...group,
      actions: group.actions.filter((action) =>
        `${action.label.de} ${action.label.en} ${action.id} ${formatKeyToken(values[action.id], lang)}`
          .toLocaleLowerCase()
          .includes(query),
      ),
    })).filter((group) => group.actions.length > 0)
  }, [search, values, lang])

  const offLayoutCount = ALL_KEYBIND_ACTIONS.filter((action) => {
    const token = values[action.id]
    return !!token && token !== 'key.keyboard.unknown' && !availableTokens.has(token)
  }).length

  const hoveredActions = hoveredToken ? byToken.get(hoveredToken) || [] : []
  const hoveredLabel = hoveredToken ? formatKeyToken(hoveredToken, lang) : ''
  const selectedActions = selectedToken ? byToken.get(selectedToken) || [] : []

  return (
    <div className="flex flex-col gap-4">
      {recording && (
        <KeyRecorder
          recording={recording}
          lang={lang}
          values={values}
          onCancel={() => setRecording(null)}
          onPick={(token) => {
            onSet(recording.actionId, token)
            setRecording(null)
          }}
          onClear={() => {
            onClear(recording.actionId)
            setRecording(null)
          }}
        />
      )}

      {note && (
        <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-info/20 bg-info/8 px-3 py-2.5 text-mini leading-5 text-ink-secondary">
          <Keyboard className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <span>{note}</span>
        </div>
      )}

      <section className="overflow-hidden rounded-[var(--r-xl)] border border-stroke bg-root/45">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-4 py-3">
          <div>
            <h3 className="m-0 flex items-center gap-2 text-small font-medium text-ink">
              <Keyboard className="h-4 w-4 text-accent" />
              {t(lang, 'Tastatur', 'Keyboard')}
            </h3>
            <p className="m-0 mt-0.5 text-mini text-ink-secondary">
              {t(
                lang,
                'Fahre über eine Taste für Details. Klicke sie an, um alle Aktionen zu bearbeiten.',
                'Hover a key to inspect it. Click a key to edit all of its actions.',
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-micro text-ink-tertiary">
              {t(lang, 'Layout', 'Layout')}
            </span>
            <Segmented<KeyboardLayoutId>
              value={activeLayout.id}
              onChange={onLayoutChange}
              size="sm"
              options={KEYBOARD_LAYOUTS.map((entry) => ({
                value: entry.id,
                label: entry.label[lang],
              }))}
            />
            <span className="w-full text-right text-micro text-ink-quaternary sm:w-auto">
              {activeLayout.description[lang]}
            </span>
          </div>
        </header>

        <div ref={boardRef} className="overflow-x-auto px-4 pb-3 pt-4">
          <div className="flex w-fit flex-col gap-[5px]">
            {activeLayout.rows.map((row, rowIndex) => {
              let cursor = 0
              return (
              <div key={rowIndex} className="relative h-[30px]" style={{ width: boardWidth }}>
                {row.map((key) => {
                  const span = key.width ?? 1
                  const col = key.col ?? cursor
                  cursor = col + span
                  const actions = key.token ? byToken.get(key.token) : undefined
                  const state = keyState(actions)
                  const selected = !!key.token && key.token === selectedToken
                  const conflict = !!key.token && !!conflicts.get(actions?.[0] || '')
                  return (
                    <button
                      key={key.id}
                      type="button"
                      title={key.token ? formatKeyToken(key.token, lang) : key.label}
                      onMouseEnter={() => key.token && setHoveredToken(key.token)}
                      onMouseLeave={() => setHoveredToken(null)}
                      onFocus={() => key.token && setHoveredToken(key.token)}
                      onBlur={() => setHoveredToken(null)}
                      onClick={() => {
                        if (key.token) setSelectedToken(key.token === selectedToken ? null : key.token)
                      }}
                      className={cx(
                        'relative flex h-[30px] shrink-0 items-center justify-center rounded-[5px] border text-[10px] font-medium tracking-tight transition-[background-color,border-color,color,box-shadow] duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none',
                        state === 'unused' && 'border-stroke bg-surface/70 text-ink-tertiary hover:border-stroke-strong hover:text-ink-secondary',
                        state === 'bound' && 'border-success/45 bg-success/12 text-ink hover:border-success/70',
                        state === 'shared' && 'border-danger/55 bg-danger/12 text-danger hover:border-danger/80',
                        conflict && 'ring-1 ring-danger/40',
                        selected && 'ring-2 ring-accent/70 ring-offset-1 ring-offset-[var(--bg-root)]',
                      )}
                      style={{
                        position: 'absolute',
                        left: col * (unit + KEY_GAP),
                        top: 0,
                        height: '100%',
                        width: span * unit + (span - 1) * KEY_GAP,
                      }}
                    >
                      <span className="px-0.5">{overlayKeyLabel(key)}</span>
                      {state !== 'unused' && (
                        <span
                          className={cx(
                            'absolute right-1 top-1 h-1 w-1 rounded-full',
                            state === 'shared' ? 'bg-danger' : 'bg-success',
                          )}
                        />
                      )}
                    </button>
                  )
                })}
              </div>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3 text-micro text-ink-tertiary">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-success" />
              {t(lang, 'Belegt', 'Bound')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-danger" />
              {t(lang, 'Geteilt / Konflikt', 'Shared / conflict')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-stroke-strong" />
              {t(lang, 'Unbenutzt', 'Unused')}
            </span>
          </div>
          <div className="text-micro text-ink-tertiary">
            {sharedKeys > 0 ? (
              <span className="text-danger">
                {t(
                  lang,
                  `${sharedKeys} Tasten mehrfach belegt`,
                  `${sharedKeys} shared keys across all controls`,
                )}
              </span>
            ) : (
              <span className="text-success">{t(lang, 'Keine Konflikte', 'No conflicts')}</span>
            )}
            <span className="mx-1.5 text-ink-quaternary">·</span>
            {activeLayout.label[lang]} · {activeLayout.description[lang]}
            {offLayoutCount > 0 && (
              <>
                <span className="mx-1.5 text-ink-quaternary">·</span>
                <span
                  className="text-warning"
                  title={t(
                    lang,
                    'Diese Aktionen sind auf Tasten gelegt, die es auf dem gewählten Layout nicht gibt.',
                    'These actions use keys that do not exist on the selected layout.',
                  )}
                >
                  {t(lang, `${offLayoutCount} außerhalb des Layouts`, `${offLayoutCount} outside this layout`)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="min-h-[46px] border-t border-hairline bg-root/30 px-4 py-2">
          {selectedToken ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-micro text-accent">{formatKeyToken(selectedToken, lang)}</span>
              <span className="text-micro text-ink-tertiary">
                {selectedActions.length === 0
                  ? t(lang, 'Keine Aktion zugewiesen', 'No action assigned')
                  : t(
                      lang,
                      `${selectedActions.length} Aktion${selectedActions.length === 1 ? '' : 'en'}`,
                      `${selectedActions.length} action${selectedActions.length === 1 ? '' : 's'}`,
                    )}
              </span>
              {selectedActions.map((id) => {
                const action = actionById(id)
                if (!action) return null
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-md border border-stroke bg-surface px-1.5 py-0.5 text-micro text-ink"
                  >
                    {action.label[lang]}
                    <button
                      type="button"
                      aria-label={t(lang, 'Aktion entfernen', 'Remove action')}
                      onClick={() => onClear(action.id)}
                      className="text-ink-tertiary hover:text-danger cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )
              })}
              {selectedActions.length === 0 && (
                <select
                  aria-label={t(lang, 'Aktion zuweisen', 'Assign action')}
                  defaultValue=""
                  onChange={(event) => {
                    if (!event.target.value || !selectedToken) return
                    onSet(event.target.value, selectedToken)
                    event.target.value = ''
                  }}
                  className="h-6 rounded-md border border-stroke bg-root/60 px-1.5 text-micro text-ink outline-none"
                >
                  <option value="">{t(lang, 'Aktion zuweisen …', 'Assign action …')}</option>
                  {KEYBIND_GROUPS.map((group) => (
                    <optgroup key={group.id} label={group.label[lang]}>
                      {group.actions.map((action) => (
                        <option key={action.id} value={action.id}>
                          {action.label[lang]}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => setSelectedToken(null)}
                className="ml-auto text-micro text-ink-tertiary hover:text-ink cursor-pointer"
              >
                {t(lang, 'Schließen', 'Close')}
              </button>
            </div>
          ) : hoveredToken ? (
            <div className="flex flex-wrap items-center gap-2 text-micro">
              <span className="font-mono text-ink">{hoveredLabel}</span>
              {hoveredActions.length > 0 ? (
                <>
                  <span className="text-ink-quaternary">→</span>
                  {hoveredActions.map((id) => (
                    <span key={id} className="text-ink-secondary">
                      {actionById(id)?.label[lang]}
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-ink-tertiary">
                  {t(lang, 'Nicht belegt', 'Not bound')}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-micro text-ink-quaternary">
              <MousePointer2 className="h-3.5 w-3.5" />
              {t(
                lang,
                'Taste auswählen, um ihre Aktionen zu sehen und zu ändern.',
                'Select a key to inspect and edit its actions.',
              )}
            </div>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-[var(--r-xl)] border border-stroke bg-surface/65">
        <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h3 className="m-0 text-small font-medium text-ink">
              {t(lang, 'Aktionen', 'Actions')}{' '}
              <span className="font-normal text-ink-tertiary">
                {boundCount}/{ALL_KEYBIND_ACTIONS.length}
              </span>
            </h3>
            <p className="m-0 mt-0.5 text-mini text-ink-secondary">
              {t(
                lang,
                'Klicke auf eine Taste, um sie neu zu belegen.',
                'Click a key to rebind the action.',
              )}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-quaternary" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(lang, 'Aktionen suchen …', 'Search actions …')}
                className="h-7 w-44 rounded-lg border border-stroke bg-root/50 pl-7 pr-2 text-micro text-ink outline-none placeholder:text-ink-quaternary focus:border-accent/50"
              />
            </div>
            <ConfirmButton
              onConfirm={onResetAll}
              confirmLabel={t(lang, 'Wirklich?', 'Really?')}
              variant="secondary"
              icon={<RotateCcw className="h-3 w-3" />}
            >
              {t(lang, 'Vanilla', 'Vanilla')}
            </ConfirmButton>
          </div>
        </header>

        <div className="divide-y divide-hairline">
          {filteredGroups.length === 0 && (
            <p className="px-4 py-8 text-center text-mini text-ink-tertiary">
              {t(lang, 'Keine Aktionen gefunden.', 'No actions found.')}
            </p>
          )}
          {filteredGroups.map((group) => (
            <div key={group.id} className="px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-micro font-medium uppercase tracking-label text-ink-tertiary">
                  {group.label[lang]}
                </span>
                <div className="h-px flex-1 bg-hairline" />
              </div>
              <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
                {group.actions.map((action) => {
                  const token = values[action.id]
                  const conflict = conflicts.get(action.id)
                  const custom = isCustom?.(action.id) ?? token !== DEFAULT_KEYBINDS[action.id]
                  const offLayout = !!token && token !== 'key.keyboard.unknown' && !availableTokens.has(token)
                  return (
                    <div
                      key={action.id}
                      className="group flex h-9 items-center gap-2 border-b border-hairline/60 last:border-b-0 lg:[&:nth-last-child(2)]:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-mini text-ink-secondary">
                        {action.label[lang]}
                      </span>
                      {offLayout && (
                        <span
                          title={t(
                            lang,
                            'Diese Taste gibt es auf dem gewählten Layout nicht – die Bindung bleibt gespeichert.',
                            'This key does not exist on the selected layout – the binding is kept.',
                          )}
                          className="shrink-0 rounded border border-warning/35 bg-warning/10 px-1 text-[10px] font-medium leading-4 text-warning"
                        >
                          {t(lang, 'fehlt', 'missing')}
                        </span>
                      )}
                      {conflict && (
                        <span
                          title={t(
                            lang,
                            `Konflikt mit ${conflict.map((id) => actionById(id)?.label[lang] || id).join(', ')}`,
                            `Conflict with ${conflict.map((id) => actionById(id)?.label[lang] || id).join(', ')}`,
                          )}
                          className="text-danger"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setRecording({ actionId: action.id, label: action.label[lang] })}
                        className={cx(
                          keycapClass(!token),
                          offLayout && 'border-warning/45 text-warning',
                          'hover:border-accent/60 hover:text-accent cursor-pointer',
                        )}
                      >
                        {formatKeyToken(token, lang)}
                      </button>
                      {custom && (
                        <button
                          type="button"
                          title={t(lang, 'Auf Standard zurücksetzen', 'Reset to default')}
                          onClick={() => onClear(action.id)}
                          className="text-ink-quaternary opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {footer}
    </div>
  )
}

function KeyRecorder({
  recording,
  lang,
  values,
  onPick,
  onCancel,
  onClear,
}: {
  recording: RecordingState
  lang: Lang
  values: Record<string, string>
  onPick: (token: string) => void
  onCancel: () => void
  onClear: () => void
}) {
  const [armed, setArmed] = useState(false)
  const [conflictWith, setConflictWith] = useState<string[]>([])
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const onPickRef = useRef(onPick)
  const onClearRef = useRef(onClear)
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onPickRef.current = onPick
    onClearRef.current = onClear
    onCancelRef.current = onCancel
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), 80)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!armed) return

    const keydown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'Escape') {
        onCancelRef.current()
        return
      }
      if (event.code === 'Backspace' || event.code === 'Delete') {
        onClearRef.current()
        return
      }
      const token = keyTokenFromEvent(event)
      if (!token) return
      const usedBy = ALL_KEYBIND_ACTIONS.filter(
        (action) => action.id !== recording.actionId && values[action.id] === token,
      )
      if (usedBy.length > 0) {
        setConflictWith(usedBy.map((action) => action.label[lang]))
        setPendingToken(token)
        return
      }
      onPickRef.current(token)
    }

    const mousedown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('[data-recorder-ui]')) return
      event.preventDefault()
      event.stopPropagation()
      const token = keyTokenFromMouseButton(event.button)
      if (!token) return
      const usedBy = ALL_KEYBIND_ACTIONS.filter(
        (action) => action.id !== recording.actionId && values[action.id] === token,
      )
      if (usedBy.length > 0) {
        setConflictWith(usedBy.map((action) => action.label[lang]))
        setPendingToken(token)
        return
      }
      onPickRef.current(token)
    }

    window.addEventListener('keydown', keydown, true)
    window.addEventListener('mousedown', mousedown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('mousedown', mousedown, true)
    }
  }, [armed, recording.actionId, lang, values])

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        data-recorder-ui
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, 'Taste belegen', 'Assign key')}
        className="w-[360px] rounded-2xl border border-rim bg-surface p-5 shadow-[var(--shadow-palette)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="m-0 text-micro font-medium uppercase tracking-label text-accent">
              {t(lang, 'Taste belegen', 'Assign key')}
            </p>
            <h3 className="m-0 mt-1 text-regular font-semibold text-ink">{recording.label}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-ink-tertiary hover:text-ink cursor-pointer"
            aria-label={t(lang, 'Abbrechen', 'Cancel')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className={cx(
            'mt-4 flex h-24 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed transition-colors',
            armed ? 'border-accent/50 bg-accent/5' : 'border-stroke',
          )}
        >
          <Keyboard className={cx('h-5 w-5', armed ? 'text-accent' : 'text-ink-tertiary')} />
          <p className="m-0 text-mini font-medium text-ink">
            {armed
              ? t(lang, 'Taste oder Maustaste drücken …', 'Press a key or mouse button …')
              : t(lang, 'Bereit …', 'Ready …')}
          </p>
          <p className="m-0 text-micro text-ink-tertiary">
            {t(lang, 'Esc = abbrechen · Entf = nicht belegen', 'Esc = cancel · Delete = unbound')}
          </p>
        </div>

        {conflictWith.length > 0 && (
          <div className="mt-3 rounded-lg border border-danger/25 bg-danger/8 px-2.5 py-2">
            <p className="m-0 flex items-start gap-1.5 text-micro text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(lang, 'Bereits belegt mit: ', 'Already used by: ')}
              {conflictWith.join(', ')}
            </p>
            {pendingToken && (
              <button
                type="button"
                onClick={() => onPick(pendingToken)}
                className="mt-2 inline-flex h-6 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 text-micro font-medium text-danger hover:bg-danger/20 cursor-pointer"
              >
                <Check className="h-3 w-3" />
                {t(lang, 'Trotzdem belegen', 'Use anyway')}
              </button>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              onClear()
            }}
            className="inline-flex items-center gap-1.5 text-micro text-ink-tertiary hover:text-ink cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t(lang, 'Auf Standard zurücksetzen', 'Reset to default')}
          </button>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t(lang, 'Abbrechen', 'Cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
