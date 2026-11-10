//! Liest ein `.cosmiq`-Paket (Container v1) in die Form, die die 3D-Vorschau
//! zeichnet: ein Mesh je Textur, in Blockbench-Pixeln und Fußraum.
//!
//! Der Container ist kein ZIP: Magic `COSMIQCP`, ein Versionsbyte, zwei
//! Big-Endian-Längen, dann Manifest-JSON und bbmodel-JSON — genau in dieser
//! Reihenfolge und ohne Füllbytes.

use serde_json::{json, Map, Value};

const MAGIC: &[u8] = b"COSMIQCP";
const HEADER_BYTES: usize = 17;
const MAX_MANIFEST_BYTES: u32 = 65_536;
const MAX_BBMODEL_BYTES: u32 = 5 * 1024 * 1024;
const FACE_NAMES: [&str; 6] = ["north", "south", "east", "west", "up", "down"];

pub struct Package {
    pub manifest: Value,
    pub bbmodel: Value,
}

/// Prüft Header und Längen und zerlegt das Paket in seine beiden JSON-Dokumente.
pub fn read_package(bytes: &[u8]) -> Result<Package, String> {
    if bytes.len() < HEADER_BYTES || &bytes[..MAGIC.len()] != MAGIC {
        return Err("Die Datei ist kein Cosmiq-Paket.".to_string());
    }
    if bytes[8] != 1 {
        return Err(format!("Unbekannte Cosmiq-Container-Version {}.", bytes[8]));
    }
    let manifest_len = u32::from_be_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]);
    let bbmodel_len = u32::from_be_bytes([bytes[13], bytes[14], bytes[15], bytes[16]]);
    if !(2..=MAX_MANIFEST_BYTES).contains(&manifest_len)
        || !(2..=MAX_BBMODEL_BYTES).contains(&bbmodel_len)
        || HEADER_BYTES + manifest_len as usize + bbmodel_len as usize != bytes.len()
    {
        return Err("Das Cosmiq-Paket hat unplausible Längen.".to_string());
    }
    let split = HEADER_BYTES + manifest_len as usize;
    let manifest: Value = serde_json::from_slice(&bytes[HEADER_BYTES..split])
        .map_err(|error| format!("Paket-Manifest nicht lesbar: {error}"))?;
    let bbmodel: Value = serde_json::from_slice(&bytes[split..])
        .map_err(|error| format!("Paket-Modell nicht lesbar: {error}"))?;
    Ok(Package { manifest, bbmodel })
}

/// Alles, was die Vorschau braucht. `fallback_id` greift, wenn das Manifest
/// keine `projectId` nennt (handgebaute Pakete).
pub fn preview(package: &Package, fallback_id: &str) -> Result<Value, String> {
    let manifest = &package.manifest;
    let bbmodel = &package.bbmodel;
    let id = text(manifest, "projectId").unwrap_or(fallback_id);
    let name = text(manifest, "displayName")
        .or_else(|| text(bbmodel, "name"))
        .unwrap_or(id);

    let mut slots = slot_list(manifest);
    if slots.is_empty() {
        slots = bbmodel
            .get("cosmiq")
            .and_then(|cosmiq| cosmiq.get("cosmetic"))
            .map(slot_list)
            .unwrap_or_default();
    }
    if slots.is_empty() {
        slots.push("back".to_string());
    }
    let rarity = bbmodel
        .get("cosmiq")
        .and_then(|cosmiq| cosmiq.get("bamboo"))
        .and_then(|bamboo| text(bamboo, "rarity"))
        .unwrap_or("Common");

    let (parts, faces) = parts(bbmodel);
    if parts.is_empty() {
        return Err("Das Paket enthält keine eingebettete Textur.".to_string());
    }

    Ok(json!({
        "id": id,
        "name": name,
        "creator": text(manifest, "creatorName").unwrap_or("Bamboo Launcher"),
        "description": text(manifest, "description").unwrap_or(""),
        "rarity": rarity,
        "slots": slots,
        "faces": faces,
        "parts": parts,
    }))
}

/// Ein Teil je eingebetteter Textur; `faces` zählt weltweit für die Statistik.
fn parts(bbmodel: &Value) -> (Vec<Value>, u64) {
    let (Some(textures), Some(elements)) = (
        bbmodel.get("textures").and_then(Value::as_array),
        bbmodel.get("elements").and_then(Value::as_array),
    ) else {
        return (Vec::new(), 0);
    };
    let mut parts = Vec::new();
    let mut total_faces = 0_u64;

    for (index, texture) in textures.iter().enumerate() {
        let Some(texture_url) = texture
            .get("source")
            .and_then(Value::as_str)
            .filter(|source| source.starts_with("data:image/"))
        else {
            continue;
        };
        let width = number(texture, "width").unwrap_or(16.0);
        let height = number(texture, "height").unwrap_or(16.0);
        // Blockbench speichert UVs im Raster der Modellauflösung, das Mesh
        // braucht Atlas-Pixel.
        let scale_x = width / number(texture, "uv_width").unwrap_or(16.0).max(1.0);
        let scale_y = height / number(texture, "uv_height").unwrap_or(16.0).max(1.0);

        let mut cubes = Vec::new();
        let mut faces = 0_u64;
        for element in elements {
            if let Some((cube, count)) = cube(element, index, scale_x, scale_y) {
                faces += count;
                cubes.push(cube);
            }
        }
        if cubes.is_empty() {
            continue;
        }
        total_faces += faces;
        parts.push(json!({
            "texture": texture_url,
            "textureWidth": width.round() as u64,
            "textureHeight": height.round() as u64,
            "cubes": cubes,
        }));
    }

    (parts, total_faces)
}

/// Ein bbmodel-Element als Bedrock-Cube, nur mit den Flächen dieser Textur.
fn cube(element: &Value, texture: usize, scale_x: f64, scale_y: f64) -> Option<(Value, u64)> {
    let from = vec3(element.get("from")?)?;
    let to = vec3(element.get("to")?)?;
    // Blockbench nennt den Rotationsanker `origin`.
    let pivot = element.get("origin").and_then(vec3).unwrap_or(from);
    let rotation = element.get("rotation").and_then(vec3).unwrap_or([0.0; 3]);

    let mut faces = Map::new();
    let mut count = 0_u64;
    for name in FACE_NAMES {
        let Some(face) = element.get("faces").and_then(|faces| faces.get(name)) else {
            continue;
        };
        // Der Exporter schreibt ganze Zahlen als Double (`0.0`).
        if face.get("texture").and_then(Value::as_f64) != Some(texture as f64) {
            continue;
        }
        let Some(uv) = face
            .get("uv")
            .and_then(Value::as_array)
            .filter(|uv| uv.len() == 4)
            .and_then(|uv| {
                Some([
                    uv[0].as_f64()?,
                    uv[1].as_f64()?,
                    uv[2].as_f64()?,
                    uv[3].as_f64()?,
                ])
            })
        else {
            continue;
        };
        let mut entry = json!({
            "uv": [uv[0].min(uv[2]) * scale_x, uv[1].min(uv[3]) * scale_y],
            "uv_size": [(uv[2] - uv[0]) * scale_x, (uv[3] - uv[1]) * scale_y],
        });
        if let Some(rotation) = face
            .get("rotation")
            .and_then(Value::as_f64)
            .filter(|r| *r != 0.0)
        {
            entry["uv_rotation"] = json!(rotation);
        }
        faces.insert(name.to_string(), entry);
        count += 1;
    }
    if count == 0 {
        return None;
    }

    Some((
        json!({
            "origin": from,
            "size": [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
            "pivot": pivot,
            "rotation": rotation,
            "uv": Value::Object(faces),
        }),
        count,
    ))
}

/// `cosmiq:slot/head` und Verwandte auf die Slots der Oberfläche abbilden.
fn slot_list(value: &Value) -> Vec<String> {
    let Some(entries) = value.get("bodySlots").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut slots: Vec<String> = Vec::new();
    for raw in entries.iter().filter_map(Value::as_str) {
        let slot = match raw.trim().trim_start_matches("cosmiq:slot/") {
            "head" | "hat" => "head",
            "cape" => "cape",
            "back" => "back",
            _ => continue,
        };
        if !slots.iter().any(|existing| existing == slot) {
            slots.push(slot.to_string());
        }
    }
    slots
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn vec3(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array().filter(|array| array.len() == 3)?;
    Some([array[0].as_f64()?, array[1].as_f64()?, array[2].as_f64()?])
}
