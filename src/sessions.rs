//! Session-Protokoll je Instanz.
//!
//! Der Launcher kann nur wissen, wann er selbst ein Spiel gestartet und wann
//! der Prozess geendet hat. Genau das steht hier: pro Start ein Eintrag mit
//! Anfang und – sobald das Spiel endet – Ende. Die Statistik-Seite zählt
//! daraus die Sessions und den ersten bzw. letzten Start; die Spielzeit selbst
//! kommt weiterhin aus den `stats`-Dateien der Welten, weil nur das Spiel sie
//! kennt.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Ältere Starts fliegen raus, damit die Datei nicht unbegrenzt wächst.
const MAX_SESSIONS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub start: u64,
    #[serde(default)]
    pub end: Option<u64>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    /// Anzahl gestarteter Sessions, auch die gerade laufende.
    pub count: u64,
    /// Frühester Start, oder 0 wenn es noch keinen gibt.
    pub first_start: u64,
    /// Letzter Start bzw. letztes Ende, oder 0.
    pub last_seen: u64,
}

impl Summary {
    fn push(&mut self, session: &Session) {
        self.count += 1;
        if self.first_start == 0 || session.start < self.first_start {
            self.first_start = session.start;
        }
        let seen = session.end.unwrap_or(session.start);
        self.last_seen = self.last_seen.max(seen);
    }
}

pub fn log_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join("bamboo").join("sessions.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Eine kaputte oder halb geschriebene Datei darf den Start nicht verhindern;
/// sie wird dann einfach durch eine leere Liste ersetzt.
fn read_all(instance_dir: &Path) -> Vec<Session> {
    std::fs::read_to_string(log_path(instance_dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Session>>(&text).ok())
        .unwrap_or_default()
}

fn write_all(instance_dir: &Path, sessions: &[Session]) -> Result<(), String> {
    let path = log_path(instance_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Session-Ordner nicht anlegbar: {error}"))?;
    }
    let start = sessions.len().saturating_sub(MAX_SESSIONS);
    let body = serde_json::to_vec(&sessions[start..])
        .map_err(|error| format!("Sessions nicht serialisierbar: {error}"))?;
    std::fs::write(&path, body).map_err(|error| format!("Sessions nicht schreibbar: {error}"))
}

/// Wird nach einem erfolgreichen Spawn aufgerufen.
pub fn record_start(instance_dir: &Path) -> Result<(), String> {
    let mut sessions = read_all(instance_dir);
    sessions.push(Session {
        start: now_ms(),
        end: None,
    });
    write_all(instance_dir, &sessions)
}

/// Schließt die zuletzt offene Session. Ohne offene Session passiert nichts.
pub fn record_end(instance_dir: &Path) -> Result<(), String> {
    let mut sessions = read_all(instance_dir);
    let Some(last) = sessions.last_mut() else {
        return Ok(());
    };
    if last.end.is_some() {
        return Ok(());
    }
    last.end = Some(now_ms());
    write_all(instance_dir, &sessions)
}

pub fn summary(instance_dir: &Path) -> Summary {
    let mut summary = Summary::default();
    for session in read_all(instance_dir) {
        summary.push(&session);
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_and_end_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        record_start(dir.path()).expect("start");
        record_end(dir.path()).expect("end");

        let sessions = read_all(dir.path());
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].start > 0);
        assert!(sessions[0].end.is_some());

        let summary = summary(dir.path());
        assert_eq!(summary.count, 1);
        assert_eq!(summary.first_start, sessions[0].start);
        assert_eq!(summary.last_seen, sessions[0].end.unwrap());
    }

    #[test]
    fn an_open_session_still_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        record_start(dir.path()).expect("start");

        let summary = summary(dir.path());
        assert_eq!(summary.count, 1);
        assert_eq!(summary.last_seen, summary.first_start);
    }

    #[test]
    fn end_without_start_is_a_no_op() {
        let dir = tempfile::tempdir().expect("tempdir");
        record_end(dir.path()).expect("end");
        assert_eq!(summary(dir.path()).count, 0);
    }

    #[test]
    fn corrupt_file_is_replaced_on_the_next_start() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("bamboo")).expect("bamboo");
        std::fs::write(log_path(dir.path()), "{ kaputt").expect("write");

        assert_eq!(summary(dir.path()).count, 0);
        record_start(dir.path()).expect("start");
        assert_eq!(summary(dir.path()).count, 1);
    }

    #[test]
    fn old_sessions_are_dropped_at_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions: Vec<Session> = (0..MAX_SESSIONS + 5)
            .map(|index| Session {
                start: 1000 + index as u64,
                end: Some(1001 + index as u64),
            })
            .collect();
        write_all(dir.path(), &sessions).expect("write");

        let stored = read_all(dir.path());
        assert_eq!(stored.len(), MAX_SESSIONS);
        assert_eq!(stored[0].start, 1005);
        assert_eq!(summary(dir.path()).count, MAX_SESSIONS as u64);
    }
}
