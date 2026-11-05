import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  Backpack,
  Check,
  Crown,
  Download,
  Flag,
  Loader2,
  Package,
  RefreshCw,
  Store,
  Trash2,
} from 'lucide-react'
import type {
  CosmeticPreview,
  CosmeticSlot,
  CosmeticSyncStatus,
  InstalledCosmetic,
  ShopCatalog,
  ShopItem,
  SkinSnapshot,
} from '../../electron'
import type { LanguageType } from '../../lib/translations'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { useToast } from '../Toast'
import { CosmeticStage } from './CosmeticStage'

interface CosmeticsTabProps {
  snapshot: SkinSnapshot | null
  lang: LanguageType
  /** Reloads the page-level skin snapshot; the tab only owns the package lists. */
  onRefresh?: () => Promise<void>
}

type Selection = { kind: 'installed'; file: string } | { kind: 'shop'; id: string }

const PRIMARY =
  'inline-flex h-9 items-center justify-center gap-2 rounded-[8px] bg-ink px-3 text-small font-medium text-root transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
const QUIET =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] px-2 text-micro font-medium text-ink-tertiary transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
const PANEL = 'rounded-[16px] border border-hairline bg-surface'

const RARITY_COLOR: Record<string, string> = {
  Common: '#9BAAA1',
  Uncommon: '#7FD9A0',
  Rare: '#7EC2E8',
  Epic: '#E8A56A',
  Legendary: '#E6C15C',
}

const SLOT_ICON: Record<CosmeticSlot, React.ComponentType<{ className?: string }>> = {
  head: Crown,
  back: Backpack,
  cape: Flag,
}

function slotOf(slots: CosmeticSlot[]): CosmeticSlot {
  if (slots.includes('head')) return 'head'
  if (slots.includes('cape')) return 'cape'
  return 'back'
}

function slotLabel(slots: CosmeticSlot[], de: boolean): string {
  const slot = slotOf(slots)
  if (slot === 'head') return de ? 'Kopf' : 'Head'
  if (slot === 'cape') return 'Cape'
  return de ? 'Rücken' : 'Back'
}

/** Rarity already means something, so it keeps its colour - one dot, never a badge. */
const Rarity: React.FC<{ rarity: string }> = ({ rarity }) => (
  <span className="inline-flex shrink-0 items-center gap-1.5 text-micro text-ink-tertiary">
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: RARITY_COLOR[rarity] ?? RARITY_COLOR.Common }}
      aria-hidden
    />
    {rarity}
  </span>
)

const SlotTile: React.FC<{ slots: CosmeticSlot[]; active?: boolean; className?: string }> = ({
  slots,
  active,
  className = 'h-9 w-9',
}) => {
  const Icon = SLOT_ICON[slotOf(slots)]
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[6px] border ${className} ${
        active ? 'border-accent/40 bg-accent/[0.08]' : 'border-hairline bg-root/40'
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-ink-quaternary'}`} />
    </span>
  )
}

/** Package artwork: the portrait plate is the product's real material, so it carries the list. */
const Artwork: React.FC<{
  image: string | null
  slots: CosmeticSlot[]
  active?: boolean
  className?: string
}> = ({ image, slots, active, className = 'h-[68px] w-[42px]' }) =>
  image ? (
    <span
      className={`shrink-0 overflow-hidden rounded-[6px] border ${
        active ? 'border-accent/40' : 'border-hairline'
      } ${className}`}
    >
      <img
        src={image}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
        draggable={false}
      />
    </span>
  ) : (
    <SlotTile slots={slots} active={active} className={`${className} rounded-[6px]`} />
  )

export const CosmeticsTab: React.FC<CosmeticsTabProps> = ({ snapshot, lang, onRefresh }) => {
  const de = lang === 'de'
  const api = window.electronAPI?.cosmetics
  const deleteTitleId = useId()
  const { addToast } = useToast()
  const [mode, setMode] = useState<'installed' | 'shop'>('installed')
  const [installed, setInstalled] = useState<InstalledCosmetic[]>([])
  const [shop, setShop] = useState<ShopCatalog | null>(null)
  const [shopError, setShopError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [previewState, setPreviewState] = useState<{
    key: string
    preview: CosmeticPreview | null
    error: string | null
  } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InstalledCosmetic | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sync, setSync] = useState<CosmeticSyncStatus | null>(null)

  const selectionKey = selection
    ? selection.kind === 'installed'
      ? `installed:${selection.file}`
      : `shop:${selection.id}`
    : ''
  const preview = previewState?.key === selectionKey ? previewState.preview : null
  const previewError = previewState?.key === selectionKey ? previewState.error : null
  const shopLoading = mode === 'shop' && !shop && !shopError

  const applyList = useCallback((list: InstalledCosmetic[]) => {
    setInstalled(list)
    setSelection((current) =>
      current?.kind === 'installed' && list.some((entry) => entry.file === current.file)
        ? current
        : list[0]
          ? { kind: 'installed', file: list[0].file }
          : null,
    )
  }, [])

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api
      .list()
      .then((list) => {
        if (!cancelled) applyList(list ?? [])
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api, applyList])

  // Loaded up front: the shop artwork is also what makes the library scannable.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    api
      .shop()
      .then((catalog) => {
        if (!cancelled) setShop(catalog ?? { items: [], source: 'local' })
      })
      .catch((cause) => {
        if (!cancelled) setShopError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Local state only: which instances have the mod and a readable sync.json.
  useEffect(() => {
    if (!api) return
    let cancelled = false
    api
      .syncStatus()
      .then((value) => {
        if (cancelled) return
        setSync(value ?? null)
      })
      .catch(() => {
        if (!cancelled) setSync(null)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    if (!api || !selection) return
    let cancelled = false
    const key = selectionKey
    const request =
      selection.kind === 'installed'
        ? api.preview({ file: selection.file })
        : api.shopPreview(selection.id)
    request
      .then((result) => {
        if (!cancelled) setPreviewState({ key, preview: result ?? null, error: null })
      })
      .catch((cause) => {
        if (!cancelled) {
          setPreviewState({
            key,
            preview: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, selection, selectionKey])

  const installedItem =
    selection?.kind === 'installed'
      ? installed.find((entry) => entry.file === selection.file) ?? null
      : null
  const shopItem =
    selection?.kind === 'shop' ? shop?.items.find((entry) => entry.id === selection.id) ?? null : null
  const activeName = installedItem?.name ?? shopItem?.name ?? null
  const activeRarity = installedItem?.rarity ?? shopItem?.rarity ?? 'Common'
  const activeSlots = installedItem?.slots ?? shopItem?.slots ?? (['back'] as CosmeticSlot[])
  const activeCreator = installedItem?.creator ?? shopItem?.creator ?? ''
  const activeDescription = installedItem?.description ?? shopItem?.description ?? ''
  const activeBytes = installedItem?.bytes ?? null

  const imageByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of shop?.items ?? []) {
      if (item.image) map.set(item.name.toLowerCase(), item.image)
    }
    return map
  }, [shop])
  const installedNames = useMemo(
    () => new Set(installed.map((entry) => entry.name.toLowerCase())),
    [installed],
  )

  const install = async (item: ShopItem) => {
    if (!api || busy) return
    setBusy(`install:${item.id}`)
    setError(null)
    try {
      const list = await api.install({ id: item.id })
      const next = list ?? []
      setInstalled(next)
      const file = next.find((entry) => entry.name.toLowerCase() === item.name.toLowerCase())?.file
      addToast({
        type: 'success',
        message: de ? `${item.name} installiert.` : `${item.name} installed.`,
      })
      if (file) setSelection({ kind: 'installed', file })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = async () => {
    if (!api || !deleteTarget) return
    setBusy(`remove:${deleteTarget.file}`)
    setError(null)
    try {
      const list = await api.remove({ file: deleteTarget.file })
      applyList(list ?? [])
      addToast({
        type: 'success',
        message: de ? `${deleteTarget.name} gelöscht.` : `${deleteTarget.name} deleted.`,
      })
      setDeleteTarget(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    if (!api) return
    setBusy('refresh')
    setError(null)
    try {
      await onRefresh?.()
      applyList((await api.list()) ?? [])
      setShop((await api.shop()) ?? { items: [], source: 'local' })
      setShopError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!api) {
    return (
      <p className={`m-0 mt-6 px-5 py-6 text-mini text-ink-tertiary ${PANEL}`}>
        {de ? 'Die Cosmetic-Brücke ist nicht verfügbar.' : 'The cosmetic bridge is not available.'}
      </p>
    )
  }

  const total = sync?.instances.total ?? 0
  const ready = sync?.instances.ready ?? 0
  const syncText =
    sync === null
      ? de
        ? 'Sync-Status nicht lesbar'
        : 'Sync status unreadable'
      : !sync.configured
        ? de
          ? 'Kein Supabase-Projekt in diesem Build'
          : 'This build ships no Supabase project'
        : ready === 0
          ? de
            ? 'Eingerichtet · noch keine Instanz bereit'
            : 'Set up · no instance ready yet'
          : de
            ? `Bereit in ${ready} von ${total} Instanzen`
            : `Ready in ${ready} of ${total} instances`
  const syncDetail =
    sync?.configured && sync.instances.missingMod > 0
      ? de
        ? `${sync.instances.missingMod} Instanz(en) ohne Mod-Jar`
        : `${sync.instances.missingMod} instance(s) without the mod jar`
      : null

  return (
    <>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* The wardrobe mirror: the one place this tab gets material and light. */}
        <aside className="min-w-0 lg:sticky lg:top-6">
          <section className={PANEL}>
            <div className="overflow-hidden rounded-t-[16px]">
              <CosmeticStage
                skinUrl={snapshot?.skin.url ?? null}
                variant={snapshot?.skin.variant ?? 'classic'}
                preview={preview}
                capeUrl={snapshot?.capes.find((cape) => cape.active)?.url ?? null}
                lang={lang}
              />
            </div>

            <div className="p-4">
              {selection ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="m-0 min-w-0 truncate text-title3 font-medium text-ink">
                      {activeName ?? (de ? 'Wird geladen' : 'Loading')}
                    </h2>
                    <Rarity rarity={activeRarity} />
                  </div>
                  <p className="m-0 mt-1 truncate text-micro text-ink-quaternary">
                    {[activeCreator, slotLabel(activeSlots, de)]
                      .concat(activeBytes ? `${(activeBytes / 1024).toFixed(0)} KB` : [])
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {previewError ? (
                    <p className="m-0 mt-3 text-micro leading-5 text-danger">{previewError}</p>
                  ) : activeDescription ? (
                    <p className="m-0 mt-3 line-clamp-3 text-mini leading-5 text-ink-secondary">
                      {activeDescription}
                    </p>
                  ) : null}

                  {installedItem ? (
                    <div className="mt-4 flex items-center gap-3 border-t border-hairline pt-3">
                      <button
                        type="button"
                        className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-micro font-medium text-ink-tertiary transition-colors duration-[var(--t-quick)] hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-35"
                        onClick={() => setDeleteTarget(installedItem)}
                        disabled={busy !== null}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        {de ? 'Löschen' : 'Delete'}
                      </button>
                      <p className="m-0 ml-auto truncate text-micro text-ink-quaternary">
                        {de ? 'Im Spiel: Pause → Cosmetics' : 'In game: Pause → Cosmetics'}
                      </p>
                    </div>
                  ) : shopItem ? (
                    <div className="mt-4 border-t border-hairline pt-3">
                      <button
                        type="button"
                        className={`${PRIMARY} w-full`}
                        onClick={() => void install(shopItem)}
                        disabled={busy !== null}
                      >
                        {busy === `install:${shopItem.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Download className="h-3.5 w-3.5" aria-hidden />
                        )}
                        {installedNames.has(shopItem.name.toLowerCase())
                          ? de
                            ? 'Erneut installieren'
                            : 'Install again'
                          : de
                            ? 'Installieren'
                            : 'Install'}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="m-0 text-mini leading-5 text-ink-tertiary">
                  {de
                    ? 'Wähle ein Cosmetic. Die Vorschau zeigt es an deinem Skin.'
                    : 'Pick a cosmetic. The preview shows it on your skin.'}
                </p>
              )}
            </div>
          </section>

          <div className="mt-3 rounded-[12px] border border-hairline px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  sync?.configured && ready > 0 ? 'bg-accent' : 'bg-ink-quaternary/50'
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-micro text-ink-tertiary">
                {syncText}
              </span>
            </div>
            {syncDetail ? (
              <p className="m-0 mt-1 text-micro text-ink-quaternary">{syncDetail}</p>
            ) : null}
            {sync?.configured ? (
              <p className="m-0 mt-1 text-micro leading-4 text-ink-quaternary">
                {de
                  ? 'Projekt kommt mit dem Launcher; bamboo/sync.json wird beim Start jeder Instanz geschrieben.'
                  : 'The project ships with the launcher; bamboo/sync.json is written on every instance start.'}
              </p>
            ) : null}
          </div>
        </aside>

        <section className={`min-w-0 overflow-hidden ${PANEL}`}>
          <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-3">
            <div role="tablist" aria-label="Cosmetics" className="flex items-center gap-1">
              {(
                [
                  {
                    id: 'installed',
                    label: de ? 'Installiert' : 'Installed',
                    count: installed.length,
                  },
                  { id: 'shop', label: 'Shop', count: shop?.items.length },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === entry.id}
                  onClick={() => setMode(entry.id)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-small transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    mode === entry.id
                      ? 'text-ink'
                      : 'text-ink-tertiary hover:bg-hover hover:text-ink-secondary'
                  }`}
                >
                  {entry.label}
                  {typeof entry.count === 'number' ? (
                    <span
                      className={`text-micro tabular-nums ${
                        mode === entry.id ? 'text-accent' : 'text-ink-quaternary'
                      }`}
                    >
                      {entry.count}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span
                className="text-micro text-ink-quaternary"
                title={
                  de
                    ? 'Cosmetics laufen nur mit Minecraft 26.3 (Fabric) und gelten für alle Instanzen.'
                    : 'Cosmetics only run on Minecraft 26.3 (Fabric) and apply to every instance.'
                }
              >
                26.3 Fabric · {de ? 'alle Instanzen' : 'all instances'}
              </span>
              <span className="h-3.5 w-px bg-hairline" aria-hidden />
              <button
                type="button"
                className={QUIET}
                onClick={() => void refresh()}
                disabled={busy !== null}
                aria-label={de ? 'Neu laden' : 'Refresh'}
                title={de ? 'Neu laden' : 'Refresh'}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`}
                  aria-hidden
                />
              </button>
            </div>
          </header>

          {error ? (
            <p role="alert" className="m-0 border-b border-hairline px-4 py-2 text-micro text-danger">
              {error}
            </p>
          ) : null}

          <div className="p-2">
            {mode === 'installed' ? (
              installed.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <Package className="mx-auto h-4 w-4 text-ink-quaternary" aria-hidden />
                  <p className="m-0 mt-3 text-small font-medium text-ink">
                    {de ? 'Noch nichts installiert' : 'Nothing installed yet'}
                  </p>
                  <p className="mx-auto mt-1 max-w-[280px] text-micro leading-5 text-ink-tertiary">
                    {de
                      ? 'Im Shop findest du Pakete, die direkt im Spiel auswählbar sind.'
                      : 'The shop has packages you can pick in game.'}
                  </p>
                  <button type="button" className={`${PRIMARY} mt-5`} onClick={() => setMode('shop')}>
                    <Store className="h-3.5 w-3.5" aria-hidden />
                    {de ? 'Zum Shop' : 'Open shop'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {installed.map((entry) => {
                    const active = selection?.kind === 'installed' && selection.file === entry.file
                    return (
                      <button
                        key={entry.file}
                        type="button"
                        onClick={() => setSelection({ kind: 'installed', file: entry.file })}
                        aria-pressed={active}
                        className={`relative flex w-full items-center gap-3 rounded-[8px] py-2 pl-3 pr-3 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                          active ? 'bg-raised' : 'hover:bg-hover'
                        }`}
                      >
                        <span
                          className={`absolute inset-y-2 left-0 w-0.5 rounded-full ${
                            active ? 'bg-accent' : 'bg-transparent'
                          }`}
                          aria-hidden
                        />
                        <Artwork
                          image={imageByName.get(entry.name.toLowerCase()) ?? null}
                          slots={entry.slots}
                          active={active}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="truncate text-small text-ink">{entry.name}</span>
                            {entry.valid ? null : (
                              <span className="shrink-0 text-micro text-danger">
                                {de ? 'defekt' : 'broken'}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-micro text-ink-quaternary">
                            {entry.rarity} · {slotLabel(entry.slots, de)}
                          </span>
                        </span>
                        <span className="shrink-0 text-micro tabular-nums text-ink-quaternary">
                          {(entry.bytes / 1024).toFixed(0)} KB
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            ) : shopLoading && !shop ? (
              <div className="flex min-h-[240px] items-center justify-center text-ink-tertiary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              </div>
            ) : shop && shop.items.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                {shop.items.map((item) => {
                  const active = selection?.kind === 'shop' && selection.id === item.id
                  const owned = installedNames.has(item.name.toLowerCase())
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelection({ kind: 'shop', id: item.id })}
                      aria-pressed={active}
                      className={`flex items-stretch gap-3 rounded-[8px] border p-2 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                        active
                          ? 'border-accent/40 bg-raised'
                          : 'border-hairline bg-surface/55 hover:border-stroke hover:bg-raised/55'
                      }`}
                    >
                      <Artwork
                        image={item.image}
                        slots={item.slots}
                        active={active}
                        className="h-[116px] w-[72px]"
                      />
                      <span className="flex min-w-0 flex-1 flex-col py-0.5">
                        <span className="flex items-start justify-between gap-2">
                          <span className="line-clamp-2 text-small font-medium text-ink">
                            {item.name}
                          </span>
                          {owned ? (
                            <Check
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent"
                              aria-label={de ? 'Installiert' : 'Installed'}
                            />
                          ) : null}
                        </span>
                        <span className="mt-1 truncate text-micro text-ink-tertiary">
                          {[item.creator, slotLabel(item.slots, de)].filter(Boolean).join(' · ')}
                        </span>
                        <span className="mt-auto flex items-center justify-between gap-2 pt-2">
                          <Rarity rarity={item.rarity} />
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-5 py-14 text-center">
                <Store className="mx-auto h-4 w-4 text-ink-quaternary" aria-hidden />
                <p className="m-0 mt-3 text-small font-medium text-ink">
                  {de ? 'Shop ist leer' : 'Shop is empty'}
                </p>
                <p className="mx-auto mt-1 max-w-[320px] text-micro leading-5 text-ink-tertiary">
                  {shop?.error
                    ? shop.error
                    : de
                      ? 'Der Katalog enthält noch keine Pakete.'
                      : 'The catalog has no packages yet.'}
                </p>
              </div>
            )}
          </div>

          {mode === 'shop' && shop ? (
            <p className="m-0 border-t border-hairline px-4 py-2 text-micro text-ink-quaternary">
              {shop.source === 'remote'
                ? de
                  ? 'Katalog von GitHub'
                  : 'Catalog from GitHub'
                : de
                  ? 'Katalog aus dem Launcher (GitHub nicht erreichbar)'
                  : 'Catalog bundled with the launcher (GitHub unreachable)'}
            </p>
          ) : null}
        </section>
      </div>

      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={de ? 'Cosmetic löschen' : 'Delete cosmetic'}
        titleId={deleteTitleId}
        closeLabel={de ? 'Schließen' : 'Close'}
        tone="danger"
        icon={<Trash2 className="h-4 w-4" />}
        footer={
          <>
            <button
              type="button"
              className={dialogButton.secondary}
              onClick={() => setDeleteTarget(null)}
            >
              {de ? 'Abbrechen' : 'Cancel'}
            </button>
            <button type="button" className={dialogButton.danger} onClick={() => void confirmDelete()}>
              {de ? 'Löschen' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="m-0">
          {de
            ? `„${deleteTarget?.name ?? ''}“ verschwindet aus deiner Sammlung und aus allen Instanzen. Im Spiel ist es danach nicht mehr auswählbar.`
            : `“${deleteTarget?.name ?? ''}” leaves your library and every instance, so it can no longer be picked in game.`}
        </p>
      </Dialog>
    </>
  )
}
