import { RotateCcw, Search } from 'lucide-react'
import { translations } from '../../lib/translations';
import {
  DEFAULT_PREFERENCES,
  RAM_MAX_MB,
  RAM_MIN_MB,
  RAM_STEP_MB,
  type LauncherPreferences,
} from '../../lib/launcherPreferences'
import {
  Button,
  SettingsCard,
  SettingsRow,
  SelectField,
  Slider,
  TextField,
  type Lang,
} from './SettingsPrimitives'
import { t } from './settingsUtils'

interface JavaVersion {
  path: string
  version: number
  verStr: string
}

export interface JavaTabProps {
  lang: Lang
  preferences: LauncherPreferences
  updatePreferences: (updater: (current: LauncherPreferences) => LauncherPreferences) => void
  javaVersions: JavaVersion[]
  scanningJava: boolean
  onScan: () => void
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`
}

/** Memory and Java defaults for new instances. */
export function JavaTab({
  lang: L,
  preferences,
  updatePreferences,
  javaVersions,
  scanningJava,
  onScan,
}: JavaTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={t(L, 'Arbeitsspeicher', 'Memory')}
        description={t(L, 'Gilt als Standard für neue Instanzen.', 'The default for new instances.')}
      >
        <SettingsRow
          title={t(L, 'Maximaler RAM (-Xmx)', 'Maximum RAM (-Xmx)')}
          description={
            preferences.instanceDefaults.ramMb > 12288
              ? t(L, 'Über 12 GB kann GC-Lags verursachen.', 'Above 12 GB can cause GC stalls.')
              : t(L, '4–8 GB empfohlen.', '4–8 GB recommended.')
          }
          badge={
            preferences.instanceDefaults.ramMb < 2048 ? (
              <span className="text-micro text-warning">{t(L, 'Sehr wenig', 'Very low')}</span>
            ) : undefined
          }
          control={
            <div className="w-[300px] max-w-[46vw]">
              <Slider
                min={RAM_MIN_MB}
                max={RAM_MAX_MB}
                step={RAM_STEP_MB}
                value={preferences.instanceDefaults.ramMb}
                onChange={(value) =>
                  updatePreferences((current) => ({
                    ...current,
                    instanceDefaults: {
                      ...current.instanceDefaults,
                      ramMb: value,
                      minRamMb: Math.min(current.instanceDefaults.minRamMb, value),
                    },
                  }))
                }
                formatValue={gb}
                minLabel="1 GB"
                maxLabel="16 GB"
              />
            </div>
          }
        />
        <SettingsRow
          title={t(L, 'Minimaler RAM (-Xms)', 'Minimum RAM (-Xms)')}
          description={t(L, 'Meist reicht 1 GB.', 'Usually 1 GB is enough.')}
          control={
            <div className="w-[300px] max-w-[46vw]">
              <Slider
                min={512}
                max={preferences.instanceDefaults.ramMb}
                step={256}
                value={preferences.instanceDefaults.minRamMb}
                onChange={(value) =>
                  updatePreferences((current) => ({
                    ...current,
                    instanceDefaults: { ...current.instanceDefaults, minRamMb: value },
                  }))
                }
                formatValue={gb}
              />
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title={t(L, 'Java', 'Java')}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Search className="h-3 w-3" />}
            onClick={onScan}
            disabled={scanningJava}
          >
            {scanningJava ? t(L, 'Suche …', 'Scanning …') : t(L, 'Java suchen', 'Find Java')}
          </Button>
        }
      >
        <SettingsRow
          title={translations[L].common.javaInstallation}
          control={
            <SelectField
              value={preferences.instanceDefaults.javaPath}
              onChange={(value) =>
                updatePreferences((current) => ({
                  ...current,
                  instanceDefaults: { ...current.instanceDefaults, javaPath: value },
                }))
              }
              options={[
                { value: '', label: t(L, 'Automatisch (empfohlen)', 'Automatic (recommended)') },
                ...javaVersions.map((entry) => ({
                  value: entry.path,
                  label: `Java ${entry.verStr || entry.version} — ${entry.path}`,
                })),
                ...(preferences.instanceDefaults.javaPath &&
                !javaVersions.some((entry) => entry.path === preferences.instanceDefaults.javaPath)
                  ? [{ value: preferences.instanceDefaults.javaPath, label: preferences.instanceDefaults.javaPath }]
                  : []),
              ]}
              className="w-[280px] max-w-[46vw]"
              ariaLabel={translations[L].common.javaInstallation}
            />
          }
        />
        <SettingsRow
          title={translations[L].common.jvmArguments}
          description={t(L, 'Optional, z. B. -XX:+UseG1GC.', 'Optional, e.g. -XX:+UseG1GC.')}
          control={
            <div className="w-[420px] max-w-[46vw]">
              <TextField
                value={preferences.instanceDefaults.jvmArgs}
                onChange={(value) =>
                  updatePreferences((current) => ({
                    ...current,
                    instanceDefaults: { ...current.instanceDefaults, jvmArgs: value },
                  }))
                }
                placeholder="-XX:+UseG1GC -XX:+ParallelRefProcEnabled"
                mono
                ariaLabel={translations[L].common.jvmArguments}
              />
            </div>
          }
        />
      </SettingsCard>

      <Button
        variant="ghost"
        icon={<RotateCcw className="h-3.5 w-3.5" />}
        onClick={() =>
          updatePreferences((current) => ({
            ...current,
            instanceDefaults: { ...DEFAULT_PREFERENCES.instanceDefaults },
          }))
        }
        className="self-end"
      >
        {t(L, 'Java & Speicher zurücksetzen', 'Reset Java & memory')}
      </Button>
    </div>
  )
}
