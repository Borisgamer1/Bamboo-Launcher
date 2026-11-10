//! Prüft das automatische Laden beim Start: gültige Sitzung ohne Netz,
//! abgelaufene Sitzung mit stillem Refresh, toter Refresh-Token räumt auf.

use bamboo_launcher::auth::{AuthConfig, AuthEndpoints, MicrosoftAuth};
use bamboo_launcher::launcher::UserType;
use bamboo_launcher::token_store::{
    now_ms, MemoryStore, SecretStore, SessionManager, StoredSession,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// Mock-Server
// ---------------------------------------------------------------------------

struct Mock {
    base: String,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

impl Mock {
    fn body_for(&self, path: &str) -> String {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .find(|(recorded, _)| recorded == path)
            .map(|(_, body)| body.clone())
            .unwrap_or_default()
    }
}

fn header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
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

        if let Some(position) = header_end(&buffer) {
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

async fn start_mock(routes: Vec<(&'static str, u16, Value)>) -> Mock {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);

    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let Some((head, body)) = read_request(&mut stream).await else {
                continue;
            };
            let path = head
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/")
                .to_string();
            recorded.lock().unwrap().push((path.clone(), body));

            let (status, payload) = match routes.iter().find(|(route, _, _)| *route == path) {
                Some((_, status, payload)) => (*status, payload.to_string()),
                None => (404, json!({ "error": "not found" }).to_string()),
            };
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.flush().await;
        }
    });

    Mock { base, requests }
}

fn auth_for(base: &str) -> MicrosoftAuth {
    MicrosoftAuth::with_config(AuthConfig {
        endpoints: AuthEndpoints {
            authority: base.to_string(),
            xbox_user: format!("{base}/user/authenticate"),
            xsts: format!("{base}/xsts/authorize"),
            minecraft_login: format!("{base}/authentication/login_with_xbox"),
            minecraft_profile: format!("{base}/minecraft/profile"),
        },
        ..AuthConfig::default()
    })
}

/// Erreichbar, aber niemand hört zu: jeder Netzwerkaufruf scheitert sofort.
fn unreachable_auth() -> MicrosoftAuth {
    auth_for("http://127.0.0.1:1")
}

fn refresh_chain() -> Vec<(&'static str, u16, Value)> {
    vec![
        (
            "/token",
            200,
            json!({
                "access_token": "ms-token-new",
                "refresh_token": "refresh-new",
                "expires_in": 3600
            }),
        ),
        (
            "/user/authenticate",
            200,
            json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [{ "uhs": "uhs-1" }] }
            }),
        ),
        ("/xsts/authorize", 200, json!({ "Token": "xsts-token" })),
        (
            "/authentication/login_with_xbox",
            200,
            json!({ "access_token": "mc-token-new" }),
        ),
        (
            "/minecraft/profile",
            200,
            json!({ "id": "0123456789abcdef0123456789abcdef", "name": "TestUser" }),
        ),
    ]
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

const UUID: &str = "0123456789abcdef0123456789abcdef";

fn session(expires_at: u64, refresh: Option<&str>) -> StoredSession {
    StoredSession {
        username: "AltUser".to_string(),
        uuid: UUID.to_string(),
        minecraft_access_token: "mc-token-alt".to_string(),
        minecraft_expires_at: expires_at,
        microsoft_access_token: "ms-token-alt".to_string(),
        microsoft_refresh_token: refresh.map(str::to_string),
        microsoft_expires_at: 1,
    }
}

fn seed(store: &MemoryStore, session: &StoredSession) {
    store
        .write(&serde_json::to_string(session).unwrap())
        .unwrap();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn valid_session_restores_without_any_network_call() {
    let store = MemoryStore::new();
    seed(&store, &session(now_ms() + 3_600_000, Some("refresh-alt")));
    let manager = SessionManager::new(store);

    let restored = manager
        .restore(&unreachable_auth())
        .await
        .expect("gültige Sitzung darf nie das Netz brauchen")
        .expect("Sitzung muss vorhanden sein");

    assert_eq!(restored.username, "AltUser");
    assert_eq!(restored.minecraft_access_token, "mc-token-alt");
    let account = restored.account();
    assert_eq!(account.user_type, UserType::Msa);
    assert_eq!(account.uuid, UUID);
}

#[tokio::test]
async fn expired_session_is_refreshed_and_saved_back() {
    let mock = start_mock(refresh_chain()).await;
    let store = MemoryStore::new();
    seed(&store, &session(1, Some("refresh-alt")));
    let manager = SessionManager::new(store);

    let restored = manager
        .restore(&auth_for(&mock.base))
        .await
        .unwrap()
        .expect("Refresh muss eine Sitzung liefern");

    assert_eq!(restored.minecraft_access_token, "mc-token-new");
    assert_eq!(restored.refresh_token(), Some("refresh-new"));
    assert_eq!(restored.username, "TestUser");
    assert_eq!(restored.uuid, UUID);
    assert!(restored.tokens_valid(now_ms()));

    let token = mock.body_for("/token");
    assert!(token.contains("grant_type=refresh_token"), "{token}");
    assert!(token.contains("refresh_token=refresh-alt"), "{token}");
    assert!(mock.body_for("/xsts/authorize").contains("RETAIL"));

    // Der neue Satz muss den alten im Store ersetzt haben.
    let persisted = manager.store().read().unwrap().unwrap();
    assert!(persisted.contains("mc-token-new"), "{persisted}");
    assert!(persisted.contains("refresh-new"), "{persisted}");
    assert!(!persisted.contains("mc-token-alt"), "{persisted}");
}

#[tokio::test]
async fn rejected_refresh_token_signs_the_user_out() {
    let mock = start_mock(vec![(
        "/token",
        400,
        json!({ "error": "invalid_grant", "error_description": "expired" }),
    )])
    .await;
    let store = MemoryStore::new();
    seed(&store, &session(1, Some("refresh-alt")));
    let manager = SessionManager::new(store);

    let restored = manager.restore(&auth_for(&mock.base)).await.unwrap();
    assert!(restored.is_none(), "invalid_grant muss abmelden");
    assert!(
        manager.store().read().unwrap().is_none(),
        "toter Token darf nicht liegen bleiben"
    );
}

#[tokio::test]
async fn expired_session_without_refresh_token_is_discarded() {
    let store = MemoryStore::new();
    seed(&store, &session(1, None));
    let manager = SessionManager::new(store);

    let restored = manager.restore(&unreachable_auth()).await.unwrap();
    assert!(restored.is_none());
    assert!(manager.store().read().unwrap().is_none());
}

#[tokio::test]
async fn network_failure_keeps_the_session_for_the_next_start() {
    let store = MemoryStore::new();
    seed(&store, &session(1, Some("refresh-alt")));
    let manager = SessionManager::new(store);

    let error = manager
        .restore(&unreachable_auth())
        .await
        .expect_err("Netzfehler muss gemeldet werden");
    assert!(
        manager.store().read().unwrap().is_some(),
        "ein Netzfehler darf die Sitzung nicht löschen: {error}"
    );
}

#[tokio::test]
async fn restore_without_any_session_is_silent() {
    let manager = SessionManager::new(MemoryStore::new());
    assert!(manager
        .restore(&unreachable_auth())
        .await
        .unwrap()
        .is_none());
}
