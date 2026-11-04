import React, { useEffect, useId, useRef, useState } from "react";
import { Check, Loader2, Lock, Pencil, RotateCcw, Trash2, Upload, UserRound } from "lucide-react";
import type { SkinSnapshot, SkinVariant } from "../../electron";
import type { LanguageType } from "../../lib/translations";
import { Dialog } from "../Dialog";
import { dialogButton } from "../dialogSupport";
import { useToast } from "../Toast";
import { SkinStage } from "./SkinStage";

const LIBRARY_KEY = "bamboo:skin-library:v1";
const PRIMARY =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-ink px-3 text-small font-medium text-root transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const QUIET =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-micro font-medium text-ink-tertiary transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const CARD_ACTION =
  "inline-flex h-6 w-6 items-center justify-center rounded-md border border-hairline bg-root/80 text-ink-tertiary backdrop-blur-sm transition-colors duration-[var(--t-quick)] hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

interface LocalSkin {
  id: string;
  name: string;
  dataUrl: string;
  variant: SkinVariant;
}

interface SkinTabProps {
  snapshot: SkinSnapshot | null;
  lang: LanguageType;
  busy: string | null;
  mutate: (
    key: string,
    action: () => Promise<SkinSnapshot | undefined>,
    success?: string,
  ) => Promise<SkinSnapshot | null>;
  onOpenAccounts: () => void;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `skin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function readLibrary(): LocalSkin[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LocalSkin => {
      if (!entry || typeof entry !== "object") return false;
      const skin = entry as Record<string, unknown>;
      return (
        typeof skin.id === "string" &&
        typeof skin.name === "string" &&
        typeof skin.dataUrl === "string" &&
        skin.dataUrl.startsWith("data:image/png;base64,") &&
        (skin.variant === "classic" || skin.variant === "slim")
      );
    });
  } catch {
    return [];
  }
}

function seedLibrary(snapshot: SkinSnapshot | null, lang: LanguageType): LocalSkin[] {
  const stored = readLibrary();
  const url = snapshot?.skin.url;
  if (snapshot?.skin.source !== "local" || !url || stored.some((skin) => skin.dataUrl === url)) {
    return stored;
  }
  return [
    {
      id: createId(),
      name: uniqueName(lang === "de" ? "Mein Skin" : "My skin", stored),
      dataUrl: url,
      variant: snapshot.skin.variant,
    },
    ...stored,
  ];
}

function uniqueName(name: string, library: LocalSkin[]): string {
  const base = name.trim().replace(/\.png$/i, "") || "Mein Skin";
  if (!library.some((skin) => skin.name.toLowerCase() === base.toLowerCase())) return base;
  let suffix = 2;
  while (library.some((skin) => skin.name.toLowerCase() === `${base} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const SkinFace: React.FC<{ src: string; size: number }> = ({ src, size }) => (
  <span
    className="relative block overflow-hidden"
    style={{ width: size, height: size }}
    aria-hidden
  >
    <img
      src={src}
      alt=""
      draggable={false}
      className="absolute max-w-none"
      style={{
        width: size * 8,
        height: "auto",
        left: -size,
        top: -size,
        imageRendering: "pixelated",
      }}
    />
    <img
      src={src}
      alt=""
      draggable={false}
      className="absolute max-w-none"
      style={{
        width: size * 8,
        height: "auto",
        left: -size * 5,
        top: -size,
        imageRendering: "pixelated",
      }}
    />
  </span>
);

interface SkinCardProps {
  name: string;
  variant: SkinVariant;
  skinUrl: string;
  active: boolean;
  inGame: boolean;
  lang: LanguageType;
  local: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

const SkinCard: React.FC<SkinCardProps> = ({
  name,
  variant,
  skinUrl,
  active,
  inGame,
  lang,
  local,
  busy,
  onSelect,
  onRename,
  onDelete,
}) => (
  <article
    className={`group relative rounded-[12px] border p-3 transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] ${
      active
        ? "border-stroke-strong bg-raised"
        : "border-hairline bg-surface/55 hover:border-stroke hover:bg-raised/55"
    }`}
  >
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      aria-pressed={active}
      className="block w-full cursor-pointer rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="relative flex h-[92px] items-center justify-center overflow-hidden rounded-[8px] border border-hairline bg-root/55">
        <span
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_38%,rgba(255,255,255,0.055),transparent_64%)]"
          aria-hidden
        />
        <SkinFace src={skinUrl} size={64} />
      </span>
      <span className="mt-2.5 flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small font-medium text-ink" title={name}>
            {name}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-micro text-ink-tertiary">
            {variant === "slim" ? "Slim" : lang === "de" ? "Klassisch" : "Classic"}
            {active && inGame ? (
              <>
                <span className="h-1 w-1 bg-success" aria-hidden />
                <span>{lang === "de" ? "Im Spiel" : "In game"}</span>
              </>
            ) : null}
          </span>
        </span>
        {active ? (
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-accent text-accent-contrast">
            <Check className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
          </span>
        ) : null}
      </span>
    </button>

    {local ? (
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-[var(--t-quick)] group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          className={CARD_ACTION}
          onClick={onRename}
          aria-label={lang === "de" ? `${name} umbenennen` : `Rename ${name}`}
          title={lang === "de" ? "Umbenennen" : "Rename"}
        >
          <Pencil className="h-3 w-3" aria-hidden />
        </button>
        <button
          type="button"
          className={`${CARD_ACTION} hover:text-danger`}
          onClick={onDelete}
          aria-label={lang === "de" ? `${name} löschen` : `Delete ${name}`}
          title={lang === "de" ? "Löschen" : "Delete"}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </button>
      </div>
    ) : null}
  </article>
);

export const SkinTab: React.FC<SkinTabProps> = ({ snapshot, lang, busy, mutate, onOpenAccounts }) => {
  const { addToast } = useToast();
  const api = window.electronAPI?.skins;
  const de = lang === "de";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const renameTitleId = useId();
  const deleteTitleId = useId();

  const [library, setLibrary] = useState<LocalSkin[]>(() => seedLibrary(snapshot, lang));
  const [renameTarget, setRenameTarget] = useState<LocalSkin | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LocalSkin | null>(null);
  const [dragging, setDragging] = useState(false);
  const capes = snapshot?.capes ?? [];

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch {
      addToast({
        type: "error",
        message: de
          ? "Die Skin-Bibliothek konnte nicht gespeichert werden."
          : "The skin library could not be saved.",
      });
    }
  }, [addToast, de, library]);

  const currentLocal = library.find((skin) => skin.dataUrl === snapshot?.skin.url) ?? null;
  const hasProfile = false;
  const total = library.length;
  const currentName = currentLocal?.name ??
    (snapshot?.skin.source === "local"
      ? de
        ? "Lokaler Skin"
        : "Local skin"
      : de
        ? "Kein Skin"
        : "No skin");
  const variant = snapshot?.skin.variant ?? "classic";
  const variantLocked = !!snapshot?.skin.url && snapshot?.skin.source !== "local";
  const canChangeVariant = snapshot?.skin.source === "local" && busy === null;
  const canApply = !!(snapshot?.canApplySkin && busy === null);

  const upload = async (file: File | undefined) => {
    if (!file || !api) return;
    if (file.type && file.type !== "image/png") {
      addToast({
        type: "error",
        message: de ? "Bitte wähle eine PNG-Datei." : "Choose a PNG file.",
      });
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await mutate(
      "skin-upload",
      () => api.saveSkin({ bytes, variant }),
      de ? "Skin hinzugefügt." : "Skin added.",
    );
    const url = result?.skin.url;
    if (!result || !url) return;
    setLibrary((previous) => {
      const existing = previous.find((skin) => skin.dataUrl === url);
      if (existing) {
        return previous.map((skin) =>
          skin.id === existing.id ? { ...skin, variant: result.skin.variant } : skin,
        );
      }
      return [
        {
          id: createId(),
          name: uniqueName(file.name.replace(/\.png$/i, ""), previous),
          dataUrl: url,
          variant: result.skin.variant,
        },
        ...previous,
      ];
    });
  };

  const selectSkin = async (skin: LocalSkin) => {
    if (!api || busy !== null || snapshot?.skin.url === skin.dataUrl) return;
    await mutate(
      `skin-select:${skin.id}`,
      () => api.saveSkin({ bytes: dataUrlBytes(skin.dataUrl), variant: skin.variant }),
      de ? `${skin.name} ausgewählt.` : `${skin.name} selected.`,
    );
  };

  const restoreProfile = async () => {
    if (!api || busy !== null) return;
    await mutate(
      "skin-profile",
      () => api.resetSkin(),
      de ? "Minecraft-Profil wird wieder verwendet." : "Minecraft profile restored.",
    );
  };

  const changeVariant = async (next: SkinVariant) => {
    if (!api || !canChangeVariant || next === variant) return;
    const result = await mutate("skin-variant", () => api.setSkinVariant(next));
    if (!result?.skin.url) return;
    setLibrary((previous) =>
      previous.map((skin) =>
        skin.dataUrl === result.skin.url ? { ...skin, variant: next } : skin,
      ),
    );
  };

  const applySkin = async () => {
    if (!api || busy !== null) return;
    await mutate(
      "skin-apply",
      () => api.applySkin(),
      de ? "Skin wurde auf dein Minecraft-Profil gesetzt." : "Skin applied to your Minecraft profile.",
    );
  };

  const selectCape = async (capeId: string | null) => {
    if (!api || busy !== null) return;
    await mutate(
      `cape:${capeId ?? "none"}`,
      () => api.selectCape(capeId),
      capeId ? (de ? "Cape gewechselt." : "Cape changed.") : de ? "Cape ausgeblendet." : "Cape hidden.",
    );
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const wasActive = deleteTarget.dataUrl === snapshot?.skin.url;
    if (wasActive && api) {
      const result = await mutate("skin-delete", () => api.resetSkin());
      if (!result) return;
    }
    setLibrary((previous) => previous.filter((skin) => skin.id !== deleteTarget.id));
    setDeleteTarget(null);
    addToast({ type: "success", message: de ? "Skin gelöscht." : "Skin deleted." });
  };

  const saveRename = () => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName) return;
    setLibrary((previous) =>
      previous.map((skin) => (skin.id === renameTarget.id ? { ...skin, name: nextName } : skin)),
    );
    setRenameTarget(null);
  };

  return (
    <>
      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="min-w-0 self-start lg:sticky lg:top-6">
          <section className="overflow-hidden rounded-[16px] border border-hairline bg-surface">
            <SkinStage snapshot={snapshot} lang={lang} onOpenAccounts={onOpenAccounts} />
          </section>
        </aside>

        <section
          className="relative min-w-0 rounded-[16px] border border-hairline bg-surface p-5"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files?.[0]);
          }}
        >
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[12px] border border-accent/45 bg-root/85 text-small font-medium text-ink backdrop-blur-sm">
              <Upload className="mr-2 h-4 w-4 text-ink-secondary" aria-hidden />
              {de ? "Skin hier ablegen" : "Drop skin here"}
            </div>
          ) : null}

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="m-0 text-title3 font-medium text-ink">Skins</h2>
              <p className="m-0 mt-1 text-mini text-ink-tertiary">
                {de ? "Wähle, was im Spiel getragen wird" : "Choose what you wear in game"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-micro tabular-nums text-ink-quaternary">
                {total} {total === 1 ? (de ? "Skin" : "skin") : de ? "Skins" : "skins"}
              </span>
              <button
                ref={uploadButtonRef}
                type="button"
                className={PRIMARY}
                onClick={() => fileInputRef.current?.click()}
                disabled={busy !== null}
              >
                {busy === "skin-upload" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                )}
                {de ? "Skin hochladen" : "Upload skin"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png"
                className="hidden"
                onChange={(event) => {
                  void upload(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          {!hasProfile && library.length === 0 ? (
            <div className="mt-6 rounded-[12px] border border-dashed border-stroke px-5 py-8">
              <p className="m-0 text-small font-medium text-ink">
                {de ? "Noch kein Skin gespeichert" : "No skin saved yet"}
              </p>
              <p className="m-0 mt-1 text-micro leading-5 text-ink-tertiary">
                {de
                  ? "Eine PNG-Datei mit 64×64 oder 64×32 Pixeln reicht"
                  : "A PNG at 64×64 or 64×32 pixels is enough"}
              </p>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-4">

              {library.map((skin) => {
                const active = skin.dataUrl === snapshot?.skin.url;
                return (
                  <SkinCard
                    key={skin.id}
                    name={skin.name}
                    variant={skin.variant}
                    skinUrl={skin.dataUrl}
                    active={active}
                    inGame={active && !!snapshot?.skin.applied}
                    lang={lang}
                    local
                    busy={busy !== null}
                    onSelect={() => void selectSkin(skin)}
                    onRename={() => {
                      setRenameTarget(skin);
                      setRenameValue(skin.name);
                    }}
                    onDelete={() => setDeleteTarget(skin)}
                  />
                );
              })}
            </div>
          )}

          {snapshot ? (
            <div className="mt-6 border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1 w-1 shrink-0 ${snapshot.skin.applied ? "bg-success" : "bg-ink-quaternary"}`}
                      aria-hidden
                    />
                    <p className="m-0 truncate text-small font-medium text-ink">{currentName}</p>
                    {snapshot.skin.source === "local" && !snapshot.skin.applied ? (
                      <span className="shrink-0 text-micro text-ink-tertiary">
                        {de ? "Entwurf" : "Draft"}
                      </span>
                    ) : null}
                  </div>
                  <p className="m-0 mt-0.5 text-micro text-ink-tertiary">
                    {snapshot.skin.url
                      ? snapshot.skin.applied
                        ? de
                          ? "Im Spiel aktiv"
                          : "Active in game"
                        : snapshot.skin.source === "local"
                          ? de
                            ? "Lokal, noch nicht angewendet"
                            : "Local, not applied yet"
                          : de
                            ? "Vom Profil geladen"
                            : "Loaded from profile"
                      : de
                        ? "Kein Skin ausgewählt"
                        : "No skin selected"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {variantLocked ? (
                    <Lock
                      className="h-3 w-3 text-ink-quaternary"
                      aria-label={
                        de ? "Vom Minecraft-Profil vorgegeben" : "Provided by the Minecraft profile"
                      }
                    />
                  ) : null}
                  <span className="text-micro text-ink-tertiary">{de ? "Modell" : "Model"}</span>
                  <div className="grid grid-cols-2 rounded-[8px] border border-hairline bg-root/45 p-0.5">
                    {(["classic", "slim"] as const).map((entry) => {
                      const selected = variant === entry;
                      return (
                        <button
                          key={entry}
                          type="button"
                          onClick={() => void changeVariant(entry)}
                          disabled={!canChangeVariant}
                          aria-pressed={selected}
                          title={
                            canChangeVariant
                              ? undefined
                              : de
                                ? "Wird vom Minecraft-Profil vorgegeben"
                                : "Provided by the Minecraft profile"
                          }
                          className={`h-7 min-w-[72px] rounded-[6px] px-2 text-micro font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-35 ${
                            selected
                              ? "bg-raised text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                              : "text-ink-tertiary hover:text-ink-secondary"
                          }`}
                        >
                          {entry === "classic" ? (de ? "Klassisch" : "Classic") : "Slim"}
                        </button>
                      );
                    })}
                  </div>

                  {snapshot.skin.source === "local" ? (
                    <>
                      {snapshot.account ? (
                        <button
                          type="button"
                          className={PRIMARY}
                          onClick={() => void applySkin()}
                          disabled={!canApply}
                        >
                          {busy === "skin-apply" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {de ? "Auf Profil anwenden" : "Apply to profile"}
                        </button>
                      ) : (
                        <button type="button" className={PRIMARY} onClick={onOpenAccounts}>
                          <UserRound className="h-3.5 w-3.5" aria-hidden />
                          {de ? "Konto verbinden" : "Connect account"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={QUIET}
                        onClick={() => void restoreProfile()}
                        disabled={busy !== null}
                        title={de ? "Minecraft-Profil verwenden" : "Use Minecraft profile"}
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden />
                        {snapshot.account
                          ? de
                            ? "Profil verwenden"
                            : "Use profile"
                          : de
                            ? "Entfernen"
                            : "Remove"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <p className="m-0 mt-3 text-micro text-ink-tertiary">
                {de
                  ? "Eigene Skins bleiben lokal, bis du sie auf dein Profil anwendest"
                  : "Saved skins stay local until you apply one to your profile"}
              </p>
            </div>
          ) : null}

          <div className="mt-6 border-t border-hairline pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <h3 className="m-0 text-small font-medium text-ink">
                  {de ? "Mojang-Cape" : "Mojang cape"}
                </h3>
                <p className="m-0 mt-0.5 text-micro text-ink-tertiary">
                  {de
                    ? "Wird direkt am Minecraft-Profil gesetzt, nicht nur in der Vorschau"
                    : "Set on your Minecraft profile, not only in the preview"}
                </p>
              </div>
              {capes.some((cape) => cape.active) ? (
                <button
                  type="button"
                  className={QUIET}
                  onClick={() => void selectCape(null)}
                  disabled={busy !== null}
                >
                  {busy === "cape:none" ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : null}
                  {de ? "Ohne Cape" : "No cape"}
                </button>
              ) : null}
            </div>

            {capes.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {capes.map((cape) => {
                  const active = cape.active;
                  const loading = busy === `cape:${cape.id}`;
                  return (
                    <button
                      key={cape.id}
                      type="button"
                      onClick={() => void selectCape(cape.id)}
                      disabled={busy !== null && !loading}
                      aria-pressed={active}
                      className={`flex items-center gap-2 rounded-[10px] border p-1.5 pr-3 text-left transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 ${
                        active
                          ? "border-accent/45 bg-accent/[0.06]"
                          : "border-hairline bg-root/40 hover:border-stroke hover:bg-raised/60"
                      }`}
                    >
                      <span className="flex h-8 w-12 items-center justify-center overflow-hidden rounded-[6px] border border-hairline bg-root/60">
                        <img
                          src={cape.url}
                          alt=""
                          draggable={false}
                          className="h-full w-full object-contain"
                          style={{ imageRendering: "pixelated" }}
                        />
                      </span>
                      <span className="block max-w-[136px] truncate text-micro text-ink">
                        {cape.name}
                      </span>
                      {loading ? (
                        <Loader2 className="h-3 w-3 animate-spin text-ink-tertiary" aria-hidden />
                      ) : active ? (
                        <Check className="h-3 w-3 text-accent" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="m-0 mt-3 text-micro leading-5 text-ink-tertiary">
                {snapshot?.account
                  ? de
                    ? "Dieses Konto besitzt keine Mojang-Capes."
                    : "This account owns no Mojang capes."
                  : de
                    ? "Verbinde dein Microsoft-Konto, um deine Capes zu sehen."
                    : "Connect your Microsoft account to see your capes."}
              </p>
            )}
          </div>
        </section>
      </div>

      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title={de ? "Skin umbenennen" : "Rename skin"}
        titleId={renameTitleId}
        closeLabel={de ? "Schließen" : "Close"}
        tone="accent"
        footer={
          <>
            <button type="button" className={dialogButton.secondary} onClick={() => setRenameTarget(null)}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className={dialogButton.accent}
              onClick={saveRename}
              disabled={!renameValue.trim()}
            >
              {de ? "Speichern" : "Save"}
            </button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1.5 block text-micro font-medium text-ink-secondary">Name</span>
          <input
            data-autofocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveRename();
              }
            }}
            maxLength={48}
            className="h-9 w-full rounded-lg border border-stroke bg-root px-3 text-small text-ink outline-none transition-colors focus:border-accent/45"
          />
        </label>
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={de ? "Skin löschen" : "Delete skin"}
        titleId={deleteTitleId}
        closeLabel={de ? "Schließen" : "Close"}
        tone="danger"
        icon={<Trash2 className="h-4 w-4" />}
        returnFocusFallback={() => uploadButtonRef.current}
        footer={
          <>
            <button type="button" className={dialogButton.secondary} onClick={() => setDeleteTarget(null)}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="button" className={dialogButton.danger} onClick={() => void confirmDelete()}>
              {de ? "Löschen" : "Delete"}
            </button>
          </>
        }
      >
        <p className="m-0">
          {de
            ? `„${deleteTarget?.name ?? ""}“ wird aus deiner lokalen Skin-Bibliothek entfernt.`
            : `“${deleteTarget?.name ?? ""}” will be removed from your local skin library.`}
        </p>
      </Dialog>
    </>
  );
};
