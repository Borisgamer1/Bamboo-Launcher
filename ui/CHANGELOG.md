# Changelog

What changed for people using the launcher. `src/lib/changelog.ts` reads this
file at build time and shows the section for the running version, once per
version, so every release needs a block here in **both** languages.

Group headings are fixed: `Neu` / `Besser` / `Behoben` / `Entfernt` for German,
`New` / `Better` / `Fixed` / `Removed` for English.

## 0.2.5 - 2026-11-10

### Neu

- Der große Schnitt: Der Launcher läuft komplett auf Rust und Tauri. Die Electron-Shell ist entfernt, es gibt keinen Node- oder Chromium-Unterbau mehr; Start, Anmeldung, Instanzen, Mods, Modpacks, Downloads, Cosmetics und Einstellungen laufen im Rust-Kern, die Oberfläche spricht über Tauri-Commands mit ihm.
- Für Windows, macOS und Linux gibt es wieder Installationspakete: MSI und NSIS unter Windows, DMG unter macOS, DEB, RPM und AppImage unter Linux, jeweils mit eigenem Icon.
- CurseForge lässt sich im Rust-Build vollständig nutzen: suchen, Projektseite lesen, Version wählen und installieren; ein in der Oberfläche hinterlegter API-Key wird übernommen.
- Modpack-Installation fragt vor dem Download nach der Minecraft-Version, wenn das Pack mehrere anbietet; bei nur einer Version wird automatisch die neueste passende genommen.
- Der Kosmetik-Shop bringt seinen Katalog mit und bleibt auch dann gefüllt, wenn GitHub nicht erreichbar ist.
- Cosmetics-Pakete kommen jetzt in jeder Instanz an: Beim Installieren legt der Launcher sie in `bamboo/cosmetics` der Instanz ab, beim Löschen nimmt er sie dort wieder zurück.
- In *Anpassen → Cosmetics* lässt sich unter „Automatisch in Instanzen“ pro Instanz abschalten, dass sie die Pakete bekommt. Ausgeschlossene Instanzen bekommen nichts Neues und verlieren ihre Kopien; selbst gebaute Pakete bleiben liegen.
- Die Spieloptionen erreichen jetzt wirklich das Spiel: Sichtweite, Sichtfeld, GUI-Skalierung, Lautstärken, Chat, Barrierefreiheit und die Tastaturbelegung schreibt der Launcher bei jedem Start in die `options.txt` der Instanz.
- Profile lassen sich wieder exportieren und importieren: als Bamboo-`.zip` oder als `.mrpack`, mit Vorschau vor dem Import und wählbaren Inhaltsarten.
- Fertige Instanzen aus Prism/MultiMC, der CurseForge App und der Modrinth App lassen sich übernehmen: Der Launcher erkennt Quelle, Minecraft-Version und Loader am Ordner, kopiert nur die gewählten Inhalte und installiert den Loader selbst. Auf Wunsch landet das Paket in einer bestehenden Instanz; vorhandene Dateien und Welten werden dabei nicht überschrieben.
- CurseForge-Modpacks (ZIP mit `manifest.json`) lassen sich importieren: Der Launcher erkennt den Loader aus dem Manifest, lädt jede Mod über ihre Projekt- und Datei-ID und trägt sie als CurseForge-Inhalt in die Bestandsdatei ein.
- Quilt ist ein vollwertiger Loader: Der Launcher installiert ihn aus Quilt Meta, legt das Startprofil an, aktualisiert ihn und importiert Modpacks, die Quilt verlangen.
- Importierte Packs lassen sich aktualisieren: In den Instanz-Einstellungen unter *Erweitert → Wartung* wählst du die neue Pack-Datei. Der Launcher gleicht Projekt- und Datei-IDs ab, lädt nur geänderte Mods, entfernt, was das Pack nicht mehr führt, und lässt eigene Mods stehen.
- Klonen, Reparieren und Desktop-Verknüpfung funktionieren wieder; die Verknüpfung startet die Instanz direkt.
- Neue Ansichten mit echten Daten: Welten einer Instanz, Screenshots zum Löschen und Öffnen, Statistik aus den Spielständen und ein Server-Ping im Mehrspieler-Tab.
- Der Skin-Editor speichert lokal und lädt zu Mojang hoch; Capes lassen sich aus dem eigenen Profil wählen.
- Die Crash-Analyse erkennt Speichermangel, altes Java, fehlende Abhängigkeiten, doppelte Mods, Mixin-Fehler und beschädigte JARs und bietet passende Reparaturen an, inklusive Zurücknehmen.
- Vor jedem Start prüft der Launcher die Mods der Instanz: doppelte Mods, fehlende Abhängigkeiten sowie Mods für einen anderen Loader oder eine andere Minecraft-Version erscheinen in einem Dialog. Einzelne Dateien lassen sich direkt deaktivieren, und starten geht weiterhin bewusst.
- Updates laufen jetzt im Launcher: „Nach Updates suchen“ holt die neue Version im Hintergrund und prüft ihre Signatur, „Neu starten“ spielt sie ein und startet den Launcher neu. Ein Installationspaket muss dafür nicht mehr heruntergeladen werden.
- Vor jedem Modpack-Update, jedem Versionswechsel und jedem Import sichert der Launcher Welt und Konfiguration der Instanz; die letzten Sicherungen bleiben liegen, ältere werden automatisch entfernt.
- Unter *Instanz-Einstellungen → Erweitert → Sicherungen* siehst du die angelegten Sicherungen, kannst eine von Hand erstellen, eine einspielen oder löschen. Beim Einspielen bleiben Dateien erhalten, die die Sicherung nicht kennt.
- Ohne Microsoft-Konto und ohne eigene Skin zeigt die Cosmetics-Vorschau eine mitgelieferte Standardskin, damit Pakete auch vor der Anmeldung beurteilbar sind.

### Besser

- Mehrere Microsoft-Konten: weitere Konten verbinden, zwischen ihnen wechseln und einzelne wieder entfernen; eine laufende Anmeldung lässt sich abbrechen.
- Modpack-Installation lädt fehlende Dateien in einem zweiten Durchlauf nach, statt das ganze Pack zu verwerfen.
- Der Import prüft nach dem Entpacken jede Override-Datei und schreibt fehlende nach; FancyMenu-, Drippy- und ähnliche Konfigurationen bleiben dadurch nicht mehr sporadisch aus.
- Mods, Ressourcenpakete, Shader und Welten aus den Overrides stehen nach dem Import in der Inhaltsliste der Instanz.
- Die Fußleiste räumt fertige Installationen, Importe und Reparaturen nach ein paar Sekunden von selbst weg; Fehler bleiben stehen, bis du sie schließt.
- Die Seite, die der Browser nach der Anmeldung zeigt, trägt jetzt das Bamboo-Gesicht: Logo, kurze Meldung und ein Akzent statt der generischen Erfolgskarte.
- Mehrere Instanzen gleichzeitig: Der Start überschreibt die Natives einer bereits laufenden Minecraft-Version nicht mehr, und eine schon laufende Instanz lässt sich nicht versehentlich doppelt starten.
- Die eingestellte Spielsprache kommt jetzt wirklich im Spiel an: Der Launcher schreibt sie bei jedem Start in die `options.txt` der Instanz, auch bei Modpacks mit YOSBR.
- Der Launcher merkt sich Fenstergröße, Position und Maximiert-Zustand; nach einem Neustart öffnet er wieder genau so.
- Mehrere laufende Instanzen teilen sich unten einen Platz: Sie wechseln sich alle paar Sekunden mit einer kurzen Bewegung ab, kleine Punkte zeigen, wie viele laufen, und beim Darüberfahren hält der Wechsel an.
- Der Vollbildstart greift jetzt zuverlässig: Der Launcher schreibt den Schalter bei jedem Start in die `options.txt`, statt sich auf den Wert zu verlassen, den das Spiel zuletzt gespeichert hat.
- „Inhalte hinzufügen“ in einem Inhalts-Tab einer Instanz öffnet den Browser wieder in genau diesem Bereich, auch wenn dort vorher schon gestöbert wurde; die Auswahl bleibt nicht mehr beim zuletzt besuchten Inhaltstyp hängen. Auch ein zweiter Klick auf denselben Bereich baut den Browser neu auf, statt auf dem alten Tab stehen zu bleiben.
- Die Update-Prüfung fragt in zwei Sammelanfragen nach dem Stand aller Dateien einer Instanz, statt für jede Mod eine eigene Versionsliste zu holen.
- Die Fenstergröße wird schon während des Spielens gemerkt, nicht erst beim sauberen Schließen; ein abgebrochener Dev-Start verliert sie nicht mehr. Minimiert speichert der Launcher keine 0×0-Größe.
- Alte Instanzen im `profiles`-Ordner des Spielverzeichnisses erscheinen jetzt auch dann in der Liste, wenn die Wurzeldatei der Vorgänger-App fehlt oder auf einen anderen Ordner zeigt.
- Die Prüfung vor dem Start meldet keine falschen Lücken mehr: Bibliotheken, die der Loader selbst mitbringt, und Bibliotheken, die eine Mod als Jar-in-Jar mitliefert, gelten jetzt als vorhanden.

### Behoben

- „Reparieren“ meldete Erfolg, ohne etwas zu tun: Der Befehl fehlte im Kern. Jetzt wird der Loader neu installiert und die Bibliotheken werden geprüft; ein Fehlschlag wird als Fehlschlag gemeldet.
- Eine fehlgeschlagene Loader-Installation legte still eine Vanilla-Instanz an. Jetzt bricht das Anlegen mit einer Meldung ab.
- Im Dev-Build blieb die Oberfläche auf dem Dashboard stehen: Ein Klick auf einen Tab wechselte die Markierung, aber nicht die Ansicht. Der Wechsel funktioniert wieder.
- Die Microsoft-Anmeldung in den Einstellungen meldet Fehler jetzt, statt still zu scheitern; ein weiteres Konto verdrängt die vorhandenen nicht mehr.
- Die Anmeldung öffnet den Browser wieder: Windows meldete beim Anmeldeversuch „Die Datei "\" wurde nicht gefunden“, weil `cmd` die Adresse mit maskierten Anführungszeichen bekam und die Anmeldung danach ins Leere wartete.
- Die CurseForge-Suche meldete fälschlich, CurseForge sei nicht verfügbar, obwohl der Kern lief.
- Der Rust-Kern legt seine Einstellungen in `core.json` ab und überschreibt `settings.json` nicht mehr, sodass Theme, Sprache und CurseForge-Key der Oberfläche erhalten bleiben.
- Instanzen aus der Zeit vor dem Rust-Umbau fehlten in der Liste: Der Kern durchsucht jetzt auch den Spielordner der Vorgänger-App und startet diese Profile mit ihren eigenen Versionen, Libraries und ihrem Mod-Ordner.
- Der Kosmetik-Shop war ohne GitHub-Verbindung leer.
- Bilder ließen sich nicht hochladen: Der Rust-Kern kannte den Befehl zum Einlesen der Bilddatei nicht. Instanzbilder und Screenshots erscheinen jetzt wieder.
- Der Launcher erkennt die Inhalte einer Instanz jetzt selbst: Mods, Ressourcenpakete und Shader werden über ihren Modrinth-Hash oder CurseForge-Fingerprint zugeordnet und zeigen Name, Version, Quelle und Cover. „Lokal“ steht nur noch bei Dateien, die wirklich unbekannt sind.
- Forge geht jetzt auch: Eine Instanz mit Forge oder ein importiertes Pack, das Forge verlangt, installiert den Loader über den offiziellen Installer in ein Profil wie `1.20.1-forge-47.4.0`.
- Ein Rechtsklick öffnet nicht mehr das Seitenmenü der WebView mit Aktualisieren, Drucken und Untersuchen; Textfelder behalten ihres.
- Server-Pings gehen wieder: Die Brücke zum Rust-Core hat die Serveradresse unterschlagen, deshalb kam jede Abfrage ohne Adresse an.
- Die Cosmetics-Vorschau blieb weiß, wenn weder ein Konto noch eine lokale Skin-Datei vorhanden war; jetzt greift die mitgelieferte Skin, und auch eine fehlgeschlagene Skin-Textur fällt darauf zurück.
- Mojang liefert Skin-Adressen über `http`; der Launcher lädt sie jetzt über `https`, damit die WebView die Textur nicht blockiert.

### New

- The big cut: the launcher runs entirely on Rust and Tauri. The Electron shell is gone, there is no Node or Chromium underneath any more; launching, sign-in, instances, mods, modpacks, downloads, cosmetics and settings run in the Rust core, and the interface talks to it through Tauri commands.
- Installers are back for Windows, macOS and Linux: MSI and NSIS on Windows, DMG on macOS, DEB, RPM and AppImage on Linux, each with its own icon.
- CurseForge is fully usable in the Rust build: search, read the project page, pick a version and install; an API key stored in the UI is picked up.
- Modpack installs ask for the Minecraft version before downloading when the pack offers several; a single-version pack automatically takes the newest matching one.
- The cosmetics shop carries its catalog with it, so it stays populated even when GitHub is unreachable.
- Cosmetic packages now reach every instance: installing places them in the instance's `bamboo/cosmetics`, deleting takes them back out.
- Under *Customize → Cosmetics*, "Automatic in instances" lets you switch off per instance whether it receives the packages. Excluded instances get nothing new and lose their copies; packages you built yourself stay put.
- The game options now actually reach the game: render distance, field of view, GUI scale, volumes, chat, accessibility and the key binds are written to the instance's `options.txt` on every start.
- Profiles can be exported and imported again: as a Bamboo `.zip` or a `.mrpack`, with a preview before the import and selectable content types.
- Finished instances from Prism/MultiMC, the CurseForge App and the Modrinth App can be taken over: the launcher reads the source, Minecraft version and loader from the folder, copies only the selected content and installs the loader itself. If you want, the pack can go into an existing instance; existing files and worlds are never overwritten.
- CurseForge modpacks (a ZIP with `manifest.json`) import too: the launcher reads the loader from the manifest, downloads every mod through its project and file ID and records it as CurseForge content in the ledger.
- Quilt is a first-class loader: the launcher installs it from Quilt Meta, writes its launch profile, updates it, and imports modpacks that require Quilt.
- Imported packs can be updated: in the instance settings under *Advanced → Maintenance* you pick the new pack file. The launcher matches project and file IDs, downloads only changed mods, removes what the pack no longer ships and leaves your own mods alone.
- Clone, repair and desktop shortcut work again; the shortcut starts the instance directly.
- New views with real data: an instance's worlds, screenshots to delete and open, statistics read from the save files, and a server ping in the multiplayer tab.
- The skin editor stores locally and uploads to Mojang; capes can be picked from the account's own profile.
- The crash analysis recognises low memory, old Java, missing dependencies, duplicate mods, mixin failures and corrupt JARs, and offers matching fixes including undo.
- Every start checks the instance's mods first: duplicate mods, missing dependencies and mods built for another loader or Minecraft version show up in a dialog. Single files can be disabled right there, and starting anyway stays a deliberate choice.
- Updates now happen inside the launcher: "Check for updates" fetches and verifies the new version in the background, "Restart now" applies it and starts the launcher again. No installer download needed.
- Before every modpack update, version switch and import the launcher backs up the instance's worlds and config; the newest backups are kept and older ones pruned automatically.
- Under *Instance settings → Advanced → Backups* you see the backups, can create one by hand, restore one or delete it. A restore keeps files the backup does not know about.
- Without a Microsoft account and without a local skin, the cosmetics preview shows a bundled default skin, so packages can be judged before signing in.

### Better

- Multiple Microsoft accounts: connect more accounts, switch between them and remove single ones again; a pending sign-in can be cancelled.
- Modpack installs retry missing files in a second pass instead of discarding the whole pack.
- The import checks every override file after extracting and rewrites the missing ones, so FancyMenu, Drippy and similar configurations no longer drop out now and then.
- Mods, resource packs, shaders and worlds from the overrides appear in the instance's content list after the import.
- The footer clears finished installs, imports and repairs by itself after a few seconds; errors stay until you close them.
- The page the browser shows after signing in now wears Bamboo's face: logo, a short message and one accent instead of the generic success card.
- Several instances at once: launching no longer overwrites the natives of a Minecraft version that is already running, and an already running instance cannot be started twice by accident.
- The chosen in-game language now actually reaches the game: the launcher writes it to the instance's `options.txt` on every start, including modpacks that use YOSBR.
- The launcher remembers its window size, position and maximized state, so a restart brings it back the same way.
- Several running instances share one slot in the footer: they take turns every few seconds with a short motion, small dots show how many are running, and hovering pauses the rotation.
- Fullscreen launch is now reliable: the launcher writes the flag to `options.txt` on every start instead of trusting whatever the game saved last.
- "Add content" in one of an instance's content tabs opens the browser on exactly that section again, even after an earlier visit; the selection no longer stays on the content type browsed last. Opening the same section twice rebuilds the browser instead of leaving it on the old tab.
- The update check asks for the state of every file in two batched requests instead of fetching a version list per mod.
- The window size is remembered while the game runs, not only on a clean close, so an aborted dev start no longer loses it. A minimized window never stores a 0×0 size.
- Instances in the game folder's `profiles` folder now show up even when the previous app's root file is missing or points somewhere else.
- The check before launch no longer reports false gaps: libraries the loader itself provides, and libraries a mod bundles as jar-in-jar, now count as present.

### Fixed

- "Repair" reported success without doing anything: the command was missing in the core. It now reinstalls the loader and checks the libraries, and a failure is reported as one.
- A failed loader install silently created a vanilla instance. Creating now stops with a message instead.
- In the dev build the UI stayed on the dashboard: clicking a tab changed the marker but not the view. Switching works again.
- Microsoft sign-in in Settings now reports failures instead of failing silently; an additional account no longer replaces the existing ones.
- Sign-in opens the browser again: Windows reported a missing file on every sign-in attempt because `cmd` received the URL with escaped quotes, leaving the sign-in waiting for nothing.
- CurseForge search wrongly reported CurseForge as unavailable even though the core was running.
- Instances from before the Rust port were missing from the list: the core now also scans the previous app's game folder and launches those profiles with their own versions, libraries and mod folder.
- The Rust core keeps its settings in `core.json` and no longer overwrites `settings.json`, so the UI's theme, language and CurseForge key survive.
- The cosmetics shop was empty without a GitHub connection.
- Images could not be uploaded: the Rust core did not know the command that reads the image file. Instance images and screenshots show up again.
- The launcher now identifies an instance's content itself: mods, resource packs and shaders are matched to Modrinth or CurseForge by hash or fingerprint and show name, version, source and cover. Files no store knows still get their name and version from the jar, so "Local" only appears where a file has neither.
- Imported packs list their content immediately: the core reads the folders and the jar metadata instead of returning an empty list.
- Forge joins Fabric and NeoForge: an instance created with Forge, or a pack that requires it, installs the loader through the official installer into a profile like `1.20.1-forge-47.4.0`.
- A right click no longer opens the WebView page menu with reload, print and inspect; text fields keep theirs.
- Server pings work again: the bridge to the Rust core dropped the server address, so every request arrived without one.
- The cosmetics preview stayed white when neither an account nor a local skin file existed; the bundled skin now takes over, and a failed skin texture falls back to it too.
- Mojang hands out skin URLs over `http`; the launcher now loads them over `https`, so the WebView no longer blocks the texture.

## 0.2.4 - 2026-11-07

### Neu

- Mehrere Microsoft-Konten: weitere Konten verbinden, zwischen ihnen wechseln und einzelne wieder entfernen.
- Eigener Statistik-Tab in den Instanz-Einstellungen mit Spielzeit, Sitzungen, Größe und Inhalten.
- Instanzbild lässt sich direkt über das Bild im Kopf der Einstellungen ändern, inklusive der Launcher-Vorlagen.

### Besser

- Kosmetik-Shop: alle Pakete haben ein einheitliches 3D-Vorschaubild.
- Cosmetics-Hinweis steht als eigener Block neben der Vorschau statt als Mini-Text am Rand; die Tour erklärt ihn.
- Spieloptionen: Die Tabs laufen nicht mehr in eine Scrollleiste, sondern brechen sauber um.
- Das Unendlich-Zeichen bei der Bildrate ist deutlich größer.
- Mod-Detailansicht innerhalb einer Instanz ist breiter, damit Beschreibung und Versionen lesbar sind.
- Tastaturbelegung nutzt die Labels des eingestellten Windows-Layouts, statt immer US-Layout.
- Skin-Vorschau zeigt Kopf-Cosmetics von vorne und Cape-/Rücken-Cosmetics von hinten.
- Mod-Updates einer Instanz laufen als Hintergrund-Aufgabe weiter, auch wenn man die Instanz verlässt.
- Instanz-Einstellungen aufgeräumt: keine doppelten Einträge für Name, Ordner, Inhalt, Reparieren und Exportieren.
- Toasts sind kürzer, zeigen bei Hover den vollen Text und bleiben stehen, solange der Zeiger darauf ist.
- Instanzerstellung blendet Modloader aus, für die es keine Version der gewählten Minecraft-Version gibt.

### Behoben

- Unter Cosmetics wird das Vanilla-Cape ausgeblendet, sobald ein Cape- oder Rücken-Cosmetic aktiv ist.
- Skin-Rendering zeigt Arm-Overlays und die Unterseite der Hände.
- Serverstatus großer Netzwerke wie Hypixel meldet nicht mehr fälschlich offline.
- Shader-Liste zeigt keine `.txt`-Konfigurationsdateien mehr.
- Versionswechsel lädt die gewählte Version wirklich herunter; der Fortschritt erscheint nur noch in der Zeile der laufenden Version.
- „MC Lokal“ steht nur noch an Dateien, die weder Modrinth noch CurseForge kennt.

### New

- Multiple Microsoft accounts: connect more accounts, switch between them and remove single ones again.
- A dedicated statistics tab in the instance settings with playtime, sessions, size and content.
- The instance image can be changed by clicking the image in the settings header, including the launcher's own presets.

### Better

- Cosmetics shop: every pack has a matching 3D preview image.
- The cosmetics note is a proper block next to the preview instead of a tiny edge label; the tour explains it.
- Game options: the tabs wrap instead of squeezing into a scrollbar.
- The infinity sign for the framerate limit is much larger.
- The mod detail view inside an instance is wider, so description and versions stay readable.
- Keybinds use the labels of the configured Windows layout instead of always showing a US layout.
- The skin preview shows head cosmetics from the front and cape or back cosmetics from behind.
- Mod updates of an instance keep running in the background after leaving the instance.
- Instance settings cleaned up: no duplicate entries for name, folder, content, repair and export.
- Toasts are narrower, expand to the full text on hover and stay while the pointer is on them.
- Instance creation hides modloaders that have no version for the selected Minecraft version.

### Fixed

- The vanilla cape is hidden under Cosmetics as soon as a cape or back cosmetic is active.
- Skin rendering shows arm overlays and the underside of the hands.
- Server status for large networks such as Hypixel no longer reports them offline.
- The shader list no longer shows `.txt` config files.
- Version switching actually downloads the chosen version; progress only appears in the row of the running version.
- "MC Lokal" only appears on files neither Modrinth nor CurseForge knows.

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
- Fenster, Dialoge, Screenshots, Einstellungen, die Instanzordner-Regeln, Versionswechsel/Reparatur, Modpack-Installation sowie Profil-Export/Import liegen in eigenen Main-Prozess-Modulen statt in `main.js`.
- Fortschritt langer Aufgaben läuft über einen gemeinsamen Sender; nicht erreichbare Alt-Kanäle und der unbenutzte Zip-Modpack-Schreiber sind entfernt.
- Darstellung, Mod-Ergebniszeile und Weltliste der Instanz sind eigene Bausteine; der Instanz-Größen-Cache liegt in einem eigenen Modul.

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
- Anlegen, Klonen und Löschen einer Instanz aktualisieren sofort das Core-Register, damit Update-Prüfung und Kosmetik-Spiegel ohne Neustart stimmen.
- Jedes Speichern der Instanzliste gleicht Name, Version und Loader mit dem Core-Register ab. Eine Änderung kann dort nicht mehr veralten.
- Fehlermeldungen kommen über stabile Codes in die englische Oberfläche statt als deutscher Rohtext.
- Fehler beim Import, Export, bei der Modpack-Installation und beim lokalen Hochladen erscheinen auf Englisch, statt den deutschen Satz des Main-Prozesses zu zeigen.
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
- Window chrome, dialogs, screenshots, settings, the instance-folder rules and version switch/repair live in their own main-process modules instead of `main.js`.

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
- Creating, cloning and deleting an instance updates the core register immediately, so update checks and the cosmetics mirror are correct without a restart.
- Every save of the instance list copies name, version and loader into the core register, so an edit there can no longer go stale.
- Errors reach the English UI through stable codes instead of raw German text.
- Import, export, modpack install and local upload failures are shown in English instead of the main process's German sentence.
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
