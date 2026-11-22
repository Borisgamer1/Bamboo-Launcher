//! Sicherungen einer Instanz, bevor der Launcher schreibt.
//!
//! Ein Pack-Update und ein Versionswechsel fassen Mods, Overrides und Configs
//! an. Welten lassen sich nicht erneut herunterladen; deshalb entsteht vor
//! solchen Eingriffen eine Kopie von Welten und Konfiguration. Die Sicherungen
//! liegen unter `<instanz>/backups/<id>/` und werden nach Anzahl rotiert.

use crate::error::{LauncherError, Result};
use crate::safe_fs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Wie viele Sicherungen je Instanz bleiben, wenn nichts anderes angegeben ist.
pub const DEFAULT_KEEP: usize = 5;

const META_FILE: &str = "backup.json";
const STAGING_PREFIX: &str = ".tmp-";
/// Arbeitsordner beim Einspielen: erst vollständig lesen, dann ersetzen.
const RESTORE_STAGING: &str = ".restore-staging";
/// Hier liegt jeder Stand, den das Einspielen überschreibt – für den Rückweg.
const RESTORE_UNDO: &str = ".restore-undo";

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
    ///
    /// Warnungen beim Aufräumen landen hier nur im Log; wer sie anzeigen will,
    /// ruft `create_reported`.
    pub fn create(&self, reason: &str, keep: usize) -> Result<Option<BackupEntry>> {
        let (entry, warnings) = self.create_reported(reason, keep)?;
        for warning in warnings {
            eprintln!("[launcher] Rotation der Sicherungen: {warning}");
        }
        Ok(entry)
    }

    /// Wie `create`, meldet aber zusätzlich, was beim Aufräumen liegen blieb.
    pub fn create_reported(
        &self,
        reason: &str,
        keep: usize,
    ) -> Result<(Option<BackupEntry>, Vec<String>)> {
        let present: Vec<&str> = SNAPSHOT_ENTRIES
            .iter()
            .copied()
            .filter(|name| self.instance_dir.join(name).exists())
            .collect();
        if present.is_empty() {
            return Ok((None, Vec::new()));
        }

        let backups = self.backups_dir();
        std::fs::create_dir_all(&backups)?;
        // Reste eines abgebrochenen Laufs sind nicht gelistet; sie würden sonst
        // dauerhaft Platz belegen.
        self.sweep_staging();
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
                safe_fs::copy_tree(&source, &target, &mut files, &mut bytes)?;
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

        let entry = match result {
            Ok(entry) => entry,
            Err(error) => return Err(failed_staging(staging, error)),
        };
        // Rotation ist Aufräumen: die neue Sicherung ist fertig und gelistet.
        // Ein Fehler dabei darf das Anlegen nicht als gescheitert melden – er
        // wird nach oben gemeldet statt verschluckt.
        let mut warnings = Vec::new();
        if let Err(error) = self.prune(keep) {
            warnings.push(error.to_string());
        }
        Ok((Some(entry), warnings))
    }

    /// Räumt liegen gebliebene Arbeitsordner abgebrochener Läufe weg.
    fn sweep_staging(&self) {
        let Ok(entries) = std::fs::read_dir(self.backups_dir()) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(STAGING_PREFIX) {
                let _ = safe_fs::remove_path(&entry.path());
            }
        }
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
    ///
    /// Die Sicherung wird erst vollständig in einen Staging-Ordner gelesen und
    /// gegen ihre Metadatei geprüft; erst danach wird die Instanz angefasst.
    /// Jede überschriebene Datei landet vorher im Undo-Ordner. Bricht etwas ab
    /// – unvollständige Sicherung, gesperrte oder blockierte Zieldatei –, wird
    /// der alte Stand zurückgeschrieben, statt eine halb eingespielte Instanz
    /// zu hinterlassen.
    pub fn restore(&self, id: &str) -> Result<RestoreReport> {
        let source = self.snapshot_dir(id)?;
        let staging = self.instance_dir.join(RESTORE_STAGING);
        let undo = self.instance_dir.join(RESTORE_UNDO);

        // 1. Lesen und prüfen, ohne die Instanz anzufassen.
        let mut report = RestoreReport::default();
        let prepared = (|| -> Result<Vec<PathBuf>> {
            safe_fs::remove_path(&staging)?;
            std::fs::create_dir_all(&staging)?;
            let mut names = Vec::new();
            for name in SNAPSHOT_ENTRIES {
                let from = source.join(name);
                if !from.exists() {
                    continue;
                }
                safe_fs::copy_tree(
                    &from,
                    &staging.join(name),
                    &mut report.files,
                    &mut report.bytes,
                )?;
                names.push(PathBuf::from(name));
            }
            verify_snapshot(&source, id, &report)?;
            Ok(names)
        })();
        let names = match prepared {
            Ok(names) => names,
            Err(error) => {
                let _ = safe_fs::remove_path(&staging);
                return Err(error);
            }
        };

        // 2. Datei für Datei ersetzen und dabei jeden alten Stand sichern.
        let mut journal = safe_fs::Journal::new();
        let mut fresh_roots: Vec<PathBuf> = Vec::new();
        let applied = (|| -> Result<()> {
            let _ = safe_fs::remove_path(&undo);
            for name in &names {
                let target = self.instance_dir.join(name);
                if !target.exists() {
                    fresh_roots.push(target.clone());
                }
                safe_fs::apply_tree(&staging.join(name), &target, &undo, name, &mut journal)?;
            }
            Ok(())
        })();

        if let Err(error) = applied {
            safe_fs::roll_back(&self.instance_dir, &undo, &journal, &fresh_roots);
            let _ = safe_fs::remove_path(&undo);
            let _ = safe_fs::remove_path(&staging);
            return Err(error);
        }
        let _ = safe_fs::remove_path(&undo);
        let _ = safe_fs::remove_path(&staging);
        Ok(report)
    }

    /// Papierkorb für Sicherungen, die gerade entfernt werden.
    fn trash(&self) -> safe_fs::Trash {
        safe_fs::Trash::under(&self.backups_dir().join(format!("{STAGING_PREFIX}trash")))
    }

    /// Löscht eine Sicherung. Sie wird erst beiseitegelegt und dann entfernt:
    /// scheitert das Löschen, bleibt kein halb gelöschter Ordner im Bestand.
    pub fn remove(&self, id: &str) -> Result<()> {
        let dir = self.snapshot_dir(id)?;
        let mut trash = self.trash();
        trash.take(&dir)?;
        let root = trash.root().to_path_buf();
        trash
            .discard()
            .map_err(|error| LauncherError::TrashLeftover {
                path: root,
                cause: error.to_string(),
            })?;
        Ok(())
    }

    /// Entfernt die ältesten Sicherungen, bis `keep` übrig sind.
    ///
    /// Erst werden alle überzähligen Sicherungen beiseitegelegt, dann werden sie
    /// gelöscht. Scheitert schon das Beiseitelegen, ist der Bestand unverändert
    /// und der Fehler kommt an der Aufrufstelle an – statt einer halb gelöschten
    /// Sicherung, die noch als gültig aufgelistet wird.
    pub fn prune(&self, keep: usize) -> Result<usize> {
        let keep = keep.max(1);
        let backups = self.list()?;
        let excess: Vec<&BackupEntry> = backups.iter().skip(keep).collect();
        if excess.is_empty() {
            return Ok(0);
        }

        let mut trash = self.trash();
        let mut moved = 0;
        for backup in &excess {
            let dir = self.backups_dir().join(&backup.id);
            match trash.take(&dir) {
                Ok(true) => moved += 1,
                Ok(false) => {}
                Err(error) => {
                    let stuck = trash.restore();
                    if !stuck.is_empty() {
                        return Err(LauncherError::TrashRestore {
                            path: trash.root().to_path_buf(),
                            cause: error.to_string(),
                        });
                    }
                    return Err(error);
                }
            }
        }

        // Sie sind jetzt nicht mehr gelistet; das endgültige Löschen darf
        // scheitern, ohne einen halben Bestand zu hinterlassen.
        let root = trash.root().to_path_buf();
        trash
            .discard()
            .map_err(|error| LauncherError::TrashLeftover {
                path: root,
                cause: error.to_string(),
            })?;
        // Reste eines früheren, abgebrochenen Löschens sind nicht gelistet und
        // werden hier eingesammelt, statt dauerhaft Platz zu belegen.
        let _ = safe_fs::remove_path(&self.backups_dir().join(format!("{STAGING_PREFIX}trash")));
        Ok(moved)
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

/// Räumt einen gescheiterten Staging-Ordner weg. Bleibt er liegen, nennt der
/// Fehler den Pfad, statt ihn stillschweigend zu verschweigen.
fn failed_staging(staging: PathBuf, cause: LauncherError) -> LauncherError {
    match safe_fs::remove_path(&staging) {
        Ok(()) => cause,
        Err(error) => LauncherError::TrashLeftover {
            path: staging,
            cause: error.to_string(),
        },
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

/// Vergleicht die Metadatei mit dem, was wirklich in der Sicherung liegt.
///
/// Eine angefangene Sicherung, aus der jemand Dateien entfernt hat, würde die
/// Instanz sonst halb einspielen: die fehlenden Dateien blieben auf ihrem
/// aktuellen Stand, alles andere käme aus der Sicherung.
fn verify_snapshot(source: &Path, id: &str, staged: &RestoreReport) -> Result<()> {
    let meta = std::fs::read_to_string(source.join(META_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<BackupEntry>(&text).ok());
    match meta {
        Some(meta) if meta.files == staged.files && meta.bytes == staged.bytes => Ok(()),
        _ => Err(LauncherError::BackupIncomplete(id.to_string())),
    }
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
        // Die Arbeitsordner des Einspielens bleiben nicht liegen.
        assert!(!dir.path().join(RESTORE_STAGING).exists());
        assert!(!dir.path().join(RESTORE_UNDO).exists());
    }

    #[test]
    fn an_incomplete_snapshot_is_not_applied() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();
        std::fs::write(dir.path().join("saves/Welt/level.dat"), "aktuell").unwrap();

        // Datei aus der Sicherung entfernt; die Metadatei zählt sie noch mit.
        std::fs::remove_file(
            manager
                .backups_dir()
                .join(&backup.id)
                .join("saves/Welt/region/r.0.0.mca"),
        )
        .unwrap();

        let error = manager.restore(&backup.id).unwrap_err();
        assert!(
            matches!(error, LauncherError::BackupIncomplete(_)),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("saves/Welt/level.dat")).unwrap(),
            "aktuell",
            "eine unvollständige Sicherung darf nichts überschreiben"
        );
    }

    #[test]
    fn a_failed_restore_rolls_back_what_it_already_wrote() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();

        std::fs::write(dir.path().join("saves/Welt/level.dat"), "aktuell").unwrap();
        std::fs::write(dir.path().join("config/bamboo.toml"), "aktuelle-config").unwrap();
        // An der Stelle einer Datei aus der Sicherung steht jetzt ein Ordner:
        // das Zurückschreiben dieser Datei muss scheitern – und zwar nachdem
        // Welt und Config bereits ersetzt wurden.
        std::fs::remove_file(dir.path().join("options.txt")).unwrap();
        std::fs::create_dir_all(dir.path().join("options.txt")).unwrap();

        assert!(manager.restore(&backup.id).is_err());

        assert_eq!(
            std::fs::read_to_string(dir.path().join("saves/Welt/level.dat")).unwrap(),
            "aktuell",
            "bereits eingespielte Welt wurde nicht zurückgenommen"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("config/bamboo.toml")).unwrap(),
            "aktuelle-config",
            "bereits eingespielte Config wurde nicht zurückgenommen"
        );
        assert!(dir.path().join("options.txt").is_dir());
        assert!(!dir.path().join(RESTORE_STAGING).exists());
        assert!(!dir.path().join(RESTORE_UNDO).exists());
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
    fn a_failed_prune_deletes_nothing() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let mut ids = Vec::new();
        for index in 0..3 {
            write(
                &dir.path().join("options.txt"),
                &format!("fov:{}", 70 + index),
            );
            ids.push(manager.create("Rotation", 99).unwrap().unwrap().id);
        }
        // Der Papierkorb lässt sich nicht anlegen: das Beiseitelegen der
        // überzähligen Sicherungen scheitert, bevor eine angefasst wurde.
        let blocked = manager.backups_dir().join(format!("{STAGING_PREFIX}trash"));
        write(&blocked, "im weg");

        let error = manager.prune(1).unwrap_err();
        assert!(matches!(error, LauncherError::Io(_)), "{error}");
        assert_eq!(
            manager.list().unwrap().len(),
            3,
            "keine Sicherung darf verschwinden"
        );
        for id in &ids {
            assert!(
                manager.backups_dir().join(id).join(META_FILE).is_file(),
                "Sicherung {id} wurde halb gelöscht"
            );
        }
    }

    #[test]
    fn deleting_a_snapshot_reports_a_failure_instead_of_a_half_backup() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();
        let blocked = manager.backups_dir().join(format!("{STAGING_PREFIX}trash"));
        write(&blocked, "im weg");

        assert!(manager.remove(&backup.id).is_err());
        assert!(
            manager
                .backups_dir()
                .join(&backup.id)
                .join(META_FILE)
                .is_file(),
            "die Sicherung muss unverändert und gelistet bleiben"
        );
        assert_eq!(manager.list().unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_snapshot_does_not_follow_a_link_inside_it() {
        use crate::safe_fs::test_support::dir_link;

        let dir = temp_instance();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("geheim.txt"), "draussen");
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();
        if !dir_link(
            outside.path(),
            &manager.backups_dir().join(&backup.id).join("link"),
        ) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }

        manager.remove(&backup.id).unwrap();

        assert!(manager.list().unwrap().is_empty());
        assert!(
            outside.path().join("geheim.txt").is_file(),
            "hinter dem Link darf nichts gelöscht werden"
        );
    }

    #[test]
    fn a_half_deleted_snapshot_is_not_listed_and_is_swept_by_rotation() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        manager.create("alt", 99).unwrap().unwrap();
        write(&dir.path().join("options.txt"), "fov:90");
        let backup = manager.create("neu", 99).unwrap().unwrap();
        // Rest eines abgebrochenen Löschens: nicht mehr gelistet, aber noch auf
        // der Platte.
        let leftover = manager
            .backups_dir()
            .join(format!("{STAGING_PREFIX}trash/0"));
        write(&leftover.join("saves/Welt/level.dat"), "rest");

        assert_eq!(manager.list().unwrap().len(), 2);
        assert_eq!(manager.prune(1).unwrap(), 1);
        assert!(!leftover.exists(), "der Rest muss eingesammelt werden");
        assert_eq!(manager.list().unwrap().len(), 1);
        assert!(manager.backups_dir().join(&backup.id).is_dir());
    }

    #[test]
    fn a_create_sweeps_leftover_staging() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let leftover = manager
            .backups_dir()
            .join(format!("{STAGING_PREFIX}abgebrochen"));
        write(&leftover.join("mods/alt.jar"), "rest");

        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();

        assert!(!leftover.exists(), "der Rest muss eingesammelt werden");
        assert_eq!(manager.list().unwrap().len(), 1);
        // Ein Rest darf die neue Sicherung nicht verfälschen.
        assert!(manager.restore(&backup.id).is_ok());
    }

    #[test]
    fn a_failed_rotation_is_reported_not_swallowed() {
        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let old = manager.create("alt", 99).unwrap().unwrap();

        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            // Ohne Löschfreigabe geöffnet: die alte Sicherung lässt sich nicht
            // beiseitelegen, die Rotation scheitert.
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x0000_0001)
                .open(manager.backups_dir().join(&old.id).join(META_FILE))
                .unwrap()
        };
        #[cfg(not(windows))]
        {
            eprintln!("Ohne Windows keine Sperre; Test übersprungen");
            return;
        }

        write(&dir.path().join("options.txt"), "fov:90");
        let (entry, warnings) = manager.create_reported("neu", 1).unwrap();

        assert!(entry.is_some(), "die neue Sicherung entsteht trotzdem");
        assert_eq!(
            warnings.len(),
            1,
            "die misslungene Rotation muss gemeldet werden, nicht nur geloggt"
        );
        assert_eq!(
            manager.list().unwrap().len(),
            2,
            "nichts wurde halb gelöscht"
        );
        assert!(
            manager
                .backups_dir()
                .join(&old.id)
                .join(META_FILE)
                .is_file(),
            "die alte Sicherung bleibt vollständig"
        );
        drop(held);
    }

    #[test]
    fn a_staging_that_cannot_be_removed_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join(format!("{STAGING_PREFIX}weg"));
        let error = failed_staging(missing, LauncherError::BackupNotFound("x".to_string()));
        assert!(
            matches!(error, LauncherError::BackupNotFound(_)),
            "ohne Rest bleibt die Ursache: {error}"
        );

        let staging = dir.path().join(format!("{STAGING_PREFIX}gescheitert"));
        write(&staging.join("mods/alt.jar"), "rest");
        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            // Ohne Löschfreigabe geöffnet: der Ordner lässt sich nicht entfernen.
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x0000_0001)
                .open(staging.join("mods/alt.jar"))
                .unwrap()
        };
        #[cfg(not(windows))]
        {
            eprintln!("Ohne Windows keine Sperre; Test übersprungen");
            return;
        }

        let error = failed_staging(
            staging.clone(),
            LauncherError::BackupNotFound("x".to_string()),
        );
        assert!(
            matches!(error, LauncherError::TrashLeftover { .. }),
            "ein liegen gebliebener Rest muss gemeldet werden: {error}"
        );
        assert!(
            error.to_string().contains("gescheitert"),
            "die Meldung nennt den Pfad: {error}"
        );

        drop(held);
        assert!(safe_fs::remove_path(&staging).is_ok());
    }

    #[test]
    fn empty_instance_produces_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::new(dir.path());
        assert!(manager.create("leer", DEFAULT_KEEP).unwrap().is_none());
        assert!(!manager.backups_dir().exists());
    }

    #[test]
    fn a_backup_does_not_read_through_links() {
        use crate::safe_fs::test_support::dir_link;

        let dir = temp_instance();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("geheim.txt"), "draussen");
        if !dir_link(outside.path(), &dir.path().join("saves/Welt/link")) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }

        let manager = BackupManager::new(dir.path());
        let backup = manager.create("links", DEFAULT_KEEP).unwrap().unwrap();
        let snapshot = manager.backups_dir().join(&backup.id);

        assert_eq!(
            backup.files, 4,
            "nur echte Dateien gehören in die Sicherung"
        );
        assert!(!snapshot.join("saves/Welt/link").exists());
        assert!(
            !snapshot.join("saves/Welt/geheim.txt").exists(),
            "Datei außerhalb der Instanz wurde mitgesichert"
        );
    }

    #[test]
    fn restore_refuses_a_linked_target_and_rolls_back() {
        use crate::safe_fs::test_support::dir_link;

        let dir = temp_instance();
        let manager = BackupManager::new(dir.path());
        let backup = manager.create("manuell", DEFAULT_KEEP).unwrap().unwrap();

        // `config` zeigt auf einen Ordner außerhalb der Instanz; `saves` ist
        // bereits eingespielt, wenn das Zurückschreiben an `config` scheitert.
        let outside = tempfile::tempdir().unwrap();
        std::fs::remove_dir_all(dir.path().join("config")).unwrap();
        if !dir_link(outside.path(), &dir.path().join("config")) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }
        std::fs::write(dir.path().join("saves/Welt/level.dat"), "aktuell").unwrap();

        let error = manager.restore(&backup.id).unwrap_err();
        assert!(matches!(error, LauncherError::UnsafePath(_)), "{error}");
        assert!(
            !outside.path().join("bamboo.toml").exists(),
            "durch den Link wurde außerhalb der Instanz geschrieben"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("saves/Welt/level.dat")).unwrap(),
            "aktuell",
            "nach dem Abbruch muss der alte Weltstand stehen"
        );
        assert!(!dir.path().join(RESTORE_STAGING).exists());
        assert!(!dir.path().join(RESTORE_UNDO).exists());
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
