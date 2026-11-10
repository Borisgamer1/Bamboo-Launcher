//! Import von Modpacks: Modrinth (`.mrpack`) und CurseForge (`manifest.json`).
//!
//! Ein `.mrpack` ist ein ZIP mit `modrinth.index.json`, der eigentlichen
//! Download-Dateien und `overrides/`-Ordnern. Ein CurseForge-Pack ist ein ZIP
//! mit `manifest.json`, das nur Projekt- und Datei-IDs nennt; die Adressen
//! kommen aus der CurseForge-API. Beide Wege münden in denselben Ablauf: frische
//! Instanz anlegen, geforderten Loader installieren, Dateien mit Prüfsumme
//! laden und die Overrides entpacken.

pub mod curseforge;

use crate::download::{DownloadError, Downloader, FileSpec};
use crate::error::LauncherError;
use crate::install::{InstallEvent, InstallOptions, InstallReport, Installer};
use crate::instances::{validate_instance_name, Instance, InstanceManager};
use crate::java::{self, JavaRuntime};
use crate::loader::{self, LoaderError, LoaderInstaller};
use crate::mods::{
    CurseForgeClient, Loader, ModError, ModLedger, ModRecord, ModSource, PackFileRecord, PackRecord,
};
use crate::version;
use serde::Deserialize;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const INDEX_FILE: &str = "modrinth.index.json";
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
/// Obergrenze für entpackte Overrides – schützt vor ZIP-Bomben.
const MAX_OVERRIDE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const OVERRIDE_ROOTS: [&str; 2] = ["overrides/", "client-overrides/"];
/// Metadateien der Instanz dürfen von einem Pack nie überschrieben werden.
const RESERVED_META: [&str; 2] = ["instance.json", "bamboo-mods.json"];

#[derive(Debug, Error)]
pub enum ModpackError {
    #[error("Die Modpack-Datei {0} existiert nicht.")]
    ArchiveMissing(PathBuf),

    #[error("{0} ist kein lesbares Modpack: {1}")]
    InvalidArchive(PathBuf, String),

    #[error("Das Archiv enthält kein Modpack-Manifest (modrinth.index.json oder manifest.json).")]
    MissingIndex,

    #[error("Der Pack-Index ist ungültig: {0}")]
    InvalidIndex(String),

    #[error("Das CurseForge-Manifest ist ungültig: {0}")]
    InvalidManifest(String),

    #[error(
        "Für CurseForge-Modpacks wird ein CurseForge-API-Key benötigt. Trage ihn in den Einstellungen ein."
    )]
    MissingCurseForgeKey,

    #[error(
        "CurseForge konnte die Datei {file_id} von Projekt {project_id} nicht liefern: {message}"
    )]
    CurseForgeFile {
        project_id: u64,
        file_id: u64,
        message: String,
    },

    #[error("Das Pack-Format {0} wird nicht unterstützt (unterstützt wird Format 1).")]
    UnsupportedFormat(u32),

    #[error("Das Modpack ist für '{0}' gedacht, nicht für Minecraft.")]
    UnsupportedGame(String),

    #[error("Im Modpack fehlt die Minecraft-Version.")]
    MissingMinecraftVersion,

    #[error("Diese Overrides konnten nicht geschrieben werden: {0}")]
    OverridesIncomplete(String),

    #[error("Das Modpack verlangt mehrere Loader ({0}); das ist nicht eindeutig.")]
    MultipleLoaders(String),

    #[error(
        "Das Modpack verlangt {0}. Automatisch installierbar sind Fabric, Forge, NeoForge und Quilt."
    )]
    UnsupportedLoader(String),

    #[error("Der Pfad '{0}' im Modpack ist unsicher.")]
    UnsafePath(String),

    #[error("Die Datei '{0}' im Modpack hat keine Download-Adresse.")]
    MissingDownload(String),

    #[error("Der Pfad '{0}' kommt im Modpack mehrfach vor.")]
    DuplicatePath(String),

    #[error("Die Overrides des Modpacks überschreiten die Grenze von {0} Byte.")]
    OverridesTooLarge(u64),

    #[error("Für '{0}' gibt es zu viele gleichnamige Instanzen.")]
    InstanceNameExhausted(String),

    #[error(
        "Die Instanz '{0}' wurde nicht als Modpack installiert; für ein Pack-Update fehlen die Bestandsdaten des Imports."
    )]
    NotAModpack(String),

    #[error(transparent)]
    Download(#[from] DownloadError),

    #[error(transparent)]
    Install(#[from] crate::install::InstallError),

    #[error(transparent)]
    Loader(#[from] LoaderError),

    #[error(transparent)]
    Mod(#[from] ModError),

    #[error(transparent)]
    Launcher(#[from] LauncherError),

    #[error("I/O-Fehler: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON-Fehler: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ModpackError>;

// ---------------------------------------------------------------------------
// Pack-Format
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PackIndex {
    #[serde(rename = "formatVersion")]
    format_version: u32,
    game: String,
    #[serde(rename = "versionId")]
    version_id: String,
    name: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    files: Vec<PackFile>,
    #[serde(default)]
    dependencies: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PackFile {
    path: String,
    #[serde(default)]
    hashes: HashMap<String, String>,
    #[serde(default)]
    env: Option<PackEnv>,
    #[serde(default)]
    downloads: Vec<String>,
    #[serde(rename = "fileSize", default)]
    file_size: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct PackEnv {
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    server: Option<String>,
}

/// Ein Index-Eintrag, wie ihn die Oberfläche für die Inhaltsliste braucht.
/// Downloads bleiben drin, damit ein erneuter Start die Dateien zuordnen kann.
#[derive(Debug, Clone, Serialize)]
pub struct PackFileReport {
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub downloads: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub hashes: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

pub(crate) struct LoaderDependency {
    pub(crate) loader: Loader,
    pub(crate) version: String,
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ModpackImport {
    pub instance: Instance,
    pub pack_name: String,
    pub pack_version: String,
    pub summary: Option<String>,
    pub minecraft_version: String,
    pub loader: Option<Loader>,
    pub loader_version: Option<String>,
    /// Profil-ID, an die die Instanz gebunden ist (Loader-Profil oder Vanilla).
    pub version_id: String,
    /// Bericht der Basisinstallation, wenn die Minecraft-Version beim Import
    /// noch fehlte. `None`, wenn sie bereits installiert war.
    pub base_install: Option<InstallReport>,
    /// Vorhandenes Java, das die Basisinstallation genutzt hat. Dann wurde
    /// keine Mojang-Runtime heruntergeladen.
    pub system_java: Option<JavaRuntime>,
    /// Anzahl der geladenen Pack-Dateien.
    pub files: usize,
    /// Client-seitig als „unsupported“ markierte Dateien.
    pub skipped: usize,
    pub overrides: usize,
    /// Die Override-Pfade, die tatsächlich geschrieben wurden.
    pub override_files: Vec<String>,
    /// Der Pack-Index, damit die Oberfläche die Inhaltsliste füllen kann.
    pub index_files: Vec<PackFileReport>,
    pub downloaded_bytes: u64,
}

/// Ergebnis eines Pack-Updates. Die Zähler sagen genau, was passiert ist:
/// Unveränderte Dateien wurden nicht erneut geladen.
#[derive(Debug, Clone)]
pub struct ModpackUpdate {
    pub instance: Instance,
    pub pack_version: String,
    pub minecraft_version: String,
    pub loader: Option<Loader>,
    pub loader_version: Option<String>,
    /// Profil-ID, an die die Instanz nach dem Update gebunden ist.
    pub version_id: String,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub kept: usize,
    pub overrides: usize,
    pub downloaded_bytes: u64,
    /// Der Pack-Index, damit die Oberfläche die Inhaltsliste nach dem Update
    /// ohne einen zweiten Platten-Scan füllen kann.
    pub index_files: Vec<PackFileReport>,
    /// Override-Pfade, die das Update geschrieben hat.
    pub override_files: Vec<String>,
}

/// Was ein Update gegenüber dem letzten Import wirklich verändert.
#[derive(Default)]
struct PackDiff {
    /// Nur die Dateien, die tatsächlich geladen werden müssen.
    downloads: Vec<PackDownload>,
    added: usize,
    updated: usize,
    /// Pfade, die das neue Pack nicht mehr führt.
    removed: Vec<String>,
    /// Alte Dateien ersetzter Mods (gleiches Projekt, anderer Dateiname).
    stale: Vec<PathBuf>,
}

#[derive(Default)]
struct BaseInstall {
    report: Option<InstallReport>,
    system_java: Option<JavaRuntime>,
}

#[derive(Default)]
struct Populated {
    files: usize,
    skipped: usize,
    overrides: Vec<String>,
    bytes: u64,
}

/// Ein geprüfter Download aus dem Pack-Index. Das Ziel entsteht erst mit der
/// Instanz, deshalb wird der relative Pfad aufbewahrt.
struct PackDownload {
    relative: PathBuf,
    urls: Vec<String>,
    sha1: Option<String>,
    size: Option<u64>,
}

/// Ergebnis der Vorabprüfung: Alles, was vor dem ersten Download feststehen
/// kann, ist bereits validiert.
struct Prepared {
    downloads: Vec<PackDownload>,
    records: Vec<PackFileRecord>,
    mods: Vec<PendingModRecord>,
    skipped: usize,
}

/// Welches Manifest das Archiv enthält.
enum PackFormat {
    Modrinth(PackIndex),
    CurseForge(curseforge::Manifest),
}

/// Ein vollständig geprüfter Import, bevor irgendetwas geschrieben wird.
struct PackPlan {
    name: String,
    version: String,
    summary: Option<String>,
    minecraft: String,
    loader: Option<LoaderDependency>,
    downloads: Vec<PackDownload>,
    mods: Vec<PendingModRecord>,
    records: Vec<PackFileRecord>,
    skipped: usize,
    /// Ordnerwurzeln, aus denen Overrides entpackt werden.
    override_roots: Vec<String>,
    index_files: Vec<PackFileReport>,
}

/// Ein Mod, der nach dem Download in die Bestandsdatei gehört.
struct PendingModRecord {
    path: PathBuf,
    source: ModSource,
    project_id: String,
    version_id: String,
    version_number: String,
}

pub struct ModpackImporter {
    cache_dir: PathBuf,
    java_path: Option<PathBuf>,
    installer: Installer,
    install_progress: Option<Arc<dyn Fn(InstallEvent) + Send + Sync>>,
    curseforge_key: Option<String>,
    curseforge_api_base: Option<String>,
    curseforge_cdn_base: Option<String>,
}

impl ModpackImporter {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        let cache_dir = cache_dir.into();
        Self {
            installer: Installer::new(&cache_dir),
            cache_dir,
            java_path: None,
            install_progress: None,
            curseforge_key: None,
            curseforge_api_base: None,
            curseforge_cdn_base: None,
        }
    }

    pub fn with_java_path(mut self, java_path: Option<PathBuf>) -> Self {
        self.java_path = java_path;
        self
    }

    /// Ersetzt den Installer – Tests können so Mojang-Endpunkte mocken.
    pub fn with_installer(mut self, installer: Installer) -> Self {
        self.installer = installer;
        self
    }

    /// Meldet den Fortschritt der Basisinstallation (Libraries, Assets, Java).
    pub fn with_install_progress<F>(mut self, listener: F) -> Self
    where
        F: Fn(InstallEvent) + Send + Sync + 'static,
    {
        self.install_progress = Some(Arc::new(listener));
        self
    }

    /// API-Key für CurseForge-Packs. Ohne Key lehnt der Import ein solches
    /// Pack mit einer klaren Meldung ab, statt es halb zu installieren.
    pub fn with_curseforge_key(mut self, key: Option<String>) -> Self {
        self.curseforge_key = key.filter(|value| !value.trim().is_empty());
        self
    }

    /// Nur für Tests: API und CDN auf einen lokalen Server zeigen lassen.
    pub fn with_curseforge_base(mut self, base: impl Into<String>) -> Self {
        self.curseforge_api_base = Some(base.into());
        self
    }

    pub fn with_curseforge_cdn(mut self, base: impl Into<String>) -> Self {
        self.curseforge_cdn_base = Some(base.into());
        self
    }

    /// Importiert ein Modpack als neue Instanz – `.mrpack` oder
    /// CurseForge-ZIP. Schlägt nach dem Anlegen der Instanz etwas fehl, wird
    /// sie wieder entfernt; ein halber Import bleibt nicht liegen.
    pub async fn import(
        &self,
        game_root: &Path,
        archive_path: &Path,
        requested_name: Option<&str>,
    ) -> Result<ModpackImport> {
        if !archive_path.is_file() {
            return Err(ModpackError::ArchiveMissing(archive_path.to_path_buf()));
        }

        let format = self.read_manifest(archive_path.to_path_buf()).await?;
        let roots = match &format {
            PackFormat::Modrinth(_) => override_roots(None),
            PackFormat::CurseForge(manifest) => override_roots(manifest.overrides.as_deref()),
        };
        // Vor dem ersten Download: Ein unsicheres Pack darf weder die API noch
        // die Basisinstallation beschäftigen.
        validate_overrides(archive_path.to_path_buf(), roots.clone()).await?;

        let plan = match format {
            PackFormat::Modrinth(index) => self.plan_modrinth(index, roots)?,
            PackFormat::CurseForge(manifest) => self.plan_curseforge(manifest, roots).await?,
        };
        self.finish_import(game_root, archive_path, requested_name, plan)
            .await
    }

    /// Aktualisiert eine bestehende Pack-Instanz aus einem neuen Archiv –
    /// `.mrpack` oder CurseForge-ZIP.
    ///
    /// Geladen wird nur, was sich geändert hat: Dateien mit derselben Projekt-
    /// und Datei-ID (CurseForge) bzw. derselben Prüfsumme (Modrinth) bleiben
    /// liegen. Ein unverändertes Pack braucht deshalb weder API-Aufrufe noch
    /// einen erneuten Loader-Lauf. Vom Pack entfernte Dateien werden gelöscht,
    /// selbst verwaltete Mods der Instanz bleiben unberührt.
    pub async fn update(
        &self,
        game_root: &Path,
        archive_path: &Path,
        instance_name: &str,
    ) -> Result<ModpackUpdate> {
        if !archive_path.is_file() {
            return Err(ModpackError::ArchiveMissing(archive_path.to_path_buf()));
        }
        let manager = InstanceManager::new(game_root.join("instances"));
        let instance = manager.load(instance_name)?;
        let mut ledger = ModLedger::load(&instance.dir)?;
        let Some(previous) = ledger.pack.clone() else {
            return Err(ModpackError::NotAModpack(instance_name.trim().to_string()));
        };

        let format = self.read_manifest(archive_path.to_path_buf()).await?;
        let roots = match &format {
            PackFormat::Modrinth(_) => override_roots(None),
            PackFormat::CurseForge(manifest) => override_roots(manifest.overrides.as_deref()),
        };
        // Wie beim Import: ein unsicheres Pack beschäftigt weder API noch Loader.
        validate_overrides(archive_path.to_path_buf(), roots.clone()).await?;

        let plan = match format {
            PackFormat::Modrinth(index) => self.plan_modrinth(index, roots)?,
            PackFormat::CurseForge(manifest) => {
                self.plan_curseforge_update(manifest, roots, &previous, &ledger, &instance.dir)
                    .await?
            }
        };

        // Auch ein Update braucht eine startbare Basis – vorhandene Versionen
        // werden dabei nicht erneut geprüft.
        self.ensure_base_version(game_root, &plan.minecraft).await?;
        let version_id = self.bind_version(game_root, &instance, &plan).await?;

        let diff = diff_pack(&plan, &previous, &ledger, &instance.dir);
        let download = fetch_files(download_specs(&diff.downloads, &instance.dir)).await?;

        // Overrides sind auch bei kleinen Updates dabei: sie enthalten die
        // Konfiguration, die zur neuen Pack-Version gehört.
        let override_files = extract_overrides(
            archive_path.to_path_buf(),
            instance.dir.clone(),
            plan.override_roots.clone(),
        )
        .await?;

        // Erst nach erfolgreichen Downloads aufräumen: Bricht das Update vorher
        // ab, bleibt die bisherige Installation vollständig benutzbar.
        for path in diff.stale {
            remove_file_if_present(&path)?;
            remove_file_if_present(&disabled_path(&path))?;
        }
        for path in &diff.removed {
            let Some(relative) = safe_relative(path) else {
                continue;
            };
            let target = instance.dir.join(&relative);
            remove_file_if_present(&target)?;
            remove_file_if_present(&disabled_path(&target))?;
        }
        // Eine deaktivierte Altversion einer aktualisierten Mod darf nicht
        // neben der neuen JAR liegen bleiben.
        for download in &diff.downloads {
            let target = instance.dir.join(&download.relative);
            remove_file_if_present(&disabled_path(&target))?;
        }

        let installed_at = now_secs();
        // Nur Dateien, die das Pack selbst gelegt hat, verlassen den Bestand.
        for path in &diff.removed {
            if let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) {
                ledger.mods.retain(|record| record.file_name != name);
            }
        }
        for pending in &plan.mods {
            let Some(name) = pending.path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            ledger.upsert(ModRecord {
                file_name: name.to_string(),
                source: pending.source,
                project_id: pending.project_id.clone(),
                version_id: pending.version_id.clone(),
                version_number: pending.version_number.clone(),
                installed_at,
                required_by: vec![plan.name.clone()],
            });
        }
        ledger.pack = Some(PackRecord {
            name: plan.name.clone(),
            version_id: plan.version.clone(),
            source: archive_name(archive_path),
            imported_at: installed_at,
            files: plan.records.clone(),
        });
        ledger.save(&instance.dir)?;

        let rebind = instance.version_id.as_deref() != Some(version_id.as_str());
        let instance = if rebind {
            manager.set_version(instance_name, &version_id)?
        } else {
            instance
        };

        Ok(ModpackUpdate {
            instance,
            pack_version: plan.version.clone(),
            minecraft_version: plan.minecraft.clone(),
            loader: plan.loader.as_ref().map(|dependency| dependency.loader),
            loader_version: plan
                .loader
                .as_ref()
                .map(|dependency| dependency.version.clone()),
            version_id: version_id.clone(),
            added: diff.added,
            updated: diff.updated,
            removed: diff.removed.len(),
            // Alles, was im Plan steht und nicht geladen werden musste.
            kept: plan.records.len().saturating_sub(diff.downloads.len()),
            overrides: override_files.len(),
            downloaded_bytes: download.bytes,
            index_files: plan.index_files.clone(),
            override_files,
        })
    }

    /// Bindet die Instanz an das vom Pack verlangte Profil. Liegt genau dieses
    /// Profil schon, entfällt der Loader-Installer – bei Forge und NeoForge
    /// wäre das sonst ein vollständiger Java-Lauf pro Update.
    async fn bind_version(
        &self,
        game_root: &Path,
        instance: &Instance,
        plan: &PackPlan,
    ) -> Result<String> {
        let Some(dependency) = &plan.loader else {
            return Ok(plan.minecraft.clone());
        };
        if let Some(current) = instance.version_id.as_deref() {
            let installed = loader::installed_loader(game_root, current)?;
            if installed.is_some_and(|profile| {
                profile.loader == dependency.loader
                    && profile.loader_version == dependency.version
                    && profile.minecraft_version == plan.minecraft
            }) {
                return Ok(current.to_string());
            }
        }
        let installed = LoaderInstaller::new(&self.cache_dir)
            .with_java_path(self.java_path.clone())
            .install(
                game_root,
                &plan.minecraft,
                dependency.loader,
                Some(&dependency.version),
            )
            .await?;
        Ok(installed.version_id)
    }

    /// Liest das Manifest aus dem Archiv. Ein CurseForge-Pack enthält nie eine
    /// `modrinth.index.json`, deshalb ist die Reihenfolge eindeutig.
    async fn read_manifest(&self, archive_path: PathBuf) -> Result<PackFormat> {
        let path = archive_path.clone();
        tokio::task::spawn_blocking(move || read_manifest_blocking(&archive_path))
            .await
            .map_err(|error| ModpackError::InvalidArchive(path, error.to_string()))?
    }

    /// Alles, was ein `.mrpack` ohne Netz hergibt.
    fn plan_modrinth(&self, index: PackIndex, roots: Vec<String>) -> Result<PackPlan> {
        if index.format_version != 1 {
            return Err(ModpackError::UnsupportedFormat(index.format_version));
        }
        if !index.game.trim().eq_ignore_ascii_case("minecraft") {
            return Err(ModpackError::UnsupportedGame(index.game.clone()));
        }
        let minecraft = index
            .dependencies
            .get("minecraft")
            .map(|version| version.trim().to_string())
            .filter(|version| !version.is_empty())
            .ok_or(ModpackError::MissingMinecraftVersion)?;
        let loader = loader_dependency(&index.dependencies)?;
        // Erst prüfen, dann laden: Ein fehlerhaftes Pack darf keine Hunderte
        // Megabyte Basisinstallation auslösen, bevor es abgelehnt wird.
        let prepared = prepare_files(&index)?;
        let index_files = index
            .files
            .iter()
            .map(|file| PackFileReport {
                path: file.path.clone(),
                downloads: file.downloads.clone(),
                hashes: file.hashes.clone(),
                env: file.env.as_ref().map(|env| {
                    let mut map = HashMap::new();
                    if let Some(client) = &env.client {
                        map.insert("client".to_string(), client.clone());
                    }
                    if let Some(server) = &env.server {
                        map.insert("server".to_string(), server.clone());
                    }
                    map
                }),
            })
            .collect();
        Ok(PackPlan {
            name: index.name,
            version: index.version_id,
            summary: index.summary,
            minecraft,
            loader,
            downloads: prepared.downloads,
            mods: prepared.mods,
            records: prepared.records,
            skipped: prepared.skipped,
            override_roots: roots,
            index_files,
        })
    }

    /// Ein CurseForge-Pack nennt nur IDs; jede Datei wird einzeln über die API
    /// aufgelöst. Ohne Key wird abgebrochen, bevor irgendetwas geschrieben wird.
    async fn plan_curseforge(
        &self,
        manifest: curseforge::Manifest,
        roots: Vec<String>,
    ) -> Result<PackPlan> {
        let minecraft = manifest.minecraft.version.trim().to_string();
        let loader = curseforge::detect_loader(&manifest.minecraft.mod_loaders, &minecraft)?;
        let client = self.curseforge_client()?;

        let resolved = curseforge::resolve(&client, &manifest.files).await?;
        let mut entries = CurseForgeEntries::default();
        let mut seen = HashSet::new();
        for file in resolved {
            let path = path_string(&file.relative);
            if !seen.insert(path.clone()) {
                return Err(ModpackError::DuplicatePath(path));
            }
            entries.push(file);
        }

        Ok(PackPlan {
            name: manifest.name,
            version: manifest.version,
            summary: None,
            minecraft,
            loader,
            downloads: entries.downloads,
            mods: entries.mods,
            records: entries.records,
            skipped: 0,
            override_roots: roots,
            index_files: entries.index_files,
        })
    }

    /// Client für die CurseForge-API. Der Key wird erst verlangt, wenn wirklich
    /// eine Datei aufgelöst werden muss – ein Update ohne Änderungen läuft so
    /// auch ohne Key.
    fn curseforge_client(&self) -> Result<CurseForgeClient> {
        let Some(key) = self.curseforge_key.clone() else {
            return Err(ModpackError::MissingCurseForgeKey);
        };
        let mut client = match &self.curseforge_api_base {
            Some(base) => CurseForgeClient::with_base(Some(key), base.clone())?,
            None => CurseForgeClient::new(Some(key))?,
        };
        if let Some(cdn) = &self.curseforge_cdn_base {
            client = client.with_cdn_base(cdn.clone());
        }
        Ok(client)
    }

    /// Update-Plan für ein CurseForge-Pack. Einträge, deren Projekt- und
    /// Datei-ID schon im Bestand stehen und deren Datei noch unverändert auf
    /// der Platte liegt, werden aus dem Bestand übernommen – ohne einen
    /// einzigen API-Aufruf. Nur neue, geänderte, beschädigte oder fehlende
    /// Dateien werden aufgelöst.
    async fn plan_curseforge_update(
        &self,
        manifest: curseforge::Manifest,
        roots: Vec<String>,
        previous: &PackRecord,
        ledger: &ModLedger,
        instance_dir: &Path,
    ) -> Result<PackPlan> {
        let minecraft = manifest.minecraft.version.trim().to_string();
        let loader = curseforge::detect_loader(&manifest.minecraft.mod_loaders, &minecraft)?;
        // Dateien, die der letzte Import gelegt hat – nur die gehören dem Pack.
        let owned: HashSet<&str> = previous
            .files
            .iter()
            .filter_map(|file| file.path.strip_prefix("mods/"))
            .collect();

        let mut resolved_files = Vec::with_capacity(manifest.files.len());
        let mut downloads = Vec::new();
        let mut mods = Vec::new();
        let mut records = Vec::new();
        let mut index_files = Vec::new();
        let mut seen = HashSet::new();

        for file in &manifest.files {
            let project_id = file.project_id.to_string();
            let version_id = file.file_id.to_string();
            let known = ledger.mods.iter().find(|record| {
                record.source == ModSource::CurseForge
                    && record.project_id == project_id
                    && record.version_id == version_id
                    && owned.contains(record.file_name.as_str())
            });
            let present =
                known.is_some_and(|record| kept_file_is_intact(previous, record, instance_dir));
            let Some(record) = known.filter(|_| present) else {
                resolved_files.push(curseforge::FileRef {
                    project_id: file.project_id,
                    file_id: file.file_id,
                });
                continue;
            };

            let path = format!("mods/{}", record.file_name);
            if !seen.insert(path.clone()) {
                return Err(ModpackError::DuplicatePath(path));
            }
            let file_record = previous
                .files
                .iter()
                .find(|file| file.path == path)
                .cloned()
                .unwrap_or(PackFileRecord {
                    path: path.clone(),
                    sha1: None,
                    size: None,
                });
            index_files.push(PackFileReport {
                path: path.clone(),
                // Die Datei liegt schon; die Oberfläche braucht keine Adresse.
                downloads: Vec::new(),
                hashes: file_record
                    .sha1
                    .clone()
                    .map(|sha1| HashMap::from([("sha1".to_string(), sha1)]))
                    .unwrap_or_default(),
                env: None,
            });
            records.push(file_record);
            mods.push(PendingModRecord {
                path: PathBuf::from(&path),
                source: ModSource::CurseForge,
                project_id: record.project_id.clone(),
                version_id: record.version_id.clone(),
                version_number: record.version_number.clone(),
            });
        }

        if !resolved_files.is_empty() {
            let client = self.curseforge_client()?;
            let resolved = curseforge::resolve(&client, &resolved_files).await?;
            let mut entries = CurseForgeEntries::default();
            for file in resolved {
                let path = path_string(&file.relative);
                if !seen.insert(path.clone()) {
                    return Err(ModpackError::DuplicatePath(path));
                }
                entries.push(file);
            }
            downloads.extend(entries.downloads);
            mods.extend(entries.mods);
            records.extend(entries.records);
            index_files.extend(entries.index_files);
        }

        Ok(PackPlan {
            name: manifest.name,
            version: manifest.version,
            summary: None,
            minecraft,
            loader,
            downloads,
            mods,
            records,
            skipped: 0,
            override_roots: roots,
            index_files,
        })
    }

    /// Gemeinsamer Ablauf beider Formate. Die Reihenfolge ist bewusst: erst
    /// validieren, dann Basisversion und Loader installieren, dann die Instanz
    /// anlegen. Ein Pack, das hier scheitert, hinterlässt keine halbe Instanz.
    async fn finish_import(
        &self,
        game_root: &Path,
        archive_path: &Path,
        requested_name: Option<&str>,
        plan: PackPlan,
    ) -> Result<ModpackImport> {
        // Eine frische Installation soll ohne Vorarbeit startbar sein: Fehlt die
        // Basisversion, werden Client, Libraries und Assets mitinstalliert. Eine
        // Mojang-Java-Runtime kommt nur dazu, wenn kein passendes Java gefunden wird.
        let base_install = self.ensure_base_version(game_root, &plan.minecraft).await?;

        let mut loader_install = None;
        let mut version_id = plan.minecraft.clone();
        if let Some(dependency) = &plan.loader {
            let installed = LoaderInstaller::new(&self.cache_dir)
                .with_java_path(self.java_path.clone())
                .install(
                    game_root,
                    &plan.minecraft,
                    dependency.loader,
                    Some(&dependency.version),
                )
                .await?;
            version_id = installed.version_id.clone();
            loader_install = Some(installed);
        }

        let manager = InstanceManager::new(game_root.join("instances"));
        let name = match requested_name {
            Some(name) => name.trim().to_string(),
            None => unique_instance_name(&manager, &sanitize_name(&plan.name))?,
        };
        let instance = manager.create(&name, Some(&version_id))?;

        match self.populate(&instance, &plan, archive_path).await {
            Ok(populated) => {
                let override_files = populated.overrides;
                Ok(ModpackImport {
                    instance,
                    pack_name: plan.name,
                    pack_version: plan.version,
                    summary: plan.summary,
                    minecraft_version: plan.minecraft,
                    loader: loader_install.as_ref().map(|install| install.loader),
                    loader_version: loader_install
                        .as_ref()
                        .map(|install| install.loader_version.clone()),
                    version_id,
                    base_install: base_install.report,
                    system_java: base_install.system_java,
                    files: populated.files,
                    skipped: populated.skipped,
                    overrides: override_files.len(),
                    override_files,
                    index_files: plan.index_files,
                    downloaded_bytes: populated.bytes,
                })
            }
            Err(error) => {
                let _ = manager.remove(&instance.name);
                Err(error)
            }
        }
    }

    /// Installiert die Basisversion nur, wenn ihr Versions-JSON fehlt. Eine
    /// vorhandene Installation wird nicht erneut geprüft – das ist Aufgabe von
    /// `install` und würde bei jedem Import alle Assets hashen.
    ///
    /// Vor dem Download wird die Java-Anforderung aus den Versionsdaten gelesen.
    /// Ist bereits ein passendes Java startbar – System-Java oder ein explizit
    /// gesetzter Pfad –, wird nur die Mojang-Runtime übersprungen, nicht die
    /// übrige Basisinstallation.
    async fn ensure_base_version(&self, game_root: &Path, version_id: &str) -> Result<BaseInstall> {
        if version::version_json_path(game_root, version_id).is_file() {
            return Ok(BaseInstall::default());
        }

        let resolved = self
            .installer
            .ensure_version_metadata(game_root, version_id)
            .await?;
        let system_java =
            java::find_java_in(game_root, self.java_path.as_deref(), resolved.java_major)
                .await
                .ok();
        let options = InstallOptions {
            java: system_java.is_none(),
            ..InstallOptions::default()
        };

        let listener = self.install_progress.clone();
        let mut report = self
            .installer
            .install_version(game_root, version_id, &options, move |event| {
                if let Some(listener) = &listener {
                    listener(event);
                }
            })
            .await?;
        // Das Versions-JSON wurde oben bereits geladen; für den Aufrufer gehört
        // es dennoch zu dieser Basisinstallation.
        report.version_json_downloaded = true;

        Ok(BaseInstall {
            report: Some(report),
            system_java,
        })
    }

    async fn populate(
        &self,
        instance: &Instance,
        plan: &PackPlan,
        archive_path: &Path,
    ) -> Result<Populated> {
        // Ein einzelner Netzwerkfehler darf einen 300-Mod-Pack nicht verwerfen.
        // Der zweite Durchlauf lädt nur, was noch fehlt: `download_all` prüft
        // Größe und SHA-1 und überspringt vollständige Dateien.
        let download = fetch_files(download_specs(&plan.downloads, &instance.dir)).await?;
        let overrides = extract_overrides(
            archive_path.to_path_buf(),
            instance.dir.clone(),
            plan.override_roots.clone(),
        )
        .await?;
        write_ledger(
            instance,
            &plan.name,
            &plan.version,
            archive_path,
            &plan.mods,
            &plan.records,
        )?;

        Ok(Populated {
            files: download.files,
            skipped: plan.skipped,
            overrides,
            bytes: download.bytes,
        })
    }
}

/// Lädt die angegebenen Dateien; erst mit voller Parallelität, bei einem
/// Fehler noch einmal nacheinander. Der zweite Lauf überspringt alles, was
/// schon vollständig auf der Platte liegt.
async fn fetch_files(specs: Vec<FileSpec>) -> Result<crate::download::DownloadReport> {
    let fallback = specs.clone();
    match Downloader::new().download_all(specs, |_| {}).await {
        Ok(report) => Ok(report),
        Err(first) => Downloader::new()
            .with_concurrency(1)
            .download_all(fallback, |_| {})
            .await
            .map_err(|_| first)
            .map_err(ModpackError::from),
    }
}

/// Die Download-Spezifikationen für Pack-Dateien. Import und Update teilen
/// diesen Weg, damit Prüfsumme und Größe nie nur an einer Stelle gesetzt werden.
fn download_specs(downloads: &[PackDownload], instance_dir: &Path) -> Vec<FileSpec> {
    downloads
        .iter()
        .map(|download| {
            let mut spec = FileSpec::new(
                instance_dir.join(&download.relative),
                download.urls[0].clone(),
            );
            spec.urls = download.urls.clone();
            if let Some(sha1) = &download.sha1 {
                spec = spec.with_sha1(sha1.clone());
            }
            if let Some(size) = download.size {
                spec = spec.with_size(size);
            }
            spec
        })
        .collect()
}

/// Alle Sichten, die aus einer aufgelösten CurseForge-Datei entstehen. Import
/// und Update bauen ihre Pläne damit auf demselben Code.
#[derive(Default)]
struct CurseForgeEntries {
    downloads: Vec<PackDownload>,
    mods: Vec<PendingModRecord>,
    records: Vec<PackFileRecord>,
    index_files: Vec<PackFileReport>,
}

impl CurseForgeEntries {
    fn push(&mut self, file: curseforge::ResolvedFile) {
        let path = path_string(&file.relative);
        self.index_files.push(PackFileReport {
            path: path.clone(),
            downloads: vec![file.url.clone()],
            hashes: file
                .sha1
                .clone()
                .map(|sha1| HashMap::from([("sha1".to_string(), sha1)]))
                .unwrap_or_default(),
            env: None,
        });
        self.records.push(PackFileRecord {
            path,
            sha1: file.sha1.clone(),
            size: file.size,
        });
        self.mods.push(PendingModRecord {
            path: file.relative.clone(),
            source: ModSource::CurseForge,
            project_id: file.project_id,
            version_id: file.file_id,
            version_number: file.version_number,
        });
        self.downloads.push(PackDownload {
            relative: file.relative,
            urls: vec![file.url],
            sha1: file.sha1,
            size: file.size,
        });
    }
}

/// Eine vom Pack gelegte Datei bleibt nur liegen, wenn sie noch unverändert
/// ist. Eine bewusst deaktivierte Mod wird respektiert; eine beschädigte oder
/// ersetzte JAR wird dagegen neu geladen, obwohl die Datei existiert.
fn kept_file_is_intact(previous: &PackRecord, record: &ModRecord, instance_dir: &Path) -> bool {
    let target = instance_dir.join("mods").join(&record.file_name);
    if disabled_path(&target).is_file() {
        return true;
    }
    if !target.is_file() {
        return false;
    }
    let path = format!("mods/{}", record.file_name);
    let expected = previous
        .files
        .iter()
        .find(|file| file.path == path)
        .and_then(|file| file.sha1.as_deref());
    match expected {
        Some(expected) => {
            file_sha1(&target).is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
        }
        // Ältere Bestandsdateien tragen keine Prüfsumme; dann ist die Existenz
        // das Beste, was sich ohne Netz prüfen lässt.
        None => true,
    }
}

/// SHA-1 einer Datei, gestreamt – eine 300-Mod-Instanz soll nicht komplett in
/// den Speicher wandern, nur um eine Prüfsumme zu bestätigen.
fn file_sha1(path: &Path) -> Option<String> {
    use sha1::{Digest, Sha1};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let bytes: &[u8] = digest.as_ref();
    let mut hash = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hash.push_str(&format!("{byte:02x}"));
    }
    Some(hash)
}

/// Vergleicht den neuen Plan mit dem letzten Import: Was gleich bleibt, wird
/// nicht geladen; was das Pack nicht mehr führt, wird entfernt.
fn diff_pack(
    plan: &PackPlan,
    previous: &PackRecord,
    ledger: &ModLedger,
    instance_dir: &Path,
) -> PackDiff {
    let mut diff = PackDiff::default();
    let planned: HashSet<&str> = plan
        .records
        .iter()
        .map(|record| record.path.as_str())
        .collect();

    // Ein Mod, dessen Datei einen neuen Namen bekommen hat, ist kein "entfernt"
    // und kein "neu", sondern ein Update.
    let mut replaced_names: HashSet<String> = HashSet::new();
    for pending in &plan.mods {
        let Some(record) = ledger.mods.iter().find(|record| {
            record.project_id == pending.project_id && record.source == pending.source
        }) else {
            continue;
        };
        let Some(name) = pending.path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if record.file_name != name {
            replaced_names.insert(record.file_name.clone());
            let old = instance_dir.join("mods").join(&record.file_name);
            diff.stale.push(old.clone());
            diff.stale.push(disabled_path(&old));
        }
    }

    for download in &plan.downloads {
        let path = path_string(&download.relative);
        let target = instance_dir.join(&download.relative);
        let on_disk = if target.is_file() {
            Some(target.clone())
        } else {
            let disabled = disabled_path(&target);
            disabled.is_file().then_some(disabled)
        };
        let unchanged = previous
            .files
            .iter()
            .find(|file| file.path == path)
            .and_then(|file| file.sha1.as_deref())
            .zip(download.sha1.as_deref())
            .is_some_and(|(old, new)| old.eq_ignore_ascii_case(new));
        // Die Plan-Prüfsumme allein sagt nichts über die Platte. Ohne diesen
        // Abgleich gälte eine beschädigte JAR ewig als unverändert.
        let intact = match download.sha1.as_deref() {
            Some(expected) => on_disk
                .as_deref()
                .and_then(file_sha1)
                .is_some_and(|actual| actual.eq_ignore_ascii_case(expected)),
            None => on_disk.is_some(),
        };
        if unchanged && intact {
            continue;
        }
        let known = plan
            .mods
            .iter()
            .find(|pending| pending.path == download.relative)
            .and_then(|pending| {
                ledger.mods.iter().find(|record| {
                    record.project_id == pending.project_id && record.source == pending.source
                })
            })
            .is_some()
            || previous.files.iter().any(|file| file.path == path);
        if known {
            diff.updated += 1;
        } else {
            diff.added += 1;
        }
        diff.downloads.push(PackDownload {
            relative: download.relative.clone(),
            urls: download.urls.clone(),
            sha1: download.sha1.clone(),
            size: download.size,
        });
    }

    for file in &previous.files {
        if planned.contains(file.path.as_str()) {
            continue;
        }
        let replaced = Path::new(&file.path)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| replaced_names.contains(name));
        if !replaced {
            diff.removed.push(file.path.clone());
        }
    }
    diff
}

/// `<datei>.jar` → `<datei>.jar.disabled`, wie es die Inhaltsliste anlegt.
fn disabled_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".disabled");
    path.with_file_name(name)
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn archive_name(archive_path: &Path) -> String {
    archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("modpack.mrpack")
        .to_string()
}

/// Prüft alle Dateien des Index, bevor irgendetwas heruntergeladen wird.
fn prepare_files(index: &PackIndex) -> Result<Prepared> {
    let mut downloads = Vec::new();
    let mut records = Vec::new();
    let mut mods = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped = 0usize;

    for file in &index.files {
        if file
            .env
            .as_ref()
            .and_then(|env| env.client.as_deref())
            .is_some_and(|client| client.eq_ignore_ascii_case("unsupported"))
        {
            skipped += 1;
            continue;
        }

        let relative =
            safe_relative(&file.path).ok_or_else(|| ModpackError::UnsafePath(file.path.clone()))?;
        if is_reserved(&relative) {
            return Err(ModpackError::UnsafePath(file.path.clone()));
        }
        if !seen.insert(relative.clone()) {
            return Err(ModpackError::DuplicatePath(file.path.clone()));
        }
        let urls: Vec<String> = file
            .downloads
            .iter()
            .filter(|url| !url.trim().is_empty())
            .cloned()
            .collect();
        let Some(url) = urls.first().cloned() else {
            return Err(ModpackError::MissingDownload(file.path.clone()));
        };

        let sha1 = file
            .hashes
            .get("sha1")
            .map(|hash| hash.to_ascii_lowercase());
        records.push(PackFileRecord {
            path: path_string(&relative),
            sha1: sha1.clone(),
            size: file.file_size,
        });
        // Modrinth-CDN-Links enthalten Projekt- und Versions-ID. Damit kennt die
        // Bestandsdatei auch Pack-Mods und ein späteres `mods install` erkennt
        // sie als bereits vorhanden.
        if relative.parent() == Some(Path::new("mods")) {
            if let Some((project_id, version_id)) = modrinth_ids(&url) {
                mods.push(PendingModRecord {
                    path: relative.clone(),
                    source: ModSource::Modrinth,
                    project_id,
                    version_id: version_id.clone(),
                    version_number: version_id,
                });
            }
        }
        downloads.push(PackDownload {
            relative,
            urls,
            sha1,
            size: file.file_size,
        });
    }

    Ok(Prepared {
        downloads,
        records,
        mods,
        skipped,
    })
}

fn write_ledger(
    instance: &Instance,
    pack_name: &str,
    pack_version: &str,
    archive_path: &Path,
    mods: &[PendingModRecord],
    records: &[PackFileRecord],
) -> Result<()> {
    let installed_at = now_secs();
    let mut ledger = ModLedger::load(&instance.dir)?;

    for pending in mods {
        if pending.path.parent() != Some(Path::new("mods")) {
            continue;
        }
        let Some(file_name) = pending.path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        ledger.upsert(ModRecord {
            file_name: file_name.to_string(),
            source: pending.source,
            project_id: pending.project_id.clone(),
            version_id: pending.version_id.clone(),
            version_number: pending.version_number.clone(),
            installed_at,
            required_by: vec![pack_name.to_string()],
        });
    }

    ledger.pack = Some(PackRecord {
        name: pack_name.to_string(),
        version_id: pack_version.to_string(),
        source: archive_name(archive_path),
        imported_at: installed_at,
        files: records.to_vec(),
    });
    ledger.save(&instance.dir)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Archiv lesen
// ---------------------------------------------------------------------------

fn read_manifest_blocking(archive_path: &Path) -> Result<PackFormat> {
    let file = open_archive(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
    })?;

    if let Some(text) = read_zip_text(&mut archive, archive_path, INDEX_FILE)? {
        let index = serde_json::from_str(&text)
            .map_err(|error| ModpackError::InvalidIndex(error.to_string()))?;
        return Ok(PackFormat::Modrinth(index));
    }
    if let Some(text) = read_zip_text(&mut archive, archive_path, curseforge::MANIFEST_FILE)? {
        let Some(manifest) = curseforge::Manifest::parse(&text) else {
            return Err(ModpackError::MissingIndex);
        };
        return Ok(PackFormat::CurseForge(manifest?.validate()?));
    }
    Err(ModpackError::MissingIndex)
}

fn open_archive(archive_path: &Path) -> Result<std::fs::File> {
    std::fs::File::open(archive_path).map_err(|error| {
        ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
    })
}

/// Liest einen Text-Eintrag aus dem ZIP, begrenzt auf die Indexgröße.
/// `None` heißt: Es gibt keinen Eintrag mit diesem Namen.
fn read_zip_text(
    archive: &mut zip::ZipArchive<std::fs::File>,
    archive_path: &Path,
    name: &str,
) -> Result<Option<String>> {
    let Ok(entry) = archive.by_name(name) else {
        return Ok(None);
    };
    let too_large = || {
        ModpackError::InvalidArchive(archive_path.to_path_buf(), format!("'{name}' ist zu groß."))
    };
    if entry.size() > MAX_INDEX_BYTES {
        return Err(too_large());
    }
    let mut text = String::new();
    entry
        .take(MAX_INDEX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| {
            ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
        })?;
    if text.len() as u64 > MAX_INDEX_BYTES {
        return Err(too_large());
    }
    Ok(Some(text))
}

/// Erlaubte Override-Wurzeln. CurseForge-Packs dürfen den Ordnernamen im
/// Manifest selbst bestimmen; die Standardnamen gelten immer.
fn override_roots(custom: Option<&str>) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    if let Some(name) = custom {
        let name = name.trim().trim_matches('/');
        if !name.is_empty() && !name.contains("..") {
            roots.push(format!("{name}/"));
        }
    }
    for root in OVERRIDE_ROOTS {
        if !roots.iter().any(|value| value == root) {
            roots.push(root.to_string());
        }
    }
    roots
}

/// Prüft die Override-Einträge im Archiv, ohne etwas zu schreiben. So scheitert
/// ein unsicheres Pack, bevor die Basisversion installiert wird.
async fn validate_overrides(archive_path: PathBuf, roots: Vec<String>) -> Result<()> {
    let path = archive_path.clone();
    tokio::task::spawn_blocking(move || validate_overrides_blocking(&archive_path, &roots))
        .await
        .map_err(|error| ModpackError::InvalidArchive(path, error.to_string()))?
}

fn validate_overrides_blocking(archive_path: &Path, roots: &[String]) -> Result<()> {
    let file = open_archive(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
    })?;

    let mut declared_total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|error| {
                ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
            })?
            .replace('\\', "/");
        let Some(stripped) = roots.iter().find_map(|root| name.strip_prefix(root)) else {
            continue;
        };
        let relative =
            safe_relative(stripped).ok_or_else(|| ModpackError::UnsafePath(name.clone()))?;
        if is_reserved(&relative) {
            return Err(ModpackError::UnsafePath(name));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_OVERRIDE_BYTES {
            return Err(ModpackError::OverridesTooLarge(MAX_OVERRIDE_BYTES));
        }
    }
    Ok(())
}

async fn extract_overrides(
    archive_path: PathBuf,
    destination: PathBuf,
    roots: Vec<String>,
) -> Result<Vec<String>> {
    let path = archive_path.clone();
    tokio::task::spawn_blocking(move || {
        extract_overrides_blocking(&archive_path, &destination, &roots)
    })
    .await
    .map_err(|error| ModpackError::InvalidArchive(path, error.to_string()))?
}

fn extract_overrides_blocking(
    archive_path: &Path,
    destination: &Path,
    roots: &[String],
) -> Result<Vec<String>> {
    let extracted = extract_override_pass(archive_path, destination, roots, None)?;
    let missing: Vec<String> = extracted
        .iter()
        .filter(|name| !override_written(destination, name, roots))
        .cloned()
        .collect();
    if missing.is_empty() {
        return Ok(extracted);
    }

    // Zweiter Durchlauf nur für die Dateien, die nicht auf der Platte landeten.
    // Ohne ihn bliebe ein Pack mit fehlenden FancyMenu- oder Drippy-Konfigurationen
    // scheinbar erfolgreich installiert.
    let wanted: HashSet<String> = missing.iter().cloned().collect();
    extract_override_pass(archive_path, destination, roots, Some(&wanted))?;

    let still_missing: Vec<String> = missing
        .into_iter()
        .filter(|name| !override_written(destination, name, roots))
        .collect();
    if still_missing.is_empty() {
        return Ok(extracted);
    }
    Err(ModpackError::OverridesIncomplete(still_missing.join(", ")))
}

/// Pfad eines Override-Eintrags relativ zur Instanz, falls er sicher ist.
fn override_relative(name: &str, roots: &[String]) -> Option<PathBuf> {
    roots
        .iter()
        .find_map(|root| name.strip_prefix(root))
        .and_then(safe_relative)
}

fn override_written(destination: &Path, name: &str, roots: &[String]) -> bool {
    override_relative(name, roots).is_some_and(|relative| destination.join(relative).is_file())
}

/// Ein Durchlauf über das Archiv. Mit `only` werden ausschließlich die dort
/// genannten Einträge geschrieben; ohne werden alle Overrides entpackt.
fn extract_override_pass(
    archive_path: &Path,
    destination: &Path,
    roots: &[String],
    only: Option<&HashSet<String>>,
) -> Result<Vec<String>> {
    let file = open_archive(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
    })?;

    let mut extracted: Vec<String> = Vec::new();
    let mut declared_total = 0u64;
    let mut written_total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|error| {
                ModpackError::InvalidArchive(archive_path.to_path_buf(), error.to_string())
            })?
            .replace('\\', "/");
        let Some(stripped) = roots.iter().find_map(|root| name.strip_prefix(root)) else {
            continue;
        };
        let Some(relative) = safe_relative(stripped) else {
            return Err(ModpackError::UnsafePath(name));
        };
        if is_reserved(&relative) {
            return Err(ModpackError::UnsafePath(name));
        }
        if only.is_some_and(|only| !only.contains(&name)) {
            continue;
        }

        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_OVERRIDE_BYTES {
            return Err(ModpackError::OverridesTooLarge(MAX_OVERRIDE_BYTES));
        }

        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut output = std::fs::File::create(&target)?;
        let copied = std::io::copy(&mut entry, &mut output)?;
        // Schließen, bevor der zweite Durchlauf prüft: auf Windows ist die
        // Datei sonst noch gesperrt und ein erneutes Schreiben schlägt fehl.
        drop(output);
        written_total = written_total.saturating_add(copied);
        if written_total > MAX_OVERRIDE_BYTES {
            return Err(ModpackError::OverridesTooLarge(MAX_OVERRIDE_BYTES));
        }
        extracted.push(name);
    }
    Ok(extracted)
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

fn loader_dependency(dependencies: &HashMap<String, String>) -> Result<Option<LoaderDependency>> {
    const KEYS: [(&str, Loader); 4] = [
        ("fabric-loader", Loader::Fabric),
        ("neoforge", Loader::NeoForge),
        ("forge", Loader::Forge),
        ("quilt-loader", Loader::Quilt),
    ];

    let mut found: Vec<(Loader, String)> = KEYS
        .iter()
        .filter_map(|(key, loader)| {
            dependencies
                .get(*key)
                .map(|version| (*loader, version.trim().to_string()))
        })
        .filter(|(_, version)| !version.is_empty())
        .collect();

    if found.len() > 1 {
        let names = found
            .iter()
            .map(|(loader, _)| loader.label())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ModpackError::MultipleLoaders(names));
    }
    match found.pop() {
        None => Ok(None),
        Some((Loader::Fabric, version)) => Ok(Some(LoaderDependency {
            loader: Loader::Fabric,
            version,
        })),
        Some((Loader::NeoForge, version)) => Ok(Some(LoaderDependency {
            loader: Loader::NeoForge,
            version,
        })),
        Some((Loader::Forge, version)) => Ok(Some(LoaderDependency {
            loader: Loader::Forge,
            version,
        })),
        Some((Loader::Quilt, version)) => Ok(Some(LoaderDependency {
            loader: Loader::Quilt,
            version,
        })),
    }
}

/// Prüft einen pack-relativen Pfad: keine absoluten Pfade, kein `..`, keine
/// Laufwerksangaben, keine Steuerzeichen.
fn safe_relative(raw: &str) -> Option<PathBuf> {
    let normalized = raw.replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        if part.contains(':') || part.chars().any(char::is_control) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// Unter Windows sind Pfade ohne Rücksicht auf Groß-/Kleinschreibung gleich;
/// `INSTANCE.JSON` würde `instance.json` überschreiben. Deshalb wird
/// unabhängig vom Betriebssystem konservativ verglichen.
fn is_reserved(relative: &Path) -> bool {
    let name = relative.to_string_lossy();
    RESERVED_META
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

/// Pfad für die Bestandsdatei, unabhängig vom Betriebssystem mit `/`.
fn path_string(relative: &Path) -> String {
    relative.to_string_lossy().replace('\\', "/")
}

/// Projekt- und Versions-ID aus einem Modrinth-CDN-Link.
fn modrinth_ids(raw: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(
        url.host_str(),
        Some("cdn.modrinth.com") | Some("cdn-raw.modrinth.com")
    ) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.collect();
    match segments.as_slice() {
        ["data", project, "versions", version, ..]
            if !project.is_empty() && !version.is_empty() =>
        {
            Some((project.to_string(), version.to_string()))
        }
        _ => None,
    }
}

fn sanitize_name(raw: &str) -> String {
    let mut name: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '-'
            } else {
                ch
            }
        })
        .collect();
    name = name.trim().trim_end_matches([' ', '.']).to_string();
    if name.chars().count() > 64 {
        name = name
            .chars()
            .take(64)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    if name.is_empty() || validate_instance_name(&name).is_err() {
        "Modpack".to_string()
    } else {
        name
    }
}

fn unique_instance_name(manager: &InstanceManager, base: &str) -> Result<String> {
    if !manager.instance_dir(base)?.exists() {
        return Ok(base.to_string());
    }
    for suffix in 2..100 {
        let candidate = with_suffix(base, suffix);
        if !manager.instance_dir(&candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Err(ModpackError::InstanceNameExhausted(base.to_string()))
}

fn with_suffix(base: &str, suffix: usize) -> String {
    let suffix = format!("-{suffix}");
    let limit = 64usize.saturating_sub(suffix.chars().count());
    let stem: String = base.chars().take(limit).collect();
    format!("{}{suffix}", stem.trim_end_matches([' ', '.']))
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

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(safe_relative("mods/a.jar").is_some());
        assert!(safe_relative("config/a/b.json").is_some());
        assert!(safe_relative("../evil.jar").is_none());
        assert!(safe_relative("mods/../../evil.jar").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("C:/Windows/system32").is_none());
        assert!(safe_relative("mods//a.jar").is_none());
        assert!(safe_relative("").is_none());
    }

    #[test]
    fn sanitizes_pack_names_for_instances() {
        assert_eq!(
            sanitize_name("Fabulously Optimized"),
            "Fabulously Optimized"
        );
        assert_eq!(sanitize_name("a/b:c"), "a-b-c");
        assert_eq!(sanitize_name("  ..  "), "Modpack");
        assert_eq!(sanitize_name(""), "Modpack");
        assert_eq!(sanitize_name("CON"), "Modpack");
        assert!(sanitize_name(&"x".repeat(100)).chars().count() <= 64);
    }

    #[test]
    fn protects_instance_metadata_case_insensitively() {
        assert!(is_reserved(Path::new("instance.json")));
        assert!(is_reserved(Path::new("Bamboo-Mods.JSON")));
        assert!(!is_reserved(Path::new("config/instance.json")));
    }

    #[test]
    fn parses_modrinth_cdn_links() {
        let (project, version) =
            modrinth_ids("https://cdn.modrinth.com/data/AANobbMI/versions/abc123/sodium.jar")
                .unwrap();
        assert_eq!(project, "AANobbMI");
        assert_eq!(version, "abc123");
        assert!(modrinth_ids("https://example.com/data/AANobbMI/versions/abc123/x.jar").is_none());
        assert!(modrinth_ids("https://cdn.modrinth.com/other/path.jar").is_none());
    }

    #[test]
    fn picks_a_single_supported_loader() {
        let mut deps = HashMap::new();
        deps.insert("minecraft".to_string(), "1.20.1".to_string());
        deps.insert("fabric-loader".to_string(), "0.16.10".to_string());
        let dependency = loader_dependency(&deps).unwrap().unwrap();
        assert_eq!(dependency.loader, Loader::Fabric);
        assert_eq!(dependency.version, "0.16.10");

        deps.insert("neoforge".to_string(), "21.1.9".to_string());
        assert!(matches!(
            loader_dependency(&deps),
            Err(ModpackError::MultipleLoaders(_))
        ));

        let mut forge = HashMap::new();
        forge.insert("minecraft".to_string(), "1.20.1".to_string());
        forge.insert("forge".to_string(), "47.2.0".to_string());
        let dependency = loader_dependency(&forge).unwrap().unwrap();
        assert_eq!(dependency.loader, Loader::Forge);
        assert_eq!(dependency.version, "47.2.0");

        let mut quilt = HashMap::new();
        quilt.insert("minecraft".to_string(), "1.20.1".to_string());
        quilt.insert("quilt-loader".to_string(), "0.23.1".to_string());
        let dependency = loader_dependency(&quilt).unwrap().unwrap();
        assert_eq!(dependency.loader, Loader::Quilt);
        assert_eq!(dependency.version, "0.23.1");
    }

    #[test]
    fn ledger_records_pack_and_modrinth_mods() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("mods")).unwrap();
        let instance = Instance {
            name: "Test".to_string(),
            dir: dir.path().to_path_buf(),
            version_id: Some("1.20.1".to_string()),
        };
        let index = PackIndex {
            format_version: 1,
            game: "minecraft".to_string(),
            version_id: "1.0.0".to_string(),
            name: "Test Pack".to_string(),
            summary: None,
            files: Vec::new(),
            dependencies: HashMap::new(),
        };
        let pending = vec![PendingModRecord {
            path: PathBuf::from("mods/sodium.jar"),
            source: ModSource::Modrinth,
            project_id: "AANobbMI".to_string(),
            version_id: "abc123".to_string(),
            version_number: "abc123".to_string(),
        }];
        let records = vec![PackFileRecord {
            path: "mods/sodium.jar".to_string(),
            sha1: Some("abc".to_string()),
            size: Some(3),
        }];

        write_ledger(
            &instance,
            &index.name,
            &index.version_id,
            Path::new("pack.mrpack"),
            &pending,
            &records,
        )
        .unwrap();

        let ledger = ModLedger::load(dir.path()).unwrap();
        assert_eq!(ledger.mods.len(), 1);
        assert_eq!(ledger.mods[0].project_id, "AANobbMI");
        assert_eq!(ledger.mods[0].version_id, "abc123");
        assert_eq!(ledger.mods[0].file_name, "sodium.jar");
        assert_eq!(ledger.mods[0].required_by, vec!["Test Pack"]);
        let pack = ledger.pack.expect("Pack-Eintrag");
        assert_eq!(pack.files.len(), 1);
        assert_eq!(pack.files[0].path, "mods/sodium.jar");
    }

    #[test]
    fn appends_a_suffix_and_keeps_the_name_limit() {
        assert_eq!(with_suffix("Pack", 2), "Pack-2");
        let long = "x".repeat(64);
        let candidate = with_suffix(&long, 12);
        assert!(candidate.chars().count() <= 64);
        assert!(candidate.ends_with("-12"));
    }
}
