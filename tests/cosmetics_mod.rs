//! Die Cosmetics-Mod gehört in jede passende Instanz – und nur dorthin.

use bamboo_launcher::instances::sync_cosmetics_mod;

const MOD_FILE: &str = "bamboo-cosmetics-26.3-fabric.jar";

#[test]
fn the_bundled_cosmetics_mod_follows_the_instance() {
    let root = tempfile::tempdir().unwrap();
    let instance = root.path().join("instance");
    std::fs::create_dir_all(&instance).unwrap();
    let target = instance.join("mods").join(MOD_FILE);

    assert!(sync_cosmetics_mod(&instance, true));
    assert!(target.is_file());
    // Zweiter Lauf schreibt nichts neu.
    assert!(!sync_cosmetics_mod(&instance, true));

    // Eine eigene Fassung der Mod gewinnt: nichts wird daneben gelegt.
    std::fs::write(instance.join("mods").join("cosmiq-0.4.0.jar"), b"eigene").unwrap();
    assert!(!sync_cosmetics_mod(&instance, true));

    // Ausschalten nimmt nur die unveränderte Launcher-Kopie zurück.
    assert!(sync_cosmetics_mod(&instance, false));
    assert!(!target.exists());
    assert!(instance.join("mods").join("cosmiq-0.4.0.jar").is_file());
}

#[test]
fn a_modified_launcher_copy_is_left_alone() {
    let root = tempfile::tempdir().unwrap();
    let instance = root.path().join("instance");
    std::fs::create_dir_all(&instance).unwrap();
    let target = instance.join("mods").join(MOD_FILE);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"getauscht").unwrap();

    assert!(!sync_cosmetics_mod(&instance, false));
    assert!(target.is_file());
}
