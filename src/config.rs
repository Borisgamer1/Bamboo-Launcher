use crate::error::{LauncherError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MIN_MEMORY_MB: u32 = 512;
pub const MAX_MEMORY_MB: u32 = 65_536;

/// RAM-Zuweisung, die 1:1 zu `-Xms` / `-Xmx` wird.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySettings {
    pub min_mb: u32,
    pub max_mb: u32,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            min_mb: 1024,
            max_mb: 4096,
        }
    }
}

impl MemorySettings {
    pub fn new(min_mb: u32, max_mb: u32) -> Self {
        Self { min_mb, max_mb }
    }

    /// Prüft die Grenzen und dass der Initial-Heap nicht über dem Maximum liegt.
    pub fn validate(&self) -> Result<()> {
        if self.max_mb < MIN_MEMORY_MB {
            return Err(LauncherError::InvalidSettings(format!(
                "Der maximale Heap muss mindestens {MIN_MEMORY_MB} MB betragen."
            )));
        }
        if self.max_mb > MAX_MEMORY_MB {
            return Err(LauncherError::InvalidSettings(format!(
                "Der maximale Heap darf höchstens {MAX_MEMORY_MB} MB betragen."
            )));
        }
        if self.min_mb > self.max_mb {
            return Err(LauncherError::InvalidSettings(
                "Der Initial-Heap (-Xms) darf nicht größer als der maximale Heap (-Xmx) sein."
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

/// Benutzereinstellungen, die als JSON neben dem Launcher liegen.
///
/// Dieselbe Datei kann die Electron-Shell geschrieben haben; ihre Feldnamen
/// sind camelCase (`curseForgeApiKey`). Die Aliase sorgen dafür, dass der
/// Rust-Kern deren Werte liest, statt sie als „keine Einstellungen“ zu
/// verwerfen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherSettings {
    #[serde(default = "default_game_root", alias = "gameRoot")]
    pub game_root: PathBuf,
    #[serde(default, alias = "javaPath")]
    pub java_path: Option<PathBuf>,
    /// Optionaler CurseForge-API-Key. `BAMBOO_CURSEFORGE_API_KEY` hat Vorrang.
    #[serde(default, alias = "curseForgeApiKey", alias = "curseforgeApiKey")]
    pub curseforge_api_key: Option<String>,
    #[serde(default)]
    pub memory: MemorySettings,
    #[serde(default, alias = "extraJvmArgs")]
    pub extra_jvm_args: Vec<String>,
    #[serde(default, alias = "extraGameArgs")]
    pub extra_game_args: Vec<String>,
    #[serde(default, deserialize_with = "lenient_resolution")]
    pub resolution: Option<Resolution>,
    #[serde(default, alias = "demoMode")]
    pub demo_mode: bool,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            game_root: default_game_root(),
            java_path: None,
            curseforge_api_key: None,
            memory: MemorySettings::default(),
            extra_jvm_args: Vec::new(),
            extra_game_args: Vec::new(),
            resolution: None,
            demo_mode: false,
        }
    }
}

/// Eine fremde Datei darf ihre Auflösung anders ablegen; ein unbekanntes
/// Format soll dann nur dieses Feld kosten, nicht alle Einstellungen.
fn lenient_resolution<'de, D>(deserializer: D) -> std::result::Result<Option<Resolution>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

impl LauncherSettings {
    /// Lädt die Einstellungen oder liefert die Defaults, wenn noch keine Datei existiert.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(path)?;
        let settings: Self = serde_json::from_str(&text)?;
        settings.memory.validate()?;
        Ok(settings)
    }

    /// Schreibt die Einstellungen atomar über eine temporäre Datei.
    pub fn save(&self, path: &Path) -> Result<()> {
        self.memory.validate()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json)?;
        std::fs::rename(&temp, path)?;
        Ok(())
    }
}

/// `<APPDATA>\.minecraft` unter Windows, `~/.minecraft` sonst.
pub fn default_game_root() -> PathBuf {
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(".minecraft");
        }
    }
    home_dir().join(".minecraft")
}

/// Verzeichnis für Launcher-eigene Dateien (Einstellungen, Logs).
pub fn default_config_dir() -> PathBuf {
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("BambooLauncher");
        }
    }
    home_dir().join(".config").join("bamboo-launcher")
}

pub fn default_settings_path() -> PathBuf {
    default_config_dir().join("settings.json")
}

/// Eigene Einstellungen des Rust-Kerns.
///
/// Bewusst eine eigene Datei: `settings.json` gehört der React-Oberfläche. Ein
/// Schreiben dorthin würde Theme, Sprache, Onboarding und den CurseForge-Key
/// der Oberfläche löschen.
pub fn default_core_settings_path() -> PathBuf {
    default_config_dir().join("core.json")
}

/// Zwischenspeicher für Manifeste (Versionsliste, Java-Runtimes).
pub fn default_cache_dir() -> PathBuf {
    default_config_dir().join("cache")
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_memory_is_valid() {
        assert!(MemorySettings::default().validate().is_ok());
    }

    #[test]
    fn rejects_inverted_heap() {
        assert!(MemorySettings::new(4096, 2048).validate().is_err());
    }

    #[test]
    fn rejects_tiny_heap() {
        assert!(MemorySettings::new(256, 256).validate().is_err());
    }

    #[test]
    fn round_trips_through_json() {
        let settings = LauncherSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: LauncherSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.memory, settings.memory);
        assert_eq!(parsed.game_root, settings.game_root);
    }

    /// `%APPDATA%/bamboo-launcher/settings.json` schreibt die Electron-Shell:
    /// camelCase, ohne Spielwurzel, mit fremden Schlüsseln daneben. Diese Datei
    /// muss lesbar bleiben, sonst startet der Rust-Kern ohne CurseForge-Key.
    #[test]
    fn reads_the_settings_shape_of_the_electron_shell() {
        let json = r#"{
            "currentTheme": "bamboo",
            "lang": "de",
            "telemetryEnabled": false,
            "onboarding": { "done": true },
            "preferences": { "instanceDefaults": { "ramMb": 8192 } },
            "curseForgeApiKey": "  key-123  ",
            "gameRoot": "C:/Games/.minecraft",
            "resolution": "1920x1080"
        }"#;
        let parsed: LauncherSettings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.curseforge_api_key.as_deref(), Some("  key-123  "));
        assert_eq!(parsed.game_root, PathBuf::from("C:/Games/.minecraft"));
        assert!(
            parsed.resolution.is_none(),
            "unbekanntes Format kostet nur das Feld"
        );
    }
}
