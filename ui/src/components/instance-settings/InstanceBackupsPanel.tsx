import { useState } from 'react'
import { Archive, FolderOpen, RotateCcw, Trash2 } from 'lucide-react'
import type { InstanceBackup } from '../../electron'
import type { Instance } from '../InstancesView'
import { instanceFolderKeyOf } from '../../lib/instanceFolders'
import type { LanguageType } from '../../lib/translations'
import { useInstanceBackups } from '../../hooks/useInstanceBackups'
import { useToast } from '../Toast'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { Button, SettingsCard, SettingsRow } from '../settings/SettingsPrimitives'
import { t } from '../settings/settingsUtils'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatWhen(createdAt: number, lang: LanguageType): string {
  if (!createdAt) return '—'
  return new Date(createdAt).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface InstanceBackupsPanelProps {
  instance: Instance
  lang: LanguageType
}

export function InstanceBackupsPanel({ instance, lang }: InstanceBackupsPanelProps) {
  const L = lang === 'de' ? 'de' : 'en'
  const { addToast } = useToast()
  const folderKey = instanceFolderKeyOf(instance)
  const { backups, loading, refresh } = useInstanceBackups({ folderKey, active: true })
  const [busy, setBusy] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<InstanceBackup | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InstanceBackup | null>(null)

  const createBackup = async () => {
    setBusy('create')
    try {
      const result = await window.electronAPI?.instances.createBackup?.({
        folderName: folderKey,
        reason: t(L, 'Manuell', 'Manual'),
      })
      if (!result?.success) {
        addToast({
          type: result?.empty ? 'info' : 'error',
          message:
            result?.error ||
            t(L, 'Sicherung fehlgeschlagen.', 'Backup failed.'),
        })
        return
      }
      addToast({
        type: 'success',
        message: t(L, 'Sicherung angelegt.', 'Backup created.'),
      })
      await refresh()
    } catch (error) {
      addToast({ type: 'error', message: String(error) })
    } finally {
      setBusy(null)
    }
  }

  const restoreBackup = async () => {
    if (!restoreTarget) return
    setBusy('restore')
    try {
      const result = await window.electronAPI?.instances.restoreBackup?.({
        folderName: folderKey,
        backupId: restoreTarget.id,
      })
      addToast({
        type: result?.success ? 'success' : 'error',
        message: result?.success
          ? t(
              L,
              `Sicherung eingespielt (${result.files ?? 0} Dateien).`,
              `Backup restored (${result.files ?? 0} files).`,
            )
          : result?.error || t(L, 'Wiederherstellen fehlgeschlagen.', 'Restore failed.'),
      })
    } catch (error) {
      addToast({ type: 'error', message: String(error) })
    } finally {
      setBusy(null)
      setRestoreTarget(null)
    }
  }

  const deleteBackup = async () => {
    if (!deleteTarget) return
    setBusy('delete')
    try {
      const result = await window.electronAPI?.instances.deleteBackup?.({
        folderName: folderKey,
        backupId: deleteTarget.id,
      })
      addToast({
        type: result?.success ? 'success' : 'error',
        message: result?.success
          ? t(L, 'Sicherung gelöscht.', 'Backup deleted.')
          : result?.error || t(L, 'Löschen fehlgeschlagen.', 'Delete failed.'),
      })
      if (result?.success) await refresh()
    } catch (error) {
      addToast({ type: 'error', message: String(error) })
    } finally {
      setBusy(null)
      setDeleteTarget(null)
    }
  }

  const openFolder = async () => {
    const result = await window.electronAPI?.instances.openBackupsFolder?.(folderKey)
    if (result && !result.success) {
      addToast({
        type: 'error',
        message: result.error || t(L, 'Ordner konnte nicht geöffnet werden.', 'Could not open the folder.'),
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={t(L, 'Sicherungen', 'Backups')}
        description={t(
          L,
          'Welten, Configs und Optionen vor jedem Pack-Update und Versionswechsel. Die letzten fünf bleiben erhalten.',
          'Worlds, configs and options before every pack update and version change. The last five are kept.',
        )}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen className="h-3 w-3" />}
              onClick={() => void openFolder()}
            >
              {t(L, 'Ordner', 'Folder')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Archive className="h-3 w-3" />}
              disabled={busy !== null}
              onClick={() => void createBackup()}
            >
              {busy === 'create'
                ? t(L, 'Sichere …', 'Saving …')
                : t(L, 'Jetzt sichern', 'Back up now')}
            </Button>
          </div>
        }
      >
        {loading && !backups ? (
          <p className="m-0 px-4 py-6 text-center text-small text-ink-tertiary">
            {t(L, 'Sicherungen werden gelesen …', 'Reading backups …')}
          </p>
        ) : !backups || backups.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-small text-ink-tertiary">
            {t(
              L,
              'Noch keine Sicherung. Sie entsteht automatisch vor dem nächsten Update.',
              'No backups yet. One is created automatically before the next update.',
            )}
          </p>
        ) : (
          backups.map((backup) => (
            <SettingsRow
              key={backup.id}
              icon={<Archive className="h-3.5 w-3.5" />}
              title={formatWhen(backup.createdAt, lang)}
              description={`${backup.reason} · ${backup.files} ${t(L, 'Dateien', 'files')} · ${formatBytes(backup.bytes)}`}
              control={
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<RotateCcw className="h-3 w-3" />}
                    disabled={busy !== null}
                    onClick={() => setRestoreTarget(backup)}
                  >
                    {t(L, 'Einspielen', 'Restore')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Trash2 className="h-3 w-3" />}
                    disabled={busy !== null}
                    onClick={() => setDeleteTarget(backup)}
                  >
                    {t(L, 'Löschen', 'Delete')}
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsCard>

      <Dialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title={t(L, 'Sicherung einspielen?', 'Restore backup?')}
        titleId="backup-restore-title"
        closeLabel={t(L, 'Abbrechen', 'Cancel')}
        tone="info"
        footer={
          <>
            <button
              type="button"
              className={dialogButton.secondary}
              onClick={() => setRestoreTarget(null)}
              disabled={busy !== null}
            >
              {t(L, 'Abbrechen', 'Cancel')}
            </button>
            <button
              type="button"
              className={dialogButton.accent}
              onClick={() => void restoreBackup()}
              disabled={busy !== null}
            >
              {busy === 'restore' ? t(L, 'Spiele ein …', 'Restoring …') : t(L, 'Einspielen', 'Restore')}
            </button>
          </>
        }
      >
        <p className="m-0 text-small leading-6 text-ink-secondary">
          {t(
            L,
            'Welten und Configs aus dieser Sicherung überschreiben den aktuellen Stand. Vorher die Instanz beenden.',
            'Worlds and configs from this backup overwrite the current state. Stop the instance first.',
          )}
        </p>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t(L, 'Sicherung löschen?', 'Delete backup?')}
        titleId="backup-delete-title"
        closeLabel={t(L, 'Abbrechen', 'Cancel')}
        tone="danger"
        footer={
          <>
            <button
              type="button"
              className={dialogButton.secondary}
              onClick={() => setDeleteTarget(null)}
              disabled={busy !== null}
            >
              {t(L, 'Abbrechen', 'Cancel')}
            </button>
            <button
              type="button"
              className={dialogButton.danger}
              onClick={() => void deleteBackup()}
              disabled={busy !== null}
            >
              {busy === 'delete' ? t(L, 'Lösche …', 'Deleting …') : t(L, 'Löschen', 'Delete')}
            </button>
          </>
        }
      >
        <p className="m-0 text-small leading-6 text-ink-secondary">
          {t(
            L,
            'Diese Sicherung wird dauerhaft entfernt. Die Welten in der Instanz bleiben unverändert.',
            'This backup is removed permanently. The worlds in the instance stay untouched.',
          )}
        </p>
      </Dialog>
    </div>
  )
}
