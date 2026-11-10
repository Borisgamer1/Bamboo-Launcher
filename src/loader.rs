//! Automatische Installation von Mod-Loadern.
//!
//! Fabric liefert ein fertiges Versionsprofil als JSON – das wird geschrieben
//! und die enthaltenen Bibliotheken über den normalen Installer geladen.
//!
//! NeoForge geht einen anderen Weg: Das Profil entsteht erst durch den
//! offiziellen Installer, der den Vanilla-Client mit Binärpatches und Mappings
//! bearbeitet (zehn Processor-Schritte). Diese Kette in Rust nachzubauen wäre
//! ein eigener Installer; stattdessen wird der offizielle Installer headless
//! mit `--installClient` gestartet. Das Ergebnis ist dasselbe Profil, das auch
//! der offizielle Launcher erzeugen würde.

use crate::download::{DownloadError, Downloader, FileSpec};
use crate::error::LauncherError;
use crate::install::{InstallError, InstallOptions, Installer};
use crate::java;
use crate::mods::Loader;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

pub const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
pub const QUILT_META: &str = "https://meta.quiltmc.org/v3";
pub const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases";
pub const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OUTPUT_TAIL_CHARS: usize = 2000;

#[derive(Debug, Error)]
pub enum LoaderError {
    #[error("Ungültige Minecraft-Version: {0}")]
    InvalidVersion(String),

    #[error("Fabric bietet für Minecraft {0} keinen Loader an.")]
    NoFabricLoader(String),

    #[error("Fabric-Loader {loader} ist für Minecraft {minecraft} nicht verfügbar.")]
    UnknownFabricLoader { loader: String, minecraft: String },

    #[error("Quilt bietet für Minecraft {0} keinen Loader an.")]
    NoQuiltLoader(String),

    #[error("Quilt-Loader {loader} ist für Minecraft {minecraft} nicht verfügbar.")]
    UnknownQuiltLoader { loader: String, minecraft: String },

    #[error("Das Loader-Profil gehört zu {found}, erwartet war {expected}.")]
    ProfileMismatch { expected: String, found: String },

    #[error(
        "NeoForge bietet für Minecraft {0} keine passende Version an (NeoForge beginnt mit Minecraft 1.20.2)."
    )]
    NoNeoForgeVersion(String),

    #[error("Forge bietet für Minecraft {0} keine passende Version an.")]
    NoForgeVersion(String),

    #[error(
        "Die Basisversion {0} ist nicht installiert. Führe zuerst `bamboo-launcher install {0}` aus."
    )]
    MissingBaseVersion(String),

    #[error("Java {required} oder neuer wird für den NeoForge-Installer benötigt: {source}")]
    MissingJava {
        required: u32,
        #[source]
        source: Box<LauncherError>,
    },

    #[error("Der NeoForge-Installer konnte nicht gestartet werden: {0}")]
    Spawn(String),

    #[error("Der NeoForge-Installer hat nach {0} Sekunden nicht fertig installiert.")]
    Timeout(u64),

    #[error("Der NeoForge-Installer endete mit {status}:\n{output}")]
    InstallerFailed { status: String, output: String },

    #[error("Der NeoForge-Installer hat kein Profil {0} erzeugt.")]
    MissingProfile(String),

    #[error("Netzwerkfehler: {0}")]
    Network(String),

    #[error("Ungültige Antwort von {url}: {reason}")]
    InvalidResponse { url: String, reason: String },

    #[error(transparent)]
    Download(#[from] DownloadError),

    #[error(transparent)]
    Install(#[from] InstallError),

    #[error(transparent)]
    Launcher(#[from] LauncherError),

    #[error("I/O-Fehler: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON-Fehler: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, LoaderError>;

#[derive(Debug, Clone)]
pub struct LoaderInstall {
    pub loader: Loader,
    pub loader_version: String,
    /// ID des installierten Versionsprofils (`fabric-loader-…`, `neoforge-…`).
    pub version_id: String,
    pub minecraft_version: String,
    /// Vom Launcher geladene Bibliotheken (Fabric); beim NeoForge-Installer 0.
    pub library_files: usize,
    pub downloaded_bytes: u64,
    /// Ob der offizielle NeoForge-Installer die Bibliotheken selbst gelegt hat.
    pub used_installer: bool,
    /// Fehlende Bibliotheksdateien im Profil – bei 0 ist der Classpath vollständig.
    pub missing_libraries: usize,
}

/// Ein bereits auf der Platte liegendes Loader-Profil.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledLoader {
    pub version_id: String,
    pub loader: Loader,
    pub loader_version: String,
    pub minecraft_version: String,
}

/// Ergebnis einer Update-Prüfung. `applied` ist nur gesetzt, wenn wirklich
/// installiert wurde – so lässt sich dieselbe Struktur für `--dry-run` nutzen.
#[derive(Debug, Clone)]
pub struct LoaderUpdate {
    pub installed: InstalledLoader,
    pub latest: Option<String>,
    pub update_available: bool,
    pub applied: Option<LoaderInstall>,
    /// Instanzen, die von der alten auf die neue Profil-ID umgehängt wurden.
    pub retargeted_instances: Vec<String>,
}

pub struct LoaderInstaller {
    fabric_meta: String,
    quilt_meta: String,
    neoforge_maven: String,
    forge_maven: String,
    cache_dir: PathBuf,
    java_path: Option<PathBuf>,
    downloader: Downloader,
}

impl LoaderInstaller {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            fabric_meta: FABRIC_META.to_string(),
            quilt_meta: QUILT_META.to_string(),
            neoforge_maven: NEOFORGE_MAVEN.to_string(),
            forge_maven: FORGE_MAVEN.to_string(),
            cache_dir: cache_dir.into(),
            java_path: None,
            downloader: Downloader::new(),
        }
    }

    /// Überschreibbar, damit Tests gegen einen lokalen Server laufen.
    pub fn with_endpoints(
        mut self,
        fabric_meta: impl Into<String>,
        neoforge_maven: impl Into<String>,
        quilt_meta: impl Into<String>,
    ) -> Self {
        self.fabric_meta = fabric_meta.into().trim_end_matches('/').to_string();
        self.neoforge_maven = neoforge_maven.into().trim_end_matches('/').to_string();
        self.quilt_meta = quilt_meta.into().trim_end_matches('/').to_string();
        self
    }

    pub fn with_java_path(mut self, java_path: Option<PathBuf>) -> Self {
        self.java_path = java_path;
        self
    }

    pub fn with_downloader(mut self, downloader: Downloader) -> Self {
        self.downloader = downloader;
        self
    }

    pub async fn install(
        &self,
        game_root: &Path,
        minecraft_version: &str,
        loader: Loader,
        loader_version: Option<&str>,
    ) -> Result<LoaderInstall> {
        validate_minecraft_version(minecraft_version)?;
        match loader {
            Loader::Fabric => {
                self.install_fabric(game_root, minecraft_version, loader_version)
                    .await
            }
            Loader::Quilt => {
                self.install_quilt(game_root, minecraft_version, loader_version)
                    .await
            }
            Loader::Forge => {
                self.install_forge(game_root, minecraft_version, loader_version)
                    .await
            }
            Loader::NeoForge => {
                self.install_neoforge(game_root, minecraft_version, loader_version)
                    .await
            }
        }
    }

    // -- Updates ------------------------------------------------------------

    /// Prüft alle installierten Loader-Profile gegen die aktuellen Metadaten.
    /// Ohne `minecraft`/`loader`-Filter werden alle Profile berücksichtigt.
    pub async fn check_updates(
        &self,
        game_root: &Path,
        minecraft: Option<&str>,
        loader: Option<Loader>,
    ) -> Result<Vec<LoaderUpdate>> {
        let mut updates = Vec::new();
        for installed in installed_loaders(game_root)? {
            if minecraft.is_some_and(|filter| installed.minecraft_version != filter) {
                continue;
            }
            if loader.is_some_and(|filter| installed.loader != filter) {
                continue;
            }
            let latest = self
                .latest_loader_version(installed.loader, &installed.minecraft_version)
                .await?;
            let update_available = version_key(&latest) > version_key(&installed.loader_version);
            updates.push(LoaderUpdate {
                installed,
                latest: Some(latest),
                update_available,
                applied: None,
                retargeted_instances: Vec::new(),
            });
        }
        Ok(updates)
    }

    /// Prüft genau ein installiertes Profil – der Hinweis vor dem Spielstart.
    /// Anders als [`installed_loaders`] werden auch ersetzte Profile gefunden,
    /// denn eine Instanz kann noch an einem alten Profil hängen.
    pub async fn check_update_for(
        &self,
        game_root: &Path,
        version_id: &str,
    ) -> Result<Option<LoaderUpdate>> {
        let Some(installed) = scan_loader_profiles(game_root)?
            .into_iter()
            .find(|profile| profile.version_id == version_id)
        else {
            return Ok(None);
        };
        let latest = self
            .latest_loader_version(installed.loader, &installed.minecraft_version)
            .await?;
        if version_key(&latest) <= version_key(&installed.loader_version) {
            return Ok(None);
        }
        Ok(Some(LoaderUpdate {
            installed,
            latest: Some(latest),
            update_available: true,
            applied: None,
            retargeted_instances: Vec::new(),
        }))
    }

    /// Installiert alle verfügbaren Aktualisierungen und hängt Instanzen um.
    pub async fn update_all(
        &self,
        game_root: &Path,
        minecraft: Option<&str>,
        loader: Option<Loader>,
    ) -> Result<Vec<LoaderUpdate>> {
        let mut updates = self.check_updates(game_root, minecraft, loader).await?;
        for update in updates.iter_mut().filter(|update| update.update_available) {
            self.apply_update(game_root, update).await?;
        }
        Ok(updates)
    }

    /// Aktualisiert genau ein Profil – das Angebot vor dem Spielstart.
    pub async fn update_profile(
        &self,
        game_root: &Path,
        version_id: &str,
    ) -> Result<Option<LoaderUpdate>> {
        let Some(mut update) = self.check_update_for(game_root, version_id).await? else {
            return Ok(None);
        };
        self.apply_update(game_root, &mut update).await?;
        Ok(Some(update))
    }

    /// Führt die in einer Prüfung gefundene Aktualisierung aus und hängt
    /// Instanzen auf die neue Profil-ID um.
    async fn apply_update(&self, game_root: &Path, update: &mut LoaderUpdate) -> Result<()> {
        let Some(latest) = update.latest.clone() else {
            return Ok(());
        };
        let install = self
            .install(
                game_root,
                &update.installed.minecraft_version,
                update.installed.loader,
                Some(&latest),
            )
            .await?;
        update.retargeted_instances =
            retarget_instances(game_root, &update.installed.version_id, &install.version_id)?;
        update.applied = Some(install);
        Ok(())
    }

    async fn latest_loader_version(
        &self,
        loader: Loader,
        minecraft_version: &str,
    ) -> Result<String> {
        match loader {
            Loader::Fabric => {
                let url = format!(
                    "{}/versions/loader/{}",
                    self.fabric_meta,
                    encode_segment(minecraft_version)
                );
                let entries: Vec<FabricEntry> = self.get_json(&url).await?;
                pick_fabric_loader(&entries, minecraft_version, None)
            }
            Loader::Quilt => {
                let url = format!(
                    "{}/versions/loader/{}",
                    self.quilt_meta,
                    encode_segment(minecraft_version)
                );
                let entries: Vec<QuiltEntry> = self.get_json(&url).await?;
                pick_quilt_loader(&entries, minecraft_version, None)
            }
            Loader::NeoForge => {
                let versions = self.neoforge_versions().await?;
                pick_neoforge_version(&versions, minecraft_version, None)
            }
            Loader::Forge => {
                let versions = self.forge_versions().await?;
                let artifact = pick_forge_version(&versions, minecraft_version, None)?;
                Ok(forge_loader_version(&artifact).to_string())
            }
        }
    }

    // -- Fabric -------------------------------------------------------------

    async fn install_fabric(
        &self,
        game_root: &Path,
        minecraft_version: &str,
        pinned: Option<&str>,
    ) -> Result<LoaderInstall> {
        // Das Fabric-Profil erbt vom Vanilla-JSON; ohne Basis gibt es nichts
        // aufzulösen – und der Fehler soll das sagen, statt mitten im
        // Bibliotheks-Schreiben aufzutauchen.
        self.base_version(game_root, minecraft_version)?;

        let versions_url = format!(
            "{}/versions/loader/{}",
            self.fabric_meta,
            encode_segment(minecraft_version)
        );
        let entries: Vec<FabricEntry> = self.get_json(&versions_url).await?;
        let loader_version = pick_fabric_loader(&entries, minecraft_version, pinned)?;

        let profile_url = format!(
            "{}/versions/loader/{}/{}/profile/json",
            self.fabric_meta,
            encode_segment(minecraft_version),
            encode_segment(&loader_version)
        );
        let profile: Value = self.get_json(&profile_url).await?;

        let id = profile.get("id").and_then(Value::as_str).ok_or_else(|| {
            LoaderError::InvalidResponse {
                url: profile_url.clone(),
                reason: "Profil enthält keine ID".to_string(),
            }
        })?;
        validate_version_id(id)?;
        let inherits = profile
            .get("inheritsFrom")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if inherits != minecraft_version {
            return Err(LoaderError::ProfileMismatch {
                expected: minecraft_version.to_string(),
                found: inherits.to_string(),
            });
        }

        write_version_profile(game_root, id, &profile)?;

        let report = Installer::new(self.cache_dir.clone())
            .install_version(
                game_root,
                id,
                &InstallOptions {
                    assets: false,
                    java: false,
                    refresh_manifest: false,
                },
                |_| {},
            )
            .await?;

        let (library_files, missing_libraries) = profile_library_state(game_root, id)?;

        Ok(LoaderInstall {
            loader: Loader::Fabric,
            loader_version,
            version_id: id.to_string(),
            minecraft_version: minecraft_version.to_string(),
            library_files,
            downloaded_bytes: report.downloaded_bytes(),
            used_installer: false,
            missing_libraries,
        })
    }

    // -- Quilt --------------------------------------------------------------

    /// Quilt liefert wie Fabric ein fertiges Profil samt Bibliotheksliste.
    /// Der offizielle Installer würde zusätzlich eine Dummy-Jar und einen
    /// `launcher_profiles.json`-Eintrag anlegen; für den eigenen Launcher
    /// genügt das Profil, die Bibliotheken lädt der normale Installer.
    async fn install_quilt(
        &self,
        game_root: &Path,
        minecraft_version: &str,
        pinned: Option<&str>,
    ) -> Result<LoaderInstall> {
        self.base_version(game_root, minecraft_version)?;

        let versions_url = format!(
            "{}/versions/loader/{}",
            self.quilt_meta,
            encode_segment(minecraft_version)
        );
        let entries: Vec<QuiltEntry> = self.get_json(&versions_url).await?;
        let loader_version = pick_quilt_loader(&entries, minecraft_version, pinned)?;

        let profile_url = format!(
            "{}/versions/loader/{}/{}/profile/json",
            self.quilt_meta,
            encode_segment(minecraft_version),
            encode_segment(&loader_version)
        );
        let profile: Value = self.get_json(&profile_url).await?;

        let id = profile.get("id").and_then(Value::as_str).ok_or_else(|| {
            LoaderError::InvalidResponse {
                url: profile_url.clone(),
                reason: "Profil enthält keine ID".to_string(),
            }
        })?;
        validate_version_id(id)?;
        let inherits = profile
            .get("inheritsFrom")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if inherits != minecraft_version {
            return Err(LoaderError::ProfileMismatch {
                expected: minecraft_version.to_string(),
                found: inherits.to_string(),
            });
        }

        write_version_profile(game_root, id, &profile)?;

        let report = Installer::new(self.cache_dir.clone())
            .install_version(
                game_root,
                id,
                &InstallOptions {
                    assets: false,
                    java: false,
                    refresh_manifest: false,
                },
                |_| {},
            )
            .await?;

        let (library_files, missing_libraries) = profile_library_state(game_root, id)?;

        Ok(LoaderInstall {
            loader: Loader::Quilt,
            loader_version,
            version_id: id.to_string(),
            minecraft_version: minecraft_version.to_string(),
            library_files,
            downloaded_bytes: report.downloaded_bytes(),
            used_installer: false,
            missing_libraries,
        })
    }

    // -- NeoForge -----------------------------------------------------------

    async fn install_neoforge(
        &self,
        game_root: &Path,
        minecraft_version: &str,
        pinned: Option<&str>,
    ) -> Result<LoaderInstall> {
        let base = self.base_version(game_root, minecraft_version)?;

        let versions = self.neoforge_versions().await?;
        let version = pick_neoforge_version(&versions, minecraft_version, pinned)?;
        let installer = self.download_installer(&version).await?;
        let id = format!("neoforge-{version}");

        self.run_installer(
            game_root,
            &installer,
            base.java_major,
            Loader::NeoForge,
            &id,
            &version,
            minecraft_version,
        )
        .await
    }

    // -- Forge --------------------------------------------------------------

    /// Forge geht denselben Weg wie NeoForge: derselbe Installer, dieselben
    /// Argumente, nur ein anderer Maven host und eine andere Profil-ID
    /// (`1.20.1-forge-47.4.0`).
    async fn install_forge(
        &self,
        game_root: &Path,
        minecraft_version: &str,
        pinned: Option<&str>,
    ) -> Result<LoaderInstall> {
        let base = self.base_version(game_root, minecraft_version)?;

        let versions = self.forge_versions().await?;
        let artifact = pick_forge_version(&versions, minecraft_version, pinned)?;
        let loader_version = forge_loader_version(&artifact).to_string();
        let installer = self.download_forge_installer(&artifact).await?;
        let id = format!("{minecraft_version}-forge-{loader_version}");

        self.run_installer(
            game_root,
            &installer,
            base.java_major,
            Loader::Forge,
            &id,
            &loader_version,
            minecraft_version,
        )
        .await
    }

    /// Startet den offiziellen Installer headless. Er erzeugt dasselbe Profil,
    /// das auch der offizielle Launcher anlegen würde; die Bibliotheken legt er
    /// selbst, deshalb steht `downloaded_bytes` auf 0.
    #[allow(clippy::too_many_arguments)]
    async fn run_installer(
        &self,
        game_root: &Path,
        installer: &Path,
        java_major: u32,
        loader: Loader,
        version_id: &str,
        loader_version: &str,
        minecraft_version: &str,
    ) -> Result<LoaderInstall> {
        ensure_launcher_profiles(game_root)?;

        let runtime = java::find_java_in(game_root, self.java_path.as_deref(), java_major)
            .await
            .map_err(|source| LoaderError::MissingJava {
                required: java_major,
                source: Box::new(source),
            })?;

        let log_dir = self.cache_dir.join("loaders");
        std::fs::create_dir_all(&log_dir)?;
        let command = tokio::process::Command::new(&runtime.path)
            .arg("-jar")
            .arg(installer)
            .arg("--installClient")
            .arg(game_root)
            .current_dir(&log_dir)
            .kill_on_drop(true)
            .output();

        let output = tokio::time::timeout(INSTALLER_TIMEOUT, command)
            .await
            .map_err(|_| LoaderError::Timeout(INSTALLER_TIMEOUT.as_secs()))?
            .map_err(|error| LoaderError::Spawn(error.to_string()))?;

        if !output.status.success() {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return Err(LoaderError::InstallerFailed {
                status: format!("{:?}", output.status),
                output: tail(&text, OUTPUT_TAIL_CHARS),
            });
        }

        let profile = game_root
            .join("versions")
            .join(version_id)
            .join(format!("{version_id}.json"));
        if !profile.is_file() {
            return Err(LoaderError::MissingProfile(version_id.to_string()));
        }

        let (library_files, missing_libraries) = profile_library_state(game_root, version_id)?;

        Ok(LoaderInstall {
            loader,
            loader_version: loader_version.to_string(),
            version_id: version_id.to_string(),
            minecraft_version: minecraft_version.to_string(),
            library_files,
            downloaded_bytes: 0,
            used_installer: true,
            missing_libraries,
        })
    }

    /// Lädt die Vanilla-Basis der Version und prüft, ob sie vollständig ist.
    /// Beide Loader erben von ihr, also muss sie vor dem Schreiben existieren.
    fn base_version(
        &self,
        game_root: &Path,
        minecraft_version: &str,
    ) -> Result<crate::version::ResolvedVersion> {
        let base = match crate::version::resolve_version(game_root, minecraft_version) {
            Ok(base) => base,
            Err(LauncherError::VersionNotFound(..)) => {
                return Err(LoaderError::MissingBaseVersion(
                    minecraft_version.to_string(),
                ));
            }
            Err(error) => return Err(error.into()),
        };
        let libraries_present = base
            .libraries
            .iter()
            .chain(base.natives.iter())
            .all(|library| library.path.is_file());
        if !base.client_jar.is_file() || !libraries_present {
            return Err(LoaderError::MissingBaseVersion(
                minecraft_version.to_string(),
            ));
        }
        Ok(base)
    }

    async fn neoforge_versions(&self) -> Result<Vec<String>> {
        let url = format!(
            "{}/net/neoforged/neoforge/maven-metadata.xml",
            self.neoforge_maven
        );
        let bytes = self.fetch(&url).await?;
        let versions = parse_maven_versions(&String::from_utf8_lossy(&bytes));
        if versions.is_empty() {
            return Err(LoaderError::InvalidResponse {
                url,
                reason: "keine Versionen im Maven-Metadatensatz".to_string(),
            });
        }
        Ok(versions)
    }

    async fn forge_versions(&self) -> Result<Vec<String>> {
        let url = format!(
            "{}/net/minecraftforge/forge/maven-metadata.xml",
            self.forge_maven
        );
        let bytes = self.fetch(&url).await?;
        let versions = parse_maven_versions(&String::from_utf8_lossy(&bytes));
        if versions.is_empty() {
            return Err(LoaderError::InvalidResponse {
                url,
                reason: "keine Versionen im Maven-Metadatensatz".to_string(),
            });
        }
        Ok(versions)
    }

    async fn download_installer(&self, version: &str) -> Result<PathBuf> {
        let base = format!(
            "{}/net/neoforged/neoforge/{}",
            self.neoforge_maven,
            encode_segment(version)
        );
        let url = format!("{base}/neoforge-{version}-installer.jar");
        self.download_installer_from(url, &format!("neoforge-{version}-installer.jar"))
            .await
    }

    async fn download_forge_installer(&self, artifact: &str) -> Result<PathBuf> {
        let url = format!(
            "{}/net/minecraftforge/forge/{}/forge-{artifact}-installer.jar",
            self.forge_maven,
            encode_segment(artifact)
        );
        self.download_installer_from(url, &format!("forge-{artifact}-installer.jar"))
            .await
    }

    /// Die `.sha1`-Datei ist optional; fehlt sie, wird ohne Prüfsumme geladen.
    async fn download_installer_from(&self, url: String, file_name: &str) -> Result<PathBuf> {
        let sha1 = match self.fetch(&format!("{url}.sha1")).await {
            Ok(bytes) => parse_sha1(&String::from_utf8_lossy(&bytes)),
            Err(_) => None,
        };

        let destination = self.cache_dir.join("loaders").join(file_name);
        let mut spec = FileSpec::new(destination.clone(), url);
        if let Some(sha1) = sha1 {
            spec = spec.with_sha1(sha1);
        }
        self.downloader.download_all(vec![spec], |_| {}).await?;
        Ok(destination)
    }

    // -- HTTP ---------------------------------------------------------------

    async fn fetch(&self, url: &str) -> Result<Vec<u8>> {
        self.downloader
            .fetch_bytes(&[url.to_string()])
            .await
            .map_err(|error| LoaderError::Network(format!("{url}: {error}")))
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let bytes = self.fetch(url).await?;
        serde_json::from_slice(&bytes).map_err(|error| LoaderError::InvalidResponse {
            url: url.to_string(),
            reason: error.to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// Installierte Profile
// ---------------------------------------------------------------------------

/// Liest alle Loader-Profile von der Platte – inklusive ersetzter Profile.
fn scan_loader_profiles(game_root: &Path) -> Result<Vec<InstalledLoader>> {
    let versions_dir = game_root.join("versions");
    let entries = match std::fs::read_dir(&versions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut found: Vec<InstalledLoader> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let version_id = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().join(format!("{version_id}.json"));
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(profile) = serde_json::from_slice::<crate::version::VersionJson>(&bytes) else {
            continue;
        };
        // Nur Profile mit Elternteil sind Loader-Profile; Vanilla bleibt außen vor.
        let Some(minecraft_version) = profile.inherits_from.clone() else {
            continue;
        };

        if let Some(loader_version) = profile.libraries.iter().find_map(|library| {
            library
                .name
                .strip_prefix("net.fabricmc:fabric-loader:")
                .map(|rest| rest.split(':').next().unwrap_or(rest).to_string())
        }) {
            found.push(InstalledLoader {
                version_id,
                loader: Loader::Fabric,
                loader_version,
                minecraft_version,
            });
            continue;
        }

        if let Some(loader_version) = profile.libraries.iter().find_map(|library| {
            library
                .name
                .strip_prefix("org.quiltmc:quilt-loader:")
                .map(|rest| rest.split(':').next().unwrap_or(rest).to_string())
        }) {
            found.push(InstalledLoader {
                version_id,
                loader: Loader::Quilt,
                loader_version,
                minecraft_version,
            });
            continue;
        }

        if let Some(artifact) = profile.libraries.iter().find_map(|library| {
            library
                .name
                .strip_prefix("net.minecraftforge:forge:")
                .map(str::to_string)
        }) {
            found.push(InstalledLoader {
                version_id,
                loader: Loader::Forge,
                loader_version: forge_loader_version(&artifact).to_string(),
                minecraft_version: artifact
                    .split_once('-')
                    .map(|(minecraft, _)| minecraft.to_string())
                    .unwrap_or(minecraft_version),
            });
            continue;
        }

        let neoforge_version = version_id
            .strip_prefix("neoforge-")
            .filter(|version| !version.is_empty())
            .map(str::to_string);
        if let Some(loader_version) = neoforge_version {
            found.push(InstalledLoader {
                version_id,
                loader: Loader::NeoForge,
                loader_version,
                minecraft_version,
            });
        }
    }
    Ok(found)
}

/// Das installierte Profil mit genau dieser ID – auch ein inzwischen von einem
/// neueren Profil abgelöstes. Ein Pack-Update kann damit prüfen, ob der
/// verlangte Loader schon liegt, und den teuren Installer-Lauf sparen.
pub fn installed_loader(game_root: &Path, version_id: &str) -> Result<Option<InstalledLoader>> {
    Ok(scan_loader_profiles(game_root)?
        .into_iter()
        .find(|profile| profile.version_id == version_id))
}

/// Erkennt Loader-Profile an ihrer Versions-JSON, nicht am Verzeichnisnamen –
/// so bleiben auch verschachtelte Namen und Prerelease-Versionen eindeutig.
///
/// Pro Loader und Minecraft-Version wird nur das neueste Profil geliefert:
/// Nach einer Aktualisierung liegt das alte Profil noch auf der Platte, soll
/// aber nicht erneut als veraltet gemeldet werden.
pub fn installed_loaders(game_root: &Path) -> Result<Vec<InstalledLoader>> {
    let mut found = scan_loader_profiles(game_root)?;

    // Ersetzte Profile ausblenden: gleicher Loader, gleiche Minecraft-Version,
    // aber eine ältere Loader-Version als ein anderes vorhandenes Profil.
    let mut keep = Vec::with_capacity(found.len());
    for (index, candidate) in found.iter().enumerate() {
        let superseded = found.iter().enumerate().any(|(other_index, other)| {
            other_index != index
                && other.loader == candidate.loader
                && other.minecraft_version == candidate.minecraft_version
                && version_key(&other.loader_version) > version_key(&candidate.loader_version)
        });
        keep.push(!superseded);
    }
    found = found
        .into_iter()
        .zip(keep)
        .filter_map(|(profile, keep)| keep.then_some(profile))
        .collect();

    found.sort_by(|left, right| {
        left.minecraft_version
            .cmp(&right.minecraft_version)
            .then(left.loader.label().cmp(right.loader.label()))
            .then(version_key(&left.loader_version).cmp(&version_key(&right.loader_version)))
    });
    Ok(found)
}

/// Hängt Instanzen von einem alten auf ein neues Profil um. Ohne das würde
/// eine Aktualisierung die Instanzen ins Leere zeigen lassen.
fn retarget_instances(game_root: &Path, old_id: &str, new_id: &str) -> Result<Vec<String>> {
    let manager = crate::instances::InstanceManager::new(game_root.join("instances"));
    let mut moved = Vec::new();
    for instance in manager.list()? {
        if instance.version_id.as_deref() == Some(old_id) {
            manager.set_version(&instance.name, new_id)?;
            moved.push(instance.name);
        }
    }
    Ok(moved)
}

// ---------------------------------------------------------------------------
// Auswahl und Prüfungen
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct FabricEntry {
    loader: FabricLoaderInfo,
}

#[derive(Debug, Deserialize)]
struct FabricLoaderInfo {
    #[serde(default)]
    version: String,
    #[serde(default)]
    stable: bool,
}

#[derive(Debug, Deserialize)]
struct QuiltEntry {
    loader: QuiltLoaderInfo,
}

#[derive(Debug, Deserialize)]
struct QuiltLoaderInfo {
    #[serde(default)]
    version: String,
}

fn pick_fabric_loader(
    entries: &[FabricEntry],
    minecraft_version: &str,
    pinned: Option<&str>,
) -> Result<String> {
    if entries.is_empty() {
        return Err(LoaderError::NoFabricLoader(minecraft_version.to_string()));
    }
    if let Some(pinned) = pinned {
        if entries.iter().any(|entry| entry.loader.version == pinned) {
            return Ok(pinned.to_string());
        }
        return Err(LoaderError::UnknownFabricLoader {
            loader: pinned.to_string(),
            minecraft: minecraft_version.to_string(),
        });
    }
    entries
        .iter()
        .find(|entry| entry.loader.stable && !entry.loader.version.is_empty())
        .or_else(|| {
            entries
                .iter()
                .find(|entry| !entry.loader.version.is_empty())
        })
        .map(|entry| entry.loader.version.clone())
        .ok_or_else(|| LoaderError::NoFabricLoader(minecraft_version.to_string()))
}

/// Quilt Meta liefert die Einträge nicht zuverlässig sortiert; Prereleases
/// tragen einen Bindestrich und werden nur genommen, wenn es nichts Stabiles
/// gibt. Die Version wird deshalb wie bei Fabric lokal ausgewählt.
fn pick_quilt_loader(
    entries: &[QuiltEntry],
    minecraft_version: &str,
    pinned: Option<&str>,
) -> Result<String> {
    if entries.is_empty() {
        return Err(LoaderError::NoQuiltLoader(minecraft_version.to_string()));
    }
    if let Some(pinned) = pinned {
        if entries
            .iter()
            .any(|entry| !entry.loader.version.is_empty() && entry.loader.version == pinned)
        {
            return Ok(pinned.to_string());
        }
        return Err(LoaderError::UnknownQuiltLoader {
            loader: pinned.to_string(),
            minecraft: minecraft_version.to_string(),
        });
    }

    let mut versions: Vec<&str> = entries
        .iter()
        .map(|entry| entry.loader.version.as_str())
        .filter(|version| !version.is_empty())
        .collect();
    versions.sort_by_key(|version| version_key(version));
    let stable = versions
        .iter()
        .rev()
        .find(|version| !version.contains('-'))
        .copied();
    stable
        .or_else(|| versions.last().copied())
        .map(str::to_string)
        .ok_or_else(|| LoaderError::NoQuiltLoader(minecraft_version.to_string()))
}

/// `1.21.1` → `21.1.`, `1.21` → `21.0.`, `26.1` → `26.1.`.
/// NeoForge zählt die Minecraft-Major-Version ohne führende 1.
fn neoforge_prefix(minecraft_version: &str) -> Option<String> {
    let trimmed = minecraft_version
        .strip_prefix("1.")
        .unwrap_or(minecraft_version);
    let mut parts = trimmed.split('.');
    let major = parts.next()?;
    if major.is_empty() || !major.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    match parts.next() {
        Some(minor) if minor.chars().all(|ch| ch.is_ascii_digit()) && !minor.is_empty() => {
            Some(format!("{major}.{minor}."))
        }
        Some(_) => None,
        None => Some(format!("{major}.0.")),
    }
}

fn pick_neoforge_version(
    versions: &[String],
    minecraft_version: &str,
    pinned: Option<&str>,
) -> Result<String> {
    let prefix = neoforge_prefix(minecraft_version)
        .ok_or_else(|| LoaderError::NoNeoForgeVersion(minecraft_version.to_string()))?;
    let mut candidates: Vec<&String> = versions
        .iter()
        .filter(|version| version.starts_with(&prefix))
        .filter(|version| {
            let lower = version.to_ascii_lowercase();
            !lower.contains("beta") && !lower.contains("alpha") && !version.contains('-')
        })
        .collect();
    candidates.sort_by_key(|version| version_key(version));

    if let Some(pinned) = pinned {
        // Auch eine feste Version muss zu dieser Minecraft-Version gehören.
        return if versions
            .iter()
            .any(|version| version == pinned && version.starts_with(&prefix))
        {
            Ok(pinned.to_string())
        } else {
            Err(LoaderError::InvalidVersion(format!(
                "NeoForge {pinned} gehört nicht zu Minecraft {minecraft_version}"
            )))
        };
    }
    candidates
        .last()
        .map(|version| (*version).clone())
        .ok_or_else(|| LoaderError::NoNeoForgeVersion(minecraft_version.to_string()))
}

/// Forge-Maven listet Artefakte als `1.20.1-47.4.0`; der Installer braucht
/// den vollen Namen, der Launcher zusätzlich die reine Loader-Version.
fn forge_loader_version(artifact: &str) -> &str {
    artifact
        .split_once('-')
        .map(|(_, rest)| rest.split('-').next().unwrap_or(rest))
        .unwrap_or(artifact)
}

fn pick_forge_version(
    versions: &[String],
    minecraft_version: &str,
    pinned: Option<&str>,
) -> Result<String> {
    let prefix = format!("{minecraft_version}-");
    let matches_version =
        |version: &String| version.starts_with(&prefix) && version.len() > prefix.len();

    if let Some(pinned) = pinned {
        // Auch eine feste Version muss genau zu dieser Minecraft-Version gehören.
        return versions
            .iter()
            .find(|version| matches_version(version) && forge_loader_version(version) == pinned)
            .cloned()
            .ok_or_else(|| {
                LoaderError::InvalidVersion(format!(
                    "Forge {pinned} gehört nicht zu Minecraft {minecraft_version}"
                ))
            });
    }

    let mut candidates: Vec<&String> = versions
        .iter()
        .filter(|version| matches_version(version))
        .filter(|version| {
            let lower = version.to_ascii_lowercase();
            !lower.contains("beta") && !lower.contains("alpha")
        })
        .collect();
    candidates.sort_by_key(|version| version_key(forge_loader_version(version)));

    candidates
        .last()
        .map(|version| (*version).clone())
        .ok_or_else(|| LoaderError::NoForgeVersion(minecraft_version.to_string()))
}

fn version_key(version: &str) -> Vec<u32> {
    version
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn parse_maven_versions(xml: &str) -> Vec<String> {
    let mut versions = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<version>") {
        let after = &rest[start + "<version>".len()..];
        let Some(end) = after.find("</version>") else {
            break;
        };
        let value = after[..end].trim();
        if !value.is_empty() {
            versions.push(value.to_string());
        }
        rest = &after[end + "</version>".len()..];
    }
    versions.sort();
    versions.dedup();
    versions
}

fn parse_sha1(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?;
    if token.len() == 40 && token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(token.to_ascii_lowercase())
    } else {
        None
    }
}

fn ensure_launcher_profiles(game_root: &Path) -> Result<()> {
    let path = game_root.join("launcher_profiles.json");
    if path.is_file() {
        return Ok(());
    }
    std::fs::write(&path, br#"{"profiles":{},"settings":{},"version":3}"#)?;
    Ok(())
}

fn write_version_profile(game_root: &Path, id: &str, profile: &Value) -> Result<()> {
    let directory = game_root.join("versions").join(id);
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}.json"));
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(profile)?)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// Zählt Bibliotheken des Profils und wie viele davon auf der Platte fehlen.
fn profile_library_state(game_root: &Path, version_id: &str) -> Result<(usize, usize)> {
    let resolved = crate::version::resolve_version(game_root, version_id)?;
    let all = resolved.libraries.iter().chain(resolved.natives.iter());
    let mut total = 0;
    let mut missing = 0;
    for library in all {
        total += 1;
        if !library.path.is_file() {
            missing += 1;
        }
    }
    Ok((total, missing))
}

fn validate_minecraft_version(value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 32
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
    {
        return Err(LoaderError::InvalidVersion(value.to_string()));
    }
    Ok(())
}

fn validate_version_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 96
        || value == "."
        || value == ".."
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
    {
        return Err(LoaderError::InvalidVersion(value.to_string()));
    }
    Ok(())
}

/// Prozent-Kodierung für ein einzelnes URL-Pfadsegment.
fn encode_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.trim().to_string();
    }
    text.chars().skip(count - max).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_minecraft_versions_to_neoforge_prefixes() {
        assert_eq!(neoforge_prefix("1.21.1").as_deref(), Some("21.1."));
        assert_eq!(neoforge_prefix("1.21").as_deref(), Some("21.0."));
        assert_eq!(neoforge_prefix("1.20.6").as_deref(), Some("20.6."));
        assert_eq!(neoforge_prefix("26.1").as_deref(), Some("26.1."));
        assert_eq!(neoforge_prefix("kaputt"), None);
    }

    #[test]
    fn picks_the_newest_stable_neoforge_version() {
        let versions = [
            "21.1.9",
            "21.1.77",
            "21.1.100-beta",
            "21.2.1",
            "20.4.10",
            "26.1.2.126",
        ]
        .map(str::to_string);
        assert_eq!(
            pick_neoforge_version(&versions, "1.21.1", None).unwrap(),
            "21.1.77"
        );
        assert_eq!(
            pick_neoforge_version(&versions, "26.1", None).unwrap(),
            "26.1.2.126"
        );
        assert!(pick_neoforge_version(&versions, "1.20.1", None).is_err());
    }

    #[test]
    fn accepts_a_pinned_neoforge_version_even_if_unstable() {
        let versions = ["21.1.77".to_string(), "21.1.100-beta".to_string()];
        assert_eq!(
            pick_neoforge_version(&versions, "1.21.1", Some("21.1.100-beta")).unwrap(),
            "21.1.100-beta"
        );
        assert!(pick_neoforge_version(&versions, "1.21.1", Some("21.1.999")).is_err());
    }

    #[test]
    fn picks_newest_forge_for_the_minecraft_version() {
        let versions = [
            "1.20.1-47.2.0",
            "1.20.1-47.4.0",
            "1.20.2-48.1.0",
            "1.7.10-10.13.4.1614-1.7.10",
        ]
        .map(str::to_string);
        assert_eq!(
            pick_forge_version(&versions, "1.20.1", None).unwrap(),
            "1.20.1-47.4.0"
        );
        // Alte Artefakte hängen die Minecraft-Version noch einmal an.
        assert_eq!(
            forge_loader_version("1.7.10-10.13.4.1614-1.7.10"),
            "10.13.4.1614"
        );
        assert_eq!(
            pick_forge_version(&versions, "1.20.1", Some("47.2.0")).unwrap(),
            "1.20.1-47.2.0"
        );
        assert!(pick_forge_version(&versions, "1.19.2", None).is_err());
        assert!(pick_forge_version(&versions, "1.20.1", Some("47.9.9")).is_err());
    }

    #[test]
    fn parses_maven_metadata() {
        let xml = r#"<metadata><versioning><versions>
            <version>20.4.10</version>
            <version>21.1.77</version>
            <version>21.1.9</version>
        </versions></versioning></metadata>"#;
        let versions = parse_maven_versions(xml);
        assert_eq!(versions, vec!["20.4.10", "21.1.77", "21.1.9"]);
        assert!(parse_maven_versions("<metadata/>").is_empty());
    }

    #[test]
    fn parses_sha1_with_or_without_filename() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(parse_sha1(hash).as_deref(), Some(hash));
        assert_eq!(
            parse_sha1(&format!("{hash}  neoforge.jar")).as_deref(),
            Some(hash)
        );
        assert!(parse_sha1("zu-kurz").is_none());
    }

    #[test]
    fn prefers_stable_fabric_loader_and_accepts_pins() {
        let entries = vec![
            FabricEntry {
                loader: FabricLoaderInfo {
                    version: "0.17.0-beta.1".to_string(),
                    stable: false,
                },
            },
            FabricEntry {
                loader: FabricLoaderInfo {
                    version: "0.16.10".to_string(),
                    stable: true,
                },
            },
        ];
        assert_eq!(
            pick_fabric_loader(&entries, "1.20.1", None).unwrap(),
            "0.16.10"
        );
        assert_eq!(
            pick_fabric_loader(&entries, "1.20.1", Some("0.17.0-beta.1")).unwrap(),
            "0.17.0-beta.1"
        );
        assert!(pick_fabric_loader(&entries, "1.20.1", Some("9.9.9")).is_err());
        assert!(pick_fabric_loader(&[], "1.20.1", None).is_err());
    }

    #[test]
    fn picks_newest_stable_quilt_loader_regardless_of_response_order() {
        let entries = vec![
            QuiltEntry {
                loader: QuiltLoaderInfo {
                    version: "0.25.0-beta.1".to_string(),
                },
            },
            QuiltEntry {
                loader: QuiltLoaderInfo {
                    version: "0.23.1".to_string(),
                },
            },
            QuiltEntry {
                loader: QuiltLoaderInfo {
                    version: "0.24.0".to_string(),
                },
            },
            QuiltEntry {
                loader: QuiltLoaderInfo {
                    version: String::new(),
                },
            },
        ];
        assert_eq!(
            pick_quilt_loader(&entries, "1.20.1", None).unwrap(),
            "0.24.0"
        );
        assert_eq!(
            pick_quilt_loader(&entries, "1.20.1", Some("0.25.0-beta.1")).unwrap(),
            "0.25.0-beta.1"
        );
        assert!(pick_quilt_loader(&entries, "1.20.1", Some("9.9.9")).is_err());
        assert!(pick_quilt_loader(&[], "1.20.1", None).is_err());
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(validate_version_id("fabric-loader-0.16.10-1.20.1").is_ok());
        assert!(validate_version_id("../evil").is_err());
        assert!(validate_version_id("a/b").is_err());
        assert!(validate_minecraft_version("1.20.1").is_ok());
        assert!(validate_minecraft_version("1.20.1 & rm -rf").is_err());
    }

    #[test]
    fn encodes_only_what_a_path_segment_needs() {
        assert_eq!(encode_segment("1.20.1"), "1.20.1");
        assert_eq!(encode_segment("a b"), "a%20b");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
    }
}
