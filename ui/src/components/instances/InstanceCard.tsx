import React from "react";
import { Play, Square, Loader2, AlertTriangle, ShieldAlert } from "lucide-react";
import type { Instance } from "../InstancesView";
import type { LaunchProgress, LogAnalysisResult } from "../../electron";
import { translations, type LanguageType } from "../../lib/translations";
import { formatPlaytime } from "../../lib/launcherPreferences";
import { derivePlayState } from "../../lib/usePlayState";
import { InstanceLaunchProgress } from "./InstanceLaunchProgress";

export interface InstanceCardProps {
  instance: Instance;
  running: boolean;
  launching: boolean;
  progress?: LaunchProgress;
  error?: string | null;
  analysis?: LogAnalysisResult | null;
  tabIndex: number;
  onOpen: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onOpenAnalysis?: () => void;
  onLaunch: (event: React.MouseEvent) => void;
  onStop: (event: React.MouseEvent) => void;
  onRetry: () => void;
  showPlaytime?: boolean;
  hasAccount?: boolean;
  lang: LanguageType;
}

const badge = "h-5 inline-flex items-center rounded-md px-1.5 text-micro font-medium whitespace-nowrap";

export const InstanceCard: React.FC<InstanceCardProps> = ({
  instance,
  running,
  launching,
  progress,
  error,
  analysis,
  tabIndex,
  onOpen,
  onContextMenu,
  onOpenAnalysis,
  onLaunch,
  onStop,
  onRetry,
  showPlaytime,
  hasAccount,
  lang,
}) => {
  const t = translations[lang];
  const playState = derivePlayState({ running, launching, hasAccount: !!hasAccount });
  const canPress = playState !== "disabled";
  const meta = [instance.minecraftVersion, [instance.modloader, instance.modloaderVersion].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-instance-card
      data-tour="instance-card"
      tabIndex={tabIndex}
      aria-label={instance.name}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onContextMenu?.({
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          } as React.MouseEvent<HTMLDivElement>);
        }
      }}
      className={`relative flex flex-col overflow-hidden rounded-[var(--r-xl)] border bg-surface shadow-[var(--shadow-card)] cursor-pointer transition-[background-color,border-color,transform,translate] duration-[var(--t-quick)] ease-[var(--ease-out)] hover:-translate-y-px hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] ${
        error ? "border-danger/35" : "border-stroke hover:border-rim"
      }`}
    >
      <div className="relative aspect-video shrink-0 overflow-hidden border-b border-hairline bg-black">
        {instance.thumbnail ? (
          <img
            src={instance.thumbnail}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(event) => {
              (event.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="truncate text-regular font-medium text-ink">{instance.name}</h3>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-mini font-[450] text-ink-tertiary">{meta}</p>
          <button
            type="button"
            disabled={!canPress}
            onClick={(event) => {
              event.stopPropagation();
              if (running) onStop(event);
              else onLaunch(event);
            }}
            className={`ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-[color,background-color,border-color,transform] duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              canPress
                ? "border-rim text-ink-secondary hover:border-accent hover:bg-accent hover:text-accent-contrast hover:scale-[1.04] active:scale-95 cursor-pointer"
                : "cursor-not-allowed border-stroke text-ink-quaternary opacity-40"
            }`}
            aria-label={running ? t.stopAction : t.playAction}
          >
            {playState === "preparing" ? (
              <Loader2 className="h-4.5 w-4.5 animate-spin" />
            ) : playState === "running" ? (
              <Square className="h-4 w-4 fill-current" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
          </button>
        </div>

        <div className="mt-auto flex h-5 items-center gap-1">
          <span className={`${badge} bg-hover text-ink-secondary`}>{instance.modloader}</span>
          {showPlaytime && instance.playTimeMs ? (
            <span className={`${badge} bg-hover text-ink-tertiary`}>
              {formatPlaytime(instance.playTimeMs, lang)}
            </span>
          ) : null}
          {playState === "running" && <span className={`${badge} bg-success/12 text-success`}>{t.runningState}</span>}
          {playState === "preparing" && <span className={`${badge} bg-accent-soft text-accent`}>{t.launchingState}</span>}
        </div>

        {launching && <InstanceLaunchProgress progress={progress} lang={lang} />}

        {analysis && analysis.findings.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/25 bg-danger/8 px-2 py-1.5 text-mini text-danger">
            <span className="flex min-w-0 items-center gap-1">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {lang === "de" ? "Crash erkannt" : "Crash detected"} · {analysis.findings[0].title}
              </span>
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenAnalysis?.();
              }}
              className="shrink-0 font-medium underline underline-offset-2 cursor-pointer"
            >
              {lang === "de" ? "Beheben" : "Fix"}
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-2 text-mini text-danger">
            <span className="flex min-w-0 items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{error}</span>
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
              className="shrink-0 font-medium underline underline-offset-2 cursor-pointer"
            >
              {t.retryLabel}
            </button>
          </div>
        )}
      </div>

    </div>
  );
};
