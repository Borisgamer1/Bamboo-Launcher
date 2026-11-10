import React from "react";
import { Loader2, Play, Square } from "lucide-react";
import { usePlayState } from "../../lib/usePlayState";
import { translations } from "../../lib/translations";
import type { LaunchProgress } from "../../electron";

export interface PlayAreaProps {
  running: boolean;
  launching: boolean;
  progress?: LaunchProgress;
  hasAccount: boolean;
  onPlay: () => void;
  onStop: () => void;
  lang?: "de" | "en";
}

const formatElapsed = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

const baseButton =
  "relative h-12 rounded-[10px] px-6 inline-flex items-center justify-center gap-2 text-regular font-semibold transition-[background-color,box-shadow,transform,opacity] duration-[var(--t-quick)] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]";

const accentButton =
  `${baseButton} bg-accent text-accent-contrast shadow-[var(--shadow-card)] hover:bg-accent-hover accent-glow-hover cursor-pointer ` +
  "active:translate-y-px active:bg-accent-press active:duration-[var(--t-instant)] active:ease-[var(--ease-back)]";

export const PlayArea: React.FC<PlayAreaProps> = ({
  running,
  launching,
  progress,
  hasAccount,
  onPlay,
  onStop,
  lang = "de",
}) => {
  const { state, elapsed } = usePlayState({ running, launching, hasAccount });
  const t = translations[lang];
  const de = lang === "de";

  const button = (() => {
    if (state === "preparing") {
      return (
        <button type="button" disabled className={`${baseButton} bg-accent-press text-accent-contrast cursor-wait`}>
          <Loader2 className="h-4 w-4 animate-spin" />
          {de ? "Wird vorbereitet…" : "Preparing…"}
          {progress ? <span className="tabular-nums opacity-80">{Math.round(progress.percent)}%</span> : null}
        </button>
      );
    }
    if (state === "running") {
      return (
        <div className="flex items-center gap-2">
          <div className="h-12 inline-flex items-center gap-2 rounded-[10px] border border-stroke bg-surface px-4 text-regular font-medium text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            {de ? "Läuft" : "Playing"} · {formatElapsed(elapsed)}
          </div>
          <button
            type="button"
            onClick={onStop}
            className="h-12 inline-flex items-center gap-1.5 rounded-[10px] px-3 text-small font-medium text-ink-secondary hover:text-ink hover:bg-hover transition-colors duration-[var(--t-quick)] ease-[var(--ease-out)] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Square className="h-3 w-3 fill-current" />
            {de ? "Stoppen" : "Stop"}
          </button>
        </div>
      );
    }
    if (state === "disabled") {
      const reason = t.noAccountSelected;
      return (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled
            title={reason}
            aria-label={`${t.playAction} – ${reason}`}
            className={`${baseButton} bg-accent text-accent-contrast opacity-20 cursor-not-allowed`}
          >
            <Play className="h-[18px] w-[18px] fill-current" />
            {de ? "Starten" : "Play"}
          </button>
          <span className="text-mini text-ink-tertiary">{reason}</span>
        </div>
      );
    }
    return (
      <button type="button" onClick={onPlay} className={accentButton}>
        <Play className="h-[18px] w-[18px] fill-current" />
        {de ? "Starten" : "Play"}
      </button>
    );
  })();

  return (
    <div data-play-area="header" className="shrink-0 [&_button]:w-full sm:[&_button]:w-auto">
      {button}
    </div>
  );
};
