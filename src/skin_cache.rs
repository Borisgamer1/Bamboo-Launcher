//! Zwischenspeicher für das Startseiten-Avatar.
//!
//! Die Startseite hat das Skin-PNG bisher bei jedem Start neu aus dem Netz
//! geholt. Bis die Antwort da war, blieb die 3D-Figur weiß. Der Cache hält das
//! zuletzt geladene PNG neben den übrigen Skin-Daten, damit die Vorschau sofort
//! etwas zeigt und nur im Hintergrund aktualisiert.
//!
//! Alles hier ist "best effort": ein fehlender oder kaputter Cache ist kein
//! Fehler, die Aufrufer fallen dann auf das mitgelieferte Skin zurück.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

/// So lange gilt ein Cache-Treffer als aktuell; danach wird im Hintergrund
/// nachgeladen. Verhindert eine Netzanfrage bei jedem Tab-Wechsel.
pub const FRESH_MS: u64 = 10 * 60 * 1000;

const FILE: &str = "avatar.png";
const META: &str = "meta.json";
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CachedSkin {
    /// PNG als Daten-URL, damit die WebView nichts nachladen muss.
    pub url: String,
    pub updated_at: u64,
}

/// Ein dateisystemtauglicher Schlüssel für ein Konto.
///
/// Die UUID hat Vorrang (Minecraft-Namen ändern sich), sonst der Name. Alles
/// außerhalb von `[a-z0-9_-]` fällt weg, damit ein Kontoname niemals einen Pfad
/// aus dem Cache-Ordner heraus bilden kann.
pub fn key_for(uuid: Option<&str>, name: Option<&str>) -> Option<String> {
    let raw = uuid
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| name.map(str::trim).filter(|value| !value.is_empty()))?;

    let mut key = String::with_capacity(raw.len());
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            key.push(character.to_ascii_lowercase());
        }
    }
    let key = key.trim_matches('-').trim_matches('_').to_string();
    if key.is_empty() {
        return None;
    }
    Some(key.chars().take(64).collect())
}

pub fn png_ok(bytes: &[u8]) -> bool {
    bytes.len() > 24 && &bytes[1..4] == b"PNG" && bytes.len() <= MAX_BYTES
}

pub fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_fresh(updated_at: u64, now: u64) -> bool {
    // A timestamp in the future means the clock jumped; reload instead of
    // trusting the entry indefinitely.
    updated_at > 0 && now >= updated_at && now - updated_at < FRESH_MS
}

/// Liest den Cache für genau dieses Konto. Ein Treffer eines anderen Kontos
/// wird ignoriert, damit beim Kontowechsel kein fremdes Skin erscheint.
pub fn read(dir: &Path, key: &str) -> Option<CachedSkin> {
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(META)).ok()?).ok()?;
    if meta.get("key").and_then(Value::as_str)? != key {
        return None;
    }
    let bytes = std::fs::read(dir.join(FILE)).ok()?;
    if !png_ok(&bytes) {
        return None;
    }
    Some(CachedSkin {
        url: data_url(&bytes),
        updated_at: meta
            .get("updatedAt")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

/// Schreibt ein frisch geladenes PNG. Gibt `None` zurück, wenn es kein gültiges
/// PNG ist oder der Ordner nicht beschreibbar ist.
pub fn write(dir: &Path, key: &str, bytes: &[u8]) -> Option<CachedSkin> {
    if !png_ok(bytes) {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(dir.join(FILE), bytes).ok()?;
    let updated_at = now_ms();
    let meta = json!({ "key": key, "updatedAt": updated_at });
    std::fs::write(dir.join(META), meta.to_string()).ok()?;
    Some(CachedSkin {
        url: data_url(bytes),
        updated_at,
    })
}

/// Ordner, in dem das Avatar-PNG liegt (neben `skin/skin.png`).
pub fn avatar_dir() -> PathBuf {
    crate::config::default_config_dir()
        .join("skin")
        .join("avatar")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bamboo-skin-cache-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png() -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[1] = b'P';
        bytes[2] = b'N';
        bytes[3] = b'G';
        bytes
    }

    #[test]
    fn key_prefers_uuid_and_stays_path_safe() {
        assert_eq!(
            key_for(Some("069A79F4-44E9-4726-A5BE-FCA90E38AFFE"), Some("Notch")).as_deref(),
            Some("069a79f4-44e9-4726-a5be-fca90e38affe")
        );
        assert_eq!(key_for(None, Some("Player_1")).as_deref(), Some("player_1"));
        assert_eq!(key_for(None, Some("../../etc/passwd")).as_deref(), Some("etcpasswd"));
        assert_eq!(key_for(None, Some("  ")), None);
        assert_eq!(key_for(Some(""), None), None);
    }

    #[test]
    fn write_then_read_returns_the_same_png() {
        let dir = temp_dir("roundtrip");
        let written = write(&dir, "notch", &png()).expect("cache write");
        assert!(written.url.starts_with("data:image/png;base64,"));
        assert!(written.updated_at > 0);

        let read_back = read(&dir, "notch").expect("cache hit");
        assert_eq!(read_back.url, written.url);
        assert_eq!(read_back.updated_at, written.updated_at);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn another_account_never_gets_the_cached_skin() {
        let dir = temp_dir("switch");
        write(&dir, "notch", &png()).unwrap();
        assert!(read(&dir, "jeb").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn broken_or_foreign_files_are_ignored() {
        let dir = temp_dir("broken");
        std::fs::write(dir.join(FILE), b"kein png").unwrap();
        std::fs::write(
            dir.join(META),
            json!({ "key": "notch", "updatedAt": 1 }).to_string(),
        )
        .unwrap();
        assert!(read(&dir, "notch").is_none());

        // A valid PNG with a non-PNG payload is still rejected by the header.
        assert!(write(&dir, "notch", &[0u8; 64]).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn freshness_window_is_bounded() {
        assert!(is_fresh(1_000, 1_000 + FRESH_MS - 1));
        assert!(!is_fresh(1_000, 1_000 + FRESH_MS));
        assert!(!is_fresh(0, 5_000));
        // A clock that jumped backwards must not mark a cache as fresh forever.
        assert!(!is_fresh(5_000, 1_000));
    }
}
