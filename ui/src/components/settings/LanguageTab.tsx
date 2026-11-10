import { Check } from 'lucide-react'
import { MINECRAFT_LANGUAGES } from '../../lib/gameOptions'
import type { LauncherPreferences } from '../../lib/launcherPreferences'
import { SettingsCard, SettingsRow, SelectField, type Lang } from './SettingsPrimitives'
import { t } from './settingsUtils'

export interface LanguageTabProps {
  lang: Lang
  onLauncherLanguage: (lang: Lang) => void
  preferences: LauncherPreferences
  updatePreferences: (updater: (current: LauncherPreferences) => LauncherPreferences) => void
}

/** Launcher and in-game language for new instances. */
export function LanguageTab({ lang: L, onLauncherLanguage, preferences, updatePreferences }: LanguageTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={t(L, 'Launcher-Sprache', 'Launcher language')}
        description={t(L, 'Gilt sofort für alle Ansichten.', 'Applies to every view immediately.')}
      >
        {[
          { id: 'de' as const, title: 'Deutsch', tag: 'DE' },
          { id: 'en' as const, title: 'English', tag: 'EN' },
        ].map((option) => {
          const active = L === option.id
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onLauncherLanguage(option.id)}
              className="flex w-full items-center gap-4 border-t border-hairline px-5 py-3.5 text-left transition-colors duration-[var(--t-quick)] hover:bg-hover first:border-t-0 cursor-pointer"
            >
              <span className="w-6 shrink-0 font-mono text-micro tabular-nums text-ink-tertiary">
                {option.tag}
              </span>
              <span className="min-w-0 flex-1 text-small font-medium text-ink">{option.title}</span>
              {active && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          )
        })}
      </SettingsCard>

      <SettingsCard
        title={t(L, 'Minecraft-Sprache', 'Minecraft language')}
        description={t(
          L,
          'Wird bei jedem Start in die options.txt der Instanz geschrieben und überschreibt eine im Spiel gewählte Sprache.',
          'Written to the instance’s options.txt on every launch, overriding a language picked in game.',
        )}
      >
        <SettingsRow
          title={t(L, 'Spielsprache', 'In-game language')}
          control={
            <SelectField
              value={preferences.instanceDefaults.minecraftLanguage}
              onChange={(value) =>
                updatePreferences((current) => ({
                  ...current,
                  instanceDefaults: { ...current.instanceDefaults, minecraftLanguage: value },
                }))
              }
              options={MINECRAFT_LANGUAGES.map((entry) => ({
                value: entry.code,
                label: entry.name,
              }))}
              className="w-52"
              ariaLabel={t(L, 'Minecraft-Sprache', 'Minecraft language')}
            />
          }
        />
      </SettingsCard>
    </div>
  )
}
