//! Sammelabfrage für Updates installierter Dateien.
//!
//! Eine Instanz mit 200 Mods einzeln zu prüfen heißt 200 Versionslisten
//! abzurufen. Modrinth beantwortet dieselbe Frage für alle Dateien auf einmal:
//! einmal, welche Hashes es kennt, und einmal, für welche es eine neuere
//! Version gibt. Was Modrinth nicht kennt (CurseForge-Inhalt, lokale Umbauten),
//! bleibt offen und wird von der Oberfläche einzeln nachgefragt.

use super::http::ApiClient;
use super::modrinth::MODRINTH_API;
use super::{Loader, ModSource, Result};
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};

/// Eine Datei, für die es eine neuere Version gibt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateEntry {
    /// Dateiname auf der Platte, wie die Oberfläche ihn kennt.
    pub file: String,
    pub version_number: String,
    pub version_id: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub url: String,
    pub file_name: String,
}

/// Antwort der Sammelabfrage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateReport {
    /// Dateien, die Modrinth kennt – auch ohne neuere Version.
    pub resolved: Vec<String>,
    /// Dateien mit einer neueren Version für diese Instanz.
    pub updates: Vec<UpdateEntry>,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    primary: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RawVersion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    files: Vec<RawFile>,
}

/// Prüft alle Dateien einer Instanz gegen Modrinth.
///
/// `files` sind Paare aus Dateiname und SHA-1. `game_version` und `loader`
/// grenzen das Update auf das ein, was die Instanz überhaupt laden kann;
/// fehlen sie, schlägt Modrinth die neueste Version unabhängig davon vor.
pub async fn check(
    files: &[(String, String)],
    game_version: Option<&str>,
    loader: Option<Loader>,
) -> Result<UpdateReport> {
    check_at(files, game_version, loader, MODRINTH_API).await
}

/// Wie [`check`], aber gegen den angegebenen Server (für Tests).
pub async fn check_at(
    files: &[(String, String)],
    game_version: Option<&str>,
    loader: Option<Loader>,
    base: &str,
) -> Result<UpdateReport> {
    let mut report = UpdateReport::default();
    let hashes: Vec<&str> = files
        .iter()
        .map(|(_, hash)| hash.as_str())
        .filter(|hash| !hash.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if hashes.is_empty() {
        return Ok(report);
    }

    let api = ApiClient::new(base, ModSource::Modrinth)?;
    let known: HashMap<String, RawVersion> = api
        .post(
            "/version_files",
            &serde_json::json!({ "hashes": hashes, "algorithm": "sha1" }),
        )
        .await?;

    let mut body = serde_json::json!({ "hashes": hashes, "algorithm": "sha1" });
    if let Some(loader) = loader {
        body["loaders"] = serde_json::json!([loader.modrinth_name()]);
    }
    if let Some(game_version) = game_version.filter(|value| !value.trim().is_empty()) {
        body["game_versions"] = serde_json::json!([game_version.trim()]);
    }
    // Ein Fehler hier darf den bekannten Stand nicht verschlucken: dann bleibt
    // eben alles "aktuell" und die Oberfläche fragt die Reste einzeln nach.
    let newer: HashMap<String, RawVersion> = api
        .post("/version_files/update", &body)
        .await
        .unwrap_or_default();

    for (file, hash) in files {
        let Some(installed) = known.get(hash) else {
            continue;
        };
        let Some(version) = newer.get(hash) else {
            report.resolved.push(file.clone());
            continue;
        };
        // `/version_files/update` liefert auch dann die neueste passende
        // Version, wenn das die installierte ist. Ohne diesen Vergleich meldet
        // der Launcher jedes Mal ein Update, obwohl nichts zu tun ist.
        if same_version(installed, version) {
            report.resolved.push(file.clone());
            continue;
        }
        let Some(entry) = entry_for(file, version) else {
            // Gemeldet, aber ohne nutzbaren Download: offen lassen, damit die
            // Einzelprüfung den Fall übernehmen kann.
            continue;
        };
        report.updates.push(entry);
    }

    report.resolved.sort();
    report
        .updates
        .sort_by(|left, right| left.file.cmp(&right.file));
    Ok(report)
}

/// Ist die vorgeschlagene Version die bereits installierte?
///
/// Die ID ist die verlässliche Kennung; fehlt sie in einer Antwort, bleibt der
/// Versionsname als Notnagel.
fn same_version(installed: &RawVersion, candidate: &RawVersion) -> bool {
    if !installed.id.is_empty() && !candidate.id.is_empty() {
        return installed.id == candidate.id;
    }
    !installed.version_number.is_empty()
        && installed.version_number.trim() == candidate.version_number.trim()
}

fn entry_for(file: &str, version: &RawVersion) -> Option<UpdateEntry> {
    let chosen = version
        .files
        .iter()
        .find(|candidate| candidate.primary)
        .or_else(|| version.files.first())?;
    if chosen.url.trim().is_empty() || chosen.filename.trim().is_empty() {
        return None;
    }
    Some(UpdateEntry {
        file: file.to_string(),
        version_number: version.version_number.clone(),
        version_id: version.id.clone(),
        game_versions: version.game_versions.clone(),
        loaders: version
            .loaders
            .iter()
            .map(|loader| loader.to_ascii_lowercase())
            .collect(),
        url: chosen.url.clone(),
        file_name: chosen.filename.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installed_version_is_not_an_update() {
        let installed = RawVersion {
            id: "abc".to_string(),
            version_number: "1.0".to_string(),
            ..RawVersion::default()
        };
        assert!(same_version(&installed, &installed));

        let newer = RawVersion {
            id: "def".to_string(),
            version_number: "1.1".to_string(),
            ..RawVersion::default()
        };
        assert!(!same_version(&installed, &newer));

        // Antworten ohne ID fallen auf den Versionsnamen zurück.
        let without_ids = RawVersion {
            version_number: "1.0".to_string(),
            ..RawVersion::default()
        };
        assert!(same_version(&without_ids, &without_ids));
    }

    #[test]
    fn prefers_the_primary_file_of_a_version() {
        let version = RawVersion {
            id: "abc".to_string(),
            version_number: "2.0".to_string(),
            game_versions: vec!["1.20.1".to_string()],
            loaders: vec!["Fabric".to_string()],
            files: vec![
                RawFile {
                    filename: "sources.jar".to_string(),
                    url: "https://example/sources.jar".to_string(),
                    primary: false,
                },
                RawFile {
                    filename: "mod.jar".to_string(),
                    url: "https://example/mod.jar".to_string(),
                    primary: true,
                },
            ],
        };
        let entry = entry_for("mod.jar", &version).unwrap();
        assert_eq!(entry.file_name, "mod.jar");
        assert_eq!(entry.version_id, "abc");
        assert_eq!(entry.loaders, vec!["fabric".to_string()]);
    }

    #[test]
    fn skips_a_version_without_a_download() {
        let version = RawVersion {
            id: "abc".to_string(),
            version_number: "2.0".to_string(),
            game_versions: Vec::new(),
            loaders: Vec::new(),
            files: Vec::new(),
        };
        assert!(entry_for("mod.jar", &version).is_none());
    }
}
