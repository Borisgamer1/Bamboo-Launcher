//! Kern-Engine des Bamboo Launchers.
//!
//! Die Module sind bewusst frei von UI-Abhängigkeiten: Java-Erkennung,
//! Versionsauflösung, Argumentbau, Prozessstart und Instanzverwaltung
//! funktionieren eigenständig und lassen sich einzeln testen.

pub mod auth;
pub mod backup;
pub mod config;
pub mod cosmetics;
pub mod download;
pub mod error;
pub mod foreign_instance;
pub mod game_settings;
pub mod install;
pub mod instances;
pub mod java;
pub mod launcher;
pub mod loader;
pub mod modpack;
pub mod mods;
pub mod preflight;
pub mod server_ping;
pub mod servers_dat;
pub mod sessions;
pub mod skin_cache;
pub mod token_store;
pub mod version;

pub use error::{LauncherError, Result};
