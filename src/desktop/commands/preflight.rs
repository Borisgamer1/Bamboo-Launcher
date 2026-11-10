//! Startprüfung für eine Instanz: Mods lesen, Befunde melden, auf Wunsch
//! einzelne Dateien deaktivieren. Der eigentliche Start bleibt in `ipc.rs`.

use crate::ipc;
use bamboo_launcher::{mods, preflight, version};
use serde_json::{json, Value};
use std::path::{Component, Path};

#[tauri::command]
pub async fn preflight_check(folder_name: String) -> Value {
    // Hunderte JARs zu lesen darf das Fenster nicht blockieren; der Befehl
    // läuft deshalb abseits des Main-Threads.
    tauri::async_runtime::spawn_blocking(move || check_instance(&folder_name))
        .await
        .unwrap_or_else(|error| {
            json!({
                "success": false,
                "error": error.to_string(),
                "checkedMods": 0,
                "issues": [],
            })
        })
}

fn check_instance(folder_name: &str) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let folder_name = folder_name.to_string();
    let instance = match ipc::manager(&root).load(&folder_name) {
        Ok(instance) => instance,
        Err(error) => {
            return json!({
                "success": false,
                "error": error.to_string(),
                "checkedMods": 0,
                "issues": [],
            })
        }
    };

    // Ohne installierte Version gibt es keinen Loader und keine Minecraft-
    // Version zu prüfen. Das ist kein Fehler der Mods, sondern Sache des
    // Starts, der die fehlende Version selbst meldet.
    let Some(version_id) = ipc::instance_version_id(&instance) else {
        return json!({"success": true, "checkedMods": 0, "issues": [], "skipped": "version-unknown"});
    };
    let content_root = ipc::instance_content_root(&root, &instance.dir, &version_id);
    let Ok(resolved) = version::resolve_version(&content_root, &version_id) else {
        return json!({"success": true, "checkedMods": 0, "issues": [], "skipped": "version-not-installed"});
    };

    let loader = mods::detect_instance_loader(&content_root, &version_id);
    let report = preflight::check(
        &instance.dir.join("mods"),
        loader,
        &resolved.minecraft_version,
    );
    json!({
        "success": true,
        "checkedMods": report.checked_mods,
        "issues": report.issues,
    })
}

/// Benennt die angegebenen Dateien im `mods`-Ordner in `*.disabled` um. Der
/// Loader ignoriert sie danach, die Datei bleibt aber zum Zurückholen liegen.
#[tauri::command]
pub fn preflight_disable(folder_name: String, files: Vec<String>) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let mods_dir = match ipc::manager(&root).instance_dir(&folder_name) {
        Ok(dir) => dir.join("mods"),
        Err(error) => {
            return json!({"success": false, "error": error.to_string(), "disabled": [], "failed": []})
        }
    };

    let mut disabled = Vec::new();
    let mut failed = Vec::new();
    for file in files {
        let name = file.trim();
        let path = Path::new(name);
        let plain_name = matches!(path.components().next(), Some(Component::Normal(_)))
            && path.components().count() == 1;
        if !plain_name || name.ends_with(".disabled") {
            failed.push(name.to_string());
            continue;
        }
        let target = mods_dir.join(name);
        if !target.is_file() {
            failed.push(name.to_string());
            continue;
        }
        let disabled_name = format!("{name}.disabled");
        match std::fs::rename(&target, mods_dir.join(&disabled_name)) {
            Ok(()) => disabled.push(disabled_name),
            Err(_) => failed.push(name.to_string()),
        }
    }

    json!({
        "success": !disabled.is_empty(),
        "disabled": disabled,
        "failed": failed,
    })
}
