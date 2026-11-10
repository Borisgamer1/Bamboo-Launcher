//! Prüft Loopback-Callback und die komplette Microsoft→Xbox→Minecraft-Kette
//! gegen lokale Mock-Server – ohne Browser und ohne echtes Microsoft-Konto.

use bamboo_launcher::auth::{
    complete_token_chain, start_loopback_login, AuthConfig, AuthEndpoints, AuthError,
    MicrosoftAuth, LOGIN_TIMEOUT,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::net::TcpStream;

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

fn endpoints_for(mock: &Mock) -> AuthEndpoints {
    AuthEndpoints {
        authority: mock.base.clone(),
        xbox_user: format!("{}/user/authenticate", mock.base),
        xsts: format!("{}/xsts/authorize", mock.base),
        minecraft_login: format!("{}/authentication/login_with_xbox", mock.base),
        minecraft_profile: format!("{}/minecraft/profile", mock.base),
    }
}

#[tokio::test]
async fn loopback_delivers_code_and_decodes_it() {
    let login = start_loopback_login(0, "state-123").await.unwrap();
    let target = format!(
        "http://127.0.0.1:{}/callback?code=abc%20def&state=state-123",
        login.port
    );

    let response = reqwest::get(&target).await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert!(body.contains("Anmeldung erfolgreich"));

    let code = login.wait(LOGIN_TIMEOUT).await.unwrap();
    assert_eq!(code, "abc def");
}

#[tokio::test]
async fn loopback_rejects_wrong_state() {
    let login = start_loopback_login(0, "erwartet").await.unwrap();
    let target = format!("http://127.0.0.1:{}/?code=abc&state=falsch", login.port);

    let response = reqwest::get(&target).await.unwrap();
    assert_eq!(response.status(), 400);

    let error = login.wait(LOGIN_TIMEOUT).await.unwrap_err();
    assert!(matches!(error, AuthError::StateMismatch));
}

#[tokio::test]
async fn loopback_reports_cancelled_login() {
    let login = start_loopback_login(0, "state").await.unwrap();
    let target = format!(
        "http://127.0.0.1:{}/?error=access_denied&state=state",
        login.port
    );

    let response = reqwest::get(&target).await.unwrap();
    assert_eq!(response.status(), 400);

    let error = login.wait(LOGIN_TIMEOUT).await.unwrap_err();
    assert!(matches!(error, AuthError::Cancelled));
}

#[tokio::test]
async fn full_login_runs_loopback_exchange_and_xbox_chain() {
    let mock = start_mock(vec![
        (
            "/token",
            200,
            json!({
                "access_token": "ms-token",
                "refresh_token": "refresh-token",
                "expires_in": 3600
            }),
        ),
        (
            "/user/authenticate",
            200,
            json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [{ "uhs": "uhs-42" }] }
            }),
        ),
        ("/xsts/authorize", 200, json!({ "Token": "xsts-token" })),
        (
            "/authentication/login_with_xbox",
            200,
            json!({ "access_token": "mc-token", "expires_in": 86400 }),
        ),
        (
            "/minecraft/profile",
            200,
            json!({ "id": "uuid-1234", "name": "TestUser" }),
        ),
    ])
    .await;

    let config = AuthConfig {
        client_id: "test-client".to_string(),
        port: 0,
        endpoints: endpoints_for(&mock),
        ..AuthConfig::default()
    };
    let auth = MicrosoftAuth::with_config(config);

    // Mini-Browser: liest state und redirect_uri aus der Authorize-URL und
    // ruft den Loopback-Server wie ein echter Browser auf.
    let opener = |url: &str| {
        let url = url.to_string();
        tokio::spawn(async move {
            let parsed = reqwest::Url::parse(&url).unwrap();
            let mut state = String::new();
            let mut redirect = String::new();
            for (key, value) in parsed.query_pairs() {
                if key == "state" {
                    state = value.to_string();
                }
                if key == "redirect_uri" {
                    redirect = value.to_string().replace("localhost", "127.0.0.1");
                }
            }
            let target = format!("{redirect}/callback?code=test-code&state={state}");
            let _ = reqwest::get(&target).await;
        });
        Ok(())
    };

    let outcome = auth.login_with(opener).await.unwrap();

    assert_eq!(outcome.minecraft.profile.name, "TestUser");
    assert_eq!(outcome.minecraft.profile.id, "uuid-1234");
    assert_eq!(outcome.minecraft.access_token, "mc-token");
    assert_eq!(outcome.microsoft.access_token, "ms-token");
    assert_eq!(
        outcome.microsoft.refresh_token.as_deref(),
        Some("refresh-token")
    );

    let xbl = mock.body_for("/user/authenticate");
    assert!(xbl.contains("d=ms-token"), "RpsTicket fehlt: {xbl}");
    assert!(xbl.contains("RPS"));

    let xsts = mock.body_for("/xsts/authorize");
    assert!(xsts.contains("RETAIL"), "Sandbox fehlt: {xsts}");
    assert!(xsts.contains("xbl-token"));

    let login = mock.body_for("/authentication/login_with_xbox");
    assert!(
        login.contains("XBL3.0 x=uhs-42;xsts-token"),
        "identityToken falsch: {login}"
    );

    let token = mock.body_for("/token");
    assert!(token.contains("code=test-code"));
    assert!(token.contains("code_verifier="));
    assert!(token.contains("grant_type=authorization_code"));
}

#[tokio::test]
async fn xsts_rejection_surfaces_the_reason() {
    let mock = start_mock(vec![
        (
            "/user/authenticate",
            200,
            json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [{ "uhs": "uhs" }] }
            }),
        ),
        ("/xsts/authorize", 200, json!({ "XErr": 2148916233i64 })),
    ])
    .await;

    let client = reqwest::Client::new();
    let error = complete_token_chain(&client, &endpoints_for(&mock), "ms-token")
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("kein Xbox-Profil"),
        "unerwartete Meldung: {error}"
    );
}

#[tokio::test]
async fn missing_profile_is_reported() {
    let mock = start_mock(vec![
        (
            "/user/authenticate",
            200,
            json!({
                "Token": "xbl-token",
                "DisplayClaims": { "xui": [{ "uhs": "uhs" }] }
            }),
        ),
        ("/xsts/authorize", 200, json!({ "Token": "xsts-token" })),
        (
            "/authentication/login_with_xbox",
            200,
            json!({ "access_token": "mc-token" }),
        ),
        ("/minecraft/profile", 404, json!({ "error": "not found" })),
    ])
    .await;

    let client = reqwest::Client::new();
    let error = complete_token_chain(&client, &endpoints_for(&mock), "ms-token")
        .await
        .unwrap_err();
    assert!(matches!(error, AuthError::NoProfile));
}
