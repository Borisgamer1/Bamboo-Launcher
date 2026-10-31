import { useEffect, useRef, useState } from "react";

export type PlayState = "idle" | "preparing" | "running" | "disabled";

export interface PlayStateInput {
  running: boolean;
  launching: boolean;
  hasAccount: boolean;
}

export function derivePlayState({ running, launching, hasAccount }: PlayStateInput): PlayState {
  if (running) return "running";
  if (!hasAccount) return "disabled";
  if (launching) return "preparing";
  return "idle";
}

export function usePlayState(input: PlayStateInput) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!input.running) {
      startedAt.current = null;
      return;
    }
    startedAt.current = Date.now();
    const timer = window.setInterval(() => {
      const started = startedAt.current;
      if (started !== null) setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [input.running]);

  return { state: derivePlayState(input), elapsed: input.running ? elapsed : 0 };
}
