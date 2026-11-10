# Bamboo Launcher

Minecraft-Launcher mit Rust-Kern und React-Oberfläche (Tauri 2). Der Kern
übernimmt Installation, Anmeldung, Instanzen, Loader, Mods, Modpacks und den
Spielstart; die Oberfläche spricht über Tauri-Commands mit ihm.

## Voraussetzungen

- Rust (stable, Edition 2021) und Cargo
- Node.js 20+ und npm
- Windows: WebView2 (bei Windows 10/11 vorinstalliert)
- Linux/macOS: die [Tauri-Systempakete](https://tauri.app/start/prerequisites/)

## Entwicklung

```bash
npm --prefix ui install
npm --prefix ui run tauri dev
```

`tauri dev` startet Vite auf Port 5173 und danach das Desktop-Fenster. Läuft
bereits ein Vite-Server, bricht der Start mit „Port 5173 is already in use“ ab –
dann den alten Prozess beenden oder nur `cargo run --bin bamboo-desktop` starten,
wenn die Oberfläche schon läuft.

## Prüfen

```bash
cargo test                          # Kern- und Integrationstests
npm --prefix ui run check:bridge    # Brücke gegen alle Tauri-Commands
npm --prefix ui run build           # Typecheck + Produktions-Build
```

`check:bridge` vergleicht jeden `invoke`-Aufruf mit der Rust-Signatur. Fehlt ein
Pflichtargument, schlägt der Lauf fehl – genau dieser Fehler hat schon
Server-Ping und Crash-Analyse lahmgelegt.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/` | Kern-Engine ohne UI-Abhängigkeiten (Versionen, Install, Java, Loader, Mods, Modpacks, Auth, Start) |
| `src/desktop/` | Tauri-App: `main.rs` und die Command-Schicht in `ipc.rs` / `commands/` |
| `src/main.rs` | CLI-Frontend `bamboo-launcher` für dieselbe Engine |
| `tests/` | Integrationstests gegen lokale Mock-Server, keine echten Konten nötig |
| `ui/` | React 19, Vite, Tailwind 4; `ui/src/lib/tauriBridge.ts` bildet die alte Electron-API auf Tauri ab |
| `BambooCosmetics/` | Katalog und Pakete des Kosmetik-Shops |
| `docs/` | Migrations- und Cosmiq-Notizen |

## Daten

Einstellungen und Cache liegen unter `%APPDATA%\BambooLauncher` (Windows) bzw.
`~/.config/bamboo-launcher` (Linux/macOS):

- `settings.json` – Theme, Sprache und Einstellungen der Oberfläche
- `core.json` – Spielwurzel, Java-Pfad, Speicher, CurseForge-Key des Kerns
- `cache/` – Versionsmanifeste und Java-Runtimes

Spielinstanzen liegen unter `<Spielwurzel>/instances`. Jede Instanz führt in
`bamboo/sessions.json` Protokoll über ihre Starts; die Statistik-Seite liest
daraus Sessions und „zuletzt gespielt“, die Spielzeit aus den Welt-Statistiken.

## Paketierung

`tauri.conf.json` bündelt alle Ziele des jeweiligen Systems (`bundle.targets:
"all"`). `npm --prefix ui run tauri -- build` legt die Pakete unter
`target/release/bundle/` ab:

| System | Artefakte |
| --- | --- |
| Windows | `msi/`, `nsis/` |
| macOS | `dmg/`, `macos/` |
| Linux | `deb/`, `rpm/`, `appimage/` |

Die Pakete werden auf dem Zielsystem gebaut; Windows-Installer entstehen nur
unter Windows, `.dmg` nur unter macOS und `.deb`/`.rpm`/`.AppImage` nur unter
Linux. Die Icons für alle drei Systeme liegen in `icons/`.

### Updates veröffentlichen

Der Launcher aktualisiert sich selbst über das Tauri-Updater-Plugin. Die Quelle
steht in `tauri.conf.json` unter `plugins.updater.endpoints`, der öffentliche
Schlüssel daneben unter `pubkey`. Signiert wird mit dem privaten Schlüssel:

```bash
TAURI_SIGNING_PRIVATE_KEY=release/updater.key npm --prefix ui run tauri -- build
```

`bundle.createUpdaterArtifacts` legt neben jedem Paket eine `.sig`-Datei ab.
Die ersten Versionen mit diesem Updater sind die 0.2.5; ältere Electron-Builds
kennen ihn nicht und brauchen einmalig ein Paket von Hand.
Danach die Pakete samt `.sig` nach `release/v<version>/` kopieren und den Feed
bauen:

```bash
node scripts/make-latest-json.mjs \
  --base-url https://github.com/Borisgamer1/Bamboo-Launcher/releases/download/v0.2.5
```

Das Skript schreibt `release/v<version>/latest.json`. Diese Datei und alle
Artefakte gehören ins GitHub-Release; der Endpoint zeigt auf
`releases/latest/download/latest.json`, die Dateinamen müssen also zum Feed
passen.

### Veröffentlichen per Tag

Der normale Weg ist ein Tag: [`.github/workflows/release.yml`](.github/workflows/release.yml)
baut auf GitHub Windows, macOS (universal) und Linux, hängt alle Pakete samt
`.sig` an das Release des Tags und schreibt am Ende `latest.json` aus den
hochgeladenen Dateien. Ein Push von `v0.2.5` veröffentlicht also alles, was der
Updater braucht.

Dafür muss im Repository unter *Settings → Secrets and variables → Actions* der
private Schlüssel als `TAURI_SIGNING_PRIVATE_KEY` liegen (Inhalt von
`release/updater.key`), bei gesetztem Passwort zusätzlich
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Ohne den Schlüssel bricht der Build ab,
weil `createUpdaterArtifacts` signierte Pakete verlangt.

Lokal bauen geht weiterhin nur für das eigene System:

```bash
TAURI_SIGNING_PRIVATE_KEY=$(cat release/updater.key) npm --prefix ui run tauri -- build
```

**Der private Schlüssel (`release/updater.key`) ist ein Geheimnis.** Er liegt
außerhalb der Versionsverwaltung und muss gesichert werden: geht er verloren,
nehmen bestehende Installationen keine Updates mehr an, weil die Signatur nicht
mehr zum eingebauten öffentlichen Schlüssel passt. Ein neuer Schlüssel braucht
ein neues Release mit neuem `pubkey` — und eine manuelle Installation bei allen.

## Lizenz

Noch keine Lizenz hinterlegt.
