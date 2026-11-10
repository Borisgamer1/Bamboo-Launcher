//! Zwischenspeicher für erkannte Inhalte.
//!
//! Jede Mod wird über ihren Hash bei Modrinth und CurseForge gesucht. Das
//! Ergebnis ändert sich nur, wenn die Datei sich ändert, deshalb wird es pro
//! Instanz in `bamboo/identified.json` abgelegt. Schlüssel ist Ordnertyp und
//! Dateiname; Größe und Änderungszeit entscheiden, ob der Eintrag noch gilt.
//! So zeigt der Inhalt-Tab bekannte Namen auch dann, wenn gerade keine Quelle
//! erreichbar ist.

use super::identify::Identified;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "identified.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    size: u64,
    modified: u64,
    identified: Identified,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IdentityCache {
    #[serde(default)]
    entries: HashMap<String, Entry>,
    #[serde(skip)]
    dirty: bool,
}

impl IdentityCache {
    pub fn path(instance_dir: &Path) -> PathBuf {
        instance_dir.join("bamboo").join(FILE_NAME)
    }

    pub fn load(instance_dir: &Path) -> Self {
        std::fs::read_to_string(Self::path(instance_dir))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Liefert nur, wenn Größe und Änderungszeit exakt zur Datei passen.
    pub fn get(&self, key: &str, size: u64, modified: u64) -> Option<&Identified> {
        let entry = self.entries.get(key)?;
        if entry.size != size || entry.modified != modified {
            return None;
        }
        Some(&entry.identified)
    }

    pub fn insert(&mut self, key: String, size: u64, modified: u64, identified: Identified) {
        self.entries.insert(
            key,
            Entry {
                size,
                modified,
                identified,
            },
        );
        self.dirty = true;
    }

    /// Schreibfehler dürfen den Inhalt-Tab nicht stören; dann bleibt der
    /// Speicher eben ungenutzt.
    pub fn save(&mut self, instance_dir: &Path) {
        if !self.dirty {
            return;
        }
        let path = Self::path(instance_dir);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(self) {
            if std::fs::write(&path, bytes).is_ok() {
                self.dirty = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identified(name: &str) -> Identified {
        Identified {
            source: "modrinth".to_string(),
            project_id: "abc".to_string(),
            slug: "abc".to_string(),
            name: name.to_string(),
            icon_url: String::new(),
            version_number: "1.0".to_string(),
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cache = IdentityCache::load(dir.path());
        cache.insert("mods/a.jar".to_string(), 10, 20, identified("A"));

        let loaded = IdentityCache::load(dir.path());
        assert!(loaded.get("mods/a.jar", 10, 20).is_none(), "not saved yet");

        cache.save(dir.path());
        let loaded = IdentityCache::load(dir.path());
        assert_eq!(
            loaded
                .get("mods/a.jar", 10, 20)
                .map(|entry| entry.name.as_str()),
            Some("A")
        );
    }

    #[test]
    fn a_changed_file_invalidates_its_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cache = IdentityCache::load(dir.path());
        cache.insert("mods/a.jar".to_string(), 10, 20, identified("A"));

        assert!(cache.get("mods/a.jar", 11, 20).is_none());
        assert!(cache.get("mods/a.jar", 10, 21).is_none());
        assert!(cache.get("mods/a.jar", 10, 20).is_some());
    }

    #[test]
    fn corrupt_cache_starts_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("bamboo")).expect("bamboo");
        std::fs::write(IdentityCache::path(dir.path()), "{ kaputt").expect("write");

        let cache = IdentityCache::load(dir.path());
        assert!(cache.get("mods/a.jar", 10, 20).is_none());
    }

    #[test]
    fn save_without_changes_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut cache = IdentityCache::load(dir.path());
        cache.save(dir.path());
        assert!(!IdentityCache::path(dir.path()).exists());
    }
}
