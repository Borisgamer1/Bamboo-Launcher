#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop entry point. The CLI in `src/main.rs` stays available for scripts;
//! this binary is the Tauri shell that renders the ported UI.

mod commands;
mod ipc;

use bamboo_launcher::config as core_config;
use ipc::LauncherState;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const MIN_WINDOW_WIDTH: u32 = 1024;
const MIN_WINDOW_HEIGHT: u32 = 700;

/// Zählt jedes Größenereignis. Nur der letzte Durchlauf speichert, damit ein
/// Ziehen am Fensterrand nicht hunderte Schreibvorgänge auslöst.
static RESIZE_TOKEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Datei mit Größe, Position und Maximiert-Zustand des Launcher-Fensters.
fn window_state_path() -> std::path::PathBuf {
    core_config::default_config_dir().join("window-state.json")
}

fn load_window_state() -> Option<Value> {
    let text = std::fs::read_to_string(window_state_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Merkt sich die Fenstergröße beim Schließen.
///
/// Ist das Fenster maximiert, bleibt die zuletzt bekannte Normalgröße
/// erhalten; sonst würde ein maximiertes Fenster seine Bildschirmgröße
/// speichern und danach immer maximiert aufmachen.
fn save_window_state(window: &WebviewWindow) {
    let Ok(maximized) = window.is_maximized() else {
        return;
    };
    let mut state = match load_window_state() {
        Some(value) if value.is_object() => value,
        _ => json!({}),
    };
    if !maximized {
        let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else {
            return;
        };
        // Minimiert meldet das Fenster 0×0; dann bleibt die alte Größe stehen.
        if size.width == 0 || size.height == 0 {
            return;
        }
        state["width"] = json!(size.width);
        state["height"] = json!(size.height);
        state["x"] = json!(position.x);
        state["y"] = json!(position.y);
    }
    state["maximized"] = json!(maximized);

    let path = window_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(&path, text);
    }
}

/// Liegt die linke obere Ecke auf einem angeschlossenen Bildschirm? Sonst
/// würde ein abgezogener Monitor das Fenster unerreichbar machen.
fn position_is_reachable(window: &WebviewWindow, x: i32, y: i32) -> bool {
    match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors.iter().any(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            x >= origin.x - 32
                && y >= origin.y - 32
                && x < origin.x + size.width as i32 - 64
                && y < origin.y + size.height as i32 - 64
        }),
        _ => true,
    }
}

/// Stellt die zuletzt gespeicherte Fenstergröße und -position wieder her.
fn restore_window_state(window: &WebviewWindow) {
    let Some(state) = load_window_state() else {
        return;
    };
    let width = state.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let height = state.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    if width > 0 && height > 0 {
        // Ein gespeicherter Wert unterhalb der Mindestgröße (etwa aus einer
        // früheren Fassung) wird angehoben statt verworfen.
        let width = width.max(MIN_WINDOW_WIDTH);
        let height = height.max(MIN_WINDOW_HEIGHT);
        let _ = window.set_size(PhysicalSize::new(width, height));
    }

    let x = state
        .get("x")
        .and_then(Value::as_i64)
        .map(|value| value as i32);
    let y = state
        .get("y")
        .and_then(Value::as_i64)
        .map(|value| value as i32);
    if let (Some(x), Some(y)) = (x, y) {
        if position_is_reachable(window, x, y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }

    if state
        .get("maximized")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let _ = window.maximize();
    }
}

/// Speichert die Fenstergröße, sobald die Größe kurz stehen bleibt.
fn schedule_window_state_save(window: &WebviewWindow) {
    let token = RESIZE_TOKEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        // Kam inzwischen ein neueres Ereignis, speichert dieses selbst.
        if RESIZE_TOKEN.load(std::sync::atomic::Ordering::SeqCst) != token {
            return;
        }
        save_window_state(&window);
    });
}

/// `--launch <folder>` is what a launcher-created shortcut passes along.
fn launch_argument(mut args: impl Iterator<Item = String>) -> Option<String> {
    while let Some(arg) = args.next() {
        if arg == "--launch" {
            return args.next().filter(|value| !value.trim().is_empty());
        }
    }
    None
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LauncherState::new())
        .manage(commands::updater::UpdateState::new())
        .invoke_handler(tauri::generate_handler![
            ipc::get_settings,
            ipc::save_settings,
            ipc::get_profiles,
            ipc::save_profiles,
            ipc::list_instances,
            ipc::create_instance,
            ipc::rename_instance,
            ipc::delete_instance_files,
            ipc::open_instance_folder,
            ipc::change_instance_version,
            ipc::update_launch_settings,
            ipc::read_latest_log,
            ipc::auth_status,
            ipc::auth_login,
            ipc::auth_cancel,
            ipc::auth_logout,
            ipc::auth_refresh,
            ipc::player_identity,
            ipc::list_accounts,
            ipc::set_active_account,
            ipc::remove_account,
            ipc::launch_game,
            ipc::kill_game,
            ipc::list_java,
            ipc::list_content_files,
            ipc::delete_content_file,
            ipc::identify_content_files,
            ipc::check_mod_updates,
            ipc::install_mod,
            ipc::upload_local_mod,
            ipc::install_modpack,
            ipc::curseforge_search,
            ipc::curseforge_project,
            ipc::curseforge_files,
            ipc::cosmetics_list,
            ipc::cosmetics_shop,
            ipc::cosmetics_shop_preview,
            ipc::cosmetics_preview,
            ipc::cosmetics_install,
            ipc::cosmetics_remove,
            ipc::show_open_dialog,
            ipc::show_save_dialog,
            ipc::read_image_file,
            ipc::open_external,
            ipc::get_icon,
            ipc::minimize_window,
            ipc::maximize_window,
            ipc::is_maximized_window,
            ipc::focus_window,
            ipc::close_window,
            commands::updater::updates_state,
            commands::flush_before_close_complete,
            commands::show_item_in_folder,
            commands::instances_extra::clone_instance,
            commands::instances_extra::repair_instance,
            commands::instances_extra::create_desktop_shortcut,
            commands::instances_extra::list_instance_worlds,
            commands::instances_extra::open_instance_world,
            commands::instances_extra::export_instance_world,
            commands::instances_extra::import_instance_world,
            commands::instances_extra::delete_instance_world,
            commands::backups::list_backups,
            commands::backups::create_backup,
            commands::backups::restore_backup,
            commands::backups::delete_backup,
            commands::backups::open_backups_folder,
            commands::servers::sync_servers_dat,
            commands::diagnostics::forge_versions,
            commands::diagnostics::neoforge_versions,
            commands::updater::updates_check,
            commands::updater::updates_install,
            commands::media::collect_screenshots,
            commands::media::delete_screenshot,
            commands::media::open_screenshots_folder,
            commands::media::statistics_summary,
            commands::media::ping_server,
            commands::profiles_io::export_profile,
            commands::profiles_io::import_profile_preview,
            commands::profiles_io::import_profile,
            commands::profiles_io::update_modpack,
            commands::external_import::external_instance_preview,
            commands::external_import::import_external_instance,
            commands::preflight::preflight_check,
            commands::preflight::preflight_disable,
            commands::logs_tools::logs_analyze,
            commands::logs_tools::logs_apply_fix,
            commands::logs_tools::logs_undo_fix,
            commands::logs_tools::logs_support_bundle,
            commands::skins::skins_snapshot,
            commands::skins::skins_save,
            commands::skins::skins_variant,
            commands::skins::skins_reset,
            commands::skins::skins_apply,
            commands::skins::skins_cape,
            commands::skins::skins_refresh,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Erst die gespeicherte Größe setzen, dann zeigen – sonst
                // springt das Fenster beim Start sichtbar von 1280×800 um.
                restore_window_state(&window);
                let _ = window.show();
                // A shortcut made by the launcher asks for one instance.
                if let Some(folder) = launch_argument(std::env::args().skip(1)) {
                    let handle = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                        let _ = handle.emit("bamboo:launch-instance-request", folder);
                    });
                }
                let handle = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        save_window_state(&handle);
                        let state = handle.state::<LauncherState>();
                        if state.is_closing() {
                            return;
                        }
                        api.prevent_close();
                        // Give the renderer one persistence pass before the
                        // window goes away, exactly like the Electron flush.
                        let _ = handle.emit("app:flush-before-close", ());
                        let window = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            // The renderer confirms its last save; the timeout is
                            // only for a window that never answers.
                            for _ in 0..50 {
                                if commands::flush_finished() {
                                    break;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            }
                            let state = window.state::<LauncherState>();
                            state.mark_closing();
                            let _ = window.close();
                        });
                    }
                    tauri::WindowEvent::Resized(_) => {
                        if let Ok(maximized) = handle.is_maximized() {
                            let _ = handle.emit("window-maximized-change", maximized);
                        }
                        // Auch ohne sauberes Schließen (Dev-Sitzung, Absturz)
                        // bleibt die zuletzt eingestellte Größe erhalten.
                        schedule_window_state_save(&handle);
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Bamboo Launcher konnte nicht gestartet werden");
}
