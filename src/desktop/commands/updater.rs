//! In-app updates through the Tauri updater plugin.
//!
//! One click covers the whole way: `updates_check` looks for a newer build,
//! downloads and verifies it, and keeps the bytes ready. `updates_install`
//! hands them to the platform updater and restarts, so a new version never
//! needs a manual installer download.
//!
//! The feed lives next to the release artifacts (`latest.json`), see
//! `scripts/make-latest-json.mjs`. Its URL and the public key are configured
//! in `tauri.conf.json`.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// A verified download waiting for the restart that applies it.
struct Prepared {
    update: Update,
    bytes: Vec<u8>,
}

/// Held in Tauri's managed state; empty until an update is downloaded.
#[derive(Default)]
pub struct UpdateState {
    prepared: Mutex<Option<Prepared>>,
}

impl UpdateState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn status(state: &str, version: Option<&str>, percent: Option<u64>, message: Option<&str>) -> Value {
    let mut value = json!({
        "state": state,
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "checkedAt": now_ms(),
    });
    if let Some(version) = version {
        value["version"] = json!(version);
    }
    if let Some(percent) = percent {
        value["percent"] = json!(percent);
    }
    if let Some(message) = message {
        value["message"] = json!(message);
    }
    value
}

/// The renderer listens on this event, so a download shows its progress even
/// though the command only resolves at the end.
fn publish(app: &AppHandle, value: &Value) {
    let _ = app.emit("updater-status", value.clone());
}

#[tauri::command]
pub fn updates_state() -> Value {
    status("idle", None, None, None)
}

/// Looks for an update and downloads it; `downloaded` means "restart now".
#[tauri::command]
pub async fn updates_check(app: AppHandle) -> Value {
    publish(&app, &status("checking", None, None, None));

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let reply = status("error", None, None, Some(&error.to_string()));
            publish(&app, &reply);
            return reply;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            let reply = status("not-available", None, None, None);
            publish(&app, &reply);
            return reply;
        }
        Err(error) => {
            let reply = status("error", None, None, Some(&error.to_string()));
            publish(&app, &reply);
            return reply;
        }
    };

    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();
    publish(
        &app,
        &status("available", Some(&version), None, Some(&notes)),
    );

    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                // At most a few hundred events for a 30 MB package: one per
                // percent, not one per network chunk.
                let percent = match total.filter(|total| *total > 0) {
                    Some(total) => (downloaded.saturating_mul(100) / total).min(100),
                    None => 0,
                };
                if percent != reported {
                    reported = percent;
                    publish(
                        &progress_app,
                        &status(
                            "downloading",
                            Some(&progress_version),
                            Some(percent),
                            None,
                        ),
                    );
                }
            },
            || {},
        )
        .await;

    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
            let reply = status("error", Some(&version), None, Some(&error.to_string()));
            publish(&app, &reply);
            return reply;
        }
    };

    let state = app.state::<UpdateState>();
    match state.prepared.lock() {
        Ok(mut slot) => *slot = Some(Prepared { update, bytes }),
        Err(_) => {
            let reply = status("error", Some(&version), None, Some("Update-Speicher gesperrt"));
            publish(&app, &reply);
            return reply;
        }
    }

    let reply = status("downloaded", Some(&version), Some(100), None);
    publish(&app, &reply);
    reply
}

/// Applies the prepared update. On Windows the installer takes over and
/// restarts the app; everywhere else the new version starts on relaunch.
#[tauri::command]
pub fn updates_install(app: AppHandle) -> Value {
    let prepared = app
        .state::<UpdateState>()
        .prepared
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());

    let Some(prepared) = prepared else {
        return status("error", None, None, Some("Kein Update bereit"));
    };

    let version = prepared.update.version.clone();
    publish(&app, &status("installing", Some(&version), Some(100), None));

    if let Err(error) = prepared.update.install(&prepared.bytes) {
        let reply = status("error", Some(&version), None, Some(&error.to_string()));
        publish(&app, &reply);
        return reply;
    }

    // Windows never reaches this line: the installer exits the app and starts
    // it again. macOS and Linux install in place and need the relaunch.
    app.restart();
}
