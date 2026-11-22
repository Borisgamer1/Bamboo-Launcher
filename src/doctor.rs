//! Der Instanz-Doktor.
//!
//! Alle Support-Fälle der letzten Zeit hatten dieselbe Form: eine Datei liegt
//! im Instanzordner, wird aber im Spiel nicht geladen. Der Doktor prüft die
//! Stellen, an denen das passiert, und nennt zu jedem Fund den nächsten Schritt.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::instances::{self, Instance};
use crate::launcher;
use crate::version;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// Aktion, die die Oberfläche anbieten darf (`resource-packs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub instance: String,
    pub version_id: String,
    pub minecraft_version: Option<String>,
    pub fabric: bool,
    pub findings: Vec<Finding>,
}

impl Report {
    fn push(
        &mut self,
        code: &str,
        severity: Severity,
        title: impl Into<String>,
        detail: impl Into<String>,
        action: Option<&str>,
    ) {
        self.findings.push(Finding {
            code: code.to_string(),
            severity,
            title: title.into(),
            detail: detail.into(),
            action: action.map(str::to_string),
        });
    }

    /// True, wenn etwas den Start verhindert.
    pub fn blocked(&self) -> bool {
        self.findings
            .iter()
            .any(|finding| finding.severity == Severity::Error)
    }
}

/// Wo die Version der Instanz liegt (eigene `versions/` oder die Spielwurzel).
fn content_root(game_root: &Path, instance_dir: &Path, version_id: &str) -> PathBuf {
    let own = instances::content_root(instance_dir);
    if !version_id.is_empty() {
        if let Some(own) = &own {
            if own.join("versions").join(version_id).is_dir() {
                return own.clone();
            }
        }
        if game_root.join("versions").join(version_id).is_dir() {
            return game_root.to_path_buf();
        }
    }
    own.filter(|dir| dir.join("versions").is_dir())
        .unwrap_or_else(|| game_root.to_path_buf())
}

fn mod_files(mods_dir: &Path) -> Vec<(String, Option<String>)> {
    let Ok(entries) = std::fs::read_dir(mods_dir) else {
        return Vec::new();
    };
    let mut files: Vec<(String, Option<String>)> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        })
        .map(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let id = instances::read_mod_metadata(&path).and_then(|meta| meta.id);
            (name, id)
        })
        .collect();
    files.sort_by(|left, right| left.0.to_lowercase().cmp(&right.0.to_lowercase()));
    files
}

fn pack_files(resourcepacks: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(resourcepacks) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.to_ascii_lowercase().ends_with(".zip"))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    names
}

/// Prüft eine Instanz und gibt die Funde in fester Reihenfolge zurück.
pub fn examine(game_root: &Path, instance: &Instance) -> Report {
    let version_id = instance.version_id.clone().unwrap_or_default();
    let fabric = version_id.to_ascii_lowercase().contains("fabric");
    let mut report = Report {
        instance: instance.name.clone(),
        version_id: version_id.clone(),
        minecraft_version: None,
        fabric,
        findings: Vec::new(),
    };

    if version_id.trim().is_empty() {
        report.push(
            "no-version",
            Severity::Error,
            "Keine Version eingetragen",
            "Die Instanz hat keine Version. Trage eine Minecraft-Version ein, sonst kann der Launcher sie nicht starten.",
            None,
        );
    } else {
        let root = content_root(game_root, &instance.dir, &version_id);
        match version::resolve_version(&root, &version_id) {
            Ok(resolved) => report.minecraft_version = Some(resolved.minecraft_version),
            Err(_) => report.push(
                "version-missing",
                Severity::Error,
                "Basisversion fehlt",
                format!(
                    "„{version_id}“ liegt nicht in den installierten Versionen. Der Start endet vor dem Spiel."
                ),
                None,
            ),
        }
    }

    let mods = mod_files(&instance.dir.join("mods"));
    if !fabric && !mods.is_empty() {
        report.push(
            "mods-without-loader",
            Severity::Warning,
            "Mods ohne Mod-Loader",
            "In dieser Instanz liegen Mods, aber die Version hat keinen Loader. Vanilla ignoriert den Ordner komplett.",
            None,
        );
    }

    if fabric && !mods.is_empty() {
        let has_api = mods.iter().any(|(name, id)| {
            id.as_deref() == Some("fabric-api")
                || name.to_ascii_lowercase().starts_with("fabric-api")
        });
        if !has_api {
            report.push(
                "fabric-api-missing",
                Severity::Warning,
                "Fabric API fehlt",
                "Ohne Fabric API starten die meisten Fabric-Mods nicht; einige brechen den Start sogar ab. Installiere Fabric API über den Mod-Browser.",
                None,
            );
        }
    }

    let mut ids: Vec<&str> = Vec::new();
    for (_, id) in &mods {
        if let Some(id) = id.as_deref() {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    for pair in ids.windows(2) {
        if pair[0] == pair[1] {
            report.push(
                "duplicate-mod",
                Severity::Warning,
                "Eine Mod liegt doppelt",
                format!(
                    "„{}“ steckt in mehr als einer Jar. Minecraft lädt beide und kann daran scheitern.",
                    pair[0]
                ),
                None,
            );
            break;
        }
    }

    let packs = pack_files(&instance.dir.join("resourcepacks"));
    let selected = launcher::selected_resource_packs(&instance.dir);
    let missing: Vec<&String> = packs
        .iter()
        .filter(|name| !selected.iter().any(|id| id == &format!("file/{name}")))
        .collect();
    if !missing.is_empty() {
        let names = missing
            .iter()
            .take(3)
            .map(|name| format!("„{name}“"))
            .collect::<Vec<_>>()
            .join(", ");
        let rest = missing.len().saturating_sub(3);
        report.push(
            "resource-packs-not-enabled",
            Severity::Warning,
            "Resourcepacks sind nicht ausgewählt",
            format!(
                "{names}{} liegen im Ordner, stehen aber nicht in der options.txt. Minecraft lädt sie deshalb nicht.",
                if rest > 0 {
                    format!(" und {rest} weitere")
                } else {
                    String::new()
                }
            ),
            Some("resource-packs"),
        );
    }

    let cosmetics = instance.dir.join("bamboo").join("cosmetics");
    let has_packages = std::fs::read_dir(&cosmetics)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("cosmiq"))
        });
    if fabric
        && report.minecraft_version.as_deref() == Some("26.3")
        && has_packages
        && !instances::cosmetics_mod_present(&instance.dir)
    {
        report.push(
            "cosmetics-mod-missing",
            Severity::Info,
            "Cosmetics-Mod fehlt",
            "Die Pakete liegen bereit, aber die Mod, die sie im Spiel zeigt, ist nicht im mods-Ordner. Der nächste Start legt sie an, sofern Cosmetics für diese Instanz eingeschaltet sind.",
            None,
        );
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(dir: &Path, version_id: &str) -> Instance {
        Instance {
            name: "Test".to_string(),
            dir: dir.to_path_buf(),
            version_id: Some(version_id.to_string()),
        }
    }

    fn codes(report: &Report) -> Vec<&str> {
        report.findings.iter().map(|finding| finding.code.as_str()).collect()
    }

    #[test]
    fn a_missing_base_version_blocks_the_start() {
        let root = tempfile::tempdir().unwrap();
        let instance = instance(&root.path().join("instance"), "26.3");
        std::fs::create_dir_all(&instance.dir).unwrap();
        let report = examine(root.path(), &instance);
        assert!(codes(&report).contains(&"version-missing"));
        assert!(report.blocked());
    }

    #[test]
    fn packs_in_the_folder_but_not_in_the_options_are_reported() {
        let root = tempfile::tempdir().unwrap();
        let instance = instance(&root.path().join("instance"), "");
        std::fs::create_dir_all(instance.dir.join("resourcepacks")).unwrap();
        std::fs::write(instance.dir.join("resourcepacks/Dark.zip"), b"pk").unwrap();
        std::fs::write(
            instance.dir.join("options.txt"),
            "resourcePacks:[\"vanilla\"]\n",
        )
        .unwrap();
        let report = examine(root.path(), &instance);
        let finding = report
            .findings
            .iter()
            .find(|finding| finding.code == "resource-packs-not-enabled")
            .expect("pack finding");
        assert_eq!(finding.action.as_deref(), Some("resource-packs"));
        assert!(finding.detail.contains("Dark.zip"));
    }

    #[test]
    fn a_fabric_instance_with_mods_but_without_fabric_api_is_warned() {
        let root = tempfile::tempdir().unwrap();
        let instance = instance(&root.path().join("instance"), "fabric-loader-0.20.1-26.3");
        std::fs::create_dir_all(instance.dir.join("mods")).unwrap();
        std::fs::write(instance.dir.join("mods/sodium.jar"), b"not a jar").unwrap();
        let report = examine(root.path(), &instance);
        assert!(codes(&report).contains(&"fabric-api-missing"));
    }
}
