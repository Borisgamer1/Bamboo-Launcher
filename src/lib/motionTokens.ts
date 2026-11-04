import type { Transition } from "framer-motion";

const FALLBACK_MS = {
  "--t-instant": 90,
  "--t-quick": 120,
  "--t-base": 160,
  "--t-slow": 250,
  "--t-out": 350,
} as const;

const FALLBACK_EASE: Record<string, [number, number, number, number]> = {
  "--ease-out": [0.165, 0.84, 0.44, 1],
  "--ease-expo": [0.16, 1, 0.3, 1],
  "--ease-in-out": [0.645, 0.045, 0.355, 1],
  "--ease-back": [0.34, 1.56, 0.64, 1],
};

const readMs = (name: keyof typeof FALLBACK_MS): number => {
  if (typeof document === "undefined") return FALLBACK_MS[name] / 1000;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value / 1000 : FALLBACK_MS[name] / 1000;
};

const readEase = (name: keyof typeof FALLBACK_EASE): [number, number, number, number] => {
  if (typeof document === "undefined") return FALLBACK_EASE[name];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const match = raw.match(/cubic-bezier\(([^)]+)\)/);
  if (!match) return FALLBACK_EASE[name];
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  return parts.length === 4 && parts.every(Number.isFinite)
    ? (parts as [number, number, number, number])
    : FALLBACK_EASE[name];
};

export const MOTION = {
  instant: readMs("--t-instant"),
  quick: readMs("--t-quick"),
  base: readMs("--t-base"),
  slow: readMs("--t-slow"),
  out: readMs("--t-out"),
};

export const EASE = {
  out: readEase("--ease-out"),
  expo: readEase("--ease-expo"),
  inOut: readEase("--ease-in-out"),
  back: readEase("--ease-back"),
};

export const STAGGER = 0.02;
export const STAGGER_MAX = 5;
export const staggerDelay = (index: number) => Math.min(Math.max(index, 0), STAGGER_MAX) * STAGGER;

export const motionSafe = (transition: Transition): Transition => {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return { duration: 0 };
  }
  return transition;
};
