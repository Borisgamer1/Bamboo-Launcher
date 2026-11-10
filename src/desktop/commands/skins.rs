//! Player skin and cape, stored locally and applied through the Mojang API.
//!
//! The local copy is the source of truth for the preview; the profile call only
//! supplies capes and confirms what Mojang currently has.

use std::path::PathBuf;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::ipc;

const PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const SKIN_URL: &str = "https://api.minecraftservices.com/minecraft/profile/skins";
const ACTIVE_SKIN_URL: &str = "https://api.minecraftservices.com/minecraft/profile/skins/active";
const CAPE_URL: &str = "https://api.minecraftservices.com/minecraft/profile/capes/active";

fn skin_dir() -> PathBuf {
    bamboo_launcher::config::default_config_dir().join("skin")
}

fn skin_file() -> PathBuf {
    skin_dir().join("skin.png")
}

fn meta_file() -> PathBuf {
    skin_dir().join("meta.json")
}

fn variant() -> String {
    ipc::read_json(&meta_file())
        .and_then(|meta| {
            meta.get("variant")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|value| value == "slim" || value == "classic")
        .unwrap_or_else(|| "classic".to_string())
}

fn local_skin_url() -> Option<String> {
    let bytes = std::fs::read(skin_file()).ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

struct Session {
    token: String,
    uuid: String,
    name: String,
    expires_at: u64,
}

fn session() -> Option<Session> {
    let stored = ipc::session_manager().load().ok().flatten()?;
    let token = stored.minecraft_access_token.trim().to_string();
    if token.is_empty() {
        return None;
    }
    Some(Session {
        token,
        uuid: stored.uuid,
        name: stored.username,
        expires_at: stored.minecraft_expires_at,
    })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())
}

/// The Mojang profile, or `None` when the token is missing, expired or rejected.
async fn profile(session: &Session) -> Option<Value> {
    if session.expires_at > 0 && session.expires_at < bamboo_launcher::token_store::now_ms() {
        return None;
    }
    let response = client()
        .ok()?
        .get(PROFILE_URL)
        .bearer_auth(&session.token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn snapshot_with(profile: Option<&Value>) -> Value {
    let session = session();
    let variant = variant();
    let local = local_skin_url();
    let profile_skin = profile
        .and_then(|value| value.get("skins"))
        .and_then(|skins| {
            skins
                .as_array()?
                .iter()
                .find(|skin| skin.get("state").and_then(Value::as_str) == Some("ACTIVE"))
                .cloned()
        });

    let online = profile.is_some();
    let skin_url = local.clone().or_else(|| {
        profile_skin
            .as_ref()?
            .get("url")?
            .as_str()
            // Mojang still hands out `http://textures.minecraft.net/...`.
            // The WebView refuses to mix that into its own secure origin, so
            // the texture has to be fetched over https.
            .map(|url| url.replacen("http://", "https://", 1))
    });
    let source = if local.is_some() {
        "local"
    } else if skin_url.is_some() {
        "profile"
    } else {
        "none"
    };

    let capes = profile
        .and_then(|value| value.get("capes"))
        .and_then(Value::as_array)
        .map(|capes| {
            capes
                .iter()
                .filter_map(|cape| {
                    Some(json!({
                        "id": cape.get("id")?.as_str()?,
                        "name": cape.get("alias").and_then(Value::as_str).unwrap_or("Cape"),
                        "url": cape.get("url").and_then(Value::as_str).unwrap_or_default(),
                        "active": cape.get("state").and_then(Value::as_str) == Some("ACTIVE"),
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "account": session.as_ref().map(|session| json!({
            "id": session.uuid,
            "name": session.name,
            "uuid": session.uuid,
            "online": online,
        })),
        "capes": capes,
        "skin": {
            "url": skin_url,
            "source": source,
            "variant": variant,
            "updatedAt": std::fs::metadata(skin_file())
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as u64),
            // A local file that Mojang has not confirmed yet is not applied.
            "applied": online && local.is_none(),
        },
        "canApplySkin": session.is_some(),
    })
}

async fn current() -> Value {
    let profile = match session() {
        Some(session) => profile(&session).await,
        None => None,
    };
    snapshot_with(profile.as_ref())
}

#[tauri::command]
pub async fn skins_snapshot() -> Value {
    current().await
}

#[tauri::command]
pub async fn skins_refresh() -> Value {
    current().await
}

/// PNG header check before anything is written or uploaded.
fn png_ok(bytes: &[u8]) -> bool {
    bytes.len() > 24 && &bytes[1..4] == b"PNG" && bytes.len() <= 2 * 1024 * 1024
}

fn bytes_from(value: &Value) -> Option<Vec<u8>> {
    let array = value.as_array()?;
    let mut bytes = Vec::with_capacity(array.len());
    for item in array {
        bytes.push(u8::try_from(item.as_u64()?).ok()?);
    }
    Some(bytes)
}

#[tauri::command]
pub async fn skins_save(payload: Value) -> Value {
    let Some(bytes) = payload.get("bytes").and_then(bytes_from) else {
        return current().await;
    };
    if !png_ok(&bytes) {
        return current().await;
    }
    let variant = payload
        .get("variant")
        .and_then(Value::as_str)
        .filter(|value| *value == "slim" || *value == "classic")
        .unwrap_or("classic");
    let _ = std::fs::create_dir_all(skin_dir());
    if std::fs::write(skin_file(), &bytes).is_err() {
        return current().await;
    }
    let _ = ipc::write_json(&meta_file(), &json!({ "variant": variant }));
    current().await
}

#[tauri::command]
pub async fn skins_variant(payload: Option<Value>) -> Value {
    let variant = payload
        .as_ref()
        .and_then(|payload| payload.get("variant"))
        .and_then(Value::as_str)
        .filter(|value| *value == "slim" || *value == "classic")
        .unwrap_or("classic");
    let _ = std::fs::create_dir_all(skin_dir());
    let _ = ipc::write_json(&meta_file(), &json!({ "variant": variant }));
    current().await
}

#[tauri::command]
pub async fn skins_reset() -> Value {
    let _ = std::fs::remove_file(skin_file());
    let _ = std::fs::remove_file(meta_file());
    if let Some(session) = session() {
        if let Ok(client) = client() {
            let _ = client
                .delete(ACTIVE_SKIN_URL)
                .bearer_auth(&session.token)
                .send()
                .await;
        }
    }
    current().await
}

/// Manual multipart body: Mojang needs a file part, and reqwest is built here
/// without the multipart feature.
fn multipart_skin(bytes: &[u8], variant: &str) -> (String, Vec<u8>) {
    let boundary = "----BambooSkinBoundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{variant}\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[tauri::command]
pub async fn skins_apply() -> Value {
    let Some(session) = session() else {
        return current().await;
    };
    let Ok(bytes) = std::fs::read(skin_file()) else {
        return current().await;
    };
    if !png_ok(&bytes) {
        return current().await;
    }
    let (content_type, body) = multipart_skin(&bytes, &variant());
    if let Ok(client) = client() {
        let _ = client
            .post(SKIN_URL)
            .bearer_auth(&session.token)
            .header("Content-Type", content_type)
            .body(body)
            .send()
            .await;
    }
    current().await
}

#[tauri::command]
pub async fn skins_cape(payload: Option<Value>) -> Value {
    let Some(session) = session() else {
        return current().await;
    };
    let Ok(client) = client() else {
        return current().await;
    };
    match payload
        .as_ref()
        .and_then(|payload| payload.get("capeId"))
        .and_then(Value::as_str)
    {
        Some(cape) if !cape.is_empty() => {
            let _ = client
                .put(CAPE_URL)
                .bearer_auth(&session.token)
                .json(&json!({ "capeId": cape }))
                .send()
                .await;
        }
        _ => {
            let _ = client
                .delete(CAPE_URL)
                .bearer_auth(&session.token)
                .send()
                .await;
        }
    }
    current().await
}
