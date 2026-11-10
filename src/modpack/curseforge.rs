//! CurseForge-Modpacks (`manifest.json`).
//!
//! Ein CurseForge-Pack ist ein ZIP mit `manifest.json`, `overrides/` und den
//! Override-Dateien. Anders als ein `.mrpack` enthält das Manifest **keine**
//! Download-Adressen: es nennt nur `projectID` und `fileID`. Jede Datei muss
//! deshalb einzeln über die CurseForge-API aufgelöst werden – inklusive der
//! Frage, ob der Autor Fremd-Downloads erlaubt. Ohne API-Key lässt sich ein
//! solches Pack nicht installieren, und das sagt der Import auch klar.
//!
//! `files` enthält ausschließlich Mods; sie landen in `mods/`. Ressourcen- und
//! Shader-Packs kommen wie bei Modrinth über die Overrides.

use super::{LoaderDependency, ModpackError, Result};
use crate::mods::curseforge::CurseForgeClient;
use crate::mods::{validate_mod_file_name, Loader, ModError, ModProvider};
use serde::Deserialize;
use std::path::PathBuf;

pub const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_TYPE: &str = "minecraftModpack";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub manifest_type: String,
    #[serde(default)]
    pub manifest_version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub minecraft: Minecraft,
    #[serde(default)]
    pub files: Vec<FileRef>,
    /// Name des Override-Ordners; Packs dürfen ihn frei wählen.
    #[serde(default)]
    pub overrides: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Minecraft {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mod_loaders: Vec<ModLoader>,
}

#[derive(Debug, Deserialize)]
pub struct ModLoader {
    pub id: String,
    #[serde(default)]
    pub primary: bool,
}

/// `required` wird bewusst nicht ausgewertet: Ohne Auswahl in der Oberfläche
/// wäre ein Pack, dem die optionalen Mods fehlen, schlechter dran als eines,
/// das sie mitbringt – CurseForge liefert sie im selben Manifest mit.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    #[serde(rename = "projectID")]
    pub project_id: u64,
    #[serde(rename = "fileID")]
    pub file_id: u64,
}

impl Manifest {
    /// Liest und prüft das Manifest. `None` heißt: Das JSON ist kein
    /// CurseForge-Manifest (dann entscheidet der Aufrufer, was zu tun ist).
    pub fn parse(text: &str) -> Option<Result<Self>> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        if !value
            .get("manifestType")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| kind.trim().eq_ignore_ascii_case(MANIFEST_TYPE))
        {
            return None;
        }
        Some(serde_json::from_value::<Self>(value).map_err(|error| {
            ModpackError::InvalidManifest(format!("Das Manifest ist unlesbar: {error}"))
        }))
    }

    /// Prüft alles, was ohne Netz entscheidbar ist.
    pub fn validate(mut self) -> Result<Self> {
        if self.manifest_version > 1 {
            return Err(ModpackError::UnsupportedFormat(self.manifest_version));
        }
        if self.minecraft.version.trim().is_empty() {
            return Err(ModpackError::MissingMinecraftVersion);
        }
        if self.name.trim().is_empty() {
            self.name = "Modpack".to_string();
        }
        Ok(self)
    }
}

/// Kurzfassung für die Import-Vorschau – ohne Netz und ohne Download.
#[derive(Debug, Clone)]
pub struct Summary {
    pub name: String,
    pub version: String,
    pub author: String,
    pub minecraft: String,
    /// Leer bei Vanilla, sonst `fabric`, `forge`, `neoforge` oder `quilt`.
    pub loader: String,
    pub loader_version: String,
    pub files: usize,
}

/// Erkennt ein CurseForge-Manifest und fasst es für die Vorschau zusammen.
pub fn summarize(text: &str) -> Option<Summary> {
    let manifest = Manifest::parse(text)?.ok()?;
    // Ein unbekannter Loader darf die Vorschau nicht verschlucken: Das Pack
    // bleibt ein Modpack, der Import meldet den Fehler.
    let loader = detect_loader(&manifest.minecraft.mod_loaders, &manifest.minecraft.version)
        .ok()
        .flatten();
    Some(Summary {
        name: manifest.name.trim().to_string(),
        version: manifest.version.clone(),
        author: manifest.author.clone(),
        minecraft: manifest.minecraft.version.trim().to_string(),
        loader: loader
            .as_ref()
            .map(|dependency| dependency.loader.modrinth_name().to_string())
            .unwrap_or_default(),
        loader_version: loader
            .map(|dependency| dependency.version)
            .unwrap_or_default(),
        files: manifest.files.len(),
    })
}

/// Wählt den primären Loader. Ohne `primary`-Markierung ist nur ein einzelner
/// Eintrag eindeutig.
pub(crate) fn detect_loader(
    loaders: &[ModLoader],
    minecraft: &str,
) -> Result<Option<LoaderDependency>> {
    let chosen = loaders
        .iter()
        .find(|loader| loader.primary)
        .or_else(|| (loaders.len() == 1).then(|| &loaders[0]));
    let Some(chosen) = chosen else {
        if loaders.is_empty() {
            return Ok(None);
        }
        let names = loaders
            .iter()
            .map(|loader| loader.id.clone())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(ModpackError::MultipleLoaders(names));
    };
    parse_loader_id(&chosen.id, minecraft)
}

/// Zerlegt eine Loader-ID wie `forge-47.2.0` in Loader und Version.
///
/// Manche Packs hängen die Minecraft-Version noch an: `forge-1.20.1-47.2.0`.
/// Diese Form wird genauso verstanden wie die kurze.
fn parse_loader_id(id: &str, minecraft: &str) -> Result<Option<LoaderDependency>> {
    let id = id.trim();
    let Some((prefix, rest)) = id.split_once('-') else {
        return Err(ModpackError::InvalidManifest(format!(
            "'{id}' sieht nicht wie eine Loader-ID aus."
        )));
    };
    let prefix = prefix.trim().to_ascii_lowercase();
    let loader = match prefix.as_str() {
        "forge" => Loader::Forge,
        "neoforge" => Loader::NeoForge,
        "fabric" => Loader::Fabric,
        "quilt" => Loader::Quilt,
        other => return Err(ModpackError::UnsupportedLoader(other.to_string())),
    };
    let rest = rest.trim();
    let minecraft = minecraft.trim();
    let version = match rest.strip_prefix(minecraft) {
        Some(tail) if !minecraft.is_empty() && tail.starts_with('-') => {
            tail.trim_start_matches('-')
        }
        _ => rest,
    };
    if version.is_empty() {
        return Err(ModpackError::InvalidManifest(format!(
            "'{id}' enthält keine Loader-Version."
        )));
    }
    Ok(Some(LoaderDependency {
        loader,
        version: version.to_string(),
    }))
}

/// Eine aufgelöste Pack-Datei samt Zielpfad und Bestandsdaten.
pub struct ResolvedFile {
    pub relative: PathBuf,
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub project_id: String,
    pub file_id: String,
    pub version_number: String,
}

/// Löst alle Mods des Manifests nacheinander über die API auf.
///
/// Bewusst sequenziell: 200 Mods bedeuten hier 400 Anfragen, und CurseForge
/// drosselt pro Key. Ein einzelner Fehler bricht ab – eine halb installierte
/// Instanz wäre schlimmer als ein klarer Abbruch.
pub async fn resolve(client: &CurseForgeClient, files: &[FileRef]) -> Result<Vec<ResolvedFile>> {
    let mut resolved = Vec::with_capacity(files.len());
    for file in files {
        if file.project_id == 0 || file.file_id == 0 {
            return Err(ModpackError::InvalidManifest(
                "Das Manifest enthält eine Datei ohne Projekt- oder Datei-ID.".to_string(),
            ));
        }
        let project = file.project_id.to_string();
        let file_id = file.file_id.to_string();
        let version = client
            .version(&project, &file_id)
            .await
            .map_err(|error| wrap(error, file))?;
        let name =
            validate_mod_file_name(&version.file.file_name).map_err(|error| match error {
                // Ein Archiv im Mod-Ordner wäre nutzlos, aber kein Angriff.
                ModError::NotAJar(invalid) => {
                    ModpackError::InvalidManifest(format!("'{invalid}' ist keine .jar-Datei."))
                }
                _ => ModpackError::UnsafePath(format!("mods/{}", version.file.file_name)),
            })?;
        let download = client
            .download(&version)
            .await
            .map_err(|error| wrap(error, file))?;
        resolved.push(ResolvedFile {
            relative: PathBuf::from("mods").join(name),
            url: download.url,
            sha1: download.sha1,
            size: download.size,
            project_id: file.project_id.to_string(),
            file_id: file.file_id.to_string(),
            version_number: if version.version_number.trim().is_empty() {
                version.name.clone()
            } else {
                version.version_number.clone()
            },
        });
    }
    Ok(resolved)
}

fn wrap(error: ModError, file: &FileRef) -> ModpackError {
    match error {
        ModError::MissingApiKey => ModpackError::MissingCurseForgeKey,
        other => ModpackError::CurseForgeFile {
            project_id: file.project_id,
            file_id: file.file_id,
            message: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loader(id: &str, primary: bool) -> ModLoader {
        ModLoader {
            id: id.to_string(),
            primary,
        }
    }

    fn manifest(loaders: &str) -> String {
        format!(
            r#"{{"manifestType":"minecraftModpack","manifestVersion":1,"name":"Test","version":"2.0","minecraft":{{"version":"1.20.1","modLoaders":{loaders}}},"files":[{{"projectID":238222,"fileID":4610000,"required":true}}]}}"#
        )
    }

    #[test]
    fn parses_a_manifest_and_its_files() {
        let parsed = Manifest::parse(&manifest(r#"[{"id":"fabric-0.16.10","primary":true}]"#))
            .expect("CurseForge-Manifest")
            .expect("lesbar");
        assert_eq!(parsed.name, "Test");
        assert_eq!(parsed.minecraft.version, "1.20.1");
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].project_id, 238222);
        assert_eq!(parsed.files[0].file_id, 4610000);
    }

    #[test]
    fn rejects_other_json_documents() {
        assert!(Manifest::parse(r#"{"name":"kein Modpack"}"#).is_none());
        assert!(Manifest::parse("kein JSON").is_none());
        let broken = r#"{"manifestType":"minecraftModpack","files":"nein"}"#;
        assert!(matches!(
            Manifest::parse(broken),
            Some(Err(ModpackError::InvalidManifest(_)))
        ));
    }

    #[test]
    fn detects_every_supported_loader() {
        let cases = [
            ("forge-47.2.0", Loader::Forge, "47.2.0"),
            ("neoforge-21.1.9", Loader::NeoForge, "21.1.9"),
            ("fabric-0.16.10", Loader::Fabric, "0.16.10"),
        ];
        for (id, expected_loader, expected_version) in cases {
            let detected = detect_loader(&[loader(id, true)], "1.20.1")
                .unwrap()
                .expect("Loader");
            assert_eq!(detected.loader, expected_loader);
            assert_eq!(detected.version, expected_version);
        }
    }

    #[test]
    fn strips_the_minecraft_prefix_from_forge_versions() {
        let detected = detect_loader(&[loader("forge-1.20.1-47.2.0", true)], "1.20.1")
            .unwrap()
            .expect("Loader");
        assert_eq!(detected.version, "47.2.0");
    }

    #[test]
    fn picks_the_primary_loader_and_rejects_ambiguity() {
        let detected = detect_loader(
            &[
                loader("forge-47.2.0", false),
                loader("fabric-0.16.10", true),
            ],
            "1.20.1",
        )
        .unwrap()
        .expect("Loader");
        assert_eq!(detected.loader, Loader::Fabric);

        assert!(matches!(
            detect_loader(
                &[
                    loader("forge-47.2.0", false),
                    loader("fabric-0.16.10", false)
                ],
                "1.20.1"
            ),
            Err(ModpackError::MultipleLoaders(_))
        ));
        assert!(detect_loader(&[], "1.20.1").unwrap().is_none());
    }

    #[test]
    fn accepts_quilt_and_rejects_unknown_loaders() {
        let detected = detect_loader(&[loader("quilt-0.23.1", true)], "1.20.1")
            .unwrap()
            .expect("Loader");
        assert_eq!(detected.loader, Loader::Quilt);
        assert_eq!(detected.version, "0.23.1");
        assert!(matches!(
            detect_loader(&[loader("rift-1.0", true)], "1.20.1"),
            Err(ModpackError::UnsupportedLoader(_))
        ));
        assert!(matches!(
            detect_loader(&[loader("forge", true)], "1.20.1"),
            Err(ModpackError::InvalidManifest(_))
        ));
    }

    #[test]
    fn validate_requires_a_minecraft_version() {
        let broken = Manifest::parse(
            r#"{"manifestType":"minecraftModpack","manifestVersion":1,"name":"X","minecraft":{"version":" "},"files":[]}"#,
        )
        .unwrap()
        .unwrap();
        assert!(matches!(
            broken.validate(),
            Err(ModpackError::MissingMinecraftVersion)
        ));
    }

    #[test]
    fn summarizes_for_the_preview() {
        let summary =
            summarize(&manifest(r#"[{"id":"forge-47.2.0","primary":true}]"#)).expect("Vorschau");
        assert_eq!(summary.name, "Test");
        assert_eq!(summary.minecraft, "1.20.1");
        assert_eq!(summary.loader, "forge");
        assert_eq!(summary.loader_version, "47.2.0");
        assert_eq!(summary.files, 1);

        let quilt = summarize(&manifest(r#"[{"id":"quilt-0.23.1","primary":true}]"#))
            .expect("Quilt-Vorschau");
        assert_eq!(quilt.loader, "quilt");
        assert_eq!(quilt.loader_version, "0.23.1");
    }
}
