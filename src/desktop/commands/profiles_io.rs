//! Profile export and import (`.zip` and `.mrpack`).

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use bamboo_launcher::backup::{BackupManager, DEFAULT_KEEP};
use bamboo_launcher::config;
use bamboo_launcher::instances::validate_instance_name;
use bamboo_launcher::modpack::{curseforge, ModpackImporter};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;

use crate::ipc;

/// Nur ein Pack-Update pro Instanz gleichzeitig: ein zweiter Lauf würde das
/// zwischengelagerte Archiv überschreiben, aus dem der erste noch liest.
static UPDATES_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct UpdateSlot(String);

impl Drop for UpdateSlot {
    fn drop(&mut self) {
        if let Some(slots) = UPDATES_IN_FLIGHT.get() {
            slots.lock().unwrap().remove(&self.0);
        }
    }
}

fn begin_update(folder: &str) -> Option<UpdateSlot> {
    let slots = UPDATES_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
    let mut slots = slots.lock().unwrap();
    slots
        .insert(folder.to_string())
        .then(|| UpdateSlot(folder.to_string()))
}

/// Eindeutiger Name für die Arbeitskopie eines Pack-Archivs. Die PID allein
/// reicht nicht: zwei Updates im selben Prozess würden sich überschreiben.
fn staged_archive(cache: &Path, prefix: &str, source: &Path) -> PathBuf {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("zip");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    cache.join(format!(
        "{prefix}-{}-{stamp}.{extension}",
        std::process::id()
    ))
}

/// Export flags map to the folder they copy.
fn content_folders(options: &Value) -> Vec<(&'static str, &'static str)> {
    [
        ("includeMods", "mods"),
        ("includeResourcepacks", "resourcepacks"),
        ("includeShaderpacks", "shaderpacks"),
        ("includeDatapacks", "datapacks"),
        ("includeWorlds", "saves"),
        ("includeConfig", "config"),
        ("includeScreenshots", "screenshots"),
    ]
    .into_iter()
    .filter(|(flag, _)| options.get(*flag).and_then(Value::as_bool).unwrap_or(false))
    .collect()
}

pub(crate) fn downloads_dir() -> Option<PathBuf> {
    // Windows setzt USERPROFILE, Linux und macOS HOME. Ohne den zweiten
    // Zweig landete der Export dort im Arbeitsverzeichnis.
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    Some(home.join("Downloads"))
}

fn add_folder(
    zip: &mut zip::ZipWriter<std::fs::File>,
    source: &Path,
    prefix: &str,
    options: SimpleFileOptions,
) -> Result<u64, String> {
    let mut written = 0;
    let Ok(entries) = std::fs::read_dir(source) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            written += add_folder(zip, &path, &format!("{prefix}/{name}"), options)?;
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        zip.start_file(format!("{prefix}/{name}"), options)
            .map_err(|error| error.to_string())?;
        zip.write_all(&bytes).map_err(|error| error.to_string())?;
        written += 1;
    }
    Ok(written)
}

#[tauri::command]
pub fn export_profile(data: Value) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let Ok(source) = ipc::manager(&root).instance_dir(folder) else {
        return json!({"success": false, "code": "invalid-name", "error": "Ungültiger Instanzname."});
    };
    if !source.is_dir() {
        return json!({"success": false, "code": "not-found", "error": "Instanz nicht gefunden."});
    }

    let suggested = data
        .get("suggestedFileName")
        .and_then(Value::as_str)
        .unwrap_or("bamboo-profile.zip");
    let destination = data
        .get("savePath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| downloads_dir().map(|dir| dir.join(suggested)))
        .unwrap_or_else(|| PathBuf::from(suggested));
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let Ok(file) = std::fs::File::create(&destination) else {
        return json!({"success": false, "code": "EACCES", "error": "Datei konnte nicht angelegt werden."});
    };
    let mut zip = zip::ZipWriter::new(file);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let is_mrpack = data.get("format").and_then(Value::as_str) == Some("mrpack");
    let options = data.get("options").cloned().unwrap_or_else(|| json!({}));

    let mut write = || -> Result<(), String> {
        if is_mrpack {
            let index = data
                .get("mrpackIndex")
                .cloned()
                .unwrap_or_else(|| json!({}));
            zip.start_file("modrinth.index.json", deflated)
                .map_err(|error| error.to_string())?;
            zip.write_all(index.to_string().as_bytes())
                .map_err(|error| error.to_string())?;
        } else {
            let manifest = data.get("manifest").cloned().unwrap_or_else(|| json!({}));
            zip.start_file("bamboo/manifest.json", deflated)
                .map_err(|error| error.to_string())?;
            zip.write_all(manifest.to_string().as_bytes())
                .map_err(|error| error.to_string())?;
            zip.start_file("bamboo/options.json", deflated)
                .map_err(|error| error.to_string())?;
            zip.write_all(options.to_string().as_bytes())
                .map_err(|error| error.to_string())?;
        }
        for (_, content) in content_folders(&options) {
            let prefix = if is_mrpack {
                format!("overrides/{content}")
            } else {
                content.to_string()
            };
            add_folder(&mut zip, &source.join(content), &prefix, stored)?;
        }
        Ok(())
    };
    let result = write();
    let finish = zip.finish().map_err(|error| error.to_string());
    if let Err(error) = result.and(finish) {
        let _ = std::fs::remove_file(&destination);
        return json!({"success": false, "code": "export-failed", "error": error});
    }

    let size = std::fs::metadata(&destination)
        .map(|meta| meta.len())
        .unwrap_or(0);
    json!({
        "success": true,
        "filePath": destination.to_string_lossy(),
        "fileName": destination.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        "fileSize": size,
    })
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// Counts content by the folder prefix it lives in.
fn count_by_prefix(names: &[String], prefix: &str) -> usize {
    names
        .iter()
        .filter(|name| {
            let stripped = name.trim_start_matches("overrides/");
            stripped.starts_with(&format!("{prefix}/")) && !name.ends_with('/')
        })
        .count()
}

#[tauri::command]
pub fn import_profile_preview(file_path: String) -> Value {
    let Ok(file) = std::fs::File::open(&file_path) else {
        return json!({"error": "Datei konnte nicht geöffnet werden."});
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return json!({"error": "Kein gültiges Archiv."});
    };
    let mut names = Vec::new();
    for index in 0..archive.len() {
        if let Ok(entry) = archive.by_index(index) {
            if let Ok(name) = entry.name() {
                names.push(name.to_string());
            }
        }
    }
    let size = std::fs::metadata(&file_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let has = |wanted: &str| names.iter().any(|name| name.ends_with(wanted));

    let mut preview = json!({
        "fileSize": size,
        "totalFiles": names.len(),
        "modCount": count_by_prefix(&names, "mods"),
        "resourcepackCount": count_by_prefix(&names, "resourcepacks"),
        "shaderCount": count_by_prefix(&names, "shaderpacks"),
        "datapackCount": count_by_prefix(&names, "datapacks"),
        "worldCount": count_by_prefix(&names, "saves"),
        "hasIcon": has("icon.png")
            || has("pack.png")
            || names.iter().any(|name| name == "bamboo/icon.png"),
        "hasBanner": has("banner.png") || names.iter().any(|name| name == "bamboo/banner.png"),
        "hasConfig": count_by_prefix(&names, "config") > 0,
        "hasScreenshots": count_by_prefix(&names, "screenshots") > 0,
        "isModpack": names.iter().any(|name| name == "modrinth.index.json"),
    });

    if preview["isModpack"].as_bool().unwrap_or(false) {
        if let Some(text) = read_entry(&mut archive, "modrinth.index.json") {
            if let Ok(index) = serde_json::from_str::<Value>(&text) {
                let files = index
                    .get("files")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                let dependencies = index
                    .get("dependencies")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let loader = if dependencies.get("fabricLoader").is_some() {
                    "fabric"
                } else if dependencies.get("quiltLoader").is_some() {
                    "quilt"
                } else if dependencies.get("neoforge").is_some() {
                    "neoforge"
                } else if dependencies.get("forge").is_some() {
                    "forge"
                } else {
                    "vanilla"
                };
                preview["format"] = json!("mrpack");
                preview["title"] = index
                    .get("name")
                    .cloned()
                    .unwrap_or_else(|| json!("Modpack"));
                preview["description"] = index.get("summary").cloned().unwrap_or_else(|| json!(""));
                preview["minecraftVersion"] = dependencies
                    .get("minecraft")
                    .cloned()
                    .unwrap_or_else(|| json!("1.21"));
                preview["modloader"] = json!(loader);
                preview["modloaderVersion"] = dependencies
                    .get("fabricLoader")
                    .or_else(|| dependencies.get("quiltLoader"))
                    .or_else(|| dependencies.get("neoforge"))
                    .or_else(|| dependencies.get("forge"))
                    .cloned()
                    .unwrap_or_else(|| json!(""));
                preview["modCount"] = json!(files);
            }
        }
        return preview;
    }

    // CurseForge packs carry manifest.json at the archive root and only IDs for
    // their files; the download addresses come from the CurseForge API.
    if let Some(text) = read_entry(&mut archive, curseforge::MANIFEST_FILE) {
        if let Some(summary) = curseforge::summarize(&text) {
            preview["format"] = json!("curseforge");
            preview["isModpack"] = json!(true);
            preview["title"] = json!(summary.name);
            preview["description"] = json!("");
            preview["author"] = json!(summary.author);
            preview["minecraftVersion"] = json!(summary.minecraft);
            preview["modloader"] = json!(summary.loader);
            preview["modloaderVersion"] = json!(summary.loader_version);
            preview["modCount"] = json!(summary.files);
            return preview;
        }
    }

    if let Some(text) = read_entry(&mut archive, "bamboo/manifest.json") {
        if let Ok(manifest) = serde_json::from_str::<Value>(&text) {
            preview["format"] = json!("zip");
            preview["title"] = manifest
                .get("name")
                .or_else(|| manifest.get("instanceName"))
                .cloned()
                .unwrap_or_else(|| json!("Profil"));
            preview["description"] = manifest
                .get("description")
                .cloned()
                .unwrap_or_else(|| json!(""));
            preview["author"] = manifest.get("author").cloned().unwrap_or_else(|| json!(""));
            preview["minecraftVersion"] = manifest
                .get("minecraftVersion")
                .or_else(|| manifest.get("version"))
                .cloned()
                .unwrap_or_else(|| json!("1.21"));
            preview["modloader"] = manifest
                .get("modloader")
                .or_else(|| manifest.get("loader"))
                .cloned()
                .unwrap_or_else(|| json!("Vanilla"));
            preview["modloaderVersion"] = manifest
                .get("modloaderVersion")
                .or_else(|| manifest.get("loaderVersion"))
                .cloned()
                .unwrap_or_else(|| json!(""));
        }
        return preview;
    }

    preview["format"] = json!("zip");
    preview["title"] = json!(Path::new(&file_path)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Profil".to_string()));
    preview
}

fn wanted_folders(data: &Value) -> Vec<(&'static str, &'static str)> {
    [
        ("installMods", "mods"),
        ("installResourcepacks", "resourcepacks"),
        ("installShaderpacks", "shaderpacks"),
        ("installDatapacks", "datapacks"),
        ("installWorlds", "saves"),
        ("installConfig", "config"),
        ("installScreenshots", "screenshots"),
    ]
    .into_iter()
    .filter(|(flag, _)| data.get(*flag).and_then(Value::as_bool).unwrap_or(false))
    .collect()
}

#[tauri::command]
pub async fn import_profile(data: Value) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let Some(file_path) = data.get("filePath").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Keine Datei angegeben."});
    };
    let target = data
        .get("targetInstanceName")
        .and_then(Value::as_str)
        .unwrap_or("Import")
        .trim();
    if let Err(error) = validate_instance_name(target) {
        return json!({"success": false, "code": "invalid-name", "error": error.to_string()});
    }
    let manager = ipc::manager(&root);
    if manager
        .instance_dir(target)
        .map(|dir| dir.exists())
        .unwrap_or(false)
    {
        return json!({"success": false, "code": "exists", "error": format!("'{target}' existiert bereits.")});
    }

    let preview = import_profile_preview(file_path.to_string());
    if preview.get("error").is_some() {
        return json!({"success": false, "code": "INVALID", "error": preview["error"]});
    }

    // A Modrinth pack already has a full installer; do not reimplement it.
    if preview["isModpack"].as_bool().unwrap_or(false) {
        let cache = config::default_cache_dir().join("modpacks");
        let _ = std::fs::create_dir_all(&cache);
        // Keep the original extension: the ledger names the archive the pack
        // came from, and a CurseForge pack is a .zip.
        let archive = staged_archive(&cache, "import", Path::new(file_path));
        if std::fs::copy(file_path, &archive).is_err() {
            return json!({"success": false, "code": "ENOENT", "error": "Datei konnte nicht gelesen werden."});
        }
        let result = ModpackImporter::new(config::default_cache_dir())
            .with_curseforge_key(ipc::curseforge_api_key())
            .import(&root, &archive, Some(target))
            .await;
        let _ = std::fs::remove_file(&archive);
        return match result {
            Ok(report) => json!({
                "success": true,
                "instanceName": report.instance.name,
                "modsInstalled": report.files,
                "profile": ipc::instance_profile(&root, &report.instance),
            }),
            Err(error) => {
                json!({"success": false, "code": "import-failed", "error": error.to_string()})
            }
        };
    }

    let Ok(file) = std::fs::File::open(file_path) else {
        return json!({"success": false, "code": "ENOENT", "error": "Datei konnte nicht geöffnet werden."});
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return json!({"success": false, "code": "INVALID", "error": "Kein gültiges Archiv."});
    };

    let version = preview["minecraftVersion"]
        .as_str()
        .unwrap_or("1.21")
        .to_string();
    let Ok(instance) = manager.create(target, Some(&version)) else {
        return json!({"success": false, "code": "create-failed", "error": "Instanz konnte nicht angelegt werden."});
    };

    let folders = wanted_folders(&data);
    let mut counts: Vec<(&'static str, usize)> = folders.iter().map(|(_, dir)| (*dir, 0)).collect();
    for index in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(index) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let Ok(entry_name) = entry.name() else {
            continue;
        };
        let raw = entry_name.trim_start_matches("overrides/").to_string();
        // Zip-Slip: a crafted name must not escape the instance folder.
        if raw.split(['/', '\\']).any(|part| part == "..") {
            continue;
        }
        let Some((folder, rest)) = raw.split_once('/') else {
            continue;
        };
        let Some(slot) = counts.iter_mut().find(|(name, _)| *name == folder) else {
            continue;
        };
        let destination = instance.dir.join(folder).join(rest);
        if let Some(parent) = destination.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(mut out) = std::fs::File::create(&destination) else {
            continue;
        };
        if std::io::copy(&mut entry, &mut out).is_ok() {
            slot.1 += 1;
        }
    }

    let count = |name: &str| {
        counts
            .iter()
            .find(|(dir, _)| *dir == name)
            .map(|(_, value)| *value)
            .unwrap_or(0)
    };
    json!({
        "success": true,
        "instanceName": instance.name,
        "profile": ipc::instance_profile(&root, &instance),
        "modsInstalled": count("mods"),
        "resourcepacksInstalled": count("resourcepacks"),
        "shaderpacksInstalled": count("shaderpacks"),
        "datapacksInstalled": count("datapacks"),
        "worldsImported": count("saves"),
    })
}

/// Aktualisiert eine importierte Pack-Instanz aus einer neuen Pack-Datei.
/// Geladen werden nur geänderte Mods – der Rest bleibt liegen.
#[tauri::command]
pub async fn update_modpack(data: Value) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let Some(file_path) = data.get("filePath").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Keine Datei angegeben."});
    };
    let folder = data
        .get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if let Err(error) = validate_instance_name(&folder) {
        return json!({"success": false, "code": "invalid-name", "error": error.to_string()});
    }
    let manager = ipc::manager(&root);
    let Ok(instance) = manager.load(&folder) else {
        return json!({"success": false, "code": "not-found", "error": "Instanz nicht gefunden."});
    };
    // Ein zweites Update für dieselbe Instanz würde das Archiv des ersten
    // überschreiben, während daraus noch Overrides entpackt werden.
    let Some(_slot) = begin_update(&folder) else {
        return json!({
            "success": false,
            "code": "update-running",
            "error": "Für diese Instanz läuft bereits ein Pack-Update."
        });
    };
    // Overrides überschreiben Configs; ohne Sicherung gäbe es keinen Weg zurück.
    let backup = match BackupManager::new(&instance.dir).create("Vor Pack-Update", DEFAULT_KEEP) {
        Ok(entry) => entry,
        Err(error) => {
            return json!({
                "success": false,
                "code": "backup-failed",
                "error": format!("Sicherung fehlgeschlagen: {error}")
            })
        }
    };

    // Der Importer erkennt das Format selbst; die Datei bleibt bis zum Ende im
    // Cache, weil daraus auch die Overrides entpackt werden.
    let cache = config::default_cache_dir().join("modpacks");
    let _ = std::fs::create_dir_all(&cache);
    let archive = staged_archive(&cache, "update", Path::new(file_path));
    if std::fs::copy(file_path, &archive).is_err() {
        return json!({"success": false, "code": "ENOENT", "error": "Datei konnte nicht gelesen werden."});
    }
    let result = ModpackImporter::new(config::default_cache_dir())
        .with_curseforge_key(ipc::curseforge_api_key())
        .update(&root, &archive, &folder)
        .await;
    let _ = std::fs::remove_file(&archive);

    match result {
        Ok(report) => {
            // Gezielt die neue Inhaltsliste zurückgeben; ein volles Profil würde
            // nur noch einmal alle JARs scannen und die UI-Form mitprüfen.
            let (content, mods, source) = ipc::instance_content(&report.instance);
            json!({
                "success": true,
                "folderName": report.instance.name,
                "version": report.pack_version,
                "mcVersion": report.minecraft_version,
                "loader": report.loader.map(|loader| loader.label()),
                "loaderVersion": report.loader_version,
                "added": report.added,
                "updated": report.updated,
                "removed": report.removed,
                "kept": report.kept,
                "downloadedBytes": report.downloaded_bytes,
                "content": content,
                "mods": mods,
                "modpackSource": source,
                "backup": backup,
            })
        }
        Err(error) => {
            json!({"success": false, "code": "update-failed", "error": error.to_string()})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn export_folders_follow_the_selected_flags() {
        let folders = content_folders(&json!({
            "includeMods": true,
            "includeConfig": false,
            "includeWorlds": true,
        }));
        assert_eq!(
            folders,
            vec![("includeMods", "mods"), ("includeWorlds", "saves")]
        );
    }

    #[test]
    fn import_folders_follow_the_selected_flags() {
        let folders = wanted_folders(&json!({
            "installMods": true,
            "installConfig": true,
            "installScreenshots": false,
        }));
        assert_eq!(
            folders,
            vec![("installMods", "mods"), ("installConfig", "config")]
        );
    }

    #[test]
    fn previews_curseforge_manifests() {
        let dir = std::env::temp_dir().join(format!(
            "bamboo-cf-preview-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pack.zip");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(
            br#"{"manifestType":"minecraftModpack","manifestVersion":1,"name":"CF Preview","version":"2.0","author":"Autor","minecraft":{"version":"1.20.1","modLoaders":[{"id":"forge-47.2.0","primary":true}]},"files":[{"projectID":1,"fileID":2},{"projectID":3,"fileID":4}]}"#,
        )
        .unwrap();
        zip.start_file("pack.png", options).unwrap();
        zip.write_all(b"png").unwrap();
        zip.finish().unwrap();

        let preview = import_profile_preview(path.to_string_lossy().to_string());
        assert_eq!(preview["format"], json!("curseforge"));
        assert_eq!(preview["isModpack"], json!(true));
        assert_eq!(preview["title"], json!("CF Preview"));
        assert_eq!(preview["author"], json!("Autor"));
        assert_eq!(preview["minecraftVersion"], json!("1.20.1"));
        assert_eq!(preview["modloader"], json!("forge"));
        assert_eq!(preview["modloaderVersion"], json!("47.2.0"));
        assert_eq!(preview["modCount"], json!(2));
        assert_eq!(preview["hasIcon"], json!(true));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_ignore_directories_and_strip_overrides() {
        let names = vec![
            "mods/a.jar".to_string(),
            "mods/".to_string(),
            "overrides/mods/b.jar".to_string(),
            "config/x.toml".to_string(),
        ];
        assert_eq!(count_by_prefix(&names, "mods"), 2);
        assert_eq!(count_by_prefix(&names, "config"), 1);
        assert_eq!(count_by_prefix(&names, "saves"), 0);
    }
}
