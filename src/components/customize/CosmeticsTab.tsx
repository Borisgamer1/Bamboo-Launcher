import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  Check,
  Crown,
  Download,
  Flag,
  Loader2,
  Package,
  RefreshCw,
  Store,
  Swords,
  Trash2,
} from 'lucide-react'
import type {
  CosmeticPreview,
  CosmeticSlot,
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
  /** Instances this launcher manages; cosmetics live in the selected one. */
  instances: Array<{ folderName?: string; name: string }>
}

type Selection =
  | { kind: 'installed'; file: string }
  | { kind: 'shop'; id: string }

const FOLDER_KEY = 'bamboo:cosmetics-instance:v1'
const PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-ink px-3 text-small font-medium text-root transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
const QUIET =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-micro font-medium text-ink-tertiary transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
const CARD =
  'rounded-[12px] border p-3 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

const RARITY_COLOR: Record<string, string> = {
  Common: '#9BAAA1',
  Uncommon: '#7FD9A0',
  Rare: '#6FB6DE',
  Epic: '#B293E6',
  Legendary: '#E6B45C',
}

const SLOT_ICON: Record<CosmeticSlot, React.ComponentType<{ className?: string }>> = {
  head: Crown,
  back: Swords,
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

const Rarity: React.FC<{ rarity: string }> = ({ rarity }) => (
  <span className="inline-flex items-center gap-1.5 text-micro text-ink-tertiary">
    <span
      className="h-[5px] w-[5px] shrink-0 rounded-full"
      style={{ backgroundColor: RARITY_COLOR[rarity] ?? RARITY_COLOR.Common }}
      aria-hidden
    />
    {rarity}
  </span>
)

const SlotTile: React.FC<{ slots: CosmeticSlot[]; active?: boolean }> = ({ slots, active }) => {
  const Icon = SLOT_ICON[slotOf(slots)]
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border ${
        active ? 'border-accent/40 bg-accent/[0.08]' : 'border-hairline bg-root/60'
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-ink-secondary'}`} />
    </span>
  )
}

export const CosmeticsTab: React.FC<CosmeticsTabProps> = ({ snapshot, lang, instances }) => {
  const de = lang === 'de'
  const api = window.electronAPI?.cosmetics
  const deleteTitleId = useId()
  const { addToast } = useToast()
  const targets = useMemo(
    () => instances.filter((entry): entry is { folderName: string; name: string } => !!entry.folderName),
    [instances],
  )
  const [preferred, setPreferred] = useState(() => {
    try {
      return localStorage.getItem(FOLDER_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const fallback = targets[0]?.folderName ?? ''
  const folder = targets.some((entry) => entry.folderName === preferred) ? preferred : fallback
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

  const selectionKey = selection
    ? selection.kind === 'installed'
      ? `installed:${folder}:${selection.file}`
      : `shop:${selection.id}`
    : ''
  const preview = previewState?.key === selectionKey ? previewState.preview : null
  const previewError = previewState?.key === selectionKey ? previewState.error : null
  const shopLoading = mode === 'shop' && !shop && !shopError

  const refreshInstalled = useCallback(async (): Promise<InstalledCosmetic[]> => {
    if (!api || !folder) return []
    const list = (await api.list(folder)) ?? []
    setInstalled(list)
    return list
  }, [api, folder])

  useEffect(() => {
    if (!api || !folder) return
    let cancelled = false
    api
      .list(folder)
      .then((list) => {
        if (cancelled) return
        const next = list ?? []
        setInstalled(next)
        setSelection((current) => {
          if (current?.kind === 'installed' && next.some((entry) => entry.file === current.file)) {
            return current
          }
          return next[0] ? { kind: 'installed', file: next[0].file } : null
        })
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api, folder])

  useEffect(() => {
    if (!api || mode !== 'shop' || shop || shopError) return
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
  }, [api, mode, shop, shopError])

  useEffect(() => {
    if (!api || !selection) return
    let cancelled = false
    const key = selectionKey
    const request =
      selection.kind === 'installed'
        ? api.preview({ folderName: folder, file: selection.file })
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
  }, [api, folder, selection, selectionKey])

  const installedItem =
    selection?.kind === 'installed'
      ? installed.find((entry) => entry.file === selection.file) ?? null
      : null
  const shopItem = selection?.kind === 'shop' ? shop?.items.find((entry) => entry.id === selection.id) ?? null : null
  const activeName = installedItem?.name ?? shopItem?.name ?? null
  const activeRarity = installedItem?.rarity ?? shopItem?.rarity ?? 'Common'
  const activeSlots = installedItem?.slots ?? shopItem?.slots ?? (['back'] as CosmeticSlot[])
  const activeCreator = installedItem?.creator ?? shopItem?.creator ?? ''
  const activeDescription = installedItem?.description ?? shopItem?.description ?? ''
  const installedByName = new Set(installed.map((entry) => entry.name.toLowerCase()))

  const selectInstance = (next: string) => {
    setPreferred(next)
    setSelection(null)
    try {
      localStorage.setItem(FOLDER_KEY, next)
    } catch {
      // A blocked localStorage must not stop the tab from working.
    }
  }

  const install = async (item: ShopItem) => {
    if (!api || !folder || busy) return
    setBusy(`install:${item.id}`)
    setError(null)
    try {
      const list = await api.install({ folderName: folder, id: item.id })
      setInstalled(list ?? [])
      const file = (list ?? []).find((entry) => entry.name.toLowerCase() === item.name.toLowerCase())?.file
      addToast({
        type: 'success',
        message: de ? `${item.name} installiert.` : `${item.name} installed.`,
      })
      setMode('installed')
      if (file) setSelection({ kind: 'installed', file })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = async () => {
    if (!api || !folder || !deleteTarget) return
    setBusy(`remove:${deleteTarget.file}`)
    setError(null)
    try {
      const list = await api.remove({ folderName: folder, file: deleteTarget.file })
      setInstalled(list ?? [])
      setSelection((current) =>
        current?.kind === 'installed' && current.file === deleteTarget.file
          ? (list ?? [])[0]
            ? { kind: 'installed', file: (list ?? [])[0].file }
            : null
          : current,
      )
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
    try {
      await refreshInstalled()
      if (mode === 'shop') {
        const catalog = await api.shop()
        setShop(catalog ?? { items: [], source: 'local' })
        setShopError(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!api) {
    return (
      <p className="m-0 mt-6 rounded-[14px] border border-hairline bg-surface px-5 py-6 text-mini text-ink-tertiary">
        {de ? 'Die Cosmetic-Brücke ist nicht verfügbar.' : 'The cosmetic bridge is not available.'}
      </p>
    )
  }

  if (targets.length === 0) {
    return (
      <p className="m-0 mt-6 rounded-[14px] border border-dashed border-stroke px-5 py-6 text-mini leading-5 text-ink-tertiary">
        {de
          ? 'Lege zuerst eine Instanz an. Cosmetics liegen in deren Ordner bamboo/cosmetics.'
          : 'Create an instance first. Cosmetics live in its bamboo/cosmetics folder.'}
      </p>
    )
  }

  return (
    <>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[288px_minmax(0,1fr)]">
        <aside className="min-w-0 self-start lg:sticky lg:top-6">
          <section className="overflow-hidden rounded-[14px] border border-hairline bg-surface">
            <CosmeticStage
              skinUrl={snapshot?.skin.url ?? null}
              variant={snapshot?.skin.variant ?? 'classic'}
              preview={preview}
              capeUrl={snapshot?.capes.find((cape) => cape.active)?.url ?? null}
              lang={lang}
            />
          </section>

          <section className="mt-3 rounded-[14px] border border-hairline bg-surface p-4">
            {selection ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="m-0 min-w-0 truncate text-small font-medium text-ink">
                    {activeName ?? (de ? 'Wird geladen' : 'Loading')}
                  </h3>
                  <Rarity rarity={activeRarity} />
                </div>
                <p className="m-0 mt-1 text-micro text-ink-tertiary">
                  {[activeCreator, slotLabel(activeSlots, de)].filter(Boolean).join(' · ')}
                </p>
                {previewError ? (
                  <p className="m-0 mt-3 text-micro leading-5 text-danger">{previewError}</p>
                ) : activeDescription ? (
                  <p className="m-0 mt-3 text-mini leading-5 text-ink-secondary">{activeDescription}</p>
                ) : null}

                {installedItem ? (
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3">
                    <p className="m-0 text-micro leading-4 text-ink-quaternary">
                      {de ? 'Ausrüsten im Spiel' : 'Equip in game'}
                    </p>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-micro font-medium text-ink-tertiary transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-35"
                      onClick={() => setDeleteTarget(installedItem)}
                      disabled={busy !== null}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {de ? 'Löschen' : 'Delete'}
                    </button>
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
                      {installedByName.has(shopItem.name.toLowerCase())
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
          </section>
        </aside>

        <section className="relative min-w-0 rounded-[14px] border border-hairline bg-surface lg:self-stretch">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3">
            <div className="inline-flex rounded-[8px] border border-hairline bg-root/40 p-0.5">
              {(
                [
                  { id: 'installed', label: de ? `Installiert` : 'Installed', count: installed.length },
                  { id: 'shop', label: 'Shop', count: shop?.items.length },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setMode(entry.id)}
                  aria-pressed={mode === entry.id}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-micro font-medium transition-colors duration-[var(--t-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    mode === entry.id
                      ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                      : 'text-ink-tertiary hover:text-ink-secondary'
                  }`}
                >
                  {entry.id === 'installed' ? (
                    <Package className="h-3 w-3" aria-hidden />
                  ) : (
                    <Store className="h-3 w-3" aria-hidden />
                  )}
                  {entry.label}
                  {typeof entry.count === 'number' ? (
                    <span className="tabular-nums text-ink-quaternary">{entry.count}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="flex min-w-0 items-center gap-2">
              <label className="flex min-w-0 items-center gap-1.5 text-micro text-ink-quaternary">
                <span className="shrink-0">{de ? 'Instanz' : 'Instance'}</span>
                <select
                  value={folder}
                  onChange={(event) => selectInstance(event.currentTarget.value)}
                  className="h-7 max-w-[180px] rounded-md border border-hairline bg-root px-1.5 text-micro text-ink-secondary outline-none focus:border-accent/40"
                >
                  {targets.map((entry) => (
                    <option key={entry.folderName} value={entry.folderName}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={QUIET}
                onClick={() => void refresh()}
                disabled={busy !== null}
                aria-label={de ? 'Aktualisieren' : 'Refresh'}
                title={de ? 'Aktualisieren' : 'Refresh'}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`} aria-hidden />
              </button>
            </div>
          </header>

          {error ? (
            <p role="alert" className="m-0 border-b border-hairline px-4 py-2 text-micro text-danger">
              {error}
            </p>
          ) : null}

          <div className="p-3">
            {mode === 'installed' ? (
              installed.length === 0 ? (
                <div className="rounded-[12px] border border-dashed border-stroke px-5 py-8 text-center">
                  <p className="m-0 text-small font-medium text-ink">
                    {de ? 'Noch nichts installiert' : 'Nothing installed yet'}
                  </p>
                  <p className="m-0 mt-1 text-micro leading-5 text-ink-tertiary">
                    {de
                      ? 'Im Shop findest du Pakete, die direkt im Spiel auswählbar sind.'
                      : 'The shop has packages you can pick in game.'}
                  </p>
                  <button type="button" className={`${PRIMARY} mt-4`} onClick={() => setMode('shop')}>
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
                        className={`relative flex w-full items-center gap-3 px-2.5 py-2 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                          active ? 'bg-raised' : 'hover:bg-hover'
                        }`}
                      >
                        <span
                          className={`absolute inset-y-1.5 left-0 w-0.5 rounded-full ${active ? 'bg-accent' : 'bg-transparent'}`}
                          aria-hidden
                        />
                        <SlotTile slots={entry.slots} active={active} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-small text-ink">{entry.name}</span>
                            {entry.valid ? null : (
                              <span className="shrink-0 text-micro text-danger">
                                {de ? 'defekt' : 'broken'}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2">
                            <Rarity rarity={entry.rarity} />
                            <span className="text-micro text-ink-quaternary">
                              {slotLabel(entry.slots, de)}
                            </span>
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
              <div className="flex min-h-[220px] items-center justify-center text-ink-tertiary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              </div>
            ) : shop && shop.items.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {shop.items.map((item) => {
                  const active = selection?.kind === 'shop' && selection.id === item.id
                  const owned = installedByName.has(item.name.toLowerCase())
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelection({ kind: 'shop', id: item.id })}
                      aria-pressed={active}
                      className={`${CARD} group relative ${
                        active ? 'border-stroke-strong bg-raised' : 'border-hairline bg-surface/55 hover:border-stroke hover:bg-raised/55'
                      }`}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <SlotTile slots={item.slots} active={active} />
                        {owned ? (
                          <span className="inline-flex items-center gap-1 text-micro text-accent">
                            <Check className="h-3 w-3" aria-hidden />
                            {de ? 'Installiert' : 'Installed'}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-2.5 block truncate text-small font-medium text-ink">{item.name}</span>
                      <span className="mt-0.5 block truncate text-micro text-ink-tertiary">
                        {[item.creator, slotLabel(item.slots, de)].filter(Boolean).join(' · ')}
                      </span>
                      {item.description ? (
                        <span className="mt-1.5 line-clamp-2 text-micro leading-4 text-ink-tertiary">
                          {item.description}
                        </span>
                      ) : null}
                      <span className="mt-2 flex items-center justify-between gap-2">
                        <Rarity rarity={item.rarity} />
                        {owned ? null : (
                          <Download
                            className="h-3.5 w-3.5 text-ink-quaternary transition-colors group-hover:text-ink-secondary"
                            aria-hidden
                          />
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-[12px] border border-dashed border-stroke px-5 py-8 text-center">
                <p className="m-0 text-small font-medium text-ink">
                  {de ? 'Shop ist leer' : 'Shop is empty'}
                </p>
                <p className="m-0 mt-1 text-micro leading-5 text-ink-tertiary">
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
            <button type="button" className={dialogButton.secondary} onClick={() => setDeleteTarget(null)}>
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
            ? `„${deleteTarget?.name ?? ''}“ wird aus ${folder} entfernt. Im Spiel ist es danach nicht mehr auswählbar.`
            : `“${deleteTarget?.name ?? ''}” will be removed from ${folder} and can no longer be picked in game.`}
        </p>
      </Dialog>
    </>
  )
}
