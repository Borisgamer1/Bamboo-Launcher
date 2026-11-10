use crate::config::{default_game_root, home_dir, MemorySettings};
use crate::error::{LauncherError, Result};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Eine erkannte Java-Installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaRuntime {
    pub path: PathBuf,
    pub major: u32,
    pub version: String,
    pub vendor: Option<String>,
    pub arch: String,
}

impl JavaRuntime {
    pub fn label(&self) -> String {
        match &self.vendor {
            Some(vendor) => format!("Java {} ({vendor}, {})", self.major, self.arch),
            None => format!("Java {} ({})", self.major, self.arch),
        }
    }
}

/// Ergebnis von `java -XshowSettings:properties -version`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JavaProbe {
    pub version: Option<String>,
    pub major: Option<u32>,
    pub arch: Option<String>,
    pub vendor: Option<String>,
}

/// Baut die RAM-Argumente für den Spielprozess.
pub fn memory_args(memory: &MemorySettings) -> Result<Vec<String>> {
    memory.validate()?;
    Ok(vec![
        format!("-Xms{}M", memory.min_mb),
        format!("-Xmx{}M", memory.max_mb),
    ])
}

/// Akzeptiert sowohl `1.8.0_402` als auch moderne Schemata wie `17.0.10` oder `21`.
pub fn parse_java_major(value: &str) -> Option<u32> {
    let clean = value.trim().trim_matches('"');
    if clean.is_empty() {
        return None;
    }
    if let Some(rest) = clean.strip_prefix("1.") {
        let major = rest.split(['.', '_', '-', '+']).next()?;
        return major.parse().ok();
    }
    clean.split(['.', '_', '-', '+']).next()?.parse().ok()
}

/// Liest die Properties-Zeilen von `-XshowSettings:properties`.
pub fn parse_java_properties(output: &str) -> JavaProbe {
    let mut properties = std::collections::HashMap::new();
    for line in output.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.starts_with("java.") || key.starts_with("os.") {
            properties.insert(key.to_string(), value.trim().to_string());
        }
    }

    let version = properties
        .get("java.version")
        .or_else(|| properties.get("java.runtime.version"))
        .cloned()
        .or_else(|| {
            // Fallback auf die Banner-Zeile: openjdk version "17.0.10" 2024-01-16
            let banner = output
                .lines()
                .find(|line| line.contains(" version \""))
                .and_then(|line| line.split('"').nth(1));
            banner.map(str::to_string)
        });

    JavaProbe {
        major: version.as_deref().and_then(parse_java_major),
        version,
        arch: properties.get("os.arch").cloned(),
        vendor: properties
            .get("java.vendor")
            .or_else(|| properties.get("java.vm.vendor"))
            .cloned(),
    }
}

/// Startet `java -XshowSettings:properties -version` und liest die Ausgabe.
pub async fn probe_java(path: &Path) -> Result<JavaRuntime> {
    let output = tokio::process::Command::new(path)
        .arg("-XshowSettings:properties")
        .arg("-version")
        .output()
        .await
        .map_err(|error| LauncherError::Spawn(format!("{}: {error}", path.display())))?;

    // Die Properties landen bei Java auf stderr, das Banner teilweise auf stdout.
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    let probe = parse_java_properties(&text);
    let Some(major) = probe.major else {
        return Err(LauncherError::ProcessFailed(format!(
            "{} liefert keine erkennbare Java-Version",
            path.display()
        )));
    };

    Ok(JavaRuntime {
        path: path.to_path_buf(),
        major,
        version: probe.version.unwrap_or_else(|| format!("{major}")),
        vendor: probe.vendor,
        arch: probe
            .arch
            .unwrap_or_else(|| std::env::consts::ARCH.to_string()),
    })
}

/// Löst einen Nutzerpfad auf: Datei, Installationsverzeichnis oder `bin/java`.
pub fn resolve_java_executable(path: &Path) -> PathBuf {
    if path.is_dir() {
        let candidate = java_binary(path);
        if candidate.is_file() {
            return candidate;
        }
        let nested = path.join("jre").join("bin").join(java_name());
        if nested.is_file() {
            return nested;
        }
    }
    path.to_path_buf()
}

fn java_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn java_binary(home: &Path) -> PathBuf {
    home.join("bin").join(java_name())
}

/// Sammelt alle plausiblen Java-Executables auf diesem System.
pub fn candidate_paths() -> Vec<PathBuf> {
    candidate_paths_in(&default_game_root())
}

/// Kandidaten inklusive der vom Launcher selbst installierten Runtimes unter
/// `<game_root>/java/<komponente>/bin/java`.
pub fn candidate_paths_in(game_root: &Path) -> Vec<PathBuf> {
    let mut found: BTreeSet<PathBuf> = BTreeSet::new();

    if let Some(java_home) = std::env::var_os("JAVA_HOME") {
        let home = PathBuf::from(java_home);
        let binary = resolve_java_executable(&home);
        if binary.is_file() {
            found.insert(binary);
        }
    }

    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let binary = dir.join(java_name());
            if binary.is_file() {
                found.insert(binary);
            }
        }
    }

    for root in scan_roots(game_root) {
        collect_java_from(&root, 3, &mut found);
    }

    found.into_iter().collect()
}

fn scan_roots(game_root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    // Von Mojang verwaltete Runtimes liegen tief verschachtelt im Spielverzeichnis.
    roots.push(game_root.join("runtime"));
    // Vom Installer geladene Runtimes: java/<komponente>/bin/java.
    roots.push(game_root.join("java"));

    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(key) {
                let base = PathBuf::from(base);
                roots.push(base.join("Java"));
                roots.push(base.join("Eclipse Adoptium"));
                roots.push(base.join("Microsoft"));
                roots.push(base.join("Zulu"));
                roots.push(base.join("BellSoft"));
                roots.push(base.join("Programs").join("Eclipse Adoptium"));
            }
        }
    } else {
        roots.push(PathBuf::from("/usr/lib/jvm"));
        roots.push(PathBuf::from("/usr/java"));
        roots.push(PathBuf::from("/opt/java"));
        roots.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
        roots.push(home_dir().join(".sdkman").join("candidates").join("java"));
    }

    roots
}

fn collect_java_from(root: &Path, depth: usize, out: &mut BTreeSet<PathBuf>) {
    if depth == 0 || !root.exists() {
        return;
    }
    if root.is_file() {
        if root.file_name().and_then(|name| name.to_str()) == Some(java_name()) {
            out.insert(root.to_path_buf());
        }
        return;
    }

    let binary = java_binary(root);
    if binary.is_file() {
        out.insert(binary);
        return;
    }

    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_java_from(&path, depth - 1, out);
        }
    }
}

/// Probt alle Kandidaten und liefert die tatsächlich startbaren Runtimes.
pub async fn detect_all() -> Vec<JavaRuntime> {
    detect_all_in(&default_game_root()).await
}

pub async fn detect_all_in(game_root: &Path) -> Vec<JavaRuntime> {
    let mut runtimes = Vec::new();
    for candidate in candidate_paths_in(game_root) {
        if let Ok(runtime) = probe_java(&candidate).await {
            runtimes.push(runtime);
        }
    }
    runtimes
}

/// Wählt die passende Java-Version: exakter Treffer zuerst, sonst die kleinste
/// Version, die die Anforderung noch erfüllt.
pub fn pick_runtime(mut runtimes: Vec<JavaRuntime>, required: u32) -> Option<JavaRuntime> {
    runtimes.retain(|runtime| runtime.major >= required);
    runtimes.sort_by_key(|runtime| runtime.major);
    runtimes.into_iter().next()
}

/// Findet Java für einen Start. Ein expliziter Pfad gewinnt immer.
pub async fn find_java(explicit: Option<&Path>, required: u32) -> Result<JavaRuntime> {
    find_java_in(&default_game_root(), explicit, required).await
}

/// Wie [`find_java`], durchsucht aber auch die Runtimes dieser Installation.
pub async fn find_java_in(
    game_root: &Path,
    explicit: Option<&Path>,
    required: u32,
) -> Result<JavaRuntime> {
    if let Some(path) = explicit {
        let executable = resolve_java_executable(path);
        if !executable.is_file() {
            return Err(LauncherError::JavaNotFound);
        }
        let runtime = probe_java(&executable).await?;
        if runtime.major < required {
            return Err(LauncherError::JavaVersionMismatch {
                required,
                found: format!("Java {}", runtime.major),
            });
        }
        return Ok(runtime);
    }

    let runtimes = detect_all_in(game_root).await;
    let found = if runtimes.is_empty() {
        "keine Installation".to_string()
    } else {
        runtimes
            .iter()
            .map(|runtime| runtime.major.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };

    pick_runtime(runtimes, required).ok_or(LauncherError::JavaVersionMismatch { required, found })
}

/// Betriebssystem-Version im Format, das Minecraft-Regeln erwarten (`10.0.19045`).
pub fn os_version() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if cfg!(windows) {
                let major = registry_value(
                    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                    "CurrentMajorVersionNumber",
                );
                let build = registry_value(
                    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                    "CurrentBuildNumber",
                );
                match (major, build) {
                    (Some(major), Some(build)) => format!("{major}.0.{build}"),
                    _ => "10.0".to_string(),
                }
            } else {
                String::new()
            }
        })
        .clone()
}

#[cfg(windows)]
fn registry_value(key: &str, value: &str) -> Option<String> {
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", value])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| line.contains(value))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
}

#[cfg(not(windows))]
fn registry_value(_key: &str, _value: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_and_modern_majors() {
        assert_eq!(parse_java_major("1.8.0_402"), Some(8));
        assert_eq!(parse_java_major("17.0.10"), Some(17));
        assert_eq!(parse_java_major("21"), Some(21));
        assert_eq!(parse_java_major("\"21.0.1\""), Some(21));
        assert_eq!(parse_java_major(""), None);
        assert_eq!(parse_java_major("openjdk"), None);
    }

    #[test]
    fn reads_properties_and_banner() {
        let output = "\
Property settings:
    java.version = 17.0.10
    java.vendor = Eclipse Adoptium
    os.arch = amd64
    user.dir = C:\\spiel
";
        let probe = parse_java_properties(output);
        assert_eq!(probe.major, Some(17));
        assert_eq!(probe.version.as_deref(), Some("17.0.10"));
        assert_eq!(probe.vendor.as_deref(), Some("Eclipse Adoptium"));
        assert_eq!(probe.arch.as_deref(), Some("amd64"));
    }

    #[test]
    fn falls_back_to_version_banner() {
        let probe = parse_java_properties("openjdk version \"1.8.0_402\" 2024-01-16\n");
        assert_eq!(probe.major, Some(8));
    }

    #[test]
    fn memory_args_follow_settings() {
        let args = memory_args(&MemorySettings::new(2048, 8192)).unwrap();
        assert_eq!(args, vec!["-Xms2048M", "-Xmx8192M"]);
    }

    #[test]
    fn invalid_memory_never_produces_args() {
        assert!(memory_args(&MemorySettings::new(8192, 2048)).is_err());
    }

    #[test]
    fn picks_smallest_sufficient_major() {
        let runtime = |major| JavaRuntime {
            path: PathBuf::from(format!("C:/jdk{major}/bin/java.exe")),
            major,
            version: major.to_string(),
            vendor: None,
            arch: "x64".to_string(),
        };
        let picked = pick_runtime(vec![runtime(21), runtime(17), runtime(8)], 17).unwrap();
        assert_eq!(picked.major, 17);
        assert!(pick_runtime(vec![runtime(8)], 17).is_none());
    }

    #[test]
    fn resolves_install_directory_to_binary() {
        let resolved = resolve_java_executable(Path::new("C:/definitiv/nicht/vorhanden"));
        assert_eq!(resolved, PathBuf::from("C:/definitiv/nicht/vorhanden"));
    }
}
