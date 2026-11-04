import type { LanguageType } from '../../lib/translations'
import type { LauncherFont } from '../../lib/launcherFont'
import {
  Segmented,
  SettingsCard,
  SettingsRow,
  type Lang,
} from './SettingsPrimitives'
import { t } from './settingsUtils'

export function FontSettingsCard({
  lang,
  value,
  onChange,
}: {
  lang: LanguageType
  value: LauncherFont
  onChange: (font: LauncherFont) => void
}) {
  const L = lang as Lang
  return (
    <SettingsCard
      title={t(L, 'Schriftart', 'Typeface')}
      description={t(L, 'Gilt für die gesamte Oberfläche.', 'Applies to the whole interface.')}
    >
      <SettingsRow
        title={t(L, 'Launcher-Schrift', 'Launcher font')}
        description={t(
          L,
          'Minecraft-Stil nutzt die mitgelieferte Pixel-Schrift Monocraft.',
          'Minecraft style uses the bundled Monocraft pixel font.',
        )}
        control={
          <Segmented
            value={value}
            onChange={onChange}
            options={[
              { value: 'normal', label: t(L, 'Normal', 'Normal') },
              { value: 'minecraft', label: t(L, 'Minecraft-Stil', 'Minecraft style') },
            ]}
          />
        }
      />
    </SettingsCard>
  )
}
