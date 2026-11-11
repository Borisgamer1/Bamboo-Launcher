# Bamboo Roadmap

Wunschliste und Arbeitsstand. Keine Termine, keine Versprechen, sondern das, was irgendwann in Bamboo landen soll. Stand: 11. November 2026, nach 0.2.6.

**Legende**

- `[ ]` offen · `[~]` in Arbeit · `[x]` fertig
- Aufwand: **S** = 1–3 Tage, **M** = 1–2 Wochen, **L** = 3–6 Wochen, **XL** = 2+ Monate oder Backend/Mod nötig
- „Gesetzt“ heißt: als Nächstes gewollt. „Pool“ heißt: irgendwann, wenn es passt. „Nein“ heißt: bewusst nicht.

---

## 1. Leitidee: Launcher und Client in einem Programm

**Vision.** Ein Fenster, zwei Modi. Draußen verwaltest du Instanzen, Mods und Server. Drinnen bist du im Spiel und hast dieselben Freunde, dieselbe Bibliothek, dieselben Einstellungen. Kein zweiter Launcher, kein zweites Konto, kein Rätselraten, welche Client-Version gerade läuft.

### Was „switchen“ heißen kann

Nicht alles davon gleichzeitig bauen. Die Ebenen bauen aufeinander auf.

| Ebene | Bedeutung | Aufwand |
| --- | --- | --- |
| **L1 Client-Schalter pro Instanz** | Vanilla / Bamboo Client / Performance. Der Launcher installiert und aktualisiert die nötige Mod, gestartet wird wie immer. | L |
| **L2 Overlay im Spiel** | Hotkey öffnet Freunde, Server, Instanzinfos und Screenshots. Der Launcher läuft im Tray weiter. | L |
| **L3 Client-Modus im Launcher** | Eigener Vollbildbereich mit Bibliothek, Freunden, Serverliste, Cosmetics und Voice. Umschalten per Tab oder Hotkey. | XL |
| **L4 Instanzwechsel ohne Launcher-Neustart** | Aus dem Spiel zurück, andere Instanz starten, Fenster bleibt offen. | M, größtenteils vorhanden |
| **L5 Client als eigenes Produkt** | Eigener Download, eigene Updates, eigene Server, Anti-Cheat. | XL+ |

### Empfohlener Weg

**L1 + L2 + L4 zuerst.** Als Fabric-Mod plus Begleitprozess. Der Launcher bleibt die einzige Installation, der Client ist eine Mod, die über einen lokalen Kanal mit dem Launcher spricht (Named Pipe oder WebSocket auf `127.0.0.1`). Keine Bytecode-Injection, kein Eingriff in fremde Prozesse, kein Anti-Cheat-Umgehen. Damit bleiben Serverregeln, Updates und Support beherrschbar.

**Warum keine Injection wie Lunar oder Badlion.** Jede Minecraft-Version bricht den Patch, Anti-Cheat liest es als Manipulation, und der Wartungsaufwand wächst mit jedem Snapshot. Eine Mod startet später, ist aber ehrlich und langlebig.

### MVP für den Client

1. Mod pro Instanz installieren und deinstallieren, ohne Modpack-Inhalte anzufassen.
2. Overlay mit Instanzname, Spielzeit, Freunden (Presence), „Server beitreten“ und Screenshot teilen.
3. Launcher im Tray, Rückkehr per Hotkey.
4. Cosmetics-Sync bleibt wie er ist. Im Spiel sichtbar nur für andere Bamboo-Nutzer.

### Später

Voice, P2P-Welten, Hosted Worlds, HUD-Module. Jedes davon braucht Backend oder Server und wird einzeln entschieden.

### Risiken

- Forge- und NeoForge-Packs brauchen eine zweite Mod-Variante oder einen Loader-unabhängigen Weg.
- Cosmetics im Spiel bedeuten Rendering-Code pro Minecraft-Version. Das ist der teuerste Teil.
- Ein Overlay im Vollbild kann mit Grafiktreibern und Linux-Compositors kollidieren.
- Freundesliste und Presence brauchen einen Dienst, also Konten, Datenschutz und Moderation.

### Offene Fragen

- [ ] Soll der Client auch ohne Bamboo-Account nutzbar sein?
- [ ] Nur Fabric und NeoForge, oder auch Forge?
- [ ] Voice mit eigenem Protokoll oder kompatibel zu Simple Voice Chat?
- [ ] Dürfen Freunde ohne Launcher über eine Web-Einladung joinen?
- [ ] Bleibt der Client kostenlos und Teil des Launchers?

---

## 2. Gesetzt: die nächsten sechs Baustellen

### R01 Quick Play und „Weiterspielen“

Status: **weitgehend vorhanden** · Rest **S** · Vorbild: offizieller Launcher, Modrinth App

**Ist-Stand.** Startseite und Startpfad sind verdrahtet. Das Dashboard zeigt die letzte Welt als Hero, darunter Welten, Server und Profile. „Weiter spielen“ startet die Welt ab 1.20 per Quick Play, ältere Versionen starten das Profil. Server-Join nutzt `--quickPlayMultiplayer`; Welt und Server gleichzeitig sind ausgeschlossen. Pins für Welten und Server liegen lokal neben dem Launcher.

**Umfang**

- [x] Dashboard-Leiste „Weiterspielen“ mit letzten Welten und Servern (3 Welten, 4 Server sichtbar)
- [x] Welt-Karte mit Name, Instanz, letzter Spielzeit und „Spielen“
- [x] Server-Karte mit Ping, Spielerzahl und „Beitreten“
- [x] Favoriten anpinnen
- [ ] Kontextmenü pro Instanz: „Direkt in Welt …“ und „Direkt auf Server …“
- [ ] Fallback für Versionen unter 1.20 direkt in die Welt (Kern kann `--server`/`--port` bereits)
- [x] Einträge ausblenden, wenn Welt, Server oder Instanz gelöscht wurde

**Akzeptanz.** Klick auf eine Welt startet das Spiel und landet in der Welt. Klick auf einen Server landet direkt auf dem Server. Beides funktioniert mit mehreren Konten und mit einer Instanz, die nicht die zuletzt gestartete ist. Unter 1.20 startet die Welt-Karte das Profil, nicht die Welt; das ist der bewusste Fallback.

### R02 Instanzen wirklich ordnen

Status: offen · Aufwand **M** · Vorbild: Prism, GDLauncher, SKLauncher

**Ist-Stand.** Flache Liste mit Suche und Sortierung nach zuletzt gespielt. Keine Gruppen, keine Favoriten, keine Notizen, keine Mehrfachauswahl.

**Umfang**

- [ ] Gruppen und Tags anlegen, umbenennen, löschen, einfärben
- [ ] Drag & Drop zwischen Gruppen, „Ohne Gruppe“ als Standard
- [ ] Favoriten und Pins oben
- [ ] Notiz pro Instanz
- [ ] Mehrfachauswahl mit Sammelaktionen: aktualisieren, exportieren, verschieben, löschen
- [ ] Filter nach Loader, Minecraft-Version, Gruppe und „hat Update“
- [ ] Sortierung nach Name, zuletzt gespielt, Größe und Anlagedatum
- [ ] Instanz-Sperre gegen versehentliche Änderungen an kuratierten Packs
- [ ] Vorlagen: Vanilla, Performance, Modpack-Dev

**Akzeptanz.** Eine Gruppe überlebt den Neustart. Verschieben per Drag & Drop aktualisiert die Liste sofort. Sammel-Löschen fragt einmal und nennt die Anzahl. Suche und Filter wirken zusammen.

### R03 Speicher-Dashboard und Dedupe

Status: offen · Aufwand **M–L** · Vorbild: Modrinth, XMCL, Prism

**Ist-Stand.** Pro Instanz wird eine Größe angezeigt, sonst nichts.

**Umfang**

- [ ] Gesamtübersicht: Instanzen, Assets, Libraries, Java-Runtimes, Cache, Logs, Backups
- [ ] Pro Instanz: Mods, Ressourcenpakete, Shader, Welten, Screenshots, Logs
- [ ] Größte Dateien, doppelte JARs (Hash + Größe), unbenutzte Dateien
- [ ] „Aufräumen“ mit Vorschau: was wird gelöscht, wie viel wird frei
- [ ] Hardlink-Dedupe für identische Mods, Ressourcenpakete und Shader über Instanzen
- [ ] Welten und Screenshots vom Dedupe ausnehmen
- [ ] Fehlerbehandlung: Hash prüfen, bei Fehler das Original behalten

**Akzeptanz.** Der Trockenlauf nennt die reclaimbaren Bytes. Dedupe erzeugt Hardlinks und prüft danach die Hashes. Ein fehlgeschlagener Link zerstört keine Datei. Windows und Linux getestet.

### R04 Sichtbarer Download-Manager

Status: offen · Aufwand **M** · Vorbild: Modrinth, SKLauncher, PCL2

**Ist-Stand.** Hintergrundaufgaben ohne sichtbare Warteschlange, ohne Pause, ohne Speed und ETA.

**Umfang**

- [ ] Queue-Tabelle: Datei, Quelle, Ziel, Status, Fortschritt, Speed, ETA
- [ ] Pause, Fortsetzen, Abbrechen, Wiederholen, Reihenfolge ändern
- [ ] Parallele Downloads begrenzen
- [ ] Fehler pro Datei mit Grund und Retry
- [ ] Queue über einen Neustart hinweg speichern
- [ ] Verlauf der letzten Downloads
- [ ] Anbinden an Modpack-Install, Mod-Updates, Java-Runtime und Assets

**Akzeptanz.** Pause und Fortsetzen funktionieren auch nach einem App-Neustart. Abbrechen räumt Teil-Dateien auf. Ein Fehler nennt Datei, Quelle und Grund. Eine Modpack-Installation zeigt alle Dateien, nicht nur einen Balken.

### R05 Instanz duplizieren (Ausbau)

Status: **teilweise vorhanden** · Aufwand **S–M** · Vorbild: Prism, GDLauncher

**Ist-Stand.** `clone_instance` kopiert den kompletten Ordner und vergibt automatisch einen Namen. Das ist ein vollständiger Klon, keine Auswahl.

**Umfang**

- [ ] Dialog mit Auswahl: Mods, Configs, Ressourcenpakete, Shader, Welten, Screenshots, Options, Keybinds
- [ ] Name und Zielordner vor dem Start
- [ ] Große Ordner per Hardlink statt Kopie, optional
- [ ] Fortschritt und Abbrechen
- [ ] Klon als Vorlage speichern

**Akzeptanz.** Abgewählte Inhalte fehlen im Klon. Abbruch hinterlässt keinen halben Ordner. Ein Hardlink-Klon teilt Bytes, aber Änderungen bleiben getrennt (Copy-on-Write-Verhalten prüfen).

### R06 `bamboo://`-Protokoll und Dateizuordnung

Status: offen · Aufwand **M** · Vorbild: Modrinth, CurseForge, GDLauncher

**Ist-Stand.** Kein Protokollhandler, keine Dateizuordnung, kein Drag & Drop von Pack-Dateien.

**Umfang**

- [ ] Schema `bamboo://install?project=<slug>&source=modrinth|curseforge&version=…`
- [ ] Schema `bamboo://pack?url=…` für `.mrpack` und Zip
- [ ] Registrierung unter Windows (Registry), Linux (`.desktop` + MIME) und macOS (Info.plist)
- [ ] Doppelklick auf `.mrpack`, `.zip` und `.jar` (nur mit Bestätigung)
- [ ] Drag & Drop aufs Fenster
- [ ] „Im Browser öffnen“ als Rückweg
- [ ] Allowlist: bekannte Hosts ohne Nachfrage, unbekannte mit Warnung

**Akzeptanz.** Ein Link auf einer Modpack-Seite öffnet Bamboo mit dem richtigen Pack. Doppelklick auf eine `.mrpack` startet den Import. Unbekannte Quellen zeigen Host und Dateigröße vor dem Download.

---

## 3. Ideenpool

Alles hier ist gewollt, aber noch nicht eingeplant. Die Reihenfolge in den Tabellen ist keine Priorität.

### Ordnung und Instanzen

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Import per URL | ATLauncher, Prism | S |
| [ ] | Desktop-Verknüpfung mit Server und Konto | MultiMC | S |
| [ ] | Snapshot-, Alpha- und Beta-Versionen im Browser | Prism, offizieller Launcher | S–M |
| [ ] | Pack-„keep“-Liste und deklarierte Java-/RAM-Anforderung | ATLauncher, Technic | M |
| [ ] | Portable Mode | Prism | S |
| [ ] | Instanz-Export als Zip zusätzlich zu `.mrpack` | Prism | S–M |

### Downloads und Updates

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Delta- und Smart-Updates statt Volldownload | Technic Solder, SKLauncher | L |
| [ ] | Auto-Update beim Start pro Instanz | CurseForge, Modrinth | S |
| [ ] | Changelog vor dem Update, Version pinnen oder überspringen | Modrinth, HMCL | S–M |
| [ ] | „Alle aktualisieren“ mit Live-Fortschritt | Modrinth | S |
| [ ] | Integritätsprüfung, nur Fehlendes nachladen | SKLauncher, HMCL | M |
| [ ] | Mirror, Proxy und Speed-Limit | HMCL, PCL2 | M |
| [ ] | Cache-Größe anzeigen und aufräumen | Modrinth, HMCL | S |

### Teilen und Publishing

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Share-Code mit Ablauf und Download-Limit | GDLauncher, CurseForge | L, Backend |
| [ ] | Export als CurseForge-Zip | Prism, GDLauncher, HMCL | M |
| [ ] | Server-Pack-Export | HMCL, XMCL, CurseForge | M–L |
| [ ] | packwiz-Sync und serverseitige Mods | packwiz | L |
| [ ] | Cloud-Sync von Einstellungen und Options | Modrinth | XL, Backend |
| [ ] | Launcher-Profil an Freund senden | Feather | S |
| [ ] | Screenshot- und Log-Share-Link | Lunar, SKLauncher, MultiMC | S–M |
| [ ] | Server-Invite, der eine Instanz anlegt | CurseForge, Modrinth | L, Backend |

### Server und Multiplayer

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Lokaler Server-Manager | ATLauncher, GDLauncher, Crafty | L |
| [ ] | Live-Konsole und RCON | Crafty, GDLauncher | M |
| [ ] | Geplante Backups, Retention, Ausschlüsse | Crafty | M |
| [ ] | Crash-Erkennung und Auto-Restart | Crafty | S–M |
| [ ] | Metriken-Graph und Prometheus | Crafty | M |
| [ ] | Discord- und Slack-Webhooks | Crafty | S |
| [ ] | Öffentlicher Server-Browser mit Spielerzahlen | SKLauncher, Lunar | L, API |
| [ ] | Quick Host und Hosted Worlds | SKLauncher, Lunar, Feather | XL |
| [ ] | P2P-Welt teilen | Essential, XMCL, e4mc | XL |
| [ ] | UPnP zuerst, Proxy als Fallback | World Host | M–L |
| [ ] | Voice-Chat | Simple Voice Chat, Lunar, Feather | XL, Mod + Server |
| [ ] | Freunde, DMs und Presence | Lunar, Essential | XL, Backend |
| [ ] | Tunnel-Sidecar (playit.gg) | playit.gg | M |
| [ ] | Serverliste: Gruppen und Ping-Historie | eigene Idee | S |

### Welten, Screenshots und Inhalte

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Save-Preview als Karte | XMCL | L |
| [ ] | Chunks auswählen, kopieren, löschen | XMCL | L |
| [ ] | 3D-Blueprint und Struktur-Vorschau | XMCL | L |
| [ ] | Seed-Map-Link (Chunkbase) | HMCL | S |
| [ ] | Schematic-Manager | HMCL | M |
| [ ] | Datapacks pro Welt verwalten | HMCL | S–M |
| [ ] | Ressourcenpaket-Ladereihenfolge und Enabled-State | Modrinth | M |
| [ ] | Mods im laufenden Spiel togglen | Modrinth | M |
| [ ] | Pack-Inhalte und eigene Mods trennen | Modrinth | S–M |
| [ ] | Abhängigkeitsgraph | eigene Idee | M |
| [ ] | Konflikt-Bisect: Hälfte deaktivieren, testen, wiederholen | eigene Idee | M |
| [ ] | Safe Mode: ohne Mods starten | eigene Idee | S |
| [ ] | Unbenutzte Inhalte finden | XMCL | S–M |
| [ ] | Replay-Verwaltung und Render-Queue | ReplayMod, Lunar | M, Mod |

### Performance, Logs und Java

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Performance-Pack pro Loader und Minecraft-Version | Lunar, Badlion, Iris/Sodium | M |
| [ ] | Benchmark mit 1%-Lows und A/B-Vergleich | eigene Idee | M |
| [ ] | Hardware-Panel (CPU, GPU, RAM) | Badlion | S |
| [ ] | FPS- und Frametime-Graph | eigene Idee | M |
| [ ] | Hardware-Infos im Log | Prism | S |
| [ ] | Low-RAM-Warnung vor dem Start | Prism | S |
| [ ] | Live-Konsole mit Filtern | Modrinth, MultiMC | M |
| [ ] | Anonymisierter Paste-Upload | MultiMC, Modrinth | S–M |
| [ ] | Log-Historie und Aufräumen | MultiMC | S |
| [ ] | KI-Crash-Hilfe, optional mit eigenem Key | XMCL | M |
| [ ] | Exit-Code-Diagnose | XMCL | S |
| [ ] | Startzeitmessung (Java, Assets, Mods) | eigene Idee | S |
| [ ] | Java-Manager: installieren, entfernen, testen | Prism, Modrinth | M |
| [ ] | Adoptium/Temurin und GraalVM als Quellen | GDLauncher, PCL2 | S–M |
| [ ] | Java pro Versionsbereich automatisch wählen | PCL2 | S |
| [ ] | Unbenutzte Runtimes löschen | Modrinth, Prism | S |
| [ ] | Pre- und Post-Launch-Befehle, Env-Vars | Prism, MultiMC | S |
| [ ] | Wrapper (gamescope, mangohud) | Prism | S |
| [ ] | API-Overrides (Metadata, Paste, Auth-Client-ID, User-Agent) | Prism | S–M |
| [ ] | CLI erweitern: Import-URL, Server, Alive-Check | Prism | S |
| [ ] | Skripting und Custom Events | PCL2 | M |
| [ ] | Tray und Close-to-Tray | viele | S |
| [ ] | Jump List und Taskbar-Fortschritt | Windows | S |
| [ ] | Controller- und Steam-Deck-Modus | XMCL Big Picture | L |
| [ ] | Theme-Import/-Export und Custom CSS | HMCL, XMCL | S–M |

### Sicherheit und Ökosystem

| | Feature | Vorbild | Aufwand |
| --- | --- | --- | --- |
| [ ] | Malware-Scan der JARs | SKLauncher | M |
| [ ] | Hosts-Datei prüfen und reparieren | SKLauncher | S–M |
| [ ] | Download-Quellen-Allowlist mit Warnung | CurseForge | S |
| [ ] | Link-Bestätigung vor dem Öffnen | SKLauncher | S |
| [ ] | Pack-Signaturen und Verify | eigene Idee | M–L |
| [ ] | Telemetrie opt-in und Privacy-Panel | SKLauncher | S |
| [ ] | Rollback nach einem schlechten Update | Pack-Update + Backups | M |
| [ ] | FTB-App-Katalog | Prism, FTB | L |
| [ ] | Technic und Solder | Prism, Technic | L |
| [ ] | ATLauncher-Packs | Prism, ATLauncher | M–L |
| [ ] | CurseForge-Plugins für Server | CurseForge | M |
| [ ] | Pack-Dev-Modus mit packwiz, Metadaten und Testserver | packwiz, GDLauncher | L |
| [ ] | Kuratierte Collections und Featured | Stores | S–M |

### Client (siehe Abschnitt 1)

| | Feature | Aufwand |
| --- | --- | --- |
| [ ] | Client-Mod plus Installer, pro Instanz schaltbar | L |
| [ ] | Overlay mit Freunden, Servern, Instanzinfos | L |
| [ ] | Freunde, Presence und DMs | XL, Backend |
| [ ] | Voice-Chat | XL, Mod + Server |
| [ ] | Cosmetics im Spiel sichtbar machen | L |
| [ ] | HUD-Module | M |
| [ ] | Hosted Worlds und P2P | XL |

---

## 4. Bewusst nicht

- **Client-Injection mit Anti-Cheat wie Lunar oder Badlion.** Anderes Produkt, rechtliches Risiko, bricht mit jedem Update.
- **ReplayMod bündeln.** GPL, passt nicht in einen Closed-Source-Launcher. Höchstens als optionale, vom Nutzer installierte Mod.
- **OptiFine bündeln.** Lizenz und Konflikte mit Sodium/Iris.
- **Offline- oder Cracked-Auth.** Auch wenn Prism und HMCL es anbieten.
- **Cosmetics für Vanilla-Spieler.** Braucht einen Client auf beiden Seiten. Bamboo-Cosmetics bleiben unter Bamboo-Nutzern sichtbar.
- **Prism-Component-Graph mit editierbaren JSON-Patches.** Power-User-Komplexität, die die meisten Nutzer nicht brauchen.

---

## 5. Vorgeschlagene Reihenfolge

| Release | Inhalt | Dauer |
| --- | --- | --- |
| **0.3.0 „Weiterspielen“** | R01, R02, R05, Safe Mode, Pre-/Post-Launch, Tray, Discord RPC zurück | 2–3 Wochen |
| **0.4.0 „Aufgeräumt“** | R03, R04, Java-Manager, Live-Konsole, Paste-Upload, Hardware-Panel | 3–4 Wochen |
| **0.5.0 „Teilen“** | R06, CurseForge-Zip-Export, Screenshot-Editor, Share-Codes | 3–4 Wochen |
| **0.6.0 „Server“** | Server-Manager, RCON, geplante Backups, Server-Pack-Export, packwiz | 6–8 Wochen |
| **Danach** | Client-Modus (L1/L2), P2P, Voice, Freunde, Cloud-Sync, Weltkarte | offen |

Die Reihenfolge ist ein Vorschlag, kein Beschluss. R01 und R02 sind billig und sofort sichtbar, deshalb stehen sie vorn. Der Client ist die größte Idee und braucht die meiste Vorbereitung.

---

## 6. Offene Entscheidungen

- [ ] Reihenfolge 0.3.0 bestätigen oder tauschen
- [ ] Client: Fabric-only starten oder direkt NeoForge mitdenken?
- [ ] Backend für Freunde und Share-Codes jetzt vorbereiten oder erst nach 0.6.0?
- [ ] Discord Rich Presence sofort zurückbringen oder mit dem Client-Overlay zusammen?
- [ ] Welche drei Features aus dem Pool sind „muss in 2026 noch rein“?
