//! Tauri commands for the global client-mode switch.

use bamboo_launcher::client_mode::{self, ClientState};

#[tauri::command]
pub fn client_state() -> ClientState {
    client_mode::load()
}

#[tauri::command]
pub fn client_set_enabled(enabled: bool) -> Result<ClientState, String> {
    client_mode::set_enabled(enabled)
}
