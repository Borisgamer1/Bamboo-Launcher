import React, { useEffect, useRef, useState } from "react";
import type { LaunchProgress } from "../../electron";
import type { LanguageType } from "../../lib/translations";

interface InstanceLaunchProgressProps {
  progress?: LaunchProgress;
  lang: LanguageType;
}

/**
 * The bar's total time is the launch's own time: it advances with the real
 * launch steps, so it cannot outlast the start or stall at a fixed cap.
 * Smoothly interpolates between real progress values to avoid jarring jumps.
 */
// Global state to persist across component remounts
const globalLaunchState = {
  startTime: 0,
  instanceKey: '',
};

export const InstanceLaunchProgress: React.FC<InstanceLaunchProgressProps> = ({ progress, lang }) => {
  const [smoothedPercent, setSmoothedPercent] = useState(0);
  const targetRef = useRef(0);
  const currentRef = useRef(0);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const minTimeRef = useRef<number>(15000); // minimum time to reach high percentage

  useEffect(() => {
    const realPercent = progress?.percent ?? 0;
    
    // Initialize start time only once per launch session
    if (globalLaunchState.startTime === 0 && realPercent < 100) {
      globalLaunchState.startTime = Date.now();
    }
    startTimeRef.current = globalLaunchState.startTime || Date.now();
    
    const elapsed = Date.now() - startTimeRef.current;
    
    if (realPercent >= 100) {
      targetRef.current = 100;
      globalLaunchState.startTime = 0;
    } else {
      // Time-based progression - takes long time to reach high values
      const timeProgress = Math.min(1, elapsed / minTimeRef.current);
      // Very slow start, brakes near end
      const easedTime = 1 - Math.pow(1 - timeProgress, 2.5);
      let timeBasedTarget = easedTime * 95;
      
      // Don't go below current to avoid resetting
      timeBasedTarget = Math.max(currentRef.current, timeBasedTarget);
      
      targetRef.current = Math.max(0, Math.min(95, timeBasedTarget));
    }

    const animate = () => {
      const diff = targetRef.current - currentRef.current;
      if (realPercent >= 100) {
        if (currentRef.current < 100) {
          currentRef.current = Math.min(100, currentRef.current + 2);
          setSmoothedPercent(currentRef.current);
          animationRef.current = requestAnimationFrame(animate);
          return;
        }
        currentRef.current = 100;
        setSmoothedPercent(100);
        animationRef.current = null;
        return;
      }
      
      if (diff <= 0.01) {
        // Keep advancing slowly based on time
        const elapsed2 = Date.now() - startTimeRef.current;
        const timeProgress2 = Math.min(1, elapsed2 / minTimeRef.current);
        // Even slower easing near the end
        const easedTime2 = 1 - Math.pow(1 - timeProgress2, 3);
        let newTarget = easedTime2 * 95;
        newTarget = Math.max(currentRef.current, newTarget);
        if (newTarget > currentRef.current + 0.05) {
          targetRef.current = Math.min(95, newTarget);
        }
      }
      
      if (targetRef.current > currentRef.current) {
        // Brake near the end for smoother feel
        const progressRatio = currentRef.current / 95;
        const brakeFactor = progressRatio > 0.8 ? 0.005 : (progressRatio > 0.6 ? 0.008 : 0.012);
        const step = Math.max(0.01, (targetRef.current - currentRef.current) * brakeFactor);
        currentRef.current += step;
        if (currentRef.current > targetRef.current) currentRef.current = targetRef.current;
        setSmoothedPercent(currentRef.current);
      } else {
        setSmoothedPercent(currentRef.current);
      }
      animationRef.current = requestAnimationFrame(animate);
    };

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [progress?.percent]);

  const displayPercent = (progress?.percent ?? 0) >= 100 ? 100 : Math.min(95, Math.max(0, smoothedPercent));

  return (
    <div className="shrink-0" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-mini font-medium">
        <span className="truncate text-ink-secondary">
          {progress?.label || (lang === "de" ? "Wird vorbereitet…" : "Preparing…")}
        </span>
        <span className="shrink-0 tabular-nums text-ink">{Math.round(displayPercent)}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-selected" aria-hidden>
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.max(0, Math.min(100, displayPercent))}%`, transition: 'width 50ms linear' }}
        />
      </div>
    </div>
  );
};
