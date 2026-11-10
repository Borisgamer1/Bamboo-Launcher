# Rust-Migration: Blueprint aus dem Electron-Prototyp

Referenz: `C:\AI Games-Apps\Bamboo Launcher\BambooLauncher\electron`
Ziel: `C:\AI Games-Apps\Bamboo Launcher (RUST)`

## 1. Microsoft-OAuth (Quelle: `electron/auth/microsoft.ts`)

**Flow:** Authorization Code + PKCE, lokaler Loopback-HTTP-Server.

| Konstante | Wert |
| --- | --- |
| Redirect-Port | `3377`, URI `http://localhost:3377` (Bind auf `127.0.0.1`) |
| Authority | `https://login.microsoftonline.com/consumers/oauth2/v2.0` |
| Scope | `XboxLive.signin XboxLive.offline_access offline_access openid profile` |
| Client-ID | öffentlicher Client, kein Secret (Default `ccbe9e09-...`, per env überschreibbar) |
| Login-Timeout | 5 min |

1. `state` = 16 Zufallsbytes (hex), PKCE-Verifier = 32 Zufallsbytes (base64url), Challenge = SHA-256 davon (base64url).
2. Authorize-URL: `response_type=code`, `response_mode=query`, `code_challenge_method=S256`, `prompt=select_account`.
3. Server nimmt nur `GET /` bzw. `/callback`, prüft `state`, liefert bei Erfolg HTML-Seite, dann `code`.
4. Token-Tausch: `POST {authority}/token` als `application/x-www-form-urlencoded` (`grant_type=authorization_code`, `code_verifier`).
5. Refresh: gleicher Endpoint mit `grant_type=refresh_token`. Refresh-Margin 5 min.

**Xbox-Kette (danach immer dieselbe Reihenfolge):**
1. `POST https://user.auth.xboxlive.com/user/authenticate` → `RpsTicket: "d=<ms_access_token>"`, RelyingParty `http://auth.xboxlive.com` → liefert `Token` + `DisplayClaims.xui[0].uhs`.
2. `POST https://xsts.auth.xboxlive.com/xsts/authorize` → `SandboxId: RETAIL`, RelyingParty `rp://api.minecraftservices.com/`.
3. `POST https://api.minecraftservices.com/authentication/login_with_xbox` → `identityToken: "XBL3.0 x=<uhs>;<xsts>"` → `access_token` (ca. 24 h).
4. `GET https://api.minecraftservices.com/minecraft/profile` mit Bearer → `{ id (uuid), name }`.

**Fehlercodes, die gemappt werden müssen:** `XErr` 2148916227 (gesperrt), 2148916233 (kein Xbox-Profil), 2148916235 (Region), 2148916236/237/238 (Kinderkonto/Familie). HTTP 403 bei Schritt 3 = App-ID nicht für Minecraft freigegeben. Profil-404 = kein Java-Profil.

**Persistenz:** Metadaten (Name, UUID, Avatar, expiresAt) in `accounts.json`, Tokens **nur** im OS-Secret-Store (Electron: `safeStorage`; Rust: `keyring`-Crate). Tokens nie loggen, nie an die UI geben.

## 2. Versions-Auflösung (Quelle: `electron/version/`)

- Versions-JSON: `<root>/versions/<id>/<id>.json`. `inheritsFrom` bildet eine Kette (max. 8, Zyklus = Fehler). Merge von **hinten nach vorne**, damit das Kind gewinnt.
- Legacy: fehlt `arguments`, wird `minecraftArguments` an Leerzeichen gesplittet und ein festes `LEGACY_JVM_ARGUMENTS`-Set verwendet (`-Djava.library.path`, `-cp ${classpath}`, Windows-10-Tricks).
- Argument-Regeln (`rules`): `allow`/`disallow`, Bedingungen auf `os.name` (`windows`/`osx`/`linux`), `os.arch` (`x64`/`ia32`/`arm64`, `x86`→`ia32`), `os.version` als **Regex** gegen `os.release()`, und `features` (z. B. `is_demo_user`, `has_custom_resolution`). Letzte passende Regel gewinnt; keine Regeln = erlaubt.
- Libraries: `rules` auswerten, `natives`-Classifier je OS/Arch einsammeln und entpacken (ZIP, nur erlaubte Einträge, Executable-Bit auf Unix), `classpath` = Libraries + Client-Jar, Trenner `;` (Windows) sonst `:`.
- Assets: `assetIndex` → `assets/indexes/<id>.json`, Objekte nach `assets/objects/<2-stelliger-Prefix>/<hash>`, URL `https://resources.download.minecraft.net/<prefix>/<hash>`.
- Java-Anforderung: `javaVersion.majorVersion` / `component`, Fallback `jre-legacy`/8.

## 3. Java-Runtime (Quelle: `electron/java/`)

- Manifest: `https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json`
- Platform-Keys: `windows-x64`, `windows-x86`, `windows-arm64`, `mac-os`, `mac-os-arm64`, `linux`, `linux-i386`.
- Komponente ↔ Major: `jre-legacy`=8, `java-runtime-alpha`=16, `java-runtime-beta/gamma`=17, `java-runtime-delta`=21, `java-runtime-epsilon`=25.
- Auswahl: erst installierte JVMs scannen (Major aus `release`-File/`java -version`), dann Mojang-Runtime passend zum Major herunterladen.
- Start unter Windows mit `javaw.exe` aus demselben Verzeichnis, falls vorhanden.

## 4. Launch (Quelle: `electron/launch/`)

**Reihenfolge:** `resolveVersionModel` → JVM-Plan (Heap/Preset) → Natives entpacken → Argumente bauen → Precheck (Java-Version, Speicher) → Prozess starten.

**Platzhalter im Argument-Template** `${...}`:

```
natives_directory, launcher_name, launcher_version, game_directory, classpath,
library_directory, classpath_separator, version_name, auth_player_name, auth_uuid,
auth_access_token, auth_session, user_type (msa|legacy), version_type,
user_properties ("{}"), clientid, auth_xuid, resolution_width, resolution_height,
assets_root, assets_index_name
```

- Pfade für Minecraft immer mit `/`.
- Offline-UUID: MD5 von `OfflinePlayer:<name>`, danach Version 3 + Variante RFC 4122 setzen.
- JVM-Argumente werden geschichtet gemerged (Plan vor Versions-JSON); `-Xms` des JSON wird verworfen, wenn der Plan einen Heap vorgibt; `-DignoreList=` bekommt den Client-Jar angehängt; fehlt `-cp`, wird es ergänzt.
- Logging-Argument nur setzen, wenn `<root>/assets/log_configs/<file.id>` existiert.
- Quick Play ab 1.20: `--quickPlayMultiplayer host:port` bzw. `--quickPlaySingleplayer <world>`, sonst `--server`/`--port`.
- Prozess: `cwd` = Spielverzeichnis, detached, stdout/stderr zeilenweise lesen.
  - Ready-Marker: `LWJGL Version:`, `OpenAL initialized`, `Reloading ResourceManager`, `Preparing level`, `Setting user:`.
  - Crash: `---- Minecraft Crash Report ----`, Pfad aus `Crash report saved to: ...`.
  - Beenden unter Windows: `taskkill /pid <pid> /f /t`; sonst `SIGKILL`.
- Token in der Kommandozeile immer redigieren, bevor geloggt wird.

## 5. Modrinth (Quelle: `electron/mods/modrinth.ts`)

Basis `https://api.modrinth.com/v2`, Pflicht-Header `User-Agent: BambooLauncher/<version> (bamboo-launcher)`.

| Zweck | Endpoint |
| --- | --- |
| Suche | `GET /search?query=&limit=&offset=&index=&facets=` (facets = JSON-Array von Arrays) |
| Projekt | `GET /project/{id|slug}` |
| Versionen | `GET /project/{id|slug}/version?game_versions=["1.20.1"]&loaders=["fabric"]` |
| Einzelversion | `GET /version/{id}` |
| Datei per Hash | `GET /version_file/{hash}?algorithm=sha1` |
| Mehrere Hashes | `POST /version_files` `{hashes, algorithm}` |
| Updates | `POST /version_files/update_many` `{hashes, algorithm, game_versions, loaders, version_types}` |

Loader-Namen für Modrinth: `fabric`, `quilt`, `forge`, `neoforge`. Download-URLs stehen direkt in `files[].url`; primär ist `files[].primary`; Hashes `sha1`/`sha512` immer verifizieren.

## 6. CurseForge (Quelle: `electron/mods/curseforge.ts`, `curseforge-http.ts`)

Basis `https://api.curseforge.com/v1`, Header `x-api-key` **und** `User-Agent`, `gameId` = **432** (Minecraft).

| Zweck | Endpoint |
| --- | --- |
| Suche | `GET /mods/search?gameId=432&classId=&searchFilter=&gameVersion=&modLoaderType=&index=&pageSize=` |
| Mod | `GET /mods/{id}` (liefert `allowModDistribution`) |
| Dateien | `GET /mods/{id}/files?pageSize=100&sortField=2&sortOrder=desc` |
| Eine Datei | `GET /mods/{id}/files/{fileId}` |
| Download-URL | `GET /mods/{id}/files/{fileId}/download-url` |
| Fingerprints | `POST /fingerprints` `{fingerprints:[murmur2]}` |
| Mods per ID | `POST /mods` `{modIds:[]}` |

- CDN-Fallback: `https://mediafilez.forgecdn.net/files/{id/1000}/{id%1000}/{filename}` (4-stellig gepolstert). Nur erlaubt, wenn `allowModDistribution !== false`.
- Reihenfolge beim Download: `file.downloadUrl` → `download-url`-Endpoint → CDN. Bei 403/abgelaufener URL eine Runde ohne den toten Kandidaten wiederholen.
- Retry: 429/5xx mit `Retry-After`, sonst exponentiell (250 ms × Versuch), 3 Versuche.

## 7. Loader-Metadaten (Quelle: `electron/loaders/metadata.ts`)

```
Fabric    https://meta.fabricmc.net
Quilt     https://meta.quiltmc.org
Forge     https://maven.minecraftforge.net   (+ files.minecraftforge.net)
NeoForge  https://maven.neoforged.net/releases
          https://maven.neoforged.net/api/maven/versions/releases
Launchwrapper  https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar
```

## 8. Spielverzeichnis-Layout

```
<root>/versions/<id>/<id>.json + <id>.jar
<root>/libraries/<group>/<artifact>/<version>/...
<root>/assets/indexes/<index>.json
<root>/assets/objects/<xx>/<hash>
<root>/assets/log_configs/<file>
<root>/instances/<name>/{mods,config,saves,resourcepacks}
```

## 9. Crate-Zuordnung für den Rust-Neubau

| Aufgabe | Crate |
| --- | --- |
| Async-Runtime, Prozesse, Loopback-Server | `tokio` |
| HTTP + Streaming | `reqwest` (rustls) |
| JSON / Modelle | `serde`, `serde_json` |
| Fehlertypen | `thiserror`, `anyhow` |
| Hashes (SHA-1/SHA-256/MD5) | `sha1`, `sha2`, `md-5` |
| ZIP (Natives, Modpacks) | `zip` |
| Tokens im OS-Store | `keyring` |
| Browser öffnen | `open` |
| Pfade (AppData etc.) | `directories` |
| Logging | `tracing`, `tracing-subscriber` |

## 10. Migrationsreihenfolge (Vorschlag)

1. Pfad-/Config-Layer + Spielverzeichnis.
2. Version-Manifest + Rules + Libraries + Assets (Download mit Hash-Verifikation).
3. Java-Erkennung/Installation, JVM-Plan.
4. Launch-Argumente + Prozessstart + Log-Streaming.
5. Microsoft-OAuth inkl. Secret-Store.
6. Modrinth, dann CurseForge.
7. Loader-Installer (Fabric → NeoForge → Forge).
