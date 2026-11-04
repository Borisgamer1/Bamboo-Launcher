import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Crown, Flag, Pencil, Plus, Swords } from 'lucide-react'
import type { SkinSnapshot } from '../../electron'
import type { LanguageType } from '../../lib/translations'
import { CosmeticStage } from './CosmeticStage'
import {
  COSMETIC_ENTRIES,
  cosmeticById,
  cosmeticsForSlot,
  type CosmeticEntry,
  type CosmeticSlot,
  type CosmeticTransform,
} from './cosmeticCatalog'
import { DevTransformEditor } from './DevTransformEditor'

interface Selection {
  hat?: string
  back?: string
  cape?: string
  vanillaCapeId?: string
  vanillaCapeName?: string
  vanillaCapeUrl?: string
}

interface CosmeticsTabProps {
  snapshot: SkinSnapshot | null
  lang: LanguageType
  onOpenAccounts: () => void
  locked?: boolean
}

const SLOT_ICON: Record<CosmeticSlot, React.ComponentType<{ className?: string }>> = {
  hat: Crown,
  back: Swords,
  cape: Flag,
}

const SLOT_LABEL: Record<CosmeticSlot, { de: string; en: string }> = {
  hat: { de: 'Kopf', en: 'Head' },
  back: { de: 'Rücken', en: 'Back' },
  cape: { de: 'Cape', en: 'Cape' },
}

function sanitizeSelection(value: unknown): Selection {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const next: Selection = {}
  if (typeof record.hat === 'string' && cosmeticById(record.hat)) next.hat = record.hat
  if (typeof record.back === 'string' && cosmeticById(record.back)) next.back = record.back
  if (typeof record.cape === 'string' && cosmeticById(record.cape)) next.cape = record.cape
  if (typeof record.vanillaCapeId === 'string') next.vanillaCapeId = record.vanillaCapeId
  if (typeof record.vanillaCapeName === 'string') next.vanillaCapeName = record.vanillaCapeName
  if (typeof record.vanillaCapeUrl === 'string') next.vanillaCapeUrl = record.vanillaCapeUrl
  return next
}

const Row: React.FC<{
  name: string
  detail: string
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  thumbnail?: string
  onSelect: () => void
  onEdit?: () => void
}> = ({ name, detail, active, icon: Icon, thumbnail, onSelect, onEdit }) => (
  <div className="group relative">
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={active}
    className={`group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
      active ? 'bg-accent/[0.07]' : 'hover:bg-hover'
    }`}
  >
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border ${
        active ? 'border-accent/40 bg-accent/[0.08]' : 'border-hairline bg-root/60'
      }`}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          style={{ imageRendering: 'pixelated', objectPosition: 'left top' }}
        />
      ) : (
        <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-ink-secondary'}`} />
      )}
    </span>

    <span className="min-w-0 flex-1">
      <span className="block truncate text-small text-ink">{name}</span>
      <span className="mt-0.5 block truncate text-micro text-ink-tertiary">{detail}</span>
    </span>

    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
        active ? 'border-accent/50 bg-accent text-root' : 'border-hairline text-ink-quaternary'
      }`}
      aria-hidden
    >
      {active ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
    </span>
  </button>
  {onEdit ? (
    <button
      type="button"
      onClick={onEdit}
      className="absolute right-9 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-quaternary opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-label={`${name} bearbeiten`}
      title="Transform bearbeiten"
    >
      <Pencil className="h-3 w-3" aria-hidden />
    </button>
  ) : null}
  </div>
)

const GroupLabel: React.FC<{ label: string; hint?: string }> = ({ label, hint }) => (
  <div className="flex items-center gap-2 px-2.5 pb-1 pt-0.5">
    <span className="h-1 w-1 rounded-full bg-ink-quaternary" aria-hidden />
    <span className="text-micro text-ink-tertiary">{label}</span>
    {hint ? <span className="text-micro text-ink-quaternary">· {hint}</span> : null}
  </div>
)

export const CosmeticsTab: React.FC<CosmeticsTabProps> = ({ snapshot, lang, onOpenAccounts, locked = false }) => {
  const de = lang === 'de'
  const dev = import.meta.env.DEV
  const [selection, setSelection] = useState<Selection>({})
  const [loaded, setLoaded] = useState(false)
  const [transforms, setTransforms] = useState<Record<string, CosmeticTransform>>(() =>
    Object.fromEntries(COSMETIC_ENTRIES.map((entry) => [entry.id, entry.transform])),
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dirtyId, setDirtyId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    const api = window.electronAPI?.cosmetics
    let cancelled = false
    if (!api) {
      setLoaded(true)
      return
    }
    api
      .selection()
      .then((next) => {
        if (!cancelled) setSelection(sanitizeSelection(next))
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loaded || locked) return
    const api = window.electronAPI?.cosmetics
    if (!api) return
    const timer = setTimeout(() => {
      void api.saveSelection(selection).catch(() => undefined)
    }, 150)
    return () => clearTimeout(timer)
  }, [loaded, selection, locked])

  const update = useCallback((patch: Partial<Selection>) => {
    setSelection((current) => ({ ...current, ...patch }))
  }, [])

  const placed = useCallback(
    (entry: CosmeticEntry): CosmeticEntry => {
      const transform = transforms[entry.id]
      return transform ? { ...entry, transform } : entry
    },
    [transforms],
  )

  const customCapes = cosmeticsForSlot('cape')
  const selectedCustomCape = cosmeticById(selection.cape)
  const cosmetics = useMemo(() => {
    // Every cape goes through the cosmetic mesh path, including texture-only
    // ones: the catalog gives those the generated vanilla shape, so position,
    // rotation and scale mean the same thing here as they do in game.
    const entries = [
      cosmeticById(selection.hat),
      cosmeticById(selection.back),
      selectedCustomCape,
    ].filter((entry): entry is CosmeticEntry => Boolean(entry))
    return entries.map(placed)
  }, [selection.hat, selection.back, selectedCustomCape, placed])

    const vanillaCapes = snapshot?.capes ?? []
  const selectedVanillaCape = selection.vanillaCapeId
    ? vanillaCapes.find((cape) => cape.id === selection.vanillaCapeId)
    : undefined
  // Only a Mojang cape uses the fixed vanilla sheet. Custom capes are meshes
  // in `cosmetics` above, so the movement controls apply to them too. A
  // custom cape wins, matching the bundle writer's precedence.
  // If no custom cape is selected and no vanilla cape is explicitly chosen,
  // ensure capeUrl is null so no cape is displayed (fixes: cape always shows when nothing selected)
  const explicitCapeUrl = selectedCustomCape ? null : (selectedVanillaCape?.url ?? null)
  const capeUrl = selection.cape || selection.vanillaCapeId ? explicitCapeUrl : null

  const toggle = (entry: CosmeticEntry) => {
    if (entry.slot === 'cape') {
      // When toggling a cape, remove any back cosmetic (mutual exclusion)
      // Also preserve the "toggle off" behavior: if the same cape is already selected, deselect it
      const current = selection.cape
      const next = current === entry.id ? undefined : entry.id
      update({ cape: next, back: next ? undefined : selection.back, vanillaCapeId: next ? undefined : selection.vanillaCapeId })
      if (dev) {
        setEditingId(next ?? null)
        setSaveState('idle')
      }
      return
    }
    // When toggling a back cosmetic, remove any cape (mutual exclusion)
    // Also preserve the "toggle off" behavior: if the same back is already selected, deselect it
    const current = selection[entry.slot]
    const next = current === entry.id ? undefined : entry.id
    update({ [entry.slot]: next, cape: next ? undefined : selection.cape } as Partial<Selection>)
    if (dev) {
      setEditingId(next ?? null)
      setSaveState('idle')
    }
  }

  const toggleVanillaCape = (cape: { id: string; name: string; url: string }) => {
    const active = selection.vanillaCapeId === cape.id
    if (active) {
      update({
        vanillaCapeId: undefined,
        vanillaCapeName: undefined,
        vanillaCapeUrl: undefined,
      })
      return
    }
    update({
      vanillaCapeId: cape.id,
      vanillaCapeName: cape.name,
      vanillaCapeUrl: cape.url,
      cape: undefined,
      back: undefined,
    })
  }

  const editorEntry = cosmeticById(editingId ?? selection.hat ?? selection.back ?? selection.cape)
  const editorTransform = editorEntry ? transforms[editorEntry.id] ?? editorEntry.transform : null

  const updateTransform = (patch: Partial<CosmeticTransform>) => {
    if (!editorEntry) return
    setTransforms((current) => ({
      ...current,
      [editorEntry.id]: { ...(current[editorEntry.id] ?? editorEntry.transform), ...patch },
    }))
    setDirtyId(editorEntry.id)
  }

  useEffect(() => {
    if (!dev || !dirtyId) return
    const api = window.electronAPI?.cosmetics
    const transform = transforms[dirtyId]
    if (!api || !transform) return
    setSaveState('saving')
    const timer = setTimeout(() => {
      api
        .saveTransform({ id: dirtyId, ...transform })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'))
    }, 400)
    return () => clearTimeout(timer)
  }, [dev, dirtyId, transforms])

  const variant = snapshot?.skin.variant ?? 'classic'
  const skinUrl = snapshot?.skin.url ?? null

  return (
    <div className="mt-6 grid items-start gap-6 lg:grid-cols-[288px_minmax(0,1fr)]">
      <aside className="min-w-0 self-start lg:sticky lg:top-6">
        <section className="overflow-hidden rounded-[14px] border border-hairline bg-surface">
          <CosmeticStage
            skinUrl={skinUrl}
            variant={variant}
            equipped={cosmetics}
            capeUrl={capeUrl}
            lang={lang}
          />
        </section>
        {dev && editorEntry && editorTransform ? (
          <DevTransformEditor
            entry={editorEntry}
            transform={editorTransform}
            saveState={saveState}
            lang={lang}
            onChange={updateTransform}
            onReset={() => {
              updateTransform({
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              })
            }}
          />
        ) : null}
        <p className="m-0 mt-2 px-1 text-micro leading-4 text-ink-quaternary">
          {de
            ? 'Die Vorschau zeigt genau das Bundle, das auch im Spiel gelesen wird.'
            : 'The preview shows the same bundle the game reads.'}
        </p>
      </aside>

      <div className="flex min-w-0 flex-col gap-5">
        <section className="rounded-[14px] border border-hairline bg-surface">
          <header className="flex items-baseline justify-between gap-4 px-5 pb-2 pt-4">
            <h2 className="m-0 text-title3 font-medium text-ink">Capes</h2>
            <span className="text-micro tabular-nums text-ink-quaternary">
              {vanillaCapes.length + customCapes.length}
            </span>
          </header>

          <div className="border-t border-hairline px-2.5 pb-1.5 pt-1.5">
            <GroupLabel
              label={de ? 'Vanilla' : 'Vanilla'}
              hint={de ? 'über dein Minecraft-Konto' : 'through your Minecraft account'}
            />
            {snapshot?.account ? (
              vanillaCapes.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {vanillaCapes.map((cape) => (
                    <Row
                      key={cape.id}
                      name={cape.name}
                      // The bundled selection is what the game wears, not the
                      // cape the Mojang account happens to have equipped.
                      detail={de ? 'Mojang-Cape' : 'Mojang cape'}
                      active={selection.vanillaCapeId === cape.id}
                      icon={Flag}
                      thumbnail={cape.url}
                      onSelect={() => toggleVanillaCape(cape)}
                    />
                  ))}
                </div>
              ) : (
                <p className="m-0 px-2.5 pb-1 text-micro leading-5 text-ink-tertiary">
                  {de
                    ? 'Dieses Konto besitzt keine Vanilla-Capes.'
                    : 'This account owns no vanilla capes.'}
                </p>
              )
            ) : (
              <div className="flex items-center justify-between gap-3 px-2.5 pb-1">
                <p className="m-0 text-micro leading-5 text-ink-tertiary">
                  {de
                    ? 'Verbinde dein Microsoft-Konto, um deine Vanilla-Capes zu sehen.'
                    : 'Connect your Microsoft account to see your vanilla capes.'}
                </p>
                <button
                  type="button"
                  onClick={onOpenAccounts}
                  className="shrink-0 text-micro font-medium text-accent hover:underline"
                >
                  {de ? 'Verbinden' : 'Connect'}
                </button>
              </div>
            )}
          </div>

          <div className="border-t border-hairline px-2.5 py-1.5">
            <GroupLabel label={de ? 'Custom' : 'Custom'} hint={de ? 'aus deinem Bundle' : 'from your bundle'} />
            {customCapes.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {customCapes.map((entry) => (
                  <Row
                    key={entry.id}
                    name={entry.name}
                    detail={SLOT_LABEL[entry.slot][de ? 'de' : 'en']}
                    active={selection.cape === entry.id}
                    icon={SLOT_ICON[entry.slot]}
                    thumbnail={entry.atlasUrl}
                    onSelect={() => toggle(entry)}
                    onEdit={
                      dev
                        ? () => {
                            update({ cape: entry.id, vanillaCapeId: undefined })
                            setEditingId(entry.id)
                            setSaveState('idle')
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="m-0 px-2.5 pb-1 text-micro leading-5 text-ink-tertiary">
                {de ? 'Noch keine Custom-Capes im Bundle.' : 'No custom capes in the bundle yet.'}
              </p>
            )}
          </div>
        </section>

        <section className="rounded-[14px] border border-hairline bg-surface">
          <header className="flex items-baseline justify-between gap-4 px-5 pb-2 pt-4">
            <h2 className="m-0 text-title3 font-medium text-ink">Cosmetics</h2>
            <span className="text-micro tabular-nums text-ink-quaternary">
              {cosmeticsForSlot('hat').length + cosmeticsForSlot('back').length}
            </span>
          </header>
          <div className="border-t border-hairline px-2.5 py-2">
            {(['hat', 'back'] as const).map((slot) => {
              const entries = cosmeticsForSlot(slot)
              if (entries.length === 0) return null
              return (
                <div key={slot} className="pb-1">
                  <GroupLabel label={SLOT_LABEL[slot][de ? 'de' : 'en']} />
                  <div className="flex flex-col gap-0.5">
                    {entries.map((entry) => (
                      <Row
                        key={entry.id}
                        name={entry.name}
                        detail={
                          de
                            ? `${SLOT_LABEL[entry.slot].de} · ${entry.cubes} Teile`
                            : `${SLOT_LABEL[entry.slot].en} · ${entry.cubes} parts`
                        }
                        active={selection[entry.slot] === entry.id}
                        icon={SLOT_ICON[entry.slot]}
                        onSelect={() => toggle(entry)}
                        onEdit={
                          dev
                            ? () => {
                                if (entry.slot !== 'cape') {
                                  update({ [entry.slot]: entry.id } as Partial<Selection>)
                                }
                                setEditingId(entry.id)
                                setSaveState('idle')
                              }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
              )
            })}
            {cosmeticsForSlot('hat').length + cosmeticsForSlot('back').length === 0 ? (
              <p className="m-0 px-2.5 py-1 text-micro leading-5 text-ink-tertiary">
                {de ? 'Noch keine Cosmetics im Bundle.' : 'No cosmetics in the bundle yet.'}
              </p>
            ) : null}
          </div>
        </section>

        <p className="m-0 px-1 text-micro leading-4 text-ink-quaternary">
          {de
            ? 'Ausrüsten ändert im Moment nur die Vorschau. Was im Spiel getragen wird, entscheidest du im nächsten Schritt.'
            : 'Equipping only changes the preview for now. What the game wears is the next step.'}
        </p>
      </div>
    </div>
  )
}
