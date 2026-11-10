//! Kleiner HTTP-Layer für die Mod-APIs.
//!
//! Beide Quellen brauchen dasselbe: JSON, Retry bei 429/5xx, klare Fehler mit
//! Provider-Namen und ein optionales Header-Feld (der CurseForge-API-Key).

use super::{ModError, ModSource, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, RETRY_AFTER};
use serde::de::DeserializeOwned;
use std::time::Duration;

const ATTEMPTS: u32 = 3;
const BASE_DELAY: Duration = Duration::from_millis(500);
const MAX_DELAY: Duration = Duration::from_secs(10);
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const SNIPPET_CHARS: usize = 200;

pub(crate) struct ApiClient {
    client: reqwest::Client,
    base: String,
    provider: ModSource,
    headers: HeaderMap,
}

impl ApiClient {
    pub fn new(base: impl Into<String>, provider: ModSource) -> Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!(
                "BambooLauncher/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/bamboo-launcher)"
            ))
            .build()
            .map_err(|error| ModError::Network {
                provider: provider.label(),
                message: error.to_string(),
            })?;
        Ok(Self {
            client,
            base: base.into().trim_end_matches('/').to_string(),
            provider,
            headers: HeaderMap::new(),
        })
    }

    pub fn with_header(mut self, name: &'static str, value: String) -> Result<Self> {
        let name = HeaderName::from_static(name);
        let value = HeaderValue::from_str(&value).map_err(|error| ModError::Provider {
            provider: self.provider.label(),
            message: format!("Ungültiger Header-Wert: {error}"),
        })?;
        self.headers.insert(name, value);
        Ok(self)
    }

    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T> {
        let (status, body) = self.send(reqwest::Method::GET, path, query, None).await?;
        self.decode(path, status, body)
    }

    /// POST mit JSON-Body. Modrinth beantwortet Hashes und CurseForge
    /// Fingerprints nur so; beides sind Massenabfragen, die nicht in die URL
    /// passen.
    pub async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T> {
        let (status, bytes) = self
            .send(reqwest::Method::POST, path, &[], Some(body))
            .await?;
        self.decode(path, status, bytes)
    }

    /// Wie [`get`](Self::get), aber 403/404 sind ein erwartetes "gibt es nicht".
    pub async fn get_optional<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Option<T>> {
        let (status, body) = self.send(reqwest::Method::GET, path, query, None).await?;
        if status == 403 || status == 404 {
            return Ok(None);
        }
        self.decode(path, status, body).map(Some)
    }

    fn decode<T: DeserializeOwned>(&self, path: &str, status: u16, body: Vec<u8>) -> Result<T> {
        if status == 401 || status == 403 {
            return Err(ModError::Unauthorized {
                provider: self.provider.label(),
                status,
            });
        }
        if status == 404 {
            return Err(ModError::NotFound {
                provider: self.provider.label(),
                what: path.to_string(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(ModError::Http {
                provider: self.provider.label(),
                status,
                message: snippet(&String::from_utf8_lossy(&body)),
            });
        }
        serde_json::from_slice(&body).map_err(|error| ModError::Provider {
            provider: self.provider.label(),
            message: format!("Ungültige JSON-Antwort von {path}: {error}"),
        })
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&serde_json::Value>,
    ) -> Result<(u16, Vec<u8>)> {
        if !path.starts_with('/') {
            return Err(ModError::Provider {
                provider: self.provider.label(),
                message: format!("Interner Pfad ohne führenden Slash: {path}"),
            });
        }
        let url = format!("{}{}", self.base, path);
        let mut last_error: Option<ModError> = None;

        for attempt in 1..=ATTEMPTS {
            let mut request = self
                .client
                .request(method.clone(), &url)
                .query(query)
                .header(ACCEPT, "application/json");
            for (name, value) in &self.headers {
                request = request.header(name, value);
            }
            if let Some(body) = body {
                request = request.json(body);
            }

            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    let retryable = error.is_timeout() || error.is_connect() || error.is_request();
                    last_error = Some(ModError::Network {
                        provider: self.provider.label(),
                        message: error.to_string(),
                    });
                    if retryable && attempt < ATTEMPTS {
                        tokio::time::sleep(backoff(attempt)).await;
                        continue;
                    }
                    break;
                }
            };

            let status = response.status().as_u16();
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs)
                .map(|delay| delay.min(MAX_DELAY));

            if let Some(length) = response.content_length() {
                if length > MAX_BODY_BYTES as u64 {
                    return Err(ModError::Provider {
                        provider: self.provider.label(),
                        message: format!("Antwort von {path} ist zu groß ({length} Byte)."),
                    });
                }
            }

            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    last_error = Some(ModError::Network {
                        provider: self.provider.label(),
                        message: error.to_string(),
                    });
                    if attempt < ATTEMPTS {
                        tokio::time::sleep(backoff(attempt)).await;
                        continue;
                    }
                    break;
                }
            };

            if status == 429 || (500..600).contains(&status) {
                if attempt < ATTEMPTS {
                    let delay = retry_after.unwrap_or_else(|| backoff(attempt));
                    tokio::time::sleep(delay).await;
                    continue;
                }
                if status == 429 {
                    return Err(ModError::RateLimited {
                        provider: self.provider.label(),
                    });
                }
            }

            return Ok((status, bytes.to_vec()));
        }

        Err(last_error.unwrap_or_else(|| ModError::Network {
            provider: self.provider.label(),
            message: "Anfrage ohne Antwort abgebrochen".to_string(),
        }))
    }
}

fn backoff(attempt: u32) -> Duration {
    let factor = 1u32 << (attempt.saturating_sub(1).min(4));
    (BASE_DELAY * factor).min(MAX_DELAY)
}

fn snippet(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return "leere Antwort".to_string();
    }
    let mut text: String = compact.chars().take(SNIPPET_CHARS).collect();
    if compact.chars().count() > SNIPPET_CHARS {
        text.push('…');
    }
    text
}
