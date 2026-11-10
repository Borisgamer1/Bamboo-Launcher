use crate::error::{LauncherError, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Standard-Unterordner, die eine Instanz vom Spielverzeichnis trennen.
const INSTANCE_DIRS: [&str; 5] = ["mods", "config", "saves", "resourcepacks", "logs"];
const MOD_SUFFIX: &str = ".jar";
const DISABLED_SUFFIX: &str = ".jar.disabled";
const META_FILE: &str = "instance.json";

/// Windows verbietet diese Namen unabhängig von der Endung.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceMeta {
    pub name: String,
    #[serde(default, alias = "versionId")]
    pub version_id: Option<String>,
    /// Bei alten Profilen steht hier die reine Minecraft-Version, wenn keine
    /// Versions-ID gespeichert ist.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default, alias = "createdAt")]
    pub created_at: Option<u64>,
    /// Loader-Version, für die ein Update schon einmal abgelehnt wurde.
    #[serde(default, alias = "declinedLoaderUpdate")]
    pub declined_loader_update: Option<String>,
}

impl InstanceMeta {
    /// Die benutzbare Versions-ID: bevorzugt `versionId`, sonst `version`.
    fn usable_version(&self) -> Option<String> {
        self.version_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                self.version
                    .clone()
                    .filter(|value| !value.trim().is_empty())
            })
    }
}

#[derive(Debug, Clone)]
pub struct Instance {
    pub name: String,
    pub dir: PathBuf,
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModMetadata {
    pub id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModEntry {
    pub file_name: String,
    pub path: PathBuf,
    pub enabled: bool,
    pub size: u64,
    pub metadata: ModMetadata,
}

/// Prüft einen Instanznamen und verhindert Ausbrüche aus dem Instanz-Ordner.
pub fn validate_instance_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(LauncherError::InvalidInstanceName(
            "Der Name darf nicht leer sein.".to_string(),
        ));
    }
    if trimmed.len() > 64 {
        return Err(LauncherError::InvalidInstanceName(
            "Der Name darf höchstens 64 Zeichen lang sein.".to_string(),
        ));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(LauncherError::InvalidInstanceName(
            "Der Name darf nicht aus Punkten bestehen.".to_string(),
        ));
    }
    if trimmed.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return Err(LauncherError::InvalidInstanceName(format!(
            "'{trimmed}' enthält unerlaubte Zeichen."
        )));
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err(LauncherError::InvalidInstanceName(
            "Der Name darf nicht mit Punkt oder Leerzeichen enden.".to_string(),
        ));
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(LauncherError::InvalidInstanceName(format!(
            "'{trimmed}' ist ein reservierter Systemname."
        )));
    }
    Ok(())
}

/// Verhindert, dass ein Dateiname Pfadtrenner enthält.
fn safe_file_name(file_name: &str) -> Result<&str> {
    if file_name.is_empty()
        || std::path::Path::new(file_name).components().count() != 1
        || file_name == "."
        || file_name == ".."
    {
        return Err(LauncherError::UnsafePath(PathBuf::from(file_name)));
    }
    Ok(file_name)
}

/// Verwaltet Instanzordner unterhalb eines Wurzelverzeichnisses.
#[derive(Debug, Clone)]
pub struct InstanceManager {
    root: PathBuf,
    /// Weitere Instanzordner, etwa die Profile der Vorgänger-App. Dort wird
    /// nie etwas angelegt, aber gelesen, gestartet und gelöscht.
    extra_roots: Vec<PathBuf>,
}

/// Sieht ein Ordner wie eine echte Instanz aus? Fremde Wurzeln enthalten oft
/// halb angelegte Testordner, die nicht in der Liste auftauchen sollen.
fn looks_like_instance(dir: &Path) -> bool {
    if dir.join(META_FILE).is_file() || dir.join("options.txt").is_file() {
        return true;
    }
    ["mods", "saves"].iter().any(|sub| {
        std::fs::read_dir(dir.join(sub))
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
    })
}

/// Die Wurzel, in der Versionen, Libraries und Assets zu einem Instanzordner
/// liegen: `<wurzel>/instances/<name>` und `<wurzel>/profiles/<name>` haben
/// beide die Wurzel zwei Ebenen darüber.
pub fn content_root(instance_dir: &Path) -> Option<PathBuf> {
    instance_dir.parent()?.parent().map(Path::to_path_buf)
}

/// Wo die Cosmiq-Mod die lokalen Cosmetic-Pakete einer Instanz liest.
const COSMETICS_DIR: [&str; 2] = ["bamboo", "cosmetics"];
const COSMETIC_SUFFIX: &str = "cosmiq";

/// Was ein Abgleich der Kontobibliothek mit den Instanzen bewirkt hat.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CosmeticMirrorReport {
    /// Neu kopierte Pakete.
    pub added: usize,
    /// Entfernte Kopien (ausgeschlossene Instanz oder gelöschtes Paket).
    pub removed: usize,
}

/// Alle `.cosmiq`-Pakete der Bibliothek als (Dateiname, Pfad).
fn cosmetic_packages(library: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(library) else {
        return Vec::new();
    };
    let mut packages: Vec<(String, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case(COSMETIC_SUFFIX))
        })
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            Some((name, entry.path()))
        })
        .collect();
    packages.sort_by(|left, right| left.0.cmp(&right.0));
    packages
}

/// Zwei Dateien mit gleichem Inhalt? Nur dann gilt eine Kopie als die unsere
/// und darf entfernt werden.
fn same_contents(left: &Path, right: &Path) -> bool {
    let (Ok(left_size), Ok(right_size)) = (std::fs::metadata(left), std::fs::metadata(right))
    else {
        return false;
    };
    if left_size.len() != right_size.len() {
        return false;
    }
    match (std::fs::read(left), std::fs::read(right)) {
        (Ok(left_bytes), Ok(right_bytes)) => left_bytes == right_bytes,
        _ => false,
    }
}

fn cosmetics_dir_of(instance: &Instance) -> PathBuf {
    COSMETICS_DIR
        .iter()
        .fold(instance.dir.clone(), |path, sub| path.join(sub))
}

/// Verteilt die Cosmetic-Pakete der Kontobibliothek in die Instanzen.
///
/// Die Mod liest `<instanz>/bamboo/cosmetics`; installiert wird also nur eine
/// Kopie pro Instanz. Ausgeschlossene Instanzen bekommen nichts Neues und
/// verlieren nur Kopien, die noch exakt der Bibliothek entsprechen – ein von
/// Hand geändertes Paket bleibt liegen.
pub fn mirror_cosmetic_packages(
    instances: &[Instance],
    library: &Path,
    excluded: &[String],
) -> CosmeticMirrorReport {
    let mut report = CosmeticMirrorReport::default();
    let packages = cosmetic_packages(library);

    for instance in instances {
        let target = cosmetics_dir_of(instance);
        let excluded_here = excluded
            .iter()
            .any(|name| name.trim().eq_ignore_ascii_case(instance.name.trim()));

        if excluded_here {
            for (file, source) in &packages {
                let copy = target.join(file);
                if same_contents(source, &copy) && std::fs::remove_file(&copy).is_ok() {
                    report.removed += 1;
                }
            }
            continue;
        }

        if packages.is_empty() || std::fs::create_dir_all(&target).is_err() {
            continue;
        }
        for (file, source) in &packages {
            let copy = target.join(file);
            if copy.exists() {
                continue;
            }
            if std::fs::copy(source, &copy).is_ok() {
                report.added += 1;
            }
        }
    }

    report
}

/// Nimmt ein gelöschtes Paket aus allen Instanzen zurück, solange die Kopie
/// noch dem gelöschten Inhalt entspricht.
pub fn forget_cosmetic_package(instances: &[Instance], file_name: &str, content: &[u8]) -> usize {
    let mut removed = 0;
    for instance in instances {
        let copy = cosmetics_dir_of(instance).join(file_name);
        if std::fs::read(&copy).ok().as_deref() == Some(content)
            && std::fs::remove_file(&copy).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// Ordner, in denen die Electron-Shell ihre Instanzen abgelegt hat.
///
/// Sie schrieb den gewählten Spielordner nach `<config>/bamboo-launcher/root`
/// und legte die Instanzen dort unter `profiles/` an. Der Rust-Kern arbeitet
/// unter `<game_root>/instances`; ohne diese Erkennung tauchen die alten
/// Instanzen nach dem Wechsel nie wieder auf.
pub fn legacy_profiles_roots(config_dir: &Path) -> Vec<PathBuf> {
    let Some(appdata) = config_dir.parent() else {
        return Vec::new();
    };
    let electron = appdata.join("bamboo-launcher");
    let mut roots: Vec<PathBuf> = Vec::new();

    fn push(roots: &mut Vec<PathBuf>, root: &Path) {
        let profiles = root.join("profiles");
        if profiles.is_dir() && !roots.iter().any(|known| known == &profiles) {
            roots.push(profiles);
        }
    }

    if let Ok(text) = std::fs::read_to_string(electron.join("root")) {
        let root = text.trim();
        if !root.is_empty() {
            push(&mut roots, Path::new(root));
        }
    }
    // Ohne Wurzeldatei ergibt sich der Ordner aus den gespeicherten Pfaden.
    if roots.is_empty() {
        if let Some(list) = read_json_file(&electron.join("instances.json")) {
            if let Some(entries) = list.get("instances").and_then(|value| value.as_array()) {
                for entry in entries {
                    let Some(path) = entry.get("path").and_then(|value| value.as_str()) else {
                        continue;
                    };
                    if let Some(root) = Path::new(path).parent().and_then(Path::parent) {
                        push(&mut roots, root);
                    }
                }
            }
        }
    }
    roots
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Ein Eintrag aus der Instanzliste der Electron-Shell.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyProfile {
    pub folder: String,
    pub name: String,
    pub version_id: Option<String>,
}

/// Anzeigenamen und Versions-IDs der alten Instanzen.
///
/// Die Ordner selbst wissen oft nur die Minecraft-Version oder tragen einen
/// falschen Namen; die Liste der Electron-Shell ist die bessere Quelle.
pub fn legacy_profiles(config_dir: &Path) -> Vec<LegacyProfile> {
    let Some(appdata) = config_dir.parent() else {
        return Vec::new();
    };
    let path = appdata.join("bamboo-launcher").join("instances.json");
    let Some(list) = read_json_file(&path) else {
        return Vec::new();
    };
    let Some(entries) = list.get("instances").and_then(|value| value.as_array()) else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|entry| {
            let folder = entry
                .get("folderName")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .or_else(|| {
                    entry
                        .get("path")
                        .and_then(|value| value.as_str())
                        .and_then(|path| Path::new(path).file_name())
                        .map(|name| name.to_string_lossy().to_string())
                })?;
            let name = entry
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&folder)
                .to_string();
            let version_id = entry
                .get("versionId")
                .and_then(|value| value.as_str())
                .or_else(|| entry.get("version").and_then(|value| value.as_str()))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Some(LegacyProfile {
                folder,
                name,
                version_id,
            })
        })
        .collect()
}

/// Liest die Metadatei; fehlt sie, entsteht ein leerer Datensatz.
fn load_meta(name: &str, dir: &Path) -> InstanceMeta {
    std::fs::read_to_string(dir.join(META_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<InstanceMeta>(&text).ok())
        .unwrap_or_else(|| InstanceMeta {
            name: name.trim().to_string(),
            version_id: None,
            version: None,
            created_at: None,
            declined_loader_update: None,
        })
}

/// Schreibt die Metadatei atomar über eine temporäre Datei.
fn store_meta(dir: &Path, meta: &InstanceMeta) -> Result<()> {
    let path = dir.join(META_FILE);
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(meta)?)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

impl InstanceManager {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            extra_roots: Vec::new(),
        }
    }

    /// Ergänzt weitere Instanzordner (etwa die Profile der Vorgänger-App).
    pub fn with_extra_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.extra_roots = roots;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn extra_roots(&self) -> &[PathBuf] {
        &self.extra_roots
    }

    /// Findet den Instanzordner: erst unter der eigenen Wurzel, dann in den
    /// zusätzlichen Ordnern. Gibt es ihn nirgends, entsteht der Pfad unter der
    /// eigenen Wurzel (so legt `create` neue Instanzen an).
    pub fn instance_dir(&self, name: &str) -> Result<PathBuf> {
        validate_instance_name(name)?;
        let primary = self.root.join(name.trim());
        if primary.is_dir() {
            return Ok(primary);
        }
        for extra in &self.extra_roots {
            let candidate = extra.join(name.trim());
            if candidate.is_dir() {
                return Ok(candidate);
            }
        }
        Ok(primary)
    }

    pub fn list(&self) -> Result<Vec<Instance>> {
        let mut instances: Vec<Instance> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let roots = std::iter::once((&self.root, false))
            .chain(self.extra_roots.iter().map(|root| (root, true)));

        for (root, extra) in roots {
            // Ein zusätzlicher Ordner darf fehlen oder gesperrt sein.
            if !root.exists() {
                continue;
            }
            let entries = match std::fs::read_dir(root) {
                Ok(entries) => entries,
                Err(_) if extra => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let path = entry.path();
                if extra && !looks_like_instance(&path) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if extra && validate_instance_name(&name).is_err() {
                    continue;
                }
                if seen.iter().any(|known| known.eq_ignore_ascii_case(&name)) {
                    continue;
                }
                seen.push(name.clone());
                let meta = load_meta(&name, &path);
                instances.push(Instance {
                    name,
                    dir: path,
                    version_id: meta.usable_version(),
                });
            }
        }
        instances.sort_by_key(|instance| instance.name.to_lowercase());
        Ok(instances)
    }

    pub fn create(&self, name: &str, version_id: Option<&str>) -> Result<Instance> {
        let dir = self.instance_dir(name)?;
        if dir.exists() {
            return Err(LauncherError::InstanceExists(name.trim().to_string()));
        }
        std::fs::create_dir_all(&dir)?;
        for sub in INSTANCE_DIRS {
            std::fs::create_dir_all(dir.join(sub))?;
        }

        let meta = InstanceMeta {
            name: name.trim().to_string(),
            version_id: version_id.map(str::to_string),
            version: None,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_secs()),
            declined_loader_update: None,
        };
        std::fs::write(dir.join(META_FILE), serde_json::to_string_pretty(&meta)?)?;

        Ok(Instance {
            name: meta.name,
            dir,
            version_id: meta.version_id,
        })
    }

    pub fn load(&self, name: &str) -> Result<Instance> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        let meta = std::fs::read_to_string(dir.join(META_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<InstanceMeta>(&text).ok());
        Ok(Instance {
            name: name.trim().to_string(),
            dir,
            version_id: meta.and_then(|meta| meta.usable_version()),
        })
    }

    /// Ändert die Versions-ID einer Instanz, etwa auf ein neu installiertes
    /// Loader-Profil. Die Metadatei wird atomar ersetzt.
    pub fn set_version(&self, name: &str, version_id: &str) -> Result<Instance> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        let mut meta = load_meta(name, &dir);
        meta.name = name.trim().to_string();
        meta.version_id = Some(version_id.to_string());
        store_meta(&dir, &meta)?;

        Ok(Instance {
            name: meta.name,
            dir,
            version_id: meta.version_id,
        })
    }

    /// Die Loader-Version, für die diese Instanz ein Update abgelehnt hat.
    pub fn declined_loader_update(&self, name: &str) -> Result<Option<String>> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        Ok(load_meta(name, &dir).declined_loader_update)
    }

    /// Merkt eine abgelehnte Loader-Version; `None` löscht die Erinnerung.
    pub fn set_declined_loader_update(&self, name: &str, version: Option<&str>) -> Result<()> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        let mut meta = load_meta(name, &dir);
        meta.name = name.trim().to_string();
        meta.declined_loader_update = version.map(str::to_string);
        store_meta(&dir, &meta)
    }

    /// Löscht eine Instanz – aber niemals das Wurzelverzeichnis selbst.
    pub fn remove(&self, name: &str) -> Result<()> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        if dir == self.root {
            return Err(LauncherError::UnsafePath(dir));
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    pub fn mods_dir(&self, name: &str) -> Result<PathBuf> {
        let dir = self.instance_dir(name)?;
        if !dir.is_dir() {
            return Err(LauncherError::InstanceNotFound(name.to_string()));
        }
        Ok(dir.join("mods"))
    }

    /// Listet alle Mod-Dateien; `.jar.disabled` gilt als deaktiviert.
    pub fn scan_mods(&self, name: &str) -> Result<Vec<ModEntry>> {
        let dir = self.mods_dir(name)?;
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut mods = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let lower = file_name.to_lowercase();
            let (enabled, metadata_source) = if lower.ends_with(DISABLED_SUFFIX) {
                (false, entry.path())
            } else if lower.ends_with(MOD_SUFFIX) {
                (true, entry.path())
            } else {
                continue;
            };

            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            mods.push(ModEntry {
                metadata: read_mod_metadata(&metadata_source).unwrap_or_default(),
                file_name,
                path: entry.path(),
                enabled,
                size,
            });
        }
        mods.sort_by_key(|entry| entry.file_name.to_lowercase());
        Ok(mods)
    }

    /// Aktiviert oder deaktiviert eine Mod durch Umbenennen der Endung.
    pub fn set_mod_enabled(&self, name: &str, file_name: &str, enabled: bool) -> Result<PathBuf> {
        let dir = self.mods_dir(name)?;
        let file_name = safe_file_name(file_name)?;
        let source = dir.join(file_name);
        if !source.is_file() {
            return Err(LauncherError::InstanceNotFound(format!(
                "{file_name} in {name}"
            )));
        }
        let lower = file_name.to_lowercase();

        let target = if enabled {
            if !lower.ends_with(DISABLED_SUFFIX) {
                return Ok(source);
            }
            dir.join(&file_name[..file_name.len() - ".disabled".len()])
        } else {
            if lower.ends_with(DISABLED_SUFFIX) {
                return Ok(source);
            }
            if !lower.ends_with(MOD_SUFFIX) {
                return Err(LauncherError::InvalidInstanceName(format!(
                    "{file_name} ist keine Mod-Datei."
                )));
            }
            dir.join(format!("{file_name}.disabled"))
        };

        std::fs::rename(&source, &target)?;
        Ok(target)
    }

    pub fn delete_mod(&self, name: &str, file_name: &str) -> Result<()> {
        let dir = self.mods_dir(name)?;
        let file_name = safe_file_name(file_name)?;
        let target = dir.join(file_name);
        if !target.is_file() {
            return Err(LauncherError::InstanceNotFound(format!(
                "{file_name} in {name}"
            )));
        }
        std::fs::remove_file(target)?;
        Ok(())
    }
}

/// Liest Name/ID/Version aus `fabric.mod.json` oder `quilt.mod.json`.
pub fn read_mod_metadata(path: &Path) -> Option<ModMetadata> {
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    for candidate in ["fabric.mod.json", "quilt.mod.json"] {
        let Ok(mut entry) = archive.by_name(candidate) else {
            continue;
        };
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_err() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        let id = json
            .get("id")
            .and_then(|value| value.as_str())
            .or_else(|| {
                json.get("quilt_loader")
                    .and_then(|loader| loader.get("id"))
                    .and_then(|value| value.as_str())
            })
            .map(str::to_string);
        let version = json
            .get("version")
            .and_then(|value| value.as_str())
            .or_else(|| {
                json.get("quilt_loader")
                    .and_then(|loader| loader.get("version"))
                    .and_then(|value| value.as_str())
            })
            .map(str::to_string);
        let name = json
            .get("name")
            .and_then(|value| value.as_str())
            .or_else(|| {
                json.get("metadata")
                    .and_then(|meta| meta.get("name"))
                    .and_then(|value| value.as_str())
            })
            .map(str::to_string);

        return Some(ModMetadata { id, name, version });
    }

    for candidate in ["META-INF/mods.toml", "META-INF/neoforge.mods.toml"] {
        let Ok(mut entry) = archive.by_name(candidate) else {
            continue;
        };
        let mut text = String::new();
        if entry.read_to_string(&mut text).is_err() {
            continue;
        }
        return Some(forge_metadata(&text));
    }

    None
}

/// `mods.toml` ist TOML; für Name, ID und Version genügt das Zeilenformat
/// `key="value"` im ersten `[[mods]]`-Block. Ein TOML-Parser wäre für diese
/// drei Felder zu viel.
fn forge_metadata(text: &str) -> ModMetadata {
    let mut metadata = ModMetadata::default();
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']);
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "modId" if metadata.id.is_none() => metadata.id = Some(value.to_string()),
            "version" if metadata.version.is_none() => metadata.version = Some(value.to_string()),
            "displayName" if metadata.name.is_none() => metadata.name = Some(value.to_string()),
            _ => {}
        }
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_root() -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bamboo-test-{}-{}-{id}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_name_version_and_id_from_mods_toml() {
        let metadata = forge_metadata(
            "modLoader=\"javafml\"\nloaderVersion=\"[47,)\"\n[[mods]]\nmodId=\"jei\"\nversion=\"15.2.0.27\"\ndisplayName=\"Just Enough Items\"\n\n[[dependencies.jei]]\nmodId=\"minecraft\"\nversionRange=\"[1.20.1,1.21)\"\n",
        );
        assert_eq!(metadata.id.as_deref(), Some("jei"));
        assert_eq!(metadata.name.as_deref(), Some("Just Enough Items"));
        assert_eq!(metadata.version.as_deref(), Some("15.2.0.27"));
    }

    #[test]
    fn validates_instance_names() {
        assert!(validate_instance_name("Survival").is_ok());
        assert!(validate_instance_name("Modpack 1.20").is_ok());
        assert!(validate_instance_name("").is_err());
        assert!(validate_instance_name("..").is_err());
        assert!(validate_instance_name("../boese").is_err());
        assert!(validate_instance_name("a/b").is_err());
        assert!(validate_instance_name("a\\b").is_err());
        assert!(validate_instance_name("CON").is_err());
        assert!(validate_instance_name("name.").is_err());
    }

    #[test]
    fn creates_scans_and_removes_instance() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);

        let instance = manager.create("Test", Some("1.20.1")).unwrap();
        assert_eq!(instance.version_id.as_deref(), Some("1.20.1"));
        for sub in INSTANCE_DIRS {
            assert!(instance.dir.join(sub).is_dir(), "{sub} fehlt");
        }
        assert!(manager.create("Test", None).is_err());

        let listed = manager.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Test");

        manager.remove("Test").unwrap();
        assert!(manager.list().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updates_the_version_of_an_instance() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);
        manager.create("Test", Some("1.20.1")).unwrap();

        let updated = manager
            .set_version("Test", "fabric-loader-0.16.10-1.20.1")
            .unwrap();
        assert_eq!(
            updated.version_id.as_deref(),
            Some("fabric-loader-0.16.10-1.20.1")
        );
        assert_eq!(
            manager.load("Test").unwrap().version_id.as_deref(),
            Some("fabric-loader-0.16.10-1.20.1")
        );
        assert!(manager.set_version("Fehlt", "1.20.1").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remembers_a_declined_loader_update() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);
        manager
            .create("Test", Some("fabric-loader-0.16.9-1.20.1"))
            .unwrap();

        assert_eq!(manager.declined_loader_update("Test").unwrap(), None);
        manager
            .set_declined_loader_update("Test", Some("0.16.10"))
            .unwrap();
        assert_eq!(
            manager.declined_loader_update("Test").unwrap().as_deref(),
            Some("0.16.10")
        );

        // Ein neues Profil (Update) darf die Erinnerung nicht verlieren.
        manager
            .set_version("Test", "fabric-loader-0.16.10-1.20.1")
            .unwrap();
        assert_eq!(
            manager.declined_loader_update("Test").unwrap().as_deref(),
            Some("0.16.10")
        );

        manager.set_declined_loader_update("Test", None).unwrap();
        assert_eq!(manager.declined_loader_update("Test").unwrap(), None);
        assert!(manager
            .set_declined_loader_update("Fehlt", Some("0.16.10"))
            .is_err());

        // Ältere Instanzdateien ohne das neue Feld bleiben lesbar.
        std::fs::write(
            root.join("Test").join(META_FILE),
            r#"{"name":"Test","version_id":"1.20.1","created_at":null}"#,
        )
        .unwrap();
        assert_eq!(manager.declined_loader_update("Test").unwrap(), None);
        assert_eq!(
            manager.load("Test").unwrap().version_id.as_deref(),
            Some("1.20.1")
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn toggles_mod_state_by_renaming() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);
        manager.create("Test", None).unwrap();
        let mods = manager.mods_dir("Test").unwrap();
        std::fs::write(mods.join("example.jar"), b"nicht wirklich ein jar").unwrap();
        std::fs::write(mods.join("notiz.txt"), b"ignorieren").unwrap();

        let scanned = manager.scan_mods("Test").unwrap();
        assert_eq!(scanned.len(), 1);
        assert!(scanned[0].enabled);

        manager
            .set_mod_enabled("Test", "example.jar", false)
            .unwrap();
        let scanned = manager.scan_mods("Test").unwrap();
        assert_eq!(scanned[0].file_name, "example.jar.disabled");
        assert!(!scanned[0].enabled);

        manager
            .set_mod_enabled("Test", "example.jar.disabled", true)
            .unwrap();
        assert!(mods.join("example.jar").is_file());

        manager.delete_mod("Test", "example.jar").unwrap();
        assert!(manager.scan_mods("Test").unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_instances_from_extra_roots_and_skips_empty_folders() {
        let root = temp_root();
        let primary = root.join("instances");
        let profiles = root.join("profiles");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::create_dir_all(profiles.join("furry_smp").join("mods")).unwrap();
        std::fs::write(
            profiles.join("furry_smp").join(META_FILE),
            r#"{"name":"Furry SMP","version":"26.3"}"#,
        )
        .unwrap();
        std::fs::write(profiles.join("furry_smp").join("mods").join("a.jar"), b"x").unwrap();
        // Halb angelegte Testordner ohne Inhalt gehören nicht in die Liste.
        std::fs::create_dir_all(profiles.join("asdads")).unwrap();
        std::fs::create_dir_all(profiles.join("re")).unwrap();

        let manager = InstanceManager::new(&primary).with_extra_roots(vec![profiles.clone()]);
        let listed = manager.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "furry_smp");
        assert_eq!(listed[0].version_id.as_deref(), Some("26.3"));
        assert_eq!(listed[0].dir, profiles.join("furry_smp"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_an_instance_from_an_extra_root() {
        let root = temp_root();
        let primary = root.join("instances");
        let profiles = root.join("profiles");
        std::fs::create_dir_all(profiles.join("26_3")).unwrap();
        std::fs::write(profiles.join("26_3").join("options.txt"), "lang:de_de\n").unwrap();

        let manager = InstanceManager::new(&primary).with_extra_roots(vec![profiles.clone()]);
        assert_eq!(manager.instance_dir("26_3").unwrap(), profiles.join("26_3"));
        // Ein neuer Name entsteht weiterhin im verwalteten Ordner.
        assert_eq!(manager.instance_dir("Neu").unwrap(), primary.join("Neu"));
        assert!(manager.load("26_3").unwrap().dir.is_dir());

        // Ein Name aus dem fremden Ordner darf nicht doppelt entstehen.
        assert!(manager.create("26_3", None).is_err());

        // Der Inhalt bleibt zwei Ebenen über dem Instanzordner.
        assert_eq!(content_root(&profiles.join("26_3")), Some(root.clone()));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_the_profiles_folder_of_the_previous_app() {
        let appdata = temp_root();
        let config = appdata.join("BambooLauncher");
        let electron = appdata.join("bamboo-launcher");
        let old_root = appdata.join("BambooLaufwerk");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&electron).unwrap();
        std::fs::create_dir_all(old_root.join("profiles").join("26_3")).unwrap();

        // Wurzeldatei zeigt woanders hin: nichts übernehmen.
        std::fs::write(
            electron.join("root"),
            appdata.join("gibt-es-nicht").to_string_lossy().as_bytes(),
        )
        .unwrap();
        assert!(legacy_profiles_roots(&config).is_empty());

        // Wurzeldatei mit `profiles/` darin wird erkannt.
        std::fs::write(electron.join("root"), old_root.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(
            legacy_profiles_roots(&config),
            vec![old_root.join("profiles")]
        );

        // Ohne Wurzeldatei zählt die gespeicherte Instanzliste.
        std::fs::remove_file(electron.join("root")).unwrap();
        let list = serde_json::json!({
            "instances": [{ "path": old_root.join("profiles").join("26_3") }]
        });
        std::fs::write(
            electron.join("instances.json"),
            serde_json::to_string(&list).unwrap(),
        )
        .unwrap();
        assert_eq!(
            legacy_profiles_roots(&config),
            vec![old_root.join("profiles")]
        );

        std::fs::remove_dir_all(appdata).unwrap();
    }

    #[test]
    fn rejects_path_traversal_in_mod_names() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);
        manager.create("Test", None).unwrap();
        assert!(manager.delete_mod("Test", "../instance.json").is_err());
        assert!(manager.set_mod_enabled("Test", "../x.jar", true).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mirrors_cosmetics_but_skips_excluded_instances() {
        let root = temp_root();
        let manager = InstanceManager::new(&root);
        manager.create("Furry", None).unwrap();
        manager.create("Vanilla", None).unwrap();
        manager.create("Eigene", None).unwrap();
        // Die Bibliothek liegt außerhalb der Instanzwurzel, wie im Launcher.
        let library = temp_root();
        std::fs::create_dir_all(&library).unwrap();
        std::fs::write(library.join("bird-cape.cosmiq"), b"paket").unwrap();
        std::fs::write(library.join("notiz.txt"), b"ignorieren").unwrap();
        // Ein selbst gebautes Paket in einer ausgeschlossenen Instanz bleibt.
        let own = root.join("Eigene").join("bamboo").join("cosmetics");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("bird-cape.cosmiq"), b"eigene version").unwrap();

        let instances = manager.list().unwrap();
        let report = mirror_cosmetic_packages(
            &instances,
            &library,
            &["vanilla".to_string(), "eigene".to_string()],
        );
        assert_eq!(report.added, 1);
        assert_eq!(report.removed, 0);
        assert!(root
            .join("Furry")
            .join("bamboo")
            .join("cosmetics")
            .join("bird-cape.cosmiq")
            .is_file());
        assert!(!root
            .join("Vanilla")
            .join("bamboo")
            .join("cosmetics")
            .exists());
        assert_eq!(
            std::fs::read(own.join("bird-cape.cosmiq")).unwrap(),
            b"eigene version"
        );

        // Zweiter Lauf kopiert nichts doppelt.
        assert_eq!(
            mirror_cosmetic_packages(&manager.list().unwrap(), &library, &[]).added,
            1
        );

        // Ausschluss entfernt nur die unveränderte Kopie.
        let report = mirror_cosmetic_packages(
            &manager.list().unwrap(),
            &library,
            &["Furry".to_string(), "Eigene".to_string()],
        );
        assert_eq!(report.removed, 1);
        assert!(!root
            .join("Furry")
            .join("bamboo")
            .join("cosmetics")
            .join("bird-cape.cosmiq")
            .exists());
        assert_eq!(
            std::fs::read(own.join("bird-cape.cosmiq")).unwrap(),
            b"eigene version"
        );

        // Ein gelöschtes Paket verschwindet aus allen Instanzen, die unsere Kopie haben.
        assert_eq!(
            mirror_cosmetic_packages(&manager.list().unwrap(), &library, &[]).added,
            1
        );
        assert_eq!(
            forget_cosmetic_package(&manager.list().unwrap(), "bird-cape.cosmiq", b"paket"),
            2
        );

        std::fs::remove_dir_all(&library).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
