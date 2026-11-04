/**
 * First-run state lives in settings.json, so "tour seen" survives a cache reset
 * and has exactly one owner next to theme and language.
 */
export interface OnboardingState {
  tourDone: boolean
  /** Launcher version whose changelog was shown; empty means never. */
  lastSeenVersion: string
}

export const DEFAULT_ONBOARDING: OnboardingState = {
  tourDone: false,
  lastSeenVersion: '',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeOnboarding(value: unknown): OnboardingState {
  if (!isRecord(value)) return { ...DEFAULT_ONBOARDING }
  return {
    tourDone: value.tourDone === true,
    lastSeenVersion: typeof value.lastSeenVersion === 'string' ? value.lastSeenVersion : '',
  }
}

export function shouldShowTour(state: OnboardingState): boolean {
  return !state.tourDone
}

export function shouldShowChangelog(state: OnboardingState, currentVersion: string): boolean {
  return state.lastSeenVersion !== currentVersion
}
