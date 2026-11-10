use crate::error::{LauncherError, Result};
use crate::java::os_version;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const MAX_INHERITANCE_DEPTH: usize = 8;

// ---------------------------------------------------------------------------
// Plattform und Regeln
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformInfo {
    /// `windows`, `osx` oder `linux` – genau die Schreibweise aus den Versions-JSONs.
    pub name: String,
    /// `x64`, `ia32` oder `arm64`.
    pub arch: String,
    pub version: String,
}

impl PlatformInfo {
    pub fn current() -> Self {
        let name = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "osx"
        } else {
            "linux"
        };
        let arch = match std::env::consts::ARCH {
            "x86" => "ia32",
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        };
        Self {
            name: name.to_string(),
            arch: arch.to_string(),
            version: os_version(),
        }
    }

    /// Classpath-Trenner des Zielsystems.
    pub fn classpath_separator(&self) -> char {
        if self.name == "windows" {
            ';'
        } else {
            ':'
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

fn normalize_arch(arch: &str) -> &str {
    match arch {
        "x86" => "ia32",
        other => other,
    }
}

fn os_matches(rule: &OsRule, platform: &PlatformInfo) -> bool {
    if let Some(name) = &rule.name {
        if name != &platform.name {
            return false;
        }
    }
    if let Some(arch) = &rule.arch {
        if normalize_arch(arch) != platform.arch {
            return false;
        }
    }
    if let Some(pattern) = &rule.version {
        let Ok(regex) = Regex::new(pattern) else {
            return false;
        };
        if !regex.is_match(&platform.version) {
            return false;
        }
    }
    true
}

/// Wertet die `rules`-Liste aus. Ohne Regeln ist alles erlaubt; andernfalls
/// gewinnt die letzte zutreffende Regel.
pub fn evaluate_rules(
    rules: Option<&[Rule]>,
    platform: &PlatformInfo,
    features: &HashMap<String, bool>,
) -> bool {
    let Some(rules) = rules else {
        return true;
    };
    if rules.is_empty() {
        return true;
    }

    let mut allowed = false;
    for rule in rules {
        let mut applies = rule.os.as_ref().is_none_or(|os| os_matches(os, platform));
        if applies {
            if let Some(required) = &rule.features {
                applies = required
                    .iter()
                    .all(|(key, value)| features.get(key).copied().unwrap_or(false) == *value);
            }
        }
        if applies {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Argument {
    Plain(String),
    Conditional {
        #[serde(default)]
        rules: Option<Vec<Rule>>,
        value: Value,
    },
}

fn argument_values(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// Filtert Argumente anhand ihrer Regeln und liefert sie in Reihenfolge.
pub fn resolve_arguments(
    arguments: &[Argument],
    platform: &PlatformInfo,
    features: &HashMap<String, bool>,
) -> Vec<String> {
    let mut resolved = Vec::new();
    for argument in arguments {
        match argument {
            Argument::Plain(value) => resolved.push(value.clone()),
            Argument::Conditional { rules, value } => {
                if evaluate_rules(rules.as_deref(), platform, features) {
                    resolved.extend(argument_values(value));
                }
            }
        }
    }
    resolved
}

// ---------------------------------------------------------------------------
// Maven-Koordinaten
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MavenCoordinate {
    pub group: String,
    pub artifact: String,
    pub version: String,
    pub classifier: Option<String>,
    pub extension: String,
}

impl MavenCoordinate {
    pub fn file_name(&self) -> String {
        let classifier = self
            .classifier
            .as_ref()
            .map(|value| format!("-{value}"))
            .unwrap_or_default();
        format!(
            "{}-{}{}.{}",
            self.artifact, self.version, classifier, self.extension
        )
    }

    /// Relativer Pfad im `libraries`-Verzeichnis.
    pub fn relative_path(&self) -> String {
        format!(
            "{}/{}/{}/{}",
            self.group.replace('.', "/"),
            self.artifact,
            self.version,
            self.file_name()
        )
    }

    /// Eindeutiger Schlüssel für die Deduplizierung mehrerer Library-Einträge.
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.group,
            self.artifact,
            self.classifier.as_deref().unwrap_or("")
        )
    }

    pub fn display_name(&self) -> String {
        match &self.classifier {
            Some(classifier) => format!(
                "{}:{}:{}:{}",
                self.group, self.artifact, self.version, classifier
            ),
            None => format!("{}:{}:{}", self.group, self.artifact, self.version),
        }
    }
}

pub fn parse_maven_coordinate(raw: &str) -> Option<MavenCoordinate> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }

    let (body, extension) = match value.rsplit_once('@') {
        Some((body, extension)) if !extension.is_empty() => (body, extension.to_string()),
        _ => (value, "jar".to_string()),
    };

    let parts: Vec<&str> = body.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].trim();
    let artifact = parts[1].trim();
    let version = parts[2].trim();
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }

    Some(MavenCoordinate {
        group: group.to_string(),
        artifact: artifact.to_string(),
        version: version.to_string(),
        classifier: parts.get(3).map(|value| value.trim().to_string()),
        extension,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LibraryDownload {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<LibraryDownload>,
    #[serde(default)]
    pub classifiers: Option<HashMap<String, LibraryDownload>>,
}

/// Die Downloads einer Version selbst (Client-Jar und Server).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct VersionDownloads {
    #[serde(default)]
    pub client: Option<LibraryDownload>,
    #[serde(default)]
    pub server: Option<LibraryDownload>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Extract {
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Fabric-Profile legen Prüfsumme und Größe direkt an der Library ab
    /// statt unter `downloads.artifact`.
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub downloads: Option<LibraryDownloads>,
    #[serde(default)]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default)]
    pub extract: Option<Extract>,
    #[serde(default)]
    pub rules: Option<Vec<Rule>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLibrary {
    pub name: String,
    pub path: PathBuf,
    pub url: String,
    pub is_native: bool,
    pub extract_exclude: Vec<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

fn version_tokens(version: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut digits = false;
    for ch in version.chars() {
        if ch.is_ascii_digit() {
            if !digits && !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            digits = true;
            current.push(ch);
        } else if ch.is_ascii_alphabetic() {
            if digits && !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            digits = false;
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Vergleicht Maven-Versionen; Rückgabe > 0 heißt `a` ist neuer.
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let left = version_tokens(a);
    let right = version_tokens(b);
    for index in 0..left.len().max(right.len()) {
        match (left.get(index), right.get(index)) {
            (None, None) => return 0,
            (None, Some(_)) => return -1,
            (Some(_), None) => return 1,
            (Some(x), Some(y)) => {
                let ordering = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    _ => x.cmp(y),
                };
                if ordering.is_ne() {
                    return if ordering.is_gt() { 1 } else { -1 };
                }
            }
        }
    }
    0
}

fn arch_suffix(platform: &PlatformInfo) -> &'static str {
    match platform.arch.as_str() {
        "ia32" => "32",
        "arm64" => "arm64",
        _ => "64",
    }
}

fn maven_base(library: &Library, coordinate: &MavenCoordinate) -> String {
    if let Some(url) = &library.url {
        return if url.ends_with('/') {
            url.clone()
        } else {
            format!("{url}/")
        };
    }
    if coordinate.group == "net.minecraftforge" {
        return "https://files.minecraftforge.net/maven/".to_string();
    }
    "https://libraries.minecraft.net/".to_string()
}

fn to_resolved(
    library: &Library,
    coordinate: &MavenCoordinate,
    download: Option<&LibraryDownload>,
    game_root: &Path,
    is_native: bool,
) -> ResolvedLibrary {
    let relative = download
        .and_then(|entry| entry.path.clone())
        .unwrap_or_else(|| coordinate.relative_path());
    let url = download
        .and_then(|entry| entry.url.clone())
        .unwrap_or_else(|| format!("{}{}", maven_base(library, coordinate), relative));

    ResolvedLibrary {
        name: coordinate.display_name(),
        path: game_root.join("libraries").join(relative),
        url,
        is_native,
        extract_exclude: if is_native {
            library
                .extract
                .as_ref()
                .map(|extract| extract.exclude.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        sha1: download
            .and_then(|entry| entry.sha1.clone())
            .or_else(|| library.sha1.clone()),
        size: download.and_then(|entry| entry.size).or(library.size),
    }
}

/// Löst die Library-Liste auf: Regeln, Natives je Plattform und Deduplizierung.
pub fn resolve_libraries(
    libraries: &[Library],
    platform: &PlatformInfo,
    features: &HashMap<String, bool>,
    game_root: &Path,
) -> (Vec<ResolvedLibrary>, Vec<ResolvedLibrary>) {
    let mut resolved: Vec<ResolvedLibrary> = Vec::new();
    let mut natives: Vec<ResolvedLibrary> = Vec::new();
    let mut keys: HashMap<String, usize> = HashMap::new();
    let mut native_keys: HashMap<String, usize> = HashMap::new();

    for library in libraries {
        if !evaluate_rules(library.rules.as_deref(), platform, features) {
            continue;
        }

        if let Some(template) = library.natives.as_ref().and_then(|n| n.get(&platform.name)) {
            let classifier = template.replace("${arch}", arch_suffix(platform));
            let Some(coordinate) =
                parse_maven_coordinate(&format!("{}:{}", library.name, classifier))
            else {
                continue;
            };
            let download = library
                .downloads
                .as_ref()
                .and_then(|downloads| downloads.classifiers.as_ref())
                .and_then(|classifiers| classifiers.get(&classifier));
            let model = to_resolved(library, &coordinate, download, game_root, true);
            match native_keys.get(&coordinate.key()) {
                Some(&index)
                    if compare_versions(
                        &coordinate.version,
                        &coordinate_version(&natives[index]),
                    ) < 0 => {}
                Some(&index) => {
                    natives[index] = model;
                }
                None => {
                    native_keys.insert(coordinate.key(), natives.len());
                    natives.push(model);
                }
            }
            continue;
        }

        let Some(coordinate) = parse_maven_coordinate(&library.name) else {
            continue;
        };
        let download = library
            .downloads
            .as_ref()
            .and_then(|downloads| downloads.artifact.as_ref());
        let model = to_resolved(library, &coordinate, download, game_root, false);
        match keys.get(&coordinate.key()) {
            Some(&index) => {
                if compare_versions(&coordinate.version, &coordinate_version(&resolved[index])) >= 0
                {
                    resolved[index] = model;
                }
            }
            None => {
                keys.insert(coordinate.key(), resolved.len());
                resolved.push(model);
            }
        }
    }

    (resolved, natives)
}

fn coordinate_version(library: &ResolvedLibrary) -> String {
    // Der Anzeigename endet auf die Version; für den Vergleich genügt der
    // letzte Abschnitt nach dem letzten ':' ohne Classifier.
    library
        .name
        .rsplit(':')
        .nth(1)
        .unwrap_or(&library.name)
        .to_string()
}

// ---------------------------------------------------------------------------
// Versions-JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AssetIndex {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub total_size: Option<u64>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct JavaVersion {
    #[serde(default)]
    pub component: Option<String>,
    #[serde(rename = "majorVersion", default)]
    pub major_version: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<Argument>,
    #[serde(default)]
    pub jvm: Vec<Argument>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LoggingFile {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LoggingClient {
    #[serde(default)]
    pub argument: Option<String>,
    #[serde(default)]
    pub file: Option<LoggingFile>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Logging {
    #[serde(default)]
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct VersionJson {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "inheritsFrom", default)]
    pub inherits_from: Option<String>,
    #[serde(rename = "mainClass", default)]
    pub main_class: Option<String>,
    #[serde(rename = "type", default)]
    pub version_type: Option<String>,
    #[serde(default)]
    pub assets: Option<String>,
    #[serde(rename = "assetIndex", default)]
    pub asset_index: Option<AssetIndex>,
    #[serde(rename = "javaVersion", default)]
    pub java_version: Option<JavaVersion>,
    #[serde(default)]
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments", default)]
    pub minecraft_arguments: Option<String>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default)]
    pub logging: Option<Logging>,
    #[serde(default)]
    pub downloads: Option<VersionDownloads>,
    #[serde(default)]
    pub jar: Option<String>,
    #[serde(rename = "clientVersion", default)]
    pub client_version: Option<String>,
    #[serde(rename = "_minecraftVersion", default)]
    pub minecraft_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogConfig {
    pub argument: String,
    pub file_id: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedVersion {
    pub id: String,
    pub main_class: String,
    pub version_type: String,
    pub minecraft_version: String,
    pub jar_version: String,
    pub client_jar: PathBuf,
    /// Download-Angaben für den Client-Jar (aus der Version oder ihrem Elternteil).
    pub client_download: Option<LibraryDownload>,
    /// Vollständige Asset-Index-Angaben inklusive URL für den Download.
    pub asset_index_info: Option<AssetIndex>,
    /// Das Rohfeld `assets` ("legacy", "pre-1.6", "1.20", …).
    pub assets_field: Option<String>,
    /// Log4j-Konfiguration, die beim Start referenziert wird.
    pub log_file: Option<LibraryDownload>,
    pub libraries: Vec<ResolvedLibrary>,
    pub natives: Vec<ResolvedLibrary>,
    pub classpath: Vec<PathBuf>,
    pub asset_index: String,
    pub assets_root: PathBuf,
    pub game_arguments: Vec<String>,
    pub jvm_arguments: Vec<String>,
    pub java_major: u32,
    /// Von Mojang empfohlener Runtime-Name (`java-runtime-gamma`, …).
    pub java_component: Option<String>,
    pub legacy: bool,
    pub log_config: Option<LogConfig>,
}

pub fn version_json_path(game_root: &Path, version_id: &str) -> PathBuf {
    game_root
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"))
}

/// Lädt das Versions-JSON samt `inheritsFrom`-Kette (Kind zuerst).
pub fn load_version_chain(game_root: &Path, version_id: &str) -> Result<Vec<VersionJson>> {
    let mut chain = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut current = Some(version_id.to_string());

    while let Some(id) = current {
        if seen.contains(&id) {
            let mut path = seen.clone();
            path.push(id);
            return Err(LauncherError::CircularInheritance(path.join(" -> ")));
        }
        if seen.len() >= MAX_INHERITANCE_DEPTH {
            let mut path = seen.clone();
            path.push(id);
            return Err(LauncherError::InvalidVersionJson {
                path: game_root.join("versions"),
                reason: format!(
                    "inheritsFrom-Kette überschreitet {MAX_INHERITANCE_DEPTH} Einträge: {}",
                    path.join(" -> ")
                ),
            });
        }
        seen.push(id.clone());

        let path = version_json_path(game_root, &id);
        if !path.is_file() {
            return Err(LauncherError::VersionNotFound(version_id.to_string(), path));
        }
        let text = std::fs::read_to_string(&path)?;
        let json: VersionJson =
            serde_json::from_str(&text).map_err(|error| LauncherError::InvalidVersionJson {
                path: path.clone(),
                reason: error.to_string(),
            })?;
        current = json.inherits_from.clone().filter(|value| !value.is_empty());
        chain.push(json);
    }

    Ok(chain)
}

/// JVM-Argumente, die Vanilla-Versionen vor 1.13 nicht selbst mitbringen.
pub fn legacy_jvm_arguments(platform: &PlatformInfo) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if platform.name == "windows" {
        args.push(
            "-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump"
                .to_string(),
        );
        args.push("-Dos.name=Windows 10".to_string());
        args.push("-Dos.version=10.0".to_string());
    }
    args.extend([
        "-Djava.library.path=${natives_directory}".to_string(),
        "-Dminecraft.launcher.brand=${launcher_name}".to_string(),
        "-Dminecraft.launcher.version=${launcher_version}".to_string(),
        "-cp".to_string(),
        "${classpath}".to_string(),
    ]);
    args
}

/// Baut das vollständig aufgelöste Versionsmodell mit den Features des aktuellen Starts.
pub fn resolve_version(game_root: &Path, version_id: &str) -> Result<ResolvedVersion> {
    let platform = PlatformInfo::current();
    resolve_version_with_features(game_root, version_id, &platform, &HashMap::new())
}

/// Wie [`resolve_version`], aber mit expliziten Regeln-Features (Demo, Auflösung).
pub fn resolve_version_with_features(
    game_root: &Path,
    version_id: &str,
    platform: &PlatformInfo,
    features: &HashMap<String, bool>,
) -> Result<ResolvedVersion> {
    let chain = load_version_chain(game_root, version_id)?;
    resolve_from_chain(game_root, version_id, &chain, platform, features)
}

pub fn resolve_from_chain(
    game_root: &Path,
    version_id: &str,
    chain: &[VersionJson],
    platform: &PlatformInfo,
    features: &HashMap<String, bool>,
) -> Result<ResolvedVersion> {
    let mut main_class: Option<String> = None;
    let mut version_type = "release".to_string();
    let mut assets_field: Option<String> = None;
    let mut asset_index: Option<AssetIndex> = None;
    let mut java_version: Option<JavaVersion> = None;
    let mut jar: Option<String> = None;
    let mut logging: Option<Logging> = None;
    let mut downloads: Option<VersionDownloads> = None;
    let mut game_arguments: Vec<String> = Vec::new();
    let mut jvm_arguments: Vec<String> = Vec::new();
    let mut legacy = false;
    let mut libraries: Vec<Library> = Vec::new();

    for entry in chain.iter().rev() {
        if entry.main_class.is_some() {
            main_class = entry.main_class.clone();
        }
        if let Some(value) = &entry.version_type {
            version_type = value.clone();
        }
        if entry.assets.is_some() {
            assets_field = entry.assets.clone();
        }
        if entry.asset_index.is_some() {
            asset_index = entry.asset_index.clone();
        }
        if entry.java_version.is_some() {
            java_version = entry.java_version.clone();
        }
        if entry.jar.is_some() {
            jar = entry.jar.clone();
        }
        if entry.logging.is_some() {
            logging = entry.logging.clone();
        }
        if entry.downloads.is_some() {
            downloads = entry.downloads.clone();
        }
        libraries.extend(entry.libraries.iter().cloned());

        if let Some(arguments) = &entry.arguments {
            game_arguments.extend(resolve_arguments(&arguments.game, platform, features));
            jvm_arguments.extend(resolve_arguments(&arguments.jvm, platform, features));
        } else if let Some(line) = &entry.minecraft_arguments {
            game_arguments = line.split_whitespace().map(str::to_string).collect();
            jvm_arguments = legacy_jvm_arguments(platform);
            legacy = true;
        }
    }

    let Some(main_class) = main_class else {
        return Err(LauncherError::MissingMainClass(version_id.to_string()));
    };

    let base = chain.last();
    let minecraft_version = base
        .and_then(|entry| {
            entry
                .client_version
                .clone()
                .or_else(|| entry.minecraft_version.clone())
                .or_else(|| entry.id.clone())
        })
        .unwrap_or_else(|| version_id.to_string());
    let jar_version = jar.unwrap_or_else(|| minecraft_version.clone());

    let (resolved_libraries, natives) =
        resolve_libraries(&libraries, platform, features, game_root);
    let client_jar = game_root
        .join("versions")
        .join(&jar_version)
        .join(format!("{jar_version}.jar"));

    let mut classpath: Vec<PathBuf> = resolved_libraries
        .iter()
        .map(|library| library.path.clone())
        .collect();
    classpath.push(client_jar.clone());

    let java_major = java_version
        .as_ref()
        .and_then(|version| version.major_version)
        .or_else(|| {
            java_version
                .as_ref()
                .and_then(|version| version.component.as_deref())
                .and_then(component_major)
        })
        .unwrap_or(8);

    let log_config = logging
        .as_ref()
        .and_then(|logging| logging.client.as_ref())
        .and_then(|client| {
            let argument = client.argument.clone()?;
            let file_id = client.file.as_ref()?.id.clone()?;
            Some(LogConfig { argument, file_id })
        });
    let log_file = logging
        .and_then(|logging| logging.client)
        .and_then(|client| {
            let file = client.file?;
            let url = file.url.clone()?;
            Some(LibraryDownload {
                path: file.id.map(|id| format!("assets/log_configs/{id}")),
                url: Some(url),
                sha1: file.sha1,
                size: file.size,
            })
        });

    let asset_index_id = asset_index
        .as_ref()
        .and_then(|index| index.id.clone())
        .or_else(|| assets_field.clone())
        .unwrap_or_else(|| "legacy".to_string());

    Ok(ResolvedVersion {
        id: version_id.to_string(),
        main_class,
        version_type,
        minecraft_version,
        jar_version,
        client_jar,
        client_download: downloads.and_then(|downloads| downloads.client),
        asset_index_info: asset_index.clone(),
        assets_field,
        log_file,
        libraries: resolved_libraries,
        natives,
        classpath,
        asset_index: asset_index_id,
        assets_root: game_root.join("assets"),
        game_arguments,
        jvm_arguments,
        java_major,
        java_component: java_version.and_then(|version| version.component),
        legacy,
        log_config,
    })
}

fn component_major(component: &str) -> Option<u32> {
    match component {
        "jre-legacy" => Some(8),
        "java-runtime-alpha" => Some(16),
        "java-runtime-beta" | "java-runtime-gamma" | "java-runtime-gamma-snapshot" => Some(17),
        "java-runtime-delta" => Some(21),
        "java-runtime-epsilon" => Some(25),
        _ => None,
    }
}

/// Alle installierten Versions-IDs, alphabetisch sortiert.
pub fn list_installed_versions(game_root: &Path) -> Result<Vec<String>> {
    let versions_dir = game_root.join("versions");
    if !versions_dir.exists() {
        return Ok(Vec::new());
    }
    let mut versions = Vec::new();
    for entry in std::fs::read_dir(versions_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().join(format!("{name}.json")).is_file() {
            versions.push(name);
        }
    }
    versions.sort();
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform(name: &str, arch: &str) -> PlatformInfo {
        PlatformInfo {
            name: name.to_string(),
            arch: arch.to_string(),
            version: "10.0.19045".to_string(),
        }
    }

    #[test]
    fn rules_default_to_allowed() {
        let features = HashMap::new();
        assert!(evaluate_rules(None, &platform("windows", "x64"), &features));
    }

    #[test]
    fn rules_respect_os_and_arch() {
        let rules = vec![Rule {
            action: "allow".to_string(),
            os: Some(OsRule {
                name: Some("osx".to_string()),
                arch: None,
                version: None,
            }),
            features: None,
        }];
        let features = HashMap::new();
        assert!(!evaluate_rules(
            Some(&rules),
            &platform("windows", "x64"),
            &features
        ));
        assert!(evaluate_rules(
            Some(&rules),
            &platform("osx", "arm64"),
            &features
        ));
    }

    #[test]
    fn disallow_after_allow_wins() {
        let rules = vec![
            Rule {
                action: "allow".to_string(),
                os: None,
                features: None,
            },
            Rule {
                action: "disallow".to_string(),
                os: Some(OsRule {
                    name: Some("linux".to_string()),
                    ..Default::default()
                }),
                features: None,
            },
        ];
        let features = HashMap::new();
        assert!(evaluate_rules(
            Some(&rules),
            &platform("windows", "x64"),
            &features
        ));
        assert!(!evaluate_rules(
            Some(&rules),
            &platform("linux", "x64"),
            &features
        ));
    }

    #[test]
    fn feature_rules_require_matching_flag() {
        let rules = vec![Rule {
            action: "allow".to_string(),
            os: None,
            features: Some(HashMap::from([("is_demo_user".to_string(), true)])),
        }];
        let mut features = HashMap::new();
        assert!(!evaluate_rules(
            Some(&rules),
            &platform("windows", "x64"),
            &features
        ));
        features.insert("is_demo_user".to_string(), true);
        assert!(evaluate_rules(
            Some(&rules),
            &platform("windows", "x64"),
            &features
        ));
    }

    #[test]
    fn os_version_rules_use_regex() {
        let rules = vec![Rule {
            action: "allow".to_string(),
            os: Some(OsRule {
                name: Some("windows".to_string()),
                arch: None,
                version: Some("^10\\.".to_string()),
            }),
            features: None,
        }];
        let features = HashMap::new();
        assert!(evaluate_rules(
            Some(&rules),
            &platform("windows", "x64"),
            &features
        ));
        let old_windows = PlatformInfo {
            name: "windows".to_string(),
            arch: "x64".to_string(),
            version: "6.1.7601".to_string(),
        };
        assert!(!evaluate_rules(Some(&rules), &old_windows, &features));
    }

    #[test]
    fn parses_maven_coordinates() {
        let coordinate = parse_maven_coordinate("net.fabricmc:fabric-loader:0.15.11").unwrap();
        assert_eq!(coordinate.group, "net.fabricmc");
        assert_eq!(coordinate.artifact, "fabric-loader");
        assert_eq!(coordinate.version, "0.15.11");
        assert_eq!(coordinate.extension, "jar");
        assert_eq!(
            coordinate.relative_path(),
            "net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar"
        );
    }

    #[test]
    fn parses_classifier_and_extension() {
        let coordinate =
            parse_maven_coordinate("org.lwjgl:lwjgl:3.3.3:natives-windows@zip").unwrap();
        assert_eq!(coordinate.classifier.as_deref(), Some("natives-windows"));
        assert_eq!(coordinate.extension, "zip");
        assert_eq!(coordinate.file_name(), "lwjgl-3.3.3-natives-windows.zip");
    }

    #[test]
    fn rejects_incomplete_coordinates() {
        assert!(parse_maven_coordinate("nur-ein-name").is_none());
        assert!(parse_maven_coordinate("gruppe:artefakt").is_none());
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(compare_versions("1.10", "1.9") > 0);
        assert!(compare_versions("3.3.3", "3.3.10") < 0);
        assert_eq!(compare_versions("1.0", "1.0"), 0);
    }

    #[test]
    fn resolves_conditional_arguments() {
        let arguments = vec![
            Argument::Plain("--username".to_string()),
            Argument::Conditional {
                rules: Some(vec![Rule {
                    action: "allow".to_string(),
                    os: None,
                    features: Some(HashMap::from([("demo".to_string(), true)])),
                }]),
                value: Value::String("--demo".to_string()),
            },
        ];
        let platform = platform("windows", "x64");
        let none = resolve_arguments(&arguments, &platform, &HashMap::new());
        assert_eq!(none, vec!["--username"]);
        let demo = resolve_arguments(
            &arguments,
            &platform,
            &HashMap::from([("demo".to_string(), true)]),
        );
        assert_eq!(demo, vec!["--username", "--demo"]);
    }

    #[test]
    fn config_platform_maps_arch() {
        let current = PlatformInfo::current();
        assert!(matches!(current.arch.as_str(), "x64" | "ia32" | "arm64"));
        assert_eq!(
            current.classpath_separator(),
            if cfg!(windows) { ';' } else { ':' }
        );
    }
}
