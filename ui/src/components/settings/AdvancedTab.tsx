import { useEffect, useState, type RefObject } from 'react'
import { translations } from '../../lib/translations';
import { Download, KeyRound, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { DEFAULT_PREFERENCES, type LauncherPreferences } from '../../lib/launcherPreferences'
import { DEFAULT_KEYBINDS } from '../../lib/keybinds'
import { DEFAULT_GAME_OPTIONS } from '../../lib/gameOptions'
import { Button, ConfirmButton, SettingsCard, SettingsRow, TextField, type Lang } from './SettingsPrimitives'
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
  const [keySet, setKeySet] = useState(false)
  const [keyValue, setKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keySaved, setKeySaved] = useState(false)

  useEffect(() => {
    let active = true
    void window.electronAPI?.settings.get?.()
      .then((snapshot) => {
        if (active && snapshot) setKeySet(snapshot.curseForgeApiKeySet === true)
      })
      .catch(() => {
        // Without settings the card still offers the input.
      })
    return () => { active = false }
  }, [])

  const saveKey = async (value: string) => {
    setSavingKey(true)
    try {
      const saved = await window.electronAPI?.settings.save?.({ curseForgeApiKey: value.trim() })
      if (!saved) return
      const snapshot = await window.electronAPI?.settings.get?.()
      setKeySet(snapshot?.curseForgeApiKeySet === true)
      setKeyValue('')
      setKeySaved(true)
      window.setTimeout(() => setKeySaved(false), 2500)
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title="CurseForge"
        description={t(
          L,
          'API-Key für Suche, Projektseiten und Modpack-Importe.',
          'API key for search, project pages and modpack imports.',
        )}
      >
        <SettingsRow
          icon={<KeyRound className="h-4 w-4" />}
          title={t(L, 'API-Key', 'API key')}
          description={
            keySet
              ? t(L, 'Ein Key ist hinterlegt. Ein neuer Wert ersetzt ihn.', 'A key is stored. A new value replaces it.')
              : t(
                  L,
                  'Ohne Key liefert CurseForge keine Ergebnisse. Kostenlos erstellen unter console.curseforge.com.',
                  'Without a key CurseForge returns no results. Create one for free at console.curseforge.com.',
                )
          }
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
              <TextField
                type="password"
                value={keyValue}
                onChange={setKeyValue}
                placeholder={keySet ? '••••••••••••' : '$CURSEFORGE_API_KEY'}
                ariaLabel={t(L, 'CurseForge API-Key', 'CurseForge API key')}
                className="w-full sm:w-56"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={savingKey || !keyValue.trim()}
                onClick={() => void saveKey(keyValue)}
              >
                {savingKey ? t(L, 'Speichere…', 'Saving…') : t(L, 'Speichern', 'Save')}
              </Button>
              {keySet && (
                <Button variant="ghost" size="sm" disabled={savingKey} onClick={() => void saveKey('')}>
                  {t(L, 'Entfernen', 'Remove')}
                </Button>
              )}
            </div>
          }
        />
        {keySaved && (
          <p className="m-0 border-t border-hairline px-5 py-2 text-micro text-success">
            {t(L, 'Key gespeichert.', 'Key saved.')}
          </p>
        )}
      </SettingsCard>

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
