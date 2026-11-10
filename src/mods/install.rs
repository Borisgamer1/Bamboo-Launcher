//! Installation eines aufgelösten Mod-Plans in eine Instanz.
//!
//! Die Bestandsdatei `bamboo-mods.json` merkt sich, welche Projekt-ID in welcher
//! Datei steckt. Ohne sie könnte ein Update nicht erkennen, dass die alte JAR
//! ersetzt werden muss – und der `mods/`-Ordner würde mit jeder Version weiter
//! wachsen, bis Minecraft an doppelten Mods scheitert.

use super::*;
use crate::download::{Downloader, FileSpec};
use crate::instances::Instance;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LEDGER_FILE: &str = "bamboo-mods.json";
const LEDGER_FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModRecord {
    pub file_name: String,
    pub source: ModSource,
    pub project_id: String,
    pub version_id: String,
    pub version_number: String,
    pub installed_at: u64,
    #[serde(default)]
    pub required_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModLedger {
    #[serde(default = "default_format")]
    pub format: u32,
    #[serde(default)]
    pub mods: Vec<ModRecord>,
    /// Zuletzt importiertes Modpack samt seiner Dateien – Grundlage für spätere
    /// Pack-Updates und ein sauberes Entfernen.
    #[serde(default)]
    pub pack: Option<PackRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackRecord {
    pub name: String,
    pub version_id: String,
    /// Dateiname des importierten Archivs, nur zur Information.
    pub source: String,
    pub imported_at: u64,
    pub files: Vec<PackFileRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackFileRecord {
    /// Pfad relativ zum Instanzordner, immer mit `/` als Trenner.
    pub path: String,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

fn default_format() -> u32 {
    LEDGER_FORMAT
}

impl Default for ModLedger {
    fn default() -> Self {
        Self {
            format: LEDGER_FORMAT,
            mods: Vec::new(),
            pack: None,
        }
    }
}

impl ModLedger {
    pub fn load(instance_dir: &Path) -> Result<Self> {
        let path = instance_dir.join(LEDGER_FILE);
        if !path.is_file() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(&path)?;
        serde_json::from_str(&text).map_err(|error| ModError::InvalidLedger {
            path,
            reason: error.to_string(),
        })
    }

    /// Schreibt atomar, damit ein Absturz keine halbe Bestandsdatei hinterlässt.
    pub fn save(&self, instance_dir: &Path) -> Result<()> {
        let path = instance_dir.join(LEDGER_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&temp, &path)?;
        Ok(())
    }

    pub fn find(&self, project_id: &str) -> Option<&ModRecord> {
        self.mods
            .iter()
            .find(|record| record.project_id == project_id)
    }

    /// Projekte, deren Datei noch im `mods/`-Ordner liegt. Manuell gelöschte
    /// Mods gelten damit nicht mehr als installiert.
    pub fn installed_projects(&self, instance_dir: &Path) -> HashSet<String> {
        let mods_dir = instance_dir.join("mods");
        self.mods
            .iter()
            .filter(|record| {
                mods_dir.join(&record.file_name).is_file()
                    || disabled_variant(&mods_dir.join(&record.file_name))
                        .is_some_and(|path| path.is_file())
            })
            .map(|record| record.project_id.clone())
            .collect()
    }

    pub fn upsert(&mut self, record: ModRecord) {
        match self
            .mods
            .iter_mut()
            .find(|existing| existing.project_id == record.project_id)
        {
            Some(existing) => *existing = record,
            None => self.mods.push(record),
        }
        self.mods
            .sort_by(|left, right| left.project_id.cmp(&right.project_id));
    }
}

#[derive(Debug, Clone)]
pub struct InstalledFile {
    pub project_id: String,
    pub title: String,
    pub file_name: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct ModInstallReport {
    pub files: Vec<InstalledFile>,
    pub download: crate::download::DownloadReport,
    pub notes: Vec<PlanNote>,
}

struct Pending {
    project_id: String,
    version_id: String,
    version_number: String,
    title: String,
    source: ModSource,
    required_by: Vec<String>,
    file_name: String,
    url: String,
    sha1: Option<String>,
    size: Option<u64>,
    destination: PathBuf,
}

/// Lädt alle Mods des Plans herunter, ersetzt alte Versionen und aktualisiert
/// die Bestandsdatei. Bei fehlenden Pflichtabhängigkeiten wird nichts angefasst.
pub async fn install_plan<P: ModProvider>(
    provider: &P,
    instance: &Instance,
    plan: &ModPlan,
    downloader: &Downloader,
    ledger: &mut ModLedger,
) -> Result<ModInstallReport> {
    if !plan.unresolved.is_empty() {
        return Err(ModError::UnresolvedDependencies(
            plan.missing_required().join("\n"),
        ));
    }

    let mods_dir = instance.dir.join("mods");
    std::fs::create_dir_all(&mods_dir)?;

    let mut pending: Vec<Pending> = Vec::with_capacity(plan.mods.len());
    let mut owners: HashMap<String, String> = HashMap::new();

    for planned in &plan.mods {
        let download = provider.download(&planned.version).await?;
        let file_name = validate_mod_file_name(&download.file_name)?.to_string();

        if let Some(owner) = owners.get(&file_name) {
            if owner != &planned.version.project_id {
                return Err(ModError::FileNameConflict {
                    file: file_name,
                    projects: format!("{owner} und {}", planned.version.project_id),
                });
            }
        }
        owners.insert(file_name.clone(), planned.version.project_id.clone());

        pending.push(Pending {
            project_id: planned.version.project_id.clone(),
            version_id: planned.version.id.clone(),
            version_number: if planned.version.version_number.trim().is_empty() {
                planned.version.label().to_string()
            } else {
                planned.version.version_number.clone()
            },
            title: planned.version.label().to_string(),
            source: planned.version.source,
            required_by: planned.required_by.clone(),
            destination: mods_dir.join(&file_name),
            file_name,
            url: download.url,
            sha1: download.sha1.map(|hash| hash.to_ascii_lowercase()),
            size: download.size,
        });
    }

    let specs = pending
        .iter()
        .map(|entry| {
            let mut spec = FileSpec::new(entry.destination.clone(), entry.url.clone());
            if let Some(sha1) = &entry.sha1 {
                spec = spec.with_sha1(sha1.clone());
            }
            if let Some(size) = entry.size {
                spec = spec.with_size(size);
            }
            spec
        })
        .collect();
    let download = downloader.download_all(specs, |_| {}).await?;

    // Erst nach erfolgreichen Downloads aufräumen: Schlägt etwas fehl, bleibt
    // die bisherige Installation unverändert benutzbar.
    let mut stale: Vec<PathBuf> = Vec::new();
    for entry in &pending {
        if let Some(record) = ledger.find(&entry.project_id) {
            if record.file_name != entry.file_name {
                stale.push(mods_dir.join(&record.file_name));
            }
        }
    }
    for entry in &pending {
        if let Some(disabled) = disabled_variant(&entry.destination) {
            stale.push(disabled);
        }
    }
    for path in stale {
        if let Some(disabled) = disabled_variant(&path) {
            remove_if_present(&disabled)?;
        }
        remove_if_present(&path)?;
    }

    let installed_at = now_secs();
    for entry in &pending {
        ledger.upsert(ModRecord {
            file_name: entry.file_name.clone(),
            source: entry.source,
            project_id: entry.project_id.clone(),
            version_id: entry.version_id.clone(),
            version_number: entry.version_number.clone(),
            installed_at,
            required_by: entry.required_by.clone(),
        });
    }
    ledger.save(&instance.dir)?;

    Ok(ModInstallReport {
        files: pending
            .iter()
            .map(|entry| InstalledFile {
                project_id: entry.project_id.clone(),
                title: entry.title.clone(),
                file_name: entry.file_name.clone(),
                size: entry.size,
            })
            .collect(),
        download,
        notes: plan.notes.clone(),
    })
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn disabled_variant(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_os_string();
    let mut disabled = name;
    disabled.push(".disabled");
    Some(path.with_file_name(disabled))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bamboo-mods-{}-{}",
            std::process::id(),
            now_secs() as u128 * 1000
                + SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos() as u128
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ledger_round_trips_and_replaces_records() {
        let dir = temp_dir();
        let mut ledger = ModLedger::load(&dir).unwrap();
        assert!(ledger.mods.is_empty());

        ledger.upsert(ModRecord {
            file_name: "a-1.jar".to_string(),
            source: ModSource::Modrinth,
            project_id: "project-a".to_string(),
            version_id: "v1".to_string(),
            version_number: "1.0".to_string(),
            installed_at: 1,
            required_by: Vec::new(),
        });
        ledger.save(&dir).unwrap();

        let mut loaded = ModLedger::load(&dir).unwrap();
        assert_eq!(loaded.mods.len(), 1);

        loaded.upsert(ModRecord {
            file_name: "a-2.jar".to_string(),
            source: ModSource::Modrinth,
            project_id: "project-a".to_string(),
            version_id: "v2".to_string(),
            version_number: "2.0".to_string(),
            installed_at: 2,
            required_by: vec!["project-b".to_string()],
        });
        loaded.save(&dir).unwrap();

        let loaded = ModLedger::load(&dir).unwrap();
        assert_eq!(loaded.mods.len(), 1);
        assert_eq!(loaded.mods[0].file_name, "a-2.jar");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn installed_projects_ignore_missing_files() {
        let dir = temp_dir();
        let mut ledger = ModLedger::default();
        for (project, file) in [("a", "a.jar"), ("b", "b.jar"), ("c", "c.jar")] {
            ledger.upsert(ModRecord {
                file_name: file.to_string(),
                source: ModSource::CurseForge,
                project_id: project.to_string(),
                version_id: "v".to_string(),
                version_number: "1".to_string(),
                installed_at: 0,
                required_by: Vec::new(),
            });
        }
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods").join("a.jar"), b"x").unwrap();
        std::fs::write(dir.join("mods").join("b.jar.disabled"), b"x").unwrap();

        let installed = ledger.installed_projects(&dir);
        assert!(installed.contains("a"));
        assert!(installed.contains("b"));
        assert!(!installed.contains("c"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_ledger_is_reported_with_a_way_out() {
        let dir = temp_dir();
        std::fs::write(dir.join(LEDGER_FILE), b"{ kaputt").unwrap();
        match ModLedger::load(&dir) {
            Err(ModError::InvalidLedger { path, .. }) => {
                assert!(path.ends_with(LEDGER_FILE));
            }
            other => panic!("erwartet: InvalidLedger, erhalten: {other:?}"),
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
