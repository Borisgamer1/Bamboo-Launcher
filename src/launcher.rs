use crate::config::{MemorySettings, Resolution};
use crate::error::{LauncherError, Result};
use crate::java::{memory_args, JavaRuntime};
use crate::version::{resolve_version_with_features, PlatformInfo, ResolvedVersion};
use md5::{Digest, Md5};
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

pub const LAUNCHER_NAME: &str = "Bamboo Launcher";
pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const LAUNCH_CLIENT_ID: &str = "bamboo-launcher";

/// Wer spielt: Microsoft-Konto oder Offline-Profil.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserType {
    Msa,
    Legacy,
}

impl UserType {
    fn as_str(self) -> &'static str {
        match self {
            UserType::Msa => "msa",
            UserType::Legacy => "legacy",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Account {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    pub user_type: UserType,
}

impl Account {
    /// Offline-Profil: kein Token, UUID deterministisch aus dem Namen.
    pub fn offline(username: impl Into<String>) -> Self {
        let username = username.into();
        Self {
            uuid: offline_uuid(&username),
            username,
            access_token: "0".to_string(),
            user_type: UserType::Legacy,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub account: Account,
    pub memory: MemorySettings,
    pub java: JavaRuntime,
    pub extra_jvm_args: Vec<String>,
    pub extra_game_args: Vec<String>,
    pub resolution: Option<Resolution>,
    pub demo: bool,
    pub server: Option<(String, u16)>,
    pub quick_play_world: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub command: Vec<String>,
    pub working_dir: PathBuf,
    pub version: ResolvedVersion,
}

impl LaunchPlan {
    /// Kommandozeile ohne Zugangsdaten – so darf sie ins Log.
    pub fn display_command(&self) -> Vec<String> {
        redact_command(&self.command)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone)]
pub enum LaunchEvent {
    Line { stream: OutputStream, text: String },
    Ready,
    CrashReport(PathBuf),
}

/// Laufender Minecraft-Prozess mit nicht-blockierender Ausgabe.
pub struct GameProcess {
    child: Child,
    events: mpsc::UnboundedReceiver<LaunchEvent>,
    pump: tokio::task::JoinHandle<()>,
}

impl GameProcess {
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Nächstes Ereignis aus stdout/stderr, `None` wenn beide Ströme enden.
    pub async fn next_event(&mut self) -> Option<LaunchEvent> {
        self.events.recv().await
    }

    /// Wartet auf das Prozessende und leert vorher die Ausgabepuffer.
    pub async fn wait(&mut self) -> Result<ExitStatus> {
        let status = self.child.wait().await?;
        let _ = (&mut self.pump).await;
        Ok(status)
    }

    /// Verarbeitet Ereignisse, bis der Prozess endet – blockiert den Launcher nicht.
    pub async fn pump_until_exit<F>(&mut self, mut on_event: F) -> Result<ExitStatus>
    where
        F: FnMut(&LaunchEvent),
    {
        let mut status: Option<ExitStatus> = None;
        while status.is_none() {
            tokio::select! {
                event = self.events.recv() => {
                    match event {
                        Some(event) => on_event(&event),
                        None => status = Some(self.child.wait().await?),
                    }
                }
                result = self.child.wait() => status = Some(result?),
            }
        }
        let _ = (&mut self.pump).await;
        Ok(status.expect("Status wurde gesetzt"))
    }

    /// Beendet den Spielprozess samt Kindprozessen.
    pub async fn kill(&mut self) -> Result<()> {
        let Some(pid) = self.child.id() else {
            return Ok(());
        };
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .output()
                .await;
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .await;
        }
        let _ = self.child.kill().await;
        Ok(())
    }
}

/// Offline-UUID: MD5 von `OfflinePlayer:<name>` mit gesetzter Version 3.
pub fn offline_uuid(username: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{username}").as_bytes());
    let mut hash = hasher.finalize();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Pfade müssen für Minecraft immer mit `/` geschrieben werden.
pub fn to_mc_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Ersetzt `${...}`-Platzhalter; unbekannte bleiben unverändert stehen.
pub fn format_argument(template: &str, values: &HashMap<String, String>) -> String {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(r"\$\{(.*?)\}").expect("gültiges Regex"));
    pattern
        .replace_all(template, |captures: &regex::Captures<'_>| {
            values
                .get(&captures[1])
                .cloned()
                .unwrap_or_else(|| captures[0].to_string())
        })
        .into_owned()
}

/// Ältere Versionen lesen ihre Assets über `${game_assets}`. Ab 1.7 liegen
/// sie unter `assets/virtual/<index>`; der Index selbst sagt, ob er
/// virtualisiert wurde, deshalb wird er bei Legacy-Versionen gelesen.
fn game_assets_dir(version: &ResolvedVersion) -> PathBuf {
    if !version.legacy {
        return version.assets_root.clone();
    }

    let legacy_field = version
        .assets_field
        .as_deref()
        .is_some_and(|field| field == "legacy" || field.starts_with("pre-"));
    let index_virtual = std::fs::read_to_string(
        version
            .assets_root
            .join("indexes")
            .join(format!("{}.json", version.asset_index)),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .is_some_and(|json| {
        json.get("virtual")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || json
                .get("map_to_resources")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    });

    if legacy_field || index_virtual {
        version
            .assets_root
            .join("virtual")
            .join(&version.asset_index)
    } else {
        version.assets_root.clone()
    }
}

pub fn has_classpath_argument(arguments: &[String]) -> bool {
    arguments.iter().any(|argument| {
        matches!(argument.as_str(), "-cp" | "-classpath" | "--class-path")
            || argument.starts_with("-cp=")
            || argument.starts_with("-classpath=")
    })
}

/// Quick Play gibt es ab Minecraft 1.20.
pub fn supports_quick_play(version: &str) -> bool {
    let mut parts = version.split('.');
    let major: u32 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    major > 1 || (major == 1 && minor >= 20)
}

/// Entfernt Access-Tokens aus einer Kommandozeile.
pub fn redact_command(command: &[String]) -> Vec<String> {
    let mut redacted = command.to_vec();
    let mut index = 0;
    while index < redacted.len() {
        let current = redacted[index].to_lowercase();
        if (current == "--accesstoken" || current == "--session") && index + 1 < redacted.len() {
            redacted[index + 1] = "****".to_string();
        } else if current.starts_with("--accesstoken=") || current.starts_with("--session=") {
            redacted[index] = format!("{}=****", redacted[index].split('=').next().unwrap_or(""));
        } else if current.contains("token=") {
            redacted[index] = redacted[index]
                .split('=')
                .next()
                .map(|prefix| format!("{prefix}=****"))
                .unwrap_or_else(|| "****".to_string());
        }
        index += 1;
    }
    redacted
}

fn strip_platform_prefix(entry: &str) -> Option<String> {
    const OS: [&str; 5] = ["windows", "linux", "macosx", "osx", "macos"];
    const ARCH: [&str; 7] = ["x64", "amd64", "x86", "i386", "arm64", "aarch64", "arm"];

    let mut segments: Vec<&str> = entry.split('/').filter(|part| !part.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    if !OS.contains(&segments[0].to_lowercase().as_str()) {
        return Some(segments.join("/"));
    }
    segments.remove(0);
    if !segments.is_empty() && ARCH.contains(&segments[0].to_lowercase().as_str()) {
        segments.remove(0);
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

fn is_excluded(entry: &str, patterns: &[String]) -> bool {
    if entry.starts_with("META-INF/") || entry.ends_with(".sha1") || entry.ends_with(".git") {
        return true;
    }
    patterns.iter().any(|pattern| {
        if pattern.is_empty() {
            return false;
        }
        if pattern.ends_with('/') {
            entry.starts_with(pattern)
        } else {
            entry == pattern || entry.rsplit('/').next() == Some(pattern.as_str())
        }
    })
}

/// Entpackt die Native-Archive der Version in das Zielverzeichnis.
///
/// Bereits vollständig entpackte Dateien bleiben liegen: Eine laufende Instanz
/// hält ihre DLLs unter Windows gesperrt, und ein zweiter Start derselben
/// Minecraft-Version würde beim Überschreiben mit „Zugriff verweigert“
/// scheitern. Genau das hat bisher verhindert, zwei Instanzen nebeneinander
/// laufen zu lassen.
pub fn extract_natives(version: &ResolvedVersion, target: &Path) -> Result<usize> {
    if version.natives.is_empty() {
        return Ok(0);
    }
    std::fs::create_dir_all(target)?;

    // Zwei gleichzeitige Starts desselben Versionsordners dürfen sich beim
    // Entpacken nicht überholen; das Entpacken ist kurz, der Lock bleibt also
    // unkritisch.
    static EXTRACT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = EXTRACT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut extracted = 0;
    for library in &version.natives {
        if !library.path.is_file() {
            return Err(LauncherError::VersionNotFound(
                library.name.clone(),
                library.path.clone(),
            ));
        }
        let file = std::fs::File::open(&library.path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name()?.replace('\\', "/");
            if is_excluded(&name, &library.extract_exclude) {
                continue;
            }
            let Some(relative) = strip_platform_prefix(&name) else {
                continue;
            };
            let destination = target.join(&relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if std::fs::metadata(&destination)
                .map(|meta| meta.len() == entry.size())
                .unwrap_or(false)
            {
                continue;
            }
            let mut output = match std::fs::File::create(&destination) {
                Ok(file) => file,
                // Das Spiel hält die Datei offen: Sie ist schon da und wird
                // weiter benutzt, also überspringen statt den Start verweigern.
                Err(error)
                    if destination.exists()
                        && error.kind() == std::io::ErrorKind::PermissionDenied =>
                {
                    continue
                }
                Err(error) => return Err(error.into()),
            };
            std::io::copy(&mut entry, &mut output)?;
            extracted += 1;
        }
    }
    Ok(extracted)
}

/// Setzt die Spielsprache in der `options.txt` des Spielverzeichnisses.
///
/// Minecraft liest die Sprache nur dort; ein Kommandozeilen-Argument dafür gibt
/// es nicht. Modpacks mit YOSBR legen ihre Vorgaben in
/// `config/yosbr/options.txt` ab und kopieren sie beim Start über die
/// `options.txt`, deshalb wird die Datei mitgepflegt.
pub fn apply_language(game_dir: &Path, language: &str) -> Result<bool> {
    let Some(code) = normalize_language(language) else {
        return Ok(false);
    };
    apply_options(game_dir, &[("lang", code)])?;
    Ok(true)
}

/// Setzt den Vollbild-Schalter, den die Oberfläche für die Instanz vorgibt.
///
/// Ohne diesen Eintrag entscheidet allein die `options.txt`: War dort noch
/// `fullscreen:false` gespeichert (frische Instanz, importiertes Pack, zuletzt
/// im Fenster gespielt), startete das Spiel im Fenster, egal was im Launcher
/// eingestellt war. Darum fällt der automatische Vollbildstart manchmal aus.
pub fn apply_fullscreen(game_dir: &Path, fullscreen: bool) -> Result<()> {
    let value = if fullscreen { "true" } else { "false" };
    apply_options(game_dir, &[("fullscreen", value.to_string())])
}

/// Schreibt Werte in die `options.txt` des Spielverzeichnisses und, wenn das
/// Modpack YOSBR nutzt, auch in dessen Vorgabedatei – die wird beim Start über
/// die `options.txt` kopiert und würde die Werte sonst überschreiben.
pub fn apply_options<K: AsRef<str>>(game_dir: &Path, values: &[(K, String)]) -> Result<()> {
    let options = game_dir.join("options.txt");
    for (key, value) in values {
        write_option(&options, key.as_ref(), value)?;
    }
    let yosbr = game_dir.join("config").join("yosbr").join("options.txt");
    if yosbr.is_file() {
        for (key, value) in values {
            write_option(&yosbr, key.as_ref(), value)?;
        }
    }
    Ok(())
}

/// Prüft einen Sprachcode wie `de_de` und gibt ihn kleingeschrieben zurück.
fn normalize_language(value: &str) -> Option<String> {
    let trimmed = value.trim().to_lowercase();
    let mut parts = trimmed.split('_');
    let language = parts.next()?;
    let region = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let valid = |part: &str, min: usize, max: usize| {
        (min..=max).contains(&part.len()) && part.chars().all(|c| c.is_ascii_lowercase())
    };
    if !valid(language, 2, 3) {
        return None;
    }
    match region {
        Some(region) if valid(region, 2, 2) => Some(format!("{language}_{region}")),
        Some(_) => None,
        None => Some(language.to_string()),
    }
}

/// Ersetzt einen Schlüssel in einer `options.txt` und lässt alle anderen Zeilen
/// unangetastet, damit die Datei keine Einstellungen verliert.
fn write_option(path: &Path, key: &str, value: &str) -> Result<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in existing.lines() {
        if line.split(':').next() == Some(key) {
            if !replaced {
                lines.push(format!("{key}:{value}"));
                replaced = true;
            }
            continue;
        }
        lines.push(line.to_string());
    }
    if !replaced {
        lines.push(format!("{key}:{value}"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut body = lines.join("\n");
    body.push('\n');
    std::fs::write(path, body)?;
    Ok(())
}

/// Baut den vollständigen Startbefehl inklusive Classpath und Argumenten.
pub fn build_launch_plan(
    game_root: &Path,
    version_id: &str,
    working_dir: &Path,
    options: &LaunchOptions,
) -> Result<LaunchPlan> {
    let platform = PlatformInfo::current();
    let mut features: HashMap<String, bool> = HashMap::new();
    if options.demo {
        features.insert("is_demo_user".to_string(), true);
    }
    if options.resolution.is_some() {
        features.insert("has_custom_resolution".to_string(), true);
    }

    let version = resolve_version_with_features(game_root, version_id, &platform, &features)?;

    let natives_dir = game_root
        .join("versions")
        .join(&version.id)
        .join(format!("{}-natives", version.id));
    // Auch ohne klassische Natives zeigen JVM-Argumente (jna.tmpdir,
    // SharedLibraryExtractPath) auf dieses Verzeichnis.
    std::fs::create_dir_all(&natives_dir)?;
    if !version.natives.is_empty() {
        extract_natives(&version, &natives_dir)?;
    }

    let separator = platform.classpath_separator();
    let classpath = version
        .classpath
        .iter()
        .map(|entry| to_mc_path(entry))
        .collect::<Vec<_>>()
        .join(&separator.to_string());

    let uuid = options.account.uuid.replace('-', "");
    let uuid = if uuid.is_empty() {
        offline_uuid(&options.account.username)
    } else {
        uuid
    };

    let resolution = options.resolution;
    let mut values: HashMap<String, String> = HashMap::new();
    values.insert("natives_directory".into(), to_mc_path(&natives_dir));
    values.insert("launcher_name".into(), LAUNCHER_NAME.into());
    values.insert("launcher_version".into(), LAUNCHER_VERSION.into());
    values.insert("game_directory".into(), to_mc_path(working_dir));
    values.insert("classpath".into(), classpath);
    values.insert(
        "library_directory".into(),
        to_mc_path(&game_root.join("libraries")),
    );
    values.insert("classpath_separator".into(), separator.to_string());
    values.insert("version_name".into(), version.id.clone());
    values.insert("auth_player_name".into(), options.account.username.clone());
    values.insert("auth_uuid".into(), uuid);
    values.insert(
        "auth_access_token".into(),
        options.account.access_token.clone(),
    );
    values.insert("auth_session".into(), options.account.access_token.clone());
    values.insert(
        "user_type".into(),
        options.account.user_type.as_str().into(),
    );
    values.insert("version_type".into(), version.version_type.clone());
    values.insert("user_properties".into(), "{}".into());
    values.insert("clientid".into(), LAUNCH_CLIENT_ID.into());
    values.insert("auth_xuid".into(), String::new());
    values.insert(
        "resolution_width".into(),
        resolution.map(|r| r.width.to_string()).unwrap_or_default(),
    );
    values.insert(
        "resolution_height".into(),
        resolution.map(|r| r.height.to_string()).unwrap_or_default(),
    );
    values.insert("assets_root".into(), to_mc_path(&version.assets_root));
    values.insert("game_assets".into(), to_mc_path(&game_assets_dir(&version)));
    values.insert("assets_index_name".into(), version.asset_index.clone());

    let mut command: Vec<String> = vec![options.java.path.to_string_lossy().into_owned()];
    command.extend(memory_args(&options.memory)?);
    command.extend(options.extra_jvm_args.iter().cloned());

    for argument in &version.jvm_arguments {
        let formatted = format_argument(argument, &values);
        // Heap-Flags des Versions-JSON haben keinen Vorrang vor den Einstellungen.
        if formatted.starts_with("-Xms") || formatted.starts_with("-Xmx") {
            continue;
        }
        command.push(formatted);
    }

    // Forge schreibt in `-DignoreList` den Versionsnamen; der Client-Jar trägt
    // aber den Namen der Basisversion. Ohne den echten Dateinamen scannt
    // BootstrapLauncher den Minecraft-Jar mit und der Start scheitert.
    if let Some(jar_name) = version
        .client_jar
        .file_name()
        .and_then(|name| name.to_str())
    {
        if let Some(index) = command
            .iter()
            .position(|argument| argument.starts_with("-DignoreList="))
        {
            let current = command[index].clone();
            let list = current.trim_start_matches("-DignoreList=");
            if !list.split(',').any(|entry| entry == jar_name) {
                command[index] = format!("{current},{jar_name}");
            }
        }
    }

    if !has_classpath_argument(&command) {
        command.push("-cp".to_string());
        command.push(values["classpath"].clone());
    }
    if !command
        .iter()
        .any(|argument| argument.starts_with("-Djava.library.path="))
    {
        command.push(format!(
            "-Djava.library.path={}",
            values["natives_directory"]
        ));
    }
    if !command
        .iter()
        .any(|argument| argument.starts_with("-Dminecraft.launcher.brand="))
    {
        command.push(format!("-Dminecraft.launcher.brand={LAUNCHER_NAME}"));
    }
    if let Some(log_config) = &version.log_config {
        let path = game_root
            .join("assets")
            .join("log_configs")
            .join(&log_config.file_id);
        if path.is_file() {
            command.push(log_config.argument.replace("${path}", &to_mc_path(&path)));
        }
    }

    command.push(version.main_class.clone());

    for argument in &version.game_arguments {
        command.push(format_argument(argument, &values));
    }

    let quick_play = supports_quick_play(&version.minecraft_version);
    if let Some((host, port)) = &options.server {
        if quick_play {
            command.push("--quickPlayMultiplayer".to_string());
            command.push(format!("{host}:{port}"));
        } else {
            command.push("--server".to_string());
            command.push(host.clone());
            command.push("--port".to_string());
            command.push(port.to_string());
        }
    } else if let Some(world) = &options.quick_play_world {
        if quick_play {
            command.push("--quickPlaySingleplayer".to_string());
            command.push(world.clone());
        }
    }

    if options.demo && !command.iter().any(|argument| argument == "--demo") {
        command.push("--demo".to_string());
    }
    command.extend(options.extra_game_args.iter().cloned());

    Ok(LaunchPlan {
        command,
        working_dir: working_dir.to_path_buf(),
        version,
    })
}

async fn open_log(path: &Path) -> Option<tokio::fs::File> {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .ok()
}

async fn read_stream<R>(
    stream: R,
    kind: OutputStream,
    sender: mpsc::UnboundedSender<LaunchEvent>,
    log: Arc<Mutex<Option<tokio::fs::File>>>,
    ready: Arc<AtomicBool>,
) where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !ready.load(Ordering::Relaxed) && is_ready_marker(&line) {
            ready.store(true, Ordering::Relaxed);
            let _ = sender.send(LaunchEvent::Ready);
        }
        if let Some(path) = crash_report_path(&line) {
            let _ = sender.send(LaunchEvent::CrashReport(path));
        }
        if let Some(handle) = log.lock().await.as_mut() {
            let _ = handle.write_all(format!("{line}\n").as_bytes()).await;
        }
        let _ = sender.send(LaunchEvent::Line {
            stream: kind,
            text: line,
        });
    }
}

fn is_ready_marker(line: &str) -> bool {
    const MARKERS: [&str; 5] = [
        "LWJGL Version:",
        "OpenAL initialized",
        "Reloading ResourceManager",
        "Preparing level",
        "Setting user:",
    ];
    MARKERS
        .iter()
        .any(|marker| line.to_lowercase().contains(&marker.to_lowercase()))
}

fn crash_report_path(line: &str) -> Option<PathBuf> {
    let marker = "Crash report saved to:";
    let index = line.find(marker)?;
    let path = line[index + marker.len()..].trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}
/// Startet einen beliebigen Prozess asynchron und streamt seine Ausgabe.
pub async fn spawn_process(
    argv: &[String],
    working_dir: &Path,
    log_path: Option<PathBuf>,
) -> Result<GameProcess> {
    let program = argv
        .first()
        .ok_or_else(|| LauncherError::Spawn("Der Startbefehl ist leer.".to_string()))?;

    let mut command = Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        LauncherError::Spawn(format!("{program} konnte nicht gestartet werden: {error}"))
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (sender, events) = mpsc::unbounded_channel();
    // Der Sender bleibt nur in den Reader-Tasks; enden beide, schließt der Kanal.

    let log = Arc::new(Mutex::new(match &log_path {
        Some(path) => open_log(path).await,
        None => None,
    }));
    let ready = Arc::new(AtomicBool::new(false));

    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(tokio::spawn(read_stream(
            stdout,
            OutputStream::Stdout,
            sender.clone(),
            log.clone(),
            ready.clone(),
        )));
    }
    if let Some(stderr) = stderr {
        readers.push(tokio::spawn(read_stream(
            stderr,
            OutputStream::Stderr,
            sender.clone(),
            log,
            ready,
        )));
    }
    let pump = tokio::spawn(async move {
        for reader in readers {
            let _ = reader.await;
        }
    });

    drop(sender);

    Ok(GameProcess {
        child,
        events,
        pump,
    })
}

/// Startet den Spielprozess aus einem fertigen Plan.
pub async fn spawn_game(plan: &LaunchPlan, log_path: Option<PathBuf>) -> Result<GameProcess> {
    spawn_process(&plan.command, &plan.working_dir, log_path).await
}

/// Bequemer Start: Plan bauen und Prozess starten.
pub async fn launch_game(plan: LaunchPlan, log_path: Option<PathBuf>) -> Result<GameProcess> {
    spawn_game(&plan, log_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values() -> HashMap<String, String> {
        HashMap::from([
            ("classpath".to_string(), "a.jar;b.jar".to_string()),
            ("natives_directory".to_string(), "C:/natives".to_string()),
            ("auth_access_token".to_string(), "geheim".to_string()),
        ])
    }

    #[test]
    fn language_is_written_into_a_fresh_options_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(apply_language(dir.path(), "de_de").unwrap());
        let body = std::fs::read_to_string(dir.path().join("options.txt")).unwrap();
        assert_eq!(body, "lang:de_de\n");
    }

    #[test]
    fn language_replaces_the_existing_value_and_keeps_other_options() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("options.txt"),
            "fov:0.5\nlang:en_us\nrenderDistance:12\n",
        )
        .unwrap();
        apply_language(dir.path(), "fr_fr").unwrap();
        let body = std::fs::read_to_string(dir.path().join("options.txt")).unwrap();
        assert_eq!(body, "fov:0.5\nlang:fr_fr\nrenderDistance:12\n");
    }

    #[test]
    fn language_updates_yosbr_defaults_when_the_pack_uses_them() {
        let dir = tempfile::tempdir().unwrap();
        let yosbr = dir.path().join("config").join("yosbr").join("options.txt");
        std::fs::create_dir_all(yosbr.parent().unwrap()).unwrap();
        std::fs::write(&yosbr, "lang:en_us\nfov:0.5\n").unwrap();
        apply_language(dir.path(), "de_de").unwrap();
        let body = std::fs::read_to_string(&yosbr).unwrap();
        assert!(body.contains("lang:de_de"));
        assert!(body.contains("fov:0.5"));
    }

    #[test]
    fn invalid_language_codes_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!apply_language(dir.path(), "kein code").unwrap());
        assert!(!dir.path().join("options.txt").exists());
    }

    #[test]
    fn fullscreen_overrides_the_saved_value_and_keeps_other_options() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("options.txt"),
            "fullscreen:false\nlang:de_de\nfov:0.5\n",
        )
        .unwrap();
        apply_fullscreen(dir.path(), true).unwrap();
        let body = std::fs::read_to_string(dir.path().join("options.txt")).unwrap();
        assert_eq!(body, "fullscreen:true\nlang:de_de\nfov:0.5\n");

        apply_fullscreen(dir.path(), false).unwrap();
        let body = std::fs::read_to_string(dir.path().join("options.txt")).unwrap();
        assert_eq!(body, "fullscreen:false\nlang:de_de\nfov:0.5\n");
    }

    #[test]
    fn fullscreen_is_added_to_a_fresh_options_file() {
        let dir = tempfile::tempdir().unwrap();
        apply_fullscreen(dir.path(), true).unwrap();
        let body = std::fs::read_to_string(dir.path().join("options.txt")).unwrap();
        assert_eq!(body, "fullscreen:true\n");
    }

    #[test]
    fn fullscreen_updates_yosbr_defaults_when_the_pack_uses_them() {
        let dir = tempfile::tempdir().unwrap();
        let yosbr = dir.path().join("config").join("yosbr").join("options.txt");
        std::fs::create_dir_all(yosbr.parent().unwrap()).unwrap();
        std::fs::write(&yosbr, "fullscreen:false\nlang:en_us\n").unwrap();
        apply_fullscreen(dir.path(), true).unwrap();
        let body = std::fs::read_to_string(&yosbr).unwrap();
        assert!(body.contains("fullscreen:true"));
        assert!(body.contains("lang:en_us"));
    }

    #[test]
    fn offline_uuid_is_stable_and_version_3() {
        let first = offline_uuid("Boris");
        assert_eq!(first, offline_uuid("Boris"));
        assert_ne!(first, offline_uuid("Steve"));
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(&first[12..13], "3", "UUID-Version muss 3 sein");
        assert!(
            matches!(&first[16..17], "8" | "9" | "a" | "b"),
            "UUID-Variante muss RFC 4122 sein"
        );
    }

    #[test]
    fn formats_known_placeholders_only() {
        let values = values();
        assert_eq!(
            format_argument("${natives_directory}/x", &values),
            "C:/natives/x"
        );
        assert_eq!(format_argument("${unbekannt}", &values), "${unbekannt}");
    }

    #[test]
    fn converts_windows_separators() {
        assert_eq!(to_mc_path(Path::new("C:\\Spiel\\mods")), "C:/Spiel/mods");
    }

    #[test]
    fn detects_existing_classpath_flags() {
        assert!(has_classpath_argument(&[
            "-cp".to_string(),
            "x".to_string()
        ]));
        assert!(has_classpath_argument(&["-classpath=y".to_string()]));
        assert!(!has_classpath_argument(&["-Xmx4G".to_string()]));
    }

    #[test]
    fn quick_play_starts_at_1_20() {
        assert!(supports_quick_play("1.20"));
        assert!(supports_quick_play("1.20.4"));
        assert!(supports_quick_play("1.21.1"));
        assert!(!supports_quick_play("1.19.4"));
        assert!(!supports_quick_play("1.8.9"));
        assert!(!supports_quick_play("unbekannt"));
    }

    #[test]
    fn redacts_tokens() {
        let command = vec![
            "java".to_string(),
            "--accessToken".to_string(),
            "geheim".to_string(),
            "--session=abc".to_string(),
        ];
        let redacted = redact_command(&command);
        assert_eq!(redacted[2], "****");
        assert_eq!(redacted[3], "--session=****");
    }

    #[test]
    fn strips_platform_prefix_from_natives() {
        assert_eq!(
            strip_platform_prefix("windows/x64/lwjgl.dll").as_deref(),
            Some("lwjgl.dll")
        );
        assert_eq!(
            strip_platform_prefix("linux/org/lwjgl/liblwjgl.so").as_deref(),
            Some("org/lwjgl/liblwjgl.so")
        );
        assert_eq!(
            strip_platform_prefix("lwjgl.dll").as_deref(),
            Some("lwjgl.dll")
        );
    }

    #[test]
    fn excludes_meta_inf_and_patterns() {
        assert!(is_excluded("META-INF/MANIFEST.MF", &[]));
        assert!(is_excluded("foo.dll", &["foo.dll".to_string()]));
        assert!(is_excluded("docs/readme.txt", &["docs/".to_string()]));
        assert!(!is_excluded("lwjgl.dll", &["foo.dll".to_string()]));
    }

    #[test]
    fn recognizes_crash_report_lines() {
        let path = crash_report_path("Crash report saved to: C:\\Spiel\\crash-2024.txt");
        assert_eq!(path, Some(PathBuf::from("C:\\Spiel\\crash-2024.txt")));
        assert_eq!(crash_report_path("nichts"), None);
    }
}
