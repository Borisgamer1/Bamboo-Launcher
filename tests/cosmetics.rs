//! Vorschau-Parser gegen die echten Shop-Pakete, die im Repo liegen.

use bamboo_launcher::cosmetics;
use serde_json::Value;
use std::path::PathBuf;

fn package(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("BambooCosmetics/packages")
        .join(name);
    std::fs::read(path).expect("Paket im Repo")
}

fn preview(name: &str) -> Value {
    let bytes = package(name);
    let package = cosmetics::read_package(&bytes).expect("Container");
    cosmetics::preview(&package, name).expect("Vorschau")
}

fn close(value: &Value, expected: f64) -> bool {
    value.as_f64().is_some_and(|value| (value - expected).abs() < 1e-3)
}

#[test]
fn bird_cape_liefert_ein_mesh_mit_atlas_uvs() {
    let preview = preview("bird-cape.cosmiq");
    assert_eq!(preview["name"], "Bird Cape");
    assert_eq!(preview["creator"], "Bamboo Launcher");
    assert_eq!(preview["rarity"], "Legendary");
    assert_eq!(preview["slots"], serde_json::json!(["back"]));
    assert_eq!(preview["faces"], 6);

    let parts = preview["parts"].as_array().expect("parts");
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["textureWidth"], 256);
    assert_eq!(parts[0]["textureHeight"], 256);
    assert!(parts[0]["texture"]
        .as_str()
        .is_some_and(|url| url.starts_with("data:image/png;base64,")));

    let cubes = parts[0]["cubes"].as_array().expect("cubes");
    assert_eq!(cubes.len(), 1);
    let cube = &cubes[0];
    assert!(close(&cube["origin"][0], -5.0));
    assert!(close(&cube["origin"][1], 7.92));
    assert!(close(&cube["size"][0], 10.0));
    assert!(close(&cube["size"][1], 16.0));
    assert!(close(&cube["size"][2], 0.5));
    assert_eq!(cube["rotation"], serde_json::json!([-4.0, 0.0, 0.0]));

    // Cape-Fläche: 10x16 UV-Einheiten bei 256er Textur = 160x256 Atlas-Pixel.
    let south = &cube["uv"]["south"];
    assert_eq!(south["uv"], serde_json::json!([0.0, 0.0]));
    assert_eq!(south["uv_size"], serde_json::json!([160.0, 256.0]));
}

#[test]
fn kopf_cosmetic_nutzt_den_kopf_slot() {
    let preview = preview("furry-ears.cosmiq");
    assert_eq!(preview["slots"], serde_json::json!(["head"]));
    let cubes = preview["parts"][0]["cubes"].as_array().expect("cubes");
    assert_eq!(cubes.len(), 140);
    // 512er Textur auf 16 UV-Einheiten skaliert, deshalb 32 Pixel je Einheit.
    let north = &cubes[0]["uv"]["north"];
    let width = north["uv_size"][0].as_f64().expect("uv_size");
    let raw = 5.188 - 3.3348;
    assert!((width - raw * 32.0).abs() < 0.05, "uv_size war {width}");
}

#[test]
fn paket_mit_256er_uv_raster_bleibt_unskaliert() {
    let preview = preview("wagasa.cosmiq");
    assert_eq!(preview["parts"][0]["textureWidth"], 256);
    let cubes = preview["parts"][0]["cubes"].as_array().expect("cubes");
    let up = &cubes[0]["uv"]["up"];
    assert_eq!(up["uv"], serde_json::json!([160.0, 32.0]));
    assert_eq!(up["uv_size"], serde_json::json!([32.0, 32.0]));
}

#[test]
fn abgeschnittenes_paket_wird_abgelehnt() {
    let mut bytes = package("bird-cape.cosmiq");
    bytes.truncate(bytes.len() - 40);
    assert!(cosmetics::read_package(&bytes).is_err());

    let beheaded = package("bird-cape.cosmiq");
    assert!(cosmetics::read_package(&beheaded[4..]).is_err());
}
