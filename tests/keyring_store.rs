//! Prüft den echten Windows Credential Manager: Ein Token-Satz ist größer als
//! das Plattformlimit von 1280 Zeichen pro Eintrag und muss trotzdem
//! vollständig zurückkommen.
//!
//! Jeder Test arbeitet unter eigenem Dienstnamen und räumt über einen
//! Drop-Wächter auf, damit eine echte Launcher-Sitzung unangetastet bleibt.

#![cfg(windows)]

use bamboo_launcher::token_store::{KeyringStore, SecretStore, CHUNK_CHARS};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Der Windows Credential Manager ist ein prozessweiter Dienst: Parallele
/// Schreib- und Löschvorgänge liefern sporadisch Fehler. Die Tests laufen
/// deshalb nacheinander, auch wenn `cargo test` sie parallel startet.
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

fn exclusive() -> MutexGuard<'static, ()> {
    KEYRING_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fresh_store() -> KeyringStore {
    // Der Zähler ist nötig, weil parallele Tests in derselben Systemuhr-Tick
    // starten können und `SystemTime` dann identische Nanos liefert.
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    KeyringStore::with_names(
        "bamboo-launcher-test",
        format!("session-{}-{id}-{nanos}", std::process::id()),
    )
}

/// Löscht den Testeintrag auch dann, wenn eine Zusicherung fehlschlägt.
struct Cleanup(KeyringStore);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.0.erase();
    }
}

#[test]
fn credential_manager_round_trips_a_session_sized_secret() {
    let _serial = exclusive();
    let store = fresh_store();
    let _cleanup = Cleanup(store.clone());
    store.erase().unwrap();
    assert_eq!(store.read().unwrap(), None, "frischer Testeintrag");

    // Ein realistischer Token-Satz: mehrere JWT-artige Blöcke, deutlich über
    // dem Limit von 1280 Zeichen – das erzwingt mehrere Einträge.
    let secret = format!(
        "{}.{}.{}",
        "a".repeat(1800),
        "äöüß🎋".repeat(600),
        "z".repeat(2200)
    );
    assert!(secret.chars().count() > 3 * CHUNK_CHARS);

    store.write(&secret).unwrap();
    assert!(
        store.stored_chunks().unwrap() > 1,
        "der Satz muss auf mehrere Einträge verteilt sein"
    );

    let restored = store.read().unwrap().expect("Sitzung muss zurückkommen");
    assert_eq!(restored, secret, "Chunking darf kein Zeichen verlieren");

    store.erase().unwrap();
    assert_eq!(store.stored_chunks().unwrap(), 0);
}

#[test]
fn shorter_secret_replaces_longer_one_without_leftovers() {
    let _serial = exclusive();
    let store = fresh_store();
    let _cleanup = Cleanup(store.clone());

    store.write(&"x".repeat(5000)).unwrap();
    assert_eq!(store.stored_chunks().unwrap(), 5);

    store.write("kurz").unwrap();
    assert_eq!(store.stored_chunks().unwrap(), 1);
    assert_eq!(store.read().unwrap().as_deref(), Some("kurz"));

    let long = "y".repeat(7000);
    store.write(&long).unwrap();
    assert_eq!(store.stored_chunks().unwrap(), 7);
    assert_eq!(store.read().unwrap().as_deref(), Some(long.as_str()));

    store.erase().unwrap();
    assert_eq!(store.read().unwrap(), None);
    assert_eq!(
        store.stored_chunks().unwrap(),
        0,
        "erase muss auch alle Teile entfernen"
    );
}

#[test]
fn adjacent_test_stores_do_not_share_a_credential() {
    let _serial = exclusive();
    // Zwei unabhängige Stores mit eigenem Eintragsnamen.
    let first = fresh_store();
    let second = fresh_store();
    let _guard_first = Cleanup(first.clone());
    let _guard_second = Cleanup(second.clone());

    first.write("eins").unwrap();
    second.write("zwei").unwrap();

    assert_eq!(first.read().unwrap().as_deref(), Some("eins"));
    assert_eq!(second.read().unwrap().as_deref(), Some("zwei"));

    first.erase().unwrap();
    second.erase().unwrap();
    assert_eq!(first.stored_chunks().unwrap(), 0);
    assert_eq!(second.stored_chunks().unwrap(), 0);
}
