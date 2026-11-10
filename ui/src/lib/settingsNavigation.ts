const TARGET_KEY = 'bamboo-settings-section'
const LEGACY_TARGET_KEY = 'bamboo-settings-category'

export const SETTINGS_TARGET_EVENT = 'bamboo:settings-target'

export function readSettingsTarget(): string | null {
  return sessionStorage.getItem(TARGET_KEY) ?? sessionStorage.getItem(LEGACY_TARGET_KEY)
}

export function clearSettingsTarget(): void {
  sessionStorage.removeItem(TARGET_KEY)
  sessionStorage.removeItem(LEGACY_TARGET_KEY)
}

export function requestSettingsTarget(target: string): void {
  sessionStorage.setItem(TARGET_KEY, target)
  sessionStorage.removeItem(LEGACY_TARGET_KEY)
  window.dispatchEvent(new Event(SETTINGS_TARGET_EVENT))
}
