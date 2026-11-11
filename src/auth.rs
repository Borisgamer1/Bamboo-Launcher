use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Konstanten und Konfiguration
// ---------------------------------------------------------------------------

pub const REDIRECT_PORT: u16 = 3377;
pub const MICROSOFT_AUTHORITY: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
pub const MICROSOFT_SCOPE: &str =
    "XboxLive.signin XboxLive.offline_access offline_access openid profile";
/// Öffentlicher Client ohne Secret; per `BAMBOO_MS_CLIENT_ID` überschreibbar.
pub const DEFAULT_CLIENT_ID: &str = "ccbe9e09-6163-4b79-99b1-03ba9be2e5ea";

pub const XBOX_USER_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
pub const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
pub const MINECRAFT_LOGIN_URL: &str =
    "https://api.minecraftservices.com/authentication/login_with_xbox";
pub const MINECRAFT_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Alle Endpunkte sind überschreibbar, damit Tests gegen einen lokalen Server laufen.
#[derive(Debug, Clone)]
pub struct AuthEndpoints {
    pub authority: String,
    pub xbox_user: String,
    pub xsts: String,
    pub minecraft_login: String,
    pub minecraft_profile: String,
}

impl Default for AuthEndpoints {
    fn default() -> Self {
        Self {
            authority: MICROSOFT_AUTHORITY.to_string(),
            xbox_user: XBOX_USER_URL.to_string(),
            xsts: XSTS_URL.to_string(),
            minecraft_login: MINECRAFT_LOGIN_URL.to_string(),
            minecraft_profile: MINECRAFT_PROFILE_URL.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub client_id: String,
    pub scope: String,
    pub port: u16,
    pub login_timeout: Duration,
    pub endpoints: AuthEndpoints,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            client_id: std::env::var("BAMBOO_MS_CLIENT_ID")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string()),
            scope: MICROSOFT_SCOPE.to_string(),
            port: REDIRECT_PORT,
            login_timeout: LOGIN_TIMEOUT,
            endpoints: AuthEndpoints::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Zeitüberschreitung: Die Anmeldung wurde nicht abgeschlossen.")]
    Timeout,

    #[error("Die Anmeldung wurde abgebrochen.")]
    Cancelled,

    #[error("Port {0} wird bereits von einem anderen Programm benutzt.")]
    PortBusy(u16),

    #[error("Die Antwort gehört zu einer anderen Anmelde-Sitzung.")]
    StateMismatch,

    #[error("Microsoft hat keinen Autorisierungscode geliefert.")]
    MissingCode,

    #[error(
        "Microsoft lehnt die Redirect-URI ab (AADSTS50011). Die Azure-App muss http://localhost:{0} exakt als Redirect für öffentliche Clients erlauben."
    )]
    RedirectMismatch(u16),

    #[error("Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich erneut an.")]
    InvalidGrant,

    #[error("Netzwerkfehler: {0}")]
    Network(String),

    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },

    #[error("Xbox Live: {0}")]
    Xbox(String),

    #[error("Dieses Konto besitzt kein Minecraft-Java-Profil.")]
    NoProfile,

    #[error("Der Browser konnte nicht geöffnet werden: {0}")]
    Browser(String),

    #[error("Der lokale Anmelde-Server konnte nicht starten: {0}")]
    Listener(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, AuthError>;

// ---------------------------------------------------------------------------
// PKCE und State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

fn random_bytes(length: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; length];
    rand::rng().fill_bytes(&mut buffer);
    buffer
}

/// PKCE-Verifier (32 Zufallsbytes, base64url) und S256-Challenge.
pub fn create_pkce() -> Pkce {
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes(32));
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Zufälliger `state`-Wert gegen CSRF auf dem Loopback-Callback.
pub fn create_state() -> String {
    random_bytes(16)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn build_authorize_url(
    config: &AuthConfig,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    let base = config.endpoints.authority.trim_end_matches('/');
    let mut url = format!("{base}/authorize?");
    let params = [
        ("client_id", config.client_id.as_str()),
        ("response_type", "code"),
        ("response_mode", "query"),
        ("redirect_uri", redirect_uri),
        ("scope", config.scope.as_str()),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("prompt", "select_account"),
    ];
    url.push_str(
        &params
            .iter()
            .map(|(key, value)| format!("{}={}", key, url_encode(value)))
            .collect::<Vec<_>>()
            .join("&"),
    );
    url
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push_str("%20"),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    decoded.push(byte);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            other => {
                decoded.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn query_params(target: &str) -> HashMap<String, String> {
    let Some((_, query)) = target.split_once('?') else {
        return HashMap::new();
    };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Loopback-Server
// ---------------------------------------------------------------------------

pub struct LoopbackLogin {
    pub redirect_uri: String,
    pub port: u16,
    code: oneshot::Receiver<Result<String>>,
    server: tokio::task::JoinHandle<()>,
}

impl LoopbackLogin {
    /// Beendet den Listener, ohne auf einen Callback zu warten.
    pub fn abort(self) {
        self.server.abort();
    }

    /// Wartet auf den Callback und beendet danach den Listener.
    pub async fn wait(self, timeout: Duration) -> Result<String> {
        self.wait_or_cancel(timeout, &tokio::sync::Notify::new())
            .await
    }

    /// Wie [`wait`](Self::wait), aber ein Signal des Launchers beendet den
    /// Listener sofort. Ohne das bliebe „Abbrechen“ wirkungslos und Port 3377
    /// bis zum Timeout belegt.
    pub async fn wait_or_cancel(
        self,
        timeout: Duration,
        cancel: &tokio::sync::Notify,
    ) -> Result<String> {
        let Self { code, server, .. } = self;
        let received = {
            let waiting = tokio::time::timeout(timeout, code);
            tokio::pin!(waiting);
            tokio::select! {
                result = &mut waiting => result,
                _ = cancel.notified() => {
                    server.abort();
                    return Err(AuthError::Cancelled);
                }
            }
        };
        server.abort();
        match received {
            Err(_) => Err(AuthError::Timeout),
            Ok(Err(_)) => Err(AuthError::Cancelled),
            Ok(Ok(result)) => result,
        }
    }
}

/// Startet den lokalen HTTP-Listener für den OAuth-Callback.
pub async fn start_loopback_login(port: u16, state: &str) -> Result<LoopbackLogin> {
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(AuthError::PortBusy(port));
        }
        Err(error) => return Err(AuthError::Listener(error.to_string())),
    };

    let actual_port = listener
        .local_addr()
        .map_err(|error| AuthError::Listener(error.to_string()))?
        .port();
    let redirect_uri = format!("http://localhost:{actual_port}");

    let (sender, receiver) = oneshot::channel();
    let expected_state = state.to_string();
    let server = tokio::spawn(async move {
        let mut sender = Some(sender);
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let Some(head) = read_http_head(&mut stream).await else {
                continue;
            };
            let Some((method, target)) = parse_request_line(&head) else {
                let _ = respond(
                    &mut stream,
                    400,
                    &page(
                        "Ungültige Anfrage",
                        "Die Anfrage konnte nicht gelesen werden.",
                        false,
                    ),
                )
                .await;
                continue;
            };

            let path = target.split('?').next().unwrap_or("/");
            if method != "GET" {
                let _ = respond(
                    &mut stream,
                    405,
                    &page(
                        "Nicht unterstützt",
                        "Diese Adresse nimmt nur Browser-Aufrufe an.",
                        false,
                    ),
                )
                .await;
                continue;
            }
            if path != "/" && path != "/callback" {
                let _ = respond(
                    &mut stream,
                    404,
                    &page(
                        "Nicht gefunden",
                        "Diese Adresse gehört nicht zur Anmeldung.",
                        false,
                    ),
                )
                .await;
                continue;
            }

            let params = query_params(&target);
            let outcome = serve_callback(&params, &expected_state, actual_port, &mut stream).await;
            if let Some(result) = outcome {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(result);
                }
                break;
            }
        }
    });

    Ok(LoopbackLogin {
        redirect_uri,
        port: actual_port,
        code: receiver,
        server,
    })
}

async fn serve_callback(
    params: &HashMap<String, String>,
    expected_state: &str,
    port: u16,
    stream: &mut tokio::net::TcpStream,
) -> Option<Result<String>> {
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .map(String::as_str)
            .unwrap_or("");
        if description.contains("AADSTS50011") || error.contains("redirect_uri") {
            let _ = respond(stream, 400, &page("Redirect-URI abgelehnt", "Die Azure-App muss die lokale Adresse als Redirect für öffentliche Clients erlauben.", false)).await;
            return Some(Err(AuthError::RedirectMismatch(port)));
        }
        let cancelled = error == "access_denied" || error == "authorization_declined";
        let _ = respond(
            stream,
            400,
            &page(
                if cancelled {
                    "Anmeldung abgebrochen"
                } else {
                    "Anmeldung fehlgeschlagen"
                },
                "Du kannst dieses Fenster schließen und es erneut versuchen.",
                false,
            ),
        )
        .await;
        return Some(Err(if cancelled {
            AuthError::Cancelled
        } else {
            AuthError::Http {
                status: 400,
                message: format!("Microsoft hat die Anmeldung abgelehnt ({error})."),
            }
        }));
    }

    if params.get("state").map(String::as_str) != Some(expected_state) {
        let _ = respond(
            stream,
            400,
            &page(
                "Sitzung ungültig",
                "Die Antwort gehört zu einer anderen Anmeldung.",
                false,
            ),
        )
        .await;
        return Some(Err(AuthError::StateMismatch));
    }

    let Some(code) = params.get("code").filter(|value| !value.is_empty()) else {
        let _ = respond(
            stream,
            400,
            &page(
                "Kein Code erhalten",
                "Microsoft hat keinen Autorisierungscode geliefert.",
                false,
            ),
        )
        .await;
        return Some(Err(AuthError::MissingCode));
    };

    let _ = respond(
        stream,
        200,
        &page(
            "Anmeldung erfolgreich",
            "Du kannst dieses Fenster schließen. Der Launcher übernimmt den Rest.",
            true,
        ),
    )
    .await;
    Some(Ok(code.clone()))
}

async fn read_http_head(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 32 * 1024 {
            break;
        }
    }
    String::from_utf8(buffer).ok()
}

fn parse_request_line(head: &str) -> Option<(String, String)> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    Some((method, target))
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

/// Rückmeldeseite im Browser: dunkle, grün getönte Rampe, ein Akzent und
/// linksbündige Typografie statt der üblichen zentrierten Erfolgskarte.
fn page(title: &str, message: &str, success: bool) -> String {
    let accent = if success { "#a5cf88" } else { "#d99a86" };
    PAGE_TEMPLATE
        .replace("%ACCENT%", accent)
        .replace("%STATE%", if success { "success" } else { "error" })
        .replace("%LOGO%", &brand_logo())
        .replace("%MARK%", if success { MARK_OK } else { MARK_ALERT })
        .replace("%TITLE%", &escape_html(title))
        .replace("%MESSAGE%", &escape_html(message))
}

/// Das Logo liegt als kleines PNG im Binärprogramm und geht als Data-URI mit,
/// damit die Seite ohne zweiten Request und ohne Netz auskommt.
const BRAND_LOGO_PNG: &[u8] = include_bytes!("../ui/public/images/bamboo-logo-96.png");

fn brand_logo() -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(BRAND_LOGO_PNG);
    format!("data:image/png;base64,{encoded}")
}

const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>%TITLE% · Bamboo Launcher</title>
<style>
  :root {
    --bg: #0d1210;
    --ink: #e9f0ea;
    --ink-2: #a3b2a7;
    --hairline: rgba(233, 240, 234, 0.08);
    --accent: %ACCENT%;
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 40px 24px;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: var(--ink);
    font: 400 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 460px;
    animation: rise .3s cubic-bezier(.2, .7, .3, 1) both;
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; }
  .brand img { display: block; width: 36px; height: 36px; border: 1px solid var(--hairline); border-radius: 9px; }
  .brand span { font-size: 13px; font-weight: 500; color: var(--ink-2); }
  .mark { display: block; width: 20px; height: 20px; margin-bottom: 14px; color: var(--accent); }
  h1 { margin: 0 0 10px; font-size: 27px; line-height: 1.2; font-weight: 500; letter-spacing: -0.012em; }
  p { margin: 0; max-width: 46ch; color: var(--ink-2); }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { main { animation: none; } }
  @media (max-width: 640px) {
    body { padding: 32px 20px; }
    .brand { margin-bottom: 28px; }
    h1 { font-size: 23px; }
  }
</style>
</head>
<body>
<main data-state="%STATE%">
  <div class="brand">
    <img src="%LOGO%" width="36" height="36" alt="">
    <span>Bamboo Launcher</span>
  </div>
  <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%MARK%</svg>
  <h1>%TITLE%</h1>
  <p>%MESSAGE%</p>
</main>
</body>
</html>"#;

const MARK_OK: &str = r#"<path d="M4.5 12.5 9 17 19.5 6.5"/>"#;

const MARK_ALERT: &str =
    r#"<circle cx="12" cy="12" r="9.2"/><path d="M12 7.8v4.6"/><path d="M12 16.2h.01"/>"#;

/// Titel und Meldung stammen teils aus Query-Parametern der Callback-URL, also
/// aus einer fremden Quelle; sie gehören escaped in die Seite.
fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Token-Austausch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct MicrosoftTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Ablaufzeitpunkt als Unix-Millisekunden.
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McProfile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct MinecraftCredentials {
    pub access_token: String,
    pub expires_at: u64,
    pub profile: McProfile,
}

#[derive(Debug, Clone)]
pub struct LoginOutcome {
    pub microsoft: MicrosoftTokens,
    pub minecraft: MinecraftCredentials,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn network_error(error: reqwest::Error) -> AuthError {
    if error.is_timeout() {
        AuthError::Timeout
    } else {
        AuthError::Network(error.to_string())
    }
}

async fn send_form(
    client: &reqwest::Client,
    url: &str,
    form: &[(&str, String)],
) -> Result<(u16, Value)> {
    let response = client
        .post(url)
        .form(form)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(network_error)?;
    let body = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok((status, body))
}

fn parse_token_response(status: u16, body: &Value) -> Result<MicrosoftTokens> {
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());

    let Some(access_token) = access_token else {
        let error = body.get("error").and_then(Value::as_str).unwrap_or("");
        let description = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or("");

        if description.contains("AADSTS50011") || description.contains("redirect_uri") {
            return Err(AuthError::RedirectMismatch(REDIRECT_PORT));
        }
        if matches!(
            error,
            "invalid_grant" | "interaction_required" | "consent_required"
        ) {
            return Err(AuthError::InvalidGrant);
        }
        if matches!(error, "access_denied" | "authorization_declined") {
            return Err(AuthError::Cancelled);
        }
        return Err(AuthError::Http {
            status,
            message: if error.is_empty() {
                "Microsoft hat kein Access-Token geliefert.".to_string()
            } else {
                format!("Microsoft-Anmeldung fehlgeschlagen ({error}).")
            },
        });
    };

    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);

    Ok(MicrosoftTokens {
        access_token: access_token.to_string(),
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: now_ms() + expires_in * 1000,
    })
}

pub async fn exchange_code(
    client: &reqwest::Client,
    config: &AuthConfig,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<MicrosoftTokens> {
    let url = format!("{}/token", config.endpoints.authority.trim_end_matches('/'));
    let form = vec![
        ("client_id", config.client_id.clone()),
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
        ("scope", config.scope.clone()),
    ];
    let (status, body) = send_form(client, &url, &form).await?;
    parse_token_response(status, &body)
}

pub async fn refresh_tokens(
    client: &reqwest::Client,
    config: &AuthConfig,
    refresh_token: &str,
) -> Result<MicrosoftTokens> {
    let url = format!("{}/token", config.endpoints.authority.trim_end_matches('/'));
    let form = vec![
        ("client_id", config.client_id.clone()),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("scope", config.scope.clone()),
    ];
    let (status, body) = send_form(client, &url, &form).await?;
    parse_token_response(status, &body)
}

// ---------------------------------------------------------------------------
// Xbox-Token-Kette
// ---------------------------------------------------------------------------

async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<(u16, Value)> {
    let response = client
        .post(url)
        .json(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(network_error)?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// Übersetzt die `XErr`-Codes von Xbox Live in eine verständliche Meldung.
pub fn xsts_error_message(xerr: Option<i64>) -> String {
    match xerr {
        Some(2148916227) => "Dieses Xbox-Konto wurde gesperrt.".to_string(),
        Some(2148916233) => {
            "Dieses Microsoft-Konto hat kein Xbox-Profil. Erstelle zuerst auf xbox.com ein Konto."
                .to_string()
        }
        Some(2148916235) => {
            "Xbox Live ist in der Region dieses Kontos nicht verfügbar.".to_string()
        }
        Some(2148916236) | Some(2148916237) => {
            "Dieses Konto benötigt eine Bestätigung durch einen Erwachsenen.".to_string()
        }
        Some(2148916238) => {
            "Dieses Konto ist ein Kinderkonto und muss einer Xbox-Familie hinzugefügt werden."
                .to_string()
        }
        _ => "Xbox Live hat die Anmeldung abgelehnt.".to_string(),
    }
}

/// Tauscht ein Microsoft-Access-Token gegen Minecraft-Credentials.
pub async fn complete_token_chain(
    client: &reqwest::Client,
    endpoints: &AuthEndpoints,
    microsoft_access_token: &str,
) -> Result<MinecraftCredentials> {
    let (xbl_status, xbl) = post_json(
        client,
        &endpoints.xbox_user,
        &json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={microsoft_access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }),
    )
    .await?;

    let xbl_token = xbl
        .get("Token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let uhs = xbl
        .get("DisplayClaims")
        .and_then(|claims| claims.get("xui"))
        .and_then(|xui| xui.get(0))
        .and_then(|entry| entry.get("uhs"))
        .and_then(Value::as_str);

    let (Some(xbl_token), Some(uhs)) = (xbl_token, uhs) else {
        return Err(AuthError::Http {
            status: xbl_status,
            message: "Xbox Live hat kein gültiges Token geliefert.".to_string(),
        });
    };

    let (_xsts_status, xsts) = post_json(
        client,
        &endpoints.xsts,
        &json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl_token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }),
    )
    .await?;

    let xsts_token = xsts
        .get("Token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(xsts_token) = xsts_token else {
        return Err(AuthError::Xbox(xsts_error_message(
            xsts.get("XErr").and_then(Value::as_i64),
        )));
    };

    let (login_status, login) = post_json(
        client,
        &endpoints.minecraft_login,
        &json!({ "identityToken": format!("XBL3.0 x={uhs};{xsts_token}") }),
    )
    .await?;

    let minecraft_token = login
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let Some(minecraft_token) = minecraft_token else {
        if login_status == 403 {
            return Err(AuthError::Http {
                status: 403,
                message: "Minecraft hat die App-Registrierung abgelehnt. Neue Azure-Apps müssen für die Minecraft-API freigegeben werden: https://aka.ms/mce-reviewappid".to_string(),
            });
        }
        return Err(AuthError::Http {
            status: login_status,
            message: "Minecraft hat kein Access-Token geliefert.".to_string(),
        });
    };

    let expires_in = login
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(86_400);

    let (profile_status, profile) =
        read_profile(client, &endpoints.minecraft_profile, minecraft_token).await?;
    if profile_status == 404 {
        return Err(AuthError::NoProfile);
    }
    if profile_status >= 400 {
        return Err(AuthError::Http {
            status: profile_status,
            message: "Das Minecraft-Profil konnte nicht geladen werden.".to_string(),
        });
    }

    let uuid = profile.get("id").and_then(Value::as_str);
    let name = profile.get("name").and_then(Value::as_str);
    let (Some(uuid), Some(name)) = (uuid, name) else {
        return Err(AuthError::NoProfile);
    };

    Ok(MinecraftCredentials {
        access_token: minecraft_token.to_string(),
        expires_at: now_ms() + expires_in * 1000,
        profile: McProfile {
            id: uuid.to_string(),
            name: name.to_string(),
        },
    })
}

/// Profil-Abfrage mit kurzem Retry: 429/5xx sind vorübergehend.
async fn read_profile(client: &reqwest::Client, url: &str, token: &str) -> Result<(u16, Value)> {
    let mut last = (0, Value::Null);
    for attempt in 0..3u64 {
        let response = client
            .get(url)
            .bearer_auth(token)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(network_error)?;
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        last = (status, body);
        if status != 429 && status < 500 {
            return Ok(last);
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(300 * (attempt + 1))).await;
        }
    }
    Ok(last)
}

// ---------------------------------------------------------------------------
// Fassade
// ---------------------------------------------------------------------------

pub struct MicrosoftAuth {
    config: AuthConfig,
    client: reqwest::Client,
}

impl Default for MicrosoftAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl MicrosoftAuth {
    pub fn new() -> Self {
        Self::with_config(AuthConfig::default())
    }

    pub fn with_config(config: AuthConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { config, client }
    }

    pub fn config(&self) -> &AuthConfig {
        &self.config
    }

    /// Vollständiger Login: Browser öffnen, Callback abwarten, Tokens tauschen.
    pub async fn login(&self) -> Result<LoginOutcome> {
        self.login_with(open_browser).await
    }

    /// Wie [`login`](Self::login), aber mit injizierbarem Browser-Aufruf (Tests).
    pub async fn login_with<F>(&self, open: F) -> Result<LoginOutcome>
    where
        F: FnOnce(&str) -> Result<()>,
    {
        self.login_with_cancel(open, &tokio::sync::Notify::new())
            .await
    }

    /// Login, den ein [`Notify`](tokio::sync::Notify) abbrechen kann.
    pub async fn login_with_cancel<F>(
        &self,
        open: F,
        cancel: &tokio::sync::Notify,
    ) -> Result<LoginOutcome>
    where
        F: FnOnce(&str) -> Result<()>,
    {
        let state = create_state();
        let pkce = create_pkce();
        let loopback = start_loopback_login(self.config.port, &state).await?;
        let redirect_uri = loopback.redirect_uri.clone();
        let authorize_url =
            build_authorize_url(&self.config, &redirect_uri, &state, &pkce.challenge);

        if let Err(error) = open(&authorize_url) {
            loopback.abort();
            return Err(error);
        }

        let code = loopback
            .wait_or_cancel(self.config.login_timeout, cancel)
            .await?;
        let microsoft = exchange_code(
            &self.client,
            &self.config,
            &code,
            &pkce.verifier,
            &redirect_uri,
        )
        .await?;
        let minecraft = complete_token_chain(
            &self.client,
            &self.config.endpoints,
            &microsoft.access_token,
        )
        .await?;

        Ok(LoginOutcome {
            microsoft,
            minecraft,
        })
    }

    /// Erneuert eine abgelaufene Sitzung ohne Browser.
    pub async fn refresh(&self, refresh_token: &str) -> Result<LoginOutcome> {
        let microsoft = refresh_tokens(&self.client, &self.config, refresh_token).await?;
        let minecraft = complete_token_chain(
            &self.client,
            &self.config.endpoints,
            &microsoft.access_token,
        )
        .await?;
        Ok(LoginOutcome {
            microsoft,
            minecraft,
        })
    }
}

/// Öffnet eine URL im Standardbrowser.
pub fn open_browser(url: &str) -> Result<()> {
    // Die URL landet in einer Kommandozeile; ein Anführungszeichen würde sie
    // dort aufbrechen. Die Authorize-URL wird vollständig prozentkodiert, dieser
    // Riegel ist nur die Absicherung dagegen.
    if url.contains(['"', '\r', '\n']) {
        return Err(AuthError::Browser(
            "Die URL enthält Zeichen, die die Kommandozeile zerlegen.".to_string(),
        ));
    }

    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        // `start` ist ein cmd-Builtin und wird von cmd selbst geparst, nicht von
        // der C-Runtime. Darum muss die Zeile roh ankommen: `Command::args`
        // escapt die Anführungszeichen zu `\"`, cmd hielte `\"` für das
        // Programm und Windows meldete „Die Datei "\" wurde nicht gefunden“.
        command.raw_arg(windows_start_line(url));
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| AuthError::Browser(error.to_string()))
}

/// Kommandozeile für `cmd /C`: der leere Titel vor der URL verhindert, dass
/// `start` die URL als Fenstertitel schluckt, die Anführungszeichen halten `&`
/// aus den Query-Parametern zusammen.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_start_line(url: &str) -> String {
    format!("/C start \"\" \"{url}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_known_vector() {
        // SHA-256("abc") als base64url ohne Padding.
        assert_eq!(
            challenge_for("abc"),
            "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
        );
    }

    #[test]
    fn pkce_verifier_is_url_safe_and_fresh() {
        let first = create_pkce();
        let second = create_pkce();
        assert_ne!(first.verifier, second.verifier);
        assert_eq!(first.verifier.len(), 43);
        assert!(first
            .verifier
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert_eq!(first.challenge, challenge_for(&first.verifier));
    }

    #[test]
    fn windows_start_line_passes_url_to_cmd_untouched() {
        let url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A3377%2Fcallback";
        let line = windows_start_line(url);
        assert_eq!(line, format!("/C start \"\" \"{url}\""));
        // Vor dem Fix hat Command::args die Quotes zu \" escapt; cmd hielt das
        // für ein Programm und Windows meldete „Die Datei "\" wurde nicht gefunden“.
        assert!(!line.contains("\\\""));
    }

    #[test]
    fn open_browser_rejects_command_separators() {
        let error = open_browser("https://example.com/\"&calc").unwrap_err();
        assert!(matches!(error, AuthError::Browser(_)));
    }

    #[test]
    fn state_is_hex_and_unique() {
        let state = create_state();
        assert_eq!(state.len(), 32);
        assert!(state.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(state, create_state());
    }

    #[test]
    fn authorize_url_carries_all_parameters() {
        let config = AuthConfig {
            client_id: "client-123".to_string(),
            ..AuthConfig::default()
        };
        let url = build_authorize_url(
            &config,
            "http://localhost:3377",
            "state-abc",
            "challenge-xyz",
        );
        assert!(url.starts_with(MICROSOFT_AUTHORITY));
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A3377"));
        assert!(url.contains("state=state-abc"));
        assert!(url.contains("code_challenge=challenge-xyz"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("prompt=select_account"));
        assert!(url.contains("XboxLive.signin"));
    }

    #[test]
    fn decodes_percent_encoding() {
        assert_eq!(percent_decode("abc%20def"), "abc def");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%C3%A4"), "ä");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn parses_request_line_and_query() {
        let head = "GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let (method, target) = parse_request_line(head).unwrap();
        assert_eq!(method, "GET");
        let params = query_params(&target);
        assert_eq!(params.get("code").map(String::as_str), Some("abc"));
        assert_eq!(params.get("state").map(String::as_str), Some("xyz"));
    }

    #[test]
    fn maps_xsts_errors() {
        assert!(xsts_error_message(Some(2148916233)).contains("kein Xbox-Profil"));
        assert!(xsts_error_message(Some(2148916238)).contains("Kinderkonto"));
        assert!(xsts_error_message(Some(999)).contains("abgelehnt"));
        assert!(xsts_error_message(None).contains("abgelehnt"));
    }

    #[test]
    fn parses_token_responses() {
        let tokens = parse_token_response(
            200,
            &json!({ "access_token": "abc", "refresh_token": "def", "expires_in": 3600 }),
        )
        .unwrap();
        assert_eq!(tokens.access_token, "abc");
        assert_eq!(tokens.refresh_token.as_deref(), Some("def"));
        assert!(tokens.expires_at > now_ms());

        let expired = parse_token_response(400, &json!({ "error": "invalid_grant" })).unwrap_err();
        assert!(matches!(expired, AuthError::InvalidGrant));

        let redirect = parse_token_response(
            400,
            &json!({ "error": "invalid_request", "error_description": "AADSTS50011: redirect" }),
        )
        .unwrap_err();
        assert!(matches!(redirect, AuthError::RedirectMismatch(_)));

        let missing = parse_token_response(500, &Value::Null).unwrap_err();
        assert!(matches!(missing, AuthError::Http { status: 500, .. }));
    }
}
