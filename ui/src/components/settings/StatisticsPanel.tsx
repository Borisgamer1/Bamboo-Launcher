import React, { useMemo, useState } from 'react'
import { translations } from '../../lib/translations';
import {
  ArrowDown,
  Boxes,
  ChevronDown,
  Droplets,
  EyeOff,
  Feather,
  Fish,
  Flame,
  Footprints,
  Gamepad2,
  Ghost,
  Mountain,
  Pickaxe,
  PiggyBank,
  Rabbit,
  Route,
  RefreshCw,
  Sailboat,
  Skull,
  Swords,
  TrainFront,
  TriangleAlert,
  Waves,
  Wind,
  Zap,
} from 'lucide-react'
import { formatDate, formatPlaytime } from '../../lib/launcherPreferences'
import { localeFor, type LanguageType } from '../../lib/translations'
import type { DistanceStats } from '../../electron'
import type { StatisticsState } from '../../hooks/useStatistics'
import {
  Button,
  EmptyHint,
  SettingsCard,
  SettingsRow,
  Toggle,
  type Lang,
} from './SettingsPrimitives'
import { cx, t } from './settingsUtils'

interface StatisticsPanelProps {
  lang: LanguageType
  statistics: StatisticsState
  statisticsEnabled: boolean
  setStatisticsEnabled: (enabled: boolean) => void
}

const DISTANCE_ROWS: Array<{
  key: keyof DistanceStats
  label: [string, string]
  icon: React.ElementType
}> = [
  { key: 'walkCm', label: ['Zu Fuß', 'Walked'], icon: Footprints },
  { key: 'sprintCm', label: ['Gesprintet', 'Sprinted'], icon: Zap },
  { key: 'crouchCm', label: ['Geschlichen', 'Crouched'], icon: EyeOff },
  { key: 'swimCm', label: ['Geschwommen', 'Swum'], icon: Waves },
  { key: 'flyCm', label: ['Geflogen', 'Flown'], icon: Feather },
  { key: 'climbCm', label: ['Geklettert', 'Climbed'], icon: Mountain },
  { key: 'fallCm', label: ['Gefallen', 'Fallen'], icon: ArrowDown },
  { key: 'walkOnWaterCm', label: ['Auf Wasser', 'On water'], icon: Droplets },
  { key: 'walkUnderWaterCm', label: ['Unter Wasser', 'Under water'], icon: Fish },
  { key: 'aviateCm', label: ['Elytren-Flug', 'Aviated'], icon: Wind },
  { key: 'minecartCm', label: ['Minecart', 'Minecart'], icon: TrainFront },
  { key: 'boatCm', label: ['Boot', 'Boat'], icon: Sailboat },
  { key: 'pigCm', label: ['Schwein', 'Pig'], icon: PiggyBank },
  { key: 'horseCm', label: ['Pferd', 'Horse'], icon: Route },
  { key: 'striderCm', label: ['Strider', 'Strider'], icon: Flame },
  { key: 'happyGhastCm', label: ['Happy Ghast', 'Happy Ghast'], icon: Ghost },
]

function formatCount(value: number, lang: LanguageType): string {
  return Math.max(0, value).toLocaleString(localeFor(lang))
}

function formatDistance(cm: number, lang: LanguageType): string {
  const locale = localeFor(lang)
  const meters = Math.max(0, cm) / 100
  if (meters < 1000) return `${Math.round(meters).toLocaleString(locale)} m`
  return `${(meters / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} km`
}

function totalDistance(distance: DistanceStats): number {
  return DISTANCE_ROWS.reduce((sum, row) => sum + (distance[row.key] || 0), 0)
}

function loaderLabel(loader: string): string {
  if (!loader) return 'Vanilla'
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

function MetricLine({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-b border-hairline/60 py-2 last:border-b-0">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-quaternary" />
      <span className="min-w-0 flex-1 truncate text-mini text-ink-secondary">{label}</span>
      <span className="shrink-0 font-mono text-mini tabular-nums text-ink">{value}</span>
    </div>
  )
}

function DistanceList({
  distance,
  lang,
  wide = false,
}: {
  distance: DistanceStats
  lang: LanguageType
  wide?: boolean
}) {
  const L = lang as Lang
  return (
    <div className={cx('grid grid-cols-1 gap-x-6 sm:grid-cols-2', wide && 'xl:grid-cols-4')}>
      {DISTANCE_ROWS.map((row) => (
        <MetricLine
          key={row.key}
          icon={row.icon}
          label={t(L, row.label[0], row.label[1])}
          value={formatDistance(distance[row.key], lang)}
        />
      ))}
    </div>
  )
}

function CounterList({
  blocksMined,
  blocksPlaced,
  mobsKilled,
  deaths,
  jumps,
  lang,
}: {
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
  lang: LanguageType
}) {
  const L = lang as Lang
  const rows = [
    {
      key: 'blocksMined',
      label: t(L, 'Blöcke abgebaut', 'Blocks mined'),
      value: formatCount(blocksMined, lang),
      icon: Pickaxe,
    },
    {
      key: 'blocksPlaced',
      label: t(L, 'Blöcke gesetzt', 'Blocks placed'),
      value: formatCount(blocksPlaced, lang),
      icon: Boxes,
    },
    {
      key: 'mobsKilled',
      label: t(L, 'Mobs getötet', 'Mobs killed'),
      value: formatCount(mobsKilled, lang),
      icon: Swords,
    },
    {
      key: 'deaths',
      label: t(L, 'Tode', 'Deaths'),
      value: formatCount(deaths, lang),
      icon: Skull,
    },
    {
      key: 'jumps',
      label: t(L, 'Sprünge', 'Jumps'),
      value: formatCount(jumps, lang),
      icon: Rabbit,
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
      {rows.map((row) => (
        <MetricLine key={row.key} icon={row.icon} label={row.label} value={row.value} />
      ))}
    </div>
  )
}

function GroupHeading({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <p className="m-0 mb-1 flex items-center gap-1.5 text-micro font-medium text-ink-tertiary">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </p>
  )
}

function emptyDistance(): DistanceStats {
  const distance = {} as DistanceStats
  for (const row of DISTANCE_ROWS) distance[row.key] = 0
  return distance
}

interface VersionGroup {
  version: string
  loaders: string
  instances: number
  worlds: number
  playTimeMs: number
  sessions: number
  distance: DistanceStats
  blocksMined: number
  blocksPlaced: number
  mobsKilled: number
  deaths: number
  jumps: number
}

function VersionSection({
  group,
  lang,
  defaultOpen,
}: {
  group: VersionGroup
  lang: LanguageType
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const L = lang as Lang
  return (
    <section className="border-t border-hairline first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-hover"
      >
        <Gamepad2 className="h-4 w-4 shrink-0 text-ink-tertiary" />
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-small font-medium text-ink">{group.version}</p>
          <p className="m-0 mt-0.5 truncate text-micro text-ink-tertiary">
            {group.loaders || 'Vanilla'} · {formatCount(group.instances, lang)}{' '}
            {group.instances === 1 ? t(L, 'Instanz', 'instance') : t(L, 'Instanzen', 'instances')} ·{' '}
            {formatCount(group.worlds, lang)} {group.worlds === 1 ? t(L, 'Welt', 'world') : t(L, 'Welten', 'worlds')}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="m-0 text-small font-medium tabular-nums text-ink">
            {formatPlaytime(group.playTimeMs, lang)}
          </p>
          <p className="m-0 text-micro text-ink-tertiary">
            {formatCount(group.sessions, lang)} {group.sessions === 1 ? t(L, 'Session', 'session') : t(L, 'Sessions', 'sessions')}
          </p>
        </div>
        <ChevronDown
          className={cx('h-4 w-4 shrink-0 text-ink-tertiary transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="px-5 pb-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <GroupHeading icon={Footprints}>{t(L, 'Distanz', 'Distance')}</GroupHeading>
            <span className="font-mono text-micro tabular-nums text-ink">
              {formatDistance(totalDistance(group.distance), lang)}
            </span>
          </div>
          <DistanceList distance={group.distance} lang={lang} />
          <div className="mt-3">
            <GroupHeading icon={Pickaxe}>{t(L, 'Blöcke & Mobs', 'Blocks & mobs')}</GroupHeading>
            <CounterList
              blocksMined={group.blocksMined}
              blocksPlaced={group.blocksPlaced}
              mobsKilled={group.mobsKilled}
              deaths={group.deaths}
              jumps={group.jumps}
              lang={lang}
            />
          </div>
        </div>
      )}
    </section>
  )
}

export const StatisticsPanel: React.FC<StatisticsPanelProps> = ({
  lang,
  statistics,
  statisticsEnabled,
  setStatisticsEnabled,
}) => {
  const L = lang as Lang
  const { summary, loading, error, refresh } = statistics
  // One section per Minecraft version that was actually played. Versions only
  // present because an instance still exists would be noise, not statistics.
  const perVersion = useMemo(() => {
    const groups = new Map<string, VersionGroup>()
    for (const entry of summary?.perInstance ?? []) {
      if (entry.playTimeMs <= 0 && entry.sessions <= 0 && entry.worlds <= 0) continue
      const version = entry.version || '—'
      const group = groups.get(version) ?? {
        version,
        loaders: '',
        instances: 0,
        worlds: 0,
        playTimeMs: 0,
        sessions: 0,
        distance: emptyDistance(),
        blocksMined: 0,
        blocksPlaced: 0,
        mobsKilled: 0,
        deaths: 0,
        jumps: 0,
      }
      group.instances += 1
      group.worlds += entry.worlds
      group.playTimeMs += entry.playTimeMs
      group.sessions += entry.sessions
      for (const row of DISTANCE_ROWS) group.distance[row.key] += entry.distance[row.key] || 0
      group.blocksMined += entry.blocksMined
      group.blocksPlaced += entry.blocksPlaced
      group.mobsKilled += entry.mobsKilled
      group.deaths += entry.deaths
      group.jumps += entry.jumps
      const loader = loaderLabel(entry.loader)
      if (loader && !group.loaders.split(', ').includes(loader)) {
        group.loaders = group.loaders ? `${group.loaders}, ${loader}` : loader
      }
      groups.set(version, group)
    }
    return [...groups.values()].sort(
      (left, right) =>
        right.playTimeMs - left.playTimeMs ||
        left.version.localeCompare(right.version, localeFor(lang), { numeric: true }),
    )
  }, [summary, lang])
  const updatedAt = summary?.generatedAt
    ? new Date(summary.generatedAt).toLocaleTimeString(localeFor(lang), {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
  const instanceLabel = summary?.instances === 1
    ? t(L, 'Instanz', 'instance')
    : t(L, 'Instanzen', 'instances')
  const worldLabel = summary?.worlds === 1
    ? t(L, 'Welt', 'world')
    : t(L, 'Welten', 'worlds')

  return (
    <div className="flex flex-col gap-4">
      {!statisticsEnabled && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[var(--r-xl)] border border-warning/25 bg-warning/5 px-4 py-3.5"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="m-0 text-small font-medium text-ink">
              {t(L, 'Erfassung ist ausgeschaltet', 'Recording is off')}
            </p>
            <p className="m-0 mt-0.5 text-mini leading-5 text-ink-secondary">
              {t(
                L,
                'Neue Spielzeit und Sessions werden nicht gespeichert. Bereits erfasste Werte bleiben sichtbar.',
                'New playtime and sessions are not saved. Already recorded values stay visible.',
              )}
            </p>
          </div>
        </div>
      )}

      <SettingsCard title={t(L, 'Erfassung', 'Recording')}>
        <SettingsRow
          title={t(L, 'Statistiken erfassen', 'Record statistics')}
          description={t(
            L,
            'Ausschalten stoppt neue Sessions sofort.',
            'Turning this off stops new sessions immediately.',
          )}
          control={
            <div className="flex items-center gap-3">
              <span className={cx('text-micro', statisticsEnabled ? 'text-ink-tertiary' : 'text-warning')}>
                {statisticsEnabled ? t(L, 'An', 'On') : t(L, 'Aus', 'Off')}
              </span>
              <Toggle
                checked={statisticsEnabled}
                onChange={setStatisticsEnabled}
                label={t(L, 'Statistiken', 'Statistics')}
              />
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title={t(L, 'Gesamt', 'Total')}
        description={t(
          L,
          'Spielzeit aus den Welt-Statistiken, Sessions aus den Starts des Launchers.',
          'Playtime from the world stats, sessions from the launcher\'s own launches.',
        )}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={cx('h-3.5 w-3.5', loading && 'animate-spin')} />}
            onClick={refresh}
            disabled={loading}
          >
            {t(L, 'Aktualisieren', 'Refresh')}
          </Button>
        }
      >
        {error ? (
          <div>
            <EmptyHint>
              {error === 'not-available'
                ? t(L, 'Statistiken sind in der Vorschau nicht verfügbar.', 'Statistics are unavailable in the preview.')
                : t(L, 'Statistiken konnten nicht geladen werden.', 'Statistics could not be loaded.')}
            </EmptyHint>
          </div>
        ) : !summary ? (
          <div>
            <EmptyHint>{t(L, 'Statistiken werden geladen …', 'Loading statistics …')}</EmptyHint>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-6 px-5 pb-5 pt-4">
              <div className="min-w-0">
                <p className="m-0 text-micro text-ink-tertiary">{translations[L].common.playtime}</p>
                <p className="m-0 mt-1 truncate text-title1 font-medium tabular-nums tracking-[-0.02em] text-ink">
                  {formatPlaytime(summary.playTimeMs, lang)}
                </p>
                <p className="m-0 mt-1 text-mini text-ink-secondary">
                  {formatCount(summary.sessions, lang)} Sessions
                  <span className="mx-1.5 text-ink-quaternary">·</span>
                  {formatCount(summary.instances, lang)} {instanceLabel}
                  <span className="mx-1.5 text-ink-quaternary">·</span>
                  {formatCount(summary.worlds, lang)} {worldLabel}
                </p>
              </div>
              <div className="grid shrink-0 grid-cols-[auto_auto] gap-x-4 gap-y-1 text-micro">
                <span className="text-ink-tertiary">{t(L, 'Erste Session', 'First session')}</span>
                <span className="text-right font-mono tabular-nums text-ink-secondary">
                  {summary.firstPlayedAt ? formatDate(summary.firstPlayedAt, lang) : '—'}
                </span>
                <span className="text-ink-tertiary">{t(L, 'Letzte Session', 'Last session')}</span>
                <span className="text-right font-mono tabular-nums text-ink-secondary">
                  {summary.lastPlayedAt ? formatDate(summary.lastPlayedAt, lang) : '—'}
                </span>
                <span className="text-ink-tertiary">{t(L, 'Zuletzt gelesen', 'Last read')}</span>
                <span className="text-right font-mono tabular-nums text-ink-secondary">{updatedAt}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-px border-t border-hairline bg-hairline sm:grid-cols-3 xl:grid-cols-5">
              {[
                { label: t(L, 'Blöcke abgebaut', 'Blocks mined'), value: formatCount(summary.blocksMined, lang) },
                { label: t(L, 'Blöcke gesetzt', 'Blocks placed'), value: formatCount(summary.blocksPlaced, lang) },
                { label: t(L, 'Mobs getötet', 'Mobs killed'), value: formatCount(summary.mobsKilled, lang) },
                { label: t(L, 'Tode', 'Deaths'), value: formatCount(summary.deaths, lang) },
                { label: t(L, 'Sprünge', 'Jumps'), value: formatCount(summary.jumps, lang) },
              ].map((entry) => (
                <div key={entry.label} className="bg-canvas px-5 py-3">
                  <p className="m-0 text-micro text-ink-tertiary">{entry.label}</p>
                  <p className="m-0 mt-0.5 font-mono text-small tabular-nums text-ink">{entry.value}</p>
                </div>
              ))}
            </div>

            {summary.worlds === 0 ? (
              <div className="border-t border-hairline">
                <EmptyHint>
                  {t(
                    L,
                    'Noch keine Weltdaten gefunden. Starte eine Instanz, damit Minecraft Statistiken schreibt.',
                    'No world data found yet. Start an instance so Minecraft writes statistics.',
                  )}
                </EmptyHint>
              </div>
            ) : (
              <div className="border-t border-hairline">
                <div className="px-5 py-4">
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <GroupHeading icon={Footprints}>{t(L, 'Distanz', 'Distance')}</GroupHeading>
                    <span className="font-mono text-micro tabular-nums text-ink-secondary">
                      {formatDistance(totalDistance(summary.distance), lang)}
                    </span>
                  </div>
                  <DistanceList distance={summary.distance} lang={lang} wide />
                </div>
              </div>
            )}
          </>
        )}
      </SettingsCard>

      <SettingsCard
        title={t(L, 'Nach Version', 'Per version')}
        description={t(
          L,
          'Nur gespielte Minecraft-Versionen, nach Spielzeit sortiert. Jede Version lässt sich einklappen.',
          'Only played Minecraft versions, sorted by playtime. Each version can be collapsed.',
        )}
      >
        {perVersion.length === 0 ? (
          <div>
            <EmptyHint>
              {t(L, 'Noch keine gespielte Version.', 'No version played yet.')}
            </EmptyHint>
          </div>
        ) : (
          perVersion.map((group, index) => (
            <VersionSection
              key={group.version}
              group={group}
              lang={lang}
              defaultOpen={index === 0}
            />
          ))
        )}
      </SettingsCard>
    </div>
  )
}
