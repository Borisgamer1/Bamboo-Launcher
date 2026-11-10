//! HTTP-Downloads für den Installer.
//!
//! Jede Datei wird gestreamt, dabei gehasht und erst nach erfolgreicher
//! Prüfung an ihren Zielort verschoben. Ein Abbruch hinterlässt höchstens
//! eine `.part`-Datei, nie eine halbe JAR im Libraries-Ordner.

use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub const DEFAULT_CONCURRENCY: usize = 8;
pub const DEFAULT_ATTEMPTS: u32 = 3;
pub const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Obergrenze für JSON-Antworten (Versions- und Runtime-Manifeste).
const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;

const BASE_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(4);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("Netzwerkfehler bei {url}: {message}")]
    Network { url: String, message: String },

    #[error("HTTP {status} bei {url}")]
    Http {
        url: String,
        status: u16,
        /// Vom Server gewünschte Wartezeit in Millisekunden (`Retry-After`).
        retry_after_ms: Option<u64>,
    },

    #[error("Prüfsumme stimmt nicht für {path}: erwartet {expected}, erhalten {actual}")]
    Checksum {
        path: PathBuf,
        expected: String,
        actual: String,
    },

    #[error("Größe stimmt nicht für {path}: erwartet {expected} Byte, erhalten {actual}")]
    Size {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },

    #[error("Für {0} ist keine Download-URL angegeben.")]
    NoUrl(String),

    #[error("Der Server liefert mehr als {0} Byte für eine JSON-Antwort.")]
    TooLarge(usize),

    #[error("Ungültige URL: {0}")]
    InvalidUrl(String),

    #[error("I/O-Fehler: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, DownloadError>;

impl DownloadError {
    /// Nur vorübergehende Fehler rechtfertigen einen zweiten Versuch.
    fn is_retryable(&self) -> bool {
        match self {
            DownloadError::Network { .. } => true,
            DownloadError::Http { status, .. } => matches!(
                status,
                408 | 425 | 429 | 500 | 502 | 503 | 504 | 520 | 521 | 522 | 524
            ),
            _ => false,
        }
    }

    fn retry_after(&self) -> Option<Duration> {
        match self {
            DownloadError::Http { retry_after_ms, .. } => {
                retry_after_ms.map(|ms| Duration::from_millis(ms).min(MAX_RETRY_AFTER))
            }
            _ => None,
        }
    }
}

/// `Retry-After` ist entweder eine Sekundenzahl oder ein HTTP-Datum; nur die
/// Sekundenzahl lässt sich ohne Datums-Parser auswerten.
fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    let seconds = value?.trim().parse::<u64>().ok()?;
    Some(seconds.saturating_mul(1000))
}

// ---------------------------------------------------------------------------
// Aufträge und Fortschritt
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSpec {
    pub destination: PathBuf,
    pub urls: Vec<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

impl FileSpec {
    pub fn new(destination: impl Into<PathBuf>, url: impl Into<String>) -> Self {
        Self {
            destination: destination.into(),
            urls: vec![url.into()],
            sha1: None,
            size: None,
        }
    }

    pub fn with_sha1(mut self, sha1: impl Into<String>) -> Self {
        self.sha1 = Some(sha1.into());
        self
    }

    pub fn with_size(mut self, size: u64) -> Self {
        self.size = Some(size);
        self
    }

    pub fn with_urls(mut self, urls: Vec<String>) -> Self {
        self.urls = urls;
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadProgress {
    pub completed: usize,
    pub total: usize,
    pub downloaded: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadReport {
    pub files: usize,
    pub downloaded: usize,
    pub skipped: usize,
    pub bytes: u64,
}

enum Outcome {
    Downloaded { bytes: u64 },
    Skipped,
}

// ---------------------------------------------------------------------------
// Downloader
// ---------------------------------------------------------------------------

pub struct Downloader {
    client: reqwest::Client,
    concurrency: usize,
    attempts: u32,
}

impl Default for Downloader {
    fn default() -> Self {
        Self::new()
    }
}

impl Downloader {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // Kein Gesamt-Timeout: große Assets dürfen lange laden, nur
            // anhaltende Stille bricht einen Versuch ab.
            .read_timeout(DEFAULT_READ_TIMEOUT)
            .user_agent(concat!(
                "BambooLauncher/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/bamboo-launcher)"
            ))
            .build()
            .unwrap_or_default();
        Self {
            client,
            concurrency: DEFAULT_CONCURRENCY,
            attempts: DEFAULT_ATTEMPTS,
        }
    }

    pub fn with_client(client: reqwest::Client) -> Self {
        Self {
            client,
            concurrency: DEFAULT_CONCURRENCY,
            attempts: DEFAULT_ATTEMPTS,
        }
    }

    pub fn with_concurrency(mut self, concurrency: usize) -> Self {
        self.concurrency = concurrency.max(1);
        self
    }

    pub fn with_attempts(mut self, attempts: u32) -> Self {
        self.attempts = attempts.max(1);
        self
    }

    /// Lädt alle Dateien parallel, überspringt bereits vollständige und meldet
    /// den Fortschritt nach jeder fertigen Datei.
    pub async fn download_all<F>(
        &self,
        files: Vec<FileSpec>,
        on_progress: F,
    ) -> Result<DownloadReport>
    where
        F: Fn(DownloadProgress) + Send + Sync + 'static,
    {
        let total = files.len();
        let total_bytes = if files.iter().all(|file| file.size.is_some()) {
            Some(files.iter().filter_map(|file| file.size).sum())
        } else {
            None
        };

        #[derive(Default)]
        struct Counters {
            completed: AtomicUsize,
            downloaded: AtomicUsize,
            skipped: AtomicUsize,
            bytes: AtomicU64,
        }

        let progress = Arc::new(on_progress);
        let counters = Arc::new(Counters::default());
        let semaphore = Arc::new(Semaphore::new(self.concurrency));
        let mut tasks: JoinSet<Result<Outcome>> = JoinSet::new();
        let mut first_error: Option<DownloadError> = None;
        // Bleibt für das Aufrücken nach einem Abbruch übrig; wird aufgeräumt.
        let temp_paths: Vec<PathBuf> = files
            .iter()
            .map(|file| temp_path(&file.destination))
            .collect();

        for file in files {
            let permit = match semaphore.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            let client = self.client.clone();
            let attempts = self.attempts;
            let counters = Arc::clone(&counters);
            let progress = Arc::clone(&progress);
            tasks.spawn(async move {
                let _permit = permit;
                let outcome = download_into(&client, &file, attempts).await;
                match &outcome {
                    Ok(Outcome::Downloaded { bytes }) => {
                        counters.downloaded.fetch_add(1, Ordering::Relaxed);
                        counters.bytes.fetch_add(*bytes, Ordering::Relaxed);
                    }
                    Ok(Outcome::Skipped) => {
                        counters.skipped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {}
                }
                let done = counters.completed.fetch_add(1, Ordering::Relaxed) + 1;
                progress.as_ref()(DownloadProgress {
                    completed: done,
                    total,
                    downloaded: counters.downloaded.load(Ordering::Relaxed),
                    skipped: counters.skipped.load(Ordering::Relaxed),
                    bytes: counters.bytes.load(Ordering::Relaxed),
                    total_bytes,
                    current: Some(display_name(&file.destination)),
                });
                outcome
            });
        }

        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                        tasks.abort_all();
                    }
                }
                // Abgebrochene Geschwister nach dem ersten Fehler sind erwartet.
                Err(error) if !error.is_cancelled() => {
                    if first_error.is_none() {
                        first_error =
                            Some(DownloadError::Io(std::io::Error::other(error.to_string())));
                        tasks.abort_all();
                    }
                }
                Err(_) => {}
            }
        }

        if let Some(error) = first_error {
            for temp in &temp_paths {
                let _ = tokio::fs::remove_file(temp).await;
            }
            return Err(error);
        }

        Ok(DownloadReport {
            files: total,
            downloaded: counters.downloaded.load(Ordering::Relaxed),
            skipped: counters.skipped.load(Ordering::Relaxed),
            bytes: counters.bytes.load(Ordering::Relaxed),
        })
    }

    /// Holt eine kleine JSON-Antwort (Manifeste) mit Retry in den Speicher.
    pub async fn fetch_bytes(&self, urls: &[String]) -> Result<Vec<u8>> {
        if urls.is_empty() {
            return Err(DownloadError::NoUrl("JSON-Antwort".to_string()));
        }
        let mut last_error = None;
        for url in urls {
            for attempt in 1..=self.attempts {
                match self.fetch_bytes_once(url).await {
                    Ok(bytes) => return Ok(bytes),
                    Err(error) => {
                        let retry = error.is_retryable() && attempt < self.attempts;
                        last_error = Some(error);
                        if !retry {
                            break;
                        }
                        tokio::time::sleep(backoff(attempt)).await;
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| DownloadError::NoUrl(urls.join(", "))))
    }

    async fn fetch_bytes_once(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| network_error(url, error))?;
        let status = response.status();
        if !status.is_success() {
            let retry_after_ms = parse_retry_after(
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
            );
            return Err(DownloadError::Http {
                url: url.to_string(),
                status: status.as_u16(),
                retry_after_ms,
            });
        }
        if let Some(length) = response.content_length() {
            if length > MAX_JSON_BYTES as u64 {
                return Err(DownloadError::TooLarge(MAX_JSON_BYTES));
            }
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| network_error(url, error))?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err(DownloadError::TooLarge(MAX_JSON_BYTES));
        }
        Ok(bytes.to_vec())
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Datei")
        .to_string()
}

fn network_error(url: &str, error: reqwest::Error) -> DownloadError {
    DownloadError::Network {
        url: url.to_string(),
        message: if error.is_timeout() {
            "Zeitüberschreitung".to_string()
        } else if error.is_connect() {
            "Verbindung fehlgeschlagen".to_string()
        } else {
            error.to_string()
        },
    }
}

fn backoff(attempt: u32) -> Duration {
    let factor = 1u32 << attempt.min(6);
    (BASE_DELAY * factor).min(MAX_DELAY)
}

async fn download_into(
    client: &reqwest::Client,
    file: &FileSpec,
    attempts: u32,
) -> Result<Outcome> {
    if is_complete(&file.destination, file.size, file.sha1.as_deref()).await {
        return Ok(Outcome::Skipped);
    }
    if file.urls.is_empty() {
        return Err(DownloadError::NoUrl(file.destination.display().to_string()));
    }

    let mut last_error = None;
    for url in &file.urls {
        for attempt in 1..=attempts {
            match fetch_to_file(client, file, url).await {
                Ok(bytes) => return Ok(Outcome::Downloaded { bytes }),
                Err(error) => {
                    let retry = error.is_retryable() && attempt < attempts;
                    last_error = Some(error);
                    if !retry {
                        break;
                    }
                    let delay = last_error
                        .as_ref()
                        .and_then(DownloadError::retry_after)
                        .unwrap_or_else(|| backoff(attempt));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| DownloadError::NoUrl(file.urls.join(", "))))
}

async fn fetch_to_file(client: &reqwest::Client, file: &FileSpec, url: &str) -> Result<u64> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| network_error(url, error))?;
    let status = response.status();
    if !status.is_success() {
        let retry_after_ms = parse_retry_after(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
        );
        return Err(DownloadError::Http {
            url: url.to_string(),
            status: status.as_u16(),
            retry_after_ms,
        });
    }
    if let (Some(expected), Some(length)) = (file.size, response.content_length()) {
        if expected != length {
            return Err(DownloadError::Size {
                path: file.destination.clone(),
                expected,
                actual: length,
            });
        }
    }

    if let Some(parent) = file.destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = temp_path(&file.destination);
    let result = write_stream(response, &temp, file, url).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
        return result;
    }

    // Windows kann eine vorhandene Datei nicht überschreiben.
    if tokio::fs::try_exists(&file.destination)
        .await
        .unwrap_or(false)
    {
        let _ = tokio::fs::remove_file(&file.destination).await;
    }
    tokio::fs::rename(&temp, &file.destination).await?;
    result
}

async fn write_stream(
    mut response: reqwest::Response,
    temp: &Path,
    file: &FileSpec,
    url: &str,
) -> Result<u64> {
    let mut handle = tokio::fs::File::create(temp).await?;
    let mut hasher = Sha1::new();
    let mut written = 0u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| network_error(url, error))?
    {
        hasher.update(&chunk);
        handle.write_all(&chunk).await?;
        written += chunk.len() as u64;
    }
    handle.flush().await?;
    let _ = handle.sync_all().await;

    let actual = hex_digest(hasher.finalize());
    if let Some(expected) = &file.sha1 {
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(DownloadError::Checksum {
                path: file.destination.clone(),
                expected: expected.clone(),
                actual,
            });
        }
    }
    if let Some(expected) = file.size {
        if written != expected {
            return Err(DownloadError::Size {
                path: file.destination.clone(),
                expected,
                actual: written,
            });
        }
    }
    Ok(written)
}

fn temp_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.part", std::process::id()));
    destination.with_file_name(name)
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let bytes = digest.as_ref();
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Ist die Datei schon vollständig? Ohne Prüfsumme zählt nur die Größe.
pub async fn is_complete(path: &Path, size: Option<u64>, sha1: Option<&str>) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if let Some(expected) = size {
        if metadata.len() != expected {
            return false;
        }
    }
    match sha1 {
        Some(expected) => match hash_file(path).await {
            Ok(actual) => actual.eq_ignore_ascii_case(expected.trim()),
            Err(_) => false,
        },
        // Ohne Prüfsumme ist eine passende Größe das beste Kriterium; fehlt
        // auch die, genügt eine nicht-leere Datei. Geschrieben wird atomar über
        // eine Temp-Datei, es kann also keine halbe Datei hier liegen. Nötig
        // ist das für Fabric-Bibliotheken: deren Profil nennt weder Größe noch
        // SHA-1, und ohne diese Regel würde jeder Install-Lauf sie neu laden.
        None => size.is_some() || metadata.len() > 0,
    }
}

pub async fn hash_file(path: &Path) -> Result<String> {
    let mut handle = tokio::fs::File::open(path).await?;
    let mut hasher = Sha1::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = handle.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(hasher.finalize()))
}

pub fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hex_digest(hasher.finalize())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_the_known_vector() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    }

    #[test]
    fn backoff_grows_but_stays_bounded() {
        assert!(backoff(1) < backoff(2));
        assert!(backoff(2) < backoff(3));
        assert_eq!(backoff(20), MAX_DELAY);
    }

    #[test]
    fn retry_after_reads_seconds_and_ignores_dates() {
        assert_eq!(parse_retry_after(Some("2")), Some(2_000));
        assert_eq!(parse_retry_after(Some(" 0 ")), Some(0));
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            None
        );
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        assert!(DownloadError::Http {
            url: "x".into(),
            status: 503,
            retry_after_ms: None
        }
        .is_retryable());
        assert!(DownloadError::Http {
            url: "x".into(),
            status: 429,
            retry_after_ms: Some(1_000)
        }
        .is_retryable());
        assert!(!DownloadError::Http {
            url: "x".into(),
            status: 404,
            retry_after_ms: None
        }
        .is_retryable());
        assert!(!DownloadError::Checksum {
            path: "x".into(),
            expected: "a".into(),
            actual: "b".into()
        }
        .is_retryable());
    }

    #[tokio::test]
    async fn partial_files_do_not_count_as_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("datei.bin");
        tokio::fs::write(&path, b"abc").await.unwrap();

        assert!(is_complete(&path, Some(3), None).await);
        assert!(is_complete(&path, Some(3), Some(&sha1_hex(b"abc"))).await);
        assert!(!is_complete(&path, Some(4), None).await);
        assert!(is_complete(&path, None, Some(&sha1_hex(b"abc"))).await);
        assert!(!is_complete(&path, None, Some(&sha1_hex(b"abd"))).await);
        assert!(!is_complete(&dir.path().join("fehlt"), Some(0), None).await);

        // Ohne Größe und SHA-1 (Fabric-Bibliotheken) zählt die vorhandene
        // Datei als vollständig, eine leere aber nicht.
        assert!(is_complete(&path, None, None).await);
        let empty = dir.path().join("leer.bin");
        tokio::fs::write(&empty, b"").await.unwrap();
        assert!(!is_complete(&empty, None, None).await);
    }
}
