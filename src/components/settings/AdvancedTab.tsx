import { type RefObject } from 'react'
import { translations } from '../../lib/translations';
import { Download, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { DEFAULT_PREFERENCES, type LauncherPreferences } from '../../lib/launcherPreferences'
import { DEFAULT_KEYBINDS } from '../../lib/keybinds'
import { DEFAULT_GAME_OPTIONS } from '../../lib/gameOptions'
import { Button, ConfirmButton, SettingsCard, SettingsRow, type Lang } from './SettingsPrimitives'
import { t } from './settingsUtils'

export interface AdvancedTabProps {
  lang: Lang
  setPreferences: (preferences: LauncherPreferences) => void
  importRef: RefObject<HTMLInputElement | null>
  onExport: () => void
  onImport: (file: File) => Promise<void> | void
  onReset: () => void
}

/** Backup, reset and the plain-language note about what exports contain. */
export function AdvancedTab({
  lang: L,
  setPreferences,
  importRef,
  onExport,
  onImport,
  onReset,
}: AdvancedTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={t(L, 'Sicherung', 'Backup')}
        description={t(
          L,
          'Einstellungen als JSON-Datei sichern und wieder einlesen.',
          'Save settings as a JSON file and read them back in.',
        )}
      >
        <SettingsRow
          title={t(L, 'Einstellungen exportieren', 'Export settings')}
          description={t(
            L,
            'Enthält Profilwerte, Tastenbelegung und Spieloptionen.',
            'Includes profile values, keybinds and game options.',
          )}
          control={
            <Button variant="secondary" size="sm" onClick={onExport} icon={<Download className="h-3.5 w-3.5" />}>
              {translations[L].common.export}
            </Button>
          }
        />
        <SettingsRow
          title={t(L, 'Einstellungen importieren', 'Import settings')}
          description={t(L, 'Liest eine zuvor exportierte Datei ein.', 'Reads a previously exported file.')}
          control={
            <>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void onImport(file)
                  event.target.value = ''
                }}
              />
              <Button variant="secondary" size="sm" onClick={() => importRef.current?.click()} icon={<Upload className="h-3.5 w-3.5" />}>
                {t(L, 'Importieren', 'Import')}
              </Button>
            </>
          }
        />
      </SettingsCard>

      <div className="flex items-start gap-3 px-1">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary" />
        <p className="m-0 text-mini leading-5 text-ink-secondary">
          {t(
            L,
            'Microsoft-Tokens bleiben im OS-Tresor. Exporte enthalten keine Konten oder Tokens.',
            'Microsoft tokens stay in the OS secret store. Exports contain no accounts or tokens.',
          )}
        </p>
      </div>

      <SettingsCard
        title={translations[L].common.reset}
        description={t(
          L,
          'RAM, Java, Tastenbelegung, Spieloptionen und Verhalten zurücksetzen.',
          'Reset RAM, Java, keybinds, game options and behavior.',
        )}
        className="border-danger/25"
      >
        <SettingsRow
          title={t(L, 'Alle Launcher-Einstellungen zurücksetzen', 'Reset all launcher settings')}
          description={t(L, 'Themes, Sprache und Darstellung bleiben erhalten.', 'Themes, language and appearance stay untouched.')}
          control={
            <ConfirmButton
              onConfirm={() => {
                setPreferences({ ...DEFAULT_PREFERENCES, keybinds: { ...DEFAULT_KEYBINDS }, gameOptions: { ...DEFAULT_GAME_OPTIONS } })
                onReset()
              }}
              confirmLabel={translations[L].common.resetConfirm}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
            >
              {translations[L].common.reset}
            </ConfirmButton>
          }
        />
      </SettingsCard>
    </div>
  )
}
