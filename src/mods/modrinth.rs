//! Modrinth-Client (API v2). Braucht keinen Key.

use super::http::ApiClient;
use super::*;
use serde::Deserialize;
use std::collections::HashMap;

pub const MODRINTH_API: &str = "https://api.modrinth.com/v2";

pub struct ModrinthClient {
    api: ApiClient,
}

impl ModrinthClient {
    pub fn new() -> Result<Self> {
        Self::with_base(MODRINTH_API)
    }

    /// Überschreibbar, damit Tests gegen einen lokalen Server laufen.
    pub fn with_base(base: impl Into<String>) -> Result<Self> {
        Ok(Self {
            api: ApiClient::new(base, ModSource::Modrinth)?,
        })
    }
}

impl ModProvider for ModrinthClient {
    fn source(&self) -> ModSource {
        ModSource::Modrinth
    }

    async fn search(&self, query: &SearchQuery) -> Result<SearchPage> {
        let mut facets = vec![vec!["project_type:mod".to_string()]];
        if let Some(target) = &query.target {
            target.validate()?;
            if let Some(loader) = target.loader {
                facets.push(vec![format!("categories:{}", loader.modrinth_name())]);
            }
            facets.push(vec![format!("versions:{}", target.game_version)]);
        }
        let limit = query.limit.clamp(1, 100);

        let params = vec![
            ("query", query.text.clone()),
            ("limit", limit.to_string()),
            ("offset", query.offset.to_string()),
            ("facets", serde_json::to_string(&facets)?),
        ];
        let response: SearchResponse = self.api.get("/search", &params).await?;

        Ok(SearchPage {
            hits: response
                .hits
                .into_iter()
                .filter(|hit| !hit.project_id.is_empty())
                .map(|hit| ProjectSummary {
                    source: ModSource::Modrinth,
                    id: hit.project_id,
                    slug: hit.slug,
                    title: hit.title,
                    description: hit.description,
                    downloads: hit.downloads,
                    author: hit.author,
                })
                .collect(),
            total: response.total_hits,
            offset: response.offset,
        })
    }

    async fn project(&self, id_or_slug: &str) -> Result<ProjectSummary> {
        let id = validate_project_ref(id_or_slug)?;
        let raw: RawProject = self.api.get(&format!("/project/{id}"), &[]).await?;
        if raw.id.is_empty() {
            return Err(ModError::Provider {
                provider: "Modrinth",
                message: format!("Projekt {id} hat keine ID."),
            });
        }
        Ok(ProjectSummary {
            source: ModSource::Modrinth,
            id: raw.id,
            slug: raw.slug,
            title: raw.title,
            description: raw.description,
            downloads: raw.downloads,
            author: None,
        })
    }

    async fn versions(&self, project: &str, target: &ModTarget) -> Result<Vec<Version>> {
        let id = validate_project_ref(project)?;
        target.validate()?;

        let mut params = Vec::new();
        if !target.game_version.is_empty() {
            params.push((
                "game_versions",
                serde_json::to_string(&[target.game_version.as_str()])?,
            ));
        }
        if let Some(loader) = target.loader {
            params.push(("loaders", serde_json::to_string(&[loader.modrinth_name()])?));
        }

        let raw: Vec<RawVersion> = self
            .api
            .get(&format!("/project/{id}/version"), &params)
            .await?;

        let mut versions: Vec<Version> = raw.into_iter().filter_map(normalize_version).collect();
        versions.sort_by(|left, right| right.published_at.cmp(&left.published_at));
        Ok(versions)
    }

    async fn version(&self, project: &str, version_id: &str) -> Result<Version> {
        // `project` darf ein Slug sein; die Version kennt ihre Projekt-ID selbst.
        validate_project_ref(project)?;
        let version_id = validate_project_ref(version_id)?;
        let raw: RawVersion = self.api.get(&format!("/version/{version_id}"), &[]).await?;
        normalize_version(raw).ok_or_else(|| {
            ModError::NoDownload(format!(
                "Modrinth-Version {version_id} enthält keine herunterladbare Datei."
            ))
        })
    }

    async fn download(&self, version: &Version) -> Result<DownloadFile> {
        let url = version.file.url.clone().ok_or_else(|| {
            ModError::NoDownload(format!(
                "Modrinth-Version {} hat keinen Download-Link.",
                version.label()
            ))
        })?;
        Ok(DownloadFile {
            url,
            file_name: version.file.file_name.clone(),
            sha1: version.file.sha1.clone(),
            size: version.file.size,
        })
    }
}

/// Projekt-IDs und Slugs landen in einem URL-Pfad. Alles, was den Pfad
/// verändern könnte, wird abgelehnt statt kodiert – die APIs vergeben nur
/// harmlose Zeichen.
pub(crate) fn validate_project_ref(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(ModError::Provider {
            provider: "Modrinth",
            message: format!("'{value}' ist keine gültige Projekt- oder Versions-ID."),
        });
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Rohdaten
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    hits: Vec<SearchHit>,
    #[serde(default)]
    total_hits: u64,
    #[serde(default)]
    offset: usize,
}

#[derive(Debug, Deserialize)]
struct SearchHit {
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProject {
    #[serde(default)]
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    downloads: u64,
}

#[derive(Debug, Deserialize)]
struct RawVersion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    version_type: String,
    #[serde(default)]
    date_published: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default)]
    dependencies: Vec<RawDependency>,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    hashes: HashMap<String, String>,
    #[serde(default)]
    primary: bool,
}

#[derive(Debug, Deserialize)]
struct RawDependency {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    dependency_type: String,
}

// ---------------------------------------------------------------------------
// Abbildung
// ---------------------------------------------------------------------------

fn normalize_version(raw: RawVersion) -> Option<Version> {
    if raw.id.is_empty() || raw.project_id.is_empty() {
        return None;
    }

    let mut files = raw.files;
    let position = files
        .iter()
        .position(|file| file.primary && file.url.is_some())
        .or_else(|| files.iter().position(|file| file.url.is_some()))?;
    let file = files.swap_remove(position);
    if file.filename.is_empty() {
        return None;
    }

    Some(Version {
        source: ModSource::Modrinth,
        id: raw.id,
        project_id: raw.project_id,
        name: raw.name,
        version_number: raw.version_number,
        channel: match raw.version_type.as_str() {
            "beta" => ReleaseChannel::Beta,
            "alpha" => ReleaseChannel::Alpha,
            _ => ReleaseChannel::Release,
        },
        published_at: raw.date_published,
        game_versions: raw.game_versions,
        loaders: raw
            .loaders
            .into_iter()
            .map(|loader| loader.to_ascii_lowercase())
            .collect(),
        file: ModFile {
            file_name: file.filename,
            url: file.url,
            sha1: file
                .hashes
                .get("sha1")
                .map(|hash| hash.to_ascii_lowercase()),
            size: file.size,
            file_id: None,
            primary: true,
        },
        dependencies: raw
            .dependencies
            .into_iter()
            .filter(|dependency| dependency.project_id.is_some() || dependency.version_id.is_some())
            .map(|dependency| Dependency {
                project_id: dependency.project_id,
                version_id: dependency.version_id,
                kind: match dependency.dependency_type.as_str() {
                    "required" => DependencyKind::Required,
                    "incompatible" => DependencyKind::Incompatible,
                    "embedded" => DependencyKind::Embedded,
                    _ => DependencyKind::Optional,
                },
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Option<Version> {
        normalize_version(serde_json::from_value(value).unwrap())
    }

    #[test]
    fn rejects_project_refs_that_could_change_the_path() {
        assert!(validate_project_ref("sodium").is_ok());
        assert!(validate_project_ref("AANobbMI").is_ok());
        assert!(validate_project_ref("../admin").is_err());
        assert!(validate_project_ref("a/b").is_err());
        assert!(validate_project_ref("").is_err());
    }

    #[test]
    fn normalizes_a_version_with_pinned_dependency() {
        let version = parse(json!({
            "id": "s5eFLITc",
            "project_id": "YL57xq9U",
            "name": "Iris 1.7.6",
            "version_number": "1.7.6+1.20.1",
            "version_type": "release",
            "date_published": "2025-03-03T00:22:55.778804Z",
            "game_versions": ["1.20.1"],
            "loaders": ["Fabric", "Quilt"],
            "files": [
                {"url": "https://cdn.example/a.jar", "filename": "a.jar", "size": 10,
                 "hashes": {"sha1": "ABC123"}, "primary": true}
            ],
            "dependencies": [
                {"project_id": "AANobbMI", "version_id": "ryOMVRuG", "dependency_type": "required"}
            ]
        }))
        .unwrap();

        assert_eq!(version.loaders, vec!["fabric", "quilt"]);
        assert_eq!(version.file.sha1.as_deref(), Some("abc123"));
        assert_eq!(version.dependencies[0].kind, DependencyKind::Required);
        assert_eq!(
            version.dependencies[0].version_id.as_deref(),
            Some("ryOMVRuG")
        );
        assert!(version.matches(&ModTarget::new("1.20.1", Some(Loader::Fabric))));
    }

    #[test]
    fn prefers_primary_file_over_extra_files() {
        let version = parse(json!({
            "id": "v",
            "project_id": "p",
            "files": [
                {"url": "https://cdn.example/sources.zip", "filename": "sources.zip"},
                {"url": "https://cdn.example/mod.jar", "filename": "mod.jar", "primary": true}
            ]
        }))
        .unwrap();
        assert_eq!(version.file.file_name, "mod.jar");
    }

    #[test]
    fn drops_versions_without_a_file() {
        assert!(parse(json!({"id": "v", "project_id": "p", "files": []})).is_none());
        assert!(parse(json!({"project_id": "p", "files": []})).is_none());
    }
}
