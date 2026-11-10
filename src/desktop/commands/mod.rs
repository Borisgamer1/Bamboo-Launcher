//! Commands the ported UI calls that do not belong to the core launch path.
//!
//! Split by area so `ipc.rs` stays about settings, launch and content.

pub mod backups;
pub mod diagnostics;
pub mod external_import;
pub mod instances_extra;
pub mod logs_tools;
pub mod media;
pub mod preflight;
pub mod profiles_io;
pub mod servers;
pub mod skins;
pub mod updater;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Unique id for undo tokens; the value itself carries no meaning.
static TOKEN: AtomicU64 = AtomicU64::new(1);

pub fn next_token() -> u64 {
    TOKEN.fetch_add(1, Ordering::SeqCst)
}

/// Set by the renderer once its last save finished, so the window can close
/// immediately instead of always waiting out the full grace period.
static FLUSH_DONE: AtomicBool = AtomicBool::new(false);

pub fn flush_finished() -> bool {
    FLUSH_DONE.swap(false, Ordering::SeqCst)
}

#[tauri::command]
pub fn flush_before_close_complete() {
    FLUSH_DONE.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn show_item_in_folder(file_path: String) -> bool {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return false;
    }
    #[cfg(windows)]
    {
        // `explorer` returns 1 even on success, so the exit code proves nothing.
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn();
        true
    }
    #[cfg(not(windows))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        crate::ipc::open_path(target).is_ok()
    }
}
