# Changelog

What changed for people using the launcher. `src/lib/changelog.ts` reads this
file at build time and shows the section for the running version, once per
version, so every release needs a block here in **both** languages.

Group headings are fixed: `Neu` / `Besser` / `Behoben` / `Entfernt` for German,
`New` / `Better` / `Fixed` / `Removed` for English.

## 0.2.3 - 2026-11-04

### Neu

- Neuer Tab „Anpassen“ mit einer Skin-Bibliothek: Skins hochladen, auswählen, umbenennen und löschen, Klassisch oder Slim wählen und direkt auf das Minecraft-Profil anwenden.
- Skins lassen sich per Drag & Drop auf die Bibliothek ziehen.
- Das Modell (Klassisch oder Slim) lässt sich pro lokalem Skin umschalten.
- Die Bamboo-Cosmetics-Mod wird vor jedem Start automatisch in die Instanz gelegt, auf Wunsch in der neuesten Version direkt aus dem Release.
- Der Kosmetik-Shop zeigt Vorschaubilder direkt im Tab.

### Besser

- Lokale Skins laden nach einem Neustart zuverlässig.
- Einstellungen aus dem Launcher landen auch nach dem ersten Spielstart wieder in `options.txt`.
- Die Oberfläche wird mit `strict: true` typgeprüft.

### Behoben

- Grafik- und Steuerungseinstellungen wurden nach dem ersten Minecraft-Start stillschweigend ignoriert.
- Eine Release-Jar für eine andere Minecraft-Version konnte in einer 26.3-Instanz landen.
- Das Löschen einer Instanz prüft den Ordnernamen und meldet einen Fehler, statt Erfolg anzuzeigen, wenn der Ordner bleibt.
- Jeder Handler, der eine Instanz öffnet, löscht oder beschreibt, prüft den Ordnernamen: `..` und absolute Pfade kommen nicht mehr in ein anderes Verzeichnis.
- Der Mod-Download schreibt keine Datei mehr unter einem Namen, den eine API-Antwort liefert.
- Ein Modpack-Export als `.mrpack` läuft ausschließlich über den Core.
- Die Instanzliste wird atomar gespeichert. Eine unlesbare `profiles.json` wird als Kopie gesichert statt beim nächsten Speichern durch eine leere Liste ersetzt.
- Die Instanzgrößen werden im Hintergrund ermittelt, statt beim Speichern jede Datei jeder Instanz zu zählen.
- Nach einem fehlgeschlagenen Start zeigt Discord wieder den Launcher statt dauerhaft „Starting…“.
- Eine laufende Instanz lässt sich nicht mehr löschen; der Fehler erscheint als Hinweis, statt die Instanz halb zu entfernen.
- Wird eine laufende Instanz umbenannt, ziehen Start-Registry und Core-Register mit.
- Die Pfadprüfung beim Hashen von Inhaltsdateien vergleicht mit Pfadtrenner, nicht mit einer rohen Zeichenkette.

### New

- New “Customize” tab with a skin library: upload, select, rename and delete skins, choose classic or slim, and apply them directly to the Minecraft profile.
- Skins can be dragged and dropped onto the library.
- The model (classic or slim) can be switched per local skin.
- The Bamboo Cosmetics mod is placed into the instance before every start, in the newest release build when one is available.
- The cosmetics shop shows preview images right in the tab.

### Better

- Local skins now reload reliably after a restart.
- Launcher settings reach `options.txt` again after the first game start.
- The UI is type-checked with `strict: true`.

### Fixed

- Graphics and control settings were silently ignored after the first Minecraft start.
- A release jar for a different Minecraft version could land in a 26.3 instance.
- Deleting an instance validates the folder name and reports a failure instead of "deleted" when the folder stays.
- Every handler that opens, deletes or writes an instance validates the folder name: `..` and absolute paths can no longer escape it.
- The mod download writes no file under a name taken from an API response.
- Exporting a modpack as `.mrpack` runs through the core only.
- The instance list is written atomically. An unreadable `profiles.json` is kept as a copy instead of being replaced by an empty list on the next save.
- Instance sizes are measured in the background instead of counting every file on every save.
- After a failed launch Discord shows the launcher again instead of staying on "Starting…".
- A running instance can no longer be deleted; the error is shown instead of removing it halfway.
- Renaming a running instance moves the launch registry and the core register along.
- Content-file hashing checks the path with a separator instead of a raw prefix.

## 0.2.2 - 2026-10-31

### Neu

- Neun Themes zur Auswahl: Bamboo Forest, End City, Snowy Lands, Nether Fortress, Obsidian Portal, Warden Valley, Copper Trials, Underwater Paradise und Cherry Blossom — dazu ein Custom-Modus mit eigener Farbe, eigenem Bild und Effekt-Reglern.
- Statistiken über alle Instanzen: Spielzeit, abgebaute und gesetzte Blöcke, Strecken, Mobs und Tode. Die Spielzeit bleibt erhalten, auch wenn du eine Instanz löschst.
- Mod-Details mit Beschreibung, Metadaten, Versionswechsel und „Im Browser öffnen" direkt neben den anderen Aktionen.
- Die Versionsliste im Mod-Browser zeigt Installationsfortschritt und „installiert" — eine andere Version ersetzt die alte, statt sie zu verdoppeln.

### Besser

- Einstellungen neu sortiert: Launcher, In-Game und System als Untertitel, Java & Speicher, Spieloptionen und Key-Binds als eigene Tabs. Vollbild und Mausempfindlichkeit wirken jetzt wirklich beim Start.
- Instanz-Kopfzeile aufgeräumt: Updates sind der auffälligste Knopf und nennen die Mods mit Update, Hochladen ist ein Icon, Neu laden ein leiser Knopf.
- Mods, Inhalte und Instanzen sind nach Namen sortiert.
- Import ohne Java-Meldung — Java wird beim Start geprüft — und das Import-Fenster lässt sich schließen, während es weiterläuft.
- Eigene Mods aktivieren zeigt vorher eine Warnung, entsperrt danach alles und verschwindet dauerhaft.
- Der Mod-Browser merkt sich Seite und Position, wenn du eine Instanz öffnest.

### Behoben

- Die Großansicht eines Screenshots wird oben nicht mehr abgeschnitten.
- Der Server-Status aktualisiert nur noch auf Knopfdruck, ist schneller und zeigt keinen Ping mehr.

### Entfernt

- Das Mehrspieler-Sharing samt Einladungen und Join-Links.
- Der Punkt am Skin im Kontomenü.

### New

- Nine themes to pick from: Bamboo Forest, End City, Snowy Lands, Nether Fortress, Obsidian Portal, Warden Valley, Copper Trials, Underwater Paradise and Cherry Blossom — plus a Custom mode with your own colour, image and effect sliders.
- Statistics across every instance: playtime, blocks broken and placed, distances, mobs and deaths. Playtime survives deleting an instance.
- Mod details with description, metadata, version switching and "open in browser" next to the other actions.
- The version list in the mod browser shows install progress and "installed" — picking another version replaces it instead of adding a second copy.

### Better

- Settings regrouped: Launcher, In-Game and System as subtitles, with Java & Memory, Game Options and Key-Binds as their own tabs. Fullscreen and mouse sensitivity now actually apply on launch.
- Instance header cleaned up: updates are the prominent action and name the mods with updates, upload is an icon, reload is a quiet button.
- Mods, content and instances sort by name.
- Import no longer mentions Java — it is checked on launch — and the import window can be closed while it keeps running.
- Enabling custom mods warns first, then unlocks everything and hides the notice for good.
- The mod browser remembers its page and position when you open an instance.

### Fixed

- The screenshot lightbox header is no longer clipped at the top.
- Server status refreshes on demand only, faster, and no longer shows ping.

### Removed

- The multiplayer sharing feature, including invites and join links.
- The skin status dot in the account menu.
