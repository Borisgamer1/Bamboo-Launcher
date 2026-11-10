//! Modpack-Import gegen einen lokalen Mock-Server: Dateien, Overrides,
//! Pfadschutz, Loader-Bindung und Bestandsdatei.

use bamboo_launcher::download::{sha1_hex, Downloader};
use bamboo_launcher::install::Installer;
use bamboo_launcher::instances::InstanceManager;
use bamboo_launcher::modpack::{ModpackError, ModpackImporter};
use bamboo_launcher::mods::{Loader, ModLedger, ModRecord, ModSource};
use bamboo_launcher::version::PlatformInfo;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use zip::write::SimpleFileOptions;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

const CLIENT_JAR: &[u8] = b"client-jar";
const VANILLA_LIB: &[u8] = b"vanilla-lib";
const FABRIC_LIB: &[u8] = b"fabric-loader";
const PACK_MOD: &[u8] = b"pack-mod-bytes";

// ---------------------------------------------------------------------------
// Mock-Server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Response {
    status: u16,
    body: Vec<u8>,
}

fn ok(body: Vec<u8>) -> Response {
    Response { status: 200, body }
}

fn not_found() -> Response {
    Response {
        status: 404,
        body: Vec::new(),
    }
}

struct Mock {
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
    handle: JoinHandle<()>,
}

impl Mock {
    fn paths(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn start_mock<F>(route: F) -> Mock
where
    F: Fn(&str) -> Response + Send + Sync + 'static,
{
    start_mock_routed(move |_, path| route(path)).await
}

/// Wie [`start_mock`], aber der Router sieht auch die Basis-URL des Servers.
/// Nötig, wenn eine Antwort auf den Mock selbst verweisen soll – etwa der
/// Download-Link aus CurseForge.
async fn start_mock_routed<F>(route: F) -> Mock
where
    F: Fn(&str, &str) -> Response + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    let route = Arc::new(route);
    let route_base = base.clone();

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let recorded = Arc::clone(&recorded);
            let route = Arc::clone(&route);
            let route_base = route_base.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match socket.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(read) => {
                            data.extend_from_slice(&chunk[..read]);
                            if data.windows(4).any(|window| window == b"\r\n\r\n")
                                || data.len() > 65536
                            {
                                break;
                            }
                        }
                        Err(_) => return,
                    }
                }
                let text = String::from_utf8_lossy(&data);
                let target = text
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                recorded.lock().unwrap().push(target.clone());
                let response = route(&route_base, &target);
                let reason = if response.status == 200 {
                    "OK"
                } else {
                    "Not Found"
                };
                let head = format!(
                    "HTTP/1.1 {} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    response.body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&response.body).await;
                let _ = socket.flush().await;
            });
        }
    });

    Mock { base, seen, handle }
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

fn temp_root() -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "bamboo-modpack-test-{}-{}-{id}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn pack_file(base: &str, path: &str, url: &str, body: &[u8]) -> Value {
    json!({
        "path": path,
        "hashes": {"sha1": sha1_hex(body)},
        "downloads": [format!("{base}{url}")],
        "fileSize": body.len(),
        "env": {"client": "required", "server": "unsupported"}
    })
}

fn build_pack(dir: &Path, index: &Value, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join("pack.mrpack");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("modrinth.index.json", options).unwrap();
    zip.write_all(&serde_json::to_vec_pretty(index).unwrap())
        .unwrap();
    for (name, body) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn base_index(name: &str, files: Vec<Value>, dependencies: Value) -> Value {
    json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": name,
        "summary": "Test-Pack",
        "files": files,
        "dependencies": dependencies
    })
}

fn write_base_version(root: &Path, base: &str, minecraft: &str) {
    let directory = root.join("versions").join(minecraft);
    std::fs::create_dir_all(&directory).unwrap();
    let json = json!({
        "id": minecraft,
        "type": "release",
        "mainClass": "net.minecraft.client.main.Main",
        "assets": "5",
        "assetIndex": {
            "id": "5",
            "url": format!("{base}/assets.json"),
            "sha1": sha1_hex(b"{}"),
            "size": 2
        },
        "downloads": {
            "client": {
                "url": format!("{base}/client.jar"),
                "sha1": sha1_hex(CLIENT_JAR),
                "size": CLIENT_JAR.len()
            }
        },
        "javaVersion": {"component": "java-runtime-gamma", "majorVersion": 17},
        "libraries": [{
            "name": "org.example:vanilla:1.0",
            "downloads": {
                "artifact": {
                    "url": format!("{base}/vanilla-lib.jar"),
                    "sha1": sha1_hex(VANILLA_LIB),
                    "size": VANILLA_LIB.len()
                }
            }
        }]
    });
    std::fs::write(
        directory.join(format!("{minecraft}.json")),
        serde_json::to_vec_pretty(&json).unwrap(),
    )
    .unwrap();
    std::fs::write(directory.join(format!("{minecraft}.jar")), CLIENT_JAR).unwrap();
    let library = root.join("libraries/org/example/vanilla/1.0/vanilla-1.0.jar");
    std::fs::create_dir_all(library.parent().unwrap()).unwrap();
    std::fs::write(library, VANILLA_LIB).unwrap();
}

/// Endpunkte für eine vollständige Basisinstallation (Client, Libraries,
/// Assets und Java) – dieselben Schritte, die `cargo run -- install` geht.
fn install_routes(base: &str) -> Vec<(String, Response)> {
    const VERSION: &str = "1.20.1";
    const ASSET: &[u8] = b"asset-bytes";
    const JAVA_EXE: &[u8] = b"java-stub";

    let asset_hash = sha1_hex(ASSET);
    let java_name = if cfg!(windows) { "java.exe" } else { "java" };
    let asset_index = serde_json::to_vec(&json!({
        "objects": {"test.txt": {"hash": asset_hash, "size": ASSET.len()}}
    }))
    .unwrap();
    let version = serde_json::to_vec(&json!({
        "id": VERSION,
        "type": "release",
        "mainClass": "net.minecraft.client.main.Main",
        "assets": "5",
        "assetIndex": {
            "id": "5",
            "url": format!("{base}/assets.json"),
            "sha1": sha1_hex(&asset_index),
            "size": asset_index.len()
        },
        "downloads": {
            "client": {
                "url": format!("{base}/client.jar"),
                "sha1": sha1_hex(CLIENT_JAR),
                "size": CLIENT_JAR.len()
            }
        },
        "javaVersion": {"component": "java-runtime-gamma", "majorVersion": 17},
        "libraries": [{
            "name": "org.example:vanilla:1.0",
            "downloads": {"artifact": {
                "path": "org/example/vanilla/1.0/vanilla-1.0.jar",
                "url": format!("{base}/vanilla-lib.jar"),
                "sha1": sha1_hex(VANILLA_LIB),
                "size": VANILLA_LIB.len()
            }}
        }]
    }))
    .unwrap();
    let manifest = serde_json::to_vec(&json!({
        "versions": [{
            "id": VERSION,
            "url": format!("{base}/versions/{VERSION}.json"),
            "sha1": sha1_hex(&version)
        }]
    }))
    .unwrap();

    let java_key = format!("bin/{java_name}");
    let mut java_files = serde_json::Map::new();
    java_files.insert(
        java_key,
        json!({
            "type": "file",
            "executable": true,
            "downloads": {"raw": {
                "url": format!("{base}/java/bin/{java_name}"),
                "sha1": sha1_hex(JAVA_EXE),
                "size": JAVA_EXE.len()
            }}
        }),
    );
    java_files.insert("conf".to_string(), json!({"type": "directory"}));
    let java_manifest = serde_json::to_vec(&json!({"files": java_files})).unwrap();
    let java_all = serde_json::to_vec(&json!({
        "windows-x64": {
            "java-runtime-gamma": [{
                "version": {"name": "17.0.8"},
                "manifest": {
                    "url": format!("{base}/java/manifest.json"),
                    "sha1": sha1_hex(&java_manifest),
                    "size": java_manifest.len()
                }
            }]
        }
    }))
    .unwrap();

    vec![
        ("/version_manifest_v2.json".to_string(), ok(manifest)),
        (format!("/versions/{VERSION}.json"), ok(version)),
        ("/client.jar".to_string(), ok(CLIENT_JAR.to_vec())),
        ("/vanilla-lib.jar".to_string(), ok(VANILLA_LIB.to_vec())),
        ("/assets.json".to_string(), ok(asset_index)),
        (
            format!("/{}/{}", &asset_hash[..2], asset_hash),
            ok(ASSET.to_vec()),
        ),
        ("/java/all.json".to_string(), ok(java_all)),
        ("/java/manifest.json".to_string(), ok(java_manifest)),
        (format!("/java/bin/{java_name}"), ok(JAVA_EXE.to_vec())),
        ("/pack/mod.jar".to_string(), ok(PACK_MOD.to_vec())),
    ]
}

fn fabric_route(base: &str, path: &str) -> Response {
    match path {
        "/versions/loader/1.20.1" => ok(serde_json::to_vec(&json!([
            {"loader": {"version": "0.16.10", "stable": true}}
        ]))
        .unwrap()),
        "/versions/loader/1.20.1/0.16.10/profile/json" => ok(serde_json::to_vec(&json!({
            "id": "fabric-loader-0.16.10-1.20.1",
            "inheritsFrom": "1.20.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "type": "release",
            "libraries": [{
                "name": "net.fabricmc:fabric-loader:0.16.10",
                "url": format!("{base}/maven/")
            }]
        }))
        .unwrap()),
        "/maven/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar" => {
            ok(FABRIC_LIB.to_vec())
        }
        "/client.jar" => ok(CLIENT_JAR.to_vec()),
        "/vanilla-lib.jar" => ok(VANILLA_LIB.to_vec()),
        "/pack/mod.jar" => ok(PACK_MOD.to_vec()),
        _ => not_found(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn imports_files_and_overrides_into_a_new_instance() {
    let mock = start_mock(|path| match path {
        "/mods/a.jar" => ok(b"mod-a".to_vec()),
        "/config/client.json" => ok(b"{\"value\":1}".to_vec()),
        _ => not_found(),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let mut server_only = pack_file(&mock.base, "mods/server-only.jar", "/mods/server.jar", b"x");
    server_only["env"] = json!({"client": "unsupported", "server": "required"});
    let index = base_index(
        "Test Pack",
        vec![
            pack_file(&mock.base, "mods/a.jar", "/mods/a.jar", b"mod-a"),
            pack_file(
                &mock.base,
                "config/client.json",
                "/config/client.json",
                b"{\"value\":1}",
            ),
            server_only,
        ],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(
        &root,
        &index,
        &[
            ("overrides/config/overrides.json", b"{\"override\":true}"),
            ("client-overrides/options.txt", b"fov:90"),
            ("server-overrides/server.properties", b"motd=nein"),
            ("modrinth.index.json.bak", b"ignorieren"),
        ],
    );

    let report = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, None)
        .await
        .expect("Import");

    assert_eq!(report.instance.name, "Test Pack");
    assert_eq!(report.pack_name, "Test Pack");
    assert_eq!(report.pack_version, "1.0.0");
    assert_eq!(report.version_id, "1.20.1");
    assert!(report.loader.is_none());
    assert!(
        report.base_install.is_none(),
        "eine vorhandene Basisversion darf nicht neu installiert werden"
    );
    assert_eq!(report.files, 2);
    assert_eq!(report.skipped, 1);
    assert_eq!(report.overrides, 2);
    assert!(report.downloaded_bytes > 0);

    let dir = &report.instance.dir;
    assert!(dir.join("mods/a.jar").is_file());
    assert!(dir.join("config/client.json").is_file());
    assert!(!dir.join("mods/server-only.jar").exists());
    assert_eq!(
        std::fs::read(dir.join("config/overrides.json")).unwrap(),
        b"{\"override\":true}"
    );
    assert_eq!(std::fs::read(dir.join("options.txt")).unwrap(), b"fov:90");
    assert!(!dir.join("server.properties").exists());

    let ledger = ModLedger::load(dir).unwrap();
    let pack_record = ledger.pack.expect("Pack-Eintrag");
    assert_eq!(pack_record.name, "Test Pack");
    assert_eq!(pack_record.version_id, "1.0.0");
    assert_eq!(pack_record.source, "pack.mrpack");
    assert_eq!(pack_record.files.len(), 2);
    assert!(pack_record
        .files
        .iter()
        .any(|file| file.path == "mods/a.jar" && file.sha1.is_some()));
    assert!(
        ledger.mods.is_empty(),
        "Mock-URLs sind kein Modrinth-CDN und dürfen keine Projekt-ID erfinden"
    );
    assert!(!mock.paths().iter().any(|path| path.contains("server.jar")));

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn imports_a_fabric_pack_with_the_pinned_loader() {
    let base_holder = Arc::new(Mutex::new(String::new()));
    let holder = Arc::clone(&base_holder);
    let mock = start_mock(move |path| {
        let base = holder.lock().unwrap().clone();
        fabric_route(&base, path)
    })
    .await;
    *base_holder.lock().unwrap() = mock.base.clone();

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let index = base_index(
        "Fabric Pack",
        vec![pack_file(
            &mock.base,
            "mods/mod.jar",
            "/pack/mod.jar",
            PACK_MOD,
        )],
        json!({"minecraft": "1.20.1", "fabric-loader": "0.16.10"}),
    );
    let pack = build_pack(&root, &index, &[]);

    let report = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, Some("Mein Pack"))
        .await
        .expect("Import");

    assert_eq!(report.instance.name, "Mein Pack");
    assert_eq!(report.loader, Some(Loader::Fabric));
    assert_eq!(report.loader_version.as_deref(), Some("0.16.10"));
    assert_eq!(report.version_id, "fabric-loader-0.16.10-1.20.1");
    assert!(report.base_install.is_none());
    assert!(report.instance.dir.join("mods/mod.jar").is_file());
    assert_eq!(
        std::fs::read(report.instance.dir.join("mods/mod.jar")).unwrap(),
        PACK_MOD
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn installs_the_missing_base_version_before_the_pack() {
    let routes = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let lookup = Arc::clone(&routes);
    let mock = start_mock(move |path| {
        lookup
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or_else(not_found)
    })
    .await;
    *routes.lock().unwrap() = install_routes(&mock.base).into_iter().collect();

    let root = temp_root();
    let index = base_index(
        "Frisches Pack",
        vec![pack_file(
            &mock.base,
            "mods/mod.jar",
            "/pack/mod.jar",
            PACK_MOD,
        )],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(&root, &index, &[]);

    let installer = Installer::new(root.join("cache"))
        .with_endpoints(
            vec![format!("{}/version_manifest_v2.json", mock.base)],
            mock.base.clone(),
            format!("{}/java/all.json", mock.base),
        )
        .with_platform(PlatformInfo {
            name: "windows".to_string(),
            arch: "x64".to_string(),
            version: "10.0.19045".to_string(),
        })
        .with_downloader(Downloader::new().with_concurrency(2));

    // Ein ungültiger expliziter Pfad erzwingt den Runtime-Download. Sonst
    // würde ein auf dem Testrechner installiertes Java die Erwartung je nach
    // Umgebung verändern.
    let report = ModpackImporter::new(root.join("cache"))
        .with_installer(installer)
        .with_java_path(Some(root.join("kein-java")))
        .import(&root, &pack, None)
        .await
        .expect("Import");

    let install = report.base_install.as_ref().expect("Basisinstallation");
    assert!(report.system_java.is_none());
    assert!(install.version_json_downloaded);
    assert_eq!(install.assets.as_ref().unwrap().objects, 1);
    assert!(install
        .java
        .as_ref()
        .expect("Java-Runtime")
        .java_path
        .is_file());
    assert!(root.join("versions/1.20.1/1.20.1.json").is_file());
    assert!(root.join("versions/1.20.1/1.20.1.jar").is_file());
    assert!(root
        .join("libraries/org/example/vanilla/1.0/vanilla-1.0.jar")
        .is_file());
    let asset_hash = sha1_hex(b"asset-bytes");
    assert!(root
        .join(format!(
            "assets/objects/{}/{}",
            &asset_hash[..2],
            asset_hash
        ))
        .is_file());
    assert_eq!(report.instance.version_id.as_deref(), Some("1.20.1"));
    assert!(report.instance.dir.join("mods/mod.jar").is_file());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn skips_the_java_runtime_when_system_java_is_suitable() {
    // Ohne Java auf dem Rechner gibt es nichts zu überspringen. Der Test prüft
    // dann nur die normale Installation und wird übersprungen.
    let Some(system_java) = bamboo_launcher::java::find_java(None, 17).await.ok() else {
        eprintln!("Kein System-Java ab 17 gefunden – Test wird übersprungen.");
        return;
    };

    let routes = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let lookup = Arc::clone(&routes);
    let mock = start_mock(move |path| {
        lookup
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or_else(not_found)
    })
    .await;
    *routes.lock().unwrap() = install_routes(&mock.base).into_iter().collect();

    let root = temp_root();
    let index = base_index(
        "System-Java-Pack",
        vec![pack_file(
            &mock.base,
            "mods/mod.jar",
            "/pack/mod.jar",
            PACK_MOD,
        )],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(&root, &index, &[]);

    let installer = Installer::new(root.join("cache"))
        .with_endpoints(
            vec![format!("{}/version_manifest_v2.json", mock.base)],
            mock.base.clone(),
            format!("{}/java/all.json", mock.base),
        )
        .with_platform(PlatformInfo {
            name: "windows".to_string(),
            arch: "x64".to_string(),
            version: "10.0.19045".to_string(),
        })
        .with_downloader(Downloader::new().with_concurrency(2));

    let report = ModpackImporter::new(root.join("cache"))
        .with_installer(installer)
        .import(&root, &pack, None)
        .await
        .expect("Import");

    let install = report.base_install.as_ref().expect("Basisinstallation");
    assert!(install.java.is_none(), "Runtime darf nicht geladen werden");
    assert!(
        report
            .system_java
            .as_ref()
            .is_some_and(|java| java.major >= 17),
        "das gefundene Java muss die Anforderung erfüllen"
    );
    assert_eq!(
        report.system_java.as_ref().unwrap().major,
        system_java.major
    );
    assert!(
        !root.join("java").exists(),
        "ohne Runtime-Download darf kein java-Verzeichnis entstehen"
    );
    assert!(
        !mock.paths().iter().any(|path| path == "/java/all.json"),
        "das Java-Manifest darf nicht abgefragt werden"
    );

    // Der Rest der Basisinstallation läuft trotzdem vollständig.
    assert!(root.join("versions/1.20.1/1.20.1.jar").is_file());
    assert!(root
        .join("libraries/org/example/vanilla/1.0/vanilla-1.0.jar")
        .is_file());
    assert_eq!(install.assets.as_ref().unwrap().objects, 1);
    assert!(report.instance.dir.join("mods/mod.jar").is_file());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn rejects_path_traversal_without_leaving_an_instance() {
    let mock = start_mock(|_| not_found()).await;
    let root = temp_root();
    let index = base_index(
        "Boese Pack",
        vec![pack_file(&mock.base, "../evil.jar", "/evil.jar", b"x")],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(&root, &index, &[]);

    let error = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::UnsafePath(ref path) if path == "../evil.jar"),
        "unerwarteter Fehler: {error}"
    );
    let instances = root.join("instances");
    assert!(
        !instances.exists() || std::fs::read_dir(&instances).unwrap().next().is_none(),
        "eine halbe Instanz darf nicht liegen bleiben"
    );
    assert!(
        !root.join("versions").exists(),
        "ein unsicheres Pack darf keine Basisinstallation auslösen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn rejects_unsafe_override_paths() {
    let root = temp_root();
    let index = base_index("Boese Overrides", vec![], json!({"minecraft": "1.20.1"}));
    let pack = build_pack(&root, &index, &[("overrides/../evil.txt", b"x")]);

    let error = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::UnsafePath(_)),
        "unerwarteter Fehler: {error}"
    );
    let instances = root.join("instances");
    assert!(!instances.exists() || std::fs::read_dir(&instances).unwrap().next().is_none());
    assert!(!root.join("versions").exists());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn rejects_archives_without_any_manifest() {
    let root = temp_root();
    let path = root.join("leer.zip");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    zip.start_file("readme.txt", options).unwrap();
    zip.write_all(b"kein Modpack").unwrap();
    zip.finish().unwrap();

    let error = ModpackImporter::new(root.join("cache"))
        .import(&root, &path, None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::MissingIndex),
        "unerwarteter Fehler: {error}"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn repeated_imports_get_unique_instance_names() {
    let mock = start_mock(|path| match path {
        "/mod.jar" => ok(PACK_MOD.to_vec()),
        _ => not_found(),
    })
    .await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let index = base_index(
        "Same Pack",
        vec![pack_file(&mock.base, "mods/mod.jar", "/mod.jar", PACK_MOD)],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(&root, &index, &[]);
    let importer = ModpackImporter::new(root.join("cache"));

    let first = importer.import(&root, &pack, None).await.unwrap();
    let second = importer.import(&root, &pack, None).await.unwrap();
    assert_eq!(first.instance.name, "Same Pack");
    assert_eq!(second.instance.name, "Same Pack-2");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn rejects_duplicate_file_paths() {
    let mock = start_mock(|_| not_found()).await;
    let root = temp_root();
    let index = base_index(
        "Doppelte Datei",
        vec![
            pack_file(&mock.base, "mods/a.jar", "/a-first.jar", b"eins"),
            pack_file(&mock.base, "mods/a.jar", "/a-second.jar", b"zwei"),
        ],
        json!({"minecraft": "1.20.1"}),
    );
    let pack = build_pack(&root, &index, &[]);

    let error = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::DuplicatePath(ref path) if path == "mods/a.jar"),
        "unerwarteter Fehler: {error}"
    );
    assert!(!root.join("instances/Doppelte Datei").exists());
    assert!(!root.join("versions").exists());

    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// CurseForge-Packs
// ---------------------------------------------------------------------------

const CF_MOD: &[u8] = b"jei-mod-bytes";

fn curseforge_manifest(loaders: Value, files: Vec<Value>, overrides: Option<&str>) -> Value {
    let mut manifest = json!({
        "manifestType": "minecraftModpack",
        "manifestVersion": 1,
        "name": "CF Test Pack",
        "version": "3.1.0",
        "author": "Tester",
        "minecraft": {"version": "1.20.1", "modLoaders": loaders},
        "files": files,
    });
    if let Some(name) = overrides {
        manifest["overrides"] = json!(name);
    }
    manifest
}

fn build_curseforge_pack(dir: &Path, manifest: &Value, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = dir.join("curseforge.zip");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec_pretty(manifest).unwrap())
        .unwrap();
    for (name, body) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
    path
}

fn cf_file_response(file_name: &str, body: &[u8], download_url: Option<&str>) -> Response {
    ok(serde_json::to_vec(&json!({
        "data": {
            "id": 4610000,
            "modId": 238222,
            "displayName": "JEI 15.2.0",
            "fileName": file_name,
            "releaseType": 1,
            "fileLength": body.len(),
            "downloadUrl": download_url,
            "gameVersions": ["1.20.1", "Fabric"],
            "hashes": [{"value": sha1_hex(body), "algo": 1}]
        }
    }))
    .unwrap())
}

#[tokio::test]
async fn imports_a_curseforge_pack_with_its_loader_and_ledger() {
    let mock = start_mock_routed(|base, path| match path {
        "/v1/mods/238222/files/4610000" => cf_file_response("jei-1.20.1-15.2.0.jar", CF_MOD, None),
        "/v1/mods/238222/files/4610000/download-url" => ok(
            serde_json::to_vec(&json!({"data": format!("{base}/cf/files/jei.jar")})).unwrap(),
        ),
        "/cf/files/jei.jar" => ok(CF_MOD.to_vec()),
        other => fabric_route(base, other),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let manifest = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![json!({"projectID": 238222, "fileID": 4610000, "required": true})],
        Some("pack-overrides"),
    );
    let pack = build_curseforge_pack(
        &root,
        &manifest,
        &[
            ("pack-overrides/config/jei.json", b"{\"overlay\":false}"),
            ("pack-overrides/options.txt", b"fov:90"),
        ],
    );

    let report = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &pack, None)
        .await
        .expect("CurseForge-Import");

    assert_eq!(report.instance.name, "CF Test Pack");
    assert_eq!(report.pack_version, "3.1.0");
    assert_eq!(report.minecraft_version, "1.20.1");
    assert_eq!(report.loader, Some(Loader::Fabric));
    assert_eq!(report.loader_version.as_deref(), Some("0.16.10"));
    assert_eq!(report.version_id, "fabric-loader-0.16.10-1.20.1");
    assert_eq!(report.files, 1);
    assert_eq!(report.overrides, 2);
    assert_eq!(report.index_files.len(), 1);
    assert_eq!(report.index_files[0].path, "mods/jei-1.20.1-15.2.0.jar");
    assert_eq!(report.index_files[0].hashes.get("sha1"), Some(&sha1_hex(CF_MOD)));

    let dir = &report.instance.dir;
    assert_eq!(
        std::fs::read(dir.join("mods/jei-1.20.1-15.2.0.jar")).unwrap(),
        CF_MOD
    );
    assert_eq!(
        std::fs::read(dir.join("config/jei.json")).unwrap(),
        b"{\"overlay\":false}"
    );
    assert_eq!(std::fs::read(dir.join("options.txt")).unwrap(), b"fov:90");

    let ledger = ModLedger::load(dir).unwrap();
    assert_eq!(ledger.mods.len(), 1);
    assert_eq!(ledger.mods[0].source, ModSource::CurseForge);
    assert_eq!(ledger.mods[0].file_name, "jei-1.20.1-15.2.0.jar");
    assert_eq!(ledger.mods[0].project_id, "238222");
    assert_eq!(ledger.mods[0].version_id, "4610000");
    assert_eq!(ledger.mods[0].version_number, "JEI 15.2.0");
    assert_eq!(ledger.mods[0].required_by, vec!["CF Test Pack"]);
    let pack_record = ledger.pack.expect("Pack-Eintrag");
    assert_eq!(pack_record.name, "CF Test Pack");
    assert_eq!(pack_record.version_id, "3.1.0");
    assert_eq!(pack_record.source, "curseforge.zip");
    assert_eq!(pack_record.files.len(), 1);

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn curseforge_import_without_a_key_creates_nothing() {
    let root = temp_root();
    let manifest = curseforge_manifest(
        json!([{"id": "forge-47.2.0", "primary": true}]),
        vec![json!({"projectID": 238222, "fileID": 4610000})],
        None,
    );
    let pack = build_curseforge_pack(&root, &manifest, &[("overrides/options.txt", b"fov:90")]);

    let error = ModpackImporter::new(root.join("cache"))
        .import(&root, &pack, Some("Ohne Key"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::MissingCurseForgeKey),
        "unerwarteter Fehler: {error}"
    );
    assert!(!root.join("instances/Ohne Key").exists());
    assert!(!root.join("versions").exists());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn curseforge_import_reports_mods_that_forbid_downloads() {
    let mock = start_mock(|path| match path {
        "/v1/mods/10/files/20" => ok(serde_json::to_vec(&json!({
            "data": {
                "id": 20,
                "modId": 10,
                "displayName": "Blocked Mod",
                "fileName": "blocked-1.0.jar",
                "fileLength": 10,
                "downloadUrl": null,
                "hashes": [{"value": sha1_hex(b"blocked"), "algo": 1}]
            }
        }))
        .unwrap()),
        "/v1/mods/10/files/20/download-url" => not_found(),
        "/v1/mods/10" => ok(serde_json::to_vec(&json!({
            "data": {"id": 10, "name": "Blocked Mod", "allowModDistribution": false}
        }))
        .unwrap()),
        _ => not_found(),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let manifest = curseforge_manifest(
        json!([{"id": "forge-47.2.0", "primary": true}]),
        vec![json!({"projectID": 10, "fileID": 20})],
        None,
    );
    let pack = build_curseforge_pack(&root, &manifest, &[]);

    let error = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &pack, Some("Blockiert"))
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ModpackError::CurseForgeFile {
                project_id: 10,
                file_id: 20,
                ..
            }
        ),
        "unerwarteter Fehler: {error}"
    );
    assert!(error.to_string().contains("Blocked Mod"), "{error}");
    assert!(!root.join("instances/Blockiert").exists());

    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// Pack-Updates
// ---------------------------------------------------------------------------

const CF_KEEP: &[u8] = b"jei-keep";
const CF_OLD: &[u8] = b"alpha-1";
const CF_NEW: &[u8] = b"alpha-2";
const CF_ADD: &[u8] = b"extra-mod";
const CF_GONE: &[u8] = b"removed-mod";

fn cf_file(file_id: u64, mod_id: u64, file_name: &str, body: &[u8]) -> Response {
    ok(serde_json::to_vec(&json!({
        "data": {
            "id": file_id,
            "modId": mod_id,
            "displayName": file_name,
            "fileName": file_name,
            "releaseType": 1,
            "fileLength": body.len(),
            "downloadUrl": serde_json::Value::Null,
            "gameVersions": ["1.20.1", "Fabric"],
            "hashes": [{"value": sha1_hex(body), "algo": 1}]
        }
    }))
    .unwrap())
}

fn cf_download(base: &str, name: &str) -> Response {
    ok(serde_json::to_vec(&json!({"data": format!("{base}/cf/{name}")})).unwrap())
}

#[tokio::test]
async fn curseforge_update_loads_only_changed_mods() {
    let mock = start_mock_routed(|base, path| match path {
        "/v1/mods/238222/files/4610000" => {
            cf_file(4610000, 238222, "jei-1.20.1-15.2.0.jar", CF_KEEP)
        }
        "/v1/mods/238222/files/4610000/download-url" => cf_download(base, "jei.jar"),
        "/cf/jei.jar" => ok(CF_KEEP.to_vec()),
        "/v1/mods/111/files/222" => cf_file(222, 111, "alpha-1.0.jar", CF_OLD),
        "/v1/mods/111/files/222/download-url" => cf_download(base, "alpha-1.0.jar"),
        "/cf/alpha-1.0.jar" => ok(CF_OLD.to_vec()),
        "/v1/mods/777/files/888" => cf_file(888, 777, "gone-1.0.jar", CF_GONE),
        "/v1/mods/777/files/888/download-url" => cf_download(base, "gone-1.0.jar"),
        "/cf/gone-1.0.jar" => ok(CF_GONE.to_vec()),
        "/v1/mods/111/files/333" => cf_file(333, 111, "alpha-2.0.jar", CF_NEW),
        "/v1/mods/111/files/333/download-url" => cf_download(base, "alpha-2.0.jar"),
        "/cf/alpha-2.0.jar" => ok(CF_NEW.to_vec()),
        "/v1/mods/444/files/555" => cf_file(555, 444, "extra-1.0.jar", CF_ADD),
        "/v1/mods/444/files/555/download-url" => cf_download(base, "extra-1.0.jar"),
        "/cf/extra-1.0.jar" => ok(CF_ADD.to_vec()),
        other => fabric_route(base, other),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let first = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![
            json!({"projectID": 238222, "fileID": 4610000}),
            json!({"projectID": 111, "fileID": 222}),
            json!({"projectID": 777, "fileID": 888}),
        ],
        None,
    );
    let archive = build_curseforge_pack(&root, &first, &[("overrides/config/a.txt", b"alt")]);
    let imported = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &archive, None)
        .await
        .expect("CurseForge-Import");
    let dir = imported.instance.dir.clone();

    // Eine selbst installierte Mod gehört nicht zum Pack und muss das Update
    // überleben – auch dann, wenn das Pack sie nicht kennt.
    std::fs::write(dir.join("mods/own-mod.jar"), b"own-mod").unwrap();
    let mut ledger = ModLedger::load(&dir).unwrap();
    ledger.mods.push(ModRecord {
        file_name: "own-mod.jar".to_string(),
        source: ModSource::CurseForge,
        project_id: "999999".to_string(),
        version_id: "1".to_string(),
        version_number: "1.0".to_string(),
        installed_at: 0,
        required_by: Vec::new(),
    });
    ledger.save(&dir).unwrap();

    // Zweite Pack-Version: JEI bleibt, Alpha bekommt eine neue Datei, Gone
    // fliegt raus, Extra kommt dazu.
    let mut second = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![
            json!({"projectID": 238222, "fileID": 4610000}),
            json!({"projectID": 111, "fileID": 333}),
            json!({"projectID": 444, "fileID": 555}),
        ],
        None,
    );
    second["version"] = json!("3.2.0");
    build_curseforge_pack(&root, &second, &[("overrides/config/a.txt", b"neu")]);

    let before = mock.paths().len();
    let report = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .update(&root, &archive, "CF Test Pack")
        .await
        .expect("CurseForge-Update");

    assert_eq!(report.pack_version, "3.2.0");
    assert_eq!(report.added, 1, "nur Extra ist neu");
    assert_eq!(report.updated, 1, "nur Alpha hat eine neue Datei-ID");
    assert_eq!(report.removed, 1, "nur Gone fehlt im neuen Manifest");
    assert_eq!(report.kept, 1, "JEI bleibt unangetastet");
    assert_eq!(report.version_id, "fabric-loader-0.16.10-1.20.1");
    assert_eq!(report.overrides, 1);

    assert_eq!(
        std::fs::read(dir.join("mods/jei-1.20.1-15.2.0.jar")).unwrap(),
        CF_KEEP
    );
    assert_eq!(std::fs::read(dir.join("mods/alpha-2.0.jar")).unwrap(), CF_NEW);
    assert_eq!(
        std::fs::read(dir.join("mods/extra-1.0.jar")).unwrap(),
        CF_ADD
    );
    assert!(!dir.join("mods/alpha-1.0.jar").exists(), "alte Alpha-Datei liegt noch");
    assert!(!dir.join("mods/gone-1.0.jar").exists(), "entfernte Mod liegt noch");
    assert_eq!(std::fs::read(dir.join("mods/own-mod.jar")).unwrap(), b"own-mod");
    assert_eq!(std::fs::read(dir.join("config/a.txt")).unwrap(), b"neu");

    // Die unveränderte JEI-Datei darf weder aufgelöst noch erneut geladen werden.
    let requests = mock.paths();
    assert!(
        !requests[before..]
            .iter()
            .any(|path| path.contains("238222")),
        "JEI wurde erneut angefragt: {:?}",
        &requests[before..]
    );

    let ledger = ModLedger::load(&dir).unwrap();
    assert_eq!(ledger.mods.len(), 4, "eigene Mod wurde aus dem Bestand geworfen");
    assert!(ledger
        .mods
        .iter()
        .any(|record| record.project_id == "999999" && record.file_name == "own-mod.jar"));
    assert!(ledger
        .mods
        .iter()
        .any(|record| record.project_id == "111"
            && record.version_id == "333"
            && record.file_name == "alpha-2.0.jar"));
    assert!(!ledger.mods.iter().any(|record| record.project_id == "777"));
    let pack_record = ledger.pack.expect("Pack-Eintrag");
    assert_eq!(pack_record.version_id, "3.2.0");
    assert_eq!(pack_record.files.len(), 3);

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn curseforge_update_without_changes_needs_no_api() {
    let mock = start_mock_routed(|base, path| match path {
        "/v1/mods/238222/files/4610000" => {
            cf_file(4610000, 238222, "jei-1.20.1-15.2.0.jar", CF_KEEP)
        }
        "/v1/mods/238222/files/4610000/download-url" => cf_download(base, "jei.jar"),
        "/cf/jei.jar" => ok(CF_KEEP.to_vec()),
        other => fabric_route(base, other),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let manifest = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![json!({"projectID": 238222, "fileID": 4610000})],
        None,
    );
    let archive = build_curseforge_pack(&root, &manifest, &[]);
    let imported = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &archive, None)
        .await
        .expect("CurseForge-Import");

    let before = mock.paths().len();
    // Kein Key, kein API-Endpunkt: Ein unverändertes Pack braucht keinen Aufruf.
    let report = ModpackImporter::new(root.join("cache"))
        .update(&root, &archive, &imported.instance.name)
        .await
        .expect("Update ohne Änderungen");

    assert_eq!(report.added, 0);
    assert_eq!(report.updated, 0);
    assert_eq!(report.removed, 0);
    assert_eq!(report.kept, 1);
    assert_eq!(report.downloaded_bytes, 0);
    assert_eq!(mock.paths().len(), before, "unerwartete Netzwerkaufrufe");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn curseforge_update_reloads_a_tampered_kept_file() {
    let mock = start_mock_routed(|base, path| match path {
        "/v1/mods/238222/files/4610000" => {
            cf_file(4610000, 238222, "jei-1.20.1-15.2.0.jar", CF_KEEP)
        }
        "/v1/mods/238222/files/4610000/download-url" => cf_download(base, "jei.jar"),
        "/cf/jei.jar" => ok(CF_KEEP.to_vec()),
        other => fabric_route(base, other),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let manifest = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![json!({"projectID": 238222, "fileID": 4610000})],
        None,
    );
    let archive = build_curseforge_pack(&root, &manifest, &[]);
    let imported = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &archive, None)
        .await
        .expect("CurseForge-Import");
    let dir = imported.instance.dir.clone();
    std::fs::write(dir.join("mods/jei-1.20.1-15.2.0.jar"), b"kaputt").unwrap();

    let before = mock.paths().len();
    let report = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .update(&root, &archive, &imported.instance.name)
        .await
        .expect("Update");

    assert_eq!(
        report.kept, 0,
        "eine beschädigte Datei darf nicht als unverändert gelten"
    );
    assert_eq!(report.updated, 1);
    assert_eq!(
        std::fs::read(dir.join("mods/jei-1.20.1-15.2.0.jar")).unwrap(),
        CF_KEEP
    );
    assert!(
        mock.paths()[before..]
            .iter()
            .any(|path| path.contains("238222")),
        "die beschädigte Datei wurde nicht neu aufgelöst"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn curseforge_update_failure_leaves_the_old_install_usable() {
    let mock = start_mock_routed(|base, path| match path {
        "/v1/mods/238222/files/4610000" => {
            cf_file(4610000, 238222, "jei-1.20.1-15.2.0.jar", CF_KEEP)
        }
        "/v1/mods/238222/files/4610000/download-url" => cf_download(base, "jei.jar"),
        "/cf/jei.jar" => ok(CF_KEEP.to_vec()),
        "/v1/mods/111/files/222" => cf_file(222, 111, "alpha-1.0.jar", CF_OLD),
        "/v1/mods/111/files/222/download-url" => cf_download(base, "alpha-1.0.jar"),
        "/cf/alpha-1.0.jar" => ok(CF_OLD.to_vec()),
        "/v1/mods/111/files/333" => cf_file(333, 111, "alpha-2.0.jar", CF_NEW),
        "/v1/mods/111/files/333/download-url" => cf_download(base, "alpha-2.0.jar"),
        "/cf/alpha-2.0.jar" => Response {
            status: 500,
            body: Vec::new(),
        },
        other => fabric_route(base, other),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let first = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![
            json!({"projectID": 238222, "fileID": 4610000}),
            json!({"projectID": 111, "fileID": 222}),
        ],
        None,
    );
    let archive = build_curseforge_pack(&root, &first, &[]);
    let imported = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .import(&root, &archive, None)
        .await
        .expect("CurseForge-Import");
    let dir = imported.instance.dir.clone();

    let mut second = curseforge_manifest(
        json!([{"id": "fabric-0.16.10", "primary": true}]),
        vec![
            json!({"projectID": 238222, "fileID": 4610000}),
            json!({"projectID": 111, "fileID": 333}),
        ],
        None,
    );
    second["version"] = json!("3.2.0");
    build_curseforge_pack(&root, &second, &[]);

    let error = ModpackImporter::new(root.join("cache"))
        .with_curseforge_key(Some("test-key".to_string()))
        .with_curseforge_base(format!("{}/v1", mock.base))
        .with_curseforge_cdn(format!("{}/cdn", mock.base))
        .update(&root, &archive, &imported.instance.name)
        .await
        .expect_err("Download-Fehler muss das Update abbrechen");
    assert!(
        matches!(error, ModpackError::Download(_)),
        "unerwarteter Fehler: {error}"
    );

    // Nichts wurde gelöscht oder ersetzt: die alte Installation bleibt startbar.
    assert_eq!(
        std::fs::read(dir.join("mods/alpha-1.0.jar")).unwrap(),
        CF_OLD
    );
    assert!(!dir.join("mods/alpha-2.0.jar").exists());
    assert_eq!(std::fs::read(dir.join("mods/jei-1.20.1-15.2.0.jar")).unwrap(), CF_KEEP);
    let ledger = ModLedger::load(&dir).unwrap();
    assert_eq!(
        ledger.pack.expect("Pack-Eintrag").version_id,
        "3.1.0",
        "die Bestandsdatei darf nach einem Abbruch nicht die neue Version tragen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn modrinth_update_keeps_unchanged_files() {
    const SAME: &[u8] = b"same-mod";
    const OLD: &[u8] = b"old-mod";
    const NEW: &[u8] = b"new-mod";
    const ADD: &[u8] = b"add-mod";
    const GONE: &[u8] = b"gone-mod";

    let mock = start_mock(|path| match path {
        "/same.jar" => ok(SAME.to_vec()),
        "/old.jar" => ok(OLD.to_vec()),
        "/new.jar" => ok(NEW.to_vec()),
        "/add.jar" => ok(ADD.to_vec()),
        "/gone.jar" => ok(GONE.to_vec()),
        _ => not_found(),
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    let first = base_index(
        "Mr Update",
        vec![
            pack_file(&mock.base, "mods/same.jar", "/same.jar", SAME),
            pack_file(&mock.base, "mods/changed.jar", "/old.jar", OLD),
            pack_file(&mock.base, "mods/gone.jar", "/gone.jar", GONE),
        ],
        json!({"minecraft": "1.20.1"}),
    );
    let archive = build_pack(&root, &first, &[]);
    let imported = ModpackImporter::new(root.join("cache"))
        .import(&root, &archive, None)
        .await
        .expect("Import");
    let dir = imported.instance.dir.clone();

    let mut second = base_index(
        "Mr Update",
        vec![
            pack_file(&mock.base, "mods/same.jar", "/same.jar", SAME),
            pack_file(&mock.base, "mods/changed.jar", "/new.jar", NEW),
            pack_file(&mock.base, "mods/add.jar", "/add.jar", ADD),
        ],
        json!({"minecraft": "1.20.1"}),
    );
    second["versionId"] = json!("2.0.0");
    build_pack(&root, &second, &[]);

    let before = mock.paths().len();
    let report = ModpackImporter::new(root.join("cache"))
        .update(&root, &archive, &imported.instance.name)
        .await
        .expect("Modrinth-Update");

    assert_eq!(report.pack_version, "2.0.0");
    assert_eq!(report.kept, 1, "nur same.jar bleibt liegen");
    assert_eq!(report.removed, 1, "gone.jar fliegt raus");
    assert_eq!(std::fs::read(dir.join("mods/same.jar")).unwrap(), SAME);
    assert_eq!(std::fs::read(dir.join("mods/changed.jar")).unwrap(), NEW);
    assert_eq!(std::fs::read(dir.join("mods/add.jar")).unwrap(), ADD);
    assert!(!dir.join("mods/gone.jar").exists());
    assert_eq!(
        mock.paths()[before..]
            .iter()
            .filter(|path| path.ends_with("/same.jar"))
            .count(),
        0,
        "unveränderte Datei wurde erneut geladen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn refuses_to_update_an_instance_without_pack_data() {
    let root = temp_root();
    InstanceManager::new(root.join("instances"))
        .create("Eigene Instanz", Some("1.20.1"))
        .unwrap();
    let manifest = curseforge_manifest(json!([]), Vec::new(), None);
    let archive = build_curseforge_pack(&root, &manifest, &[]);

    let error = ModpackImporter::new(root.join("cache"))
        .update(&root, &archive, "Eigene Instanz")
        .await
        .unwrap_err();
    assert!(
        matches!(error, ModpackError::NotAModpack(ref name) if name == "Eigene Instanz"),
        "unerwarteter Fehler: {error}"
    );

    let _ = std::fs::remove_dir_all(&root);
}
