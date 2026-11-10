//! Frische Installation: Versions-JSON, Client-Jar, Libraries, Assets und die
//! von Mojang verwaltete Java-Runtime.
//!
//! Der Installer ist idempotent: Vorhandene Dateien werden über Größe und
//! SHA-1 geprüft und übersprungen, beschädigte werden ersetzt. Alles läuft
//! über denselben [`Downloader`], damit Retry, Prüfsumme und atomares
//! Schreiben überall gleich funktionieren.

use crate::download::{DownloadError, DownloadProgress, DownloadReport, Downloader, FileSpec};
use crate::error::LauncherError;
use crate::java::JavaRuntime;
use crate::version::{self, PlatformInfo, ResolvedVersion, VersionJson};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

pub const VERSION_MANIFEST_URLS: [&str; 2] = [
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
];

pub const ASSET_OBJECT_BASE: &str = "https://resources.download.minecraft.net";

pub const JAVA_RUNTIME_MANIFEST_URL: &str = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/// Das Versions-Manifest ändert sich nur bei neuen Releases.
const VERSION_MANIFEST_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const JAVA_MANIFEST_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_INHERITANCE_DEPTH: usize = 8;

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("Version '{0}' ist weder installiert noch im Mojang-Manifest vorhanden.")]
    VersionNotInManifest(String),

    #[error(
        "Version '{0}' ist nicht installiert. Reparieren lässt sich nur eine vorhandene Installation."
    )]
    VersionNotInstalled(String),

    #[error("Version '{0}' hat keine Download-Angabe für den Client-Jar.")]
    MissingClientJar(String),

    #[error("Version '{0}' hat keinen Asset-Index mit Download-URL.")]
    MissingAssetIndex(String),

    #[error("Der Asset-Index '{index}' ist unlesbar: {reason}")]
    InvalidAssetIndex { index: String, reason: String },

    #[error("Für Java {major} gibt es auf {platform} kein Mojang-Runtime-Paket.")]
    JavaRuntimeNotFound { major: u32, platform: String },

    #[error("Das Runtime-Manifest von {0} enthält keine Dateien.")]
    InvalidRuntimeManifest(String),

    #[error("Die Java-Runtime '{component}' enthält keine ausführbare Datei unter {path}.")]
    JavaExecutableMissing { component: String, path: PathBuf },

    #[error("Unsicherer Pfad aus entfernten Daten: {0}")]
    UnsafePath(PathBuf),

    #[error("Ungültiger Name: {0}")]
    InvalidName(String),

    #[error("Zu tiefe inheritsFrom-Kette bei '{0}'.")]
    InheritanceTooDeep(String),

    #[error(transparent)]
    Download(#[from] DownloadError),

    #[error(transparent)]
    Version(#[from] LauncherError),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, InstallError>;

// ---------------------------------------------------------------------------
// Öffentliche Typen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOptions {
    /// Asset-Index und alle Asset-Objekte laden.
    pub assets: bool,
    /// Passende Mojang-Java-Runtime laden, falls keine installiert ist.
    pub java: bool,
    /// Manifest-Caches ignorieren und neu laden.
    pub refresh_manifest: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            assets: true,
            java: true,
            refresh_manifest: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStep {
    VersionJson,
    VersionFiles,
    Assets,
    JavaRuntime,
    Done,
}

impl InstallStep {
    pub fn label(self) -> &'static str {
        match self {
            InstallStep::VersionJson => "Versions-JSON",
            InstallStep::VersionFiles => "Libraries",
            InstallStep::Assets => "Assets",
            InstallStep::JavaRuntime => "Java-Runtime",
            InstallStep::Done => "Fertig",
        }
    }
}

#[derive(Debug, Clone)]
pub struct InstallEvent {
    pub step: InstallStep,
    pub progress: DownloadProgress,
}

type Listener = Arc<dyn Fn(InstallEvent) + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct AssetReport {
    pub index_id: String,
    pub objects: usize,
    pub virtual_dir: Option<PathBuf>,
    pub download: DownloadReport,
}

#[derive(Debug, Clone)]
pub struct JavaInstall {
    pub component: String,
    pub version: Option<String>,
    pub java_path: PathBuf,
    pub download: DownloadReport,
}

#[derive(Debug, Clone, Default)]
pub struct InstallReport {
    pub version_json_downloaded: bool,
    pub files: DownloadReport,
    pub assets: Option<AssetReport>,
    pub java: Option<JavaInstall>,
}

#[derive(Debug, Clone)]
pub struct RepairReport {
    pub version_id: String,
    pub install: InstallReport,
    /// Vorhandenes Java, das die Reparatur genutzt hat. Dann wurde keine
    /// Mojang-Runtime heruntergeladen.
    pub system_java: Option<JavaRuntime>,
}

impl InstallReport {
    pub fn downloaded_bytes(&self) -> u64 {
        self.files.bytes
            + self
                .assets
                .as_ref()
                .map_or(0, |assets| assets.download.bytes)
            + self.java.as_ref().map_or(0, |java| java.download.bytes)
    }

    pub fn downloaded_files(&self) -> usize {
        self.files.downloaded
            + self
                .assets
                .as_ref()
                .map_or(0, |assets| assets.download.downloaded)
            + self
                .java
                .as_ref()
                .map_or(0, |java| java.download.downloaded)
    }

    pub fn skipped_files(&self) -> usize {
        self.files.skipped
            + self
                .assets
                .as_ref()
                .map_or(0, |assets| assets.download.skipped)
            + self.java.as_ref().map_or(0, |java| java.download.skipped)
    }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

pub struct Installer {
    downloader: Downloader,
    cache_dir: PathBuf,
    manifest_urls: Vec<String>,
    asset_base: String,
    java_manifest_url: String,
    platform: PlatformInfo,
    java_path: Option<PathBuf>,
}

impl Installer {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            downloader: Downloader::new(),
            cache_dir: cache_dir.into(),
            manifest_urls: VERSION_MANIFEST_URLS
                .iter()
                .map(|url| url.to_string())
                .collect(),
            asset_base: ASSET_OBJECT_BASE.to_string(),
            java_manifest_url: JAVA_RUNTIME_MANIFEST_URL.to_string(),
            platform: PlatformInfo::current(),
            java_path: None,
        }
    }

    /// Überschreibt die Endpunkte – der Weg, den Tests gegen einen Mock nutzen.
    pub fn with_endpoints(
        mut self,
        manifest_urls: Vec<String>,
        asset_base: impl Into<String>,
        java_manifest_url: impl Into<String>,
    ) -> Self {
        self.manifest_urls = manifest_urls;
        self.asset_base = asset_base.into();
        self.java_manifest_url = java_manifest_url.into();
        self
    }

    pub fn with_platform(mut self, platform: PlatformInfo) -> Self {
        self.platform = platform;
        self
    }

    pub fn with_downloader(mut self, downloader: Downloader) -> Self {
        self.downloader = downloader;
        self
    }

    /// Bevorzugt dieses Java, wenn eine Reparatur prüft, ob eine Runtime
    /// überhaupt nötig ist.
    pub fn with_java_path(mut self, java_path: Option<PathBuf>) -> Self {
        self.java_path = java_path;
        self
    }

    pub fn platform(&self) -> &PlatformInfo {
        &self.platform
    }

    /// Setzt die Version vollständig auf. Mehrfaches Aufrufen ist billig:
    /// Vollständige Dateien werden geprüft und übersprungen.
    pub async fn install_version<F>(
        &self,
        game_root: &Path,
        version_id: &str,
        options: &InstallOptions,
        on_event: F,
    ) -> Result<InstallReport>
    where
        F: Fn(InstallEvent) + Send + Sync + 'static,
    {
        validate_component(version_id)?;
        let listener: Listener = Arc::new(on_event);

        emit(
            &listener,
            InstallStep::VersionJson,
            DownloadProgress::default(),
        );

        let version_json_downloaded = !version::version_json_path(game_root, version_id).is_file();
        if version_json_downloaded {
            self.ensure_version_chain(game_root, version_id, options.refresh_manifest, 0)
                .await?;
        }

        let resolved = version::resolve_version(game_root, version_id)?;

        let files = self.version_files(game_root, &resolved)?;
        let step_listener = Arc::clone(&listener);
        let files_report = self
            .downloader
            .download_all(files, move |progress| {
                step_listener.as_ref()(InstallEvent {
                    step: InstallStep::VersionFiles,
                    progress,
                });
            })
            .await?;

        let assets = if options.assets {
            Some(self.install_assets(game_root, &resolved, &listener).await?)
        } else {
            None
        };

        let java = if options.java {
            Some(self.install_java(game_root, &resolved, &listener).await?)
        } else {
            None
        };

        emit(&listener, InstallStep::Done, DownloadProgress::default());

        Ok(InstallReport {
            version_json_downloaded,
            files: files_report,
            assets,
            java,
        })
    }

    /// Repariert eine vorhandene Installation: Fehlende oder beschädigte
    /// Bibliotheken, Assets und – falls nötig – die Java-Runtime werden
    /// nachgeladen. Ein fehlendes Versions-JSON wird nicht stillschweigend
    /// installiert; dafür ist [`Self::install_version`] zuständig.
    pub async fn repair_version<F>(
        &self,
        game_root: &Path,
        version_id: &str,
        on_event: F,
    ) -> Result<RepairReport>
    where
        F: Fn(InstallEvent) + Send + Sync + 'static,
    {
        validate_component(version_id)?;
        if !version::version_json_path(game_root, version_id).is_file() {
            return Err(InstallError::VersionNotInstalled(version_id.to_string()));
        }

        // Die Kette kann einen fehlenden Eltern-JSON-Fall reparieren, ohne die
        // vorhandene Version selbst neu zu laden.
        let resolved = self.ensure_version_metadata(game_root, version_id).await?;
        let system_java =
            crate::java::find_java_in(game_root, self.java_path.as_deref(), resolved.java_major)
                .await
                .ok();
        let options = InstallOptions {
            assets: true,
            java: system_java.is_none(),
            refresh_manifest: false,
        };
        let install = self
            .install_version(game_root, version_id, &options, on_event)
            .await?;

        Ok(RepairReport {
            version_id: version_id.to_string(),
            install,
            system_java,
        })
    }

    /// Stellt das Versions-JSON samt `inheritsFrom`-Kette sicher und liefert
    /// die aufgelöste Version, ohne Client, Libraries oder Assets zu laden.
    ///
    /// Damit lässt sich vor der Installation entscheiden, ob eine bereits
    /// vorhandene Java-Installation genügt.
    pub async fn ensure_version_metadata(
        &self,
        game_root: &Path,
        version_id: &str,
    ) -> Result<ResolvedVersion> {
        validate_component(version_id)?;
        self.ensure_version_chain(game_root, version_id, false, 0)
            .await?;
        Ok(version::resolve_version(game_root, version_id)?)
    }

    // -- Versions-JSON ------------------------------------------------------

    async fn ensure_version_chain(
        &self,
        game_root: &Path,
        version_id: &str,
        refresh: bool,
        depth: usize,
    ) -> Result<()> {
        if depth > MAX_INHERITANCE_DEPTH {
            return Err(InstallError::InheritanceTooDeep(version_id.to_string()));
        }
        validate_component(version_id)?;

        let path = version::version_json_path(game_root, version_id);
        if !path.is_file() {
            let manifest = self.version_manifest(refresh).await?;
            let entry = manifest
                .iter()
                .find(|entry| entry.id == version_id)
                .ok_or_else(|| InstallError::VersionNotInManifest(version_id.to_string()))?;

            let mut spec = FileSpec::new(path.clone(), entry.url.clone());
            if let Some(sha1) = &entry.sha1 {
                spec = spec.with_sha1(sha1);
            }
            // Ein Fehler hier ist fatal: ohne Versions-JSON gibt es keinen Plan.
            self.downloader.download_all(vec![spec], |_| {}).await?;
        }

        // Ein Loader-JSON (Forge, Fabric) erbt vom Vanilla-JSON. Fehlt die
        // Basis, wird sie aus dem Mojang-Manifest nachgezogen.
        let parent = tokio::fs::read_to_string(&path)
            .await
            .ok()
            .and_then(|raw| serde_json::from_str::<VersionJson>(&raw).ok())
            .and_then(|json| json.inherits_from);

        if let Some(parent) = parent {
            if !version::version_json_path(game_root, &parent).is_file() {
                Box::pin(self.ensure_version_chain(game_root, &parent, refresh, depth + 1)).await?;
            }
        }
        Ok(())
    }

    async fn version_manifest(&self, refresh: bool) -> Result<Vec<ManifestVersion>> {
        let cache = self.cache_dir.join("version_manifest_v2.json");
        let bytes = self
            .cached_json(
                &self.manifest_urls,
                &cache,
                VERSION_MANIFEST_MAX_AGE,
                refresh,
            )
            .await?;
        let manifest: VersionManifest = serde_json::from_slice(&bytes)?;
        Ok(manifest.versions)
    }

    // -- Client, Libraries, Logging -----------------------------------------

    fn version_files(&self, game_root: &Path, resolved: &ResolvedVersion) -> Result<Vec<FileSpec>> {
        let mut files: BTreeMap<PathBuf, FileSpec> = BTreeMap::new();

        let client = resolved
            .client_download
            .as_ref()
            .ok_or_else(|| InstallError::MissingClientJar(resolved.id.clone()))?;
        let client_url = client
            .url
            .as_deref()
            .ok_or_else(|| InstallError::MissingClientJar(resolved.id.clone()))?;
        // Der Jar-Name stammt aus dem Versions-JSON und darf das
        // versions-Verzeichnis nicht verlassen.
        ensure_inside(&game_root.join("versions"), &resolved.client_jar)?;
        files.insert(
            resolved.client_jar.clone(),
            spec_from_download(
                &resolved.client_jar,
                client_url,
                client.sha1.as_deref(),
                client.size,
            ),
        );

        for library in resolved.libraries.iter().chain(resolved.natives.iter()) {
            if library.url.trim().is_empty() {
                continue;
            }
            ensure_inside(&game_root.join("libraries"), &library.path)?;
            let mut spec = FileSpec::new(library.path.clone(), library.url.clone());
            if let Some(sha1) = &library.sha1 {
                spec = spec.with_sha1(sha1);
            }
            if let Some(size) = library.size {
                spec = spec.with_size(size);
            }
            files.insert(library.path.clone(), spec);
        }

        // Ohne diese Datei zeigt -Dlog4j.configurationFile ins Leere.
        if let Some(log_file) = &resolved.log_file {
            if let Some(relative) = &log_file.path {
                let destination = safe_join(game_root, relative)?;
                if let Some(url) = log_file.url.as_deref() {
                    files.insert(
                        destination.clone(),
                        spec_from_download(
                            &destination,
                            url,
                            log_file.sha1.as_deref(),
                            log_file.size,
                        ),
                    );
                }
            }
        }

        Ok(files.into_values().collect())
    }

    // -- Assets -------------------------------------------------------------

    async fn install_assets(
        &self,
        game_root: &Path,
        resolved: &ResolvedVersion,
        listener: &Listener,
    ) -> Result<AssetReport> {
        let index_id = resolved.asset_index.clone();
        validate_component(&index_id)?;
        let info = resolved
            .asset_index_info
            .as_ref()
            .ok_or_else(|| InstallError::MissingAssetIndex(resolved.id.clone()))?;

        let index_url = info
            .url
            .as_deref()
            .ok_or_else(|| InstallError::MissingAssetIndex(resolved.id.clone()))?;
        let index_path = game_root
            .join("assets")
            .join("indexes")
            .join(format!("{index_id}.json"));
        let spec = spec_from_download(&index_path, index_url, info.sha1.as_deref(), info.size);
        let step_listener = Arc::clone(listener);
        self.downloader
            .download_all(vec![spec], move |progress| {
                step_listener.as_ref()(InstallEvent {
                    step: InstallStep::Assets,
                    progress,
                });
            })
            .await?;

        let raw = tokio::fs::read_to_string(&index_path).await?;
        let index: AssetIndexFile =
            serde_json::from_str(&raw).map_err(|error| InstallError::InvalidAssetIndex {
                index: index_id.clone(),
                reason: error.to_string(),
            })?;

        let mut entries: Vec<(String, String, u64)> = index
            .objects
            .into_iter()
            .filter(|(_, object)| is_sha1(&object.hash))
            .map(|(name, object)| (name, object.hash, object.size))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        let assets_root = game_root.join("assets");
        let mut files: BTreeMap<PathBuf, FileSpec> = BTreeMap::new();
        for (_, hash, size) in &entries {
            let relative = format!("objects/{}/{}", &hash[..2], hash);
            let destination = safe_join(&assets_root, &relative)?;
            let url = format!(
                "{}/{}/{}",
                self.asset_base.trim_end_matches('/'),
                &hash[..2],
                hash
            );
            files.insert(
                destination.clone(),
                FileSpec::new(destination, url)
                    .with_sha1(hash.clone())
                    .with_size(*size),
            );
        }

        let step_listener = Arc::clone(listener);
        let download = self
            .downloader
            .download_all(files.into_values().collect(), move |progress| {
                step_listener.as_ref()(InstallEvent {
                    step: InstallStep::Assets,
                    progress,
                });
            })
            .await?;

        // 1.7.x und älter suchen Assets unter assets/virtual/<index>.
        let legacy_field = resolved
            .assets_field
            .as_deref()
            .is_some_and(|field| field == "legacy" || field.starts_with("pre-"));
        let virtual_dir = if index.virtual_ || index.map_to_resources || legacy_field {
            let directory = assets_root.join("virtual").join(&index_id);
            create_virtual_assets(&assets_root, &directory, &entries).await?;
            Some(directory)
        } else {
            None
        };

        Ok(AssetReport {
            index_id,
            objects: entries.len(),
            virtual_dir,
            download,
        })
    }

    // -- Java-Runtime -------------------------------------------------------

    async fn install_java(
        &self,
        game_root: &Path,
        resolved: &ResolvedVersion,
        listener: &Listener,
    ) -> Result<JavaInstall> {
        // Nach dem ersten Lauf liegt die Runtime schon bereit.
        if let Some(existing) = find_installed_runtime(game_root, resolved.java_major).await {
            return Ok(existing);
        }

        let cache = self.cache_dir.join("java_runtime_all.json");
        let bytes = self
            .cached_json(
                std::slice::from_ref(&self.java_manifest_url),
                &cache,
                JAVA_MANIFEST_MAX_AGE,
                false,
            )
            .await?;
        let root: Value = serde_json::from_slice(&bytes)?;
        let catalog = root.get("manifest").unwrap_or(&root);

        let platform_key = runtime_platform_key(&self.platform);
        let platform =
            catalog
                .get(&platform_key)
                .ok_or_else(|| InstallError::JavaRuntimeNotFound {
                    major: resolved.java_major,
                    platform: platform_key.clone(),
                })?;

        let (component, entry) = pick_runtime_component(
            platform,
            resolved.java_major,
            resolved.java_component.as_deref(),
        )
        .ok_or_else(|| InstallError::JavaRuntimeNotFound {
            major: resolved.java_major,
            platform: platform_key.clone(),
        })?;

        let manifest_info = entry.get("manifest").ok_or_else(|| {
            InstallError::InvalidRuntimeManifest(format!("{platform_key}/{component}"))
        })?;
        let manifest_url = manifest_info
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                InstallError::InvalidRuntimeManifest(format!("{platform_key}/{component}"))
            })?;
        let manifest_bytes = self
            .downloader
            .fetch_bytes(&[manifest_url.to_string()])
            .await?;
        verify_bytes(&manifest_bytes, manifest_info, Path::new(manifest_url))?;

        let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
        let files = manifest
            .get("files")
            .and_then(Value::as_object)
            .ok_or_else(|| InstallError::InvalidRuntimeManifest(component.clone()))?;

        let runtime_root = game_root.join("java").join(&component);
        let mut specs: BTreeMap<PathBuf, FileSpec> = BTreeMap::new();
        let mut directories: Vec<PathBuf> = Vec::new();

        for (relative, file) in files {
            match file.get("type").and_then(Value::as_str).unwrap_or("file") {
                "directory" => {
                    directories.push(safe_join(&runtime_root, relative)?);
                    continue;
                }
                // Symlinks werden auf Windows nicht gebraucht und nicht angelegt.
                "link" => continue,
                _ => {}
            }
            let raw = file
                .get("downloads")
                .and_then(|downloads| downloads.get("raw"))
                .ok_or_else(|| InstallError::InvalidRuntimeManifest(component.clone()))?;
            let url = raw
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| InstallError::InvalidRuntimeManifest(component.clone()))?;
            let destination = safe_join(&runtime_root, relative)?;
            let mut spec = FileSpec::new(destination.clone(), url);
            if let Some(sha1) = raw.get("sha1").and_then(Value::as_str) {
                spec = spec.with_sha1(sha1);
            }
            if let Some(size) = raw.get("size").and_then(Value::as_u64) {
                spec = spec.with_size(size);
            }
            specs.insert(destination, spec);
        }

        for directory in directories {
            tokio::fs::create_dir_all(&directory).await?;
        }

        let step_listener = Arc::clone(listener);
        let download = self
            .downloader
            .download_all(specs.into_values().collect(), move |progress| {
                step_listener.as_ref()(InstallEvent {
                    step: InstallStep::JavaRuntime,
                    progress,
                });
            })
            .await?;

        let java_path = runtime_root.join("bin").join(java_binary_name());
        if !java_path.is_file() {
            return Err(InstallError::JavaExecutableMissing {
                component,
                path: java_path,
            });
        }

        Ok(JavaInstall {
            component,
            version: entry
                .pointer("/version/name")
                .and_then(Value::as_str)
                .map(str::to_string),
            java_path,
            download,
        })
    }

    // -- Cache --------------------------------------------------------------

    async fn cached_json(
        &self,
        urls: &[String],
        cache_file: &Path,
        max_age: Duration,
        force: bool,
    ) -> Result<Vec<u8>> {
        if !force {
            if let Ok(metadata) = tokio::fs::metadata(cache_file).await {
                let fresh = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age < max_age);
                if fresh {
                    if let Ok(bytes) = tokio::fs::read(cache_file).await {
                        return Ok(bytes);
                    }
                }
            }
        }

        match self.downloader.fetch_bytes(urls).await {
            Ok(bytes) => {
                if let Some(parent) = cache_file.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(cache_file, &bytes).await;
                Ok(bytes)
            }
            // Veralteter Cache ist besser als kein Manifest.
            Err(error) => match tokio::fs::read(cache_file).await {
                Ok(bytes) => Ok(bytes),
                Err(_) => Err(error.into()),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct ManifestVersion {
    id: String,
    url: String,
    #[serde(default)]
    sha1: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VersionManifest {
    versions: Vec<ManifestVersion>,
}

#[derive(Debug, Deserialize)]
struct AssetIndexFile {
    #[serde(default)]
    objects: HashMap<String, AssetObject>,
    #[serde(rename = "virtual", default)]
    virtual_: bool,
    #[serde(default)]
    map_to_resources: bool,
}

#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
    #[serde(default)]
    size: u64,
}

fn emit(listener: &Listener, step: InstallStep, progress: DownloadProgress) {
    listener.as_ref()(InstallEvent { step, progress });
}

fn spec_from_download(
    destination: &Path,
    url: &str,
    sha1: Option<&str>,
    size: Option<u64>,
) -> FileSpec {
    let mut spec = FileSpec::new(destination.to_path_buf(), url);
    if let Some(sha1) = sha1 {
        spec = spec.with_sha1(sha1);
    }
    if let Some(size) = size {
        spec = spec.with_size(size);
    }
    spec
}

/// Sucht eine bereits vom Launcher installierte Runtime mit passender Version.
async fn find_installed_runtime(game_root: &Path, required: u32) -> Option<JavaInstall> {
    let mut entries = tokio::fs::read_dir(game_root.join("java")).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if !entry
            .file_type()
            .await
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let binary = entry.path().join("bin").join(java_binary_name());
        if !binary.is_file() {
            continue;
        }
        let Ok(runtime) = crate::java::probe_java(&binary).await else {
            continue;
        };
        if runtime.major != required {
            continue;
        }
        return Some(JavaInstall {
            component: entry.file_name().to_string_lossy().to_string(),
            version: Some(runtime.version),
            java_path: binary,
            download: DownloadReport::default(),
        });
    }
    None
}

/// Prüft einen Namen, der als einzelnes Pfadsegment verwendet wird.
fn validate_component(name: &str) -> Result<()> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.chars().any(char::is_control);
    if invalid {
        return Err(InstallError::InvalidName(name.to_string()));
    }
    Ok(())
}

/// Baut einen Pfad aus entfernten Daten und verhindert Ausbrüche aus `root`.
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let normalized = relative.replace('\\', "/");
    let mut path = root.to_path_buf();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(InstallError::UnsafePath(PathBuf::from(relative)));
        }
        path.push(part);
    }
    Ok(path)
}

/// Stellt sicher, dass ein bereits gebauter Pfad unterhalb von `root` liegt.
fn ensure_inside(root: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| InstallError::UnsafePath(path.to_path_buf()))?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(InstallError::UnsafePath(path.to_path_buf()));
    }
    Ok(())
}

fn is_sha1(value: &str) -> bool {
    value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn java_binary_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// Plattformschlüssel aus Mojangs `all.json`.
pub fn runtime_platform_key(platform: &PlatformInfo) -> String {
    let arm = platform.arch.contains("arm") || platform.arch.contains("aarch");
    let x86 = matches!(platform.arch.as_str(), "x86" | "ia32" | "i386" | "i686");
    match platform.name.as_str() {
        "windows" => {
            if arm {
                "windows-arm64".to_string()
            } else if x86 {
                "windows-x86".to_string()
            } else {
                "windows-x64".to_string()
            }
        }
        "osx" => {
            if arm {
                "mac-os-arm64".to_string()
            } else {
                "mac-os".to_string()
            }
        }
        "linux" => {
            if x86 {
                "linux-i386".to_string()
            } else {
                "linux".to_string()
            }
        }
        other => other.to_string(),
    }
}

/// Bekannte Runtime-Namen für eine Java-Version, bester zuerst.
fn components_for_major(major: u32) -> Vec<&'static str> {
    match major {
        8 => vec!["jre-legacy"],
        16 => vec!["java-runtime-alpha"],
        17 => vec![
            "java-runtime-gamma",
            "java-runtime-beta",
            "java-runtime-gamma-snapshot",
        ],
        21 => vec!["java-runtime-delta"],
        25 => vec!["java-runtime-epsilon"],
        _ => Vec::new(),
    }
}

fn runtime_major(entry: &Value) -> Option<u32> {
    entry
        .pointer("/version/name")
        .and_then(Value::as_str)
        .and_then(crate::java::parse_java_major)
}

/// Wählt das Runtime-Paket: Mojang-Empfehlung, bekannte Namen, sonst Suche
/// über alle Komponenten der Plattform. Innerhalb einer Komponente gewinnt die
/// höchste Patch-Version.
fn pick_runtime_component<'a>(
    platform: &'a Value,
    required_major: u32,
    hint: Option<&str>,
) -> Option<(String, &'a Value)> {
    let catalog = platform.as_object()?;

    let mut candidates: Vec<String> = Vec::new();
    if let Some(hint) = hint {
        candidates.push(hint.to_string());
    }
    candidates.extend(
        components_for_major(required_major)
            .into_iter()
            .map(str::to_string),
    );

    for component in candidates {
        if let Some(entries) = catalog.get(&component).and_then(Value::as_array) {
            if let Some(entry) = best_runtime(entries, required_major) {
                return Some((component, entry));
            }
        }
    }

    let mut names: Vec<&String> = catalog.keys().collect();
    names.sort();
    for component in names {
        if let Some(entries) = catalog.get(component).and_then(Value::as_array) {
            if let Some(entry) = best_runtime(entries, required_major) {
                return Some((component.clone(), entry));
            }
        }
    }
    None
}

fn best_runtime(entries: &[Value], required_major: u32) -> Option<&Value> {
    entries
        .iter()
        .filter(|entry| runtime_major(entry) == Some(required_major))
        .max_by(|a, b| {
            let left = a
                .pointer("/version/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let right = b
                .pointer("/version/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            version::compare_versions(left, right).cmp(&0)
        })
}

fn verify_bytes(bytes: &[u8], info: &Value, path: &Path) -> Result<()> {
    if let Some(expected) = info.get("sha1").and_then(Value::as_str) {
        let actual = crate::download::sha1_hex(bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(DownloadError::Checksum {
                path: path.to_path_buf(),
                expected: expected.to_string(),
                actual,
            }
            .into());
        }
    }
    if let Some(expected) = info.get("size").and_then(Value::as_u64) {
        if bytes.len() as u64 != expected {
            return Err(DownloadError::Size {
                path: path.to_path_buf(),
                expected,
                actual: bytes.len() as u64,
            }
            .into());
        }
    }
    Ok(())
}

/// Legt für alte Versionen `assets/virtual/<index>/<name>` an. Hardlinks
/// sparen Platz; scheitern sie (anderes Volume, Rechte), wird kopiert.
async fn create_virtual_assets(
    assets_root: &Path,
    virtual_dir: &Path,
    entries: &[(String, String, u64)],
) -> Result<()> {
    let mut links: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(entries.len());
    for (name, hash, _) in entries {
        let source = assets_root.join("objects").join(&hash[..2]).join(hash);
        links.push((source, safe_join(virtual_dir, name)?));
    }

    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        for (source, target) in links {
            if target.is_file() {
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if std::fs::hard_link(&source, &target).is_err() {
                std::fs::copy(&source, &target)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| std::io::Error::other(error.to_string()))??;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_blocks_traversal_and_absolute_paths() {
        let root = Path::new("C:/game");
        assert_eq!(
            safe_join(root, "assets/objects/ab/abc").unwrap(),
            PathBuf::from("C:/game/assets/objects/ab/abc")
        );
        assert!(safe_join(root, "../outside").is_err());
        assert!(safe_join(root, "assets/../../outside").is_err());
        assert!(safe_join(root, "C:/Windows/system32").is_err());
        assert!(safe_join(root, "objects\\ab\\hash").is_ok());
    }

    #[test]
    fn ensure_inside_rejects_paths_outside_the_root() {
        let root = Path::new("C:/game/libraries");
        assert!(ensure_inside(root, Path::new("C:/game/libraries/a/b.jar")).is_ok());
        assert!(ensure_inside(root, Path::new("C:/game/versions/a.jar")).is_err());
        assert!(ensure_inside(root, Path::new("C:/game/libraries/../evil.jar")).is_err());
    }

    #[test]
    fn version_names_cannot_escape_the_versions_folder() {
        assert!(validate_component("1.20.1").is_ok());
        assert!(validate_component("1.20.1-forge-47.3.0").is_ok());
        assert!(validate_component("..").is_err());
        assert!(validate_component("a/b").is_err());
        assert!(validate_component("a\\b").is_err());
        assert!(validate_component("C:evil").is_err());
        assert!(validate_component("").is_err());
    }

    #[test]
    fn platform_keys_match_mojangs_naming() {
        let platform = |name: &str, arch: &str| PlatformInfo {
            name: name.to_string(),
            arch: arch.to_string(),
            version: String::new(),
        };
        assert_eq!(
            runtime_platform_key(&platform("windows", "x64")),
            "windows-x64"
        );
        assert_eq!(
            runtime_platform_key(&platform("windows", "ia32")),
            "windows-x86"
        );
        assert_eq!(
            runtime_platform_key(&platform("windows", "arm64")),
            "windows-arm64"
        );
        assert_eq!(
            runtime_platform_key(&platform("osx", "arm64")),
            "mac-os-arm64"
        );
        assert_eq!(runtime_platform_key(&platform("osx", "x64")), "mac-os");
        assert_eq!(
            runtime_platform_key(&platform("linux", "ia32")),
            "linux-i386"
        );
        assert_eq!(runtime_platform_key(&platform("linux", "x64")), "linux");
    }

    #[test]
    fn runtime_component_prefers_the_recommended_name() {
        let platform = serde_json::json!({
            "java-runtime-gamma": [
                { "version": { "name": "17.0.8" }, "manifest": { "url": "a" } }
            ],
            "java-runtime-delta": [
                { "version": { "name": "21.0.1" }, "manifest": { "url": "b" } }
            ]
        });
        let (component, entry) = pick_runtime_component(&platform, 21, Some("java-runtime-delta"))
            .expect("Runtime muss gefunden werden");
        assert_eq!(component, "java-runtime-delta");
        assert_eq!(entry.pointer("/manifest/url").unwrap(), "b");
    }

    #[test]
    fn runtime_component_falls_back_to_scanning() {
        let platform = serde_json::json!({
            "java-runtime-gamma": [
                { "version": { "name": "17.0.9" }, "manifest": { "url": "neu" } },
                { "version": { "name": "17.0.8" }, "manifest": { "url": "alt" } }
            ]
        });
        let (component, entry) =
            pick_runtime_component(&platform, 17, None).expect("Fallback muss greifen");
        assert_eq!(component, "java-runtime-gamma");
        assert_eq!(entry.pointer("/manifest/url").unwrap(), "neu");
    }

    #[test]
    fn missing_runtime_major_is_reported() {
        let platform = serde_json::json!({
            "java-runtime-gamma": [
                { "version": { "name": "17.0.8" }, "manifest": { "url": "a" } }
            ]
        });
        assert!(pick_runtime_component(&platform, 8, None).is_none());
    }

    #[test]
    fn asset_hashes_must_be_full_sha1() {
        assert!(is_sha1("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_sha1("../0123456789abcdef0123456789abcdef0123456"));
        assert!(!is_sha1("abc"));
        assert!(!is_sha1("zz23456789abcdef0123456789abcdef01234567"));
    }
}
