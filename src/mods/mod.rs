//! Mod-Verwaltung für Modrinth und CurseForge.
//!
//! Die beiden Quellen unterscheiden sich in mehr als der URL: Modrinth vergibt
//! String-IDs und liefert Download-Links direkt mit, CurseForge nutzt numerische
//! IDs, verlangt einen API-Key und darf Downloads ohne Zustimmung des Autors
//! verweigern. Beide werden hier auf dieselben Typen abgebildet, damit Auflösung,
//! Installation und Bestandsdatei nur einen Weg kennen.

use crate::download::DownloadError;
use crate::error::LauncherError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub mod cache;
pub mod curseforge;
mod http;
pub mod identify;
pub mod install;
pub mod modrinth;
pub mod resolve;
pub mod updates;

pub use curseforge::CurseForgeClient;
pub use install::{
    install_plan, InstalledFile, ModInstallReport, ModLedger, ModRecord, PackFileRecord, PackRecord,
};
pub use modrinth::ModrinthClient;
pub use resolve::{
    plan_install, ModPlan, PlanNote, PlannedMod, ResolveOptions, UnresolvedDependency,
};

/// Windows verbietet diese Namen unabhängig von der Endung.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const MAX_FILE_NAME: usize = 160;

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum ModError {
    #[error("{provider}: {message}")]
    Provider {
        provider: &'static str,
        message: String,
    },

    #[error("Netzwerkfehler ({provider}): {message}")]
    Network {
        provider: &'static str,
        message: String,
    },

    #[error("{provider} antwortet mit HTTP {status}: {message}")]
    Http {
        provider: &'static str,
        status: u16,
        message: String,
    },

    #[error("{provider} drosselt gerade Anfragen (HTTP 429). Versuche es gleich noch einmal.")]
    RateLimited { provider: &'static str },

    #[error(
        "{provider} verweigert den Zugriff (HTTP {status}). Bei CurseForge stimmt meist der API-Key nicht."
    )]
    Unauthorized { provider: &'static str, status: u16 },

    #[error("Nicht gefunden bei {provider}: {what}")]
    NotFound {
        provider: &'static str,
        what: String,
    },

    #[error(
        "CurseForge braucht einen API-Key. Setze BAMBOO_CURSEFORGE_API_KEY oder curseforge_api_key in den Einstellungen. Ein Key lässt sich unter https://console.curseforge.com erstellen."
    )]
    MissingApiKey,

    #[error("Keine passende Version von '{project}' für {target} gefunden.")]
    NoMatchingVersion { project: String, target: String },

    #[error("Version '{version}' gehört nicht zum Projekt '{project}'.")]
    ProjectMismatch { project: String, version: String },

    #[error("Ungültiger Dateiname aus der Mod-Antwort: {0}")]
    UnsafeFileName(String),

    #[error("Mod-Datei muss eine .jar sein: {0}")]
    NotAJar(String),

    #[error("{0}")]
    NoDownload(String),

    #[error(
        "CurseForge erlaubt für '{0}' keinen Download durch Dritte – lade die Datei im Browser."
    )]
    DistributionBlocked(String),

    #[error("Diese Datei ist bei CurseForge nicht mehr verfügbar: {0}")]
    FileUnavailable(String),

    #[error(
        "Die Datei '{file}' wird von mehreren Mods beansprucht ({projects}). Bitte eines davon entfernen."
    )]
    FileNameConflict { file: String, projects: String },

    #[error("Pflichtabhängigkeiten fehlen:\n{0}")]
    UnresolvedDependencies(String),

    #[error("Abhängigkeitskette ist tiefer als {0} Ebenen – vermutlich ein Zyklus.")]
    DependencyTooDeep(usize),

    #[error("Mehr als {0} Abhängigkeiten – Abbruch, bevor der Mod-Ordner unübersichtlich wird.")]
    TooManyDependencies(usize),

    #[error(
        "{path} ist beschädigt: {reason}\nLösche die Datei, damit der Bestand neu aufgebaut wird."
    )]
    InvalidLedger { path: PathBuf, reason: String },

    #[error("Ungültiges Ziel: {0}")]
    InvalidTarget(String),

    #[error(transparent)]
    Download(#[from] DownloadError),

    #[error(transparent)]
    Launcher(#[from] LauncherError),

    #[error("JSON-Fehler: {0}")]
    Json(#[from] serde_json::Error),

    #[error("I/O-Fehler: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ModError>;

// ---------------------------------------------------------------------------
// Quelle, Loader, Ziel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    Modrinth,
    CurseForge,
}

impl ModSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "modrinth" => Some(Self::Modrinth),
            "curseforge" | "curse-forge" => Some(Self::CurseForge),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Modrinth => "Modrinth",
            Self::CurseForge => "CurseForge",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::Modrinth => "modrinth",
            Self::CurseForge => "curseforge",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Loader {
    Fabric,
    Forge,
    NeoForge,
    Quilt,
}

impl Loader {
    pub const ALL: [Loader; 4] = [
        Loader::Fabric,
        Loader::Forge,
        Loader::NeoForge,
        Loader::Quilt,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "fabric" => Some(Self::Fabric),
            "forge" => Some(Self::Forge),
            "neoforge" | "neo-forge" => Some(Self::NeoForge),
            "quilt" => Some(Self::Quilt),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Fabric => "Fabric",
            Self::Forge => "Forge",
            Self::NeoForge => "NeoForge",
            Self::Quilt => "Quilt",
        }
    }

    /// Name, den Modrinth in `loaders` und als Such-Facette verwendet.
    pub fn modrinth_name(self) -> &'static str {
        match self {
            Self::Fabric => "fabric",
            Self::Forge => "forge",
            Self::NeoForge => "neoforge",
            Self::Quilt => "quilt",
        }
    }

    /// `modLoaderType` der CurseForge-API.
    pub fn curseforge_id(self) -> u8 {
        match self {
            Self::Forge => 1,
            Self::Fabric => 4,
            Self::Quilt => 5,
            Self::NeoForge => 6,
        }
    }

    /// Erkennt den Loader an den Maven-Namen der Version-JSON.
    ///
    /// Die Reihenfolge ist eine Priorität, kein Zufall: NeoForge-Installationen
    /// listen teilweise zusätzlich `net.minecraftforge`-Bibliotheken.
    pub fn detect<'a>(libraries: impl IntoIterator<Item = &'a str>) -> Option<Self> {
        let (mut fabric, mut forge, mut neoforge, mut quilt) = (false, false, false, false);
        for name in libraries {
            let name = name.to_ascii_lowercase();
            if name.starts_with("net.fabricmc:fabric-loader") {
                fabric = true;
            } else if name.starts_with("org.quiltmc:quilt-loader") {
                quilt = true;
            } else if name.starts_with("net.neoforged:") || name.starts_with("net.neoforged.") {
                neoforge = true;
            } else if name.starts_with("net.minecraftforge:") {
                forge = true;
            }
        }
        if fabric {
            Some(Self::Fabric)
        } else if quilt {
            Some(Self::Quilt)
        } else if neoforge {
            Some(Self::NeoForge)
        } else if forge {
            Some(Self::Forge)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModTarget {
    pub game_version: String,
    pub loader: Option<Loader>,
}

impl ModTarget {
    pub fn new(game_version: impl Into<String>, loader: Option<Loader>) -> Self {
        Self {
            game_version: game_version.into(),
            loader,
        }
    }

    pub fn validate(&self) -> Result<()> {
        let value = self.game_version.trim();
        if value.is_empty() {
            return Err(ModError::InvalidTarget(
                "Die Minecraft-Version fehlt.".to_string(),
            ));
        }
        if value.len() > 32
            || !value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
        {
            return Err(ModError::InvalidTarget(format!(
                "'{value}' sieht nicht wie eine Minecraft-Version aus."
            )));
        }
        Ok(())
    }

    pub fn describe(&self) -> String {
        match self.loader {
            Some(loader) => format!("{} / {}", self.game_version, loader.label()),
            None => self.game_version.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Projekte und Versionen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    pub source: ModSource,
    pub id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub downloads: u64,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    pub text: String,
    pub target: Option<ModTarget>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchPage {
    pub hits: Vec<ProjectSummary>,
    pub total: u64,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModFile {
    pub file_name: String,
    /// Fehlt bei CurseForge, wenn der Autor keinen Fremd-Download erlaubt.
    pub url: Option<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    /// Provider-spezifische Datei-ID (CurseForge braucht sie für den CDN-Pfad).
    pub file_id: Option<String>,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyKind {
    Required,
    Optional,
    Incompatible,
    Embedded,
    Tool,
    Include,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub kind: DependencyKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseChannel {
    Release,
    Beta,
    Alpha,
}

impl ReleaseChannel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Release => "Release",
            Self::Beta => "Beta",
            Self::Alpha => "Alpha",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub source: ModSource,
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    pub channel: ReleaseChannel,
    pub published_at: Option<String>,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub file: ModFile,
    pub dependencies: Vec<Dependency>,
}

impl Version {
    /// Passt die Version zu Minecraft-Version und Loader?
    ///
    /// Leere Listen gelten als "unbekannt" und blockieren nicht – sonst würden
    /// ältere CurseForge-Einträge ohne Loader-Angabe nie gefunden.
    pub fn matches(&self, target: &ModTarget) -> bool {
        let version_ok = self.game_versions.is_empty()
            || self
                .game_versions
                .iter()
                .any(|value| value.eq_ignore_ascii_case(&target.game_version));

        let loader_ok = match target.loader {
            None => true,
            Some(loader) => {
                self.loaders.is_empty()
                    || self.loaders.iter().any(|value| {
                        Loader::parse(value) == Some(loader)
                            || value.eq_ignore_ascii_case(loader.modrinth_name())
                    })
            }
        };

        version_ok && loader_ok
    }

    pub fn label(&self) -> &str {
        if self.name.trim().is_empty() {
            if self.version_number.trim().is_empty() {
                &self.project_id
            } else {
                &self.version_number
            }
        } else {
            &self.name
        }
    }
}

/// Erkennt den Loader einer installierten Version an ihren Bibliotheken.
pub fn detect_instance_loader(game_root: &Path, version_id: &str) -> Option<Loader> {
    let resolved = crate::version::resolve_version(game_root, version_id).ok()?;
    Loader::detect(
        resolved
            .libraries
            .iter()
            .map(|library| library.name.as_str()),
    )
}

/// Wählt die neueste zum Ziel passende Version (Datum, nicht Listenreihenfolge).
pub fn pick_version<'a>(versions: &'a [Version], target: &ModTarget) -> Option<&'a Version> {
    versions
        .iter()
        .filter(|version| version.matches(target))
        .max_by(|left, right| left.published_at.cmp(&right.published_at))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadFile {
    pub url: String,
    pub file_name: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/// Eine Mod-Quelle. Fehler tragen immer den Provider-Namen, damit die UI
/// "Modrinth" von "CurseForge" unterscheiden kann.
///
/// `async fn` im Trait ist hier die kürzeste Form: Implementiert wird nur
/// innerhalb dieses Crates, und kein Future wird über Threads hinweg gehalten –
/// der `Send`-Bound, den der Lint vermisst, wird also nicht gebraucht.
#[allow(async_fn_in_trait)]
pub trait ModProvider {
    fn source(&self) -> ModSource;

    async fn search(&self, query: &SearchQuery) -> Result<SearchPage>;

    async fn project(&self, id_or_slug: &str) -> Result<ProjectSummary>;

    /// Alle Versionen, bereits auf das Ziel eingegrenzt (sofern die API das kann).
    async fn versions(&self, project: &str, target: &ModTarget) -> Result<Vec<Version>>;

    async fn version(&self, project: &str, version_id: &str) -> Result<Version>;

    /// Löst den tatsächlichen Download-Link auf – bei CurseForge inklusive
    /// API-Endpunkt und CDN-Rückfallweg.
    async fn download(&self, version: &Version) -> Result<DownloadFile>;
}

/// Laufzeit-Auswahl zwischen den beiden Quellen.
pub enum AnyProvider {
    Modrinth(ModrinthClient),
    CurseForge(CurseForgeClient),
}

impl AnyProvider {
    pub fn modrinth() -> Result<Self> {
        Ok(Self::Modrinth(ModrinthClient::new()?))
    }

    pub fn curseforge(api_key: Option<String>) -> Result<Self> {
        Ok(Self::CurseForge(CurseForgeClient::new(api_key)?))
    }

    pub fn from_source(source: ModSource, api_key: Option<String>) -> Result<Self> {
        match source {
            ModSource::Modrinth => Self::modrinth(),
            ModSource::CurseForge => Self::curseforge(api_key),
        }
    }
}

impl ModProvider for AnyProvider {
    fn source(&self) -> ModSource {
        match self {
            Self::Modrinth(client) => client.source(),
            Self::CurseForge(client) => client.source(),
        }
    }

    async fn search(&self, query: &SearchQuery) -> Result<SearchPage> {
        match self {
            Self::Modrinth(client) => client.search(query).await,
            Self::CurseForge(client) => client.search(query).await,
        }
    }

    async fn project(&self, id_or_slug: &str) -> Result<ProjectSummary> {
        match self {
            Self::Modrinth(client) => client.project(id_or_slug).await,
            Self::CurseForge(client) => client.project(id_or_slug).await,
        }
    }

    async fn versions(&self, project: &str, target: &ModTarget) -> Result<Vec<Version>> {
        match self {
            Self::Modrinth(client) => client.versions(project, target).await,
            Self::CurseForge(client) => client.versions(project, target).await,
        }
    }

    async fn version(&self, project: &str, version_id: &str) -> Result<Version> {
        match self {
            Self::Modrinth(client) => client.version(project, version_id).await,
            Self::CurseForge(client) => client.version(project, version_id).await,
        }
    }

    async fn download(&self, version: &Version) -> Result<DownloadFile> {
        match self {
            Self::Modrinth(client) => client.download(version).await,
            Self::CurseForge(client) => client.download(version).await,
        }
    }
}

// ---------------------------------------------------------------------------
// Dateinamen
// ---------------------------------------------------------------------------

/// Prüft einen Mod-Dateinamen, bevor er im `mods/`-Ordner landet.
///
/// Der Name kommt von einer fremden API; ohne Prüfung könnte ein Eintrag wie
/// `../../start.bat` aus dem Instanzordner ausbrechen.
pub fn validate_mod_file_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.len() > MAX_FILE_NAME {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    if name.trim() != name {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    if name == "." || name == ".." || Path::new(name).components().count() != 1 {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    if name.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    if name.starts_with('.') || name.ends_with('.') || name.ends_with(' ') {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(ModError::UnsafeFileName(name.to_string()));
    }
    if !name.to_ascii_lowercase().ends_with(".jar") {
        return Err(ModError::NotAJar(name.to_string()));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(id: &str, published: &str, loaders: &[&str], games: &[&str]) -> Version {
        Version {
            source: ModSource::Modrinth,
            id: id.to_string(),
            project_id: format!("project-{id}"),
            name: format!("Version {id}"),
            version_number: id.to_string(),
            channel: ReleaseChannel::Release,
            published_at: Some(published.to_string()),
            game_versions: games.iter().map(|value| value.to_string()).collect(),
            loaders: loaders.iter().map(|value| value.to_string()).collect(),
            file: ModFile {
                file_name: format!("{id}.jar"),
                url: Some(format!("https://example.invalid/{id}.jar")),
                sha1: None,
                size: None,
                file_id: None,
                primary: true,
            },
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn parses_sources_and_loaders() {
        assert_eq!(ModSource::parse("CurseForge"), Some(ModSource::CurseForge));
        assert_eq!(ModSource::parse("modrinth"), Some(ModSource::Modrinth));
        assert_eq!(ModSource::parse("bukkit"), None);
        for loader in Loader::ALL {
            assert_eq!(Loader::parse(loader.label()), Some(loader));
            assert_eq!(Loader::parse(loader.modrinth_name()), Some(loader));
        }
        assert_eq!(Loader::NeoForge.curseforge_id(), 6);
        assert_eq!(Loader::Fabric.curseforge_id(), 4);
    }

    #[test]
    fn detects_loader_with_neoforge_priority() {
        assert_eq!(
            Loader::detect(["net.fabricmc:fabric-loader:0.15.11"]),
            Some(Loader::Fabric)
        );
        assert_eq!(
            Loader::detect(["net.minecraftforge:forge:1.20.1-47.2.0"]),
            Some(Loader::Forge)
        );
        // NeoForge bringt alte Forge-Bibliotheken mit; NeoForge muss gewinnen.
        assert_eq!(
            Loader::detect([
                "net.minecraftforge:forge:1.20.1-47.2.0",
                "net.neoforged:neoforge:20.4.237"
            ]),
            Some(Loader::NeoForge)
        );
        assert_eq!(
            Loader::detect(["org.quiltmc:quilt-loader:0.23.1"]),
            Some(Loader::Quilt)
        );
        assert_eq!(Loader::detect(["com.example:other:1.0"]), None);
    }

    #[test]
    fn matches_game_version_and_loader() {
        let candidate = version("a", "2024-01-01T00:00:00Z", &["fabric"], &["1.20.1"]);
        assert!(candidate.matches(&ModTarget::new("1.20.1", Some(Loader::Fabric))));
        assert!(!candidate.matches(&ModTarget::new("1.20.2", Some(Loader::Fabric))));
        assert!(!candidate.matches(&ModTarget::new("1.20.1", Some(Loader::Forge))));
        assert!(candidate.matches(&ModTarget::new("1.20.1", None)));
    }

    #[test]
    fn unknown_lists_do_not_block_matching() {
        let candidate = version("a", "2024-01-01T00:00:00Z", &[], &[]);
        assert!(candidate.matches(&ModTarget::new("1.20.1", Some(Loader::Fabric))));
    }

    #[test]
    fn picks_newest_matching_version() {
        let versions = vec![
            version("old", "2023-01-01T00:00:00Z", &["fabric"], &["1.20.1"]),
            version("new", "2025-01-01T00:00:00Z", &["fabric"], &["1.20.1"]),
            version("wrong", "2026-01-01T00:00:00Z", &["forge"], &["1.20.1"]),
        ];
        let picked = pick_version(&versions, &ModTarget::new("1.20.1", Some(Loader::Fabric)));
        assert_eq!(picked.map(|version| version.id.as_str()), Some("new"));
    }

    #[test]
    fn rejects_unsafe_mod_file_names() {
        assert!(validate_mod_file_name("sodium-0.5.11.jar").is_ok());
        assert!(validate_mod_file_name("../../evil.jar").is_err());
        assert!(validate_mod_file_name("..\\evil.jar").is_err());
        assert!(validate_mod_file_name("C:evil.jar").is_err());
        assert!(validate_mod_file_name("con.jar").is_err());
        assert!(validate_mod_file_name(".hidden.jar").is_err());
        assert!(validate_mod_file_name("mod.txt").is_err());
        assert!(validate_mod_file_name("").is_err());
    }

    #[test]
    fn rejects_implausible_targets() {
        assert!(ModTarget::new("1.20.1", Some(Loader::Fabric))
            .validate()
            .is_ok());
        assert!(ModTarget::new("", None).validate().is_err());
        assert!(ModTarget::new("1.20.1 OR 1=1", None).validate().is_err());
    }
}
