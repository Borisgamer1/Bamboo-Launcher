import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ChevronUp, Loader2, X } from "lucide-react";
import {
  dismissBackgroundTask,
  dismissExpiredBackgroundTasks,
  useBackgroundTasks,
  type BackgroundTask,
} from "../lib/backgroundTasks";

const clampPercent = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
};

const stateLabel = (task: BackgroundTask) => {
  if (task.state === "done") return "Fertig";
  if (task.state === "error") return "Fehlgeschlagen";
  return "Läuft";
};

const StateIcon: React.FC<{ task: BackgroundTask; className?: string }> = ({ task, className = "h-3 w-3" }) => {
  if (task.state === "error") return <AlertTriangle className={className} />;
  if (task.state === "done") return <CheckCircle2 className={className} />;
  return <Loader2 className={`${className} animate-spin`} />;
};

const stateClasses = (task: BackgroundTask) =>
  task.state === "error"
    ? "border-danger/25 bg-danger/10 text-danger"
    : task.state === "done"
      ? "border-success/25 bg-success/10 text-success"
      : "border-hairline bg-hover text-ink-secondary";

/**
 * Footer strip for large operations (modpacks, worlds, imports, repairs).
 * It lives in App, so switching tabs never hides an install that is running.
 * Finished imports clear themselves after a short result window; errors and
 * other finished work stay until the user dismisses them.
 */
export const BackgroundTaskBar: React.FC = () => {
  const tasks = useBackgroundTasks();
  // A running install is what the user needs to see while walking away; only
  // when everything has finished does the newest result take the slot.
  const task = tasks.find((entry) => entry.state === "running") ?? tasks[0];
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timers = tasks
      .filter((entry) => entry.state === "done" && entry.autoDismissMs !== undefined)
      .map((entry) =>
        window.setTimeout(
          () => dismissExpiredBackgroundTasks(),
          Math.max(0, (entry.finishedAt ?? Date.now()) + (entry.autoDismissMs ?? 0) - Date.now()),
        ),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [tasks]);

  useEffect(() => {
    if (!expanded) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);

  if (!task) return null;

  const percent = clampPercent(task.percent);
  const running = task.state === "running";
  const failed = task.state === "error";
  const done = task.state === "done";
  const extra = tasks.length - 1;

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 max-w-[min(520px,55vw)] items-center gap-2.5 text-micro font-medium"
    >
      <div
        role="status"
        aria-live="polite"
        className="flex min-w-0 items-center gap-2.5"
        title={task.detail || task.title}
      >
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${stateClasses(task)}`}>
          <StateIcon task={task} />
        </span>

        <span className="min-w-0 flex flex-col justify-center">
          <span className="flex items-baseline gap-2">
            <span className={`truncate ${failed ? "text-danger" : done ? "text-success" : "text-ink"}`}>
              {task.title}
            </span>
            {percent !== null && running ? (
              <span className="shrink-0 tabular-nums text-ink-secondary">{percent}%</span>
            ) : null}
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="relative h-1 w-[min(260px,28vw)] shrink-0 overflow-hidden rounded-full bg-selected">
              {percent !== null ? (
                <span
                  className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-[var(--ease-out)] ${
                    failed ? "bg-danger" : done ? "bg-success" : "bg-accent"
                  }`}
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <motion.span
                  aria-hidden
                  className={`absolute inset-y-0 w-1/3 rounded-full ${
                    failed ? "bg-danger" : done ? "bg-success" : "bg-accent"
                  }`}
                  animate={{ x: ["-110%", "330%"] }}
                  transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }}
                />
              )}
            </span>
            <span className="truncate text-ink-tertiary">{task.detail || stateLabel(task)}</span>
          </span>
        </span>
      </div>

      {extra > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={`${tasks.length} Aufgaben anzeigen`}
          className="flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-hover px-1.5 py-0.5 tabular-nums text-ink-secondary transition-colors hover:bg-selected hover:text-ink cursor-pointer"
        >
          +{extra}
          <ChevronUp className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => dismissBackgroundTask(task.id)}
        aria-label="Ausblenden"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-ink-tertiary transition-colors hover:bg-hover hover:text-ink cursor-pointer"
      >
        <X className="h-3 w-3" />
      </button>

      {expanded && extra > 0 ? (
        <div className="absolute bottom-full right-0 z-[90] mb-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-[var(--r-lg)] border border-rim bg-glass p-1.5 shadow-[var(--shadow-menu)] backdrop-blur-[18px] backdrop-saturate-[1.25]">
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-label text-ink-quaternary">
            {tasks.length} Aufgaben
          </div>
          <div className="max-h-64 overflow-y-auto">
            {tasks.map((entry) => {
              const entryPercent = clampPercent(entry.percent);
              return (
                <div key={entry.id} className="group flex items-start gap-2 rounded-[var(--r-sm)] px-2 py-1.5 hover:bg-hover/70">
                  <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${stateClasses(entry)}`}>
                    <StateIcon task={entry} className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-small font-medium text-ink">{entry.title}</p>
                    <p className="truncate text-micro text-ink-tertiary">
                      {entry.detail || stateLabel(entry)}
                      {entry.state === "running" && entryPercent !== null ? ` · ${entryPercent}%` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissBackgroundTask(entry.id)}
                    aria-label={`${entry.title} ausblenden`}
                    className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-ink-tertiary transition-colors hover:bg-hover hover:text-ink cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};
