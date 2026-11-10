//! Instanzen aus Prism/MultiMC, der CurseForge App und der Modrinth App
//! übernehmen. Die Inhalte werden kopiert, Versionen und Loader installiert
//! Bamboo selbst – fremde Versionen, Libraries und Assets bleiben unangetastet.

use std::path::PathBuf;

use bamboo_launcher::backup::{BackupManager, DEFAULT_KEEP};
use bamboo_launcher::config;
use bamboo_launcher::foreign_instance::{ContentSelection, ExternalInstance, ExternalSource};
use bamboo_launcher::instances::validate_instance_name;
use bamboo_launcher::loader::LoaderInstaller;
use serde_json::{json, Value};

use crate::ipc;

fn source_slug(source: ExternalSource) -> &'static str {
    match source {
        ExternalSource::Prism => "prism",
        ExternalSource::CurseForgeApp => "curseforge",
        ExternalSource::ModrinthApp => "modrinth",
    }
}

/// Wählt die Ordner, die kopiert werden sollen. Ohne Angabe bleibt das
/// Standardpaket aktiv; Screenshots sind standardmäßig aus.
fn selection_from(data: &Value) -> ContentSelection {
    let flag =
        |name: &str, default: bool| data.get(name).and_then(Value::as_bool).unwrap_or(default);
    ContentSelection {
        mods: flag("installMods", true),
        resourcepacks: flag("installResourcepacks", true),
        shaderpacks: flag("installShaderpacks", true),
        datapacks: flag("installDatapacks", true),
        worlds: flag("installWorlds", true),
        config: flag("installConfig", true),
        screenshots: flag("installScreenshots", false),
    }
}

#[tauri::command]
pub async fn external_instance_preview(directory: String) -> Value {
    let directory = PathBuf::from(directory);
    let instance = match ExternalInstance::detect(&directory) {
        Ok(instance) => instance,
        Err(error) => {
            return json!({"success": false, "code": "not-an-instance", "error": error.to_string()})
        }
    };

    json!({
        "success": true,
        "source": source_slug(instance.source),
        "sourceLabel": instance.source.label(),
        "name": instance.name,
        "minecraftVersion": instance.minecraft_version,
        "loader": instance.loader.map(|loader| loader.modrinth_name()),
        "loaderVersion": instance.loader_version,
        "iconPath": instance.icon.as_ref().map(|path| path.to_string_lossy()),
        "gameDir": instance.game_dir.to_string_lossy(),
        "counts": instance.counts,
    })
}

#[tauri::command]
pub async fn import_external_instance(data: Value) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let Some(directory) = data.get("directory").and_then(Value::as_str) else {
        return json!({"success": false, "code": "INVALID", "error": "Kein Ordner angegeben."});
    };
    let instance = match ExternalInstance::detect(&PathBuf::from(directory)) {
        Ok(instance) => instance,
        Err(error) => {
            return json!({"success": false, "code": "not-an-instance", "error": error.to_string()})
        }
    };

    let folder = data
        .get("targetInstanceName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&instance.name)
        .to_string();
    if let Err(error) = validate_instance_name(&folder) {
        return json!({"success": false, "code": "invalid-name", "error": error.to_string()});
    }

    let merge = data
        .get("mergeIntoExisting")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let manager = ipc::manager(&root);

    let target = if merge {
        // Mergen heißt: nur fehlende Inhalte ergänzen. Version und Loader der
        // bestehenden Instanz bleiben, damit ein fremdes Pack sie nicht
        // unbemerkt umstellt.
        match manager.load(&folder) {
            Ok(instance) => instance,
            Err(_) => {
                return json!({
                    "success": false,
                    "code": "not-found",
                    "error": format!("'{folder}' wurde nicht gefunden."),
                })
            }
        }
    } else {
        if manager
            .instance_dir(&folder)
            .map(|dir| dir.exists())
            .unwrap_or(false)
        {
            return json!({"success": false, "code": "exists", "error": format!("'{folder}' existiert bereits.")});
        }

        // Der Loader wird aus den Metadaten der Fremdinstanz übernommen. Schlägt
        // das fehl, entsteht keine halbe Instanz: Der Nutzer bekommt den Fehler
        // statt einer Vanilla-Instanz, die er nie wollte.
        let mut version_id = instance.minecraft_version.clone();
        if let Some(loader) = instance.loader {
            let pinned = Some(instance.loader_version.as_str()).filter(|value| !value.is_empty());
            match LoaderInstaller::new(config::default_cache_dir())
                .install(&root, &instance.minecraft_version, loader, pinned)
                .await
            {
                Ok(installed) => version_id = installed.version_id,
                Err(error) => {
                    return json!({
                        "success": false,
                        "code": "loader-unsupported",
                        "error": format!("{} ließ sich nicht installieren: {error}", loader.label()),
                    })
                }
            }
        }

        match manager.create(&folder, Some(&version_id)) {
            Ok(instance) => instance,
            Err(error) => {
                return json!({"success": false, "code": "create-failed", "error": error.to_string()})
            }
        }
    };

    // Ein Merge überschreibt Configs und Welten der vorhandenen Instanz.
    let backup = if merge {
        match BackupManager::new(&target.dir).create("Vor Import", DEFAULT_KEEP) {
            Ok(entry) => entry,
            Err(error) => {
                return json!({
                    "success": false,
                    "code": "backup-failed",
                    "error": format!("Sicherung fehlgeschlagen: {error}")
                })
            }
        }
    } else {
        None
    };

    let report = match instance.copy_content(&target.dir, selection_from(&data)) {
        Ok(report) => report,
        Err(error) => {
            // Nichts Halbes zurücklassen, wenn schon der erste Ordner scheitert.
            // Eine bestehende Instanz wird dabei nie gelöscht.
            if !merge {
                let _ = manager.remove(&target.name);
            }
            return json!({"success": false, "code": "copy-failed", "error": error.to_string()});
        }
    };

    // Ein Pack-Bild ist das einzige, was die Fremdinstanz an Optik mitbringt.
    // Beim Merge bleibt ein vorhandenes Cover unangetastet.
    if !merge {
        if let Some(icon) = &instance.icon {
            let _ = std::fs::copy(icon, target.dir.join("icon.png"));
        }
    }

    // Vorhandene Dateien sind beim Merge kein Fehler und gehören deshalb nicht
    // in die Warnungsliste; die Oberfläche nennt die Zahl separat.
    let warnings = if report.skipped > 0 {
        vec![format!(
            "{} Datei(en) konnten nicht kopiert werden (gesperrt oder Verknüpfung).",
            report.skipped
        )]
    } else {
        Vec::new()
    };

    json!({
        "success": true,
        "instanceName": target.name,
        "merged": merge,
        "source": source_slug(instance.source),
        "sourceLabel": instance.source.label(),
        "profile": ipc::instance_profile(&root, &target),
        "modsInstalled": report.counts.mods,
        "resourcepacksInstalled": report.counts.resourcepacks,
        "shaderpacksInstalled": report.counts.shaderpacks,
        "datapacksInstalled": report.counts.datapacks,
        "worldsImported": report.counts.worlds,
        "filesCopied": report.counts.files,
        "existingFiles": report.existing,
        "bytesCopied": report.counts.bytes,
        "warnings": warnings,
        "backup": backup,
    })
}
