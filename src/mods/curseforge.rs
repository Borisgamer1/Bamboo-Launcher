//! CurseForge-Client (API v1).
//!
//! Zwei Eigenheiten prägen den Code: Jede Anfrage braucht einen API-Key, und
//! Downloads dürfen ohne Zustimmung des Autors verweigert werden. Der Client
//! geht deshalb drei Wege – Metadaten-Link, `download-url`-Endpunkt, CDN – und
//! prüft vor dem CDN, ob der Autor Fremd-Downloads überhaupt erlaubt.

use super::http::ApiClient;
use super::*;
use serde::Deserialize;

pub const CURSEFORGE_API: &str = "https://api.curseforge.com/v1";
pub const CURSEFORGE_CDN: &str = "https://mediafilez.forgecdn.net/files";

const MINECRAFT_GAME_ID: u32 = 432;
const MODS_CLASS_ID: u32 = 6;
const PAGE_SIZE: usize = 50;

pub struct CurseForgeClient {
    api: ApiClient,
    cdn_base: String,
}

impl CurseForgeClient {
    pub fn new(api_key: Option<String>) -> Result<Self> {
        Self::with_base(api_key, CURSEFORGE_API)
    }

    /// Überschreibbar, damit Tests gegen einen lokalen Server laufen.
    pub fn with_base(api_key: Option<String>, base: impl Into<String>) -> Result<Self> {
        let key = api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or(ModError::MissingApiKey)?;
        Ok(Self {
            api: ApiClient::new(base, ModSource::CurseForge)?.with_header("x-api-key", key)?,
            cdn_base: CURSEFORGE_CDN.to_string(),
        })
    }

    pub fn with_cdn_base(mut self, base: impl Into<String>) -> Self {
        self.cdn_base = base.into().trim_end_matches('/').to_string();
        self
    }

    /// Rohantwort für Ansichten, die mehr Felder brauchen als
    /// [`ProjectSummary`](super::ProjectSummary) – die Launcher-Oberfläche
    /// rendert Autoren, Logo, Klasse und Datum direkt aus CurseForge.
    pub async fn get_json(
        &self,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<serde_json::Value> {
        self.api.get(path, params).await
    }

    /// Wie [`get_json`](Self::get_json), aber mit JSON-Body. Der
    /// Fingerprint-Abgleich schickt bis zu 2000 Hashes auf einmal.
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.api.post(path, body).await
    }

    async fn download_url(&self, mod_id: u64, file_id: u64) -> Result<Option<String>> {
        let path = format!("/mods/{mod_id}/files/{file_id}/download-url");
        let envelope: Option<OptionalData<String>> = self.api.get_optional(&path, &[]).await?;
        Ok(envelope
            .and_then(|envelope| envelope.data)
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty()))
    }

    async fn allows_distribution(&self, mod_id: u64) -> Result<Option<bool>> {
        let envelope: DataEnvelope<RawMod> = self.api.get(&format!("/mods/{mod_id}"), &[]).await?;
        Ok(envelope.data.allow_mod_distribution)
    }
}

impl ModProvider for CurseForgeClient {
    fn source(&self) -> ModSource {
        ModSource::CurseForge
    }

    async fn search(&self, query: &SearchQuery) -> Result<SearchPage> {
        let mut params = vec![
            ("gameId", MINECRAFT_GAME_ID.to_string()),
            ("classId", MODS_CLASS_ID.to_string()),
            ("searchFilter", query.text.clone()),
            ("index", query.offset.to_string()),
            ("pageSize", query.limit.clamp(1, PAGE_SIZE).to_string()),
        ];
        if let Some(target) = &query.target {
            target.validate()?;
            params.push(("gameVersion", target.game_version.clone()));
            if let Some(loader) = target.loader {
                params.push(("modLoaderType", loader.curseforge_id().to_string()));
            }
        }

        let response: SearchResponse = self.api.get("/mods/search", &params).await?;
        let hits: Vec<ProjectSummary> = response
            .data
            .into_iter()
            .filter(|project| project.id > 0)
            .map(|project| ProjectSummary {
                source: ModSource::CurseForge,
                id: project.id.to_string(),
                slug: project.slug,
                title: project.name,
                description: project.summary,
                downloads: project.download_count,
                author: project.authors.into_iter().next().map(|author| author.name),
            })
            .collect();
        let total = if response.pagination.total_count > 0 {
            response.pagination.total_count
        } else {
            hits.len() as u64
        };

        Ok(SearchPage {
            hits,
            total,
            offset: query.offset,
        })
    }

    async fn project(&self, id_or_slug: &str) -> Result<ProjectSummary> {
        let id = numeric_id(id_or_slug)?;
        let envelope: DataEnvelope<RawMod> = self.api.get(&format!("/mods/{id}"), &[]).await?;
        let project = envelope.data;
        Ok(ProjectSummary {
            source: ModSource::CurseForge,
            id: project.id.to_string(),
            slug: project.slug,
            title: project.name,
            description: project.summary,
            downloads: project.download_count,
            author: project.authors.into_iter().next().map(|author| author.name),
        })
    }

    async fn versions(&self, project: &str, target: &ModTarget) -> Result<Vec<Version>> {
        let id = numeric_id(project)?;
        target.validate()?;

        let mut params = vec![
            ("index", "0".to_string()),
            ("pageSize", PAGE_SIZE.to_string()),
            ("gameVersion", target.game_version.clone()),
        ];
        if let Some(loader) = target.loader {
            params.push(("modLoaderType", loader.curseforge_id().to_string()));
        }

        let response: FilesResponse = self.api.get(&format!("/mods/{id}/files"), &params).await?;
        let mut versions: Vec<Version> = response
            .data
            .into_iter()
            .filter_map(|file| normalize_file(file, id))
            .collect();
        versions.sort_by(|left, right| right.published_at.cmp(&left.published_at));
        Ok(versions)
    }

    async fn version(&self, project: &str, version_id: &str) -> Result<Version> {
        let id = numeric_id(project)?;
        let file_id = numeric_id(version_id)?;
        let envelope: DataEnvelope<RawFile> = self
            .api
            .get(&format!("/mods/{id}/files/{file_id}"), &[])
            .await?;
        if envelope.data.mod_id != id {
            return Err(ModError::ProjectMismatch {
                project: id.to_string(),
                version: file_id.to_string(),
            });
        }
        normalize_file(envelope.data, id).ok_or_else(|| {
            ModError::NoDownload(format!(
                "CurseForge-Datei {file_id} von Mod {id} enthält keine herunterladbare Datei."
            ))
        })
    }

    async fn download(&self, version: &Version) -> Result<DownloadFile> {
        let file = &version.file;
        if let Some(url) = &file.url {
            return Ok(DownloadFile {
                url: url.clone(),
                file_name: file.file_name.clone(),
                sha1: file.sha1.clone(),
                size: file.size,
            });
        }

        let project = numeric_id(&version.project_id)?;
        let file_id = file
            .file_id
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                ModError::NoDownload(format!(
                    "CurseForge-Datei von '{}' hat weder Link noch Datei-ID.",
                    version.label()
                ))
            })?;

        if let Some(url) = self.download_url(project, file_id).await? {
            return Ok(DownloadFile {
                url,
                file_name: file.file_name.clone(),
                sha1: file.sha1.clone(),
                size: file.size,
            });
        }
        if self.allows_distribution(project).await? == Some(false) {
            return Err(ModError::DistributionBlocked(version.label().to_string()));
        }

        let url =
            curseforge_cdn_url(file_id, &file.file_name, &self.cdn_base).ok_or_else(|| {
                ModError::NoDownload(format!(
                    "Für '{}' lässt sich kein CDN-Pfad bilden.",
                    version.label()
                ))
            })?;
        Ok(DownloadFile {
            url,
            file_name: file.file_name.clone(),
            sha1: file.sha1.clone(),
            size: file.size,
        })
    }
}

/// Baut den CDN-Pfad aus Datei-ID und Name:
/// `https://mediafilez.forgecdn.net/files/238/222/name.jar`.
pub fn curseforge_cdn_url(file_id: u64, file_name: &str, base: &str) -> Option<String> {
    if file_id == 0 || file_name.is_empty() {
        return None;
    }
    let digits = format!("{file_id:04}");
    let (directory, last) = digits.split_at(digits.len() - 3);
    let mut url = reqwest::Url::parse(&format!(
        "{}/{directory}/{last}",
        base.trim_end_matches('/')
    ))
    .ok()?;
    url.path_segments_mut().ok()?.push(file_name);
    Some(url.to_string())
}

fn numeric_id(value: &str) -> Result<u64> {
    value.trim().parse::<u64>().map_err(|_| ModError::Provider {
        provider: "CurseForge",
        message: format!(
            "'{value}' ist keine numerische CurseForge-ID. Nutze die ID aus der Suche (--source curseforge)."
        ),
    })
}

// ---------------------------------------------------------------------------
// Rohdaten
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct OptionalData<T> {
    #[serde(default)]
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    data: Vec<RawMod>,
    #[serde(default)]
    pagination: Pagination,
}

#[derive(Debug, Deserialize)]
struct FilesResponse {
    #[serde(default)]
    data: Vec<RawFile>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    #[serde(default)]
    total_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMod {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    allow_mod_distribution: Option<bool>,
    #[serde(default)]
    authors: Vec<RawAuthor>,
}

#[derive(Debug, Deserialize)]
struct RawAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    mod_id: u64,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    release_type: u8,
    #[serde(default)]
    file_date: Option<String>,
    #[serde(default)]
    file_length: Option<u64>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    dependencies: Vec<RawDependency>,
    #[serde(default)]
    hashes: Vec<RawHash>,
    #[serde(default)]
    is_available: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDependency {
    #[serde(default)]
    mod_id: u64,
    #[serde(default)]
    relation_type: u8,
}

#[derive(Debug, Deserialize)]
struct RawHash {
    #[serde(default)]
    value: String,
    #[serde(default)]
    algo: u8,
}

// ---------------------------------------------------------------------------
// Abbildung
// ---------------------------------------------------------------------------

fn normalize_file(raw: RawFile, project: u64) -> Option<Version> {
    if raw.id == 0 || raw.file_name.is_empty() || raw.is_available == Some(false) {
        return None;
    }

    let (game_versions, loaders) = split_game_versions(&raw.game_versions);
    let mod_id = if raw.mod_id > 0 { raw.mod_id } else { project };
    let name = if raw.display_name.trim().is_empty() {
        raw.file_name.clone()
    } else {
        raw.display_name
    };

    Some(Version {
        source: ModSource::CurseForge,
        id: raw.id.to_string(),
        project_id: mod_id.to_string(),
        version_number: name.clone(),
        name,
        channel: match raw.release_type {
            2 => ReleaseChannel::Beta,
            3 => ReleaseChannel::Alpha,
            _ => ReleaseChannel::Release,
        },
        published_at: raw.file_date,
        game_versions,
        loaders,
        file: ModFile {
            file_name: raw.file_name,
            url: raw
                .download_url
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty()),
            sha1: raw
                .hashes
                .iter()
                .find(|hash| hash.algo == 1)
                .map(|hash| hash.value.to_ascii_lowercase())
                .filter(|hash| !hash.is_empty()),
            size: raw.file_length.filter(|size| *size > 0),
            file_id: Some(raw.id.to_string()),
            primary: true,
        },
        dependencies: raw
            .dependencies
            .into_iter()
            .filter(|dependency| dependency.mod_id > 0)
            .map(|dependency| Dependency {
                project_id: Some(dependency.mod_id.to_string()),
                version_id: None,
                kind: match dependency.relation_type {
                    3 => DependencyKind::Required,
                    1 => DependencyKind::Embedded,
                    4 => DependencyKind::Tool,
                    5 => DependencyKind::Incompatible,
                    6 => DependencyKind::Include,
                    _ => DependencyKind::Optional,
                },
            })
            .collect(),
    })
}

/// CurseForge mischt Minecraft-Versionen und Loader in `gameVersions`.
fn split_game_versions(values: &[String]) -> (Vec<String>, Vec<String>) {
    let mut versions = Vec::new();
    let mut loaders = Vec::new();
    for value in values {
        let lower = value.trim().to_ascii_lowercase();
        if let Some(loader) = Loader::parse(&lower) {
            loaders.push(loader.modrinth_name().to_string());
        } else if lower.starts_with("java ") || lower.is_empty() {
            continue;
        } else {
            versions.push(value.trim().to_string());
        }
    }
    (versions, loaders)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Option<Version> {
        normalize_file(serde_json::from_value(value).unwrap(), 123)
    }

    #[test]
    fn builds_cdn_path_from_file_id() {
        assert_eq!(
            curseforge_cdn_url(238222, "example-1.0.jar", "https://cdn.example/files").as_deref(),
            Some("https://cdn.example/files/238/222/example-1.0.jar")
        );
        assert_eq!(
            curseforge_cdn_url(42, "small.jar", "https://cdn.example/files").as_deref(),
            Some("https://cdn.example/files/0/042/small.jar")
        );
        assert!(curseforge_cdn_url(0, "x.jar", "https://cdn.example/files").is_none());
        assert!(curseforge_cdn_url(1, "", "https://cdn.example/files").is_none());
    }

    #[test]
    fn encodes_file_names_in_the_cdn_url() {
        let url = curseforge_cdn_url(1000, "my mod.jar", "https://cdn.example/files").unwrap();
        assert!(url.ends_with("/1/000/my%20mod.jar"), "{url}");
    }

    #[test]
    fn splits_minecraft_versions_from_loaders() {
        let (versions, loaders) = split_game_versions(&[
            "1.20.1".to_string(),
            "Fabric".to_string(),
            "Java 17".to_string(),
            "1.20".to_string(),
        ]);
        assert_eq!(versions, vec!["1.20.1", "1.20"]);
        assert_eq!(loaders, vec!["fabric"]);
    }

    #[test]
    fn maps_required_dependency_and_sha1() {
        let version = parse(json!({
            "id": 555, "modId": 123, "displayName": "Example 1.2",
            "fileName": "example-1.2.jar", "releaseType": 2,
            "fileDate": "2024-05-01T10:00:00Z", "fileLength": 4096,
            "downloadUrl": null,
            "gameVersions": ["1.20.1", "Fabric"],
            "dependencies": [{"modId": 999, "relationType": 3}, {"modId": 7, "relationType": 2}],
            "hashes": [{"value": "ABCDEF", "algo": 1}, {"value": "ffff", "algo": 2}]
        }))
        .unwrap();

        assert_eq!(version.channel, ReleaseChannel::Beta);
        assert_eq!(version.file.sha1.as_deref(), Some("abcdef"));
        assert_eq!(version.file.file_id.as_deref(), Some("555"));
        assert_eq!(version.dependencies[0].kind, DependencyKind::Required);
        assert_eq!(version.dependencies[0].project_id.as_deref(), Some("999"));
        assert_eq!(version.dependencies[1].kind, DependencyKind::Optional);
        assert!(version.matches(&ModTarget::new("1.20.1", Some(Loader::Fabric))));
    }

    #[test]
    fn ignores_unavailable_files() {
        assert!(
            parse(json!({"id": 1, "fileId": 1, "fileName": "a.jar", "isAvailable": false}))
                .is_none()
        );
        assert!(parse(json!({"id": 1, "fileName": ""})).is_none());
    }
}
