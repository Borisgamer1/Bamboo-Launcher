//! Instance actions: clone, repair, desktop shortcut, worlds.

use std::io::Write;
use std::path::{Path, PathBuf};

use bamboo_launcher::config;
use bamboo_launcher::install::{InstallOptions, Installer};
use bamboo_launcher::instances::{validate_instance_name, InstanceManager};
use bamboo_launcher::loader::LoaderInstaller;
use bamboo_launcher::mods::Loader;
use bamboo_launcher::safe_fs;
use serde_json::{json, Value};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::ipc::{self, LauncherState};

/// Arbeitsordner beim Löschen einer Welt: erst beiseitelegen, dann löschen.
const WORLD_TRASH: &str = ".bamboo-world-trash";

/// Copies an instance folder, skipping build artefacts nobody wants doubled.
fn copy_instance_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let file_type = entry.file_type()?;
        let destination = target.join(&name);
        if file_type.is_dir() {
            if name == "logs" {
                continue;
            }
            copy_instance_tree(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

/// Wie viele Namen für einen Klon höchstens geprüft werden.
const MAX_CLONE_ATTEMPTS: usize = 1_000;

/// Erster freier Name für einen Klon.
///
/// Jeder Kandidat wird geprüft; ein angehängter Zähler verlängert den Namen,
/// deshalb endet die Suche spätestens an der Längengrenze statt wie früher
/// endlos weiterzulaufen.
fn clone_target_name(manager: &InstanceManager, base: &str) -> std::result::Result<String, String> {
    validate_instance_name(base)
        .map_err(|error| format!("'{base}' lässt sich nicht klonen: {error}"))?;
    for suffix in 1..=MAX_CLONE_ATTEMPTS {
        let name = match suffix {
            1 => base.to_string(),
            _ => format!("{base} {suffix}"),
        };
        if validate_instance_name(&name).is_err() {
            break;
        }
        match manager.instance_dir(&name) {
            Ok(dir) if !dir.exists() => return Ok(name),
            Ok(_) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!("Für '{base}' ist kein freier Klon-Name verfügbar."))
}

#[tauri::command]
pub fn clone_instance(data: Value) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let manager = ipc::manager(&root);
    let Ok(source) = manager.instance_dir(folder) else {
        return json!({"success": false, "code": "invalid-name", "error": "Ungültiger Instanzname."});
    };
    if !source.is_dir() {
        return json!({"success": false, "code": "not-found", "error": "Instanz nicht gefunden."});
    }

    let base = data
        .get("newName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{folder}-Kopie"));
    let name = match clone_target_name(&manager, &base) {
        Ok(name) => name,
        Err(error) => return json!({"success": false, "code": "invalid-name", "error": error}),
    };
    let Ok(target) = manager.instance_dir(&name) else {
        return json!({"success": false, "code": "invalid-name", "error": "Ungültiger Instanzname."});
    };
    if target.exists() {
        return json!({
            "success": false,
            "code": "exists",
            "error": format!("'{name}' existiert bereits.")
        });
    }
    if let Err(error) = copy_instance_tree(&source, &target) {
        let _ = std::fs::remove_dir_all(&target);
        return json!({"success": false, "code": "copy-failed", "error": error.to_string()});
    }
    let mut meta = ipc::read_json(&target.join("instance.json")).unwrap_or_else(|| json!({}));
    meta["name"] = json!(name);
    let _ = ipc::write_json(&target.join("instance.json"), &meta);

    match manager.load(&name) {
        Ok(instance) => json!({
            "success": true,
            "profile": ipc::instance_profile(&root, &instance),
        }),
        Err(error) => json!({"success": false, "code": "copy-failed", "error": error.to_string()}),
    }
}

/// Reinstalls the loader profile, then repairs libraries and assets.
///
/// The loader comes first because a broken loader profile is what "repair"
/// usually means; a missing version profile is installed instead of reported.
#[tauri::command]
pub async fn repair_instance(data: Value) -> Value {
    let settings = ipc::load_rust_settings();
    let root = settings.game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let minecraft = data
        .get("mcVersion")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if minecraft.is_empty() {
        return json!({"success": false, "code": "invalid", "error": "Keine Minecraft-Version angegeben."});
    }

    let instance = (!folder.is_empty())
        .then(|| ipc::manager(&root).load(folder).ok())
        .flatten();
    let version_id = instance.as_ref().and_then(ipc::instance_version_id);
    let content_root = match &instance {
        Some(instance) => ipc::instance_content_root(
            &root,
            &instance.dir,
            version_id.as_deref().unwrap_or_default(),
        ),
        None => root.clone(),
    };

    if let Some(loader) = data
        .get("loader")
        .and_then(Value::as_str)
        .and_then(Loader::parse)
    {
        let pinned = data
            .get("loaderVersion")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let installer = LoaderInstaller::new(config::default_cache_dir());
        if let Err(error) = installer.install(&root, minecraft, loader, pinned).await {
            return json!({
                "success": false,
                "code": "loader-unsupported",
                "error": error.to_string(),
            });
        }
    }

    let target = version_id.unwrap_or_else(|| minecraft.to_string());
    let installer = Installer::new(config::default_cache_dir());
    let repair = installer
        .repair_version(&content_root, &target, |_| {})
        .await;
    let repair_error = match repair {
        Ok(_) => return json!({"success": true}),
        Err(error) => error,
    };

    let options = InstallOptions {
        assets: true,
        java: true,
        refresh_manifest: false,
    };
    match installer
        .install_version(&content_root, &target, &options, |_| {})
        .await
    {
        Ok(_) => json!({"success": true}),
        Err(error) => json!({
            "success": false,
            "code": "repair-failed",
            "error": format!("{repair_error} / {error}"),
        }),
    }
}

/// Desktop folder, following the OneDrive redirect when the profile uses one.
#[cfg(windows)]
fn desktop_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let candidates = [home.join("Desktop"), home.join("OneDrive").join("Desktop")];
    candidates.into_iter().find(|path| path.is_dir())
}

#[tauri::command]
pub fn create_desktop_shortcut(data: Value) -> Value {
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = data
        .get("instanceName")
        .and_then(Value::as_str)
        .unwrap_or(folder)
        .trim();
    if folder.is_empty() || name.is_empty() {
        return json!({"success": false, "code": "invalid", "error": "Instanz fehlt."});
    }

    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else {
            return json!({"success": false, "code": "no-exe", "error": "Programmpfad nicht gefunden."});
        };
        let Some(desktop) = desktop_dir() else {
            return json!({"success": false, "code": "no-desktop", "error": "Desktop-Ordner nicht gefunden."});
        };
        let file_name: String = name
            .chars()
            .map(|ch| {
                if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        let link = desktop.join(format!("{}.lnk", file_name.trim()));
        // PowerShell quotes single quotes by doubling them.
        let quote = |value: &str| value.replace('\'', "''");
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='--launch \"{}\"';$s.WorkingDirectory='{}';$s.Save()",
            quote(&link.to_string_lossy()),
            quote(&exe.to_string_lossy()),
            quote(folder),
            quote(&exe.parent().map(|dir| dir.to_string_lossy().to_string()).unwrap_or_default()),
        );
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x0800_0000)
            .status();
        return match result {
            Ok(status) if status.success() && link.is_file() => {
                json!({"success": true, "path": link.to_string_lossy()})
            }
            Ok(_) => {
                json!({"success": false, "code": "shortcut-failed", "error": "Verknüpfung wurde nicht angelegt."})
            }
            Err(error) => {
                json!({"success": false, "code": "shortcut-failed", "error": error.to_string()})
            }
        };
    }
    #[cfg(not(windows))]
    {
        json!({"success": false, "code": "unsupported", "error": "Nur unter Windows verfügbar."})
    }
}

/// Playtime of a world from the vanilla statistics files, in milliseconds.
fn world_playtime(world: &Path) -> (Option<u64>, usize) {
    let Ok(entries) = std::fs::read_dir(world.join("stats")) else {
        return (None, 0);
    };
    let mut ticks: u64 = 0;
    let mut players = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(stats) = ipc::read_json(&path) else {
            continue;
        };
        // 1 tick = 50 ms; nur zählen, wenn die Datei die Spielzeit nennt.
        if let Some(value) = bamboo_launcher::instances::custom_stats(&stats)
            .and_then(|custom| custom.get("minecraft:play_time"))
            .and_then(Value::as_u64)
        {
            ticks = ticks.saturating_add(value);
            players += 1;
        }
    }
    if players == 0 {
        (None, 0)
    } else {
        (Some(ticks.saturating_mul(50)), players)
    }
}

#[tauri::command]
pub fn list_instance_worlds(folder_name: String) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let Ok(dir) = ipc::manager(&root).instance_dir(&folder_name) else {
        return json!([]);
    };
    let saves = dir.join("saves");
    let Ok(entries) = std::fs::read_dir(&saves) else {
        return json!([]);
    };

    let mut worlds = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let level = path.join("level.dat");
        if !level.is_file() {
            continue;
        }
        let playtime = world_playtime(&path);
        let last_played = std::fs::metadata(&level)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64);
        let icon = ipc::read_image_file(path.join("icon.png").to_string_lossy().to_string());
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        worlds.push(json!({
            "folderName": name,
            "name": name,
            "gamemode": null,
            "hardcore": false,
            "version": null,
            "lastPlayed": last_played,
            "playtimeMs": playtime.0,
            "playtimeSource": if playtime.0.is_some() { "stats" } else { "none" },
            "playtimeApproximate": false,
            "playerCount": playtime.1,
            "iconDataUrl": icon,
        }));
    }
    worlds.sort_by(|left, right| {
        right["lastPlayed"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&left["lastPlayed"].as_u64().unwrap_or(0))
    });
    Value::Array(worlds)
}

fn human_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.2} GB", value / GB)
    } else if value >= MB {
        format!("{:.1} MB", value / MB)
    } else {
        format!("{} KB", (bytes / 1024).max(1))
    }
}

/// Belegte Größe einer Instanz auf der Platte. Wird erst beim Öffnen der
/// Statistiken berechnet: Beim Start würde das Durchlaufen aller Welten den
/// Launcher nur ausbremsen.
#[tauri::command]
pub fn instance_disk_usage(folder_name: String) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let Ok(dir) = ipc::manager(&root).instance_dir(&folder_name) else {
        return json!({"success": false, "error": "Instanz nicht gefunden."});
    };
    if !dir.is_dir() {
        return json!({"success": false, "error": "Instanz nicht gefunden."});
    }
    let bytes = bamboo_launcher::instances::folder_size(&dir);
    let label = human_bytes(bytes);
    // Der Wert bleibt in der Instanzdatei, damit die Liste ihn beim nächsten
    // Start ohne erneuten Durchlauf zeigen kann.
    let meta_path = dir.join("instance.json");
    if let Some(mut meta) = ipc::read_json(&meta_path) {
        meta["size_label"] = json!(label);
        let _ = ipc::write_json(&meta_path, &meta);
    }
    json!({"success": true, "bytes": bytes, "label": label})
}

// ---------------------------------------------------------------------------
// Welt-Aktionen
// ---------------------------------------------------------------------------

/// Nur ein einzelner Ordnername – nie ein Pfad.
fn safe_world_name(name: &str) -> Option<&str> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return None;
    }
    Some(name)
}

fn safe_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "world".to_string()
    } else {
        trimmed.to_string()
    }
}

fn world_dir(folder: &str, world: &str) -> Result<(PathBuf, String), Value> {
    let root = ipc::load_rust_settings().game_root;
    let Ok(instance) = ipc::manager(&root).load(folder) else {
        return Err(json!({
            "success": false,
            "code": "not-found",
            "error": "Instanz nicht gefunden."
        }));
    };
    let Some(world) = safe_world_name(world) else {
        return Err(json!({
            "success": false,
            "code": "invalid-name",
            "error": "Ungültiger Weltname."
        }));
    };
    let dir = instance.dir.join("saves").join(world);
    if !dir.is_dir() {
        return Err(json!({
            "success": false,
            "code": "not-found",
            "error": "Welt nicht gefunden."
        }));
    }
    Ok((dir, world.to_string()))
}

#[tauri::command]
pub fn open_instance_world(folder_name: String, world_name: String) -> Value {
    let (dir, _) = match world_dir(&folder_name, &world_name) {
        Ok(found) => found,
        Err(error) => return error,
    };
    match ipc::open_path(&dir) {
        Ok(()) => json!({"success": true, "path": dir.to_string_lossy()}),
        Err(error) => json!({"success": false, "code": "open-failed", "error": error}),
    }
}

fn add_world_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    source: &Path,
    prefix: &str,
    options: SimpleFileOptions,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    let entries = std::fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            add_world_to_zip(
                zip,
                &path,
                &format!("{prefix}/{name}"),
                options,
                files,
                bytes,
            )?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let data = std::fs::read(&path).map_err(|error| error.to_string())?;
        zip.start_file(format!("{prefix}/{name}"), options)
            .map_err(|error| error.to_string())?;
        zip.write_all(&data).map_err(|error| error.to_string())?;
        *files += 1;
        *bytes = bytes.saturating_add(data.len() as u64);
    }
    Ok(())
}

#[tauri::command]
pub fn export_instance_world(data: Value) -> Value {
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    let world = data.get("worldName").and_then(Value::as_str).unwrap_or("");
    let (dir, world) = match world_dir(folder, world) {
        Ok(found) => found,
        Err(error) => return error,
    };

    let stem = safe_file_stem(&world);
    let suggested = format!("{stem}.zip");
    let destination = data
        .get("savePath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| crate::commands::profiles_io::downloads_dir().map(|dir| dir.join(&suggested)))
        .unwrap_or_else(|| PathBuf::from(&suggested));
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let Ok(file) = std::fs::File::create(&destination) else {
        return json!({"success": false, "code": "EACCES", "error": "Zieldatei konnte nicht angelegt werden."});
    };
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut files = 0;
    let mut bytes = 0;
    if let Err(error) = add_world_to_zip(&mut zip, &dir, &stem, options, &mut files, &mut bytes) {
        let _ = std::fs::remove_file(&destination);
        return json!({"success": false, "code": "export-failed", "error": error});
    }
    if let Err(error) = zip.finish() {
        let _ = std::fs::remove_file(&destination);
        return json!({"success": false, "code": "export-failed", "error": error.to_string()});
    }

    json!({
        "success": true,
        "path": destination.to_string_lossy(),
        "worldName": world,
        "files": files,
        "bytes": bytes,
    })
}

/// Findet die Weltwurzel im Archiv: `level.dat` direkt oder eine Ebene tiefer.
fn world_prefix(archive: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    let mut fallback: Option<String> = None;
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        let Ok(name) = entry.name() else {
            continue;
        };
        let normalized = name.replace('\\', "/");
        let relative = normalized.trim_start_matches("./");
        if relative == "level.dat" {
            return Some(String::new());
        }
        if let Some(parent) = relative.strip_suffix("/level.dat") {
            if !parent.is_empty() && !parent.contains('/') {
                fallback = Some(parent.to_string());
            }
        }
    }
    fallback
}

const MAX_WORLD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[tauri::command]
pub fn import_instance_world(data: Value, state: State<'_, LauncherState>) -> Value {
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    if state.is_instance_running(folder) {
        return json!({
            "success": false,
            "code": "running",
            "error": "Die Instanz läuft. Beende das Spiel, bevor du eine Welt importierst."
        });
    }
    let Some(file_path) = data.get("filePath").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Keine Datei angegeben."});
    };
    let root = ipc::load_rust_settings().game_root;
    let Ok(instance) = ipc::manager(&root).load(folder) else {
        return json!({"success": false, "code": "not-found", "error": "Instanz nicht gefunden."});
    };
    let Ok(file) = std::fs::File::open(file_path) else {
        return json!({"success": false, "code": "ENOENT", "error": "Datei konnte nicht geöffnet werden."});
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return json!({"success": false, "code": "INVALID", "error": "Kein gültiges ZIP-Archiv."});
    };
    let Some(prefix) = world_prefix(&mut archive) else {
        return json!({
            "success": false,
            "code": "not-a-world",
            "error": "Das Archiv enthält keine Minecraft-Welt (level.dat fehlt)."
        });
    };

    let source_name = prefix
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(file_path)
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Import".to_string());
    let base = safe_file_stem(&source_name);
    let saves = instance.dir.join("saves");
    let mut world_name = base.clone();
    let mut suffix = 2;
    while saves.join(&world_name).exists() {
        world_name = format!("{base} ({suffix})");
        suffix += 1;
    }
    let destination = saves.join(&world_name);
    let prefix_with_slash = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };

    let mut files = 0;
    let mut bytes = 0u64;
    let extraction = (|| -> Result<(), String> {
        std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let raw = entry
                .name()
                .map_err(|error| error.to_string())?
                .replace('\\', "/");
            let raw = raw.trim_start_matches("./");
            let relative = if prefix_with_slash.is_empty() {
                raw
            } else {
                match raw.strip_prefix(&prefix_with_slash) {
                    Some(rest) => rest,
                    None => continue,
                }
            };
            if relative.is_empty() || relative == "session.lock" {
                continue;
            }
            if relative.split('/').any(|part| part == ".." || part == ".") {
                continue;
            }
            let target = destination.join(relative);
            if !target.starts_with(&destination) {
                continue;
            }
            if entry.is_dir() {
                std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
                continue;
            }
            bytes = bytes.saturating_add(entry.size());
            if bytes > MAX_WORLD_BYTES {
                return Err("Die Welt überschreitet die Grenze von 8 GiB.".to_string());
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out = std::fs::File::create(&target).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
            files += 1;
        }
        if !destination.join("level.dat").is_file() {
            return Err("Die Welt enthält keine level.dat.".to_string());
        }
        Ok(())
    })();

    match extraction {
        Ok(()) => json!({
            "success": true,
            "worldName": world_name,
            "files": files,
            "bytes": bytes,
        }),
        Err(error) => {
            let mut message = error;
            if let Some(note) = cleanup_partial_world(&destination) {
                message.push(' ');
                message.push_str(&note);
            }
            json!({"success": false, "code": "import-failed", "error": message})
        }
    }
}

/// Entfernt einen halb entpackten Welt-Ordner. Bleibt er liegen, muss die
/// Meldung den Pfad nennen: sonst stünde eine unbrauchbare Welt in der
/// Weltliste des Spiels, ohne dass jemand erfährt, woher sie kommt.
fn cleanup_partial_world(destination: &Path) -> Option<String> {
    if std::fs::remove_dir_all(destination).is_err() && destination.exists() {
        return Some(format!(
            "Der halb entpackte Ordner {} konnte nicht entfernt werden; bitte lösche ihn von Hand.",
            destination.display()
        ));
    }
    None
}

#[tauri::command]
pub fn delete_instance_world(data: Value, state: State<'_, LauncherState>) -> Value {
    let folder = data.get("folderName").and_then(Value::as_str).unwrap_or("");
    if state.is_instance_running(folder) {
        return json!({
            "success": false,
            "code": "running",
            "error": "Die Instanz läuft. Beende das Spiel, bevor du eine Welt löschst."
        });
    }
    let world = data.get("worldName").and_then(Value::as_str).unwrap_or("");
    let (dir, world) = match world_dir(folder, world) {
        Ok(found) => found,
        Err(error) => return error,
    };
    delete_world_folder(&dir, &world)
}

/// Legt eine Welt erst beiseite und löscht sie dann.
///
/// Ein `rename` macht die Welt sofort und unteilbar verschwunden; bricht das
/// endgültige Löschen ab, steht deshalb keine halb gelöschte Welt mehr in der
/// Liste des Spiels. Ein Link in der Welt wird nur selbst verschoben, nie sein
/// Ziel. Was nicht gelöscht werden konnte, nennt der Hinweis mit Pfad.
fn delete_world_folder(dir: &Path, world: &str) -> Value {
    // Der eigene Arbeitsordner ist keine Welt; er darf nie als solche gelten.
    if world.to_ascii_lowercase().starts_with(".bamboo-") {
        return json!({
            "success": false,
            "code": "invalid-name",
            "error": "Ungültiger Weltname."
        });
    }
    let Some(saves) = dir.parent() else {
        return json!({
            "success": false,
            "code": "delete-failed",
            "error": "Der Weltordner liegt nicht in einem saves-Ordner."
        });
    };

    let mut trash = safe_fs::Trash::under(&saves.join(WORLD_TRASH));
    if let Err(error) = trash.take(dir) {
        // Nichts wurde verschoben: den leeren Papierkorb wieder abräumen, damit
        // die Welt unverändert und ohne Arbeitsordner dasteht.
        let _ = trash.restore();
        return json!({
            "success": false,
            "code": "delete-failed",
            "error": error.to_string()
        });
    }

    match trash.discard() {
        Ok(()) => json!({"success": true, "worldName": world}),
        Err(error) => json!({
            "success": true,
            "worldName": world,
            "warnings": [format!(
                "Die Welt ist aus der Liste verschwunden, die Reste in {} konnten aber nicht gelöscht werden: {error}",
                trash.root().display()
            )]
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(root: &Path) -> InstanceManager {
        InstanceManager::new(root.join("instances"))
    }

    #[test]
    fn clone_uses_the_next_free_name() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        std::fs::create_dir_all(manager.root().join("Kopie")).unwrap();
        std::fs::create_dir_all(manager.root().join("Kopie 2")).unwrap();

        assert_eq!(clone_target_name(&manager, "Kopie").unwrap(), "Kopie 3");
    }

    #[test]
    fn clone_returns_a_free_name_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        assert_eq!(clone_target_name(&manager, "Frei").unwrap(), "Frei");
    }

    #[test]
    fn clone_aborts_instead_of_looping_when_the_counter_makes_the_name_too_long() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        // 64 Zeichen sind erlaubt; „<name> 2“ wäre 66 und damit ungültig.
        let base = "a".repeat(64);
        std::fs::create_dir_all(manager.root().join(&base)).unwrap();

        let error = clone_target_name(&manager, &base).unwrap_err();
        assert!(error.contains("kein freier Klon-Name"), "{error}");
    }

    #[test]
    fn clone_rejects_names_that_are_invalid_from_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());

        assert!(clone_target_name(&manager, &"b".repeat(65)).is_err());
        assert!(clone_target_name(&manager, "a/b").is_err());
        assert!(clone_target_name(&manager, "CON").is_err());
    }

    #[test]
    fn a_partial_world_is_removed_or_named() {
        let dir = tempfile::tempdir().unwrap();
        let world = dir.path().join("Welt (2)");
        std::fs::create_dir_all(&world).unwrap();
        std::fs::write(world.join("level.dat"), "x").unwrap();

        assert_eq!(cleanup_partial_world(&world), None);
        assert!(!world.exists(), "der halb entpackte Ordner muss weg sein");

        // Lässt sich der Ordner nicht entfernen, muss die Meldung den Pfad
        // nennen – sonst stünde eine unbrauchbare Welt unerklärt in der Liste.
        std::fs::write(&world, "kein Ordner").unwrap();
        let note = cleanup_partial_world(&world).expect("Rest muss gemeldet werden");
        assert!(note.contains("Welt (2)"), "{note}");
        assert!(world.is_file());
    }

    #[test]
    fn deleting_a_world_leaves_no_working_folder() {
        let dir = tempfile::tempdir().unwrap();
        let saves = dir.path().join("saves");
        let world = saves.join("Welt");
        std::fs::create_dir_all(world.join("region")).unwrap();
        std::fs::write(world.join("level.dat"), "welt").unwrap();
        std::fs::write(world.join("region/r.0.0.mca"), "region").unwrap();

        let result = delete_world_folder(&world, "Welt");
        assert_eq!(result["success"], json!(true), "{result}");
        assert!(!world.exists(), "die Welt muss weg sein");
        assert!(
            !saves.join(WORLD_TRASH).exists(),
            "kein Arbeitsordner bleibt liegen"
        );
    }

    #[test]
    fn a_locked_world_is_not_half_deleted() {
        #[cfg(not(windows))]
        {
            eprintln!("Ohne Windows keine Sperre; Test übersprungen");
            return;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;

            let dir = tempfile::tempdir().unwrap();
            let saves = dir.path().join("saves");
            let world = saves.join("Welt");
            std::fs::create_dir_all(world.join("region")).unwrap();
            std::fs::write(world.join("level.dat"), "welt").unwrap();
            std::fs::write(world.join("region/r.0.0.mca"), "region").unwrap();
            // Die Region-Datei ist gesperrt; `level.dat` läge beim Löschen
            // alphabetisch davor, ein direktes Löschen ließe also eine halbe
            // Welt stehen.
            let held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x0000_0001)
                .open(world.join("region/r.0.0.mca"))
                .unwrap();

            let result = delete_world_folder(&world, "Welt");
            assert_eq!(result["success"], json!(false), "{result}");
            assert_eq!(
                std::fs::read_to_string(world.join("level.dat")).unwrap(),
                "welt",
                "eine gesperrte Welt bleibt vollständig stehen"
            );
            assert!(
                world.join("region/r.0.0.mca").is_file(),
                "nichts darf schon gelöscht sein"
            );
            assert!(
                !saves.join(WORLD_TRASH).exists(),
                "kein leerer Arbeitsordner bleibt liegen"
            );

            drop(held);
            let _ = std::fs::remove_dir_all(&saves);
        }
    }

    #[test]
    fn the_launcher_working_folder_is_not_a_world() {
        let dir = tempfile::tempdir().unwrap();
        let world = dir.path().join("saves/.bamboo-world-trash/123");
        std::fs::create_dir_all(&world).unwrap();

        let result = delete_world_folder(&world, ".bamboo-world-trash");
        assert_eq!(result["success"], json!(false), "{result}");
        assert!(
            world.exists(),
            "der Arbeitsordner darf nicht gelöscht werden"
        );
    }
}
