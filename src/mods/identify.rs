//! Woher kommt eine installierte Datei?
//!
//! Modrinth erkennt eine Datei an ihrem SHA-1, CurseForge nur an seinem
//! Fingerprint: MurmurHash2 über die rohen Bytes, wobei die vier
//! ASCII-Whitespace-Bytes (Tab, LF, CR, Space) vorher entfernt werden und der
//! Seed `1 ^ gefilterte Länge` lautet. Der Zip-Aufbau wird bewusst nicht
//! interpretiert – ein neu gepacktes Archiv mit gleichen Einträgen hat einen
//! anderen Fingerprint.
//!
//! Beide Wege sind optional. Ohne Netz, ohne API-Key oder ohne Treffer bleibt
//! die Datei einfach unerkannt; sie verschwindet nie aus der Liste.

use super::curseforge::CurseForgeClient;
use super::http::ApiClient;
use super::modrinth::MODRINTH_API;
use super::ModSource;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MURMUR_MULTIPLIER: u32 = 0x5bd1_e995;

/// Eine Datei, die der Launcher auf der Platte gefunden hat.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub file_name: String,
    pub sha1: String,
    pub fingerprint: u32,
}

/// Was die Quelle über die Datei weiß. Leere Felder heißen „nicht geliefert“.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identified {
    /// `modrinth` oder `curseforge`.
    pub source: String,
    pub project_id: String,
    /// Slug, damit Links auf die Projektseite zeigen statt auf eine ID.
    pub slug: String,
    pub name: String,
    pub icon_url: String,
    pub version_number: String,
}

/// CurseForge-Fingerprint einer Datei. Siehe Modulkopf für das Verfahren.
pub fn curseforge_fingerprint(bytes: &[u8]) -> u32 {
    fn stripped(byte: u8) -> bool {
        matches!(byte, b'\t' | b'\n' | b'\r' | b' ')
    }

    let filtered = bytes.iter().filter(|byte| !stripped(**byte)).count();
    let mut hash = (1 ^ filtered as u32) as u32;
    let mut word: u32 = 0;
    let mut shift = 0u32;

    for byte in bytes {
        if stripped(*byte) {
            continue;
        }
        word |= (*byte as u32) << shift;
        shift += 8;
        if shift == 32 {
            let mut mixed = word.wrapping_mul(MURMUR_MULTIPLIER);
            mixed = (mixed ^ (mixed >> 24)).wrapping_mul(MURMUR_MULTIPLIER);
            hash = hash.wrapping_mul(MURMUR_MULTIPLIER) ^ mixed;
            word = 0;
            shift = 0;
        }
    }
    if shift > 0 {
        hash = (hash ^ word).wrapping_mul(MURMUR_MULTIPLIER);
    }

    hash ^= hash >> 13;
    hash = hash.wrapping_mul(MURMUR_MULTIPLIER);
    hash ^= hash >> 15;
    hash
}

#[derive(Debug, Deserialize)]
struct HashVersion {
    project_id: String,
    #[serde(default)]
    version_number: String,
}

#[derive(Debug, Deserialize)]
struct ProjectInfo {
    id: String,
    // Alle drei liefert Modrinth auch als `null`; ein `String` würde die
    // ganze Antwort und damit jede Erkennung im Batch verwerfen.
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
}

/// Ordnet die Modrinth-Antworten den Dateien zu. Getrennt von den Anfragen,
/// damit die Zuordnung ohne Netz prüfbar bleibt.
fn modrinth_identifications(
    candidates: &[Candidate],
    versions: &HashMap<String, HashVersion>,
    projects: &HashMap<String, ProjectInfo>,
) -> HashMap<String, Identified> {
    let mut found = HashMap::new();
    for candidate in candidates {
        let Some(version) = versions.get(&candidate.sha1) else {
            continue;
        };
        let project = projects.get(&version.project_id);
        found.insert(
            candidate.file_name.clone(),
            Identified {
                source: "modrinth".to_string(),
                project_id: project
                    .map(|p| p.id.clone())
                    .unwrap_or_else(|| version.project_id.clone()),
                slug: project.and_then(|p| p.slug.clone()).unwrap_or_default(),
                name: project.and_then(|p| p.title.clone()).unwrap_or_default(),
                icon_url: project.and_then(|p| p.icon_url.clone()).unwrap_or_default(),
                version_number: version.version_number.clone(),
            },
        );
    }
    found
}

async fn identify_modrinth(
    candidates: &[Candidate],
    base: &str,
) -> super::Result<HashMap<String, Identified>> {
    let api = ApiClient::new(base, ModSource::Modrinth)?;

    let hashes: Vec<&str> = candidates
        .iter()
        .map(|candidate| candidate.sha1.as_str())
        .collect();
    let body = serde_json::json!({ "hashes": hashes, "algorithm": "sha1" });
    let versions: HashMap<String, HashVersion> = api.post("/version_files", &body).await?;
    if versions.is_empty() {
        return Ok(HashMap::new());
    }

    let ids: Vec<&str> = versions
        .values()
        .map(|version| version.project_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let query = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
    let projects: Vec<ProjectInfo> = api.get("/projects", &[("ids", query)]).await?;
    let projects: HashMap<String, ProjectInfo> = projects
        .into_iter()
        .map(|project| (project.id.clone(), project))
        .collect();

    Ok(modrinth_identifications(candidates, &versions, &projects))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintFile {
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    mod_id: u64,
    #[serde(default)]
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct FingerprintMatch {
    #[serde(default)]
    file: Option<FingerprintFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintBody {
    #[serde(default)]
    exact_matches: Vec<FingerprintMatch>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseForgeMod {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    logo: Option<CurseForgeLogo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseForgeLogo {
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    url: String,
}

async fn identify_curseforge(
    candidates: &[Candidate],
    api_key: Option<String>,
    base: &str,
) -> super::Result<HashMap<String, Identified>> {
    let Some(api_key) = api_key else {
        return Ok(HashMap::new());
    };
    let client = CurseForgeClient::with_base(Some(api_key), base)?;

    let fingerprints: Vec<u32> = candidates
        .iter()
        .map(|candidate| candidate.fingerprint)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let body = serde_json::json!({ "fingerprints": fingerprints });
    let raw = client.post_json("/fingerprints", &body).await?;
    let parsed: Option<FingerprintBody> =
        serde_json::from_value(raw.get("data").cloned().unwrap_or(serde_json::Value::Null)).ok();
    let Some(body) = parsed else {
        return Ok(HashMap::new());
    };

    // 32 Bit kollidieren: nur ein Treffer mit gleichem Dateinamen gilt.
    let mut by_name: HashMap<String, (u64, String)> = HashMap::new();
    for found in body.exact_matches {
        let Some(file) = found.file else { continue };
        if file.mod_id == 0 {
            continue;
        }
        let name = file.file_name.to_lowercase();
        let version = if file.display_name.trim().is_empty() {
            file.file_name.clone()
        } else {
            file.display_name.clone()
        };
        by_name.insert(name, (file.mod_id, version));
    }

    let mut found = HashMap::new();
    let mut mod_ids: Vec<u64> = by_name
        .values()
        .map(|(mod_id, _)| *mod_id)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if mod_ids.is_empty() {
        return Ok(found);
    }
    mod_ids.sort_unstable();
    let body = serde_json::json!({ "modIds": mod_ids });
    let raw = client.post_json("/mods", &body).await?;
    let mods: Vec<CurseForgeMod> =
        serde_json::from_value(raw.get("data").cloned().unwrap_or(serde_json::Value::Null))
            .unwrap_or_default();
    let mods: HashMap<u64, CurseForgeMod> =
        mods.into_iter().map(|entry| (entry.id, entry)).collect();

    for candidate in candidates {
        let Some((mod_id, version_number)) = by_name.get(&candidate.file_name.to_lowercase())
        else {
            continue;
        };
        let project = mods.get(mod_id);
        let icon_url = project
            .and_then(|project| project.logo.as_ref())
            .map(|logo| {
                if logo.thumbnail_url.trim().is_empty() {
                    logo.url.clone()
                } else {
                    logo.thumbnail_url.clone()
                }
            })
            .unwrap_or_default();
        found.insert(
            candidate.file_name.clone(),
            Identified {
                source: "curseforge".to_string(),
                project_id: project
                    .map(|p| p.id.to_string())
                    .unwrap_or_else(|| mod_id.to_string()),
                slug: project.map(|p| p.slug.clone()).unwrap_or_default(),
                name: project.map(|p| p.name.clone()).unwrap_or_default(),
                icon_url,
                version_number: version_number.clone(),
            },
        );
    }

    Ok(found)
}

/// Basis-URLs beider Quellen, überschreibbar damit Tests gegen einen lokalen
/// Server laufen – wie [`CurseForgeClient::with_base`].
#[derive(Debug, Clone)]
pub struct IdentifyBases {
    pub modrinth: String,
    pub curseforge: String,
}

impl Default for IdentifyBases {
    fn default() -> Self {
        Self {
            modrinth: MODRINTH_API.to_string(),
            curseforge: super::curseforge::CURSEFORGE_API.to_string(),
        }
    }
}

/// Erkennt so viele Dateien wie möglich. Fehler einer Quelle werden
/// geschluckt: eine nicht erreichbare API darf den lokalen Eintrag nicht
/// löschen oder die Liste blockieren.
pub async fn identify(
    candidates: &[Candidate],
    curseforge_api_key: Option<String>,
) -> HashMap<String, Identified> {
    identify_at(candidates, curseforge_api_key, &IdentifyBases::default()).await
}

/// Wie [`identify`], aber gegen die angegebenen Server.
pub async fn identify_at(
    candidates: &[Candidate],
    curseforge_api_key: Option<String>,
    bases: &IdentifyBases,
) -> HashMap<String, Identified> {
    if candidates.is_empty() {
        return HashMap::new();
    }
    let has_sha1 = candidates
        .iter()
        .any(|candidate| !candidate.sha1.is_empty());

    let mut found = HashMap::new();
    if has_sha1 {
        if let Ok(modrinth) = identify_modrinth(candidates, &bases.modrinth).await {
            found.extend(modrinth);
        }
    }
    if let Ok(curseforge) =
        identify_curseforge(candidates, curseforge_api_key, &bases.curseforge).await
    {
        // Eine Datei hat genau eine Quelle; wer zuerst erkannt wurde, bleibt.
        for (file, identified) in curseforge {
            found.entry(file).or_insert(identified);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_match_the_reference_implementation() {
        assert_eq!(curseforge_fingerprint(b""), 1_540_447_798);
        assert_eq!(curseforge_fingerprint(b"Hello, world!\n"), 2_173_663_876);
        assert_eq!(
            curseforge_fingerprint(&[1, 2, 3, 4, 5, 6, 7, 8, 9]),
            2_363_213_074
        );
        let big: Vec<u8> = (0..50u32).map(|index| (index * 37 % 256) as u8).collect();
        assert_eq!(curseforge_fingerprint(&big), 2_647_461_609);
        // Whitespace wird vorher entfernt: "a b" und "ab" sind gleich.
        assert_eq!(
            curseforge_fingerprint(b"a b\tc\r\nd"),
            curseforge_fingerprint(b"abcd")
        );
    }

    #[test]
    fn maps_modrinth_answers_to_the_reported_shape() {
        let candidates = vec![Candidate {
            file_name: "sodium.jar".to_string(),
            sha1: "abc".to_string(),
            fingerprint: 0,
        }];
        let versions = HashMap::from([(
            "abc".to_string(),
            HashVersion {
                project_id: "AANobbMI".to_string(),
                version_number: "0.6.9".to_string(),
            },
        )]);
        let projects = HashMap::from([(
            "AANobbMI".to_string(),
            ProjectInfo {
                id: "AANobbMI".to_string(),
                slug: Some("sodium".to_string()),
                title: Some("Sodium".to_string()),
                icon_url: Some("https://cdn.modrinth.com/sodium.png".to_string()),
            },
        )]);

        let found = modrinth_identifications(&candidates, &versions, &projects);
        let identified = found.get("sodium.jar").unwrap();
        assert_eq!(identified.source, "modrinth");
        assert_eq!(identified.project_id, "AANobbMI");
        assert_eq!(identified.slug, "sodium");
        assert_eq!(identified.name, "Sodium");
        assert_eq!(identified.version_number, "0.6.9");
        assert!(identified.icon_url.ends_with("sodium.png"));

        // Unbekannter Hash bleibt unerkannt.
        let other = vec![Candidate {
            file_name: "eigen.jar".to_string(),
            sha1: "fff".to_string(),
            fingerprint: 0,
        }];
        assert!(modrinth_identifications(&other, &versions, &projects).is_empty());
    }

    #[test]
    fn projects_without_an_icon_still_parse() {
        // Modrinth liefert `icon_url: null`, sobald ein Projekt kein Icon hat.
        let projects: Vec<ProjectInfo> = serde_json::from_str(
            r#"[{"id":"g96Z4WVZ","slug":"badoptimizations","title":"BadOptimizations","icon_url":null}]"#,
        )
        .expect("null-Icon darf die Antwort nicht verwerfen");
        assert_eq!(projects[0].id, "g96Z4WVZ");
        assert_eq!(projects[0].title.as_deref(), Some("BadOptimizations"));
        assert!(projects[0].icon_url.is_none());
    }
}
