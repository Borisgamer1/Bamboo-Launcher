import type { LanguageType } from '../../lib/translations'
import type { StatisticsState } from '../../hooks/useStatistics'
import { StatisticsPanel } from './StatisticsPanel'

export function StatisticsSettingsTab({
  lang,
  statistics,
  statisticsEnabled,
  setStatisticsEnabled,
}: {
  lang: LanguageType
  statistics: StatisticsState
  statisticsEnabled: boolean
  setStatisticsEnabled: (enabled: boolean) => void
}) {
  return (
    <StatisticsPanel
      lang={lang}
      statistics={statistics}
      statisticsEnabled={statisticsEnabled}
      setStatisticsEnabled={setStatisticsEnabled}
    />
  )
}
