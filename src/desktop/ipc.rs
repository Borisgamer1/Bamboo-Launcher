//! Tauri command layer for the ported renderer.
//!
//! Every command is the Rust end of the channel the Electron preload used to
//! expose, so the React UI keeps its exact markup and only changes transport.

use bamboo_launcher::auth::{self, MicrosoftAuth};
use bamboo_launcher::backup::{BackupManager, DEFAULT_KEEP};
use bamboo_launcher::config::{self, LauncherSettings, MemorySettings, Resolution};
use bamboo_launcher::cosmetics;
use bamboo_launcher::download::{Downloader as FileDownloader, FileSpec};
use bamboo_launcher::game_settings;
use bamboo_launcher::instances::{self, InstanceManager};
use bamboo_launcher::java;
use bamboo_launcher::launcher::{self, Account, LaunchEvent, LaunchOptions};
use bamboo_launcher::loader::LoaderInstaller;
use bamboo_launcher::modpack::ModpackImporter;
use bamboo_launcher::mods::{self, Loader};
use bamboo_launcher::sessions;
use bamboo_launcher::token_store::{self, KeyringStore, SessionManager};
use bamboo_launcher::version;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Long-lived process bookkeeping: a game is addressed by its instance folder.
#[derive(Default)]
pub struct LauncherState {
    running: Mutex<HashMap<String, u32>>,
    auth_pending: AtomicBool,
    /// Signal für den laufenden Browser-Login; `auth_cancel` löst es aus.
    auth_cancel: Mutex<Option<std::sync::Arc<tokio::sync::Notify>>>,
    closing: AtomicBool,
}

impl LauncherState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    pub fn mark_closing(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }

    /// Legt ein neues Abbruchsignal für den nächsten Login an.
    pub fn begin_auth_cancel(&self) -> std::sync::Arc<tokio::sync::Notify> {
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        if let Ok(mut slot) = self.auth_cancel.lock() {
            *slot = Some(notify.clone());
        }
        notify
    }

    /// Weckt einen wartenden Login. `notify_one` merkt sich das Signal, falls
    /// der Klick vor dem Warten ankommt.
    pub fn cancel_auth(&self) -> bool {
        match self.auth_cancel.lock() {
            Ok(slot) => match slot.as_ref() {
                Some(notify) => {
                    notify.notify_one();
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    pub fn clear_auth_cancel(&self) {
        if let Ok(mut slot) = self.auth_cancel.lock() {
            *slot = None;
        }
    }

    /// Läuft die Instanz gerade? Backups und Welt-Aktionen dürfen eine offene
    /// Instanz nicht unter den Füßen verändern.
    pub fn is_instance_running(&self, folder: &str) -> bool {
        self.running
            .lock()
            .map(|running| running.contains_key(folder))
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

pub(crate) fn ui_settings_path() -> PathBuf {
    config::default_config_dir().join("ui-settings.json")
}

/// Die Oberfläche speichert den Schalter oben in `ui-settings.json`; ältere
/// Stände hatten ihn unter `preferences`. Ohne Einstellung wird erfasst.
pub(crate) fn statistics_enabled() -> bool {
    read_json(&ui_settings_path())
        .and_then(|settings| {
            settings
                .get("statisticsEnabled")
                .or_else(|| settings.pointer("/preferences/statisticsEnabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

fn profiles_path() -> PathBuf {
    config::default_config_dir().join("profiles.json")
}

/// Kern-Einstellungen aus `core.json`; solange die Datei fehlt, dienen die
/// Werte der Oberfläche als Startpunkt (gleiche Spielwurzel, gleicher Key).
pub(crate) fn load_rust_settings() -> LauncherSettings {
    let core = config::default_core_settings_path();
    if core.is_file() {
        if let Ok(settings) = LauncherSettings::load(&core) {
            return settings;
        }
    }
    LauncherSettings::load(&config::default_settings_path()).unwrap_or_default()
}

pub(crate) fn manager(root: &Path) -> InstanceManager {
    let mut extra = instances::legacy_profiles_roots(&config::default_config_dir());
    // Das Spielverzeichnis kann die alten `profiles/` selbst tragen – auch
    // wenn die Electron-Wurzeldatei fehlt oder auf einen anderen Ordner zeigt.
    let profiles = root.join("profiles");
    if profiles.is_dir() && !extra.iter().any(|known| known == &profiles) {
        extra.push(profiles);
    }
    InstanceManager::new(root.join("instances")).with_extra_roots(extra)
}

/// Wurzel für Versionen, Libraries und Assets zu einer Instanz. Verwaltete
/// Instanzen teilen sich den Spielordner, die alten Profile haben ihre eigene
/// Wurzel mit eigenem `versions`, `libraries` und `assets`.
pub(crate) fn instance_content_root(root: &Path, instance_dir: &Path, version_id: &str) -> PathBuf {
    let own = instances::content_root(instance_dir);
    if !version_id.is_empty() {
        if let Some(own) = &own {
            if own.join("versions").join(version_id).is_dir() {
                return own.clone();
            }
        }
        if root.join("versions").join(version_id).is_dir() {
            return root.to_path_buf();
        }
    }
    own.filter(|dir| dir.join("versions").is_dir())
        .unwrap_or_else(|| root.to_path_buf())
}

/// Eintrag der alten Instanzliste, falls die Instanz von dort stammt.
fn legacy_profile(folder: &str) -> Option<instances::LegacyProfile> {
    instances::legacy_profiles(&config::default_config_dir())
        .into_iter()
        .find(|profile| profile.folder.eq_ignore_ascii_case(folder.trim()))
}

/// Versions-ID der Instanz: aus `instance.json`, sonst aus der alten Liste.
pub(crate) fn instance_version_id(instance: &instances::Instance) -> Option<String> {
    instance
        .version_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| legacy_profile(&instance.name).and_then(|profile| profile.version_id))
}

/// Anzeigename: alte Instanzliste, dann `instance.json`, zuletzt der Ordner.
fn instance_display_name(instance: &instances::Instance) -> String {
    legacy_profile(&instance.name)
        .map(|profile| profile.name)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            read_json(&instance.dir.join("instance.json"))
                .and_then(|meta| meta.get("name").and_then(Value::as_str).map(str::to_string))
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or_else(|| instance.name.clone())
}

/// Instanzordner für einen Ordnernamen – auch für Profile der Vorgänger-App.
fn instance_dir_or(root: &Path, folder: &str) -> PathBuf {
    manager(root)
        .instance_dir(folder)
        .unwrap_or_else(|_| root.join("instances").join(folder))
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|error| error.to_string())?;
    std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, value) => *target = value.clone(),
    }
}

pub(crate) fn session_manager() -> SessionManager<KeyringStore> {
    SessionManager::new(KeyringStore::new())
}

fn auth_status_from(book: &token_store::AccountBook, pending: bool) -> Value {
    match book.active_account() {
        Some(session) => {
            let now = token_store::now_ms();
            json!({
                "signedIn": true,
                "pending": pending,
                "tokenStoreDegraded": false,
                "account": {
                    "id": session.uuid,
                    "name": session.username,
                    "uuid": session.uuid,
                    "type": "Microsoft",
                    "active": true,
                    "avatar": format!("https://mc-heads.net/avatar/{}/64", session.uuid),
                    "expiresAt": session.minecraft_expires_at,
                    "expired": !session.tokens_valid(now),
                    "hasRefreshToken": session.refresh_token().is_some(),
                }
            })
        }
        None => json!({
            "signedIn": false,
            "pending": pending,
            "tokenStoreDegraded": false,
            "account": null,
        }),
    }
}

fn current_auth_status(pending: bool) -> Value {
    let book = session_manager().load_book().unwrap_or_default();
    auth_status_from(&book, pending)
}

/// Ein Eintrag der Kontenliste (Ansicht der Oberfläche).
fn account_view(session: &token_store::StoredSession, active: Option<&str>) -> Value {
    json!({
        "id": session.uuid,
        "name": session.username,
        "uuid": session.uuid,
        "type": "microsoft",
        "active": active.is_some_and(|id| id.eq_ignore_ascii_case(&session.uuid)),
        "avatar": format!("https://mc-heads.net/avatar/{}/64", session.uuid),
        "hasToken": !session.minecraft_access_token.is_empty(),
    })
}

fn account_list(book: &token_store::AccountBook) -> Value {
    let active = book.active.as_deref();
    json!(book
        .accounts
        .iter()
        .map(|session| account_view(session, active))
        .collect::<Vec<_>>())
}

pub(crate) fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(path);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/f", "/t"])
            .creation_flags(0x0800_0000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn();
    }
}

fn safe_file_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err(format!("Ungültiger Dateiname: {name}"));
    }
    Ok(name)
}

fn content_dir(instance_dir: &Path, item_type: &str) -> PathBuf {
    let sub = match item_type {
        "resourcepacks" | "resourcepack" => "resourcepacks",
        "shaderpacks" | "shaderpack" | "shaders" => "shaderpacks",
        "datapacks" | "datapack" => "datapacks",
        "worlds" | "world" | "saves" => "saves",
        _ => "mods",
    };
    instance_dir.join(sub)
}

fn loader_label(loader: Loader) -> String {
    loader.label().to_string()
}

/// Schreibweise, die die Oberfläche in `Instance["modloader"]` erwartet.
fn loader_slug(loader: Loader) -> String {
    match loader {
        Loader::Fabric => "Fabric",
        Loader::Forge => "Forge",
        // Die UI führt NeoForge als `Neoforge`; nur das Anzeige-Label trägt
        // die große Schreibweise. Vorher fiel der Filter dadurch leer aus.
        Loader::NeoForge => "Neoforge",
        Loader::Quilt => "Quilt",
    }
    .to_string()
}

/// Loader-Version aus der Profil-ID. Fabric und Quilt tragen sie vor der
/// Minecraft-Version (`fabric-loader-0.16.10-1.20.1`), Forge dahinter
/// (`1.20.1-forge-47.2.0`), NeoForge allein (`neoforge-21.1.77`).
///
/// Der letzte Bindestrich-Abschnitt taugt dafür nicht: bei Fabric ist das die
/// Minecraft-Version, nicht die Loader-Version.
fn loader_version_from_id(loader: Loader, version_id: &str) -> String {
    let id = version_id.trim();
    let version = match loader {
        Loader::Fabric => id
            .strip_prefix("fabric-loader-")
            .and_then(|rest| rest.rsplit_once('-').map(|(version, _)| version)),
        Loader::Quilt => id
            .strip_prefix("quilt-loader-")
            .and_then(|rest| rest.rsplit_once('-').map(|(version, _)| version)),
        Loader::Forge => id.split_once("-forge-").map(|(_, version)| version),
        Loader::NeoForge => id
            .strip_prefix("neoforge-")
            .or_else(|| id.split_once("-neoforge-").map(|(_, version)| version)),
    };
    version.unwrap_or_default().to_string()
}

pub(crate) fn instance_profile(root: &Path, instance: &instances::Instance) -> Value {
    let settings = load_rust_settings();
    let display_name = instance_display_name(instance);
    let version_id = instance_version_id(instance);
    let content_root =
        instance_content_root(root, &instance.dir, version_id.as_deref().unwrap_or(""));
    let (minecraft, loader, loader_version) = match &version_id {
        Some(version_id) => {
            let resolved = version::resolve_version(&content_root, version_id).ok();
            let loader = mods::detect_instance_loader(&content_root, version_id);
            (
                resolved
                    .as_ref()
                    .map(|value| value.minecraft_version.clone())
                    .unwrap_or_else(|| version_id.clone()),
                loader,
                loader
                    .map(|loader| loader_version_from_id(loader, version_id))
                    .unwrap_or_default(),
            )
        }
        None => ("1.21".to_string(), None, String::new()),
    };

    // Was auf der Platte liegt, kennt der Core selbst: eine frisch importierte
    // Instanz zeigt ihre Dateien damit sofort, statt auf den Tab-Scan der
    // Oberfläche zu warten. Projekt-ID und Quelle kommen aus der Bestandsdatei,
    // damit Update-Prüfungen auch nach einem Pack-Update funktionieren.
    let ledger = mods::ModLedger::load(&instance.dir).ok();
    let (content, mod_count) = disk_content(&instance.dir, ledger.as_ref());
    // Die installierten Projekt-IDs stehen schon in der Inhaltsliste; sie aus
    // dem Ledger erneut zu lesen wäre eine zweite Wahrheit mit anderem Stand.
    let installed_mods: Vec<String> = content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("mods"))
        .filter_map(|item| item.get("projectId").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let session_summary = sessions::summary(&instance.dir);
    // Die Bestandsdatei weiß, ob die Instanz aus einem Pack stammt – das ist
    // verlässlicher als ein von der Oberfläche gespeicherter Wert.
    let pack = ledger.as_ref().and_then(|ledger| {
        ledger
            .pack
            .clone()
            .map(|pack| (pack, ledger_source(ledger)))
    });

    let mut profile = json!({
        "id": instance.name,
        "name": display_name,
        "folderName": instance.name,
        "path": instance.dir.to_string_lossy(),
        "version": minecraft,
        "loader": loader.map(loader_slug).unwrap_or_else(|| "Vanilla".to_string()),
        "loaderVersion": loader_version,
        "minecraftVersion": minecraft,
        "lastPlayed": "Nie",
        "size": "0 MB",
        "mods": mod_count,
        "desc": "",
        "thumbnail": "",
        "javaPath": "Automatisch",
        "installedMods": installed_mods,
        "content": content,
        "ram": settings.memory.max_mb,
        "playTimeMs": 0,
        "sessionCount": session_summary.count,
        "lastPlayedAt": session_summary.last_seen,
        "isModpack": pack.is_some(),
    });

    if let Some(version_id) = &version_id {
        profile["versionId"] = json!(version_id);
    }
    if let Some(loader) = loader {
        profile["modLoader"] = json!(loader_label(loader));
    }
    if let Some((pack, source)) = &pack {
        profile["modpackVersion"] = json!(pack.version_id);
        if let Some(source) = source {
            profile["modpackSource"] = json!(source);
        }
    }
    profile
}

/// Woher die installierten Mods stammen, soweit die Bestandsdatei es weiß.
fn ledger_source(ledger: &mods::ModLedger) -> Option<&'static str> {
    if ledger
        .mods
        .iter()
        .any(|record| record.source == mods::ModSource::Modrinth)
    {
        Some("modrinth")
    } else if ledger
        .mods
        .iter()
        .any(|record| record.source == mods::ModSource::CurseForge)
    {
        Some("curseforge")
    } else {
        None
    }
}

/// Inhalte einer Instanz für die Oberfläche: Plattenstand plus Projekt-ID und
/// Quelle aus der Bestandsdatei. Damit antwortet ein Pack-Update gezielt mit
/// der neuen Liste, statt das ganze Profil neu zu projizieren.
pub(crate) fn instance_content(
    instance: &instances::Instance,
) -> (Vec<Value>, usize, Option<&'static str>) {
    let ledger = mods::ModLedger::load(&instance.dir).ok();
    let (content, mods) = disk_content(&instance.dir, ledger.as_ref());
    (content, mods, ledger.as_ref().and_then(ledger_source))
}

/// Dateien der vier Inhalts-Ordner, ohne Netz. Name und Version kommen aus der
/// Jar selbst, damit ein Forge-Mod nicht als Dateiname erscheint. Für Mods aus
/// der Bestandsdatei kommen Projekt-ID, Quelle und Versionsnummer dazu – ohne
/// sie würde die Inhaltsliste nach einem Pack-Update ihre Identität verlieren.
fn disk_content(instance_dir: &Path, ledger: Option<&mods::ModLedger>) -> (Vec<Value>, usize) {
    let mut items = Vec::new();
    let mut mods = 0;
    for item_type in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
        let dir = instance_dir.join(item_type);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.path().is_file())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort_by_key(|name| name.to_lowercase());
        for file_name in names {
            let metadata = if item_type == "mods" {
                instances::read_mod_metadata(&dir.join(&file_name))
            } else {
                None
            };
            let stem = file_name
                .trim_end_matches(".disabled")
                .trim_end_matches(".jar")
                .trim_end_matches(".zip")
                .to_string();
            let name = metadata
                .as_ref()
                .and_then(|meta| meta.name.clone().or_else(|| meta.id.clone()))
                .unwrap_or(stem);
            let plain_name = file_name.strip_suffix(".disabled").unwrap_or(&file_name);
            let record = if item_type == "mods" {
                ledger.and_then(|ledger| {
                    ledger
                        .mods
                        .iter()
                        .find(|record| record.file_name == plain_name)
                })
            } else {
                None
            };
            let version_number = record
                .map(|record| record.version_number.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| metadata.and_then(|meta| meta.version))
                .unwrap_or_default();
            if item_type == "mods" {
                mods += 1;
            }
            let mut item = json!({
                "id": format!("disk:{item_type}:{file_name}"),
                "name": name,
                "fileName": file_name,
                "version": "",
                "versionNumber": version_number,
                "type": item_type,
                "enabled": !file_name.ends_with(".disabled"),
                "locked": false,
            });
            if let Some(record) = record {
                item["projectId"] = json!(record.project_id);
                item["source"] = json!(match record.source {
                    mods::ModSource::Modrinth => "modrinth",
                    mods::ModSource::CurseForge => "curseforge",
                });
            }
            items.push(item);
        }
    }
    (items, mods)
}

/// Stored profiles first, then instances that exist on disk but were never
/// written to `profiles.json` (a fresh import, a CLI-created instance).
fn merged_profiles(root: &Path) -> Vec<Value> {
    let mut profiles: Vec<Value> = read_json(&profiles_path())
        .or_else(|| read_json(&config::default_config_dir().join("profiles.json")))
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();

    let known: Vec<String> = profiles
        .iter()
        .filter_map(|profile| {
            profile
                .get("folderName")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();

    if let Ok(instances) = manager(root).list() {
        for instance in instances {
            let fresh = instance_profile(root, &instance);
            match known.iter().position(|folder| folder == &instance.name) {
                // The stored profile keeps cover, description and playtime;
                // version, loader and path come from the disk truth.
                Some(index) => {
                    let mut merged = profiles[index].clone();
                    for key in [
                        "version",
                        "minecraftVersion",
                        "loader",
                        "loaderVersion",
                        "versionId",
                        "modLoader",
                        "path",
                        "isModpack",
                        "installedMods",
                        "modpackVersion",
                        "modpackSource",
                        // Sessions gehören dem Kern, nicht dem zuletzt von der
                        // Oberfläche gespeicherten Stand.
                        "sessionCount",
                        "lastPlayedAt",
                    ] {
                        if let Some(value) = fresh.get(key) {
                            merged[key] = value.clone();
                        }
                    }
                    profiles[index] = merged;
                }
                None => profiles.push(fresh),
            }
        }
    }
    profiles
}

fn emit_progress(
    app: &AppHandle,
    folder: &str,
    name: &str,
    percent: u32,
    label: &str,
    started: u64,
) {
    let _ = app.emit(
        "launch-progress",
        json!({
            "folderName": folder,
            "profileName": name,
            "percent": percent,
            "label": label,
            "startedAt": started,
        }),
    );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings() -> Value {
    let mut settings = read_json(&ui_settings_path()).unwrap_or_else(|| json!({}));
    let rust = load_rust_settings();
    settings["gameRoot"] = json!(rust.game_root.to_string_lossy());
    // Der Key bleibt im Kern: die Oberfläche erfährt nur, ob einer gesetzt ist,
    // und schickt beim Speichern einen neuen Wert. So landet das Geheimnis
    // nicht unnötig im Renderer.
    let key_set = curseforge_api_key().is_some();
    if let Some(object) = settings.as_object_mut() {
        object.remove("curseForgeApiKey");
    }
    settings["curseForgeApiKeySet"] = json!(key_set);
    settings
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Value) -> bool {
    let mut stored = read_json(&ui_settings_path()).unwrap_or_else(|| json!({}));
    merge(&mut stored, &settings);
    if write_json(&ui_settings_path(), &stored).is_err() {
        return false;
    }

    // The renderer owns the preferences; mirror the fields the core launches
    // with so CLI and UI stay on the same page.
    if let Some(defaults) = stored
        .get("preferences")
        .and_then(|preferences| preferences.get("instanceDefaults"))
    {
        let mut rust = load_rust_settings();
        let max = defaults
            .get("ramMb")
            .and_then(Value::as_u64)
            .unwrap_or(rust.memory.max_mb as u64)
            .clamp(config::MIN_MEMORY_MB as u64, config::MAX_MEMORY_MB as u64)
            as u32;
        let min = defaults
            .get("minRamMb")
            .and_then(Value::as_u64)
            .unwrap_or(rust.memory.min_mb as u64)
            .min(max as u64) as u32;
        rust.memory = MemorySettings::new(min, max);
        if let Some(java) = defaults.get("javaPath").and_then(Value::as_str) {
            rust.java_path = if java.trim().is_empty() {
                None
            } else {
                Some(PathBuf::from(java))
            };
        }
        // Nie in `settings.json` schreiben: die Datei gehört der Oberfläche.
        let _ = rust.save(&config::default_core_settings_path());
    }

    // Die Auswahl im Cosmetics-Tab wirkt sofort: Pakete wandern in die
    // eingeschlossenen Instanzen und verlassen die ausgeschlossenen.
    sync_cosmetics_into_instances(&load_rust_settings().game_root);

    let _ = app.emit("settings-saved", json!(true));
    true
}

// ---------------------------------------------------------------------------
// Instances and profiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_profiles() -> Value {
    Value::Array(merged_profiles(&load_rust_settings().game_root))
}

#[tauri::command]
pub fn save_profiles(profiles: Vec<Value>) -> bool {
    write_json(&profiles_path(), &Value::Array(profiles)).is_ok()
}

#[tauri::command]
pub fn list_instances() -> Value {
    let root = load_rust_settings().game_root;
    let settings = load_rust_settings();
    let listed = manager(&root).list().unwrap_or_default();
    let records: Vec<Value> = listed
        .iter()
        .map(|instance| {
            let version_id = instance_version_id(instance).unwrap_or_default();
            let content_root = instance_content_root(&root, &instance.dir, &version_id);
            let resolved = version::resolve_version(&content_root, &version_id).ok();
            let loader = mods::detect_instance_loader(&content_root, &version_id);
            json!({
                "id": instance.name,
                "name": instance_display_name(instance),
                "folderName": instance.name,
                "path": instance.dir.to_string_lossy(),
                "legacy": content_root != root,
                "version": version_id,
                "loader": loader.map(loader_label).unwrap_or_else(|| "vanilla".to_string()),
                "loaderVersion": loader
                    .map(|loader| loader_version_from_id(loader, &version_id))
                    .unwrap_or_default(),
                "javaPath": settings.java_path.as_ref().map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
                "minMemory": settings.memory.min_mb,
                "maxMemory": settings.memory.max_mb,
                "minecraftVersion": resolved.map(|value| value.minecraft_version).unwrap_or_default(),
                "createdAt": 0,
                "updatedAt": 0,
            })
        })
        .collect();
    Value::Array(records)
}

#[tauri::command]
pub async fn create_instance(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&folder)
        .trim()
        .to_string();
    let base_version = data
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("1.21")
        .to_string();

    if let Err(error) = instances::validate_instance_name(&folder) {
        return json!({"success": false, "error": error.to_string(), "code": "invalid-name"});
    }

    let manager = manager(&root);
    if manager
        .instance_dir(&folder)
        .map(|dir| dir.exists())
        .unwrap_or(false)
    {
        return json!({"success": false, "error": format!("'{folder}' existiert bereits."), "code": "exists"});
    }

    // A loader instance needs its launch profile; when that fails the instance
    // is still created on the base version so the user can repair it later.
    let mut version_id = base_version.clone();
    let loader = data
        .get("loader")
        .and_then(Value::as_str)
        .and_then(Loader::parse)
        .or_else(|| {
            data.get("modLoader")
                .and_then(Value::as_str)
                .and_then(Loader::parse)
        });
    if let Some(loader) = loader {
        let pinned = data
            .get("loaderVersion")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let installer = LoaderInstaller::new(config::default_cache_dir());
        // A failed loader install must not look like a successful creation:
        // the user would get a vanilla instance they never asked for.
        match installer
            .install(&root, &base_version, loader, pinned)
            .await
        {
            Ok(installed) => version_id = installed.version_id,
            Err(error) => {
                return json!({
                    "success": false,
                    "code": "loader-unsupported",
                    "error": format!("{} ließ sich nicht installieren: {error}", loader.label()),
                })
            }
        }
    }

    match manager.create(&name, Some(&version_id)) {
        Ok(instance) => {
            // Eine neue Instanz startet mit den installierten Cosmetics, sofern
            // sie nicht auf der Ausschlussliste steht.
            sync_cosmetics_into_instances(&root);
            json!({
                "success": true,
                "folderName": instance.name,
                "name": name,
                "path": instance.dir.to_string_lossy(),
                "created": true,
                "keybindCount": 0,
            })
        }
        Err(error) => {
            json!({"success": false, "error": error.to_string(), "code": "create-failed"})
        }
    }
}

#[tauri::command]
pub fn rename_instance(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let old = data
        .get("oldFolderName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let new = data
        .get("newName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let manager = manager(&root);

    let Ok(source) = manager.instance_dir(old) else {
        return json!({"success": false, "error": "Ungültiger Instanzname.", "code": "invalid-name"});
    };
    if instances::validate_instance_name(new).is_err() {
        return json!({"success": false, "error": "Ungültiger Instanzname.", "code": "invalid-name"});
    }
    if !source.is_dir() {
        return json!({"success": false, "error": format!("'{old}' wurde nicht gefunden."), "code": "not-found"});
    }
    // Die umbenannte Instanz bleibt in ihrem Ordner: fremde Profile werden
    // nicht in den verwalteten Spielordner verschoben.
    let target = source
        .parent()
        .map(|parent| parent.join(new))
        .unwrap_or_else(|| manager.instance_dir(new).unwrap_or_else(|_| source.clone()));
    if target.exists() {
        return json!({"success": false, "error": format!("'{new}' existiert bereits."), "code": "exists"});
    }
    if let Err(error) = std::fs::rename(&source, &target) {
        return json!({"success": false, "error": error.to_string(), "code": "rename-failed"});
    }
    if let Some(mut meta) = read_json(&target.join("instance.json")) {
        meta["name"] = json!(new);
        let _ = write_json(&target.join("instance.json"), &meta);
    }
    json!({"success": true, "newFolderName": new})
}

#[tauri::command]
pub fn delete_instance_files(folder_name: String) -> Value {
    let root = load_rust_settings().game_root;
    match manager(&root).remove(&folder_name) {
        Ok(()) => json!({"success": true, "deleted": true}),
        Err(error) => {
            json!({"success": false, "error": error.to_string(), "code": "delete-failed"})
        }
    }
}

#[tauri::command]
pub fn open_instance_folder(folder_name: String) -> Value {
    let root = load_rust_settings().game_root;
    match manager(&root).instance_dir(&folder_name) {
        Ok(dir) if dir.is_dir() => match open_path(&dir) {
            Ok(()) => json!({"success": true}),
            Err(error) => json!({"success": false, "error": error}),
        },
        Ok(_) => json!({"success": false, "error": "Instanz nicht gefunden."}),
        Err(error) => json!({"success": false, "error": error.to_string()}),
    }
}

#[tauri::command]
pub async fn change_instance_version(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let mc_version = data.get("mcVersion").and_then(Value::as_str).unwrap_or("");
    let loader = data
        .get("loader")
        .and_then(Value::as_str)
        .and_then(Loader::parse);

    let mut version_id = mc_version.to_string();
    if let Some(loader) = loader {
        let pinned = data
            .get("loaderVersion")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        match LoaderInstaller::new(config::default_cache_dir())
            .install(&root, mc_version, loader, pinned)
            .await
        {
            Ok(installed) => version_id = installed.version_id,
            Err(error) => {
                return json!({"success": false, "error": error.to_string(), "code": "loader-failed"})
            }
        }
    }

    let manager = manager(&root);
    let Ok(instance) = manager.load(folder) else {
        return json!({"success": false, "error": "Instanz nicht gefunden.", "code": "not-found"});
    };
    // Ein Versionswechsel ändert die Basis unter Welten und Configs. Die
    // Sicherung entsteht erst, wenn der Loader wirklich installiert ist.
    let backup = match BackupManager::new(&instance.dir).create("Vor Versionswechsel", DEFAULT_KEEP)
    {
        Ok(entry) => entry,
        Err(error) => {
            return json!({
                "success": false,
                "error": format!("Sicherung fehlgeschlagen: {error}"),
                "code": "backup-failed"
            })
        }
    };

    match manager.set_version(folder, &version_id) {
        Ok(_) => json!({
            "success": true,
            "mcVersion": mc_version,
            "loader": loader.map(loader_label).unwrap_or_else(|| "vanilla".to_string()),
            "loaderVersion": data.get("loaderVersion").cloned().unwrap_or(Value::Null),
            "versionId": version_id,
            "backup": backup,
        }),
        Err(error) => {
            json!({"success": false, "error": error.to_string(), "code": "version-failed"})
        }
    }
}

#[tauri::command]
pub fn update_launch_settings(folder_name: String, patch: Value) -> Value {
    let mut profiles = merged_profiles(&load_rust_settings().game_root);
    let mut updated = Value::Null;
    for profile in profiles.iter_mut() {
        let matches = profile
            .get("folderName")
            .and_then(Value::as_str)
            .map(|folder| folder.eq_ignore_ascii_case(&folder_name))
            .unwrap_or(false);
        if matches {
            merge(profile, &patch);
            updated = profile.clone();
        }
    }
    let _ = write_json(&profiles_path(), &Value::Array(profiles));
    updated
}

#[tauri::command]
pub fn read_latest_log(folder_name: String) -> String {
    let root = load_rust_settings().game_root;
    let path = instance_dir_or(&root, &folder_name)
        .join("logs")
        .join("latest.log");
    std::fs::read_to_string(path).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn auth_status(state: State<'_, LauncherState>) -> Value {
    current_auth_status(state.auth_pending.load(Ordering::Relaxed))
}

#[tauri::command]
pub async fn auth_login(app: AppHandle, state: State<'_, LauncherState>) -> Result<Value, String> {
    if state.auth_pending.swap(true, Ordering::SeqCst) {
        return Ok(current_auth_status(true));
    }
    let cancel = state.begin_auth_cancel();
    let _ = app.emit("bamboo:auth:changed", current_auth_status(true));

    let outcome = match MicrosoftAuth::new()
        .login_with_cancel(auth::open_browser, &cancel)
        .await
    {
        // Ein belegter Port (etwa von einem alten Versuch) darf die Anmeldung
        // nicht verhindern: Microsoft behandelt Loopback-Ports als austauschbar.
        Err(auth::AuthError::PortBusy(_)) => {
            let mut config = auth::AuthConfig::default();
            config.port = 0;
            MicrosoftAuth::with_config(config)
                .login_with_cancel(auth::open_browser, &cancel)
                .await
        }
        other => other,
    };
    state.auth_pending.store(false, Ordering::SeqCst);
    state.clear_auth_cancel();

    match outcome {
        Ok(outcome) => {
            // Ein vorhandenes Konto wird ersetzt, ein neues kommt dazu und wird
            // aktiv. Ein stiller Speicherfehler hätte wie ein kaputter Login
            // ausgesehen, deshalb geht er an die Oberfläche zurück.
            if let Err(error) = session_manager().save(&outcome) {
                let status = current_auth_status(false);
                let _ = app.emit("bamboo:auth:changed", status);
                return Err(format!(
                    "Die Sitzung konnte nicht gespeichert werden: {error}"
                ));
            }
            let status = current_auth_status(false);
            let _ = app.emit("bamboo:auth:changed", status.clone());
            Ok(status)
        }
        Err(error) => {
            let status = current_auth_status(false);
            let _ = app.emit("bamboo:auth:changed", status.clone());
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub fn auth_cancel(state: State<'_, LauncherState>) -> bool {
    state.cancel_auth()
}

#[tauri::command]
pub fn auth_logout(app: AppHandle, account_id: Option<String>) -> Value {
    let manager = session_manager();
    let book = manager.load_book().unwrap_or_default();
    let target = account_id
        .filter(|id| !id.trim().is_empty())
        .or_else(|| book.active.clone());
    let book = match target {
        Some(id) => manager.remove_account(&id).unwrap_or(book),
        None => {
            let _ = manager.clear();
            token_store::AccountBook::default()
        }
    };
    let status = auth_status_from(&book, false);
    let _ = app.emit("bamboo:auth:changed", status.clone());
    status
}

#[tauri::command]
pub async fn auth_refresh(app: AppHandle, account_id: Option<String>) -> Value {
    let manager = session_manager();
    let book = manager.load_book().unwrap_or_default();
    let target = account_id
        .filter(|id| !id.trim().is_empty())
        .or_else(|| book.active.clone());
    if let Some(session) = target
        .as_deref()
        .and_then(|id| {
            book.accounts
                .iter()
                .find(|account| account.uuid.eq_ignore_ascii_case(id))
        })
        .cloned()
    {
        if let Some(refresh_token) = session.refresh_token().map(str::to_string) {
            match MicrosoftAuth::new().refresh(&refresh_token).await {
                Ok(outcome) => {
                    let _ = manager.replace_account(&outcome);
                }
                // Abgelaufen heißt hier wirklich: neu anmelden.
                Err(auth::AuthError::InvalidGrant) => {
                    let _ = manager.remove_account(&session.uuid);
                }
                Err(_) => {}
            }
        }
    }
    let status = current_auth_status(false);
    let _ = app.emit("bamboo:auth:changed", status.clone());
    status
}

#[tauri::command]
pub fn player_identity() -> Value {
    let book = session_manager().load_book().unwrap_or_default();
    match book.active_account() {
        Some(session) => json!({
            "uuid": session.uuid,
            "username": session.username,
            "type": "Microsoft",
        }),
        None => Value::Null,
    }
}

#[tauri::command]
pub fn list_accounts() -> Value {
    let book = session_manager().load_book().unwrap_or_default();
    account_list(&book)
}

#[tauri::command]
pub fn set_active_account(app: AppHandle, id: String) -> Value {
    let manager = session_manager();
    let book = manager.set_active(&id).unwrap_or_default();
    let status = auth_status_from(&book, false);
    let _ = app.emit("bamboo:auth:changed", status);
    account_list(&book)
}

#[tauri::command]
pub fn remove_account(app: AppHandle, id: String) -> Value {
    let manager = session_manager();
    let book = manager.remove_account(&id).unwrap_or_default();
    let status = auth_status_from(&book, false);
    let _ = app.emit("bamboo:auth:changed", status);
    account_list(&book)
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/// Erneuert die Sitzung, wenn das Minecraft-Token kurz vor dem Ablauf steht.
///
/// Ohne das startete das Spiel mit einem abgelaufenen Token und die Anmeldung
/// scheiterte erst mitten im Start.
async fn refresh_session_if_stale() {
    let manager = session_manager();
    let Ok(Some(session)) = manager.load() else {
        return;
    };
    let expires = session.minecraft_expires_at;
    // Zehn Minuten Vorlauf: ein laufender Start darf nicht dazwischen geraten.
    if expires > 0 && expires.saturating_sub(token_store::now_ms()) > 10 * 60 * 1000 {
        return;
    }
    let Some(refresh_token) = session.refresh_token().map(str::to_string) else {
        return;
    };
    if let Ok(outcome) = MicrosoftAuth::new().refresh(&refresh_token).await {
        let _ = manager.replace_account(&outcome);
    }
}

#[tauri::command]
pub async fn launch_game(
    app: AppHandle,
    state: State<'_, LauncherState>,
    payload: Value,
) -> Result<(), String> {
    let folder = payload
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let profile = payload
        .get("profileName")
        .and_then(Value::as_str)
        .unwrap_or("Bamboo")
        .to_string();
    let started = token_store::now_ms();
    let root = load_rust_settings().game_root;
    let instance_dir = instance_dir_or(&root, &folder);
    let track_session = statistics_enabled();

    // Dieselbe Instanz nicht zweimal starten; verschiedene Instanzen dürfen
    // parallel laufen, dafür gibt es keine Obergrenze.
    if let Ok(running) = state.running.lock() {
        if running.contains_key(&folder) {
            let _ = app.emit(
                "launch-failed",
                json!({
                    "folderName": folder.clone(),
                    "profileName": profile.clone(),
                    "message": "Diese Instanz läuft bereits.",
                    "code": "already-running",
                }),
            );
            return Ok(());
        }
    }

    // Ein abgelaufenes Minecraft-Token würde den Start mit einer Anmeldung
    // quittieren; vorher still erneuern, mit Obergrenze, damit ein hängender
    // Microsoft-Server den Start nicht blockiert.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        refresh_session_if_stale(),
    )
    .await;

    emit_progress(
        &app,
        &folder,
        &profile,
        8,
        "Start wird vorbereitet",
        started,
    );

    match prepare_and_spawn(&payload, &folder).await {
        Ok(mut process) => {
            if let Some(pid) = process.pid() {
                if let Ok(mut running) = state.running.lock() {
                    running.insert(folder.clone(), pid);
                }
            }
            if track_session {
                let _ = sessions::record_start(&instance_dir);
            }
            emit_progress(&app, &folder, &profile, 65, "Spiel startet", started);

            let app_handle = app.clone();
            let folder_key = folder.clone();
            let profile_name = profile.clone();
            let session_dir = instance_dir.clone();
            tauri::async_runtime::spawn(async move {
                let status = process
                    .pump_until_exit(|event| match event {
                        LaunchEvent::Ready => {
                            let _ = app_handle.emit("launch-ready", &profile_name);
                        }
                        LaunchEvent::CrashReport(path) => {
                            let _ = app_handle
                                .emit("launch-status", format!("Crash-Report: {}", path.display()));
                        }
                        LaunchEvent::Line { .. } => {}
                    })
                    .await;

                let code = status
                    .map(|status| status.code().unwrap_or(0))
                    .unwrap_or(-1);
                if track_session {
                    let _ = sessions::record_end(&session_dir);
                }
                // Nach dem Ende wieder freigeben, sonst hält der Kern die
                // Instanz für immer als laufend und verweigert den nächsten Start.
                if let Some(state) = app_handle.try_state::<LauncherState>() {
                    if let Ok(mut running) = state.running.lock() {
                        running.remove(&folder_key);
                    }
                }
                let _ = app_handle.emit(
                    "game-closed",
                    json!({
                        "code": code,
                        "profileName": profile_name,
                        "folderName": folder_key,
                    }),
                );
            });
            Ok(())
        }
        Err(message) => {
            let _ = app.emit(
                "launch-failed",
                json!({
                    "folderName": folder,
                    "profileName": profile,
                    "message": message,
                    "code": "launch-failed",
                }),
            );
            Ok(())
        }
    }
}

async fn prepare_and_spawn(payload: &Value, folder: &str) -> Result<launcher::GameProcess, String> {
    let settings = load_rust_settings();
    let root = settings.game_root.clone();
    // Ein Start ist der sicherste Moment für den Abgleich: auch Instanzen, die
    // vor dem letzten Install angelegt wurden, sehen die Pakete.
    sync_cosmetics_into_instances(&root);
    let instance = if folder.is_empty() {
        None
    } else {
        manager(&root).load(folder).ok()
    };
    let (working_dir, log_path) = match &instance {
        Some(instance) => (
            instance.dir.clone(),
            Some(instance.dir.join("logs").join("latest.log")),
        ),
        None => (root.clone(), None),
    };

    // Sprache und Panel-Optionen gelten nur beim allerersten Start der
    // Instanz. Danach gehören die Werte dem Spiel: Was im Spiel geändert wird,
    // bleibt stehen, statt bei jedem Start von den Launcher-Standardwerten
    // überschrieben zu werden. Schlägt das Schreiben fehl, startet das Spiel
    // trotzdem – beides ist kein Startkriterium.
    if let Some(game_options) = payload.get("gameOptions").and_then(Value::as_object) {
        let language = game_options
            .get("lang")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut pairs = game_settings::options_from_ui(game_options);
        if let Some(keybinds) = game_options.get("keyBindings").and_then(Value::as_object) {
            pairs.extend(game_settings::keybinds_from_ui(keybinds));
        }
        // Pflegt zusätzlich die YOSBR-Vorgabedatei und lehnt ungültige
        // Sprachcodes ab, bevor etwas geschrieben wird.
        let _ = launcher::apply_options_once(&working_dir, language, &pairs);

        // Vollbild ist keine Option des Panels, sondern eine Startvorgabe der
        // Instanz. Ohne diesen Eintrag entscheidet allein die options.txt:
        // stand dort zuletzt `fullscreen:false`, startete das Spiel im
        // Fenster, egal was im Launcher eingestellt war.
        if let Some(fullscreen) = game_options.get("fullscreen").and_then(Value::as_bool) {
            let _ = launcher::apply_fullscreen(&working_dir, fullscreen);
        }
    }

    let requested = payload
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("1.21")
        .to_string();
    let version_id = instance
        .as_ref()
        .and_then(instance_version_id)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(requested);

    // Alte Profile haben eigene Libraries/Versionen; verwaltete Instanzen
    // teilen sich den Spielordner.
    let content_root = match &instance {
        Some(instance) => instance_content_root(&root, &instance.dir, &version_id),
        None => root.clone(),
    };

    let resolved = version::resolve_version(&content_root, &version_id).map_err(|error| {
        format!("Version '{version_id}' ist nicht installiert: {error}. Installiere sie zuerst.")
    })?;

    let java_hint = payload
        .get("javaPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| settings.java_path.clone());
    let runtime = java::find_java_in(&content_root, java_hint.as_deref(), resolved.java_major)
        .await
        .map_err(|error| error.to_string())?;

    let ram = payload
        .get("ram")
        .and_then(Value::as_u64)
        .unwrap_or(settings.memory.max_mb as u64)
        .clamp(512, config::MAX_MEMORY_MB as u64) as u32;
    let memory = MemorySettings::new(settings.memory.min_mb.min(ram), ram);

    let account = match session_manager().load().ok().flatten() {
        Some(session) => session.account(),
        None => {
            let name = payload
                .get("authData")
                .and_then(|auth| auth.get("name"))
                .and_then(Value::as_str)
                .or_else(|| payload.get("profileName").and_then(Value::as_str))
                .unwrap_or("Player");
            Account::offline(name)
        }
    };

    let resolution = payload
        .get("resolution")
        .and_then(|value| {
            let width = value.get("width").and_then(Value::as_u64)?;
            let height = value.get("height").and_then(Value::as_u64)?;
            Some(Resolution {
                width: width as u32,
                height: height as u32,
            })
        })
        .or(settings.resolution);

    let extra_jvm_args = payload
        .get("extraJvmArgs")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let server = payload
        .get("gameOptions")
        .and_then(|options| options.get("joinServer"))
        .and_then(Value::as_str)
        .filter(|host| !host.trim().is_empty())
        .map(|host| {
            let port = payload
                .get("gameOptions")
                .and_then(|options| options.get("joinPort"))
                .and_then(Value::as_u64)
                .unwrap_or(25565) as u16;
            (host.to_string(), port)
        });

    let options = LaunchOptions {
        account,
        memory,
        java: runtime,
        extra_jvm_args,
        extra_game_args: settings.extra_game_args.clone(),
        resolution,
        demo: settings.demo_mode,
        server,
        quick_play_world: None,
    };

    let plan = launcher::build_launch_plan(&content_root, &version_id, &working_dir, &options)
        .map_err(|error| error.to_string())?;
    launcher::spawn_game(&plan, log_path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn kill_game(state: State<'_, LauncherState>, folder_name: String) -> bool {
    let pid = state
        .running
        .lock()
        .ok()
        .and_then(|mut running| running.remove(&folder_name));
    match pid {
        Some(pid) => {
            kill_pid(pid);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_java(force_rescan: Option<bool>) -> Value {
    let _ = force_rescan;
    let runtimes = java::detect_all().await;
    Value::Array(
        runtimes
            .into_iter()
            .map(|runtime| {
                json!({
                    "path": runtime.path.to_string_lossy(),
                    "version": runtime.major,
                    "verStr": runtime.version,
                    "majorVersion": runtime.major,
                    "arch": runtime.arch,
                    "vendor": runtime.vendor,
                    "source": "system",
                })
            })
            .collect(),
    )
}

#[tauri::command]
pub fn list_content_files(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let item_type = data.get("type").and_then(Value::as_str).unwrap_or("mods");
    let dir = content_dir(&instance_dir_or(&root, folder), item_type);
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_file())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|name| name.to_lowercase());
    json!(names)
}

#[tauri::command]
pub fn delete_content_file(data: Value) -> bool {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let item_type = data.get("type").and_then(Value::as_str).unwrap_or("mods");
    let Ok(name) = data
        .get("fileName")
        .and_then(Value::as_str)
        .ok_or_else(|| "fileName fehlt".to_string())
        .and_then(safe_file_name)
    else {
        return false;
    };
    let dir = content_dir(&instance_dir_or(&root, folder), item_type);
    // Die Oberfläche kennt Dateien mit und ohne `.disabled`, und Windows hält
    // frisch geladene Dateien kurz gesperrt (Virenscanner, Suchindex). Deshalb
    // mehrere Namensvarianten und ein paar Wiederholungen statt eines
    // einzelnen Versuchs.
    let bare = name.trim_end_matches(".disabled").to_string();
    for candidate in [name.to_string(), format!("{name}.disabled"), bare.clone(), format!("{bare}.disabled")] {
        let target = dir.join(&candidate);
        if !target.is_file() {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&target) {
            if meta.permissions().readonly() {
                let mut permissions = meta.permissions();
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(&target, permissions);
            }
        }
        for attempt in 0..3 {
            if std::fs::remove_file(&target).is_ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(120 * (attempt + 1)));
        }
    }
    false
}

/// Mehr Hashes pro Anfrage bringt nichts: die Liste ist eine Momentaufnahme
/// des Tabs, und ein Fehlschlag soll nicht den ganzen Tab blockieren.
const IDENTIFY_BATCH: usize = 400;

/// Eine Datei auf der Platte, benannt wie sie in der Oberfläche erscheint.
/// Deaktivierte Dateien heißen `paket.jar.disabled`; ihr Inhalt ist aber das
/// unveränderte Paket, deshalb wird für den Abgleich ohne Endung geprüft.
fn identify_candidate(path: &Path, display_name: &str) -> Option<mods::identify::Candidate> {
    let bytes = std::fs::read(path).ok()?;
    let match_name = display_name
        .strip_suffix(".disabled")
        .unwrap_or(display_name)
        .to_string();
    Some(mods::identify::Candidate {
        file_name: match_name,
        sha1: bamboo_launcher::download::sha1_hex(&bytes),
        fingerprint: mods::identify::curseforge_fingerprint(&bytes),
    })
}

/// Ordnet installierte Dateien ihren Projekten zu, damit der Inhalt-Tab Name,
/// Version, Quelle und Cover zeigt statt "Lokal". Unbekannte Dateien fehlen
/// einfach in der Antwort.
#[tauri::command]
pub async fn identify_content_files(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let instance = instance_dir_or(&root, folder);

    let mut wanted: Vec<(String, String)> = Vec::new();
    for entry in data
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let Some(file_name) = entry.get("fileName").and_then(Value::as_str) else {
            continue;
        };
        if safe_file_name(file_name).is_err() {
            continue;
        }
        let item_type = entry.get("type").and_then(Value::as_str).unwrap_or("mods");
        wanted.push((file_name.to_string(), item_type.to_string()));
    }
    wanted.truncate(IDENTIFY_BATCH);

    // Derselbe Dateiname kann in zwei Ordnern liegen (Mod und Resourcepack
    // mit gleichem Namen); der erste Treffer zählt.
    let mut cache = mods::cache::IdentityCache::load(&instance);
    let mut answer = serde_json::Map::new();
    let mut candidates: Vec<(
        String,
        String,
        mods::identify::Candidate,
        Option<instances::ModMetadata>,
        u64,
        u64,
    )> = Vec::new();

    for (file_name, item_type) in wanted {
        let dir = content_dir(&instance, &item_type);
        // Ein Profil kann die Datei mit oder ohne "deaktiviert"-Endung nennen.
        let mut paths = vec![dir.join(&file_name)];
        match file_name.strip_suffix(".disabled") {
            Some(base) => paths.push(dir.join(base)),
            None => paths.push(dir.join(format!("{file_name}.disabled"))),
        }
        let Some(path) = paths.iter().find(|path| path.is_file()) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        let (size, modified) = file_stamp(&meta);
        let cache_key = format!("{item_type}/{file_name}");
        // Unveränderte Dateien kosten keinen Netzaufruf; der Tab zeigt ihren
        // Namen auch dann, wenn Modrinth oder CurseForge gerade nicht antworten.
        if let Some(identified) = cache.get(&cache_key, size, modified) {
            answer.insert(file_name, identified_json(identified));
            continue;
        }

        // Name und Version stehen meist in der Datei selbst. Ohne diesen
        // Blick hinein bliebe eine unbekannte Mod namenlos.
        let metadata = if item_type.starts_with("mod") {
            instances::read_mod_metadata(path)
        } else {
            None
        };
        let Some(candidate) = identify_candidate(path, &file_name) else {
            continue;
        };
        candidates.push((file_name, cache_key, candidate, metadata, size, modified));
    }

    if !candidates.is_empty() {
        let batch: Vec<mods::identify::Candidate> = candidates
            .iter()
            .map(|(_, _, candidate, _, _, _)| candidate.clone())
            .collect();
        let found = mods::identify::identify(&batch, curseforge_api_key()).await;

        for (display_name, cache_key, candidate, metadata, size, modified) in candidates {
            if let Some(identified) = found.get(&candidate.file_name) {
                cache.insert(cache_key, size, modified, identified.clone());
                answer.insert(display_name, identified_json(identified));
                continue;
            }
            // Kein Treffer bei Modrinth oder CurseForge heißt nicht namenlos:
            // Name und Version stehen in der Jar. Nur eine Datei ohne beides
            // bleibt ohne Quelle, und nur die heißt in der Oberfläche "Lokal".
            let Some(metadata) = metadata else {
                continue;
            };
            let name = metadata.name.or(metadata.id).unwrap_or_default();
            let version = metadata.version.unwrap_or_default();
            if name.is_empty() && version.is_empty() {
                continue;
            }
            // Nicht im Cache: kommt später ein API-Key dazu, wird die Datei
            // beim nächsten Öffnen erneut bei den Quellen gesucht.
            answer.insert(
                display_name,
                json!({
                    "source": "",
                    "projectId": "",
                    "slug": "",
                    "name": name,
                    "iconUrl": "",
                    "versionNumber": version,
                }),
            );
        }
    }

    cache.save(&instance);
    Value::Object(answer)
}

fn file_stamp(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::time::UNIX_EPOCH;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    (meta.len(), modified)
}

fn identified_json(identified: &mods::identify::Identified) -> Value {
    json!({
        "source": identified.source.clone(),
        "projectId": identified.project_id.clone(),
        "slug": identified.slug.clone(),
        "name": identified.name.clone(),
        "iconUrl": identified.icon_url.clone(),
        "versionNumber": identified.version_number.clone(),
    })
}

/// Sammelprüfung für Updates: eine Anfrage für alle Dateien der Instanz statt
/// einer Versionsliste pro Mod. Was Modrinth nicht kennt, fehlt in der Antwort;
/// die Oberfläche fragt diese Reste einzeln nach.
#[tauri::command]
pub async fn check_mod_updates(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let instance_dir = instance_dir_or(&root, folder);
    let instance = manager(&root).load(folder).ok();
    let version_id = instance
        .as_ref()
        .and_then(instance_version_id)
        .or_else(|| {
            data.get("versionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    // Für das Update zählt, was die Instanz laden kann: sonst schlägt Modrinth
    // eine Version für eine andere Minecraft-Version oder einen anderen Loader
    // vor, die das Spiel anschließend nicht startet.
    let content_root = instance_content_root(&root, &instance_dir, &version_id);
    let minecraft_version = version::resolve_version(&content_root, &version_id)
        .ok()
        .map(|resolved| resolved.minecraft_version);
    let loader = mods::detect_instance_loader(&content_root, &version_id);

    let mut files: Vec<(String, String)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item_type in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
        let Ok(entries) = std::fs::read_dir(content_dir(&instance_dir, item_type)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(candidate) = identify_candidate(&path, &name) else {
                continue;
            };
            if candidate.sha1.is_empty() {
                continue;
            }
            // Deaktivierte Dateien heißen `paket.jar.disabled`; die Oberfläche
            // kennt sie mit und ohne Endung, deshalb zählt beides.
            for alias in [name.clone(), candidate.file_name.clone()] {
                if seen.iter().any(|known| known == &alias) {
                    continue;
                }
                seen.push(alias.clone());
                files.push((alias, candidate.sha1.clone()));
            }
        }
    }
    files.truncate(IDENTIFY_BATCH);
    if files.is_empty() {
        return json!({ "resolved": [], "updates": [] });
    }

    let report = mods::updates::check(&files, minecraft_version.as_deref(), loader)
        .await
        .unwrap_or_default();
    json!({
        "resolved": report.resolved,
        "updates": report
            .updates
            .into_iter()
            .map(|entry| json!({
                "file": entry.file,
                "versionNumber": entry.version_number,
                "versionId": entry.version_id,
                "gameVersions": entry.game_versions,
                "loaders": entry.loaders,
                "url": entry.url,
                "fileName": entry.file_name,
            }))
            .collect::<Vec<Value>>(),
    })
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("BambooLauncher/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Download fehlgeschlagen: HTTP {}",
            response.status()
        ));
    }
    Ok(response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec())
}

async fn download_to(url: &str, dest: &Path) -> Result<u64, String> {
    let bytes = fetch_bytes(url).await?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(dest, &bytes).map_err(|error| error.to_string())?;
    Ok(bytes.len() as u64)
}

// ---------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------

/// Einstellungen haben Vorrang vor der Umgebung? Nein: eine gesetzte
/// Umgebungsvariable stammt aus einer bewussten Sitzung und gewinnt.
pub(crate) fn curseforge_api_key() -> Option<String> {
    for name in ["BAMBOO_CURSEFORGE_API_KEY", "CURSEFORGE_API_KEY"] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    // Die Oberfläche schreibt in `ui-settings.json`. Ein dort gesetzter Key
    // gilt vor allen Dateien des Kerns – auch ein leerer Wert, damit
    // „Entfernen“ nicht von einem älteren Key überstimmt wird.
    if let Ok(ui) = LauncherSettings::load(&ui_settings_path()) {
        if let Some(key) = ui.curseforge_api_key {
            let key = key.trim().to_string();
            return if key.is_empty() { None } else { Some(key) };
        }
    }
    load_rust_settings()
        .curseforge_api_key
        .or_else(|| {
            // Der Key der alten Electron-Shell liegt in `settings.json` und
            // gilt weiter, auch wenn der Kern schon eigene Einstellungen hat.
            LauncherSettings::load(&config::default_settings_path())
                .ok()
                .and_then(|settings| settings.curseforge_api_key)
        })
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Fehlerform, die `ui/src/lib/curseforge.ts` in Titel und Text übersetzt.
fn curseforge_failure(error: &mods::ModError) -> Value {
    let (code, status) = match error {
        mods::ModError::MissingApiKey => ("missing-key", None),
        mods::ModError::Unauthorized { status, .. } => ("invalid-key", Some(*status)),
        mods::ModError::RateLimited { .. } => ("rate-limited", None),
        mods::ModError::Http { status, .. } => ("http", Some(*status)),
        mods::ModError::Network { .. } => ("network", None),
        _ => ("http", None),
    };
    let mut payload = json!({"error": error.to_string(), "code": code});
    if let Some(status) = status {
        payload["status"] = json!(status);
    }
    payload
}

fn curseforge_client() -> std::result::Result<mods::CurseForgeClient, Value> {
    mods::CurseForgeClient::new(curseforge_api_key()).map_err(|error| curseforge_failure(&error))
}

#[tauri::command]
pub async fn curseforge_search(payload: Option<Value>) -> Value {
    let payload = payload.unwrap_or_else(|| json!({}));
    let text = payload
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sort = payload
        .get("sortBy")
        .and_then(Value::as_str)
        .unwrap_or("6")
        .to_string();
    let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
    let page_size = payload
        .get("pageSize")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 50);
    // `modFilter` ist die CurseForge-Klassen-ID aus dem Projekttyp-Filter.
    let class_id = payload
        .get("modFilter")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("classId")
                .and_then(Value::as_u64)
                .map(|id| id.to_string())
        })
        .unwrap_or_else(|| "6".to_string());

    let client = match curseforge_client() {
        Ok(client) => client,
        Err(failure) => return failure,
    };
    let mut params = vec![
        ("gameId", "432".to_string()),
        ("classId", class_id),
        ("searchFilter", text),
        ("index", index.to_string()),
        ("pageSize", page_size.to_string()),
        ("sortField", sort),
        ("sortOrder", "desc".to_string()),
    ];
    if let Some(version) = payload.get("gameVersion").and_then(Value::as_str) {
        if !version.trim().is_empty() {
            params.push(("gameVersion", version.to_string()));
        }
    }
    if let Some(loader) = payload.get("modLoaderType").and_then(Value::as_u64) {
        params.push(("modLoaderType", loader.to_string()));
    }

    match client.get_json("/mods/search", &params).await {
        Ok(value) => value,
        Err(error) => curseforge_failure(&error),
    }
}

#[tauri::command]
pub async fn curseforge_project(mod_id: String) -> Value {
    let id = match mod_id.trim().parse::<u64>() {
        Ok(id) => id,
        Err(_) => return json!({"error": "Ungültige CurseForge-Projekt-ID.", "code": "http"}),
    };
    let client = match curseforge_client() {
        Ok(client) => client,
        Err(failure) => return failure,
    };
    match client.get_json(&format!("/mods/{id}"), &[]).await {
        // Die Oberfläche liest das Projekt direkt, nicht das `data`-Envelope.
        Ok(value) => value.get("data").cloned().unwrap_or(value),
        Err(error) => curseforge_failure(&error),
    }
}

#[tauri::command]
pub async fn curseforge_files(
    mod_id: String,
    game_version: Option<String>,
    mod_loader_type: Option<u32>,
) -> Value {
    let id = match mod_id.trim().parse::<u64>() {
        Ok(id) => id,
        Err(_) => return json!({"error": "Ungültige CurseForge-Projekt-ID.", "code": "http"}),
    };
    let client = match curseforge_client() {
        Ok(client) => client,
        Err(failure) => return failure,
    };
    let mut params = vec![("index", "0".to_string()), ("pageSize", "50".to_string())];
    if let Some(version) = game_version.filter(|value| !value.trim().is_empty()) {
        params.push(("gameVersion", version));
    }
    if let Some(loader) = mod_loader_type {
        params.push(("modLoaderType", loader.to_string()));
    }
    match client.get_json(&format!("/mods/{id}/files"), &params).await {
        Ok(value) => value.get("data").cloned().unwrap_or_else(|| json!([])),
        Err(error) => curseforge_failure(&error),
    }
}

/// Löst die CurseForge-Datei-ID in einen Download auf. Der API-Endpunkt für
/// die Datei nennt Name, SHA-1 und die vom Autor erlaubte Download-Adresse.
async fn resolve_curseforge_file(
    project_id: &str,
    file_id: u64,
) -> std::result::Result<(String, Option<String>, Option<u64>), Value> {
    let client = curseforge_client()?;
    let version = mods::ModProvider::version(&client, project_id, &file_id.to_string())
        .await
        .map_err(|error| curseforge_failure(&error))?;
    let file = mods::ModProvider::download(&client, &version)
        .await
        .map_err(|error| curseforge_failure(&error))?;
    Ok((file.url, file.sha1, file.size))
}

#[tauri::command]
pub async fn install_mod(app: AppHandle, data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let item_type = data
        .get("itemType")
        .and_then(Value::as_str)
        .unwrap_or("mods")
        .to_string();
    let mut url = data
        .get("downloadUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut sha1: Option<String> = None;
    let curseforge_file_id = data
        .get("curseforgeFileId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0);
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let Ok(filename) = data
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "filename fehlt".to_string())
        .and_then(safe_file_name)
    else {
        return json!({"success": false, "error": "Ungültiger Dateiname.", "code": "invalid-name"});
    };

    // CurseForge-Mods kommen nur mit der Datei-ID an; die Adresse darf der
    // Autor verweigern, deshalb wird sie über die API aufgelöst und geprüft.
    if let Some(file_id) = curseforge_file_id {
        if project_id.is_empty() {
            return json!({"success": false, "error": "CurseForge-Projekt-ID fehlt.", "code": "invalid-project"});
        }
        match resolve_curseforge_file(&project_id, file_id).await {
            Ok((resolved, hash, _size)) => {
                url = resolved;
                sha1 = hash;
            }
            Err(failure) => {
                let mut failure = failure;
                failure["success"] = json!(false);
                return failure;
            }
        }
    }

    if url.is_empty() {
        return json!({"success": false, "error": "Diese Mod hat keine direkte Download-URL.", "code": "no-url"});
    }

    let dir = content_dir(&instance_dir_or(&root, &folder), &item_type);
    let dest = dir.join(filename);
    let task_id = data
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or(&folder)
        .to_string();
    let _ = app.emit(
        "background-task-progress",
        json!({"id": task_id, "percent": 10, "label": filename}),
    );

    let mut spec = FileSpec::new(&dest, &url);
    if let Some(hash) = sha1 {
        spec = spec.with_sha1(hash);
    }
    match FileDownloader::new().download_all(vec![spec], |_| {}).await {
        Ok(_) => {
            let _ = app.emit(
                "background-task-progress",
                json!({"id": task_id, "percent": 100, "label": filename}),
            );
            json!({"success": true, "path": dest.to_string_lossy()})
        }
        Err(error) => {
            json!({"success": false, "error": error.to_string(), "code": "download-failed"})
        }
    }
}

#[tauri::command]
pub async fn upload_local_mod(data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let item_type = data
        .get("itemType")
        .and_then(Value::as_str)
        .unwrap_or("mods");
    let Some(source) = data.get("filePath").and_then(Value::as_str) else {
        return json!({"success": false, "error": "Keine Datei ausgewählt.", "code": "no-file"});
    };
    let source = PathBuf::from(source);
    let Some(name) = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
    else {
        return json!({"success": false, "error": "Ungültige Datei.", "code": "invalid-file"});
    };
    let dir = content_dir(&instance_dir_or(&root, folder), item_type);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return json!({"success": false, "error": error.to_string(), "code": "io"});
    }
    match std::fs::copy(&source, dir.join(&name)) {
        Ok(_) => json!({"success": true, "fileName": name, "itemType": item_type}),
        Err(error) => json!({"success": false, "error": error.to_string(), "code": "io"}),
    }
}

#[tauri::command]
pub async fn install_modpack(app: AppHandle, data: Value) -> Value {
    let root = load_rust_settings().game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("Modpack")
        .to_string();
    // Die Oberfläche schickt bei einem Versionswechsel `mode: "update"`; ohne
    // diesen Zweig würde ein vorhandener Ordner als Namenskonflikt enden.
    let mode = data
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("install");
    let Some(url) = data.get("mrpackUrl").and_then(Value::as_str) else {
        return json!({"success": false, "error": "Keine Modpack-URL.", "code": "no-url"});
    };

    let backup = if mode == "update" {
        let manager = InstanceManager::new(root.join("instances"));
        let Ok(instance) = manager.load(&folder) else {
            return json!({"success": false, "error": "Instanz nicht gefunden.", "code": "not-found"});
        };
        match BackupManager::new(&instance.dir).create("Vor Pack-Update", DEFAULT_KEEP) {
            Ok(entry) => entry,
            Err(error) => {
                return json!({
                    "success": false,
                    "error": format!("Sicherung fehlgeschlagen: {error}"),
                    "code": "backup-failed"
                })
            }
        }
    } else {
        None
    };

    let cache = config::default_cache_dir().join("modpacks");
    let _ = std::fs::create_dir_all(&cache);
    let archive = cache.join(format!("{}.mrpack", token_store::now_ms()));
    let _ = app.emit(
        "modpack-install-progress",
        json!({"folderName": folder, "percent": 5, "label": "Modpack wird geladen"}),
    );
    if let Err(error) = download_to(url, &archive).await {
        return json!({"success": false, "error": error, "code": "download-failed"});
    }

    let progress_app = app.clone();
    let progress_folder = folder.clone();
    let importer =
        ModpackImporter::new(config::default_cache_dir()).with_install_progress(move |event| {
            let percent = if event.progress.total == 0 {
                0
            } else {
                (event.progress.completed * 100 / event.progress.total) as u32
            };
            let _ = progress_app.emit(
                "modpack-install-progress",
                json!({
                    "folderName": progress_folder,
                    "percent": percent,
                    "label": event.step.label(),
                }),
            );
        });

    let response = if mode == "update" {
        match importer.update(&root, &archive, &folder).await {
            Ok(report) => json!({
                "success": true,
                "mode": "update",
                "folderName": report.instance.name,
                "packVersion": report.pack_version,
                "mcVersion": report.minecraft_version,
                "loader": report.loader.map(loader_label),
                "loaderVersion": report.loader_version,
                "versionId": report.version_id,
                "added": report.added,
                "updated": report.updated,
                "removed": report.removed,
                "kept": report.kept,
                "downloadedBytes": report.downloaded_bytes,
                "index": { "files": report.index_files },
                "overrideFiles": report.override_files,
                "backup": backup,
            }),
            Err(error) => json!({
                "success": false,
                "error": error.to_string(),
                "code": "update-failed"
            }),
        }
    } else {
        match importer.import(&root, &archive, Some(&folder)).await {
            Ok(report) => json!({
                "success": true,
                "modCount": report.files,
                "mcVersion": report.minecraft_version,
                "loader": report.loader.map(loader_label),
                "loaderVersion": report.loader_version,
                "versionId": report.version_id,
                "folderName": report.instance.name,
                // Index und Overrides mischen die Inhaltsliste der Instanz. Ohne
                // sie sähe ein fertig installiertes Pack leer aus, obwohl alle
                // Dateien (auch FancyMenu-/Drippy-Konfigurationen) auf der Platte
                // liegen.
                "index": { "files": report.index_files },
                "overrideFiles": report.override_files,
                "backup": backup,
            }),
            Err(error) => json!({
                "success": false,
                "error": error.to_string(),
                "code": "import-failed"
            }),
        }
    };
    let _ = std::fs::remove_file(&archive);
    response
}

// ---------------------------------------------------------------------------
// Cosmetics
// ---------------------------------------------------------------------------

/// Katalog und Pakete liegen im öffentlichen Shop-Repo. Der Katalog ist
/// zusätzlich in den Launcher einkompiliert: ein GitHub-Ausfall oder ein
/// fehlendes Netz darf den Shop nicht leer lassen.
const SHOP_BASE: &str = "https://raw.githubusercontent.com/Borisgamer1/Bamboo-Cosmetics/main/";
const SHOP_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/Borisgamer1/Bamboo-Cosmetics/main/catalog.json";
const BUNDLED_SHOP_CATALOG: &str = include_str!("../../BambooCosmetics/catalog.json");

/// Der Electron-Vorgänger hat die Pakete hier abgelegt; der Rust-Kern liest
/// denselben Ordner, damit eine bestehende Bibliothek nicht leer wirkt.
fn cosmetics_dir() -> PathBuf {
    let base = config::default_config_dir();
    let parent = base
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| base.clone());
    let legacy = parent.join("bamboo-launcher").join("cosmetics");
    if legacy.is_dir() {
        legacy
    } else {
        base.join("cosmetics")
    }
}

/// Instanzen, die der Nutzer in den Cosmetic-Einstellungen vom automatischen
/// Verteilen der Pakete ausgenommen hat. Gespeichert sind Ordnernamen, damit
/// die Auswahl ein Umbenennen des Anzeigenamens übersteht.
fn cosmetics_excluded_instances() -> Vec<String> {
    read_json(&ui_settings_path())
        .and_then(|settings| {
            settings
                .get("preferences")?
                .get("cosmetics")?
                .get("excludedInstances")?
                .as_array()
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .collect()
                })
        })
        .unwrap_or_default()
}

/// Hält die Cosmetic-Pakete in allen Instanzen aktuell: neue Pakete landen in
/// jeder nicht ausgeschlossenen Instanz, ausgeschlossene verlieren nur ihre
/// unveränderte Kopie.
fn sync_cosmetics_into_instances(root: &Path) -> instances::CosmeticMirrorReport {
    let Ok(list) = manager(root).list() else {
        return instances::CosmeticMirrorReport::default();
    };
    instances::mirror_cosmetic_packages(&list, &cosmetics_dir(), &cosmetics_excluded_instances())
}

fn shop_absolute(path: &str) -> String {
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!("{SHOP_BASE}{}", path.trim_start_matches("./"))
}

fn shop_items(catalog: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    let Some(entries) = catalog.get("items").and_then(Value::as_array) else {
        return items;
    };
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(file) = entry.get("file").and_then(Value::as_str) else {
            continue;
        };
        let slots: Vec<String> = entry
            .get("slots")
            .and_then(Value::as_array)
            .map(|slots| {
                slots
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|slot| matches!(*slot, "head" | "back" | "cape"))
                    .map(str::to_string)
                    .collect()
            })
            .filter(|slots: &Vec<String>| !slots.is_empty())
            .unwrap_or_else(|| vec!["back".to_string()]);
        items.push(json!({
            "id": id,
            "name": entry.get("name").and_then(Value::as_str).unwrap_or(id),
            "creator": entry.get("creator").and_then(Value::as_str).unwrap_or("Bamboo Launcher"),
            "description": entry.get("description").and_then(Value::as_str).unwrap_or(""),
            "rarity": entry.get("rarity").and_then(Value::as_str).unwrap_or("Common"),
            "slots": slots,
            "file": shop_absolute(file),
            "image": entry.get("image").and_then(Value::as_str).map(shop_absolute),
            "remote": true,
        }));
    }
    items
}

/// Fernkatalog, sonst der einkompilierte. Der Fehler wird nur gemeldet, wenn
/// auch der lokale Katalog fehlt – so bleibt der Shop still benutzbar.
async fn shop_catalog() -> Value {
    let bundled = serde_json::from_str::<Value>(BUNDLED_SHOP_CATALOG)
        .unwrap_or_else(|_| json!({"items": []}));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    match client.get(SHOP_CATALOG_URL).send().await {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(remote)
                if remote
                    .get("items")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty()) =>
            {
                json!({"items": shop_items(&remote), "source": "remote"})
            }
            _ => json!({"items": shop_items(&bundled), "source": "local"}),
        },
        Ok(response) => json!({
            "items": shop_items(&bundled),
            "source": "local",
            "error": format!("GitHub antwortet mit HTTP {}.", response.status().as_u16()),
        }),
        Err(error) => json!({
            "items": shop_items(&bundled),
            "source": "local",
            "error": format!("GitHub nicht erreichbar: {error}"),
        }),
    }
}

/// Zusatzdaten zu Paketen, die aus dem Shop stammen. Die `.cosmiq`-Datei
/// enthält nur die Grafik; Name, Seltenheit und Slots stehen im Katalog. Ohne
/// diese Notiz zeigte die Bibliothek nach einem Neustart „bird-cape“ statt
/// „Bird Cape“.
fn shop_index_path() -> PathBuf {
    cosmetics_dir().join("shop-index.json")
}

fn shop_index() -> serde_json::Map<String, Value> {
    read_json(&shop_index_path())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_shop_index(entries: &serde_json::Map<String, Value>) {
    let _ = std::fs::create_dir_all(cosmetics_dir());
    let _ = write_json(&shop_index_path(), &Value::Object(entries.clone()));
}

fn cosmetic_field(meta: Option<&Value>, key: &str, fallback: &str) -> String {
    meta.and_then(|meta| meta.get(key))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn cosmetics_library() -> Vec<Value> {
    let dir = cosmetics_dir();
    let index = shop_index();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items: Vec<Value> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("cosmiq"))
        })
        .filter_map(|entry| {
            let path = entry.path();
            let file = path.file_name()?.to_string_lossy().to_string();
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_else(|| file.clone());
            let meta = index.get(&file);
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            Some(json!({
                "file": file,
                "name": cosmetic_field(meta, "name", &stem),
                "creator": cosmetic_field(meta, "creator", "Bamboo Launcher"),
                "description": cosmetic_field(meta, "description", ""),
                "rarity": cosmetic_field(meta, "rarity", "Common"),
                "slots": meta
                    .and_then(|meta| meta.get("slots"))
                    .cloned()
                    .unwrap_or_else(|| json!(["back"])),
                "bytes": bytes,
                "valid": true,
            }))
        })
        .collect();
    items.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    items
}

#[tauri::command]
pub fn cosmetics_list() -> Value {
    json!(cosmetics_library())
}

#[tauri::command]
pub async fn cosmetics_shop() -> Value {
    shop_catalog().await
}

#[tauri::command]
pub async fn cosmetics_install(data: Option<Value>) -> Result<Value, String> {
    let data = data.unwrap_or_else(|| json!({}));
    let Some(id) = data.get("id").and_then(Value::as_str) else {
        return Err("Kein Shop-Paket ausgewählt.".to_string());
    };
    let catalog = shop_catalog().await;
    let Some(item) = catalog
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        })
    else {
        return Err(format!("Das Paket '{id}' steht nicht im Shop."));
    };
    let Some(url) = item.get("file").and_then(Value::as_str) else {
        return Err("Das Shop-Paket hat keine Download-Adresse.".to_string());
    };
    let file_name = safe_file_name(
        url.split('/')
            .next_back()
            .ok_or_else(|| "Ungültiger Paketname.".to_string())?,
    )?;
    let dir = cosmetics_dir();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let destination = dir.join(file_name);
    download_to(url, &destination)
        .await
        .map_err(|error| format!("Download fehlgeschlagen: {error}"))?;

    let mut index = shop_index();
    index.insert(
        file_name.to_string(),
        json!({
            "name": cosmetic_field(Some(item), "name", id),
            "creator": cosmetic_field(Some(item), "creator", "Bamboo Launcher"),
            "description": cosmetic_field(Some(item), "description", ""),
            "rarity": cosmetic_field(Some(item), "rarity", "Common"),
            "slots": item.get("slots").cloned().unwrap_or_else(|| json!(["back"])),
        }),
    );
    write_shop_index(&index);
    sync_cosmetics_into_instances(&load_rust_settings().game_root);
    Ok(json!(cosmetics_library()))
}

#[tauri::command]
pub fn cosmetics_remove(data: Option<Value>) -> Value {
    let data = data.unwrap_or_else(|| json!({}));
    let Some(file) = data.get("file").and_then(Value::as_str) else {
        return json!(cosmetics_library());
    };
    let Ok(file) = safe_file_name(file) else {
        return json!(cosmetics_library());
    };
    // Inhalt vor dem Löschen merken: nur Kopien mit genau diesem Inhalt werden
    // aus den Instanzen zurückgenommen.
    let content = std::fs::read(cosmetics_dir().join(file)).ok();
    let _ = std::fs::remove_file(cosmetics_dir().join(file));
    if let Some(content) = content {
        let root = load_rust_settings().game_root;
        if let Ok(list) = manager(&root).list() {
            instances::forget_cosmetic_package(&list, file, &content);
        }
    }
    let mut index = shop_index();
    if index.remove(file).is_some() {
        write_shop_index(&index);
    }
    json!(cosmetics_library())
}

/// Geometrie für die 3D-Vorschau: Manifest und bbmodel aus dem Paket.
#[tauri::command]
pub fn cosmetics_preview(data: Option<Value>) -> Result<Value, String> {
    let data = data.unwrap_or_else(|| json!({}));
    let Some(file) = data.get("file").and_then(Value::as_str) else {
        return Err("Kein Cosmetic ausgewählt.".to_string());
    };
    let file = safe_file_name(file)?;
    let bytes = std::fs::read(cosmetics_dir().join(file))
        .map_err(|error| format!("Cosmetic nicht lesbar: {error}"))?;
    let package = cosmetics::read_package(&bytes)?;
    cosmetics::preview(&package, file)
}

/// Fertig geparste Shop-Vorschauen je Download-Adresse. Ein Klick durch den
/// Shop soll nicht jedes Paket erneut laden (je Paket einige hundert KB).
static SHOP_PREVIEWS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

fn cached_shop_preview(url: &str) -> Option<Value> {
    SHOP_PREVIEWS.lock().ok()?.as_ref()?.get(url).cloned()
}

fn cache_shop_preview(url: &str, preview: &Value) {
    if let Ok(mut cache) = SHOP_PREVIEWS.lock() {
        let cache = cache.get_or_insert_with(HashMap::new);
        // shortcut: bei voller Liste fliegt alles raus, statt LRU zu pflegen.
        if cache.len() >= 8 {
            cache.clear();
        }
        cache.insert(url.to_string(), preview.clone());
    }
}

/// Dasselbe für ein Shop-Paket, das noch nicht installiert ist: lokal lesen,
/// sonst für die Vorschau herunterladen (installiert wird es separat).
#[tauri::command]
pub async fn cosmetics_shop_preview(id: Option<String>) -> Result<Value, String> {
    let Some(id) = id.filter(|id| !id.trim().is_empty()) else {
        return Err("Kein Shop-Paket ausgewählt.".to_string());
    };
    let catalog = shop_catalog().await;
    let item = catalog
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .cloned()
        .ok_or_else(|| format!("Das Paket '{id}' steht nicht im Shop."))?;
    let Some(url) = item.get("file").and_then(Value::as_str) else {
        return Err("Das Shop-Paket hat keine Download-Adresse.".to_string());
    };
    if let Some(preview) = cached_shop_preview(url) {
        return Ok(preview);
    }
    let file = safe_file_name(
        url.split('/')
            .next_back()
            .ok_or_else(|| "Ungültiger Paketname.".to_string())?,
    )?;
    let bytes = match std::fs::read(cosmetics_dir().join(file)) {
        Ok(bytes) => bytes,
        Err(_) => fetch_bytes(url).await?,
    };
    let package = cosmetics::read_package(&bytes)?;
    let preview = cosmetics::preview(&package, &id)?;
    cache_shop_preview(url, &preview);
    Ok(preview)
}

// ---------------------------------------------------------------------------
// Dialogs, window and shell
// ---------------------------------------------------------------------------

fn dialog_filters(options: &Value) -> Vec<(String, Vec<String>)> {
    options
        .get("filters")
        .and_then(Value::as_array)
        .map(|filters| {
            filters
                .iter()
                .filter_map(|filter| {
                    let name = filter.get("name").and_then(Value::as_str)?.to_string();
                    let extensions = filter
                        .get("extensions")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some((name, extensions))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn show_open_dialog(app: AppHandle, options: Option<Value>) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let options = options.unwrap_or_else(|| json!({}));
    let mut builder = app.dialog().file();
    for (name, extensions) in dialog_filters(&options) {
        let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(name, &refs);
    }
    if let Some(default_path) = options.get("defaultPath").and_then(Value::as_str) {
        if !default_path.trim().is_empty() {
            builder = builder.set_directory(default_path);
        }
    }

    let properties = options
        .get("properties")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let multiple = properties.contains(&"multiSelections");

    if properties.contains(&"openDirectory") {
        // Ein Ordner-Dialog ist das Gegenstück zu pick_file; ohne diesen Zweig
        // ließe sich ein Instanzordner gar nicht auswählen.
        let path = builder.blocking_pick_folder();
        json!({
            "canceled": path.is_none(),
            "filePaths": path.map(|path| path.to_string()).into_iter().collect::<Vec<_>>(),
        })
    } else if multiple {
        let files = builder.blocking_pick_files().unwrap_or_default();
        let paths: Vec<String> = files.into_iter().map(|path| path.to_string()).collect();
        json!({"canceled": paths.is_empty(), "filePaths": paths})
    } else {
        match builder.blocking_pick_file() {
            Some(path) => json!({"canceled": false, "filePaths": [path.to_string()]}),
            None => json!({"canceled": true, "filePaths": []}),
        }
    }
}

#[tauri::command]
pub async fn show_save_dialog(app: AppHandle, options: Option<Value>) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let options = options.unwrap_or_else(|| json!({}));
    let mut builder = app.dialog().file();
    for (name, extensions) in dialog_filters(&options) {
        let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(name, &refs);
    }
    if let Some(default_path) = options.get("defaultPath").and_then(Value::as_str) {
        if !default_path.trim().is_empty() {
            builder = builder.set_file_name(default_path);
        }
    }
    match builder.blocking_save_file() {
        Some(path) => json!({"canceled": false, "filePath": path.to_string()}),
        None => json!({"canceled": true}),
    }
}

/// Obergrenze für ein Bild, das als Data-URL in die Oberfläche wandert.
/// Screenshots und Instanzbilder liegen weit darunter; ein versehentlich
/// gewählter Ordner soll den Webview nicht fluten.
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Liest eine Bilddatei als Data-URL. Die Oberfläche zeigt Instanzbilder und
/// Screenshots damit an; ohne diesen Befehl blieb „Bild ändern“ wirkungslos.
#[tauri::command]
pub fn read_image_file(file_path: String) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let path = Path::new(&file_path);
    if !path.is_file() {
        return None;
    }
    let mime = image_mime(path)?;
    if std::fs::metadata(path).ok()?.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn open_external(url: String) -> bool {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return false;
    }
    auth::open_browser(&url).is_ok()
}

#[tauri::command]
pub fn get_icon(name: String) -> Option<String> {
    let _ = name;
    None
}

#[tauri::command]
pub fn minimize_window(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn maximize_window(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn is_maximized_window(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn focus_window(window: WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
pub fn close_window(window: WebviewWindow, state: State<'_, LauncherState>) {
    state.mark_closing();
    let _ = window.close();
}

#[cfg(test)]
mod image_tests {
    use super::*;

    #[test]
    fn reads_images_as_data_urls_and_rejects_other_files() {
        let dir = std::env::temp_dir().join(format!(
            "bamboo-image-{}-{}",
            std::process::id(),
            token_store::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Groß geschriebene Endungen gelten genauso wie kleine.
        let png = dir.join("cover.PNG");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let data_url = read_image_file(png.to_string_lossy().to_string()).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,iVBO"));

        // Keine Bilddatei, kein Bild.
        let text = dir.join("note.txt");
        std::fs::write(&text, b"hallo").unwrap();
        assert!(read_image_file(text.to_string_lossy().to_string()).is_none());
        assert!(read_image_file(dir.join("fehlt.png").to_string_lossy().to_string()).is_none());

        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod content_tests {
    use super::*;

    #[test]
    fn loader_ids_yield_surface_name_and_real_loader_version() {
        assert_eq!(loader_slug(Loader::NeoForge), "Neoforge");
        assert_eq!(
            loader_version_from_id(Loader::Fabric, "fabric-loader-0.16.10-1.20.1"),
            "0.16.10"
        );
        assert_eq!(
            loader_version_from_id(Loader::Quilt, "quilt-loader-0.26.0-1.20.1"),
            "0.26.0"
        );
        assert_eq!(
            loader_version_from_id(Loader::Forge, "1.20.1-forge-47.2.0"),
            "47.2.0"
        );
        assert_eq!(
            loader_version_from_id(Loader::NeoForge, "neoforge-21.1.77"),
            "21.1.77"
        );
        assert_eq!(
            loader_version_from_id(Loader::Fabric, "1.20.1"),
            "",
            "eine unpassende ID darf nicht die Minecraft-Version als Loader-Version ausgeben"
        );
    }

    #[test]
    fn instance_content_reads_the_instance_folder() {
        let dir = std::env::temp_dir().join(format!(
            "bamboo-content-{}-{}",
            std::process::id(),
            token_store::now_ms()
        ));
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/lokal.jar"), b"kein zip").unwrap();

        let instance = instances::Instance {
            name: "Test".to_string(),
            dir: dir.clone(),
            version_id: None,
        };

        // Der Inhalt kommt aus dem Instanzordner, nicht aus der geteilten
        // Spielwurzel – dort liegen nur Versionen, Libraries und Assets.
        let (content, mods, source) = instance_content(&instance);
        assert_eq!(mods, 1, "Mod im Instanzordner wurde nicht gezählt");
        assert!(source.is_none());
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["fileName"], json!("lokal.jar"));

        let profile = instance_profile(&dir, &instance);
        assert_eq!(profile["mods"], json!(1));
        assert_eq!(profile["content"][0]["fileName"], json!("lokal.jar"));

        std::fs::remove_dir_all(dir).unwrap();
    }
}
