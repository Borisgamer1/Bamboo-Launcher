import React, { useEffect, useState } from "react";
import { Loader2, Lock, RefreshCw } from "lucide-react";
import type { LanguageType } from "../../lib/translations";
import type { SkinSnapshot } from "../../electron";
import { useToast } from "../Toast";
import { CosmeticsTab } from "./CosmeticsTab";
import { SkinTab } from "./SkinTab";

type CustomizeTab = "cosmetics" | "skin";

const REFRESH_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

interface CustomizeViewProps {
  lang: LanguageType;
  /** True while an instance is starting or running. */
  locked?: boolean;
  onOpenAccounts: () => void;
  /** Cosmetics live in an instance folder, so the tab needs the list. */
  instances?: Array<{ folderName?: string; name: string }>;
}

export const CustomizeView: React.FC<CustomizeViewProps> = ({
  lang,
  locked = false,
  onOpenAccounts,
}) => {
  const { addToast } = useToast();
  const api = window.electronAPI?.skins;
  const de = lang === "de";
  const [tab, setTab] = useState<CustomizeTab>("cosmetics");
  const [snapshot, setSnapshot] = useState<SkinSnapshot | null>(null);
  const [loading, setLoading] = useState(!!api);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    api ? null : de ? "Die Anpassen-Brücke ist nicht verfügbar." : "The customization bridge is not available.",
  );

  const accept = (next: SkinSnapshot | undefined) => {
    if (!next) return;
    setSnapshot(next);
    setError(null);
  };

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .snapshot()
      .then((next) => {
        if (!cancelled) accept(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const refresh = async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      accept(await api.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const mutate = async (
    key: string,
    action: () => Promise<SkinSnapshot | undefined>,
    success?: string,
  ): Promise<SkinSnapshot | null> => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      accept(next);
      if (next && success) addToast({ type: "success", message: success });
      return next ?? null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="custom-scrollbar relative z-10 h-full min-h-0 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="m-0 text-title2 font-medium text-ink">{de ? "Anpassen" : "Customize"}</h1>
            <p className="m-0 mt-1.5 max-w-[520px] text-mini leading-5 text-ink-tertiary">
              {de ? "Was andere im Spiel von dir sehen" : "What other players see in game"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label={de ? "Anpassen" : "Customize"}
              className="inline-flex rounded-[9px] border border-hairline bg-root/40 p-0.5"
            >
              {(
                [
                  { id: "cosmetics", label: "Cosmetics" },
                  { id: "skin", label: "Skin" },
                ] as const
              ).map((entry) => {
                const selected = tab === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setTab(entry.id)}
                    className={`h-7 rounded-[7px] px-3 text-micro font-medium transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      selected
                        ? "bg-raised text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "text-ink-tertiary hover:text-ink-secondary"
                    }`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
            {/* Cosmetics carries its own reload next to the package counts. */}
            {tab === "skin" ? (
              <button
                type="button"
                className={REFRESH_BUTTON}
                onClick={() => void refresh()}
                disabled={loading}
                aria-label={de ? "Aktualisieren" : "Refresh"}
                title={de ? "Aktualisieren" : "Refresh"}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
              </button>
            ) : null}
          </div>
        </header>

        {locked && tab === "skin" ? (
          <div
            role="status"
            className="mt-4 flex items-start gap-2 rounded-[var(--r-lg)] border border-hairline bg-raised/60 px-3 py-2 text-mini leading-5 text-ink-secondary"
          >
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
            <span>
              {de
                ? "Minecraft läuft gerade. Skin-Änderungen greifen erst nach dem Beenden der Instanz. Cosmetics lassen sich weiterhin installieren."
                : "Minecraft is running. Skin changes apply after the instance closes; cosmetics can still be installed."}
            </span>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-[var(--r-lg)] border border-danger/30 bg-danger/[0.06] px-3 py-2 text-mini text-danger"
          >
            {error}
          </div>
        ) : null}

        {loading && !snapshot ? (
          <div className="flex min-h-[320px] items-center justify-center text-ink-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          </div>
        ) : (
          <fieldset
            disabled={locked && tab === "skin"}
            aria-label={de ? "Anpassen" : "Customize"}
            className={`m-0 min-w-0 border-0 p-0 transition-opacity duration-[var(--t-quick)] ${
              locked && tab === "skin" ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {tab === "skin" ? (
              <SkinTab
                snapshot={snapshot}
                lang={lang}
                busy={busy}
                mutate={mutate}
                onOpenAccounts={onOpenAccounts}
              />
            ) : (
              <CosmeticsTab snapshot={snapshot} lang={lang} onRefresh={refresh} />
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
};
