import { useSyncExternalStore } from "react";

export type BackgroundTaskState = "running" | "done" | "error";

export interface BackgroundTask {
  id: string;
  title: string;
  detail: string;
  /** `null` renders an indeterminate bar for work without a known total. */
  percent: number | null;
  state: BackgroundTaskState;
  startedAt: number;
  finishedAt?: number;
  /** Successful imports clear themselves instead of stacking up. */
  autoDismissMs?: number;
}

/** How long a finished import stays readable in the footer before it fades out. */
export const IMPORT_AUTO_DISMISS_MS = 8000;

/**
 * Every finished task clears itself; a completed install should not sit in the
 * footer until the launcher closes. Explicit values still win, errors never
 * auto-dismiss.
 */
export const RESULT_AUTO_DISMISS_MS = 8000;

export interface BackgroundTaskInput {
  id: string;
  title: string;
  detail?: string;
  percent?: number | null;
}

let tasks: BackgroundTask[] = [];
const listeners = new Set<() => void>();

function publish(next: BackgroundTask[]) {
  tasks = next;
  for (const listener of listeners) listener();
}

let taskSequence = 0;

/** Unique id for operations that are not tied to a folder (imports, worlds). */
export function newBackgroundTaskId(prefix: string): string {
  taskSequence += 1;
  return `${prefix}:${Date.now().toString(36)}-${taskSequence}`;
}

const getSnapshot = () => tasks;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Registers a long-running operation so it survives leaving the current view. */
export function beginBackgroundTask(input: BackgroundTaskInput): void {
  const existing = tasks.find((task) => task.id === input.id);
  const next: BackgroundTask = {
    id: input.id,
    title: input.title,
    detail: input.detail ?? "",
    percent: input.percent ?? null,
    state: "running",
    startedAt: existing?.startedAt ?? Date.now(),
  };
  publish([next, ...tasks.filter((task) => task.id !== input.id)]);
}

/**
 * Updates a task that is already known. Unknown ids are ignored on purpose:
 * a stale progress event must never create a task out of nowhere.
 */
export function updateBackgroundTask(
  id: string,
  patch: Partial<Pick<BackgroundTask, "title" | "detail" | "percent">>,
): void {
  if (!tasks.some((task) => task.id === id)) return;
  publish(
    tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
            ...(patch.percent !== undefined ? { percent: patch.percent } : {}),
          }
        : task,
    ),
  );
}

export function completeBackgroundTask(
  id: string,
  detail?: string,
  autoDismissMs: number = RESULT_AUTO_DISMISS_MS,
): void {
  if (!tasks.some((task) => task.id === id)) return;
  publish(
    tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            percent: 100,
            state: "done" as const,
            finishedAt: Date.now(),
            // Without an explicit result, drop the last progress label so the
            // bar shows "Fertig" instead of a stale "wird kopiert…".
            detail: detail ?? "",
            autoDismissMs,
          }
        : task,
    ),
  );
}

/** Removes only successful tasks whose visible result has had its full time. */
export function dismissExpiredBackgroundTasks(now = Date.now()): void {
  const remaining = tasks.filter(
    (task) =>
      !(
        task.state === "done" &&
        task.autoDismissMs !== undefined &&
        (task.finishedAt ?? 0) + task.autoDismissMs <= now
      ),
  );
  if (remaining.length !== tasks.length) publish(remaining);
}

export function failBackgroundTask(id: string, detail?: string): void {
  if (!tasks.some((task) => task.id === id)) return;
  publish(
    tasks.map((task) =>
      task.id === id
        ? {
            ...task,
            state: "error" as const,
            finishedAt: Date.now(),
            ...(detail !== undefined ? { detail } : {}),
          }
        : task,
    ),
  );
}

export function dismissBackgroundTask(id: string): void {
  publish(tasks.filter((task) => task.id !== id));
}

export function useBackgroundTasks(): BackgroundTask[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
