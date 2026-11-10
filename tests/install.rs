//! Eine frische Installation gegen einen lokalen Mock: Versions-JSON,
//! Client-Jar, Libraries, Log-Konfiguration, Assets (inklusive Legacy-Virtual)
//! und eine Java-Runtime – ohne echtes Mojang-Konto oder Netz.

use bamboo_launcher::config::MemorySettings;
use bamboo_launcher::download::{sha1_hex, DownloadError};
use bamboo_launcher::install::{runtime_platform_key, InstallError, InstallOptions, Installer};
use bamboo_launcher::java::{self, JavaRuntime};
use bamboo_launcher::launcher::{build_launch_plan, Account, LaunchOptions};
use bamboo_launcher::version::{self, PlatformInfo};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// Mock-Server
// ---------------------------------------------------------------------------

struct Route {
    path: String,
    body: Vec<u8>,
    /// Anzahl der 500er, bevor die Route erfolgreich antwortet.
    fail_first: usize,
}

struct Mock {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Mock {
    fn hits(&self, path: &str) -> usize {
        *self.hits.lock().unwrap().get(path).unwrap_or(&0)
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..position]).to_string();
            let length = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    if key.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let start = position + 4;
            if buffer.len() >= start + length {
                let body = String::from_utf8_lossy(&buffer[start..start + length]).to_string();
                return Some((head, body));
            }
        }
        if buffer.len() > 1_000_000 {
            return None;
        }
    }
}

async fn start_mock<F>(build: F) -> Mock
where
    F: FnOnce(&str) -> Vec<Route>,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let routes = build(&base);
    let hits = Arc::new(Mutex::new(HashMap::new()));
    let recorded = Arc::clone(&hits);

    tokio::spawn(async move {
        let mut routes: HashMap<String, Route> = routes
            .into_iter()
            .map(|route| (route.path.clone(), route))
            .collect();
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let Some((head, _)) = read_request(&mut stream).await else {
                continue;
            };
            let path = head
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/")
                .to_string();
            let count = {
                let mut hits = recorded.lock().unwrap();
                let entry = hits.entry(path.clone()).or_insert(0);
                *entry += 1;
                *entry
            };

            let (status, body) = match routes.get_mut(&path) {
                Some(route) if count > route.fail_first => (200, route.body.clone()),
                Some(_) => (500, b"kaputt".to_vec()),
                None => (404, b"not found".to_vec()),
            };
            let reason = if status == 200 { "OK" } else { "Error" };
            let header = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(&body).await;
            let _ = stream.flush().await;
        }
    });

    Mock { base, hits }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const VERSION_ID: &str = "test-1.0";
const LIBRARY_REL: &str = "com/example/demo/1.0/demo-1.0.jar";

struct Fixture {
    client_jar: Vec<u8>,
    library: Vec<u8>,
    log: Vec<u8>,
    asset_a: Vec<u8>,
    asset_b: Vec<u8>,
    shared: Vec<u8>,
    java_exe: Vec<u8>,
    java_modules: Vec<u8>,
    asset_a_hash: String,
    asset_b_hash: String,
    shared_hash: String,
}

fn hash(bytes: &[u8]) -> String {
    sha1_hex(bytes)
}

fn route(path: &str, body: Vec<u8>) -> Route {
    Route {
        path: path.to_string(),
        body,
        fail_first: 0,
    }
}

fn build_fixture(
    base: &str,
    corrupt_library: bool,
    library_failures: usize,
) -> (Vec<Route>, Fixture) {
    let client_jar = b"client-jar-bytes".to_vec();
    let library = b"library-bytes".to_vec();
    let log = b"<configuration/>".to_vec();
    let asset_a = b"asset-a".to_vec();
    let asset_b = b"asset-b".to_vec();
    let shared = b"asset-shared".to_vec();
    let java_exe = b"fake-java".to_vec();
    let java_modules = b"modules".to_vec();

    let asset_a_hash = hash(&asset_a);
    let asset_b_hash = hash(&asset_b);
    let shared_hash = hash(&shared);

    let index = json!({
        "objects": {
            "icons/a.png": { "hash": asset_a_hash, "size": asset_a.len() },
            "minecraft/b.txt": { "hash": asset_b_hash, "size": asset_b.len() },
            "sounds/shared.bin": { "hash": shared_hash, "size": shared.len() },
            "sounds/alias.bin": { "hash": shared_hash, "size": shared.len() },
        },
        "virtual": true
    })
    .to_string()
    .into_bytes();

    let version = json!({
        "id": VERSION_ID,
        "type": "release",
        "mainClass": "net.minecraft.client.main.Main",
        "assets": "test",
        "assetIndex": {
            "id": "test",
            "url": format!("{base}/indexes/test.json"),
            "sha1": hash(&index),
            "size": index.len()
        },
        "downloads": {
            "client": {
                "url": format!("{base}/client.jar"),
                "sha1": hash(&client_jar),
                "size": client_jar.len()
            }
        },
        "javaVersion": { "component": "java-runtime-gamma", "majorVersion": 17 },
        "arguments": {
            "game": ["--username", "${auth_player_name}"],
            "jvm": ["-cp", "${classpath}", "-Djava.library.path=${natives_directory}"]
        },
        "logging": {
            "client": {
                "argument": "-Dlog4j.configurationFile=${path}",
                "file": {
                    "id": "client-test.xml",
                    "url": format!("{base}/log.xml"),
                    "sha1": hash(&log),
                    "size": log.len()
                }
            }
        },
        "libraries": [{
            "name": "com.example:demo:1.0",
            "downloads": {
                "artifact": {
                    "path": LIBRARY_REL,
                    "url": format!("{base}/lib.jar"),
                    "sha1": hash(&library),
                    "size": library.len()
                }
            }
        }]
    })
    .to_string()
    .into_bytes();

    let manifest = json!({
        "latest": { "release": VERSION_ID, "snapshot": VERSION_ID },
        "versions": [{
            "id": VERSION_ID,
            "type": "release",
            "url": format!("{base}/versions/{VERSION_ID}.json"),
            "sha1": hash(&version)
        }]
    })
    .to_string()
    .into_bytes();

    let java_files = json!({
        "files": {
            "bin/java.exe": {
                "type": "file",
                "executable": true,
                "downloads": { "raw": {
                    "url": format!("{base}/java/bin/java.exe"),
                    "sha1": hash(&java_exe),
                    "size": java_exe.len()
                }}
            },
            "lib/modules": {
                "type": "file",
                "downloads": { "raw": {
                    "url": format!("{base}/java/lib/modules"),
                    "sha1": hash(&java_modules),
                    "size": java_modules.len()
                }}
            },
            "conf": { "type": "directory" },
            "bin/server": { "type": "link" }
        }
    })
    .to_string()
    .into_bytes();

    let java_all = json!({
        "windows-x64": {
            "java-runtime-gamma": [{
                "version": { "name": "17.0.8" },
                "manifest": {
                    "url": format!("{base}/java/manifest.json"),
                    "sha1": hash(&java_files),
                    "size": java_files.len()
                }
            }]
        }
    })
    .to_string()
    .into_bytes();

    // Gleiche Länge, anderer Inhalt: Das prüft die SHA-1-Erkennung, nicht die
    // Größenprüfung.
    let served_library = if corrupt_library {
        b"manipuliert!!".to_vec()
    } else {
        library.clone()
    };

    let routes = vec![
        route("/version_manifest_v2.json", manifest),
        route(&format!("/versions/{VERSION_ID}.json"), version),
        route("/client.jar", client_jar.clone()),
        Route {
            path: "/lib.jar".to_string(),
            body: served_library,
            fail_first: library_failures,
        },
        route("/log.xml", log.clone()),
        route("/indexes/test.json", index),
        route(
            &format!("/{}/{}", &asset_a_hash[..2], asset_a_hash),
            asset_a.clone(),
        ),
        route(
            &format!("/{}/{}", &asset_b_hash[..2], asset_b_hash),
            asset_b.clone(),
        ),
        route(
            &format!("/{}/{}", &shared_hash[..2], shared_hash),
            shared.clone(),
        ),
        route("/java/all.json", java_all),
        route("/java/manifest.json", java_files),
        route("/java/bin/java.exe", java_exe.clone()),
        route("/java/lib/modules", java_modules.clone()),
    ];

    (
        routes,
        Fixture {
            client_jar,
            library,
            log,
            asset_a,
            asset_b,
            shared,
            java_exe,
            java_modules,
            asset_a_hash,
            asset_b_hash,
            shared_hash,
        },
    )
}

async fn start_fixture(corrupt_library: bool, library_failures: usize) -> (Mock, Fixture) {
    let mut slot: Option<Fixture> = None;
    let mock = start_mock(|base| {
        let (routes, fixture) = build_fixture(base, corrupt_library, library_failures);
        slot = Some(fixture);
        routes
    })
    .await;
    (mock, slot.unwrap())
}

fn platform() -> PlatformInfo {
    PlatformInfo {
        name: "windows".to_string(),
        arch: "x64".to_string(),
        version: "10.0.19045".to_string(),
    }
}

fn installer(cache: &Path, mock: &Mock) -> Installer {
    Installer::new(cache)
        .with_endpoints(
            vec![format!("{}/version_manifest_v2.json", mock.base)],
            mock.base.clone(),
            format!("{}/java/all.json", mock.base),
        )
        .with_platform(platform())
        .with_downloader(bamboo_launcher::download::Downloader::new().with_concurrency(4))
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn java_stub() -> JavaRuntime {
    JavaRuntime {
        path: PathBuf::from("java"),
        major: 17,
        version: "17.0.8".to_string(),
        vendor: None,
        arch: "x64".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fresh_install_creates_every_required_file() {
    let (mock, fixture) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");

    let report = installer(&dir.path().join("cache"), &mock)
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .expect("Installation muss durchlaufen");

    assert!(report.version_json_downloaded);
    assert_eq!(report.files.downloaded, 3, "Client, Library und Log-Config");

    assert_eq!(
        read(&game_root.join("versions/test-1.0/test-1.0.jar")),
        fixture.client_jar
    );
    assert_eq!(
        read(&game_root.join("libraries").join(LIBRARY_REL)),
        fixture.library
    );
    assert_eq!(
        read(&game_root.join("assets/log_configs/client-test.xml")),
        fixture.log
    );

    // Asset-Objekte liegen inhaltsadressiert unter objects/xx/<hash>.
    let object = |hash: &str| game_root.join("assets/objects").join(&hash[..2]).join(hash);
    assert_eq!(read(&object(&fixture.asset_a_hash)), fixture.asset_a);
    assert_eq!(read(&object(&fixture.asset_b_hash)), fixture.asset_b);
    assert_eq!(read(&object(&fixture.shared_hash)), fixture.shared);
    assert_eq!(
        mock.hits(&format!(
            "/{}/{}",
            &fixture.shared_hash[..2],
            fixture.shared_hash
        )),
        1,
        "geteilte Objekte dürfen nur einmal geladen werden"
    );

    // 1.7-Assets werden zusätzlich unter virtual/<index>/<name> verlinkt.
    let virtual_dir = game_root.join("assets/virtual/test");
    assert_eq!(read(&virtual_dir.join("icons/a.png")), fixture.asset_a);
    assert_eq!(read(&virtual_dir.join("sounds/shared.bin")), fixture.shared);
    assert_eq!(read(&virtual_dir.join("sounds/alias.bin")), fixture.shared);

    // Java-Runtime inklusive Verzeichnissen; Symlinks werden übersprungen.
    let java_root = game_root.join("java/java-runtime-gamma");
    assert_eq!(read(&java_root.join("bin/java.exe")), fixture.java_exe);
    assert_eq!(read(&java_root.join("lib/modules")), fixture.java_modules);
    assert!(java_root.join("conf").is_dir());
    assert!(!java_root.join("bin/server").exists());

    let assets = report.assets.expect("Assets wurden installiert");
    assert_eq!(assets.index_id, "test");
    assert_eq!(assets.objects, 4);
    assert_eq!(assets.virtual_dir.as_deref(), Some(virtual_dir.as_path()));

    let installed_java = report.java.expect("Java wurde installiert");
    assert_eq!(installed_java.component, "java-runtime-gamma");
    assert_eq!(installed_java.version.as_deref(), Some("17.0.8"));
    assert!(installed_java.java_path.is_file());

    // Der Launcher findet die neue Runtime ohne Eingriff.
    assert!(java::candidate_paths_in(&game_root)
        .iter()
        .any(|path| path == &installed_java.java_path));

    // Und der Startbefehl besteht aus vorhandenen Dateien.
    let resolved = version::resolve_version(&game_root, VERSION_ID).unwrap();
    for entry in &resolved.classpath {
        assert!(
            entry.is_file(),
            "Classpath-Eintrag fehlt: {}",
            entry.display()
        );
    }
    let plan = build_launch_plan(
        &game_root,
        VERSION_ID,
        &game_root,
        &LaunchOptions {
            account: Account::offline("Test"),
            memory: MemorySettings::new(1024, 2048),
            java: java_stub(),
            extra_jvm_args: Vec::new(),
            extra_game_args: Vec::new(),
            resolution: None,
            demo: false,
            server: None,
            quick_play_world: None,
        },
    )
    .unwrap();
    let log_argument = plan
        .command
        .iter()
        .find_map(|argument| argument.strip_prefix("-Dlog4j.configurationFile="))
        .expect("Log-Konfiguration muss im Befehl stehen");
    assert!(
        Path::new(log_argument).is_file(),
        "Log-Konfiguration fehlt: {log_argument}"
    );
}

#[tokio::test]
async fn second_run_skips_everything() {
    let (mock, _) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");
    let installer = installer(&dir.path().join("cache"), &mock);

    installer
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();
    let report = installer
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();

    assert!(!report.version_json_downloaded);
    assert_eq!(report.files.downloaded, 0);
    assert_eq!(report.assets.as_ref().unwrap().download.downloaded, 0);
    assert_eq!(report.java.as_ref().unwrap().download.downloaded, 0);
    assert_eq!(
        report.skipped_files(),
        report.files.files
            + report.assets.as_ref().unwrap().download.files
            + report.java.as_ref().unwrap().download.files
    );
}

#[tokio::test]
async fn damaged_file_is_replaced() {
    let (mock, fixture) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");
    let installer = installer(&dir.path().join("cache"), &mock);
    let library_path = game_root.join("libraries").join(LIBRARY_REL);

    installer
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();
    std::fs::write(&library_path, b"kaputt").unwrap();

    let report = installer
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();

    assert_eq!(report.files.downloaded, 1, "nur die beschädigte Datei");
    assert_eq!(read(&library_path), fixture.library);
}

#[tokio::test]
async fn repair_restores_missing_library_asset_and_java() {
    let (mock, fixture) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");
    let cache = dir.path().join("cache");

    installer(&cache, &mock)
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();

    let library_path = game_root.join("libraries").join(LIBRARY_REL);
    let asset_path = game_root
        .join("assets/objects")
        .join(&fixture.asset_a_hash[..2])
        .join(&fixture.asset_a_hash);
    std::fs::remove_file(&library_path).unwrap();
    std::fs::remove_file(&asset_path).unwrap();
    std::fs::remove_dir_all(game_root.join("java/java-runtime-gamma")).unwrap();

    // Ein ungültiger expliziter Pfad erzwingt den Runtime-Download; sonst
    // würde das Java des Testrechners die Erwartung verändern.
    let repair_installer =
        installer(&cache, &mock).with_java_path(Some(game_root.join("kein-java")));
    let report = repair_installer
        .repair_version(&game_root, VERSION_ID, |_| {})
        .await
        .expect("Reparatur");

    assert_eq!(report.version_id, VERSION_ID);
    assert!(report.system_java.is_none());
    assert_eq!(report.install.files.downloaded, 1, "fehlende Library");
    assert_eq!(
        report.install.assets.as_ref().unwrap().download.downloaded,
        1,
        "fehlendes Asset"
    );
    assert_eq!(
        report.install.java.as_ref().unwrap().download.downloaded,
        2,
        "Java-Binary und Module"
    );
    assert_eq!(read(&library_path), fixture.library);
    assert_eq!(read(&asset_path), fixture.asset_a);

    // Ein zweiter Lauf lädt nichts erneut herunter.
    let again = repair_installer
        .repair_version(&game_root, VERSION_ID, |_| {})
        .await
        .unwrap();
    assert_eq!(again.install.files.downloaded, 0);
    assert_eq!(again.install.assets.unwrap().download.downloaded, 0);
    assert_eq!(again.install.java.unwrap().download.downloaded, 0);
}

#[tokio::test]
async fn repair_uses_system_java_without_downloading_a_runtime() {
    // Ohne Java auf dem Rechner gibt es nichts zu überspringen.
    let Some(_) = java::find_java(None, 17).await.ok() else {
        eprintln!("Kein System-Java ab 17 gefunden – Test wird übersprungen.");
        return;
    };

    let (mock, fixture) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");
    let cache = dir.path().join("cache");
    let installer = installer(&cache, &mock);

    installer
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .unwrap();
    std::fs::remove_dir_all(game_root.join("java")).unwrap();
    let library_path = game_root.join("libraries").join(LIBRARY_REL);
    std::fs::remove_file(&library_path).unwrap();
    let java_manifest_hits = mock.hits("/java/all.json");

    let report = installer
        .repair_version(&game_root, VERSION_ID, |_| {})
        .await
        .expect("Reparatur");

    assert!(report.system_java.is_some());
    assert!(report.install.java.is_none());
    assert_eq!(
        mock.hits("/java/all.json"),
        java_manifest_hits,
        "das Java-Manifest darf nicht erneut abgefragt werden"
    );
    assert_eq!(report.install.files.downloaded, 1);
    assert_eq!(read(&library_path), fixture.library);
}

#[tokio::test]
async fn repair_requires_an_existing_installation() {
    let (mock, _) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");

    let error = installer(&dir.path().join("cache"), &mock)
        .repair_version(&game_root, VERSION_ID, |_| {})
        .await
        .expect_err("ohne Installation darf nicht repariert werden");

    assert!(
        matches!(error, InstallError::VersionNotInstalled(ref id) if id == VERSION_ID),
        "unerwarteter Fehler: {error}"
    );
    assert_eq!(mock.hits("/version_manifest_v2.json"), 0);
    assert!(!game_root.exists());
}

#[tokio::test]
async fn checksum_mismatch_fails_without_leaving_files() {
    let (mock, _) = start_fixture(true, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");

    let error = installer(&dir.path().join("cache"), &mock)
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .expect_err("eine falsche Prüfsumme darf nicht durchgehen");

    assert!(
        matches!(
            error,
            InstallError::Download(DownloadError::Checksum { .. })
        ),
        "unerwarteter Fehler: {error}"
    );

    let mut leftovers: Vec<String> = Vec::new();
    collect_files(&game_root.join("libraries"), &mut leftovers);
    assert!(
        !leftovers.iter().any(|name| name.ends_with(".part")),
        "temporäre Dateien blieben liegen: {leftovers:?}"
    );
    assert!(!game_root.join("libraries").join(LIBRARY_REL).exists());
}

#[tokio::test]
async fn transient_server_errors_are_retried() {
    let (mock, fixture) = start_fixture(false, 2).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");

    installer(&dir.path().join("cache"), &mock)
        .install_version(&game_root, VERSION_ID, &InstallOptions::default(), |_| {})
        .await
        .expect("zwei 500er müssen überbrückt werden");

    assert_eq!(mock.hits("/lib.jar"), 3, "drei Versuche");
    assert_eq!(
        read(&game_root.join("libraries").join(LIBRARY_REL)),
        fixture.library
    );
}

#[tokio::test]
async fn assets_and_java_can_be_skipped() {
    let (mock, _) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();
    let game_root = dir.path().join("minecraft");

    let report = installer(&dir.path().join("cache"), &mock)
        .install_version(
            &game_root,
            VERSION_ID,
            &InstallOptions {
                assets: false,
                java: false,
                refresh_manifest: false,
            },
            |_| {},
        )
        .await
        .unwrap();

    assert!(report.assets.is_none());
    assert!(report.java.is_none());
    assert!(!game_root.join("assets/indexes").exists());
    assert!(!game_root.join("assets/objects").exists());
    assert!(!game_root.join("java").exists());
    assert!(game_root.join("versions/test-1.0/test-1.0.jar").is_file());
}

#[tokio::test]
async fn unsafe_version_ids_are_rejected_before_any_request() {
    let (mock, _) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();

    let error = installer(&dir.path().join("cache"), &mock)
        .install_version(
            &dir.path().join("minecraft"),
            "../../evil",
            &InstallOptions::default(),
            |_| {},
        )
        .await
        .expect_err("Pfad-Ausbruch muss scheitern");

    assert!(matches!(error, InstallError::InvalidName(_)));
    assert_eq!(mock.hits("/version_manifest_v2.json"), 0);
}

#[tokio::test]
async fn unknown_versions_report_the_manifest_as_the_cause() {
    let (mock, _) = start_fixture(false, 0).await;
    let dir = tempfile::tempdir().unwrap();

    let error = installer(&dir.path().join("cache"), &mock)
        .install_version(
            &dir.path().join("minecraft"),
            "gibt-es-nicht",
            &InstallOptions::default(),
            |_| {},
        )
        .await
        .expect_err("unbekannte Version muss scheitern");

    assert!(matches!(error, InstallError::VersionNotInManifest(name) if name == "gibt-es-nicht"));
}

#[test]
fn platform_keys_are_stable_for_tests() {
    assert_eq!(runtime_platform_key(&platform()), "windows-x64");
    assert_eq!(platform().classpath_separator(), ';');
}

fn collect_files(directory: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            out.push(name.to_string());
        }
    }
}
