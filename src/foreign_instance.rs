//! Übernahme fertiger Instanzen aus anderen Launchern.
//!
//! Die anderen Launcher speichern ihre Metadaten in eigenen Dateien:
//!
//! - Prism/MultiMC: `mmc-pack.json` (Komponenten) und `instance.cfg`,
//!   Spielinhalte liegen in `.minecraft/` oder direkt daneben.
//! - CurseForge App: `minecraftinstance.json`, Inhalte direkt im Ordner.
//! - Modrinth App: `profile.json`, Inhalte direkt im Ordner.
//!
//! Übernommen werden nur die ausgewählten Inhaltsordner. Versionen, Libraries
//! und Assets werden nicht kopiert: Die gehören dem jeweiligen Launcher und
//! werden von Bamboo selbst installiert.

use crate::mods::Loader;
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_COPY_DEPTH: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum ExternalImportError {
    #[error(
        "Dieser Ordner ist keine unterstützte Instanz. Erwartet werden Prism/MultiMC, CurseForge oder Modrinth."
    )]
    NotAnInstance,

    #[error("Die Minecraft-Version der Instanz konnte nicht erkannt werden.")]
    MissingMinecraftVersion,

    #[error("Die Minecraft-Version '{0}' ist ungültig.")]
    InvalidMinecraftVersion(String),

    #[error("Die Metadaten der Instanz sind unlesbar: {0}")]
    InvalidManifest(String),

    #[error("Der Ordner konnte nicht gelesen werden: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ExternalImportError>;

/// Woher die Instanz stammt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalSource {
    Prism,
    CurseForgeApp,
    ModrinthApp,
}

impl ExternalSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Prism => "Prism/MultiMC",
            Self::CurseForgeApp => "CurseForge App",
            Self::ModrinthApp => "Modrinth App",
        }
    }
}

/// Dateizahlen einer Inhaltsart, wie sie die Vorschau anzeigt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentCounts {
    pub mods: usize,
    pub resourcepacks: usize,
    pub shaderpacks: usize,
    pub datapacks: usize,
    pub worlds: usize,
    pub config: usize,
    pub screenshots: usize,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ContentSelection {
    pub mods: bool,
    pub resourcepacks: bool,
    pub shaderpacks: bool,
    pub datapacks: bool,
    pub worlds: bool,
    pub config: bool,
    pub screenshots: bool,
}

impl Default for ContentSelection {
    fn default() -> Self {
        Self {
            mods: true,
            resourcepacks: true,
            shaderpacks: true,
            datapacks: true,
            worlds: true,
            config: true,
            screenshots: false,
        }
    }
}

impl ContentSelection {
    fn folders(self) -> [(&'static str, bool); 7] {
        [
            ("mods", self.mods),
            ("resourcepacks", self.resourcepacks),
            ("shaderpacks", self.shaderpacks),
            ("datapacks", self.datapacks),
            ("saves", self.worlds),
            ("config", self.config),
            ("screenshots", self.screenshots),
        ]
    }
}

/// Eine erkannte Fremdinstanz samt der Dateien, die für die Vorschau zählen.
#[derive(Debug, Clone)]
pub struct ExternalInstance {
    pub source: ExternalSource,
    pub name: String,
    /// Ordner mit `mods/`, `config/`, `saves/` usw.
    pub game_dir: PathBuf,
    pub minecraft_version: String,
    pub loader: Option<Loader>,
    pub loader_version: String,
    pub icon: Option<PathBuf>,
    pub counts: ContentCounts,
}

/// Was beim Kopieren tatsächlich angekommen ist.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CopyReport {
    pub counts: ContentCounts,
    pub skipped: usize,
    /// Dateien und komplette Welten, die es im Ziel schon gab und die deshalb
    /// unangetastet blieben. Ein Merge überschreibt grundsätzlich nichts.
    pub existing: usize,
}

impl ExternalInstance {
    /// Erkennt die Instanz anhand ihrer Metadatendateien.
    pub fn detect(dir: &Path) -> Result<Self> {
        if !dir.is_dir() {
            return Err(ExternalImportError::NotAnInstance);
        }

        if dir.join("mmc-pack.json").is_file() || dir.join("instance.cfg").is_file() {
            return detect_prism(dir);
        }
        if dir.join("minecraftinstance.json").is_file() {
            return detect_curseforge(dir);
        }
        if dir.join("profile.json").is_file() {
            return detect_modrinth(dir);
        }
        Err(ExternalImportError::NotAnInstance)
    }

    /// Kopiert die ausgewählten Inhaltsordner in eine Instanz.
    ///
    /// In eine frische Instanz ist das ein vollständiger Import; in eine
    /// bestehende ein Merge, der nur fehlende Dateien ergänzt. Vorhandene
    /// Dateien und komplette Welten bleiben unangetastet, damit ein Import
    /// niemals Einstellungen oder Spielstände überschreibt.
    ///
    /// Symbolische Links werden übersprungen: Sie können aus dem Quellordner
    /// herauszeigen und beim Kopieren fremde Dateien mitnehmen.
    pub fn copy_content(&self, target: &Path, selection: ContentSelection) -> Result<CopyReport> {
        let mut report = CopyReport::default();
        for (folder, wanted) in selection.folders() {
            if !wanted {
                continue;
            }
            let source = self.game_dir.join(folder);
            if !source.is_dir() {
                continue;
            }
            let destination = target.join(folder);
            // Eine vorhandene Welt ist ein zusammenhängender Spielstand; einzelne
            // Region-Dateien daraus zu ergänzen würde ihn beschädigen.
            let (files, bytes, skipped, existing) =
                copy_tree(&source, &destination, 0, folder == "saves")?;
            report.counts.files += files;
            report.counts.bytes += bytes;
            report.skipped += skipped;
            report.existing += existing;
            match folder {
                "mods" => report.counts.mods = files,
                "resourcepacks" => report.counts.resourcepacks = files,
                "shaderpacks" => report.counts.shaderpacks = files,
                "datapacks" => report.counts.datapacks = files,
                "saves" => report.counts.worlds = files,
                "config" => report.counts.config = files,
                "screenshots" => report.counts.screenshots = files,
                _ => {}
            }
        }

        // Kleine Spielstände, die nicht in einem Inhaltsordner liegen. Ohne
        // options.txt startet die Instanz mit falscher Sprache, Sichtweite und
        // Tastenbelegung; servers.dat enthält die Serverliste. Beides gehört
        // zur Config und wird nur mitkopiert, wenn der Nutzer sie will.
        if selection.config {
            for file in ["options.txt", "servers.dat"] {
                let source = self.game_dir.join(file);
                if !source.is_file() {
                    continue;
                }
                if target.join(file).exists() {
                    report.existing += 1;
                    continue;
                }
                if std::fs::copy(&source, target.join(file)).is_ok() {
                    report.counts.files += 1;
                    report.counts.bytes += std::fs::metadata(&source)
                        .map(|meta| meta.len())
                        .unwrap_or(0);
                } else {
                    report.skipped += 1;
                }
            }
        }

        Ok(report)
    }
}

fn read_json(path: &Path) -> Result<serde_json::Value> {
    let text = std::fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|error| {
        ExternalImportError::InvalidManifest(format!("{}: {error}", path.display()))
    })
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Import".to_string())
}

fn icon_in(dir: &Path) -> Option<PathBuf> {
    ["icon.png", "pack.png", "logo.png"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn validate_minecraft_version(version: &str) -> Result<String> {
    let version = version.trim();
    if version.is_empty() {
        return Err(ExternalImportError::MissingMinecraftVersion);
    }
    if version.len() > 64
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
    {
        return Err(ExternalImportError::InvalidMinecraftVersion(
            version.to_string(),
        ));
    }
    Ok(version.to_string())
}

fn detect_prism(dir: &Path) -> Result<ExternalInstance> {
    if !dir.join("mmc-pack.json").is_file() {
        return Err(ExternalImportError::InvalidManifest(
            "Prism/MultiMC-Instanz ohne mmc-pack.json; die Minecraft-Version fehlt.".to_string(),
        ));
    }
    let pack = read_json(&dir.join("mmc-pack.json"))?;
    let components = pack
        .get("components")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            ExternalImportError::InvalidManifest(
                "mmc-pack.json enthält keine Komponenten.".to_string(),
            )
        })?;

    let mut minecraft = None;
    let mut loader = None;
    let mut loader_version = String::new();
    for component in components {
        let Some(uid) = component.get("uid").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let version = component
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim();
        let uid = uid.to_ascii_lowercase();
        if uid == "net.minecraft" {
            minecraft = Some(version.to_string());
        } else if let Some(detected) = loader_from_component(&uid) {
            loader = Some(detected);
            loader_version = version.to_string();
        }
    }

    let minecraft = validate_minecraft_version(
        minecraft
            .as_deref()
            .ok_or(ExternalImportError::MissingMinecraftVersion)?,
    )?;
    let name = instance_cfg_name(dir).unwrap_or_else(|| folder_name(dir));
    let game_dir = if dir.join(".minecraft").is_dir() {
        dir.join(".minecraft")
    } else {
        dir.to_path_buf()
    };
    let counts = scan_counts(&game_dir);
    let loader_version =
        sanitize_loader_version(&strip_minecraft_prefix(&loader_version, &minecraft));

    Ok(ExternalInstance {
        source: ExternalSource::Prism,
        name,
        game_dir,
        minecraft_version: minecraft,
        loader,
        loader_version,
        icon: icon_in(dir),
        counts,
    })
}

/// Prism/MultiMC speichert den Anzeigenamen in einer INI-Datei.
fn instance_cfg_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("instance.cfg")).ok()?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "name" && !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn loader_from_component(uid: &str) -> Option<Loader> {
    if uid.contains("fabric-loader") {
        Some(Loader::Fabric)
    } else if uid.contains("quilt-loader") {
        Some(Loader::Quilt)
    } else if uid.contains("neoforge") {
        Some(Loader::NeoForge)
    } else if uid.contains("minecraftforge") {
        Some(Loader::Forge)
    } else {
        None
    }
}

fn detect_curseforge(dir: &Path) -> Result<ExternalInstance> {
    let manifest = read_json(&dir.join("minecraftinstance.json"))?;
    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            manifest
                .get("installedModpack")
                .and_then(|pack| pack.get("name"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::to_string)
        .unwrap_or_else(|| folder_name(dir));

    let base = manifest.get("baseModLoader");
    let minecraft = manifest
        .get("gameVersion")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            manifest
                .get("minecraftVersion")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            base.and_then(|loader| loader.get("minecraftVersion"))
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("");
    let minecraft = validate_minecraft_version(minecraft)?;

    let loader_name = base
        .and_then(|loader| loader.get("name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let (loader, loader_version) = parse_loader_id(loader_name)
        .or_else(|| {
            base.and_then(|loader| loader.get("type"))
                .and_then(serde_json::Value::as_u64)
                .and_then(loader_from_curseforge_type)
                .map(|loader| (Some(loader), String::new()))
        })
        .unwrap_or((None, String::new()));
    let loader_version =
        sanitize_loader_version(&strip_minecraft_prefix(&loader_version, &minecraft));

    let counts = scan_counts(dir);
    Ok(ExternalInstance {
        source: ExternalSource::CurseForgeApp,
        name,
        game_dir: dir.to_path_buf(),
        minecraft_version: minecraft,
        loader,
        loader_version,
        icon: icon_in(dir),
        counts,
    })
}

fn loader_from_curseforge_type(kind: u64) -> Option<Loader> {
    match kind {
        1 => Some(Loader::Forge),
        4 => Some(Loader::Fabric),
        5 => Some(Loader::Quilt),
        6 => Some(Loader::NeoForge),
        _ => None,
    }
}

fn detect_modrinth(dir: &Path) -> Result<ExternalInstance> {
    let profile = read_json(&dir.join("profile.json"))?;
    let minecraft = profile
        .get("game_version")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            profile
                .get("gameVersion")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("");
    if minecraft.trim().is_empty() {
        // Ein fremdes profile.json gehört zu einer anderen Anwendung; ohne
        // Minecraft-Version ist dieser Ordner keine Modrinth-Instanz.
        return Err(ExternalImportError::NotAnInstance);
    }
    let minecraft = validate_minecraft_version(minecraft)?;
    let loader = profile
        .get("loader")
        .and_then(serde_json::Value::as_str)
        .and_then(Loader::parse);
    let loader_version = sanitize_loader_version(
        profile
            .get("loader_version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(""),
    );
    let name = profile
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| folder_name(dir));
    let counts = scan_counts(dir);

    Ok(ExternalInstance {
        source: ExternalSource::ModrinthApp,
        name,
        game_dir: dir.to_path_buf(),
        minecraft_version: minecraft,
        loader,
        loader_version,
        icon: icon_in(dir),
        counts,
    })
}

/// Zerlegt IDs wie `fabric-loader-0.16.10`, `quilt-0.23.1`,
/// `forge-47.2.0` oder `forge-1.20.1-47.2.0`.
fn parse_loader_id(id: &str) -> Option<(Option<Loader>, String)> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let lower = id.to_ascii_lowercase();
    let candidates = [
        ("fabric-loader-", Loader::Fabric),
        ("fabric-", Loader::Fabric),
        ("quilt-loader-", Loader::Quilt),
        ("quilt-", Loader::Quilt),
        ("neoforge-", Loader::NeoForge),
        ("forge-", Loader::Forge),
    ];
    for (prefix, loader) in candidates {
        if lower.starts_with(prefix) {
            // Die Schreibweise der Version aus dem Original übernehmen; das
            // Präfix ist ASCII, daher stimmen die Byte-Längen überein.
            return Some((Some(loader), id[prefix.len()..].trim().to_string()));
        }
    }
    None
}

/// Eine Loader-Version aus fremden Metadaten wird nur übernommen, wenn sie
/// sich gefahrlos als Dateiname und API-Parameter verwenden lässt.
fn sanitize_loader_version(version: &str) -> String {
    let version = version.trim();
    if version.len() > 64
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
    {
        String::new()
    } else {
        version.to_string()
    }
}

fn strip_minecraft_prefix(version: &str, minecraft: &str) -> String {
    let version = version.trim();
    let prefix = format!("{minecraft}-");
    version
        .strip_prefix(&prefix)
        .unwrap_or(version)
        .trim()
        .to_string()
}

fn scan_counts(root: &Path) -> ContentCounts {
    let mut counts = ContentCounts::default();
    for (folder, _) in ContentSelection::default().folders() {
        let (files, bytes) = scan_tree(&root.join(folder), 0);
        counts.files += files;
        counts.bytes += bytes;
        match folder {
            "mods" => counts.mods = files,
            "resourcepacks" => counts.resourcepacks = files,
            "shaderpacks" => counts.shaderpacks = files,
            "datapacks" => counts.datapacks = files,
            "saves" => counts.worlds = files,
            "config" => counts.config = files,
            "screenshots" => counts.screenshots = files,
            _ => {}
        }
    }
    counts
}

fn scan_tree(path: &Path, depth: usize) -> (usize, u64) {
    if depth > MAX_COPY_DEPTH {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    let mut files = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // `symlink_metadata` beschreibt den Link selbst; ein Link auf ein
        // Verzeichnis würde sonst den Quellbaum verlassen.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let (nested_files, nested_bytes) = scan_tree(&path, depth + 1);
            files += nested_files;
            bytes += nested_bytes;
        } else if metadata.is_file() {
            files += 1;
            bytes += metadata.len();
        }
    }
    (files, bytes)
}

fn copy_tree(
    source: &Path,
    target: &Path,
    depth: usize,
    skip_existing_dirs: bool,
) -> Result<(usize, u64, usize, usize)> {
    if depth > MAX_COPY_DEPTH {
        return Ok((0, 0, 0, 0));
    }
    std::fs::create_dir_all(target)?;
    // Ein gesperrter Unterordner soll den restlichen Import nicht verhindern.
    let Ok(entries) = std::fs::read_dir(source) else {
        return Ok((0, 0, 1, 0));
    };
    let mut files = 0;
    let mut bytes = 0;
    let mut skipped = 0;
    let mut existing = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            skipped += 1;
            continue;
        };
        if metadata.file_type().is_symlink() {
            skipped += 1;
            continue;
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            if skip_existing_dirs && destination.exists() {
                existing += 1;
                continue;
            }
            match copy_tree(&path, &destination, depth + 1, false) {
                Ok((nested_files, nested_bytes, nested_skipped, nested_existing)) => {
                    files += nested_files;
                    bytes += nested_bytes;
                    skipped += nested_skipped;
                    existing += nested_existing;
                }
                Err(_) => skipped += 1,
            }
        } else if metadata.is_file() {
            if destination.exists() {
                existing += 1;
                continue;
            }
            match std::fs::copy(&path, &destination) {
                Ok(copied) => {
                    files += 1;
                    bytes += copied;
                }
                Err(_) => skipped += 1,
            }
        }
    }
    Ok((files, bytes, skipped, existing))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bamboo-external-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn detects_a_prism_instance() {
        let dir = temp_dir("prism");
        write(
            &dir.join("mmc-pack.json"),
            br#"{"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.fabricmc.fabric-loader","version":"0.16.10"}]}"#,
        );
        write(
            &dir.join("instance.cfg"),
            b"name=My Prism Pack\niconKey=default\n",
        );
        write(&dir.join(".minecraft/mods/one.jar"), b"jar");
        write(&dir.join(".minecraft/mods/nested/two.jar"), b"jar");
        write(&dir.join(".minecraft/saves/world/level.dat"), b"level");
        write(&dir.join(".minecraft/config/mod.toml"), b"config");

        let instance = ExternalInstance::detect(&dir).expect("Prism-Instanz");
        assert_eq!(instance.source, ExternalSource::Prism);
        assert_eq!(instance.name, "My Prism Pack");
        assert_eq!(instance.minecraft_version, "1.20.1");
        assert_eq!(instance.loader, Some(Loader::Fabric));
        assert_eq!(instance.loader_version, "0.16.10");
        assert_eq!(instance.game_dir, dir.join(".minecraft"));
        assert_eq!(instance.counts.mods, 2);
        assert_eq!(instance.counts.worlds, 1);
        assert_eq!(instance.counts.config, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_a_curseforge_instance() {
        let dir = temp_dir("curseforge");
        write(
            &dir.join("minecraftinstance.json"),
            br#"{"name":"CF Pack","gameVersion":"1.20.1","baseModLoader":{"name":"forge-47.2.0","type":1}}"#,
        );
        write(&dir.join("mods/a.jar"), b"jar");
        write(&dir.join("saves/world/level.dat"), b"level");

        let instance = ExternalInstance::detect(&dir).expect("CurseForge-Instanz");
        assert_eq!(instance.source, ExternalSource::CurseForgeApp);
        assert_eq!(instance.name, "CF Pack");
        assert_eq!(instance.minecraft_version, "1.20.1");
        assert_eq!(instance.loader, Some(Loader::Forge));
        assert_eq!(instance.loader_version, "47.2.0");
        assert_eq!(instance.counts.mods, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_a_modrinth_instance() {
        let dir = temp_dir("modrinth");
        write(
            &dir.join("profile.json"),
            br#"{"name":"MR Pack","game_version":"1.21.1","loader":"quilt","loader_version":"0.27.1"}"#,
        );
        write(&dir.join("mods/a.jar"), b"jar");

        let instance = ExternalInstance::detect(&dir).expect("Modrinth-Instanz");
        assert_eq!(instance.source, ExternalSource::ModrinthApp);
        assert_eq!(instance.minecraft_version, "1.21.1");
        assert_eq!(instance.loader, Some(Loader::Quilt));
        assert_eq!(instance.loader_version, "0.27.1");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_folders_without_launcher_metadata() {
        let dir = temp_dir("unknown");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        assert!(matches!(
            ExternalInstance::detect(&dir),
            Err(ExternalImportError::NotAnInstance)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_prism_instance_without_minecraft_version() {
        let dir = temp_dir("prism-missing-version");
        write(
            &dir.join("mmc-pack.json"),
            br#"{"components":[{"uid":"net.fabricmc.fabric-loader","version":"0.16.10"}]}"#,
        );
        assert!(matches!(
            ExternalInstance::detect(&dir),
            Err(ExternalImportError::MissingMinecraftVersion)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_only_selected_folders_and_keeps_nested_paths() {
        let dir = temp_dir("copy");
        write(
            &dir.join("profile.json"),
            br#"{"name":"Copy","game_version":"1.20.1","loader":"fabric","loader_version":"0.16.10"}"#,
        );
        write(&dir.join("mods/a.jar"), b"a");
        write(&dir.join("mods/nested/b.jar"), b"b");
        write(&dir.join("saves/world/level.dat"), b"level");
        write(&dir.join("screenshots/shot.png"), b"png");
        write(&dir.join("options.txt"), b"lang:de_de");

        let instance = ExternalInstance::detect(&dir).unwrap();
        let target = temp_dir("copy-target");
        let report = instance
            .copy_content(
                &target,
                ContentSelection {
                    mods: true,
                    worlds: true,
                    screenshots: false,
                    ..ContentSelection::default()
                },
            )
            .unwrap();

        assert!(target.join("mods/a.jar").is_file());
        assert!(target.join("mods/nested/b.jar").is_file());
        assert!(target.join("saves/world/level.dat").is_file());
        assert!(target.join("options.txt").is_file());
        assert!(!target.join("screenshots/shot.png").exists());
        assert_eq!(report.counts.mods, 2);
        assert_eq!(report.counts.worlds, 1);
        assert_eq!(report.counts.screenshots, 0);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn merge_only_adds_missing_files_and_leaves_worlds_alone() {
        let dir = temp_dir("merge-source");
        write(
            &dir.join("profile.json"),
            br#"{"name":"Merge","game_version":"1.20.1","loader":"fabric","loader_version":"0.16.10"}"#,
        );
        write(&dir.join("mods/new.jar"), b"new");
        write(&dir.join("mods/existing.jar"), b"replacement");
        write(&dir.join("saves/Old/level.dat"), b"replacement-world");
        write(&dir.join("saves/New/level.dat"), b"new-world");
        write(&dir.join("config/new.toml"), b"new-config");
        write(&dir.join("config/existing.toml"), b"replacement-config");
        write(&dir.join("options.txt"), b"lang:en_us");

        let target = temp_dir("merge-target");
        write(&target.join("mods/existing.jar"), b"keep");
        write(&target.join("saves/Old/level.dat"), b"keep-world");
        write(&target.join("config/existing.toml"), b"keep-config");
        write(&target.join("options.txt"), b"lang:de_de");

        let instance = ExternalInstance::detect(&dir).unwrap();
        let report = instance
            .copy_content(&target, ContentSelection::default())
            .unwrap();

        assert_eq!(std::fs::read(target.join("mods/new.jar")).unwrap(), b"new");
        assert_eq!(
            std::fs::read(target.join("mods/existing.jar")).unwrap(),
            b"keep"
        );
        assert_eq!(
            std::fs::read(target.join("saves/Old/level.dat")).unwrap(),
            b"keep-world"
        );
        assert!(target.join("saves/New/level.dat").is_file());
        assert_eq!(
            std::fs::read(target.join("config/existing.toml")).unwrap(),
            b"keep-config"
        );
        assert!(target.join("config/new.toml").is_file());
        assert_eq!(
            std::fs::read(target.join("options.txt")).unwrap(),
            b"lang:de_de"
        );
        // existing.jar, die vorhandene Welt, existing.toml und options.txt.
        assert_eq!(report.existing, 4);
        assert_eq!(report.counts.mods, 1);
        assert_eq!(report.counts.worlds, 1);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn parses_loader_ids_and_strips_the_minecraft_prefix() {
        let (loader, version) = parse_loader_id("forge-1.20.1-47.2.0").expect("Forge-ID");
        assert_eq!(loader, Some(Loader::Forge));
        assert_eq!(strip_minecraft_prefix(&version, "1.20.1"), "47.2.0");
        let (loader, version) = parse_loader_id("quilt-loader-0.24.0").expect("Quilt-ID");
        assert_eq!(loader, Some(Loader::Quilt));
        assert_eq!(version, "0.24.0");
    }

    #[test]
    fn rejects_unsafe_minecraft_versions() {
        assert!(matches!(
            validate_minecraft_version("../1.20.1"),
            Err(ExternalImportError::InvalidMinecraftVersion(_))
        ));
        assert!(matches!(
            validate_minecraft_version(" "),
            Err(ExternalImportError::MissingMinecraftVersion)
        ));
    }
}
