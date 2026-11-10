//! Loader-Installation gegen einen lokalen Mock-Server: Auswahl der Version,
//! Schreiben des Profils, Bibliotheks-Downloads und Fehlerfälle.

use bamboo_launcher::download::sha1_hex;
use bamboo_launcher::instances::InstanceManager;
use bamboo_launcher::loader::{installed_loaders, LoaderError, LoaderInstaller};
use bamboo_launcher::mods::Loader;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

const CLIENT_JAR: &[u8] = b"client-jar-bytes";
const VANILLA_LIB: &[u8] = b"vanilla-library-bytes";
const LOADER_LIB: &[u8] = b"fabric-loader-bytes";
const EXTRA_LIB: &[u8] = b"fabric-extra-bytes";
const QUILT_LOADER_LIB: &[u8] = b"quilt-loader-bytes";

// ---------------------------------------------------------------------------
// Mock-Server
// ---------------------------------------------------------------------------

struct Request {
    target: String,
}

impl Request {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }
}

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
    F: Fn(&Request) -> Response + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    let route = Arc::new(route);

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let recorded = Arc::clone(&recorded);
            let route = Arc::clone(&route);
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
                let request = Request { target };
                let response = route(&request);
                let reason = match response.status {
                    200 => "OK",
                    404 => "Not Found",
                    _ => "Error",
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
        "bamboo-loader-test-{}-{}-{id}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Legt die Vanilla-Basisversion samt herunterladbarer Dateien an.
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
            "url": format!("{base}/assets/5.json"),
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

    // Wie nach `install`: Client-Jar und Bibliothek liegen bereits (richtige
    // Größe und SHA-1), damit die Installation nur noch den Loader ergänzt.
    std::fs::write(directory.join(format!("{minecraft}.jar")), CLIENT_JAR).unwrap();
    let library = root.join("libraries/org/example/vanilla/1.0/vanilla-1.0.jar");
    std::fs::create_dir_all(library.parent().unwrap()).unwrap();
    std::fs::write(library, VANILLA_LIB).unwrap();
}

fn fabric_entries() -> Value {
    json!([
        {"loader": {"version": "0.17.0-beta.1", "stable": false, "build": 1}},
        {"loader": {"version": "0.16.10", "stable": true, "build": 2}}
    ])
}

/// Profil, wie Fabric es liefert: eine Bibliothek über den Maven-Fallback, eine
/// mit expliziter Download-Angabe inklusive SHA-1.
fn fabric_profile(base: &str, minecraft: &str, loader: &str, inherits: &str) -> Value {
    json!({
        "id": format!("fabric-loader-{loader}-{minecraft}"),
        "inheritsFrom": inherits,
        "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
        "type": "release",
        "libraries": [
            {
                "name": format!("net.fabricmc:fabric-loader:{loader}"),
                "url": format!("{base}/maven/")
            },
            {
                "name": "net.fabricmc:intermediary:1.0",
                "downloads": {
                    "artifact": {
                        "url": format!("{base}/fabric-extra.jar"),
                        "sha1": sha1_hex(EXTRA_LIB),
                        "size": EXTRA_LIB.len()
                    }
                }
            }
        ]
    })
}

fn route_fabric(base: String) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    move |request: &Request| match request.path() {
        "/versions/loader/1.20.1" => ok(serde_json::to_vec(&fabric_entries()).unwrap()),
        "/versions/loader/1.20.1/0.16.10/profile/json" => {
            ok(serde_json::to_vec(&fabric_profile(&base, "1.20.1", "0.16.10", "1.20.1")).unwrap())
        }
        "/versions/loader/1.20.1/0.17.0-beta.1/profile/json" => ok(serde_json::to_vec(
            &fabric_profile(&base, "1.20.1", "0.17.0-beta.1", "1.20.1"),
        )
        .unwrap()),
        "/maven/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar" => {
            ok(LOADER_LIB.to_vec())
        }
        "/maven/net/fabricmc/fabric-loader/0.17.0-beta.1/fabric-loader-0.17.0-beta.1.jar" => {
            ok(LOADER_LIB.to_vec())
        }
        "/client.jar" => ok(CLIENT_JAR.to_vec()),
        "/vanilla-lib.jar" => ok(VANILLA_LIB.to_vec()),
        "/fabric-extra.jar" => ok(EXTRA_LIB.to_vec()),
        _ => not_found(),
    }
}

/// Startet einen Fabric-Mock; gibt den Mock und die geteilte Basis-URL zurück.
async fn fabric_mock() -> (Mock, Arc<Mutex<String>>) {
    let base = Arc::new(Mutex::new(String::new()));
    let cell = Arc::clone(&base);
    let mock = start_mock(move |request: &Request| {
        let origin = cell.lock().unwrap().clone();
        route_fabric(origin)(request)
    })
    .await;
    *base.lock().unwrap() = mock.base.clone();
    (mock, base)
}

fn quilt_entries() -> Value {
    // Absichtlich unsortiert: Quilt Meta liefert die Reihenfolge nicht stabil.
    json!([
        {"loader": {"version": "0.25.0-beta.1"}},
        {"loader": {"version": "0.23.1"}},
        {"loader": {"version": "0.24.0"}}
    ])
}

fn quilt_profile(base: &str, minecraft: &str, loader: &str, inherits: &str) -> Value {
    json!({
        "id": format!("quilt-loader-{loader}-{minecraft}"),
        "inheritsFrom": inherits,
        "mainClass": "org.quiltmc.loader.impl.launch.knot.KnotClient",
        "type": "release",
        "libraries": [
            {
                "name": format!("org.quiltmc:quilt-loader:{loader}"),
                "url": format!("{base}/maven/")
            },
            {
                "name": "net.fabricmc:intermediary:1.0",
                "downloads": {
                    "artifact": {
                        "url": format!("{base}/fabric-extra.jar"),
                        "sha1": sha1_hex(EXTRA_LIB),
                        "size": EXTRA_LIB.len()
                    }
                }
            }
        ]
    })
}

fn route_quilt(base: String) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    move |request: &Request| match request.path() {
        "/versions/loader/1.20.1" => ok(serde_json::to_vec(&quilt_entries()).unwrap()),
        "/versions/loader/1.20.1/0.24.0/profile/json" => {
            ok(serde_json::to_vec(&quilt_profile(&base, "1.20.1", "0.24.0", "1.20.1")).unwrap())
        }
        "/maven/org/quiltmc/quilt-loader/0.24.0/quilt-loader-0.24.0.jar" => {
            ok(QUILT_LOADER_LIB.to_vec())
        }
        "/client.jar" => ok(CLIENT_JAR.to_vec()),
        "/vanilla-lib.jar" => ok(VANILLA_LIB.to_vec()),
        "/fabric-extra.jar" => ok(EXTRA_LIB.to_vec()),
        _ => not_found(),
    }
}

async fn quilt_mock() -> Mock {
    let base = Arc::new(Mutex::new(String::new()));
    let cell = Arc::clone(&base);
    let mock = start_mock(move |request: &Request| {
        let origin = cell.lock().unwrap().clone();
        route_quilt(origin)(request)
    })
    .await;
    *base.lock().unwrap() = mock.base.clone();
    mock
}

fn installer(base: &str) -> LoaderInstaller {
    LoaderInstaller::new(base).with_endpoints(base, base, base)
}

/// Legt ein Profil ab, wie es eine frühere Installation hinterlassen hätte.
fn write_loader_profile(root: &Path, id: &str, minecraft: &str, library: &str) {
    let directory = root.join("versions").join(id);
    std::fs::create_dir_all(&directory).unwrap();
    let json = json!({
        "id": id,
        "inheritsFrom": minecraft,
        "mainClass": "example.Main",
        "libraries": [{"name": library, "url": "http://unused/maven/"}]
    });
    std::fs::write(
        directory.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&json).unwrap(),
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fabric_install_writes_profile_and_libraries() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let installed = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, None)
        .await
        .expect("Fabric-Installation");

    assert_eq!(installed.loader, Loader::Fabric);
    assert_eq!(installed.loader_version, "0.16.10");
    assert_eq!(installed.version_id, "fabric-loader-0.16.10-1.20.1");
    assert_eq!(installed.minecraft_version, "1.20.1");
    assert_eq!(installed.missing_libraries, 0);
    assert!(installed.library_files >= 3);
    assert!(!installed.used_installer);

    let profile_path = root
        .join("versions")
        .join(&installed.version_id)
        .join(format!("{}.json", installed.version_id));
    let profile: Value = serde_json::from_slice(&std::fs::read(&profile_path).unwrap()).unwrap();
    assert_eq!(profile["inheritsFrom"], "1.20.1");
    assert_eq!(profile["id"], installed.version_id);

    assert!(root
        .join("libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar")
        .is_file());
    assert!(root
        .join("libraries/net/fabricmc/intermediary/1.0/intermediary-1.0.jar")
        .is_file());

    // Die Instanz kann sich jetzt an das Profil binden.
    let manager = InstanceManager::new(root.join("instances"));
    manager.create("Fabric", None).unwrap();
    manager
        .set_version("Fabric", &installed.version_id)
        .unwrap();
    assert_eq!(
        manager.load("Fabric").unwrap().version_id.as_deref(),
        Some("fabric-loader-0.16.10-1.20.1")
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn quilt_install_writes_profile_and_detects_the_loader() {
    let mock = quilt_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let installed = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Quilt, None)
        .await
        .expect("Quilt-Installation");

    assert_eq!(installed.loader, Loader::Quilt);
    assert_eq!(installed.loader_version, "0.24.0");
    assert_eq!(installed.version_id, "quilt-loader-0.24.0-1.20.1");
    assert_eq!(installed.minecraft_version, "1.20.1");
    assert_eq!(installed.missing_libraries, 0);
    assert!(installed.library_files >= 3);
    assert!(!installed.used_installer);

    let profile_path = root
        .join("versions")
        .join(&installed.version_id)
        .join(format!("{}.json", installed.version_id));
    let profile: Value = serde_json::from_slice(&std::fs::read(&profile_path).unwrap()).unwrap();
    assert_eq!(profile["inheritsFrom"], "1.20.1");
    assert_eq!(profile["id"], installed.version_id);

    assert!(root
        .join("libraries/org/quiltmc/quilt-loader/0.24.0/quilt-loader-0.24.0.jar")
        .is_file());

    let detected = installed_loaders(&root).unwrap();
    let quilt = detected
        .iter()
        .find(|profile| profile.loader == Loader::Quilt)
        .expect("Quilt-Profil");
    assert_eq!(quilt.version_id, installed.version_id);
    assert_eq!(quilt.loader_version, "0.24.0");
    assert_eq!(quilt.minecraft_version, "1.20.1");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn fabric_install_is_idempotent() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let first = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, None)
        .await
        .unwrap();
    assert!(first.downloaded_bytes > 0);

    let second = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, None)
        .await
        .unwrap();
    assert_eq!(second.downloaded_bytes, 0);
    assert_eq!(second.missing_libraries, 0);

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn fabric_install_respects_a_pinned_loader_version() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let installed = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, Some("0.17.0-beta.1"))
        .await
        .unwrap();
    assert_eq!(installed.loader_version, "0.17.0-beta.1");
    assert_eq!(installed.version_id, "fabric-loader-0.17.0-beta.1-1.20.1");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn fabric_rejects_an_unknown_pin_without_writing_a_profile() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let error = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, Some("9.9.9"))
        .await
        .unwrap_err();

    assert!(matches!(error, LoaderError::UnknownFabricLoader { .. }));
    let entries = std::fs::read_dir(root.join("versions")).unwrap().count();
    assert_eq!(entries, 1, "nur die Basisversion darf existieren");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn fabric_rejects_a_profile_for_the_wrong_minecraft_version() {
    let mock =
        start_mock(|request: &Request| match request.path() {
            "/versions/loader/1.20.1" => ok(serde_json::to_vec(&fabric_entries()).unwrap()),
            "/versions/loader/1.20.1/0.16.10/profile/json" => ok(serde_json::to_vec(
                &fabric_profile("http://unused", "1.20.1", "0.16.10", "1.19.4"),
            )
            .unwrap()),
            _ => not_found(),
        })
        .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let error = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Fabric, None)
        .await
        .unwrap_err();
    assert!(matches!(error, LoaderError::ProfileMismatch { .. }));
    assert!(
        !root.join("versions/fabric-loader-0.16.10-1.20.1").exists(),
        "ein falsches Profil darf nicht geschrieben werden"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn missing_base_version_is_reported_before_any_download() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();

    for loader in [Loader::Fabric, Loader::NeoForge, Loader::Quilt] {
        let error = installer(&mock.base)
            .install(&root, "1.20.1", loader, None)
            .await
            .unwrap_err();
        assert!(
            matches!(error, LoaderError::MissingBaseVersion(ref version) if version == "1.20.1"),
            "unerwarteter Fehler: {error}"
        );
    }
    assert!(
        mock.paths().is_empty(),
        "ohne Basis darf nichts geladen werden: {:?}",
        mock.paths()
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn neoforge_reports_a_failed_installer_download() {
    let mock = start_mock(|request: &Request| {
        if request.path() == "/net/neoforged/neoforge/maven-metadata.xml" {
            return ok(br#"<metadata><versioning><versions>
                    <version>21.1.9</version>
                    <version>21.1.77</version>
                    <version>21.1.100-beta</version>
                    <version>21.2.1</version>
                </versions></versioning></metadata>"#
                .to_vec());
        }
        not_found()
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.21.1");

    let error = installer(&mock.base)
        .install(&root, "1.21.1", Loader::NeoForge, None)
        .await
        .unwrap_err();
    let text = error.to_string();
    assert!(
        text.contains("21.1.77"),
        "Fehler nennt die Version nicht: {text}"
    );
    assert!(
        text.contains("404"),
        "Fehler nennt den Status nicht: {text}"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn quilt_without_a_loader_offer_is_rejected_cleanly() {
    let mock = start_mock(|request: &Request| match request.path() {
        "/versions/loader/1.20.1" => ok(b"[]".to_vec()),
        _ => not_found(),
    })
    .await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");

    let error = installer(&mock.base)
        .install(&root, "1.20.1", Loader::Quilt, None)
        .await
        .unwrap_err();
    assert!(matches!(error, LoaderError::NoQuiltLoader(_)));
    assert!(
        !root.join("versions/quilt-loader-0.24.0-1.20.1").exists(),
        "ohne Angebot darf kein Profil entstehen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn detects_installed_fabric_and_neoforge_profiles() {
    let root = temp_root();
    write_base_version(&root, "http://unused", "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );
    write_loader_profile(
        &root,
        "neoforge-21.1.9",
        "1.21.1",
        "net.neoforged:fancymodloader:1.0",
    );

    let profiles = installed_loaders(&root).unwrap();
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles[0].loader, Loader::Fabric);
    assert_eq!(profiles[0].loader_version, "0.16.9");
    assert_eq!(profiles[0].minecraft_version, "1.20.1");
    assert_eq!(profiles[0].version_id, "fabric-loader-0.16.9-1.20.1");
    assert_eq!(profiles[1].loader, Loader::NeoForge);
    assert_eq!(profiles[1].loader_version, "21.1.9");
    assert_eq!(profiles[1].minecraft_version, "1.21.1");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn update_all_upgrades_fabric_and_retargets_instances() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );
    let manager = InstanceManager::new(root.join("instances"));
    manager
        .create("Test", Some("fabric-loader-0.16.9-1.20.1"))
        .unwrap();

    let updates = installer(&mock.base)
        .update_all(&root, None, Some(Loader::Fabric))
        .await
        .unwrap();
    assert_eq!(updates.len(), 1);
    let update = &updates[0];
    assert_eq!(update.latest.as_deref(), Some("0.16.10"));
    assert!(update.update_available);
    let applied = update.applied.as_ref().expect("Installation ausgeführt");
    assert_eq!(applied.version_id, "fabric-loader-0.16.10-1.20.1");
    assert_eq!(update.retargeted_instances, vec!["Test".to_string()]);
    assert_eq!(
        manager.load("Test").unwrap().version_id.as_deref(),
        Some("fabric-loader-0.16.10-1.20.1")
    );
    assert!(root
        .join("versions/fabric-loader-0.16.10-1.20.1/fabric-loader-0.16.10-1.20.1.json")
        .is_file());

    // Das alte Profil bleibt liegen, wird aber nicht mehr als veraltet gemeldet.
    let again = installer(&mock.base)
        .update_all(&root, None, None)
        .await
        .unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].installed.loader_version, "0.16.10");
    assert!(!again[0].update_available);
    assert!(again[0].applied.is_none());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn update_all_keeps_current_profiles_untouched() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.10-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.10",
    );

    let updates = installer(&mock.base)
        .update_all(&root, None, None)
        .await
        .unwrap();
    assert_eq!(updates.len(), 1);
    assert!(!updates[0].update_available);
    assert!(updates[0].applied.is_none());
    assert!(updates[0].retargeted_instances.is_empty());
    assert!(
        !mock
            .paths()
            .iter()
            .any(|path| path.contains("profile/json")),
        "ohne Update darf kein Profil geladen werden: {:?}",
        mock.paths()
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn update_all_does_not_downgrade_a_prerelease() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.17.0-beta.1-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.17.0-beta.1",
    );

    let updates = installer(&mock.base)
        .update_all(&root, None, None)
        .await
        .unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].latest.as_deref(), Some("0.16.10"));
    assert!(!updates[0].update_available);
    assert!(updates[0].applied.is_none());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn check_updates_reports_without_installing() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );

    let updates = installer(&mock.base)
        .check_updates(&root, None, None)
        .await
        .unwrap();
    assert_eq!(updates.len(), 1);
    assert!(updates[0].update_available);
    assert!(updates[0].applied.is_none());
    assert!(!root.join("versions/fabric-loader-0.16.10-1.20.1").exists());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn launch_hint_finds_updates_even_for_superseded_profiles() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );
    write_loader_profile(
        &root,
        "fabric-loader-0.16.10-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.10",
    );

    // Das alte Profil ist ersetzt, eine Instanz kann aber noch daran hängen.
    let hint = installer(&mock.base)
        .check_update_for(&root, "fabric-loader-0.16.9-1.20.1")
        .await
        .unwrap()
        .expect("Hinweis für altes Profil");
    assert_eq!(hint.latest.as_deref(), Some("0.16.10"));
    assert!(hint.update_available);
    assert!(hint.applied.is_none());

    // Das aktuelle Profil löst keinen Hinweis aus.
    assert!(installer(&mock.base)
        .check_update_for(&root, "fabric-loader-0.16.10-1.20.1")
        .await
        .unwrap()
        .is_none());

    // Vanilla und unbekannte IDs bleiben still, ohne Anfrage.
    assert!(installer(&mock.base)
        .check_update_for(&root, "1.20.1")
        .await
        .unwrap()
        .is_none());
    assert!(installer(&mock.base)
        .check_update_for(&root, "gibt-es-nicht")
        .await
        .unwrap()
        .is_none());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn update_profile_changes_only_the_offered_profile() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.8-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.8",
    );
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );
    let manager = InstanceManager::new(root.join("instances"));
    manager
        .create("Old", Some("fabric-loader-0.16.9-1.20.1"))
        .unwrap();
    manager
        .create("Other", Some("fabric-loader-0.16.8-1.20.1"))
        .unwrap();

    let update = installer(&mock.base)
        .update_profile(&root, "fabric-loader-0.16.9-1.20.1")
        .await
        .unwrap()
        .expect("angebotenes Update wird installiert");
    assert_eq!(
        update.applied.as_ref().unwrap().version_id,
        "fabric-loader-0.16.10-1.20.1"
    );
    assert_eq!(update.retargeted_instances, vec!["Old".to_string()]);
    assert_eq!(
        manager.load("Old").unwrap().version_id.as_deref(),
        Some("fabric-loader-0.16.10-1.20.1")
    );
    assert_eq!(
        manager.load("Other").unwrap().version_id.as_deref(),
        Some("fabric-loader-0.16.8-1.20.1"),
        "andere Profile dürfen nicht angefasst werden"
    );
    assert!(root
        .join("versions/fabric-loader-0.16.8-1.20.1/fabric-loader-0.16.8-1.20.1.json")
        .is_file());

    assert!(installer(&mock.base)
        .update_profile(&root, "fabric-loader-0.16.10-1.20.1")
        .await
        .unwrap()
        .is_none());
    assert!(installer(&mock.base)
        .update_profile(&root, "1.20.1")
        .await
        .unwrap()
        .is_none());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn update_filters_skip_other_versions_without_network_calls() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    write_base_version(&root, &mock.base, "1.20.1");
    write_loader_profile(
        &root,
        "fabric-loader-0.16.9-1.20.1",
        "1.20.1",
        "net.fabricmc:fabric-loader:0.16.9",
    );

    let updates = installer(&mock.base)
        .check_updates(&root, Some("1.19.4"), None)
        .await
        .unwrap();
    assert!(updates.is_empty());
    assert!(mock.paths().is_empty(), "Filter darf nichts anfragen");

    let updates = installer(&mock.base)
        .check_updates(&root, None, Some(Loader::NeoForge))
        .await
        .unwrap();
    assert!(updates.is_empty());
    assert!(mock.paths().is_empty());

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn neoforge_update_check_reads_the_maven_metadata() {
    let mock = start_mock(|request: &Request| {
        if request.path() == "/net/neoforged/neoforge/maven-metadata.xml" {
            return ok(br#"<metadata><versioning><versions>
                    <version>21.1.9</version>
                    <version>21.1.77</version>
                    <version>21.1.100-beta</version>
                </versions></versioning></metadata>"#
                .to_vec());
        }
        not_found()
    })
    .await;

    let root = temp_root();
    write_base_version(&root, &mock.base, "1.21.1");
    write_loader_profile(
        &root,
        "neoforge-21.1.9",
        "1.21.1",
        "net.neoforged:fancymodloader:1.0",
    );

    let updates = installer(&mock.base)
        .check_updates(&root, Some("1.21.1"), Some(Loader::NeoForge))
        .await
        .unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].latest.as_deref(), Some("21.1.77"));
    assert!(updates[0].update_available);
    assert!(updates[0].applied.is_none());
    assert_eq!(
        mock.paths(),
        vec!["/net/neoforged/neoforge/maven-metadata.xml".to_string()],
        "die Prüfung darf keinen Installer anfassen"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn rejects_unsafe_minecraft_versions() {
    let (mock, _base) = fabric_mock().await;
    let root = temp_root();
    let error = installer(&mock.base)
        .install(&root, "../1.20.1", Loader::Fabric, None)
        .await
        .unwrap_err();
    assert!(matches!(error, LoaderError::InvalidVersion(_)));
    let _ = std::fs::remove_dir_all(&root);
}
