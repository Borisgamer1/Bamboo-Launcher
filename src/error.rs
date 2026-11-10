use std::path::PathBuf;
use thiserror::Error;

/// Alles, was im Launcher schiefgehen kann. Jeder Variant trägt genug Kontext,
/// dass die UI eine brauchbare Meldung anzeigen kann, ohne den Fehler zu erraten.
#[derive(Debug, Error)]
pub enum LauncherError {
    #[error("Java wurde nicht gefunden. Setze JAVA_HOME oder trage einen Pfad in den Einstellungen ein.")]
    JavaNotFound,

    #[error("Keine passende Java-Version gefunden: benötigt wird Java {required}, gefunden wurde {found}")]
    JavaVersionMismatch { required: u32, found: String },

    #[error("Version '{0}' ist nicht installiert (erwartet: {1})")]
    VersionNotFound(String, PathBuf),

    #[error("Ungültiges Versions-JSON in {path}: {reason}")]
    InvalidVersionJson { path: PathBuf, reason: String },

    #[error("Zyklische inheritsFrom-Kette: {0}")]
    CircularInheritance(String),

    #[error("Version '{0}' hat keine mainClass")]
    MissingMainClass(String),

    #[error("Instanz '{0}' existiert nicht")]
    InstanceNotFound(String),

    #[error("Instanz '{0}' existiert bereits")]
    InstanceExists(String),

    #[error("Sicherung '{0}' wurde nicht gefunden")]
    BackupNotFound(String),

    #[error("Ungültiger Instanzname: {0}")]
    InvalidInstanceName(String),

    #[error("Pfad liegt außerhalb des erlaubten Verzeichnisses: {0}")]
    UnsafePath(PathBuf),

    #[error("Ungültige Einstellung: {0}")]
    InvalidSettings(String),

    #[error("Java-Prozess konnte nicht gestartet werden: {0}")]
    Spawn(String),

    #[error("Java-Prozess endete mit Status {0}")]
    ProcessFailed(String),

    #[error("I/O-Fehler: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON-Fehler: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Archiv-Fehler: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub type Result<T> = std::result::Result<T, LauncherError>;
