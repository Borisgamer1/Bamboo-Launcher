//! Die Launcher-Serverliste in die Instanzen schreiben.

use bamboo_launcher::servers_dat::{self, ServerEntry};
use serde_json::{json, Value};
use tauri::State;

use crate::ipc::{self, LauncherState};

fn entries_from(data: &Value) -> Vec<ServerEntry> {
    let Some(servers) = data.get("servers").and_then(Value::as_array) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|server| {
            let ip = server.get("ip").and_then(Value::as_str)?.trim();
            if ip.is_empty() {
                return None;
            }
            let name = server
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            Some(ServerEntry {
                // Die Grenzen sind die der NBT-Zeichenkette bzw. eine bewusste
                // Obergrenze für Anzeigenamen.
                name: name.chars().take(255).collect(),
                ip: ip.chars().take(255).collect(),
            })
        })
        .take(500)
        .collect()
}

#[tauri::command]
pub fn sync_servers_dat(data: Value, state: State<'_, LauncherState>) -> Value {
    let servers = entries_from(&data);
    if servers.is_empty() {
        return json!({
            "success": false,
            "code": "empty",
            "error": "Es sind keine Server eingetragen."
        });
    }

    let root = ipc::load_rust_settings().game_root;
    let manager = ipc::manager(&root);
    let target = data
        .get("folderName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|folder| !folder.is_empty());

    let instances = match target {
        Some(folder) => match manager.load(folder) {
            Ok(instance) => vec![instance],
            Err(_) => {
                return json!({
                    "success": false,
                    "code": "not-found",
                    "error": "Instanz nicht gefunden."
                })
            }
        },
        None => match manager.list() {
            Ok(instances) => instances,
            Err(error) => {
                return json!({"success": false, "code": "io", "error": error.to_string()})
            }
        },
    };

    let mut written = 0;
    let mut kept = 0;
    let mut skipped = Vec::new();
    let mut details = Vec::new();
    for instance in instances {
        // Eine laufende Instanz schreibt ihre Liste beim Beenden selbst zurück.
        if state.is_instance_running(&instance.name) {
            skipped.push(instance.name.clone());
            continue;
        }
        let path = instance.dir.join(servers_dat::FILE_NAME);
        match servers_dat::sync(&path, &servers) {
            Ok(report) => {
                written += report.written;
                kept += report.kept;
                details.push(json!({
                    "folderName": instance.name,
                    "written": report.written,
                    "kept": report.kept,
                }));
            }
            Err(error) => details.push(json!({
                "folderName": instance.name,
                "error": error.to_string(),
            })),
        }
    }

    let failed = details.iter().any(|detail| detail.get("error").is_some());
    json!({
        "success": !failed,
        "written": written,
        "kept": kept,
        "instances": details,
        "skipped": skipped,
        "error": if failed { Some("Mindestens eine Serverliste konnte nicht geschrieben werden.") } else { None },
    })
}
