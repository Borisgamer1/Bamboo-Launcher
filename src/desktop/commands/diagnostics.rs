//! Loader version lists that the create dialog needs before a pack exists.

use std::time::Duration;

use serde_json::{json, Value};

const FORGE_METADATA: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const NEOFORGE_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";

async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response.text().await.map_err(|error| error.to_string())
}

/// Every published Forge build, newest first.
#[tauri::command]
pub async fn forge_versions() -> Value {
    let Ok(body) = fetch_text(FORGE_METADATA).await else {
        return Value::Null;
    };
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&body) else {
        return Value::Null;
    };
    let mut versions: Vec<String> = map
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    versions.sort();
    versions.dedup();
    versions.reverse();
    json!(versions)
}

/// Every published NeoForge build, newest first.
#[tauri::command]
pub async fn neoforge_versions() -> Value {
    let Ok(body) = fetch_text(NEOFORGE_METADATA).await else {
        return Value::Null;
    };
    let mut versions = Vec::new();
    let mut rest = body.as_str();
    while let Some(start) = rest.find("<version>") {
        rest = &rest[start + "<version>".len()..];
        let Some(end) = rest.find("</version>") else {
            break;
        };
        versions.push(rest[..end].trim().to_string());
        rest = &rest[end + "</version>".len()..];
    }
    versions.reverse();
    json!(versions)
}
