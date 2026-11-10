//! Screenshots, statistics and server pings.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::ipc;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", (bytes / 1024).max(1))
    }
}

/// PNG width and height come from the IHDR chunk right after the signature.
fn png_dimensions(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    if bytes.len() < 24 || &bytes[1..4] != b"PNG" {
        return String::new();
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    format!("{width} × {height}")
}

fn screenshot(path: &Path, source: &str, instance: &str, world: Option<String>) -> Option<Value> {
    let name = path.file_name()?.to_string_lossy().to_string();
    if !name.to_lowercase().ends_with(".png") {
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();
    let absolute = path.to_string_lossy().to_string();
    let stem = path.file_stem()?.to_string_lossy().to_string();
    Some(json!({
        "id": absolute,
        "title": stem,
        "fileName": name,
        "source": source,
        "instance": instance,
        "world": world,
        "date": modified_ms(path),
        "sizeBytes": size,
        "sizeStr": human_size(size),
        "dimensions": png_dimensions(path),
        "url": "",
        "absolutePath": absolute,
        "sourceAbsolutePath": absolute,
    }))
}

fn collect_from(dir: &Path, source: &str, instance: &str, into: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(item) = screenshot(&path, source, instance, None) {
                into.push(item);
            }
            continue;
        }
        if path.is_dir() {
            // Some setups keep one folder per world inside `screenshots`.
            let world = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string());
            let Ok(nested) = std::fs::read_dir(&path) else {
                continue;
            };
            for file in nested.flatten() {
                if let Some(item) = screenshot(&file.path(), source, instance, world.clone()) {
                    into.push(item);
                }
            }
        }
    }
}

#[tauri::command]
pub fn collect_screenshots() -> Value {
    let root = ipc::load_rust_settings().game_root;
    let mut items = Vec::new();
    collect_from(&root.join("screenshots"), "global", "", &mut items);
    if let Ok(listed) = ipc::manager(&root).list() {
        for instance in listed {
            collect_from(
                &instance.dir.join("screenshots"),
                "instance",
                &instance.name,
                &mut items,
            );
        }
    }
    items.sort_by(|left, right| {
        right["date"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&left["date"].as_u64().unwrap_or(0))
    });
    Value::Array(items)
}

/// Refuses anything outside the game root, so a stray path cannot delete data.
#[tauri::command]
pub fn delete_screenshot(payload: Value) -> bool {
    let root = ipc::load_rust_settings().game_root;
    let Some(candidate) = payload.get("absolutePath").and_then(Value::as_str) else {
        return false;
    };
    let target = Path::new(candidate);
    if !target.starts_with(&root) || !target.is_file() {
        return false;
    }
    std::fs::remove_file(target).is_ok()
}

#[tauri::command]
pub fn open_screenshots_folder() -> bool {
    let root = ipc::load_rust_settings().game_root;
    let dir = root.join("screenshots");
    let _ = std::fs::create_dir_all(&dir);
    ipc::open_path(&dir).is_ok()
}

fn stats_files(instance_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(worlds) = std::fs::read_dir(instance_dir.join("saves")) else {
        return files;
    };
    for world in worlds.flatten() {
        let Ok(entries) = std::fs::read_dir(world.path().join("stats")) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                files.push(entry.path());
            }
        }
    }
    files
}

fn distance_fields() -> [(&'static str, &'static str); 16] {
    [
        ("walkCm", "minecraft:walk_one_cm"),
        ("sprintCm", "minecraft:sprint_one_cm"),
        ("crouchCm", "minecraft:crouch_one_cm"),
        ("swimCm", "minecraft:swim_one_cm"),
        ("flyCm", "minecraft:fly_one_cm"),
        ("climbCm", "minecraft:climb_one_cm"),
        ("fallCm", "minecraft:fall_one_cm"),
        ("walkOnWaterCm", "minecraft:walk_on_water_one_cm"),
        ("walkUnderWaterCm", "minecraft:walk_under_water_one_cm"),
        ("aviateCm", "minecraft:aviate_one_cm"),
        ("minecartCm", "minecraft:minecart_one_cm"),
        ("boatCm", "minecraft:boat_one_cm"),
        ("pigCm", "minecraft:pig_one_cm"),
        ("horseCm", "minecraft:horse_one_cm"),
        ("striderCm", "minecraft:strider_one_cm"),
        ("happyGhastCm", "minecraft:happy_ghast_one_cm"),
    ]
}

#[derive(Default, Clone)]
struct Totals {
    play_ms: u64,
    mined: u64,
    placed: u64,
    mobs: u64,
    deaths: u64,
    jumps: u64,
    distance: [u64; 16],
}

fn add_stats(totals: &mut Totals, stats: &Value) {
    let custom = stats.get("minecraft:custom");
    let read = |key: &str| {
        custom
            .and_then(|custom| custom.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    totals.play_ms = totals
        .play_ms
        .saturating_add(read("minecraft:play_time") * 50);
    totals.mined = totals.mined.saturating_add(read("minecraft:mine_block"));
    totals.placed = totals.placed.saturating_add(read("minecraft:use_item"));
    totals.mobs = totals.mobs.saturating_add(read("minecraft:mob_kills"));
    totals.deaths = totals.deaths.saturating_add(read("minecraft:deaths"));
    totals.jumps = totals.jumps.saturating_add(read("minecraft:jump"));
    for (index, (_, key)) in distance_fields().iter().enumerate() {
        totals.distance[index] = totals.distance[index].saturating_add(read(key));
    }
}

fn distance_json(distance: &[u64; 16]) -> Value {
    let mut object = serde_json::Map::new();
    for (index, (field, _)) in distance_fields().iter().enumerate() {
        object.insert((*field).to_string(), json!(distance[index]));
    }
    Value::Object(object)
}

#[tauri::command]
pub fn statistics_summary() -> Value {
    let root = ipc::load_rust_settings().game_root;
    let enabled = ipc::statistics_enabled();

    let mut total = Totals::default();
    let mut per_instance = Vec::new();
    let mut worlds = 0u64;
    let mut total_sessions = 0u64;
    let mut first = u64::MAX;
    let mut last = 0u64;

    let listed = ipc::manager(&root).list().unwrap_or_default();
    for instance in &listed {
        let mut own = Totals::default();
        let mut instance_worlds = 0u64;
        for file in stats_files(&instance.dir) {
            if let Some(stats) = ipc::read_json(&file) {
                add_stats(&mut own, &stats);
            }
        }
        let worlds_dir = instance.dir.join("saves");
        if let Ok(entries) = std::fs::read_dir(&worlds_dir) {
            instance_worlds = entries.flatten().filter(|e| e.path().is_dir()).count() as u64;
        }
        worlds += instance_worlds;
        let profile = ipc::instance_profile(&root, instance);
        // Nur der Launcher kennt seine Starts; die Spielzeit kommt aus den
        // Welt-Statistiken, die Sessionzahl aus dem eigenen Protokoll.
        let session_summary = bamboo_launcher::sessions::summary(&instance.dir);
        if session_summary.count > 0 {
            first = first.min(session_summary.first_start);
            last = last.max(session_summary.last_seen);
        }
        total_sessions += session_summary.count;
        per_instance.push(json!({
            "id": instance.name,
            "name": profile["name"],
            "version": profile["version"],
            "loader": profile["loader"],
            "playTimeMs": own.play_ms,
            "sessions": session_summary.count,
            "worlds": instance_worlds,
            "distance": distance_json(&own.distance),
            "blocksMined": own.mined,
            "blocksPlaced": own.placed,
            "mobsKilled": own.mobs,
            "deaths": own.deaths,
            "jumps": own.jumps,
        }));
        total.play_ms += own.play_ms;
        total.mined += own.mined;
        total.placed += own.placed;
        total.mobs += own.mobs;
        total.deaths += own.deaths;
        total.jumps += own.jumps;
        for index in 0..16 {
            total.distance[index] += own.distance[index];
        }
    }
    per_instance.sort_by(|left, right| {
        right["playTimeMs"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&left["playTimeMs"].as_u64().unwrap_or(0))
    });

    json!({
        "enabled": enabled,
        "playTimeMs": total.play_ms,
        "sessions": total_sessions,
        "firstPlayedAt": if first == u64::MAX { 0 } else { first },
        "lastPlayedAt": last,
        "distance": distance_json(&total.distance),
        "blocksMined": total.mined,
        "blocksPlaced": total.placed,
        "mobsKilled": total.mobs,
        "deaths": total.deaths,
        "jumps": total.jumps,
        "instances": listed.len(),
        "worlds": worlds,
        "perInstance": per_instance,
        "generatedAt": now_ms(),
    })
}

// -- Server ping -----------------------------------------------------------

#[tauri::command]
pub async fn ping_server(server_ip: String) -> Value {
    match bamboo_launcher::server_ping::ping(&server_ip).await {
        Ok(value) => value,
        Err(error) => json!({
            "online": false,
            "playersOnline": 0,
            "playersMax": 0,
            "motd": "",
            "ping": 0,
            "version": "",
            "icon": null,
            "error": error,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_json_carries_every_field() {
        let value = distance_json(&[7; 16]);
        assert_eq!(value.as_object().expect("object").len(), 16);
        assert_eq!(value["walkCm"], 7);
        assert_eq!(value["happyGhastCm"], 7);
    }

    #[test]
    fn human_size_switches_at_a_megabyte() {
        assert_eq!(human_size(1024), "1 KB");
        assert_eq!(human_size(1536 * 1024), "1.5 MB");
    }

    #[test]
    fn png_dimensions_reads_the_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shot.png");
        let mut bytes = vec![0u8; 33];
        bytes[1..4].copy_from_slice(b"PNG");
        bytes[16..20].copy_from_slice(&854u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&480u32.to_be_bytes());
        std::fs::write(&path, bytes).expect("write");
        assert_eq!(png_dimensions(&path), "854 × 480");
    }
}
