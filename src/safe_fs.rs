//! Dateioperationen, die eine Instanz nicht beschädigen können.
//!
//! Kopiert wird nur über Staging und Undo-Journal: Bricht ein Vorgang ab, wird
//! der alte Stand zurückgeschrieben, statt eine halb überschriebene Instanz zu
//! hinterlassen. Links – unter Windows auch Junctions – werden nie verfolgt:
//! weder beim Lesen aus einem Quellbaum noch beim Schreiben in einen Zielbaum.
//! Ein Link in der Instanz kann damit keine fremde Datei außerhalb der Wurzel
//! erwischen.

use crate::error::{LauncherError, Result};
use std::path::{Path, PathBuf};

/// Ein Eintrag im Undo-Journal: relativer Pfad und ob dort vorher eine Datei lag.
pub type Journal = Vec<(PathBuf, bool)>;

/// Ist der Pfad selbst ein Link? `symlink_metadata` beschreibt den Link,
/// `metadata` würde ihm folgen und damit aus dem Baum herauszeigen.
pub fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Löscht Datei oder Ordner; fehlt der Pfad, ist das kein Fehler. Ein Link wird
/// selbst entfernt, sein Ziel bleibt unangetastet.
pub fn remove_path(path: &Path) -> Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        // `remove_file` scheitert bei einer Junction; der Ordnerpfad entfernt
        // nur den Verknüpfungspunkt, nicht den Inhalt dahinter.
        if std::fs::remove_file(path).is_err() {
            std::fs::remove_dir(path)?;
        }
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Kopiert Dateien und Ordner und zählt dabei mit. Links werden übersprungen:
/// ihnen zu folgen könnte aus der Quelle herausführen.
pub fn copy_tree(source: &Path, target: &Path, files: &mut usize, bytes: &mut u64) -> Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(source) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()), files, bytes)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Ok(());
    }
    std::fs::copy(source, target)?;
    *files += 1;
    *bytes = bytes.saturating_add(meta.len());
    Ok(())
}

/// Schreibt einen Staging-Baum ins Ziel. Jede Datei, die dabei überschrieben
/// wird, landet vorher im Undo-Ordner; `journal` merkt sich in Reihenfolge, was
/// angefasst wurde. Ein Link im Ziel wird abgelehnt statt durchschrieben.
pub fn apply_tree(
    staged: &Path,
    target: &Path,
    undo: &Path,
    relative: &Path,
    journal: &mut Journal,
) -> Result<()> {
    if is_link(target) {
        return Err(LauncherError::UnsafePath(target.to_path_buf()));
    }
    let Ok(meta) = std::fs::symlink_metadata(staged) else {
        return Ok(());
    };
    if meta.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(staged)? {
            let entry = entry?;
            apply_tree(
                &entry.path(),
                &target.join(entry.file_name()),
                undo,
                &relative.join(entry.file_name()),
                journal,
            )?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let had_old = target.is_file();
    if had_old {
        let saved = undo.join(relative);
        if let Some(parent) = saved.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(target, &saved)?;
    }
    // Vor dem Kopieren eintragen: bricht es ab, ist die Datei schon halb
    // geschrieben und muss aus dem Undo-Stand zurück.
    journal.push((relative.to_path_buf(), had_old));
    std::fs::copy(staged, target)?;
    Ok(())
}

/// Stellt den Stand vor dem Einspielen wieder her: überschriebene Dateien aus
/// dem Undo-Ordner, neu angelegte Dateien werden entfernt, und Ordner, die es
/// vorher nicht gab, verschwinden vollständig.
pub fn roll_back(instance_dir: &Path, undo: &Path, journal: &Journal, fresh_roots: &[PathBuf]) {
    for (relative, had_old) in journal.iter().rev() {
        let target = instance_dir.join(relative);
        if *had_old {
            let _ = std::fs::copy(undo.join(relative), &target);
        } else {
            let _ = std::fs::remove_file(&target);
        }
    }
    for root in fresh_roots {
        if root.is_dir() {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

/// Was ein Vorgang wegnimmt, landet erst hier: `discard` löscht endgültig,
/// `restore` legt alles zurück. Ein Abbruch mitten im Aufräumen hinterlässt so
/// keinen halb geleerten Baum – entweder ist alles weg oder alles wieder da.
pub struct Trash {
    root: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl Trash {
    /// Jeder Lauf bekommt einen eigenen Unterordner unter `parent`: Reste eines
    /// früheren Laufs werden weder überschrieben noch mitgelöscht.
    pub fn under(parent: &Path) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Self {
            root: parent.join(stamp.to_string()),
            moved: Vec::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Verschiebt `path` in den Papierkorb; ein fehlender Pfad ist kein Fehler.
    /// `rename` verschiebt auch einen Link selbst – sein Ziel bleibt liegen.
    pub fn take(&mut self, path: &Path) -> Result<bool> {
        if std::fs::symlink_metadata(path).is_err() {
            return Ok(false);
        }
        std::fs::create_dir_all(&self.root)?;
        let slot = self.root.join(self.moved.len().to_string());
        std::fs::rename(path, &slot)?;
        self.moved.push((path.to_path_buf(), slot));
        Ok(true)
    }

    /// Legt alles zurück. Liefert die Pfade, die nicht zurückkonnten; nur dann
    /// bleibt der Papierkorb liegen, damit nichts verlorengeht.
    pub fn restore(&mut self) -> Vec<PathBuf> {
        let mut stuck = Vec::new();
        while let Some((original, slot)) = self.moved.pop() {
            if std::fs::rename(&slot, &original).is_err() {
                stuck.push(original);
            }
        }
        if stuck.is_empty() {
            let _ = self.remove_root();
        }
        stuck
    }

    /// Löscht den Papierkorb endgültig.
    pub fn discard(&mut self) -> Result<()> {
        self.moved.clear();
        self.remove_root()
    }

    fn remove_root(&self) -> Result<()> {
        remove_path(&self.root)?;
        if let Some(parent) = self.root.parent() {
            let empty = std::fs::read_dir(parent)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if empty {
                let _ = std::fs::remove_dir(parent);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    /// Legt einen Ordner-Link an. Windows erlaubt echte Symlinks ohne
    /// Administratorrechte nicht; eine Junction zeigt genauso aus dem Baum
    /// heraus und wird von `symlink_metadata` als Link gemeldet. `false` heißt:
    /// Diese Maschine kann keine Links anlegen, der Test wird übersprungen.
    pub fn dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            // `cmd` hält `/` für einen Schalter; Pfade brauchen native Trenner.
            let native = |path: &Path| path.to_string_lossy().replace('/', "\\");
            match std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(native(link))
                .arg(native(target))
                .output()
            {
                Ok(output) if output.status.success() => true,
                Ok(output) => {
                    eprintln!(
                        "mklink fehlgeschlagen: {}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                    false
                }
                Err(error) => {
                    eprintln!("mklink nicht startbar: {error}");
                    false
                }
            }
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safe_fs::test_support::dir_link;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn copy_tree_does_not_follow_links() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("quelle");
        let outside = dir.path().join("aussen");
        write(&source.join("bleibt.txt"), "drinnen");
        write(&outside.join("geheim.txt"), "draussen");
        if !dir_link(&outside, &source.join("link")) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }

        let target = dir.path().join("ziel");
        let mut files = 0;
        let mut bytes = 0;
        copy_tree(&source, &target, &mut files, &mut bytes).unwrap();

        assert_eq!(files, 1, "nur die echte Datei darf kopiert werden");
        assert!(target.join("bleibt.txt").is_file());
        assert!(
            !target.join("link").exists(),
            "dem Link darf nicht gefolgt werden"
        );
        assert!(
            !target.join("geheim.txt").exists(),
            "Datei außerhalb der Quelle wurde mitkopiert"
        );
    }

    #[test]
    fn apply_tree_refuses_a_linked_target() {
        let dir = tempfile::tempdir().unwrap();
        let instance = dir.path().join("instanz");
        let outside = dir.path().join("aussen");
        std::fs::create_dir_all(&instance).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !dir_link(&outside, &instance.join("config")) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }

        let staged = dir.path().join("staging");
        write(&staged.join("config/one.toml"), "neu");

        let mut journal = Journal::new();
        let error = apply_tree(
            &staged.join("config"),
            &instance.join("config"),
            &dir.path().join("undo"),
            Path::new("config"),
            &mut journal,
        )
        .unwrap_err();

        assert!(matches!(error, LauncherError::UnsafePath(_)), "{error}");
        assert!(
            !outside.join("one.toml").exists(),
            "durch einen Link darf nicht nach außen geschrieben werden"
        );
        assert!(journal.is_empty());
    }

    #[test]
    fn a_failed_apply_restores_the_previous_files() {
        let dir = tempfile::tempdir().unwrap();
        let instance = dir.path().join("instanz");
        let staged = dir.path().join("staging");
        let undo = dir.path().join("undo");
        write(&instance.join("a.txt"), "alt");
        // An der Stelle der zweiten Datei steht ein Ordner: das Kopieren
        // scheitert, nachdem a.txt schon ersetzt wurde.
        std::fs::create_dir_all(instance.join("z.txt")).unwrap();
        write(&staged.join("a.txt"), "neu");
        write(&staged.join("z.txt"), "neu");

        let mut journal = Journal::new();
        let mut fresh = Vec::new();
        let applied = (|| -> Result<()> {
            for name in ["a.txt", "z.txt"] {
                let target = instance.join(name);
                if !target.exists() {
                    fresh.push(target.clone());
                }
                apply_tree(
                    &staged.join(name),
                    &target,
                    &undo,
                    Path::new(name),
                    &mut journal,
                )?;
            }
            Ok(())
        })();
        assert!(applied.is_err());

        roll_back(&instance, &undo, &journal, &fresh);
        assert_eq!(
            std::fs::read_to_string(instance.join("a.txt")).unwrap(),
            "alt"
        );
    }

    #[test]
    fn a_trash_puts_everything_back_on_restore() {
        let dir = tempfile::tempdir().unwrap();
        let instance = dir.path().join("instanz");
        write(&instance.join("mods/a.jar"), "a");
        write(&instance.join("mods/b.jar"), "b");
        let mut trash = Trash::under(&instance.join("papierkorb"));

        assert!(trash.take(&instance.join("mods/a.jar")).unwrap());
        assert!(trash.take(&instance.join("mods/b.jar")).unwrap());
        assert!(!instance.join("mods/a.jar").exists());

        assert!(trash.restore().is_empty(), "alles muss zurückkönnen");
        assert_eq!(
            std::fs::read_to_string(instance.join("mods/a.jar")).unwrap(),
            "a"
        );
        assert_eq!(
            std::fs::read_to_string(instance.join("mods/b.jar")).unwrap(),
            "b"
        );
        assert!(
            !instance.join("papierkorb").exists(),
            "ein leerer Papierkorb bleibt nicht liegen"
        );
    }

    #[test]
    fn a_trash_never_deletes_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let instance = dir.path().join("instanz");
        let outside = dir.path().join("aussen");
        write(&outside.join("geheim.txt"), "draussen");
        std::fs::create_dir_all(&instance).unwrap();
        if !dir_link(&outside, &instance.join("config")) {
            eprintln!("Links werden auf dieser Maschine nicht unterstützt; Test übersprungen");
            return;
        }

        let mut trash = Trash::under(&instance.join("papierkorb"));
        assert!(trash.take(&instance.join("config")).unwrap());
        trash.discard().unwrap();

        assert!(!instance.join("config").exists());
        assert!(
            outside.join("geheim.txt").is_file(),
            "hinter dem Link darf nichts gelöscht werden"
        );
    }
}
