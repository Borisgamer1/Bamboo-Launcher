//! Prüfung vor dem Start: Was würde das Spiel mit diesem `mods`-Ordner tun?
//!
//! Die Analyse nach einem Absturz erklärt im Nachhinein, was schiefging. Diese
//! Prüfung liest die JAR-Metadaten vor dem Start und findet die drei häufigen
//! Startblocker: dieselbe Mod in mehreren Versionen, fehlende Pflicht-
//! abhängigkeiten und Mods für einen anderen Loader oder eine andere
//! Minecraft-Version.
//!
//! Abhängigkeiten, die der Loader selbst mitbringt (etwa MixinExtras in
//! Fabric Loader 0.15+ oder NeoForge) oder die als JAR im Mod liegen, gelten
//! als vorhanden und werden nicht als fehlend gemeldet.
//!
//! Die Prüfung blockiert nichts. Sie liefert Befunde, aus denen die Oberfläche
//! „Deaktivieren“ oder „Trotzdem starten“ anbieten kann. Fehlende Metadaten
//! oder unbekannte Versionsbereiche führen bewusst zu keinem Befund: Ein
//! falscher Alarm wäre schlimmer als eine übersehene Mod.

use crate::mods::Loader;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

/// Abhängigkeiten, die der Loader selbst bereitstellt und die deshalb nie als
/// fehlende Mod gemeldet werden dürfen.
const PLATFORM_DEPENDENCIES: &[&str] = &[
    "minecraft",
    "java",
    "forge",
    "neoforge",
    "fml",
    "fabric",
    "fabricloader",
    "fabric-loader",
    "fabric_loader",
    "quilt",
    "quilt_loader",
    "quilt-loader",
    "javafml",
    "lowcodefml",
    "fmluserdev",
    "fmluserdev1",
    "mcp",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ModFamily {
    Fabric,
    Forge,
    Quilt,
}

impl ModFamily {
    fn label(self) -> &'static str {
        match self {
            Self::Fabric => "Fabric",
            Self::Forge => "Forge",
            Self::Quilt => "Quilt",
        }
    }
}

#[derive(Debug, Clone)]
struct Requirement {
    id: String,
}

#[derive(Debug, Clone)]
struct ModInfo {
    file: String,
    id: String,
    name: String,
    version: Option<String>,
    family: ModFamily,
    provides: Vec<String>,
    /// IDs und `provides`-Einträge der im Mod gebündelten JARs. Sie zählen als
    /// installiert, werden aber nicht selbst auf Duplikate geprüft: Der Loader
    /// lädt sie nur über den äußeren Mod.
    bundled: Vec<String>,
    requires: Vec<Requirement>,
    minecraft_ranges: Vec<String>,
    modified: Option<SystemTime>,
}

impl ModInfo {
    fn label(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.file
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightIssue {
    /// Stabiler Bezeichner für die Oberfläche, z. B. `duplicate-mod`.
    pub kind: String,
    /// `error` oder `warning`.
    pub severity: String,
    pub title: String,
    pub detail: String,
    /// Dateien, die ein Klick auf „Deaktivieren“ umbenennen würde.
    pub disable: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub checked_mods: usize,
    pub issues: Vec<PreflightIssue>,
}

/// Prüft den `mods`-Ordner gegen den Loader und die Minecraft-Version der
/// Instanz. `minecraft_version` darf leer sein, dann entfallen die
/// Versionsprüfungen.
pub fn check(mods_dir: &Path, loader: Option<Loader>, minecraft_version: &str) -> PreflightReport {
    let mods = scan_mods(mods_dir);
    let mut issues = Vec::new();

    issues.extend(duplicate_issues(&mods));
    issues.extend(loader_issues(&mods, loader));
    issues.extend(minecraft_issues(&mods, minecraft_version));
    issues.extend(missing_dependency_issues(&mods, loader));

    issues.sort_by(|left, right| {
        severity_rank(&left.severity)
            .cmp(&severity_rank(&right.severity))
            .then_with(|| left.title.cmp(&right.title))
    });

    PreflightReport {
        checked_mods: mods.len(),
        issues,
    }
}

fn severity_rank(severity: &str) -> u8 {
    if severity == "error" {
        0
    } else {
        1
    }
}

fn issue(
    kind: &str,
    severity: &str,
    title: String,
    detail: String,
    disable: Vec<String>,
) -> PreflightIssue {
    PreflightIssue {
        kind: kind.to_string(),
        severity: severity.to_string(),
        title,
        detail,
        disable,
    }
}

// ---------------------------------------------------------------------------
// JAR-Metadaten
// ---------------------------------------------------------------------------

fn scan_mods(mods_dir: &Path) -> Vec<ModInfo> {
    let Ok(entries) = std::fs::read_dir(mods_dir) else {
        return Vec::new();
    };
    let mut mods = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".jar") || !path.is_file() {
            continue;
        }
        if let Some(info) = read_mod(&path, &name) {
            mods.push(info);
        }
    }
    mods.sort_by(|left, right| left.file.to_lowercase().cmp(&right.file.to_lowercase()));
    mods
}

fn read_mod(path: &Path, file: &str) -> Option<ModInfo> {
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok();
    let archive = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(archive).ok()?;
    let mut info = read_metadata(&mut archive, file)?;
    info.modified = modified;
    info.bundled = bundled_ids(&mut archive);
    Some(info)
}

/// Liest die Mod-Identität aus den Metadatendateien eines Archivs. Das gilt
/// auch für gebündelte JARs; `modified` und `bundled` füllt der Aufrufer.
fn read_metadata<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    file: &str,
) -> Option<ModInfo> {
    if let Some(text) = read_entry(archive, "fabric.mod.json") {
        if let Some(info) = fabric_mod(&text, file, ModFamily::Fabric) {
            return Some(info);
        }
    }
    if let Some(text) = read_entry(archive, "quilt.mod.json") {
        if let Some(info) = quilt_mod(&text, file) {
            return Some(info);
        }
    }
    for (entry, family) in [
        ("META-INF/neoforge.mods.toml", ModFamily::Forge),
        ("META-INF/mods.toml", ModFamily::Forge),
    ] {
        if let Some(text) = read_entry(archive, entry) {
            if let Some(info) = forge_mod(&text, file, family) {
                return Some(info);
            }
        }
    }
    None
}

fn read_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// Pfade, unter denen die Loader gebündelte JARs ablegen: Fabric/Quilt
/// (`META-INF/jars/`), Forge/NeoForge JarJar (`META-INF/jarjar/`) und ältere
/// Forge-Bundles (`META-INF/libraries/`).
const BUNDLED_JAR_PREFIXES: [&str; 3] =
    ["meta-inf/jars/", "meta-inf/jarjar/", "meta-inf/libraries/"];
const MAX_BUNDLED_JARS: usize = 128;
const MAX_NESTED_JAR_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BUNDLED_BYTES: u64 = 64 * 1024 * 1024;

/// Sammelt die Mod-IDs der JARs, die im äußeren Mod liegen. Nur ein Level
/// tief: Ein gebündeltes JAR wird nicht selbst wieder nach JARs durchsucht.
fn bundled_ids<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
    let mut ids = Vec::new();
    let mut found = 0usize;
    let mut total_bytes = 0u64;

    for index in 0..archive.len() {
        if found >= MAX_BUNDLED_JARS {
            break;
        }
        let entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.is_file() {
            continue;
        }
        let Ok(path) = entry.name() else {
            continue;
        };
        let path = path.to_string();
        let lower = path.to_ascii_lowercase();
        if !lower.ends_with(".jar")
            || !BUNDLED_JAR_PREFIXES
                .iter()
                .any(|prefix| lower.starts_with(prefix))
        {
            continue;
        }
        found += 1;

        let mut bytes = Vec::new();
        if entry
            .take(MAX_NESTED_JAR_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_NESTED_JAR_BYTES
        {
            continue;
        }
        total_bytes += bytes.len() as u64;
        if total_bytes > MAX_BUNDLED_BYTES {
            break;
        }
        let Ok(mut nested) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
            continue;
        };
        if let Some(info) = read_metadata(&mut nested, &path) {
            if !info.id.trim().is_empty() {
                ids.push(info.id);
            }
            ids.extend(info.provides);
        }
    }

    ids
}

fn string_list(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(text) => vec![text.clone()],
        serde_json::Value::Array(values) => values.iter().flat_map(string_list).collect(),
        serde_json::Value::Object(object) => ["id", "version", "versions"]
            .iter()
            .find_map(|key| object.get(*key))
            .map(string_list)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn fabric_mod(text: &str, file: &str, family: ModFamily) -> Option<ModInfo> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let id = json.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let name = json
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let version = json
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let mut requires = Vec::new();
    let mut minecraft_ranges = Vec::new();
    if let Some(depends) = json.get("depends").and_then(serde_json::Value::as_object) {
        for (dependency, value) in depends {
            if dependency.eq_ignore_ascii_case("minecraft") {
                minecraft_ranges.extend(string_list(value));
            } else if dependency.eq_ignore_ascii_case("java") || is_platform_dependency(dependency)
            {
                continue;
            } else {
                requires.push(Requirement {
                    id: dependency.clone(),
                });
            }
        }
    }

    let provides = json
        .get("provides")
        .map(string_list)
        .unwrap_or_default()
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect();

    Some(ModInfo {
        file: file.to_string(),
        id,
        name,
        version,
        family,
        provides,
        bundled: Vec::new(),
        requires,
        minecraft_ranges,
        modified: None,
    })
}

fn quilt_mod(text: &str, file: &str) -> Option<ModInfo> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let loader = json.get("quilt_loader")?;
    let id = loader.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let name = loader
        .get("metadata")
        .and_then(|meta| meta.get("name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let version = loader
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    let mut requires = Vec::new();
    let mut minecraft_ranges = Vec::new();
    if let Some(depends) = loader.get("depends").and_then(serde_json::Value::as_array) {
        for dependency in depends {
            let Some(dep_id) = dependency.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let optional = dependency
                .get("optional")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if dep_id.eq_ignore_ascii_case("minecraft") {
                if let Some(ranges) = dependency.get("versions") {
                    minecraft_ranges.extend(string_list(ranges));
                }
            } else if dep_id.eq_ignore_ascii_case("java")
                || dep_id.eq_ignore_ascii_case("quilt_loader")
                || is_platform_dependency(dep_id)
                || optional
            {
                continue;
            } else {
                requires.push(Requirement {
                    id: dep_id.to_string(),
                });
            }
        }
    }

    let provides = loader
        .get("provides")
        .map(string_list)
        .unwrap_or_default()
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect();

    Some(ModInfo {
        file: file.to_string(),
        id,
        name,
        version,
        family: ModFamily::Quilt,
        provides,
        bundled: Vec::new(),
        requires,
        minecraft_ranges,
        modified: None,
    })
}

/// Liest die Felder, die für die Startprüfung zählen, aus `mods.toml`.
/// Mehrere `[[mods]]`-Blöcke in einer JAR sind selten; der erste liefert die
/// Identität, alle `[[dependencies.…]]`-Blöcke die Anforderungen.
fn forge_mod(text: &str, file: &str, family: ModFamily) -> Option<ModInfo> {
    #[derive(Default)]
    struct Dependency {
        id: String,
        range: String,
        required: bool,
        server_side: bool,
    }

    let mut id = String::new();
    let mut name = String::new();
    let mut version = None;
    let mut provides: Vec<String> = Vec::new();
    let mut dependencies: Vec<Dependency> = Vec::new();
    let mut section = String::new();
    let mut current: Option<Dependency> = None;

    let flush = |current: &mut Option<Dependency>, dependencies: &mut Vec<Dependency>| {
        if let Some(dependency) = current.take() {
            if !dependency.id.trim().is_empty() {
                dependencies.push(dependency);
            }
        }
    };

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("[[") {
            flush(&mut current, &mut dependencies);
            let header = line.trim_matches(|ch| ch == '[' || ch == ']').trim();
            if header == "mods" {
                section = "mods".to_string();
                if name.is_empty() {
                    name = id.clone();
                }
            } else if header.starts_with("dependencies.") {
                section = "dependencies".to_string();
                current = Some(Dependency {
                    required: true,
                    ..Dependency::default()
                });
            } else {
                section = "other".to_string();
            }
            continue;
        }
        if line.starts_with('[') {
            flush(&mut current, &mut dependencies);
            section = "other".to_string();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value
            .trim()
            .trim_matches(|ch| ch == '"' || ch == '\'')
            .to_string();
        if value.is_empty() {
            continue;
        }
        match section.as_str() {
            "mods" => match key {
                // Eine JAR darf mehrere Mods enthalten; alle IDs zählen als
                // vorhanden, sonst meldet die Prüfung ihre Abhängigkeiten
                // fälschlich als fehlend.
                "modId" if id.is_empty() => id = value,
                "modId" => provides.push(value),
                "displayName" if name.is_empty() || name == id => name = value,
                "version" if version.is_none() => version = Some(value),
                _ => {}
            },
            "dependencies" => {
                let Some(dependency) = current.as_mut() else {
                    continue;
                };
                match key {
                    "modId" => dependency.id = value,
                    "versionRange" => dependency.range = value,
                    "mandatory" => {
                        dependency.required = !value.eq_ignore_ascii_case("false");
                    }
                    "type" => {
                        // NeoForge nutzt type statt mandatory.
                        dependency.required = value.eq_ignore_ascii_case("required");
                    }
                    "side" => {
                        dependency.server_side = value.eq_ignore_ascii_case("server");
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    flush(&mut current, &mut dependencies);

    let id = id.trim().to_string();
    if id.is_empty() {
        return None;
    }
    if name.trim().is_empty() {
        name = id.clone();
    }

    let mut requires = Vec::new();
    let mut minecraft_ranges = Vec::new();
    for dependency in dependencies {
        if dependency.id.eq_ignore_ascii_case("minecraft") {
            if !dependency.range.is_empty() {
                minecraft_ranges.push(dependency.range);
            }
            continue;
        }
        if !dependency.required || dependency.server_side || is_platform_dependency(&dependency.id)
        {
            continue;
        }
        requires.push(Requirement { id: dependency.id });
    }

    Some(ModInfo {
        file: file.to_string(),
        id,
        name,
        version,
        family,
        provides,
        bundled: Vec::new(),
        requires,
        minecraft_ranges,
        modified: None,
    })
}

fn is_platform_dependency(id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    PLATFORM_DEPENDENCIES.contains(&id.as_str())
}

/// IDs, die der jeweilige Loader selbst mitbringt. MixinExtras ist seit
/// Fabric Loader 0.15 enthalten und gehört bei NeoForge zum Loader; Forge
/// liefert es nicht mit, dort bleibt die Abhängigkeit echt.
fn loader_provides(loader: Option<Loader>, id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    matches!(
        (loader, id.as_str()),
        (
            Some(Loader::Fabric | Loader::Quilt | Loader::NeoForge),
            "mixinextras"
        )
    )
}

// ---------------------------------------------------------------------------
// Befunde
// ---------------------------------------------------------------------------

fn loader_compatible(loader: Option<Loader>, family: ModFamily) -> bool {
    match (loader, family) {
        (Some(Loader::Fabric), ModFamily::Fabric) => true,
        (Some(Loader::Quilt), ModFamily::Fabric | ModFamily::Quilt) => true,
        (Some(Loader::Forge), ModFamily::Forge) => true,
        (Some(Loader::NeoForge), ModFamily::Forge) => true,
        _ => false,
    }
}

fn loader_issues(mods: &[ModInfo], loader: Option<Loader>) -> Vec<PreflightIssue> {
    let mut groups: HashMap<ModFamily, Vec<&ModInfo>> = HashMap::new();
    for module in mods {
        if loader_compatible(loader, module.family) {
            continue;
        }
        groups.entry(module.family).or_default().push(module);
    }

    let mut issues = Vec::new();
    for (family, group) in groups {
        let mut files: Vec<String> = group.iter().map(|module| module.file.clone()).collect();
        files.sort_by_key(|name| name.to_lowercase());
        let shown: Vec<String> = files.iter().take(4).cloned().collect();
        let more = files.len().saturating_sub(shown.len());
        let list = if more > 0 {
            format!("{}, … (+{more})", shown.join(", "))
        } else {
            shown.join(", ")
        };
        let (title, detail) = match loader {
            None => (
                "Mods in einer Vanilla-Instanz".to_string(),
                format!(
                    "{} Mod(s) liegen im mods-Ordner, aber die Instanz startet ohne Modloader: {list}.",
                    files.len()
                ),
            ),
            Some(loader) => (
                format!("Mods für {}", family.label()),
                format!(
                    "{} Datei(en) gehören zu {}, die Instanz nutzt {}: {list}.",
                    files.len(),
                    family.label(),
                    loader.label()
                ),
            ),
        };
        issues.push(issue("loader-mismatch", "error", title, detail, files));
    }
    issues
}

fn duplicate_issues(mods: &[ModInfo]) -> Vec<PreflightIssue> {
    let mut by_id: HashMap<String, Vec<&ModInfo>> = HashMap::new();
    for module in mods {
        if module.id.trim().is_empty() {
            continue;
        }
        by_id
            .entry(module.id.to_ascii_lowercase())
            .or_default()
            .push(module);
    }

    let mut issues = Vec::new();
    for (id, group) in by_id {
        if group.len() < 2 {
            continue;
        }
        let keep = newest(&group);
        let mut disable: Vec<String> = group
            .iter()
            .filter(|module| module.file != keep.file)
            .map(|module| module.file.clone())
            .collect();
        disable.sort_by_key(|name| name.to_lowercase());
        let kept = keep
            .version
            .as_deref()
            .map(|version| format!("{} ({version})", keep.file))
            .unwrap_or_else(|| keep.file.clone());
        issues.push(issue(
            "duplicate-mod",
            "error",
            format!("Mod doppelt installiert: {}", keep.label()),
            format!(
                "Mehrere Dateien liefern die Mod-ID ‚{id}‘. Behalten wird {kept}; die anderen werden beim Deaktivieren umbenannt."
            ),
            disable,
        ));
    }
    issues
}

/// Behält die höchste lesbare Version; bei Gleichstand die zuletzt geänderte
/// Datei. Das ist die beste Vermutung, welche Version der Nutzer wollte.
fn newest<'a>(group: &[&'a ModInfo]) -> &'a ModInfo {
    group
        .iter()
        .copied()
        .max_by(|left, right| {
            let left_version = left.version.as_deref().and_then(parse_version);
            let right_version = right.version.as_deref().and_then(parse_version);
            match (left_version, right_version) {
                (Some(left_version), Some(right_version)) => {
                    compare_versions(&left_version, &right_version)
                        .then_with(|| left.modified.cmp(&right.modified))
                }
                _ => left
                    .modified
                    .cmp(&right.modified)
                    .then_with(|| left.file.cmp(&right.file)),
            }
        })
        .expect("group is never empty")
}

fn missing_dependency_issues(mods: &[ModInfo], loader: Option<Loader>) -> Vec<PreflightIssue> {
    let installed: HashSet<String> = mods
        .iter()
        .flat_map(|module| {
            std::iter::once(module.id.to_ascii_lowercase())
                .chain(module.provides.iter().map(|id| id.to_ascii_lowercase()))
                .chain(module.bundled.iter().map(|id| id.to_ascii_lowercase()))
        })
        .collect();

    let mut missing: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for module in mods {
        for requirement in &module.requires {
            let id = requirement.id.trim();
            if id.is_empty()
                || id.eq_ignore_ascii_case("minecraft")
                || id.eq_ignore_ascii_case("java")
                || is_platform_dependency(id)
                || loader_provides(loader, id)
            {
                continue;
            }
            if !installed.contains(&id.to_ascii_lowercase()) {
                missing
                    .entry(id.to_string())
                    .or_default()
                    .push(module.label().to_string());
            }
        }
    }

    missing
        .into_iter()
        .map(|(id, mut dependents)| {
            dependents.sort_by_key(|name| name.to_lowercase());
            dependents.dedup();
            let shown: Vec<String> = dependents.iter().take(5).cloned().collect();
            let more = dependents.len().saturating_sub(shown.len());
            let list = if more > 0 {
                format!("{}, … (+{more})", shown.join(", "))
            } else {
                shown.join(", ")
            };
            issue(
                "missing-dependency",
                "error",
                format!("Fehlende Abhängigkeit: {id}"),
                format!("{list} benötigen ‚{id}‘, aber keine installierte Mod stellt sie bereit."),
                Vec::new(),
            )
        })
        .collect()
}

fn minecraft_issues(mods: &[ModInfo], minecraft_version: &str) -> Vec<PreflightIssue> {
    if minecraft_version.trim().is_empty() {
        return Vec::new();
    }
    let mut issues = Vec::new();
    for module in mods {
        if module.minecraft_ranges.is_empty() {
            continue;
        }
        // Mehrere Einträge sind Alternativen, keine UND-Verknüpfung: Ein Mod
        // listet z. B. `["1.20.1", "1.20.2"]`, wenn ihm beide reichen. Ein
        // Befund entsteht nur, wenn keine der auswertbaren Angaben passt.
        let checks: Vec<bool> = module
            .minecraft_ranges
            .iter()
            .filter_map(|range| satisfies(minecraft_version, range))
            .collect();
        if checks.is_empty() || checks.iter().any(|matches| *matches) {
            continue;
        }
        let ranges = module.minecraft_ranges.join(" / ");
        issues.push(issue(
            "minecraft-mismatch",
            "warning",
            format!("Mod für eine andere Minecraft-Version: {}", module.label()),
            format!(
                "{} verlangt Minecraft {ranges}, die Instanz nutzt {minecraft_version}.",
                module.file
            ),
            vec![module.file.clone()],
        ));
    }
    issues
}

// ---------------------------------------------------------------------------
// Versionsbereiche
// ---------------------------------------------------------------------------

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in value.split('.') {
        if part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        parts.push(part.parse().ok()?);
    }
    (!parts.is_empty()).then_some(parts)
}

fn compare_versions(left: &[u64], right: &[u64]) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

/// Prüft eine Version gegen einen Versionsbereich. `None` heißt „nicht
/// auswertbar“ und darf nie zu einem Befund führen.
fn satisfies(version: &str, range: &str) -> Option<bool> {
    let version = parse_version(version)?;
    let range = range.trim();
    if range.is_empty() || range == "*" {
        return Some(true);
    }
    if range.starts_with('[') || range.starts_with('(') {
        return maven_satisfies(&version, range);
    }

    let tokens: Vec<&str> = range
        .split(|ch: char| ch.is_whitespace() || ch == ',')
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    for token in tokens {
        if !single_constraint(&version, token)? {
            return Some(false);
        }
    }
    Some(true)
}

fn maven_satisfies(version: &[u64], range: &str) -> Option<bool> {
    let lower_inclusive = range.starts_with('[');
    let upper_inclusive = range.ends_with(']');
    if range.len() < 2 {
        return None;
    }
    let inner = &range[1..range.len() - 1];
    let Some((low, high)) = inner.split_once(',') else {
        let exact = parse_version(inner)?;
        return Some(compare_versions(version, &exact) == Ordering::Equal);
    };
    if !low.trim().is_empty() {
        let low = parse_version(low)?;
        let ordering = compare_versions(version, &low);
        let inside = if lower_inclusive {
            ordering != Ordering::Less
        } else {
            ordering == Ordering::Greater
        };
        if !inside {
            return Some(false);
        }
    }
    if !high.trim().is_empty() {
        let high = parse_version(high)?;
        let ordering = compare_versions(version, &high);
        let inside = if upper_inclusive {
            ordering != Ordering::Greater
        } else {
            ordering == Ordering::Less
        };
        if !inside {
            return Some(false);
        }
    }
    Some(true)
}

fn single_constraint(version: &[u64], token: &str) -> Option<bool> {
    let token = token.trim();
    if token.is_empty() || token == "*" {
        return Some(true);
    }
    let (operator, value) = if let Some(rest) = token.strip_prefix(">=") {
        (">=", rest)
    } else if let Some(rest) = token.strip_prefix("<=") {
        ("<=", rest)
    } else if let Some(rest) = token.strip_prefix('>') {
        (">", rest)
    } else if let Some(rest) = token.strip_prefix('<') {
        ("<", rest)
    } else if let Some(rest) = token.strip_prefix('~') {
        ("~", rest)
    } else if let Some(rest) = token.strip_prefix('^') {
        ("^", rest)
    } else if let Some(rest) = token.strip_prefix('=') {
        ("=", rest)
    } else {
        ("=", token)
    };
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    if value.contains('x') || value.contains('X') || value.contains('*') {
        let normalized = value.replace(['x', 'X', '*'], "0");
        let parts = parse_version(&normalized)?;
        let prefix = parts.len().saturating_sub(1);
        return Some(
            version
                .iter()
                .take(prefix)
                .copied()
                .eq(parts.iter().take(prefix).copied()),
        );
    }

    let target = parse_version(value)?;
    let ordering = compare_versions(version, &target);
    match operator {
        ">=" => Some(ordering != Ordering::Less),
        ">" => Some(ordering == Ordering::Greater),
        "<=" => Some(ordering != Ordering::Greater),
        "<" => Some(ordering == Ordering::Less),
        "=" => Some(ordering == Ordering::Equal),
        "~" => {
            let mut upper = target.clone();
            if upper.len() >= 2 {
                let index = upper.len() - 2;
                upper[index] += 1;
                upper.truncate(index + 1);
            } else {
                upper[0] += 1;
            }
            Some(
                compare_versions(version, &target) != Ordering::Less
                    && compare_versions(version, &upper) == Ordering::Less,
            )
        }
        "^" => {
            let mut upper = target.clone();
            upper[0] += 1;
            upper.truncate(1);
            Some(
                compare_versions(version, &target) != Ordering::Less
                    && compare_versions(version, &upper) == Ordering::Less,
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bamboo-preflight-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_entries(dir: &Path, name: &str, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(dir.join(name)).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (entry, body) in entries {
            zip.start_file(*entry, options).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    fn write_jar(dir: &Path, name: &str, entries: &[(&str, &str)]) {
        let owned: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(entry, body)| (*entry, body.as_bytes()))
            .collect();
        write_entries(dir, name, &owned);
    }

    fn jar_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for (entry, body) in entries {
                zip.start_file(*entry, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn fabric(id: &str, version: &str, minecraft: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","version":"{version}","depends":{{"minecraft":"{minecraft}"}}}}"#
        )
    }

    #[test]
    fn duplicate_mods_keep_the_newest_version() {
        let dir = temp_dir("duplicates");
        write_jar(
            &dir,
            "sodium-0.5.0.jar",
            &[("fabric.mod.json", &fabric("sodium", "0.5.0", "*"))],
        );
        write_jar(
            &dir,
            "sodium-0.5.8.jar",
            &[("fabric.mod.json", &fabric("sodium", "0.5.8", "*"))],
        );

        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert_eq!(report.checked_mods, 2);
        let issue = report
            .issues
            .iter()
            .find(|issue| issue.kind == "duplicate-mod")
            .expect("duplicate issue");
        assert_eq!(issue.disable, vec!["sodium-0.5.0.jar"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disabled_jars_are_not_checked() {
        let dir = temp_dir("disabled");
        write_jar(
            &dir,
            "sodium-0.5.0.jar.disabled",
            &[("fabric.mod.json", &fabric("sodium", "0.5.0", "*"))],
        );
        write_jar(
            &dir,
            "sodium-0.5.8.jar",
            &[("fabric.mod.json", &fabric("sodium", "0.5.8", "*"))],
        );

        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert_eq!(report.checked_mods, 1);
        assert!(report.issues.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dependency_is_reported_but_provided_ids_count() {
        let dir = temp_dir("missing");
        write_jar(
            &dir,
            "appleskin.jar",
            &[(
                "fabric.mod.json",
                r#"{"id":"appleskin","version":"1.0","depends":{"minecraft":"*","cloth-config2":"*"}}"#,
            )],
        );
        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.title.contains("cloth-config2")));

        write_jar(
            &dir,
            "cloth.jar",
            &[(
                "fabric.mod.json",
                r#"{"id":"cloth-config","version":"1.0","provides":["cloth-config2"],"depends":{"minecraft":"*"}}"#,
            )],
        );
        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "missing-dependency"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loader_provided_dependencies_are_not_reported() {
        let dir = temp_dir("loader-deps");
        write_jar(
            &dir,
            "sodium.jar",
            &[(
                "fabric.mod.json",
                r#"{"id":"sodium","version":"0.5.8","depends":{"minecraft":"*","fabricloader":">=0.15","mixinextras":"*","cloth-config2":"*"}}"#,
            )],
        );

        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        let missing: Vec<&str> = report
            .issues
            .iter()
            .filter(|issue| issue.kind == "missing-dependency")
            .map(|issue| issue.title.as_str())
            .collect();
        assert!(missing.iter().any(|title| title.contains("cloth-config2")));
        assert!(!missing.iter().any(|title| title.contains("fabricloader")));
        assert!(!missing.iter().any(|title| title.contains("mixinextras")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forge_does_not_inherit_fabric_loader_provides() {
        let dir = temp_dir("forge-mixinextras");
        write_jar(
            &dir,
            "mod.jar",
            &[(
                "META-INF/mods.toml",
                "[[mods]]\nmodId=\"mod\"\ndisplayName=\"Mod\"\n[[dependencies.mod]]\nmodId=\"mixinextras\"\nmandatory=true\nversionRange=\"*\"\nside=\"BOTH\"\n",
            )],
        );

        let report = check(&dir, Some(Loader::Forge), "1.20.1");
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.kind == "missing-dependency"
                    && issue.title.contains("mixinextras"))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_fabric_modules_count_as_installed() {
        let dir = temp_dir("jij-fabric");
        let nested = jar_bytes(&[(
            "fabric.mod.json",
            r#"{"id":"fabric-api-base","name":"Fabric API Base","version":"0.4.31","depends":{"minecraft":"*"}}"#,
        )]);
        write_entries(
            &dir,
            "fabric-api.jar",
            &[
                (
                    "fabric.mod.json",
                    br#"{"id":"fabric-api","version":"0.92.0","depends":{"minecraft":"*"}}"#
                        .as_slice(),
                ),
                ("META-INF/jars/fabric-api-base.jar", nested.as_slice()),
            ],
        );
        write_jar(
            &dir,
            "sodium.jar",
            &[(
                "fabric.mod.json",
                r#"{"id":"sodium","version":"0.5.8","depends":{"minecraft":"*","fabric-api-base":"*"}}"#,
            )],
        );

        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "missing-dependency"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_forge_jars_count_as_installed() {
        let dir = temp_dir("jij-forge");
        let nested = jar_bytes(&[(
            "META-INF/mods.toml",
            "[[mods]]\nmodId=\"bundled-library\"\ndisplayName=\"Bundled Library\"\n",
        )]);
        write_entries(
            &dir,
            "bundle.jar",
            &[
                (
                    "META-INF/mods.toml",
                    b"[[mods]]\nmodId=\"bundle\"\ndisplayName=\"Bundle\"\n".as_slice(),
                ),
                ("META-INF/jarjar/bundled-library.jar", nested.as_slice()),
            ],
        );
        write_jar(
            &dir,
            "user.jar",
            &[(
                "META-INF/mods.toml",
                "[[mods]]\nmodId=\"user\"\n[[dependencies.user]]\nmodId=\"bundled-library\"\nmandatory=true\nversionRange=\"*\"\nside=\"BOTH\"\n",
            )],
        );

        let report = check(&dir, Some(Loader::Forge), "1.20.1");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "missing-dependency"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_bundled_jars_are_ignored() {
        let dir = temp_dir("jij-broken");
        write_entries(
            &dir,
            "broken.jar",
            &[
                (
                    "fabric.mod.json",
                    br#"{"id":"broken","version":"1.0"}"#.as_slice(),
                ),
                (
                    "META-INF/jars/not-a-jar.jar",
                    b"definitely not a zip".as_slice(),
                ),
            ],
        );

        let report = check(&dir, Some(Loader::Fabric), "1.20.1");
        assert_eq!(report.checked_mods, 1);
        assert!(report.issues.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_loader_and_wrong_minecraft_version_are_found() {
        let dir = temp_dir("mismatch");
        write_jar(
            &dir,
            "old-fabric.jar",
            &[("fabric.mod.json", &fabric("old", "1.0", "~1.19.2"))],
        );

        let report = check(&dir, Some(Loader::Forge), "1.20.1");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.kind == "loader-mismatch"));
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.kind == "minecraft-mismatch"));
        let mismatch = report
            .issues
            .iter()
            .find(|issue| issue.kind == "minecraft-mismatch")
            .unwrap();
        assert_eq!(mismatch.disable, vec!["old-fabric.jar"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forge_dependencies_ignore_optional_and_platform_entries() {
        let dir = temp_dir("forge");
        write_jar(
            &dir,
            "jei.jar",
            &[(
                "META-INF/mods.toml",
                r#"modLoader="javafml"
loaderVersion="[47,)"
[[mods]]
modId="jei"
version="15.2.0.27"
displayName="Just Enough Items"
[[dependencies.jei]]
modId="forge"
mandatory=true
versionRange="[47,)"
side="BOTH"
[[dependencies.jei]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1,1.21)"
side="BOTH"
[[dependencies.jei]]
modId="optional-mod"
mandatory=false
versionRange="*"
side="BOTH"
[[dependencies.jei]]
modId="missing-mod"
mandatory=true
versionRange="*"
side="BOTH"
"#,
            )],
        );

        let report = check(&dir, Some(Loader::Forge), "1.20.1");
        assert_eq!(report.checked_mods, 1);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.title.contains("missing-mod")));
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.title.contains("optional-mod")));
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "minecraft-mismatch"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fabric_minecraft_lists_are_alternatives_and_forge_bundles_provide_ids() {
        let alternatives = temp_dir("alternatives");
        write_jar(
            &alternatives,
            "multi.jar",
            &[(
                "fabric.mod.json",
                r#"{"id":"multi","version":"1.0","depends":{"minecraft":["1.20.1","1.20.2"]}}"#,
            )],
        );
        let report = check(&alternatives, Some(Loader::Fabric), "1.20.2");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "minecraft-mismatch"));

        let forge_bundle = temp_dir("forge-bundle");
        write_jar(
            &forge_bundle,
            "bundle.jar",
            &[(
                "META-INF/mods.toml",
                r#"[[mods]]
modId="bundle"
displayName="Bundle"
[[mods]]
modId="bundled-library"
displayName="Bundled Library"
[[dependencies.bundle]]
modId="bundled-library"
mandatory=true
versionRange="*"
"#,
            )],
        );
        write_jar(
            &forge_bundle,
            "user.jar",
            &[(
                "META-INF/mods.toml",
                r#"[[mods]]
modId="user"
[[dependencies.user]]
modId="bundled-library"
mandatory=true
versionRange="*"
"#,
            )],
        );
        let report = check(&forge_bundle, Some(Loader::Forge), "1.20.1");
        assert!(!report
            .issues
            .iter()
            .any(|issue| issue.kind == "missing-dependency"));

        let _ = std::fs::remove_dir_all(&alternatives);
        let _ = std::fs::remove_dir_all(&forge_bundle);
    }

    #[test]
    fn vanilla_instance_with_mods_is_flagged() {
        let dir = temp_dir("vanilla");
        write_jar(
            &dir,
            "sodium.jar",
            &[("fabric.mod.json", &fabric("sodium", "0.5.8", "*"))],
        );
        let report = check(&dir, None, "1.20.1");
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.title.contains("Vanilla")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_ranges_cover_fabric_and_maven_syntax() {
        assert_eq!(satisfies("1.20.1", "~1.20.1"), Some(true));
        assert_eq!(satisfies("1.21", "~1.20.1"), Some(false));
        assert_eq!(satisfies("1.20.1", ">=1.20.1 <1.21"), Some(true));
        assert_eq!(satisfies("1.20.1", "1.20.x"), Some(true));
        assert_eq!(satisfies("1.21.1", "1.20.x"), Some(false));
        assert_eq!(satisfies("1.20.1", "[1.20.1,1.21)"), Some(true));
        assert_eq!(satisfies("1.21", "[1.20.1,1.21)"), Some(false));
        assert_eq!(satisfies("23w45a", ">=1.20"), None);
    }
}
