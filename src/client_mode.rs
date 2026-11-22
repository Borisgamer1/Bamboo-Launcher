//! Global client mode.
//!
//! One switch for the whole launcher. The state lives next to the other
//! launcher files so the UI can restore it before a game starts and the launch
//! path can attach the client mods.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ClientState {
    pub enabled: bool,
}

fn state_path() -> PathBuf {
    config::default_config_dir().join("client.json")
}

pub fn load() -> ClientState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn set_enabled(enabled: bool) -> Result<ClientState, String> {
    let state = ClientState { enabled };
    let path = state_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())?;
    Ok(state)
}

/// Jars, die nur im Client-Modus in den Start wandern. Nichts wird in die
/// Instanz kopiert: Fabric liest sie über `fabric.addMods` einmalig mit.
pub fn mods_dir() -> PathBuf {
    config::default_config_dir().join("client").join("mods")
}

/// Mitgelieferte Fabric API für Instanzen, die selbst keine haben.
pub fn api_dir() -> PathBuf {
    config::default_config_dir().join("client").join("api")
}

fn is_jar(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
}

fn jars_in(dir: &Path) -> Vec<PathBuf> {
    let mut jars: Vec<PathBuf> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_jar(path))
        .collect();
    jars.sort();
    jars
}

fn has_fabric_api(mods: &Path) -> bool {
    fs::read_dir(mods)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.starts_with("fabric-api") && name.ends_with(".jar")
        })
}

/// `-Dfabric.addMods=…` für den aktuellen Schalterstand.
///
/// Fabric trennt mehrere Pfade mit dem Pfadtrenner des Systems. Auf Windows
/// ist das `;`, nicht `:` – ein `:` würde jeden Laufwerksbuchstaben zerlegen.
///
/// Eine 26.3-Instanz ohne Fabric API würde den Client-Mod als inkompatibel
/// ablehnen. Deshalb wandert die mitgelieferte API nur dann in den Start,
/// wenn die Instanz selbst keine hat; sonst gäbe es zwei API-Jars.
pub fn fabric_add_mods_arg(instance_mods: &Path) -> Option<String> {
    if !load().enabled {
        return None;
    }

    let mut jars = jars_in(&mods_dir());
    if jars.is_empty() {
        return None;
    }

    if !has_fabric_api(instance_mods) {
        let bundled = jars_in(&api_dir()).into_iter().find(|path| {
            path.file_name()
                .map(|name| {
                    name.to_string_lossy()
                        .to_ascii_lowercase()
                        .starts_with("fabric-api")
                })
                .unwrap_or(false)
        });
        match bundled {
            Some(api) => jars.push(api),
            // Lieber ohne Client starten als mit einem Mod, dessen
            // Abhängigkeit garantiert fehlt.
            None => return None,
        }
    }

    let separator = if cfg!(windows) { ";" } else { ":" };
    let list = jars
        .iter()
        .map(|jar| jar.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(separator);
    Some(format!("-Dfabric.addMods={list}"))
}
