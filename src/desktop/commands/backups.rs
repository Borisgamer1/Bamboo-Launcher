//! Sicherungen einer Instanz: anlegen, auflisten, zurückholen, löschen.

use bamboo_launcher::backup::{BackupManager, DEFAULT_KEEP};
use serde_json::{json, Value};
use tauri::State;

use crate::ipc::{self, LauncherState};

fn manager_for(folder: &str) -> Result<BackupManager, Value> {
    let root = ipc::load_rust_settings().game_root;
    match ipc::manager(&root).load(folder) {
        Ok(instance) => Ok(BackupManager::new(instance.dir)),
        Err(_) => Err(json!({
            "success": false,
            "code": "not-found",
            "error": "Instanz nicht gefunden."
        })),
    }
}

fn folder_of(data: &Value) -> &str {
    data.get("folderName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
}

#[tauri::command]
pub fn list_backups(folder_name: String) -> Value {
    let manager = match manager_for(&folder_name) {
        Ok(manager) => manager,
        Err(error) => return error,
    };
    match manager.list() {
        Ok(backups) => json!({
            "success": true,
            "backups": backups,
            "path": manager.backups_dir().to_string_lossy(),
        }),
        Err(error) => json!({"success": false, "code": "io", "error": error.to_string()}),
    }
}

#[tauri::command]
pub fn create_backup(data: Value, state: State<'_, LauncherState>) -> Value {
    let folder = folder_of(&data);
    if state.is_instance_running(folder) {
        return json!({
            "success": false,
            "code": "running",
            "error": "Die Instanz läuft. Beende das Spiel, bevor du sicherst."
        });
    }
    let manager = match manager_for(folder) {
        Ok(manager) => manager,
        Err(error) => return error,
    };
    let reason = data
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("Manuell");

    match manager.create(reason, DEFAULT_KEEP) {
        Ok(Some(entry)) => json!({"success": true, "backup": entry}),
        Ok(None) => json!({
            "success": true,
            "backup": null,
            "empty": true,
            "error": "Es gibt noch keine Welten oder Configs zum Sichern."
        }),
        Err(error) => {
            json!({"success": false, "code": "backup-failed", "error": error.to_string()})
        }
    }
}

#[tauri::command]
pub fn restore_backup(data: Value, state: State<'_, LauncherState>) -> Value {
    let folder = folder_of(&data);
    if state.is_instance_running(folder) {
        return json!({
            "success": false,
            "code": "running",
            "error": "Die Instanz läuft. Beende das Spiel, bevor du eine Sicherung einspielst."
        });
    }
    let manager = match manager_for(folder) {
        Ok(manager) => manager,
        Err(error) => return error,
    };
    let Some(id) = data.get("backupId").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Keine Sicherung angegeben."});
    };

    match manager.restore(id) {
        Ok(report) => json!({
            "success": true,
            "files": report.files,
            "bytes": report.bytes,
        }),
        Err(error) => {
            json!({"success": false, "code": "restore-failed", "error": error.to_string()})
        }
    }
}

#[tauri::command]
pub fn delete_backup(data: Value, state: State<'_, LauncherState>) -> Value {
    let folder = folder_of(&data);
    if state.is_instance_running(folder) {
        return json!({
            "success": false,
            "code": "running",
            "error": "Die Instanz läuft. Beende das Spiel, bevor du eine Sicherung löschst."
        });
    }
    let manager = match manager_for(folder) {
        Ok(manager) => manager,
        Err(error) => return error,
    };
    let Some(id) = data.get("backupId").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Keine Sicherung angegeben."});
    };

    match manager.remove(id) {
        Ok(()) => json!({"success": true}),
        Err(error) => {
            json!({"success": false, "code": "delete-failed", "error": error.to_string()})
        }
    }
}

#[tauri::command]
pub fn open_backups_folder(folder_name: String) -> Value {
    let manager = match manager_for(&folder_name) {
        Ok(manager) => manager,
        Err(error) => return error,
    };
    let dir = manager.backups_dir();
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return json!({"success": false, "code": "io", "error": error.to_string()});
    }
    match ipc::open_path(&dir) {
        Ok(()) => json!({"success": true, "path": dir.to_string_lossy()}),
        Err(error) => json!({"success": false, "code": "open-failed", "error": error}),
    }
}
