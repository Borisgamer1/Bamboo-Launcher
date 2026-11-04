/**
 * The launch progress the user sees. It is driven by the real launch steps, so
 * 0 → 100 covers exactly the time the launch takes: the bar reaches 100 with the
 * ready signal and never outlives it. Only the shape is synthetic — a smooth
 * exponential curve keeps the first seconds calm and accelerates gently
 * throughout, building patience without big jumps.
 */
export const LAUNCH_PROGRESS_CAP = 97;

// Below 1 so the bar stays calm early and accelerates: at 30% real progress it
// shows 11, at 80% it shows 68. The display never reaches 100 before ready.
const CURVE_EXPONENT = 1.8;

export function launchDisplayPercent(realPercent: number): number {
  if (!Number.isFinite(realPercent) || realPercent <= 0) return 0;
  if (realPercent >= 100) return 100;
  const ratio = Math.min(1, Math.max(0, realPercent / 100));
  return Math.min(LAUNCH_PROGRESS_CAP, 100 * Math.pow(ratio, CURVE_EXPONENT));
}
