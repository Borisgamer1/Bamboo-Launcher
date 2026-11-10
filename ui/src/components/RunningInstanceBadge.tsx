import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Clock } from "lucide-react";

interface RunningInstance {
  name: string;
  folderName?: string;
  startedAt: number;
}

interface RunningInstanceBadgeProps {
  instances: RunningInstance[];
  lang?: "de" | "en";
}

/** Wie lange eine Instanz im Footer stehen bleibt, bevor die nächste kommt. */
const ROTATE_MS = 4200;
/** Feste Breite, damit der Wechsel die Fußzeile nicht verschiebt. */
const SLOT_WIDTH = 248;

const formatUptime = (s: number) =>
  `${Math.floor(s / 3600).toString().padStart(2, "0")}:${Math.floor((s % 3600) / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

/**
 * Laufende Instanzen im Footer. Bei mehreren steht immer nur eine im selben
 * Platz; sie wechseln sich mit einer kurzen Bewegung ab. Beim Darüberfahren
 * hält der Wechsel an, damit man Name und Spielzeit in Ruhe lesen kann.
 */
export const RunningInstanceBadge: React.FC<RunningInstanceBadgeProps> = ({
  instances,
  lang = "de",
}) => {
  const [now, setNow] = useState(0);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (instances.length === 0) return;
    const update = () => setNow(Date.now());
    const first = window.setTimeout(update, 0);
    const id = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [instances.length]);

  // Eine neue Instanz übernimmt sofort den Platz, eine geschlossene lässt
  // keinen leeren Platz zurück.
  const previousCount = useRef(0);
  useEffect(() => {
    if (instances.length > previousCount.current) {
      setIndex(Math.max(0, instances.length - 1));
    } else {
      setIndex((current) => (current < instances.length ? current : 0));
    }
    previousCount.current = instances.length;
  }, [instances.length]);

  const cycling = instances.length > 1 && !paused;

  useEffect(() => {
    if (!cycling) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % instances.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [cycling, instances.length]);

  if (instances.length === 0) return null;

  const current = instances[Math.min(index, instances.length - 1)];
  const elapsed = now === 0 ? 0 : Math.max(0, Math.floor((now - current.startedAt) / 1000));
  const summary = instances.map((instance) => instance.name).join(", ");

  return (
    <div
      className="flex shrink-0 items-center justify-end"
      style={{ width: SLOT_WIDTH }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="group"
      aria-label={`${lang === "en" ? "Running instances" : "Laufende Instanzen"}: ${summary}`}
      title={summary}
    >
      <div className="relative flex h-5 min-w-0 flex-1 items-center justify-end overflow-hidden" aria-hidden>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.folderName || current.name}
            initial={reduceMotion ? { opacity: 0 } : { y: 14, opacity: 0, filter: "blur(6px)" }}
            animate={reduceMotion ? { opacity: 1 } : { y: 0, opacity: 1, filter: "blur(0px)" }}
            exit={reduceMotion ? { opacity: 0 } : { y: -14, opacity: 0, filter: "blur(6px)" }}
            transition={{
              duration: reduceMotion ? 0.12 : 0.34,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex min-w-0 items-center gap-1.5 whitespace-nowrap"
          >
            <span className="text-ink-tertiary font-medium">{lang === "en" ? "Active:" : "Aktiv:"}</span>
            <span className="max-w-[116px] truncate font-semibold text-ink">{current.name}</span>
            <Clock className="ml-1 h-3 w-3 shrink-0 text-ink-tertiary" />
            <span className="font-mono font-semibold tabular-nums text-ink">
              {formatUptime(elapsed)}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>

      {instances.length > 1 ? (
        <div className="ml-2 flex shrink-0 items-center gap-1" aria-hidden>
          {instances.map((instance, position) => {
            const active = position === index;
            return (
              <motion.span
                key={instance.folderName || instance.name}
                layout
                transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
                className={`h-1 rounded-full ${active ? "w-3 bg-accent" : "w-1 bg-raised"}`}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
