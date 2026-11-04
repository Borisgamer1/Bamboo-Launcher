/**
 * The launch progress the user sees. It is driven by the real launch steps, so
 * 0 → 100 covers exactly the time the launch takes: the bar reaches 100 with the
 * ready signal and never outlives it. Only the shape is synthetic — a smooth
 * exponential curve keeps the first seconds calm and accelerates gently
 * throughout, building patience without big jumps.
 */
export const LAUNCH_PROGRESS_CAP = 97;

// Much more exponential: stays very low for a long time, rises very late
const EXPONENTIAL_K = 4.5;

export function launchDisplayPercent(realPercent: number): number {
  if (!Number.isFinite(realPercent) || realPercent <= 0) return 0;
  if (realPercent >= 100) return 100;
  const ratio = Math.min(1, Math.max(0, realPercent / 100));
  // Normalized exponential curve: (e^(k*r) - 1) / (e^k - 1)
  const exponentialValue = (Math.exp(EXPONENTIAL_K * ratio) - 1) / (Math.exp(EXPONENTIAL_K) - 1);
  return Math.min(LAUNCH_PROGRESS_CAP, 100 * exponentialValue);
}
