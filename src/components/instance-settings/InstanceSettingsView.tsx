import React, { useState } from 'react'
import { translations } from '../../lib/translations';
import {
  AlertTriangle,
  ArrowRightLeft,
  Clock3,
  Coffee,
  ExternalLink,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Image as ImageIcon,
  Info,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { InstanceCoverPicker } from '../instances/InstanceCoverPicker'
import type { Instance } from '../InstancesView'
import type { LauncherPreferences } from '../../lib/launcherPreferences'
import { formatDate, formatPlaytime } from '../../lib/launcherPreferences'
import type { LanguageType } from '../../lib/translations'
import {
  Badge,
  Button,
  SelectField,
  SettingsCard,
  SettingsRow,
  Slider,
  StatTile,
  TextField,
  Toggle,
  type Lang,
} from '../settings/SettingsPrimitives'
import { cx, t } from '../settings/settingsUtils'
import { useToast } from '../Toast'

type InstanceSection = 'overview' | 'game' | 'java' | 'danger' | 'stats'

const SECTIONS: { id: InstanceSection; label: { de: string; en: string }; icon: React.ElementType }[] = [
  { id: 'overview', label: { de: 'Übersicht', en: 'Overview' }, icon: Info },
  { id: 'game', label: { de: 'Spiel', en: 'Game' }, icon: Gamepad2 },
  { id: 'java', label: { de: 'Java & Speicher', en: 'Java & memory' }, icon: Coffee },
  { id: 'danger', label: { de: 'Erweitert', en: 'Advanced' }, icon: Wrench },
  { id: 'stats', label: { de: 'Statistiken', en: 'Statistics' }, icon: Clock3 },
]

export interface InstanceSettingsViewProps {
  instance: Instance
  lang: LanguageType
  preferences: LauncherPreferences
  onUpdate: (patch: Partial<Instance>) => void
  onRequestRename: () => void
  onRequestDelete: () => void
  onRequestImage: () => void
  onExport: () => void
  onOpenFolder: () => void
  onRepair: () => void
  onChangeVersion: () => void
}

export function InstanceSettingsView({
  instance,
  lang,
  preferences,
  onUpdate,
  onRequestRename,
  onRequestDelete,
  onExport,
  onOpenFolder,
  onRepair,
  onChangeVersion,
}: InstanceSettingsViewProps) {
  const L = lang as Lang
  const { addToast } = useToast()
  const [section, setSection] = useState<InstanceSection>('overview')
  const [javaVersions, setJavaVersions] = useState<{ path: string; version: number; verStr: string }[]>([])
  const [scanningJava, setScanningJava] = useState(false)
  const [coverOpen, setCoverOpen] = useState(false)

  const folderName = instance.folderName || instance.name.toLowerCase().replace(/\s+/g, '-')
  const created = instance.createdAt || Number(/\d{10,}/.exec(instance.id)?.[0]) || undefined
  const totalContent = instance.content?.length || 0

  const scanJava = async (force = false) => {
    setScanningJava(true)
    try {
      const result = await window.electronAPI?.java.versions?.(force)
      if (result) setJavaVersions(result)
      if (result && result.length === 0) {
        addToast({ type: 'warning', message: t(L, 'Keine Java-Installation gefunden.', 'No Java installation found.') })
      }
    } catch {
      addToast({ type: 'error', message: t(L, 'Java-Scan fehlgeschlagen.', 'Java scan failed.') })
    } finally {
      setScanningJava(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--r-xl)] border border-stroke bg-surface/55 px-4 py-3.5">
        <button
          type="button"
          onClick={() => setCoverOpen(true)}
          className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-stroke bg-root cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t(L, 'Vorschaubild ändern', 'Change thumbnail')}
        >
          {instance.thumbnail ? (
            <img src={instance.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-black" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <ImageIcon className="h-3.5 w-3.5 text-white" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="m-0 truncate text-regular font-semibold text-ink">{instance.name}</h3>
            <Badge tone="accent">{instance.minecraftVersion}</Badge>
            <Badge>
              {instance.modloader}
              {instance.modloaderVersion ? ` ${instance.modloaderVersion}` : ''}
            </Badge>
            {instance.isModpack && <Badge tone="info">{t(L, 'Modpack', 'Modpack')}</Badge>}
          </div>
          <p className="m-0 mt-0.5 text-micro text-ink-secondary">
            {t(L, 'Instanz-Einstellungen', 'Instance settings')}
            <span className="mx-1 text-ink-quaternary">·</span>
            <span className="font-mono">{folderName}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" icon={<FolderOpen className="h-3 w-3" />} onClick={onOpenFolder}>
            {t(L, 'Ordner', 'Folder')}
          </Button>
          <Button variant="secondary" size="sm" icon={<Pencil className="h-3 w-3" />} onClick={onRequestRename}>
            {t(L, 'Umbenennen', 'Rename')}
          </Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-stroke bg-root/35 p-1">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon
          const active = entry.id === section
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-mini font-medium transition-colors duration-[var(--t-quick)] cursor-pointer',
                active
                  ? 'bg-accent/12 text-accent'
                  : 'text-ink-secondary hover:bg-hover hover:text-ink',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {entry.label[L]}
            </button>
          )
        })}
      </div>

      {section === 'overview' && (
        <p className="m-0 px-1 text-mini leading-5 text-ink-tertiary">
          {t(
            L,
            'Name, Bild und Ordner stehen oben. Version und Loader findest du unter Spiel, Spielzeit und Größe unter Statistiken.',
            'Name, image and folder are above. Version and loader live under Game, playtime and size under Statistics.',
          )}
        </p>
      )}

      {section === 'game' && (
        <div className="flex flex-col gap-4">
          <SettingsCard
            title={t(L, 'Version & Loader', 'Version & loader')}
            description={t(L, 'Diese Werte bestimmen, welche Bibliotheken beim Start geladen werden.', 'These values decide which libraries are loaded at launch.')}
          >
            <SettingsRow
              title={t(L, 'Minecraft-Version', 'Minecraft version')}
              description={t(L, 'Änderungen erfordern eine Neuinstallation der Instanz.', 'Changing this requires reinstalling the instance.')}
              control={<Badge tone="accent">{instance.minecraftVersion}</Badge>}
            />
            <SettingsRow
              title={t(L, 'Modloader', 'Mod loader')}
              control={<Badge>{instance.modloader}</Badge>}
            />
            <SettingsRow
              title={t(L, 'Modloader-Version', 'Mod loader version')}
              description={
                instance.modloader === 'Vanilla'
                  ? t(L, 'Vanilla benötigt keinen Loader.', 'Vanilla does not use a loader.')
                  : instance.modloaderVersion || t(L, 'Keine Version gesetzt', 'No version set')
              }
              control={
                <span className="font-mono text-micro text-ink-secondary">
                  {instance.modloaderVersion || '—'}
                </span>
              }
            />
            <SettingsRow
              icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
              title={t(L, 'Version wechseln', 'Switch version')}
              description={t(
                L,
                'Ändert Minecraft-Version, Loader, Mods, Ressourcenpakete, Shader und Datenpakete. Welten und Configs bleiben erhalten.',
                'Changes the Minecraft version, loader, mods, resource packs, shaders and data packs. Worlds and configs are kept.',
              )}
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowRightLeft className="h-3 w-3" />}
                  onClick={onChangeVersion}
                >
                  {t(L, 'Version wechseln', 'Switch version')}
                </Button>
              }
            />
            {instance.isModpack && (
              <>
                <SettingsRow
                  title={t(L, 'Modpack-Quelle', 'Modpack source')}
                  control={<Badge tone="info">{instance.modpackSource || '—'}</Badge>}
                />
                <SettingsRow
                  title={t(L, 'Modpack-Version', 'Modpack version')}
                  control={<span className="font-mono text-micro text-ink-secondary">{instance.modpackVersion || '—'}</span>}
                />
              </>
            )}
          </SettingsCard>

          {(instance.isModpack || !!instance.modpackSource) && instance.ownContentManagement && (
            <SettingsCard title={t(L, 'Inhaltsverwaltung', 'Content management')}>
              <SettingsRow
                icon={<Package className="h-3.5 w-3.5" />}
                title={t(L, 'Bamboo-Inhaltsverwaltung', 'Bamboo content management')}
                description={t(
                  L,
                  'Eigene Mods erlaubt; Modpack-Updates überschreiben sie nicht. Deaktivieren gibt die Verwaltung wieder ans Modpack ab.',
                  'Custom mods allowed; modpack updates leave them alone. Turning it off hands management back to the modpack.',
                )}
                badge={<Badge tone="accent">{t(L, 'Manuell', 'Manual')}</Badge>}
                control={
                  <Toggle
                    checked
                    onChange={(value) => onUpdate({ ownContentManagement: value })}
                    label={t(L, 'Inhaltsverwaltung', 'Content management')}
                  />
                }
              />
            </SettingsCard>
          )}
        </div>
      )}

      {section === 'java' && (
        <div className="flex flex-col gap-4">
          <SettingsCard
            title={t(L, 'Arbeitsspeicher', 'Memory')}
            description={t(L, 'Gilt nur für diese Instanz.', 'Applies to this instance only.')}
            action={
              <Badge tone={instance.ram && instance.ram > 12288 ? 'warning' : 'accent'}>
                {((instance.ram || 4096) / 1024).toFixed(1).replace('.0', '')} GB
              </Badge>
            }
          >
            <SettingsRow
              title={t(L, 'Zugewiesener RAM', 'Allocated RAM')}
              description={
                instance.ram && instance.ram > 12288
                  ? t(L, 'Mehr als 12 GB können GC-Lags verursachen.', 'More than 12 GB can cause GC stalls.')
                  : t(L, 'Wird beim Start als -Xmx an Java übergeben.', 'Passed to Java as -Xmx at launch.')
              }
              badge={
                instance.ram && instance.ram < 2048 ? (
                  <Badge tone="warning">{t(L, 'Sehr wenig', 'Very low')}</Badge>
                ) : undefined
              }
              control={
                <div className="w-[300px] max-w-[46vw]">
                  <Slider
                    min={1024}
                    max={16384}
                    step={256}
                    value={instance.ram || 4096}
                    onChange={(value) => onUpdate({ ram: value })}
                    formatValue={(value) => `${(value / 1024).toFixed(1).replace('.0', '')} GB`}
                    valueClassName="text-title2 leading-none text-center font-semibold"
                    minLabel="1 GB"
                    maxLabel="16 GB"
                  />
                </div>
              }
            />
          </SettingsCard>

          <SettingsCard
            title={t(L, 'Java', 'Java')}
            description={t(L, 'Eine falsche Java-Version ist die häufigste Ursache für Startfehler.', 'A mismatched Java version is the most common cause of launch failures.')}
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<Search className="h-3 w-3" />}
                onClick={() => scanJava(true)}
                disabled={scanningJava}
              >
                {scanningJava ? t(L, 'Suche …', 'Scanning …') : t(L, 'Java suchen', 'Find Java')}
              </Button>
            }
          >
            <SettingsRow
              title={translations[L].common.javaInstallation}
              description={t(L, '„Automatisch“ wählt die passende Version anhand der Minecraft-Version.', '“Automatic” picks the right runtime for the Minecraft version.')}
              control={
                <SelectField
                  value={instance.javaVersion || 'Automatisch'}
                  onChange={(value) => onUpdate({ javaVersion: value })}
                  options={[
                    { value: 'Automatisch', label: t(L, 'Automatisch (empfohlen)', 'Automatic (recommended)') },
                    ...javaVersions.map((entry) => ({
                      value: `${entry.verStr} (${entry.path})`,
                      label: `Java ${entry.verStr || entry.version} — ${entry.path}`,
                    })),
                    ...(instance.javaVersion &&
                    instance.javaVersion !== 'Automatisch' &&
                    !javaVersions.some((entry) => `${entry.verStr} (${entry.path})` === instance.javaVersion)
                      ? [{ value: instance.javaVersion, label: instance.javaVersion }]
                      : []),
                  ]}
                  className="w-[290px] max-w-[46vw]"
                  ariaLabel={translations[L].common.javaInstallation}
                />
              }
            />
            <SettingsRow
              title={translations[L].common.jvmArguments}
              description={t(L, 'Überschreibt die Launcher-Standards für diese Instanz.', 'Overrides the launcher defaults for this instance.')}
              control={
                <TextField
                  value={instance.jvmArgs || ''}
                  onChange={(value) => onUpdate({ jvmArgs: value })}
                  placeholder={preferences.instanceDefaults.jvmArgs || '-XX:+UseG1GC'}
                  mono
                  className="w-[300px] max-w-[46vw]"
                  ariaLabel={translations[L].common.jvmArguments}
                />
              }
            />
          </SettingsCard>

          <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-warning/20 bg-warning/8 px-3 py-2.5 text-mini leading-5 text-ink-secondary">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {t(
                L,
                'Zu viel RAM ist nicht automatisch besser: Java benötigt länger für die Garbage Collection.',
                'More RAM is not automatically better: Java takes longer for garbage collection.',
              )}
            </span>
          </div>
        </div>
      )}

      {section === 'danger' && (
        <div className="flex flex-col gap-4">
          <SettingsCard title={t(L, 'Wartung', 'Maintenance')}>
            <SettingsRow
              icon={<Wrench className="h-3.5 w-3.5" />}
              title={t(L, 'Installation reparieren', 'Repair installation')}
              description={t(L, 'Prüft Version, Loader und Bibliotheken und lädt Fehlendes neu.', 'Checks the version, loader and libraries and re-downloads what is missing.')}
              control={
                <Button variant="secondary" size="sm" icon={<Wrench className="h-3 w-3" />} onClick={onRepair}>
                  {t(L, 'Reparieren', 'Repair')}
                </Button>
              }
            />
            <SettingsRow
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              title={t(L, 'Instanz exportieren', 'Export instance')}
              description={t(L, 'Als Modrinth-Pack oder ZIP sichern.', 'Save as a Modrinth pack or ZIP.')}
              control={
                <Button variant="secondary" size="sm" icon={<ExternalLink className="h-3 w-3" />} onClick={onExport}>
                  {translations[L].common.export}
                </Button>
              }
            />
          </SettingsCard>

          <SettingsCard
            title={t(L, 'Gefahrenzone', 'Danger zone')}
            description={t(L, 'Diese Aktionen können nicht rückgängig gemacht werden.', 'These actions cannot be undone.')}
            className="border-danger/25"
          >
            <SettingsRow
              icon={<Trash2 className="h-3.5 w-3.5 text-danger" />}
              title={t(L, 'Instanz löschen', 'Delete instance')}
              description={t(
                L,
                'Löscht Mods, Welten, Screenshots und den kompletten Instanzordner dauerhaft.',
                'Permanently deletes mods, worlds, screenshots and the whole instance folder.',
              )}
              control={
                <Button variant="danger" size="sm" icon={<Trash2 className="h-3 w-3" />} onClick={onRequestDelete}>
                  {t(L, 'Löschen', 'Delete')}
                </Button>
              }
            />
          </SettingsCard>
        </div>
      )}

      {section === 'stats' && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              icon={<Clock3 className="h-3.5 w-3.5" />}
              label={translations[L].common.playtime}
              value={formatPlaytime(instance.playTimeMs, L)}
              hint={t(L, 'Gesamte Spielzeit', 'Total playtime')}
            />
            <StatTile
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              label={t(L, 'Sitzungen', 'Sessions')}
              value={instance.sessionCount || 0}
              hint={t(L, 'Abgeschlossene Starts', 'Completed launches')}
            />
            <StatTile
              icon={<Clock3 className="h-3.5 w-3.5" />}
              label={t(L, 'Zuletzt gespielt', 'Last played')}
              value={instance.lastPlayedAt ? formatDate(instance.lastPlayedAt, L) : instance.lastPlayed || '—'}
              hint={instance.lastPlayedAt ? formatDate(instance.lastPlayedAt, L) : undefined}
            />
            <StatTile
              icon={<HardDrive className="h-3.5 w-3.5" />}
              label={t(L, 'Größe', 'Size')}
              value={instance.size || '—'}
              hint={t(L, 'Auf der Festplatte', 'On disk')}
            />
            <StatTile
              icon={<Package className="h-3.5 w-3.5" />}
              label={t(L, 'Inhalte', 'Content')}
              value={totalContent || instance.modCount || 0}
              hint={t(L, 'Mods, Packs und Welten', 'Mods, packs and worlds')}
            />
            <StatTile
              icon={<Info className="h-3.5 w-3.5" />}
              label={t(L, 'Erstellt', 'Created')}
              value={formatDate(created, L)}
              hint={instance.isModpack ? t(L, 'Modpack-Instanz', 'Modpack instance') : t(L, 'Eigene Instanz', 'Custom instance')}
            />
          </div>
        </div>
      )}

      <Dialog
        open={coverOpen}
        onClose={() => setCoverOpen(false)}
        title={t(L, 'Vorschaubild', 'Thumbnail')}
        titleId="instance-cover-title"
        closeLabel={translations[L].common.close}
        tone="accent"
        footer={
          <button type="button" className={dialogButton.secondary} onClick={() => setCoverOpen(false)}>
            {translations[L].common.close}
          </button>
        }
      >
        <InstanceCoverPicker
          value={instance.thumbnail}
          onChange={(value) => {
            onUpdate({ thumbnail: value })
            setCoverOpen(false)
          }}
          lang={lang}
        />
      </Dialog>
    </div>
  )
}
