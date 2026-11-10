//! Mod-Verwaltung gegen einen lokalen Mock-Server: API-Parsing, Auflösung der
//! Abhängigkeiten, Download und Bestandsdatei.

use bamboo_launcher::download::{sha1_hex, Downloader};
use bamboo_launcher::instances::Instance;
use bamboo_launcher::mods::{
    install_plan, plan_install, CurseForgeClient, Loader, ModError, ModLedger, ModProvider,
    ModSource, ModTarget, ModrinthClient, ResolveOptions, SearchQuery,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

// ---------------------------------------------------------------------------
// Mock-Server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
}

impl Request {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }

    fn query(&self, name: &str) -> Option<String> {
        let url = reqwest::Url::parse(&format!("http://localhost{}", self.target)).ok()?;
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_string())
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    fn origin(&self) -> String {
        format!("http://{}", self.header("host").unwrap_or("127.0.0.1"))
    }
}

struct Response {
    status: u16,
    body: Vec<u8>,
}

fn ok(value: Value) -> Response {
    Response {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    }
}

fn bytes(body: &[u8]) -> Response {
    Response {
        status: 200,
        body: body.to_vec(),
    }
}

fn status(code: u16) -> Response {
    Response {
        status: code,
        body: Vec::new(),
    }
}

struct Mock {
    base: String,
    seen: Arc<Mutex<Vec<Request>>>,
    handle: JoinHandle<()>,
}

impl Mock {
    fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }

    fn paths(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|request| request.path().to_string())
            .collect()
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
                let mut lines = text.lines();
                let mut first = lines.next().unwrap_or("").split_whitespace();
                let request = Request {
                    method: first.next().unwrap_or("GET").to_string(),
                    target: first.next().unwrap_or("/").to_string(),
                    headers: lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(key, value)| {
                            (key.trim().to_ascii_lowercase(), value.trim().to_string())
                        })
                        .collect(),
                };
                recorded.lock().unwrap().push(request.clone());
                let response = route(&request);
                let head = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.status,
                    reason(response.status),
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

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

fn temp_root() -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "bamboo-mod-test-{}-{}-{id}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("mods")).unwrap();
    dir
}

fn instance(dir: &Path) -> Instance {
    Instance {
        name: "Test".to_string(),
        dir: dir.to_path_buf(),
        version_id: Some("1.20.1".to_string()),
    }
}

fn target() -> ModTarget {
    ModTarget::new("1.20.1", Some(Loader::Fabric))
}

fn modrinth_version(
    origin: &str,
    id: &str,
    project: &str,
    file_name: &str,
    body: &[u8],
    dependencies: Vec<Value>,
) -> Value {
    json!({
        "id": id,
        "project_id": project,
        "name": format!("{project} {id}"),
        "version_number": format!("{id}+1.20.1"),
        "version_type": "release",
        "date_published": "2025-01-01T00:00:00Z",
        "game_versions": ["1.20.1"],
        "loaders": ["fabric"],
        "files": [{
            "url": format!("{origin}/files/{file_name}"),
            "filename": file_name,
            "size": body.len(),
            "hashes": {"sha1": sha1_hex(body)},
            "primary": true
        }],
        "dependencies": dependencies
    })
}

fn required(project: &str) -> Value {
    json!({"project_id": project, "version_id": null, "dependency_type": "required"})
}

fn required_version(project: &str, version: &str) -> Value {
    json!({"project_id": project, "version_id": version, "dependency_type": "required"})
}

// ---------------------------------------------------------------------------
// Modrinth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn modrinth_search_sends_loader_and_version_facets() {
    let mock = start_mock(|request| match request.path() {
        "/search" => ok(json!({
            "hits": [{
                "project_id": "AANobbMI",
                "slug": "sodium",
                "title": "Sodium",
                "description": "Schnelleres Rendering",
                "downloads": 249390788,
                "author": "jellysquid3"
            }],
            "total_hits": 1,
            "offset": 0
        })),
        _ => status(404),
    })
    .await;

    let client = ModrinthClient::with_base(&mock.base).unwrap();
    let page = client
        .search(&SearchQuery {
            text: "sodium".to_string(),
            target: Some(target()),
            limit: 5,
            offset: 0,
        })
        .await
        .unwrap();

    assert_eq!(page.total, 1);
    assert_eq!(page.hits[0].slug, "sodium");
    assert_eq!(page.hits[0].source, ModSource::Modrinth);

    let requests = mock.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].query("query").as_deref(), Some("sodium"));
    assert_eq!(requests[0].query("limit").as_deref(), Some("5"));
    assert_eq!(
        requests[0].query("facets").as_deref(),
        Some(r#"[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]"#)
    );
}

#[tokio::test]
async fn modrinth_resolves_pinned_dependency_and_installs_both() {
    let iris_body = b"iris-jar";
    let sodium_body = b"sodium-jar";

    let mock = start_mock(move |request| {
        let origin = request.origin();
        match request.path() {
            "/project/iris/version" => ok(json!([modrinth_version(
                &origin,
                "iris-v1",
                "YL57xq9U",
                "iris-1.0.jar",
                iris_body,
                vec![required_version("AANobbMI", "sodium-v1")]
            )])),
            "/version/sodium-v1" => ok(modrinth_version(
                &origin,
                "sodium-v1",
                "AANobbMI",
                "sodium-1.0.jar",
                sodium_body,
                Vec::new(),
            )),
            "/files/iris-1.0.jar" => bytes(iris_body),
            "/files/sodium-1.0.jar" => bytes(sodium_body),
            _ => status(404),
        }
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let root = temp_root();
    let instance = instance(&root);
    let plan = plan_install(
        &provider,
        "iris",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    assert_eq!(plan.mods.len(), 2);
    assert_eq!(plan.mods[0].version.project_id, "YL57xq9U");
    assert_eq!(plan.mods[1].version.project_id, "AANobbMI");
    assert_eq!(plan.mods[1].depth, 1);
    assert_eq!(plan.mods[1].required_by, vec!["YL57xq9U".to_string()]);
    assert!(plan.unresolved.is_empty());

    let mut ledger = ModLedger::default();
    let report = install_plan(&provider, &instance, &plan, &Downloader::new(), &mut ledger)
        .await
        .unwrap();
    assert_eq!(report.download.downloaded, 2);
    assert_eq!(
        std::fs::read(root.join("mods").join("iris-1.0.jar")).unwrap(),
        iris_body
    );
    assert_eq!(
        std::fs::read(root.join("mods").join("sodium-1.0.jar")).unwrap(),
        sodium_body
    );

    let saved = ModLedger::load(&root).unwrap();
    assert_eq!(saved.mods.len(), 2);
    let sodium = saved.find("AANobbMI").unwrap();
    assert_eq!(sodium.file_name, "sodium-1.0.jar");
    assert_eq!(sodium.source, ModSource::Modrinth);
    assert_eq!(sodium.required_by, vec!["YL57xq9U".to_string()]);

    // Zweiter Lauf: Abhängigkeit gilt als installiert, die JAR wird nur geprüft.
    let installed = saved.installed_projects(&root);
    let again = plan_install(
        &provider,
        "iris",
        None,
        &ResolveOptions::new(target()),
        &installed,
    )
    .await
    .unwrap();
    assert_eq!(again.mods.len(), 1);
    assert!(again.notes.iter().any(|note| matches!(
        note,
        bamboo_launcher::mods::PlanNote::AlreadyInstalled { project, .. } if project == "AANobbMI"
    )));

    let mut ledger = saved;
    let report = install_plan(
        &provider,
        &instance,
        &again,
        &Downloader::new(),
        &mut ledger,
    )
    .await
    .unwrap();
    assert_eq!(report.download.downloaded, 0);
    assert_eq!(report.download.skipped, 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn resolver_survives_dependency_cycles() {
    let body = b"jar";
    let mock = start_mock(move |request| {
        let origin = request.origin();
        match request.path() {
            "/project/a/version" => ok(json!([modrinth_version(
                &origin,
                "a1",
                "a",
                "a.jar",
                body,
                vec![required("b")]
            )])),
            "/project/b/version" => ok(json!([modrinth_version(
                &origin,
                "b1",
                "b",
                "b.jar",
                body,
                vec![required("a")]
            )])),
            _ => status(404),
        }
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    assert_eq!(plan.mods.len(), 2);
    let a = plan
        .mods
        .iter()
        .find(|planned| planned.version.project_id == "a")
        .unwrap();
    assert_eq!(a.required_by, vec!["b".to_string()]);
    assert!(plan.unresolved.is_empty());
}

#[tokio::test]
async fn resolver_reports_missing_required_dependency_before_downloading() {
    let mock = start_mock(move |request| {
        let origin = request.origin();
        match request.path() {
            "/project/a/version" => ok(json!([modrinth_version(
                &origin,
                "a1",
                "a",
                "a.jar",
                b"jar",
                vec![required("verschwunden")]
            )])),
            _ => status(404),
        }
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let root = temp_root();
    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    assert_eq!(plan.unresolved.len(), 1);
    assert_eq!(plan.unresolved[0].project.as_deref(), Some("verschwunden"));

    let mut ledger = ModLedger::default();
    let error = install_plan(
        &provider,
        &instance(&root),
        &plan,
        &Downloader::new(),
        &mut ledger,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, ModError::UnresolvedDependencies(_)));
    assert!(!mock.paths().iter().any(|path| path.starts_with("/files/")));
    assert!(!root.join("mods").join("a.jar").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn resolver_skips_optional_and_embedded_dependencies() {
    let mock = start_mock(move |request| {
        let origin = request.origin();
        match request.path() {
            "/project/a/version" => ok(json!([modrinth_version(
                &origin,
                "a1",
                "a",
                "a.jar",
                b"jar",
                vec![
                    json!({"project_id": "opt", "dependency_type": "optional"}),
                    json!({"project_id": "emb", "dependency_type": "embedded"}),
                ]
            )])),
            _ => status(404),
        }
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    assert_eq!(plan.mods.len(), 1);
    assert_eq!(plan.notes.len(), 2);
    assert!(!mock
        .paths()
        .iter()
        .any(|path| path == "/project/opt/version" || path == "/project/emb/version"));
}

#[tokio::test]
async fn resolver_rejects_a_version_from_another_project() {
    let mock = start_mock(|request| match request.path() {
        "/project/iris" => ok(json!({
            "id": "YL57xq9U",
            "slug": "iris",
            "title": "Iris",
            "description": "Shader",
            "downloads": 1
        })),
        "/version/fremd" => ok(json!({
            "id": "fremd",
            "project_id": "ANDERES",
            "files": [{"url": "http://localhost/never.jar", "filename": "never.jar"}]
        })),
        _ => status(404),
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let error = plan_install(
        &provider,
        "iris",
        Some("fremd"),
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, ModError::ProjectMismatch { .. }));
}

#[tokio::test]
async fn install_rejects_path_traversal_in_a_file_name() {
    let mock = start_mock(move |request| {
        let origin = request.origin();
        match request.path() {
            "/project/a/version" => ok(json!([modrinth_version(
                &origin,
                "a1",
                "a",
                "../evil.jar",
                b"jar",
                Vec::new()
            )])),
            _ => status(404),
        }
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let root = temp_root();
    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    let error = install_plan(
        &provider,
        &instance(&root),
        &plan,
        &Downloader::new(),
        &mut ModLedger::default(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, ModError::UnsafeFileName(_)));
    assert!(!root.join("evil.jar").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn install_fails_cleanly_on_checksum_mismatch() {
    let mock = start_mock(|request| match request.path() {
        "/project/a/version" => ok(json!([{
            "id": "a1",
            "project_id": "a",
            "files": [{
                "url": format!("{}/files/a.jar", request.origin()),
                "filename": "a.jar",
                "hashes": {"sha1": "0000000000000000000000000000000000000000"}
            }]
        }])),
        "/files/a.jar" => bytes(b"falscher-inhalt"),
        _ => status(404),
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let root = temp_root();
    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();

    let result = install_plan(
        &provider,
        &instance(&root),
        &plan,
        &Downloader::new(),
        &mut ModLedger::default(),
    )
    .await;
    assert!(result.is_err());
    assert!(!root.join("mods").join("a.jar").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn install_replaces_the_previous_file_of_the_same_project() {
    let body = b"neue-version";
    let mock = start_mock(move |request| match request.path() {
        "/project/a/version" => ok(json!([modrinth_version(
            &request.origin(),
            "a2",
            "a",
            "a-2.jar",
            body,
            Vec::new()
        )])),
        "/files/a-2.jar" => bytes(body),
        _ => status(404),
    })
    .await;

    let provider = ModrinthClient::with_base(&mock.base).unwrap();
    let root = temp_root();
    std::fs::write(root.join("mods").join("a-1.jar"), b"alte-version").unwrap();

    let mut ledger = ModLedger::default();
    ledger.upsert(bamboo_launcher::mods::ModRecord {
        file_name: "a-1.jar".to_string(),
        source: ModSource::Modrinth,
        project_id: "a".to_string(),
        version_id: "a1".to_string(),
        version_number: "1.0".to_string(),
        installed_at: 1,
        required_by: Vec::new(),
    });

    let plan = plan_install(
        &provider,
        "a",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();
    install_plan(
        &provider,
        &instance(&root),
        &plan,
        &Downloader::new(),
        &mut ledger,
    )
    .await
    .unwrap();

    assert!(!root.join("mods").join("a-1.jar").exists());
    assert_eq!(
        std::fs::read(root.join("mods").join("a-2.jar")).unwrap(),
        body
    );
    assert_eq!(ledger.find("a").unwrap().file_name, "a-2.jar");
    std::fs::remove_dir_all(root).unwrap();
}

// ---------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------

#[tokio::test]
async fn curseforge_requires_an_api_key() {
    assert!(matches!(
        CurseForgeClient::new(None),
        Err(ModError::MissingApiKey)
    ));
    assert!(matches!(
        CurseForgeClient::new(Some("   ".to_string())),
        Err(ModError::MissingApiKey)
    ));
}

#[tokio::test]
async fn curseforge_search_sends_key_and_filters() {
    let mock = start_mock(|request| match request.path() {
        "/mods/search" => ok(json!({
            "data": [{
                "id": 394468,
                "name": "Sodium",
                "slug": "sodium",
                "summary": "Schneller",
                "downloadCount": 1234,
                "authors": [{"name": "jellysquid3"}]
            }],
            "pagination": {"totalCount": 1}
        })),
        _ => status(404),
    })
    .await;

    let client = CurseForgeClient::with_base(Some("test-key".to_string()), &mock.base).unwrap();
    let page = client
        .search(&SearchQuery {
            text: "sodium".to_string(),
            target: Some(target()),
            limit: 10,
            offset: 0,
        })
        .await
        .unwrap();

    assert_eq!(page.hits[0].id, "394468");
    assert_eq!(page.hits[0].author.as_deref(), Some("jellysquid3"));
    let requests = mock.requests();
    let request = &requests[0];
    assert_eq!(request.header("x-api-key"), Some("test-key"));
    assert_eq!(request.query("gameId").as_deref(), Some("432"));
    assert_eq!(request.query("classId").as_deref(), Some("6"));
    assert_eq!(request.query("gameVersion").as_deref(), Some("1.20.1"));
    assert_eq!(request.query("modLoaderType").as_deref(), Some("4"));
}

#[tokio::test]
async fn curseforge_falls_back_to_the_cdn_and_installs() {
    let body = b"curseforge-jar";
    let mock = start_mock(move |request| match request.path() {
        "/mods/123/files" => ok(json!({
            "data": [{
                "id": 238222,
                "modId": 123,
                "displayName": "Example 1.0",
                "fileName": "example-1.0.jar",
                "releaseType": 1,
                "fileDate": "2025-01-01T00:00:00Z",
                "fileLength": body.len(),
                "downloadUrl": null,
                "gameVersions": ["1.20.1", "Fabric"],
                "dependencies": [],
                "hashes": [{"value": sha1_hex(body), "algo": 1}],
                "isAvailable": true
            }]
        })),
        "/mods/123/files/238222/download-url" => status(403),
        "/mods/123" => ok(json!({"data": {"id": 123, "allowModDistribution": true}})),
        "/files/238/222/example-1.0.jar" => bytes(body),
        _ => status(404),
    })
    .await;

    let cdn = format!("{}/files", mock.base);
    let client = CurseForgeClient::with_base(Some("key".to_string()), &mock.base)
        .unwrap()
        .with_cdn_base(cdn);

    let root = temp_root();
    let plan = plan_install(
        &client,
        "123",
        None,
        &ResolveOptions::new(target()),
        &HashSet::new(),
    )
    .await
    .unwrap();
    assert_eq!(plan.mods.len(), 1);

    let mut ledger = ModLedger::default();
    install_plan(
        &client,
        &instance(&root),
        &plan,
        &Downloader::new(),
        &mut ledger,
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read(root.join("mods").join("example-1.0.jar")).unwrap(),
        body
    );
    assert!(mock
        .paths()
        .iter()
        .any(|path| path == "/files/238/222/example-1.0.jar"));
    assert_eq!(ledger.find("123").unwrap().source, ModSource::CurseForge);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn curseforge_blocks_download_without_distribution_permission() {
    let mock = start_mock(|request| match request.path() {
        "/mods/123/files/238222/download-url" => status(403),
        "/mods/123" => ok(json!({"data": {"id": 123, "allowModDistribution": false}})),
        _ => status(404),
    })
    .await;

    let client = CurseForgeClient::with_base(Some("key".to_string()), &mock.base).unwrap();
    let version = bamboo_launcher::mods::Version {
        source: ModSource::CurseForge,
        id: "238222".to_string(),
        project_id: "123".to_string(),
        name: "Example".to_string(),
        version_number: "1.0".to_string(),
        channel: bamboo_launcher::mods::ReleaseChannel::Release,
        published_at: None,
        game_versions: vec!["1.20.1".to_string()],
        loaders: vec!["fabric".to_string()],
        file: bamboo_launcher::mods::ModFile {
            file_name: "example.jar".to_string(),
            url: None,
            sha1: None,
            size: None,
            file_id: Some("238222".to_string()),
            primary: true,
        },
        dependencies: Vec::new(),
    };

    let error = client.download(&version).await.unwrap_err();
    assert!(matches!(error, ModError::DistributionBlocked(_)));
}

// ---------------------------------------------------------------------------
// Erkennung installierter Dateien
// ---------------------------------------------------------------------------

#[tokio::test]
async fn identify_resolves_installed_files_through_both_sources() {
    use bamboo_launcher::mods::identify::{
        curseforge_fingerprint, identify_at, Candidate, IdentifyBases,
    };

    let mock = start_mock(|request| match (request.method.as_str(), request.path()) {
        ("POST", "/version_files") => ok(json!({
            "aaaa": {"project_id": "AANobbMI", "version_number": "0.6.9"}
        })),
        ("GET", "/projects") => ok(json!([{
            "id": "AANobbMI",
            "slug": "sodium",
            "title": "Sodium",
            "icon_url": "https://cdn.modrinth.com/data/AANobbMI/icon.png"
        }])),
        ("POST", "/v1/fingerprints") => ok(json!({
            "data": {
                "exactMatches": [{
                    "file": {
                        "fileName": "cfmod.jar",
                        "modId": 238222,
                        "displayName": "JEI 15.2.0"
                    }
                }]
            }
        })),
        ("POST", "/v1/mods") => ok(json!({
            "data": [{
                "id": 238222,
                "name": "Just Enough Items",
                "slug": "jei",
                "logo": {"thumbnailUrl": "https://media.forgecdn.net/jei.png", "url": ""}
            }]
        })),
        _ => status(404),
    })
    .await;

    let cf_body = b"ein fingeprint-barer inhalt";
    let candidates = vec![
        Candidate {
            file_name: "sodium.jar".to_string(),
            sha1: "aaaa".to_string(),
            fingerprint: 1,
        },
        Candidate {
            file_name: "cfmod.jar".to_string(),
            sha1: "bbbb".to_string(),
            fingerprint: curseforge_fingerprint(cf_body),
        },
    ];
    let bases = IdentifyBases {
        modrinth: mock.base.clone(),
        curseforge: format!("{}/v1", mock.base),
    };

    let found = identify_at(&candidates, Some("key".to_string()), &bases).await;

    let sodium = found.get("sodium.jar").expect("Modrinth-Treffer fehlt");
    assert_eq!(sodium.source, "modrinth");
    assert_eq!(sodium.project_id, "AANobbMI");
    assert_eq!(sodium.name, "Sodium");
    assert_eq!(sodium.version_number, "0.6.9");
    assert!(sodium.icon_url.ends_with("icon.png"));

    let jei = found.get("cfmod.jar").expect("CurseForge-Treffer fehlt");
    assert_eq!(jei.source, "curseforge");
    assert_eq!(jei.project_id, "238222");
    assert_eq!(jei.slug, "jei");
    assert_eq!(jei.name, "Just Enough Items");
    assert_eq!(jei.version_number, "JEI 15.2.0");
    assert!(jei.icon_url.ends_with("jei.png"));

    // Beide Quellen wurden mit dem richtigen Verb angesprochen, CurseForge
    // bekommt seinen Key als Header.
    let requests = mock.requests();
    let post_paths: Vec<&str> = requests
        .iter()
        .filter(|request| request.method == "POST")
        .map(|request| request.path())
        .collect();
    assert!(post_paths.contains(&"/version_files"));
    assert!(post_paths.contains(&"/v1/fingerprints"));
    let fingerprint_request = requests
        .iter()
        .find(|request| request.path() == "/v1/fingerprints")
        .unwrap();
    assert_eq!(fingerprint_request.header("x-api-key"), Some("key"));
}

#[tokio::test]
async fn identify_without_api_key_skips_curseforge_but_keeps_modrinth() {
    use bamboo_launcher::mods::identify::{identify_at, Candidate, IdentifyBases};

    let mock = start_mock(|request| match (request.method.as_str(), request.path()) {
        ("POST", "/version_files") => ok(json!({})),
        _ => status(404),
    })
    .await;

    let candidates = vec![Candidate {
        file_name: "unbekannt.jar".to_string(),
        sha1: "cccc".to_string(),
        fingerprint: 7,
    }];
    let bases = IdentifyBases {
        modrinth: mock.base.clone(),
        curseforge: format!("{}/v1", mock.base),
    };

    let found = identify_at(&candidates, None, &bases).await;
    assert!(found.is_empty());
    // Ohne Key darf gar keine CurseForge-Anfrage rausgehen.
    assert!(!mock.paths().iter().any(|path| path.starts_with("/v1")));
}

#[tokio::test]
async fn update_check_batches_known_files_and_reports_the_newer_version() {
    use bamboo_launcher::mods::updates::check_at;
    use bamboo_launcher::mods::Loader;

    let mock = start_mock(|request| match (request.method.as_str(), request.path()) {
        ("POST", "/version_files") => ok(json!({
            "aaaa": {"id": "v1", "version_number": "1.0", "project_id": "AANobbMI"},
            "bbbb": {"id": "v2", "version_number": "1.0", "project_id": "P7dR8mSH"}
        })),
        ("POST", "/version_files/update") => ok(json!({
            "bbbb": {
                "id": "v3",
                "version_number": "2.0",
                "game_versions": ["1.20.1"],
                "loaders": ["Fabric"],
                "files": [
                    {"filename": "sources.jar", "url": "https://cdn/sources.jar", "primary": false},
                    {"filename": "jei-2.0.jar", "url": "https://cdn/jei-2.0.jar", "primary": true}
                ]
            }
        })),
        _ => status(404),
    })
    .await;

    let files = vec![
        ("sodium.jar".to_string(), "aaaa".to_string()),
        ("jei.jar".to_string(), "bbbb".to_string()),
        // Unbekannt: bleibt offen, damit die Oberfläche einzeln nachfragt.
        ("eigen.jar".to_string(), "cccc".to_string()),
    ];
    let report = check_at(&files, Some("1.20.1"), Some(Loader::Fabric), &mock.base)
        .await
        .unwrap();

    assert_eq!(report.resolved, vec!["sodium.jar".to_string()]);
    assert_eq!(report.updates.len(), 1);
    let update = &report.updates[0];
    assert_eq!(update.file, "jei.jar");
    assert_eq!(update.version_number, "2.0");
    assert_eq!(update.version_id, "v3");
    // Die Primärdatei gewinnt, nicht die Quellen.
    assert_eq!(update.file_name, "jei-2.0.jar");
    assert_eq!(update.url, "https://cdn/jei-2.0.jar");
    assert_eq!(update.loaders, vec!["fabric".to_string()]);

    // Zwei Anfragen für drei Dateien statt einer pro Datei.
    let paths = mock.paths();
    assert_eq!(paths.iter().filter(|path| *path == "/version_files").count(), 1);
    assert_eq!(paths.iter().filter(|path| *path == "/version_files/update").count(), 1);
}

#[tokio::test]
async fn update_check_needs_no_request_without_hashes() {
    use bamboo_launcher::mods::updates::check_at;

    let mock = start_mock(|request| match request.path() {
        _ => status(404),
    })
    .await;

    let report = check_at(&[], None, None, &mock.base).await.unwrap();
    assert!(report.resolved.is_empty());
    assert!(report.updates.is_empty());
    assert!(mock.paths().is_empty());
}
