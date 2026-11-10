//! Sitzungsspeicher: Microsoft- und Minecraft-Tokens liegen im Anmeldedaten-
//! Speicher des Systems (Windows Credential Manager, macOS Keychain, Secret
//! Service unter Linux) – nie in einer Datei und nie in den Einstellungen.
//!
//! Unter Windows nimmt der Credential Manager pro Eintrag höchstens 2560 Byte
//! UTF-16 auf,
//! also 1280 Zeichen. Ein Token-Satz ist deutlich größer, deshalb wird das
//! JSON in Stücke von [`CHUNK_CHARS`] Zeichen zerlegt und auf nummerierte
//! Einträge verteilt. Ein Manifest-Eintrag nennt die Anzahl der Teile; er wird
//! zuletzt geschrieben. Bricht der Vorgang dazwischen ab, existiert kein
//! Manifest und damit auch keine halbe Sitzung.

use crate::auth::{AuthError, LoginOutcome, MicrosoftAuth};
use crate::launcher::{Account, UserType};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Dienstname, unter dem der Launcher im Anmeldedaten-Speicher auftaucht.
pub const KEYRING_SERVICE: &str = "bamboo-launcher";
/// Name des Manifest-Eintrags; die Teile heißen `microsoft-session.0` usw.
pub const KEYRING_ENTRY: &str = "microsoft-session";

/// Höchstzahl Zeichen pro Credential-Eintrag. 1000 Zeichen sind auch mit
/// Nicht-ASCII (2000 Byte UTF-16) sicher unter dem Plattformlimit von 2560.
pub const CHUNK_CHARS: usize = 1000;
/// Obergrenze, damit ein beschädigtes Manifest keine endlose Schleife auslöst.
pub const MAX_CHUNKS: usize = 32;
/// Tokens werden erneuert, bevor sie ablaufen – Uhren driften.
pub const EXPIRY_MARGIN_MS: u64 = 60_000;

const MANIFEST_PREFIX: &str = "bamboo-session-v1:";

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("Anmeldedaten-Speicher: {0}")]
    Backend(String),

    #[error("Der Anmeldedaten-Speicher ist nicht verfügbar: {0}")]
    Unavailable(String),

    #[error("Die gespeicherte Sitzung ist beschädigt: {0}")]
    Corrupt(String),

    #[error("Die gespeicherte Sitzung ist ungültig: {0}")]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Auth(#[from] AuthError),
}

pub type Result<T> = std::result::Result<T, SessionError>;

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------

/// Alles, was ein Neustart braucht, um ohne Browser weiterzuspielen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSession {
    pub username: String,
    pub uuid: String,
    pub minecraft_access_token: String,
    /// Ablaufzeitpunkt als Unix-Millisekunden.
    pub minecraft_expires_at: u64,
    #[serde(default)]
    pub microsoft_access_token: String,
    #[serde(default)]
    pub microsoft_refresh_token: Option<String>,
    #[serde(default)]
    pub microsoft_expires_at: u64,
}

impl StoredSession {
    pub fn from_outcome(outcome: &LoginOutcome) -> Self {
        Self {
            username: outcome.minecraft.profile.name.clone(),
            uuid: outcome.minecraft.profile.id.clone(),
            minecraft_access_token: outcome.minecraft.access_token.clone(),
            minecraft_expires_at: outcome.minecraft.expires_at,
            microsoft_access_token: outcome.microsoft.access_token.clone(),
            microsoft_refresh_token: outcome.microsoft.refresh_token.clone(),
            microsoft_expires_at: outcome.microsoft.expires_at,
        }
    }

    /// Spielbereites Konto für den Startbefehl.
    pub fn account(&self) -> Account {
        Account {
            username: self.username.clone(),
            uuid: self.uuid.clone(),
            access_token: self.minecraft_access_token.clone(),
            user_type: UserType::Msa,
        }
    }

    /// Reicht der Minecraft-Token noch, um sofort zu starten?
    pub fn tokens_valid(&self, now: u64) -> bool {
        self.minecraft_expires_at > now.saturating_add(EXPIRY_MARGIN_MS)
    }

    pub fn refresh_token(&self) -> Option<&str> {
        self.microsoft_refresh_token
            .as_deref()
            .filter(|token| !token.is_empty())
    }
}

/// Alle verbundenen Konten in einem Credential-Eintrag. Der Launcher kann so
/// mehrere Microsoft-Konten halten, ohne die 2560-Byte-Grenze je Eintrag zu
/// sprengen: das aktive Konto steht zusätzlich in `active`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountBook {
    #[serde(default = "book_version")]
    pub version: u32,
    /// UUID des aktiven Kontos.
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub accounts: Vec<StoredSession>,
}

fn book_version() -> u32 {
    2
}

impl Default for AccountBook {
    fn default() -> Self {
        Self {
            version: book_version(),
            active: None,
            accounts: Vec::new(),
        }
    }
}

impl AccountBook {
    /// Liest das neue Format oder ein einzelnes Konto aus der Zeit davor.
    /// Eine alte Sitzung wird dabei nicht verworfen, sondern zum ersten Konto.
    pub fn from_json(raw: &str) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_str(raw)?;
        if value.get("accounts").is_some() {
            return Ok(serde_json::from_value(value)?);
        }
        let session: StoredSession = serde_json::from_value(value)?;
        Ok(Self {
            active: Some(session.uuid.clone()),
            accounts: vec![session],
            ..Self::default()
        })
    }

    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    /// Fügt ein Konto hinzu oder ersetzt seine Tokens und macht es aktiv.
    pub fn upsert(&mut self, session: StoredSession) {
        let uuid = session.uuid.clone();
        match self
            .accounts
            .iter_mut()
            .find(|account| account.uuid.eq_ignore_ascii_case(&uuid))
        {
            Some(existing) => *existing = session,
            None => self.accounts.push(session),
        }
        self.active = Some(uuid);
    }

    pub fn replace(&mut self, session: StoredSession) {
        let uuid = session.uuid.clone();
        if let Some(existing) = self
            .accounts
            .iter_mut()
            .find(|account| account.uuid.eq_ignore_ascii_case(&uuid))
        {
            *existing = session;
        } else {
            self.accounts.push(session);
        }
    }

    pub fn active_account(&self) -> Option<&StoredSession> {
        match &self.active {
            Some(id) => self
                .accounts
                .iter()
                .find(|account| account.uuid.eq_ignore_ascii_case(id)),
            None => self.accounts.first(),
        }
    }

    pub fn has_account(&self, id: &str) -> bool {
        self.accounts
            .iter()
            .any(|account| account.uuid.eq_ignore_ascii_case(id))
    }

    /// Setzt das aktive Konto; ohne Treffer bleibt die Auswahl unverändert.
    pub fn select(&mut self, id: &str) -> bool {
        if !self.has_account(id) {
            return false;
        }
        self.active = Some(
            self.accounts
                .iter()
                .find(|account| account.uuid.eq_ignore_ascii_case(id))
                .map(|account| account.uuid.clone())
                .unwrap_or_else(|| id.to_string()),
        );
        true
    }

    /// Entfernt ein Konto. War es aktiv, übernimmt das nächste; leer heißt
    /// abgemeldet.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.accounts.len();
        self.accounts
            .retain(|account| !account.uuid.eq_ignore_ascii_case(id));
        if self.accounts.len() == before {
            return false;
        }
        let active_removed = self
            .active
            .as_deref()
            .is_some_and(|active| active.eq_ignore_ascii_case(id));
        if active_removed || self.active.is_none() {
            self.active = self.accounts.first().map(|account| account.uuid.clone());
        }
        true
    }

    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// „in 42 Minuten“ statt eines rohen Zeitstempels für die CLI.
pub fn describe_expiry(expires_at: u64, now: u64) -> String {
    if expires_at <= now {
        return "abgelaufen".to_string();
    }
    let seconds = (expires_at - now) / 1000;
    match seconds {
        0..=59 => format!("noch {seconds} Sekunden gültig"),
        60..=3599 => format!("noch {} Minuten gültig", seconds / 60),
        3600..=86_399 => format!("noch {} Stunden gültig", seconds / 3600),
        _ => format!("noch {} Tagen gültig", seconds / 86_400),
    }
}

// ---------------------------------------------------------------------------
// Ablage-Schnittstelle
// ---------------------------------------------------------------------------

/// Trennt die Sitzungslogik von der Plattform, damit Tests ohne echten
/// Credential Manager laufen können.
pub trait SecretStore: Send + Sync {
    fn write(&self, secret: &str) -> Result<()>;
    fn read(&self) -> Result<Option<String>>;
    fn erase(&self) -> Result<()>;
}

/// In-Memory-Ablage für Tests und für den Fall, dass der Store fehlt.
#[derive(Debug, Default)]
pub struct MemoryStore {
    secret: std::sync::Mutex<Option<String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.secret
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SecretStore for MemoryStore {
    fn write(&self, secret: &str) -> Result<()> {
        *self.guard() = Some(secret.to_string());
        Ok(())
    }

    fn read(&self) -> Result<Option<String>> {
        Ok(self.guard().clone())
    }

    fn erase(&self) -> Result<()> {
        *self.guard() = None;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Anmeldedaten-Speicher des Systems
// ---------------------------------------------------------------------------

/// Zerlegt ein Secret in Credential-Store-taugliche Stücke.
fn split_secret(secret: &str) -> Vec<String> {
    let chars: Vec<char> = secret.chars().collect();
    chars
        .chunks(CHUNK_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn manifest_for(count: usize) -> String {
    format!("{MANIFEST_PREFIX}{count}")
}

fn parse_manifest(raw: &str) -> Option<usize> {
    let count = raw
        .trim()
        .strip_prefix(MANIFEST_PREFIX)?
        .parse::<usize>()
        .ok()?;
    (1..=MAX_CHUNKS).contains(&count).then_some(count)
}

/// Speichert Secrets im Anmeldedaten-Speicher des Systems.
#[derive(Debug, Clone)]
pub struct KeyringStore {
    service: String,
    entry: String,
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyringStore {
    pub fn new() -> Self {
        Self {
            service: KEYRING_SERVICE.to_string(),
            entry: KEYRING_ENTRY.to_string(),
        }
    }

    /// Eigener Dienstname für Tests, damit echte Sitzungen unangetastet bleiben.
    pub fn with_names(service: impl Into<String>, entry: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            entry: entry.into(),
        }
    }

    fn entry(&self, suffix: Option<usize>) -> Result<keyring::Entry> {
        let name = match suffix {
            Some(index) => format!("{}.{index}", self.entry),
            None => self.entry.clone(),
        };
        keyring::Entry::new(&self.service, &name).map_err(|error| match error {
            keyring::Error::NoDefaultStore => SessionError::Unavailable(
                "Der Anmeldedaten-Speicher des Systems ist nicht verfügbar.".to_string(),
            ),
            other => SessionError::Backend(other.to_string()),
        })
    }

    fn read_entry(&self, suffix: Option<usize>) -> Result<Option<String>> {
        match self.entry(suffix)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(SessionError::Backend(error.to_string())),
        }
    }

    fn write_entry(&self, suffix: Option<usize>, value: &str) -> Result<()> {
        self.entry(suffix)?
            .set_password(value)
            .map_err(|error| match error {
                keyring::Error::TooLong(field, limit) => SessionError::Backend(format!(
                    "Eintrag ist zu lang für den Credential Store ({field}, Limit {limit} Byte)."
                )),
                other => SessionError::Backend(other.to_string()),
            })
    }

    /// Löscht einen Eintrag und meldet, ob er überhaupt existierte.
    fn delete_entry(&self, suffix: Option<usize>) -> Result<bool> {
        match self.entry(suffix)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(SessionError::Backend(error.to_string())),
        }
    }

    /// Löscht Manifest und alle vorhandenen Teile.
    ///
    /// Die Teile werden gelöscht, bis der erste fehlt – nicht nur bis zur im
    /// Manifest genannten Zahl. Ein beschädigtes oder fehlendes Manifest darf
    /// keine Waisen im Credential Store hinterlassen.
    fn clear_chunks(&self) -> Result<usize> {
        self.delete_entry(None)?;
        let mut removed = 0;
        for index in 0..MAX_CHUNKS {
            if !self.delete_entry(Some(index))? {
                break;
            }
            removed += 1;
        }
        Ok(removed)
    }

    /// Zahl der zusammenhängend vorhandenen Teile – für Diagnose und Tests.
    pub fn stored_chunks(&self) -> Result<usize> {
        let mut count = 0;
        for index in 0..MAX_CHUNKS {
            if self.read_entry(Some(index))?.is_none() {
                break;
            }
            count += 1;
        }
        Ok(count)
    }
}

impl SecretStore for KeyringStore {
    fn write(&self, secret: &str) -> Result<()> {
        let chunks = split_secret(secret);
        if chunks.is_empty() {
            return Err(SessionError::Corrupt(
                "Eine leere Sitzung wird nicht gespeichert.".to_string(),
            ));
        }
        if chunks.len() > MAX_CHUNKS {
            return Err(SessionError::Corrupt(format!(
                "Sitzung ist mit {} Zeichen zu groß für den Credential Store.",
                secret.chars().count()
            )));
        }

        // Erst alles Alte weg, damit keine Teile einer früheren Sitzung bleiben.
        self.clear_chunks()?;
        for (index, chunk) in chunks.iter().enumerate() {
            self.write_entry(Some(index), chunk)?;
        }
        // Das Manifest ist die Marke für „vollständig geschrieben“.
        self.write_entry(None, &manifest_for(chunks.len()))?;
        Ok(())
    }

    fn read(&self) -> Result<Option<String>> {
        let Some(raw) = self.read_entry(None)? else {
            return Ok(None);
        };
        let count = parse_manifest(&raw).ok_or_else(|| {
            SessionError::Corrupt(format!("Unbekanntes Manifest im Credential Store: {raw}"))
        })?;

        let mut secret = String::new();
        for index in 0..count {
            match self.read_entry(Some(index))? {
                Some(chunk) => secret.push_str(&chunk),
                None => {
                    return Err(SessionError::Corrupt(format!(
                        "Sitzungsteil {index} von {count} fehlt im Credential Store."
                    )))
                }
            }
        }
        Ok(Some(secret))
    }

    fn erase(&self) -> Result<()> {
        self.clear_chunks().map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Sitzungsverwaltung
// ---------------------------------------------------------------------------

/// Kapselt Speichern, Laden und das lautlose Erneuern beim Start.
pub struct SessionManager<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> SessionManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Schreibt eine frisch angemeldete Sitzung in den Store. Ein bereits
    /// verbundenes Konto wird ersetzt, ein neues kommt dazu und wird aktiv.
    pub fn save(&self, outcome: &LoginOutcome) -> Result<StoredSession> {
        let session = StoredSession::from_outcome(outcome);
        let mut book = self.load_book()?;
        book.upsert(session.clone());
        self.save_book(&book)?;
        Ok(session)
    }

    /// Ersetzt das aktive Konto, ohne die Auswahl zu verändern.
    pub fn replace_account(&self, outcome: &LoginOutcome) -> Result<StoredSession> {
        let session = StoredSession::from_outcome(outcome);
        let mut book = self.load_book()?;
        book.replace(session.clone());
        if book.active.is_none() {
            book.active = Some(session.uuid.clone());
        }
        self.save_book(&book)?;
        Ok(session)
    }

    /// Liest alle Konten, ohne das Netz zu benutzen. Ein beschädigter Eintrag
    /// wird gemeldet; nur [`restore_account`](Self::restore_account) verwirft
    /// ihn, damit ein Lesefehler nicht unbemerkt eine Sitzung löscht.
    pub fn load_book(&self) -> Result<AccountBook> {
        let Some(raw) = self.store.read()? else {
            return Ok(AccountBook::default());
        };
        AccountBook::from_json(&raw)
    }

    pub fn save_book(&self, book: &AccountBook) -> Result<()> {
        if book.is_empty() {
            return self.store.erase();
        }
        self.store.write(&book.to_json()?)
    }

    /// Aktives Konto, ohne das Netz zu benutzen.
    pub fn load(&self) -> Result<Option<StoredSession>> {
        Ok(self.load_book()?.active_account().cloned())
    }

    pub fn set_active(&self, id: &str) -> Result<AccountBook> {
        let mut book = self.load_book()?;
        book.select(id);
        self.save_book(&book)?;
        Ok(book)
    }

    pub fn remove_account(&self, id: &str) -> Result<AccountBook> {
        let mut book = self.load_book()?;
        book.remove(id);
        self.save_book(&book)?;
        Ok(book)
    }

    pub fn clear(&self) -> Result<()> {
        self.store.erase()
    }

    /// Lädt die Sitzung beim Start und erneuert sie nur, wenn sie abgelaufen ist.
    ///
    /// - gültig → sofort zurück, kein Netzwerkzugriff
    /// - abgelaufen mit Refresh-Token → [`MicrosoftAuth::refresh`], Ergebnis wird gespeichert
    /// - abgelaufen ohne Refresh-Token oder `invalid_grant` → Sitzung wird gelöscht
    pub async fn restore(&self, auth: &MicrosoftAuth) -> Result<Option<StoredSession>> {
        self.restore_account(auth, None).await
    }

    /// Erneuert ein Konto (Standard: das aktive), wenn sein Token abgelaufen
    /// ist. Andere Konten bleiben unberührt.
    pub async fn restore_account(
        &self,
        auth: &MicrosoftAuth,
        account_id: Option<&str>,
    ) -> Result<Option<StoredSession>> {
        let mut book = match self.load_book() {
            Ok(book) => book,
            // Ein beschädigter Eintrag würde sonst bei jedem Start erneut
            // scheitern: einmal verwerfen und frisch anmelden lassen.
            Err(SessionError::Json(_)) | Err(SessionError::Corrupt(_)) => {
                self.clear()?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let session = match account_id {
            Some(id) => book
                .accounts
                .iter()
                .find(|account| account.uuid.eq_ignore_ascii_case(id))
                .cloned(),
            None => book.active_account().cloned(),
        };
        let Some(session) = session else {
            return Ok(None);
        };

        if session.tokens_valid(now_ms()) {
            return Ok(Some(session));
        }

        let Some(refresh_token) = session.refresh_token().map(str::to_string) else {
            // Abgelaufen und nicht erneuerbar: lieber sauber abmelden als
            // mit einem toten Token in den Startbefehl zu laufen.
            book.remove(&session.uuid);
            self.save_book(&book)?;
            return Ok(None);
        };

        match auth.refresh(&refresh_token).await {
            Ok(outcome) => {
                let refreshed = StoredSession::from_outcome(&outcome);
                book.replace(refreshed.clone());
                self.save_book(&book)?;
                Ok(Some(refreshed))
            }
            Err(AuthError::InvalidGrant) => {
                book.remove(&session.uuid);
                self.save_book(&book)?;
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{McProfile, MicrosoftTokens, MinecraftCredentials};

    fn outcome(mc_token: &str, refresh: Option<&str>) -> LoginOutcome {
        LoginOutcome {
            microsoft: MicrosoftTokens {
                access_token: "ms-token".to_string(),
                refresh_token: refresh.map(str::to_string),
                expires_at: now_ms() + 3_600_000,
            },
            minecraft: MinecraftCredentials {
                access_token: mc_token.to_string(),
                expires_at: now_ms() + 3_600_000,
                profile: McProfile {
                    id: "0123456789abcdef0123456789abcdef".to_string(),
                    name: "TestUser".to_string(),
                },
            },
        }
    }

    #[test]
    fn split_and_rejoin_preserve_every_character() {
        let secret = "x".repeat(CHUNK_CHARS * 3 + 17);
        let chunks = split_secret(&secret);
        assert_eq!(chunks.len(), 4);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.chars().count() <= CHUNK_CHARS));
        assert_eq!(chunks.concat(), secret);
    }

    #[test]
    fn split_handles_multibyte_characters() {
        // Umlaute und Emoji dürfen nicht an einer Byte-Grenze zerschnitten werden.
        let secret = "äöüß🎋".repeat(900);
        let chunks = split_secret(&secret);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), secret);
        for chunk in &chunks {
            let utf16_bytes: usize = chunk.encode_utf16().count() * 2;
            assert!(
                utf16_bytes <= 2560,
                "Teil ist {utf16_bytes} Byte UTF-16 und sprengt das Plattformlimit"
            );
        }
    }

    #[test]
    fn manifest_round_trips_and_rejects_nonsense() {
        assert_eq!(parse_manifest(&manifest_for(7)), Some(7));
        assert_eq!(parse_manifest("bamboo-session-v1:0"), None);
        assert_eq!(
            parse_manifest(&format!("bamboo-session-v1:{}", MAX_CHUNKS + 1)),
            None
        );
        assert_eq!(parse_manifest("fremdes-format"), None);
        assert_eq!(parse_manifest("bamboo-session-v1:abc"), None);
    }

    #[test]
    fn memory_store_round_trips_a_session() {
        let manager = SessionManager::new(MemoryStore::new());
        assert!(manager.load().unwrap().is_none());

        let saved = manager.save(&outcome("mc-token", Some("refresh"))).unwrap();
        assert_eq!(saved.username, "TestUser");

        let loaded = manager.load().unwrap().unwrap();
        assert_eq!(loaded.minecraft_access_token, "mc-token");
        assert_eq!(loaded.refresh_token(), Some("refresh"));
        assert_eq!(loaded.account().username, "TestUser");

        manager.clear().unwrap();
        assert!(manager.load().unwrap().is_none());
    }

    #[test]
    fn account_from_session_uses_microsoft_login() {
        let session = StoredSession::from_outcome(&outcome("mc-token", None));
        let account = session.account();
        assert_eq!(account.user_type, UserType::Msa);
        assert_eq!(account.access_token, "mc-token");
        assert_eq!(account.uuid, "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn tokens_are_refreshed_before_they_expire() {
        let now = 1_000_000;
        let mut session = StoredSession::from_outcome(&outcome("mc-token", None));
        session.minecraft_expires_at = now + EXPIRY_MARGIN_MS + 1;
        assert!(session.tokens_valid(now));

        session.minecraft_expires_at = now + EXPIRY_MARGIN_MS;
        assert!(!session.tokens_valid(now));

        session.minecraft_expires_at = now - 1;
        assert!(!session.tokens_valid(now));
    }

    #[test]
    fn blank_refresh_token_counts_as_absent() {
        let mut session = StoredSession::from_outcome(&outcome("mc-token", Some("")));
        assert_eq!(session.refresh_token(), None);
        session.microsoft_refresh_token = Some("echt".to_string());
        assert_eq!(session.refresh_token(), Some("echt"));
    }

    #[test]
    fn expiry_is_described_in_human_units() {
        let now = 1_000_000_000;
        assert_eq!(describe_expiry(now, now), "abgelaufen");
        assert_eq!(
            describe_expiry(now + 30_000, now),
            "noch 30 Sekunden gültig"
        );
        assert_eq!(
            describe_expiry(now + 600_000, now),
            "noch 10 Minuten gültig"
        );
        assert_eq!(
            describe_expiry(now + 7_200_000, now),
            "noch 2 Stunden gültig"
        );
        assert_eq!(
            describe_expiry(now + 172_800_000, now),
            "noch 2 Tagen gültig"
        );
    }

    fn session(uuid: &str, name: &str) -> StoredSession {
        StoredSession {
            username: name.to_string(),
            uuid: uuid.to_string(),
            minecraft_access_token: format!("token-{uuid}"),
            minecraft_expires_at: 9_999_999_999_999,
            microsoft_access_token: String::new(),
            microsoft_refresh_token: None,
            microsoft_expires_at: 0,
        }
    }

    #[test]
    fn several_accounts_survive_a_round_trip() {
        let manager = SessionManager::new(MemoryStore::new());
        let mut book = AccountBook::default();
        book.upsert(session("aaa", "Alpha"));
        book.upsert(session("bbb", "Beta"));
        manager.save_book(&book).unwrap();

        let loaded = manager.load_book().unwrap();
        assert_eq!(loaded.accounts.len(), 2);
        assert_eq!(loaded.active_account().unwrap().username, "Beta");

        // Switching keeps both accounts and only changes the selection.
        assert!(manager.set_active("aaa").unwrap().active.as_deref() == Some("aaa"));
        assert_eq!(manager.load_book().unwrap().accounts.len(), 2);

        // Removing the active account falls back to the remaining one.
        let remaining = manager.remove_account("aaa").unwrap();
        assert_eq!(remaining.accounts.len(), 1);
        assert_eq!(remaining.active.as_deref(), Some("bbb"));
    }

    #[test]
    fn a_legacy_single_session_becomes_the_first_account() {
        let store = MemoryStore::new();
        store
            .write(&serde_json::to_string(&session("ccc", "Legacy")).unwrap())
            .unwrap();
        let manager = SessionManager::new(store);
        let book = manager.load_book().unwrap();
        assert_eq!(book.accounts.len(), 1);
        assert_eq!(book.active.as_deref(), Some("ccc"));
        assert_eq!(manager.load().unwrap().unwrap().username, "Legacy");
    }

    #[test]
    fn corrupt_payload_is_reported_not_swallowed() {
        let store = MemoryStore::new();
        store.write("{ kein json").unwrap();
        let manager = SessionManager::new(store);
        assert!(matches!(manager.load(), Err(SessionError::Json(_))));
    }

    #[tokio::test]
    async fn corrupt_session_is_discarded_on_restore() {
        use crate::auth::{AuthConfig, AuthEndpoints};

        // Alle Endpunkte sind tot: Ein Aufruf hier wäre ein Fehler.
        let auth = MicrosoftAuth::with_config(AuthConfig {
            endpoints: AuthEndpoints {
                authority: "http://127.0.0.1:1".to_string(),
                xbox_user: "http://127.0.0.1:1/xbl".to_string(),
                xsts: "http://127.0.0.1:1/xsts".to_string(),
                minecraft_login: "http://127.0.0.1:1/login".to_string(),
                minecraft_profile: "http://127.0.0.1:1/profile".to_string(),
            },
            ..AuthConfig::default()
        });

        let store = MemoryStore::new();
        store.write("{ kein json").unwrap();
        let manager = SessionManager::new(store);

        assert!(manager.restore(&auth).await.unwrap().is_none());
        assert!(
            manager.store().read().unwrap().is_none(),
            "beschädigte Sitzung muss verworfen werden"
        );
    }
}
