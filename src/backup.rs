//! Sicherungen einer Instanz, bevor der Launcher schreibt.
//!
//! Ein Pack-Update und ein Versionswechsel fassen Mods, Overrides und Configs
//! an. Welten lassen sich nicht erneut herunterladen; deshalb entsteht vor
//! solchen Eingriffen eine Kopie von Welten und Konfiguration. Die Sicherungen
//! liegen unter `<instanz>/backups/<id>/` und werden nach Anzahl rotiert.

use crate::error::{LauncherError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Wie viele Sicherungen je Instanz bleiben, wenn nichts anderes angegeben ist.
pub const DEFAULT_KEEP: usize = 5;

const META_FILE: &str = "backup.json";
const STAGING_PREFIX: &str = ".tmp-";

/// Einträge, die direkt in der Instanz liegen und mitgesichert werden.
/// `mods` fehlt bewusst: die lassen sich neu laden, der Rest nicht.
const SNAPSHOT_ENTRIES: [&str; 7] = [
    "saves",
    "config",
    "defaultconfigs",
    "kubejs",
    "scripts",
    "options.txt",
    "servers.dat",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// Zeitstempel in Millisekunden, bei Gleichstand mit `-1`, `-2` ergänzt.
    pub id: String,
    pub created_at: u64,
    /// Warum gesichert wurde, etwa "Vor Pack-Update".
    pub reason: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub files: usize,
    pub bytes: u64,
}

/// Sicherungen unterhalb eines Instanzordners.
#[derive(Debug, Clone)]
pub struct BackupManager {
    instance_dir: PathBuf,
}

impl BackupManager {
    pub fn new(instance_dir: impl Into<PathBuf>) -> Self {
        Self {
            instance_dir: instance_dir.into(),
        }
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.instance_dir.join("backups")
    }

    /// Legt eine Sicherung an. Gibt `None` zurück, wenn es nichts zu sichern
    /// gibt – dann entsteht auch kein leerer Ordner.
    pub fn create(&self, reason: &str, keep: usize) -> Result<Option<BackupEntry>> {
        let present: Vec<&str> = SNAPSHOT_ENTRIES
            .iter()
            .copied()
            .filter(|name| self.instance_dir.join(name).exists())
            .collect();
        if present.is_empty() {
            return Ok(None);
        }

        let backups = self.backups_dir();
        std::fs::create_dir_all(&backups)?;
        let id = self.next_id(&backups);
        let created_at = now_millis();
        let staging = backups.join(format!("{STAGING_PREFIX}{id}"));

        let result = (|| -> Result<BackupEntry> {
            std::fs::create_dir_all(&staging)?;
            let mut files = 0;
            let mut bytes = 0;
            for name in &present {
                let source = self.instance_dir.join(name);
                let target = staging.join(name);
                copy_tree(&source, &target, &mut files, &mut bytes)?;
            }
            let entry = BackupEntry {
                id: id.clone(),
                created_at,
                reason: reason.trim().to_string(),
                files,
                bytes,
            };
            std::fs::write(
                staging.join(META_FILE),
                serde_json::to_string_pretty(&entry)?,
            )?;
            std::fs::rename(&staging, backups.join(&id))?;
            Ok(entry)
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        let entry = result?;
        self.prune(keep)?;
        Ok(Some(entry))
    }

    /// Alle Sicherungen, neueste zuerst.
    pub fn list(&self) -> Result<Vec<BackupEntry>> {
        let Ok(entries) = std::fs::read_dir(self.backups_dir()) else {
            return Ok(Vec::new());
        };
        let mut backups = Vec::new();
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(STAGING_PREFIX) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path().join(META_FILE)) else {
                continue;
            };
            let Ok(backup) = serde_json::from_str::<BackupEntry>(&text) else {
                continue;
            };
            backups.push(backup);
        }
        backups.sort_by(|left, right| right.id.cmp(&left.id));
        Ok(backups)
    }

    /// Kopiert eine Sicherung zurück in die Instanz. Vorhandene Dateien werden
    /// überschrieben; Dateien, die in der Sicherung fehlen, bleiben liegen.
    pub fn restore(&self, id: &str) -> Result<RestoreReport> {
        let source = self.snapshot_dir(id)?;
        let mut report = RestoreReport::default();
        for name in SNAPSHOT_ENTRIES {
            let from = source.join(name);
            if !from.exists() {
                continue;
            }
            let to = self.instance_dir.join(name);
            copy_tree(&from, &to, &mut report.files, &mut report.bytes)?;
        }
        Ok(report)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let dir = self.snapshot_dir(id)?;
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    /// Entfernt die ältesten Sicherungen, bis `keep` übrig sind.
    pub fn prune(&self, keep: usize) -> Result<usize> {
        let keep = keep.max(1);
        let backups = self.list()?;
        let mut removed = 0;
        for backup in backups.iter().skip(keep) {
            let dir = self.backups_dir().join(&backup.id);
            if std::fs::remove_dir_all(&dir).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn snapshot_dir(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(LauncherError::UnsafePath(self.backups_dir().join(id)));
        }
        let dir = self.backups_dir().join(id);
        if !dir.is_dir() {
            return Err(LauncherError::BackupNotFound(id.to_string()));
        }
        Ok(dir)
    }

    fn next_id(&self, backups: &Path) -> String {
        let stamp = now_millis();
        let mut id = stamp.to_string();
        let mut suffix = 1;
        while backups.join(&id).exists() {
            id = format!("{stamp}-{suffix}");
            suffix += 1;
        }
        id
    }
}

/// Nur die selbst erzeugten IDs dürfen einen Pfad bilden.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id.chars().all(|ch| ch.is_ascii_digit() || ch == '-')
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Kopiert Dateien und Ordner und zählt dabei mit. Symbolische Verknüpfungen
/// werden übersprungen: ihnen zu folgen könnte aus der Instanz herausführen.
fn copy_tree(source: &Path, target: &Path, files: &mut usize, bytes: &mut u64) -> Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()), files, bytes)?;
        }
        return Ok(());
    }
    if !source.is_file() {
        return Ok(());
    }
    let size = std::fs::metadata(source)?.len();
    std::fs::copy(source, target)?;
    *files += 1;
    *bytes = bytes.saturating_add(size);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn temp_instance() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("saves/Welt/level.dat"), "world-v1");
        write(&dir.path().join("saves/Welt/region/r.0.0.mca"), "region");
        write(&dir.path().join("config/bamboo.toml"), "setting = 1");
        write(&dir.path().join("options.txt"), "fov:70");
        dir
    }

    #[test]
    fn snapshot_restores_world_and_config() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager
            .create("Vor Pack-Update", DEFAULT_KEEP)
            .unwrap()
            .expect("something to back up");

        assert_eq!(backup.files, 4);
        assert_eq!(backup.reason, "Vor Pack-Update");
        assert!(manager.backups_dir().join(&backup.id).is_dir());

        std::fs::write(dir.path().join("saves/Welt/level.dat"), "broken").unwrap();
        std::fs::remove_file(dir.path().join("config/bamboo.toml")).unwrap();

        let report = manager.restore(&backup.id).unwrap();
        assert_eq!(report.files, 4);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("saves/Welt/level.dat")).unwrap(),
            "world-v1"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config/bamboo.toml")).unwrap(),
            "setting = 1"
        );
    }

    #[test]
    fn restore_keeps_files_the_backup_does_not_know() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();

        write(&dir.path().join("config/newer.toml"), "new");
        manager.restore(&backup.id).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("config/newer.toml")).unwrap(),
            "new"
        );
    }

    #[test]
    fn rotation_keeps_the_newest_backups() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        for index in 0..4 {
            write(
                &dir.path().join("options.txt"),
                &format!("fov:{}", 70 + index),
            );
            manager.create("Rotation", 2).unwrap();
        }

        let backups = manager.list().unwrap();
        assert_eq!(backups.len(), 2);
        // Neueste zuerst; die ältesten sind gelöscht.
        assert!(backups[0].id >= backups[1].id);
        let remaining = std::fs::read_dir(manager.backups_dir())
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .count();
        assert_eq!(remaining, 2);
    }

    #[test]
    fn empty_instance_produces_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::new(dir.path());
        assert!(manager.create("leer", DEFAULT_KEEP).unwrap().is_none());
        assert!(!manager.backups_dir().exists());
    }

    #[test]
    fn unknown_or_unsafe_ids_are_rejected() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        assert!(matches!(
            manager.restore("../../etc"),
            Err(LauncherError::UnsafePath(_))
        ));
        assert!(matches!(
            manager.restore("9999999999999"),
            Err(LauncherError::BackupNotFound(_))
        ));
        assert!(matches!(
            manager.remove("."),
            Err(LauncherError::UnsafePath(_))
        ));
    }

    #[test]
    fn remove_deletes_only_that_snapshot() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let first = manager.create("eins", DEFAULT_KEEP).unwrap().unwrap();
        let second = manager.create("zwei", DEFAULT_KEEP).unwrap().unwrap();

        manager.remove(&first.id).unwrap();
        let ids: Vec<String> = manager
            .list()
            .unwrap()
            .into_iter()
            .map(|backup| backup.id)
            .collect();
        assert_eq!(ids, vec![second.id]);
        assert!(dir.path().join("saves/Welt/level.dat").is_file());
    }
}
