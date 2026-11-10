//! Crash-log analysis and its fix actions.
//!
//! Fewer rules than the Electron original, but every action offered here runs:
//! heap raise, mod disable, opening a folder, opening a URL.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use bamboo_launcher::config;
use serde_json::{json, Value};

use crate::ipc;

#[derive(Clone)]
struct Action {
    id: String,
    kind: &'static str,
    payload: Value,
}

#[derive(Clone)]
struct Finding {
    rule: &'static str,
    confidence: &'static str,
    title: &'static str,
    detail: String,
    evidence: Vec<String>,
    actions: Vec<Action>,
}

struct Analysis {
    findings: Vec<Finding>,
}

enum Undo {
    Memory(u32),
    Rename(PathBuf, PathBuf),
}

static ANALYSES: OnceLock<Mutex<HashMap<String, Analysis>>> = OnceLock::new();
static UNDO: OnceLock<Mutex<HashMap<String, Undo>>> = OnceLock::new();

fn analyses() -> &'static Mutex<HashMap<String, Analysis>> {
    ANALYSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn undos() -> &'static Mutex<HashMap<String, Undo>> {
    UNDO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_log(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn jar_in(line: &str) -> Option<String> {
    let start = line.find(|ch: char| ch.is_ascii_alphanumeric())?;
    let text = &line[start..];
    let end = text.find(".jar")?;
    let name: String = text[..end]
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_alphanumeric() || "-_.".contains(*ch))
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    (!name.is_empty()).then(|| format!("{name}.jar"))
}

fn evidence(log: &str, needle: &str) -> Vec<String> {
    log.lines()
        .filter(|line| line.contains(needle))
        .take(3)
        .map(|line| line.trim().chars().take(240).collect())
        .collect()
}

fn analyze_log(log: &str, mods_dir: &Path, logs_dir: &Path) -> Vec<Finding> {
    let mut findings = Vec::new();
    let open_mods = Action {
        id: "open-mods".to_string(),
        kind: "open-path",
        payload: json!({ "path": mods_dir.to_string_lossy() }),
    };
    let open_logs = Action {
        id: "open-logs".to_string(),
        kind: "open-path",
        payload: json!({ "path": logs_dir.to_string_lossy() }),
    };
    // Only offered when the log names the file, so the action always finds it.
    let disable_jar = log.lines().find_map(jar_in).map(|jar| Action {
        id: format!("disable-{jar}"),
        kind: "disable-mod",
        payload: json!({
            "jar": jar,
            "targetDir": mods_dir.to_string_lossy(),
        }),
    });

    if log.contains("OutOfMemoryError") || log.contains("Java heap space") {
        let current = ipc::load_rust_settings().memory.max_mb;
        let target = (current + 2048).min(config::MAX_MEMORY_MB).max(2048);
        findings.push(Finding {
            rule: "out-of-memory",
            confidence: "certain",
            title: "Zu wenig Arbeitsspeicher",
            detail: format!("Das Spiel hat den Heap gesprengt. {target} MB geben mehr Luft."),
            evidence: evidence(log, "OutOfMemoryError"),
            actions: vec![
                Action {
                    id: "raise-heap".to_string(),
                    kind: "raise-heap",
                    payload: json!({ "toMb": target }),
                },
                Action {
                    id: "open-jvm".to_string(),
                    kind: "open-url",
                    payload: json!({ "url": "https://docs.oracle.com/en/java/javase/21/gctuning/" }),
                },
            ],
        });
    }

    if log.contains("UnsupportedClassVersionError") {
        let major = log
            .split("UnsupportedClassVersionError")
            .nth(1)
            .and_then(|tail| {
                let text = tail
                    .split("compiled by a more recent version")
                    .next()
                    .unwrap_or(tail);
                text.split(|ch: char| !ch.is_ascii_digit())
                    .filter(|part| !part.is_empty())
                    .next()
                    .map(str::to_string)
            })
            .unwrap_or_default();
        findings.push(Finding {
            rule: "java-too-old",
            confidence: "certain",
            title: "Java ist zu alt",
            detail: if major.is_empty() {
                "Mindestens eine Mod braucht ein neueres Java.".to_string()
            } else {
                format!(
                    "Eine Mod wurde mit Java {major} gebaut; das Spiel startet mit einem älteren."
                )
            },
            evidence: evidence(log, "UnsupportedClassVersionError"),
            actions: vec![Action {
                id: "java-help".to_string(),
                kind: "open-url",
                payload: json!({ "url": "https://adoptium.net/temurin/releases/" }),
            }],
        });
    }

    if log.contains("Missing or unsupported mandatory dependencies")
        || log.contains("requires any version of")
        || log.contains("requires version")
    {
        findings.push(Finding {
            rule: "missing-dependency-fabric",
            confidence: "likely",
            title: "Fehlende Abhängigkeit",
            detail: "Eine Mod verlangt eine andere Mod, die nicht im mods-Ordner liegt."
                .to_string(),
            evidence: evidence(log, "requires"),
            actions: vec![open_mods.clone()],
        });
    }

    if log.to_lowercase().contains("duplicate mod") || log.contains("Duplicate mods") {
        findings.push(Finding {
            rule: "duplicate-mod",
            confidence: "certain",
            title: "Mod doppelt installiert",
            detail: "Zwei Mods mit derselben ID liegen im mods-Ordner.".to_string(),
            evidence: evidence(log, "uplicate"),
            actions: disable_jar
                .clone()
                .into_iter()
                .chain([open_mods.clone()])
                .collect(),
        });
    }

    if log.contains("Mixin apply failed") || log.contains("mixin.injection.throwables") {
        findings.push(Finding {
            rule: "mixin-apply-failed",
            confidence: "likely",
            title: "Mixin greift nicht",
            detail: "Eine Mod passt nicht zur installierten Version einer anderen.".to_string(),
            evidence: evidence(log, "Mixin"),
            actions: disable_jar
                .clone()
                .into_iter()
                .chain([open_mods.clone(), open_logs.clone()])
                .collect(),
        });
    }

    if log.contains("zip END header not found")
        || log.contains("Invalid or corrupt jarfile")
        || log.contains("error in opening zip file")
    {
        findings.push(Finding {
            rule: "corrupt-jar",
            confidence: "certain",
            title: "Beschädigte JAR-Datei",
            detail: "Ein Download ist unvollständig. Datei löschen und neu laden.".to_string(),
            evidence: log
                .lines()
                .filter(|line| line.contains(".jar"))
                .take(3)
                .map(|line| line.trim().chars().take(240).collect())
                .collect(),
            actions: disable_jar
                .clone()
                .into_iter()
                .chain([open_mods.clone()])
                .collect(),
        });
    }

    if log.contains("GLFW error") || log.contains("Failed to create window") {
        findings.push(Finding {
            rule: "graphics-driver",
            confidence: "possible",
            title: "Grafiktreiber-Problem",
            detail: "Minecraft konnte kein Fenster öffnen. Treiber aktualisieren.".to_string(),
            evidence: evidence(log, "GLFW"),
            actions: vec![Action {
                id: "gpu-help".to_string(),
                kind: "open-url",
                payload: json!({ "url": "https://www.minecraft.net/en-us/support" }),
            }],
        });
    }

    if findings.is_empty() && !log.is_empty() {
        findings.push(Finding {
            rule: "no-class-def",
            confidence: "possible",
            title: "Kein klares Muster",
            detail:
                "Im Log steht kein bekanntes Fehlerbild. Die letzten Zeilen zeigen den Abbruch."
                    .to_string(),
            evidence: log
                .lines()
                .filter(|line| line.contains("ERROR") || line.contains("Exception"))
                .take(3)
                .map(|line| line.trim().chars().take(240).collect())
                .collect(),
            actions: vec![open_logs],
        });
    }

    findings
}

#[tauri::command]
pub fn logs_analyze(instance_id: String) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let manager = ipc::manager(&root);
    let dir = match manager.load(&instance_id) {
        Ok(instance) => instance.dir,
        Err(_) => root.clone(),
    };
    let logs_dir = dir.join("logs");
    let mut log_path = logs_dir.join("latest.log");
    if !log_path.is_file() {
        // A crash may have written only a crash report.
        let reports = dir.join("crash-reports");
        if let Ok(entries) = std::fs::read_dir(&reports) {
            if let Some(newest) = entries
                .flatten()
                .filter(|entry| entry.path().is_file())
                .max_by_key(|entry| {
                    std::fs::metadata(entry.path())
                        .and_then(|meta| meta.modified())
                        .ok()
                })
            {
                log_path = newest.path();
            }
        }
    }

    let log = read_log(&log_path);
    if log.trim().is_empty() {
        return json!({
            "id": format!("{instance_id}:0"),
            "instanceId": instance_id,
            "truncated": false,
            "findings": [],
            "reasons": ["crash.no-signal"],
        });
    }
    let findings = analyze_log(&log, &dir.join("mods"), &logs_dir);
    let id = format!(
        "{instance_id}:{}",
        std::process::id() as u64 * 1000 + log.len() as u64
    );
    let result = json!({
        "id": id,
        "instanceId": instance_id,
        "truncated": log.len() > 2_000_000,
        "findings": findings.iter().map(|finding| json!({
            "ruleId": finding.rule,
            "confidence": finding.confidence,
            "title": finding.title,
            "detail": finding.detail,
            "evidence": finding.evidence,
            "actions": finding.actions.iter().map(|action| {
                let mut value = json!({ "id": action.id, "kind": action.kind });
                if let Some(object) = action.payload.as_object() {
                    for (key, item) in object {
                        value[key] = item.clone();
                    }
                }
                value
            }).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "reasons": [],
    });

    analyses()
        .lock()
        .unwrap()
        .insert(id.clone(), Analysis { findings });
    result
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

#[tauri::command]
pub fn logs_apply_fix(analysis_id: String, action_id: String) -> Value {
    let action = {
        let guard = analyses().lock().unwrap();
        guard.get(&analysis_id).and_then(|analysis| {
            analysis
                .findings
                .iter()
                .flat_map(|finding| finding.actions.iter())
                .find(|action| action.id == action_id)
                .cloned()
        })
    };
    let Some(action) = action else {
        return failure("INVALID", "Die Analyse ist nicht mehr verfügbar.");
    };

    match action.kind {
        "raise-heap" => {
            let Some(target) = action.payload.get("toMb").and_then(Value::as_u64) else {
                return failure("INVALID", "Kein Zielwert.");
            };
            let mut settings = ipc::load_rust_settings();
            let previous = settings.memory.max_mb;
            settings.memory = config::MemorySettings::new(
                settings.memory.min_mb.min(target as u32),
                target as u32,
            );
            if let Err(error) = settings.save(&config::default_core_settings_path()) {
                return failure("EACCES", &error.to_string());
            }
            let token = format!("undo-{}", super::next_token());
            undos()
                .lock()
                .unwrap()
                .insert(token.clone(), Undo::Memory(previous));
            json!({
                "ok": true,
                "changed": [format!("maxMemory {previous} -> {target}")],
                "undoToken": token,
                "requiresRestart": true,
            })
        }
        "disable-mod" => {
            let Some(jar) = action.payload.get("jar").and_then(Value::as_str) else {
                return failure("INVALID", "Keine Datei.");
            };
            let target = PathBuf::from(
                action
                    .payload
                    .get("targetDir")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .join(jar);
            if !target.is_file() {
                return failure("ENOENT", "Die Datei liegt nicht mehr dort.");
            }
            let disabled = PathBuf::from(format!("{}.disabled", target.to_string_lossy()));
            if std::fs::rename(&target, &disabled).is_err() {
                return failure("EACCES", "Die Datei ließ sich nicht umbenennen.");
            }
            let token = format!("undo-{}", super::next_token());
            undos()
                .lock()
                .unwrap()
                .insert(token.clone(), Undo::Rename(target, disabled.clone()));
            json!({
                "ok": true,
                "changed": [disabled.to_string_lossy()],
                "undoToken": token,
                "requiresRestart": true,
            })
        }
        "open-path" => {
            let path = action
                .payload
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match ipc::open_path(Path::new(path)) {
                Ok(()) => json!({ "ok": true, "changed": [], "requiresRestart": false }),
                Err(error) => failure("EACCES", &error),
            }
        }
        "open-url" => {
            let url = action
                .payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return failure("INVALID", "Nur http(s) erlaubt.");
            }
            match bamboo_launcher::auth::open_browser(url) {
                Ok(()) => json!({ "ok": true, "changed": [], "requiresRestart": false }),
                Err(error) => failure("EACCES", &error.to_string()),
            }
        }
        _ => failure("INVALID", "Unbekannte Aktion."),
    }
}

#[tauri::command]
pub fn logs_undo_fix(undo_token: String) -> Value {
    let Some(undo) = undos().lock().unwrap().remove(&undo_token) else {
        return failure(
            "INVALID",
            "Die Aktion kann nicht mehr rückgängig gemacht werden.",
        );
    };
    match undo {
        Undo::Memory(previous) => {
            let mut settings = ipc::load_rust_settings();
            settings.memory =
                config::MemorySettings::new(settings.memory.min_mb.min(previous), previous);
            match settings.save(&config::default_core_settings_path()) {
                Ok(()) => json!({ "ok": true, "changed": [], "requiresRestart": true }),
                Err(error) => failure("EACCES", &error.to_string()),
            }
        }
        Undo::Rename(original, current) => {
            if std::fs::rename(&current, &original).is_err() {
                return failure("EACCES", "Die Datei ließ sich nicht zurückbenennen.");
            }
            json!({
                "ok": true,
                "changed": [original.to_string_lossy()],
                "requiresRestart": true,
            })
        }
    }
}

/// Diagnostics the support bundle may contain, with token-bearing lines removed.
fn redact(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let lower = line.to_lowercase();
            !(lower.contains("accesstoken")
                || lower.contains("refreshtoken")
                || lower.contains("authorization:"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn logs_support_bundle(destination: String) -> Value {
    let root = ipc::load_rust_settings().game_root;
    let target = PathBuf::from(&destination);
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(file) = std::fs::File::create(&target) else {
        return json!({ "error": "Datei konnte nicht angelegt werden." });
    };
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut entries = Vec::new();
    let mut sanitized = 0;

    let mut push = |name: String, body: Vec<u8>, zip: &mut zip::ZipWriter<std::fs::File>| {
        use std::io::Write;
        if zip.start_file(name.clone(), options).is_ok() && zip.write_all(&body).is_ok() {
            entries.push(name);
        }
    };

    if let Ok(listed) = ipc::manager(&root).list() {
        for instance in listed {
            let latest = instance.dir.join("logs").join("latest.log");
            if latest.is_file() {
                let text = redact(&read_log(&latest));
                sanitized += 1;
                push(
                    format!("{}/latest.log", instance.name),
                    text.into_bytes(),
                    &mut zip,
                );
            }
            let meta = instance.dir.join("instance.json");
            if meta.is_file() {
                push(
                    format!("{}/instance.json", instance.name),
                    std::fs::read(&meta).unwrap_or_default(),
                    &mut zip,
                );
            }
        }
    }
    let settings = config::default_core_settings_path();
    if settings.is_file() {
        push(
            "core-settings.json".to_string(),
            std::fs::read(&settings).unwrap_or_default(),
            &mut zip,
        );
    }
    drop(push);

    if zip.finish().is_err() {
        let _ = std::fs::remove_file(&target);
        return json!({ "error": "Archiv konnte nicht geschrieben werden." });
    }
    let bytes = std::fs::metadata(&target)
        .map(|meta| meta.len())
        .unwrap_or(0);
    json!({
        "file": target.to_string_lossy(),
        "entries": entries,
        "bytes": bytes,
        "sanitizedLogFiles": sanitized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jar_name_is_taken_from_the_log_line() {
        assert_eq!(
            jar_in("Caused by: java.lang.Error in sodium-fabric-0.5.8.jar"),
            Some("sodium-fabric-0.5.8.jar".to_string())
        );
        assert_eq!(jar_in("kein Treffer"), None);
    }

    #[test]
    fn support_bundle_drops_token_lines() {
        let text = "a\nAccessToken: geheim\nb\nrefreshToken: auch";
        assert_eq!(redact(text), "a\nb");
    }

    #[test]
    fn heap_crash_becomes_a_fixable_finding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let findings = analyze_log(
            "java.lang.OutOfMemoryError: Java heap space",
            &dir.path().join("mods"),
            &dir.path().join("logs"),
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "out-of-memory");
        assert!(findings[0]
            .actions
            .iter()
            .any(|action| action.kind == "raise-heap"));
    }

    #[test]
    fn unknown_crash_offers_the_log_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let findings = analyze_log(
            "[12:00:00] [Render thread/ERROR]: etwas Unbekanntes",
            &dir.path().join("mods"),
            &dir.path().join("logs"),
        );
        assert_eq!(findings.len(), 1);
        assert!(findings[0]
            .actions
            .iter()
            .any(|action| action.kind == "open-path"));
    }
}
