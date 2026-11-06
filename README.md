# Bamboo Launcher

**A New Highly Improved Minecraft Mod Launcher with tons of Features.**

Discord: <https://discord.gg/DXzNcTGJD> · Website: <https://bamboolauncher.pages.dev>

> Der Quellcode ist einsehbar und darf frei genutzt und für dich selbst gebaut werden. Er ist
> aber **kein Open Source**: Verkaufen, Weiterverbreiten, Verändern und Forks sind nicht erlaubt.
> Die vollständigen Bedingungen stehen in [`LICENSE`](LICENSE).

## Was ist neu – v0.2.2 (Beta)

**Neu**

- Neun Themes: Bamboo Forest, End City, Snowy Lands, Nether Fortress, Obsidian Portal, Warden
  Valley, Copper Trials, Underwater Paradise und Cherry Blossom — plus Custom-Modus mit eigener
  Akzentfarbe, eigenem Hintergrundbild und Effekt-Reglern.
- Statistiken: Spielzeit, abgebaute und gesetzte Blöcke, jede Distanzart einzeln, Mobs, Tode und
  Sprünge — pro Minecraft-Version gruppiert und einklappbar. Die Spielzeit bleibt erhalten, auch
  wenn eine Instanz gelöscht wird.
- Einführung beim ersten Start: Willkommensbildschirm, geführte Tour über den echten Launcher
  (Seitenleiste, Konto, Instanz anlegen, Mod-Browser, Einstellungen) und ein echter Java-Scan.
  „Was ist neu“ erscheint einmal pro Version, der Changelog liegt unter Einstellungen → Über.
- Mod-Details: Beschreibung, Metadaten, Versionswechsel und „Im Browser öffnen“ direkt neben den
  anderen Aktionen.
- Versionsliste mit Installationsfortschritt: eine andere Version ersetzt die installierte,
  statt sie zu verdoppeln.

**Besser**

- Einstellungen neu sortiert: Launcher, In-Game und System als Untertitel, Java & Speicher,
  Spieloptionen und Key-Binds als eigene Tabs. Vollbild und Mausempfindlichkeit wirken jetzt
  wirklich beim Start.
- Instanz-Kopfzeile aufgeräumt: Updates sind der auffälligste Knopf und nennen die betroffenen
  Mods, Hochladen ist ein Icon, Neu laden ein leiser Knopf.
- Mods, Inhalte und Instanzen sind nach Namen sortiert.
- Import ohne Java-Meldung (Java wird beim Start geprüft), und das Import-Fenster lässt sich
  schließen, während der Import weiterläuft.
- Eigene Mods aktivieren zeigt vorher eine Warnung, entsperrt danach alles und verschwindet
  dauerhaft.
- Der Mod-Browser merkt sich Seite und Position, wenn du eine Instanz öffnest.

**Behoben**

- Die Großansicht eines Screenshots wird oben nicht mehr abgeschnitten.
- Der Server-Status aktualisiert nur noch auf Knopfdruck, ist schneller und zeigt keinen Ping.

**Entfernt**

- Das Mehrspieler-Sharing samt Einladungen und Join-Links.
- Der Punkt am Skin im Kontomenü.

## About this repository

Bamboo Launcher is a local-first Minecraft launcher. An Electron shell hosts a
React/TypeScript renderer and a TypeScript main process that manages instances, mod loaders
(Vanilla, Fabric, Forge, NeoForge), Java runtimes, mods and modpacks (Modrinth and CurseForge),
log analysis, Microsoft sign-in and the UI theme system.

There is no launcher backend and no launcher account service: settings, accounts and instances
are stored on the machine, and themes ship with the application. Network access is limited to the
services the features use: Mojang/Fabric metadata and asset CDNs, Modrinth, CurseForge,
Microsoft/Xbox sign-in, optional Discord rich presence, and the image hosts used for avatars and
placeholder art.

This repository holds the launcher itself. The companion cosmetics runtime is a separate project
and is not part of this repository. The launcher manages the runtime's `.cosmiq` packages: it
renders them on the player, installs packages from a GitHub catalog into an
account-wide library mirrored to every instance and deletes them. Equipping
happens in game; see
[`docs/cosmetics-shop.md`](docs/cosmetics-shop.md).

Current version: `0.2.3` (in development; the last published build is `0.2.2`). Packaging targets:
Windows x64 (NSIS), macOS universal (DMG + ZIP) and Linux x64 (AppImage + DEB). Release notes live
in [`CHANGELOG.md`](CHANGELOG.md). Releases are published to GitHub; installed Windows and Linux
AppImage builds update themselves, unsigned macOS builds do not; see [`RELEASING.md`](RELEASING.md).

## Stack and requirements

- Electron 30, main process written in TypeScript (`electron/`) and compiled to `dist-electron/`.
- React 19 + Vite 8 renderer (`src/`).
- `node:test` for all automated tests (`tests/*.test.cjs`); no Jest/Vitest runner.
- Node.js 24 and npm (the version CI uses). Java is found or installed at runtime, not bundled.
- Windows, macOS or Linux for packaging; electron-builder runs on the target OS. CI uses
  `windows-latest`, `macos-latest` and `ubuntu-latest`.

## Setup and run

```bash
cd BambooLauncher
npm install
```

Run the renderer and the Electron shell in two terminals:

```bash
npm run dev        # Vite dev server on http://localhost:5173
npm run electron   # compiles electron/ then opens the shell
```

`npm run electron` loads `http://localhost:5173`; when no dev server is running it falls back to
the built renderer in `dist/`, so run `npm run build` first for a production-like local run.
The Electron project itself is checked by `npm run build:core` (part of `npm run build` and of
`npm run electron`), not by `tsc -b`.
On first start the launcher asks for a game folder. For scripted smoke runs, set
`BAMBOO_SKIP_BOOTSTRAP=1` to keep the default folder (see environment variables below).

## Project layout

```text
main.js                 Electron window/bootstrap plus shell-owned IPC handlers
preload.js              contextBridge: exposes window.electronAPI (the only ipcRenderer user)
electron/               main-process TypeScript (compiled to dist-electron/)
  index.ts              boots the core and registers IPC
  core.ts               shared services: stores, instances, Java, launch, mods, logs
  ipc.ts                namespaced IPC handlers for the core
  legacy/               bridges for the legacy renderer: options.txt, CurseForge,
                        instance folders/register, version switch/repair, modpack
                        install, profile export/import, settings, shell and screenshots
  ipc-registry.ts       registration wrapper: sender guard + schema validation
  schemas.ts            zod schemas for IPC arguments
  auth/ launch/ loaders/ java/ mods/ instances/ version/ logs/ support/
src/                    React renderer
  App.tsx               composes the domain hooks
  hooks/                instances, settings, theme, navigation, overlays, launch, servers
  components/           views and dialogs (Instances, Mods, Settings, Logs, ...)
  lib/                  translations, description sanitizer, keybinds, helpers
  services/             theme catalog, profile import/export
  data/themes.ts        local theme definitions
  electron.d.ts         single type owner for the preload contract
public/images/          bundled theme background images
tests/                  node:test suites, fixtures only (no live Minecraft)
scripts/                offline guard, launch dry-run, support-bundle E2E
resources/              icon, instance templates, bundled cosmetic-shop catalog
mod/                    standalone Fabric cosmetics project (kept out of this repository)
website/                static legal/marketing pages (not part of the app build)
```

## Gates

Every command below was run in the repository as part of the documentation pass that produced
this file, with the results shown.

| Command | What it checks | Last result |
| --- | --- | --- |
| `npm run lint` | ESLint over the whole repository, zero warnings allowed | 0 errors, 0 warnings |
| `npx tsc -b` | TypeScript project references for the renderer and node configs | clean |
| `npm run build` | `build:core` (`tsc -p tsconfig.electron.json`), `tsc -b`, Vite production build | success |
| `npm run test:core` | core suite | 516 tests, 516 passed |
| `npm run test:offline` | the same suite with non-loopback network blocked | 516 passed, 55 files, 0 external attempts |
| `npm run launch:dryrun` | read-only launch planning against the real `.minecraft` installation | exit 0, no process started |

`npm run build` emits the usual Vite chunk-size warning but completes. `test:core` enumerates its
test files explicitly; `test:offline` runs every `tests/*.test.cjs` file under
`scripts/no-network-preload.cjs` and fails if anything tries to reach the internet.

`launch:dryrun` needs an existing Minecraft installation (`%APPDATA%\.minecraft` by default). It
resolves the installed versions, Java runtime and full command line, but never starts the game or
writes to the game folder. It is the closest check to a real launch that does not require an
account, and it is the only launch verification that was performed here (see limitations).

CI (`.github/workflows/core-ci.yml`) runs on Windows and Ubuntu with Node 24: dependency install
with scripts disabled, `npm run lint`, `npm run test:offline`, the support-bundle E2E script and
`npm run build`.

## Packaging

```bash
npm run dist:win     # Windows x64, NSIS installer
npm run dist:mac     # macOS universal (Intel + Apple Silicon), DMG + ZIP
npm run dist:linux   # Linux x64, AppImage + DEB
```

Each command runs the production build first and writes the artifacts plus update metadata
(`latest*.yml`, blockmaps) into `release/`. Windows keeps
`Bamboo-Launcher-Setup-<version>.exe` with `oneClick: false` and a selectable install directory;
macOS and Linux use `Bamboo-Launcher-<version>-<arch>.<ext>`. The builds are unsigned, so Windows
SmartScreen and macOS Gatekeeper warn on first run. macOS auto-update only works with a signed
app, so unsigned macOS builds must be replaced by hand.

`.github/workflows/release.yml` runs on a `v*` tag: it verifies lint and the offline core suite,
builds all three platforms on their native runners, then a single publish job uploads every asset
into one GitHub release. The publish job exists so the platforms never race on the same release;
`workflow_dispatch` builds the artifacts without publishing. See [`RELEASING.md`](RELEASING.md).

## Local themes

Themes are fully local; nothing is fetched from a server or CDN.

- Definitions: [`src/data/themes.ts`](src/data/themes.ts) (`LOCAL_THEMES`) - eight themes with id,
  name, accent and optional background, including the default `bamboo` theme.
- Backgrounds: [`public/images/`](public/images) (`bamboo_forest.png`, `cherry_blossom.png`,
  `frozen_ice.png`, `nether_amber.png`). Paths are relative to the document base
  (`./images/...`), so they resolve both in the Vite dev server and in a packaged build.
- Lookup: [`src/services/themeService.ts`](src/services/themeService.ts) reads only that catalog.
- Selection: [`src/hooks/useTheme.ts`](src/hooks/useTheme.ts) stores the theme id in
  `localStorage` under `bamboo-theme` (default `bamboo`) and applies the accent as CSS custom
  properties on the document root.
- Appearance switches (background image, particles, glow, brightness, blur) are separate
  `localStorage` keys prefixed `bamboo-`, owned by [`src/hooks/useAppearance.ts`](src/hooks/useAppearance.ts).

To add a theme, add a `ThemeDefinition` to `LOCAL_THEMES` and, if it has one, a background image
under `public/images/`. No download or migration step exists.

## Preload contract and IPC

The renderer never touches `ipcRenderer`. [`preload.js`](preload.js) exposes one object,
`window.electronAPI`, grouped by domain: `launch`, `logs`, `settings`, `instances`, `mods`,
`dialogs`, `profiles`, `auth`, `join`, `window`, `java`, `loaders`, `servers`, `screenshots`,
`system`, plus the cached `icons` map.

- Single type owner: [`src/electron.d.ts`](src/electron.d.ts). It declares `BambooApi` with one
  interface per namespace and augments `Window.electronAPI`. Do not duplicate these signatures
  at call sites; the preload JavaScript must be kept in sync with this file.
- Main-process side: every channel is registered through the registrar created in `main.js`
  (`createIpcRegistrar`) and the handlers in [`electron/ipc.ts`](electron/ipc.ts). The registrar
  applies a sender guard to every channel; handlers that take arguments or touch the filesystem
  validate them with the zod schemas in [`electron/schemas.ts`](electron/schemas.ts).
- `tests/preload-contract.test.cjs` and `tests/ipc-owner.test.cjs` guard the exposed channel set
  and the single-registration invariant.

## Local data and environment

Electron's userData directory (via `app.getPath('userData')`) holds launcher state:
`root` (pointer to the game folder), `settings.json`, `accounts.json`, `accounts.tokens.json`
(encrypted tokens), `instances.json`, `java.json`, `logs/`, `cache/`, `backups/`.

Instances created in the launcher UI live under the game folder at
`<game root>/profiles/<folder>/`, with the usual `mods/`, `config/`, `saves/`, `resourcepacks/`,
`shaderpacks/`, `screenshots/`, `logs/` and `crash-reports/`. Their metadata is the legacy profile
entry in `<game root>/profiles.json`. The core also accepts a managed layout under
`<game root>/instances/<folder>/` whose folders carry `instance.json`. Both kinds are registered in
`<userData>/instances.json`; the launcher updates that register when an instance is created,
renamed, cloned or deleted, and reconciles existing profiles on load. The game root is chosen on
first start and can be changed later; `%APPDATA%\.minecraft` is not modified.

| Variable | Effect |
| --- | --- |
| `BAMBOO_GAME_ROOT` | Game folder to adopt when it exists (otherwise the remembered root is used) |
| `BAMBOO_SKIP_BOOTSTRAP=1` | Skips the first-run folder picker (used by smoke runs) |
| `BAMBOO_LOG_LEVEL` | `debug`, `info`, `warn` or `error`; default `info` |
| `BAMBOO_MS_CLIENT_ID` | Overrides the built-in Microsoft OAuth client id |

CurseForge support reads its API key from `resources/curseforge-key.txt` at runtime and returns a
structured `missing-key` error when the file is absent. That file is **not** part of this
repository: a checkout you build yourself needs its own key at that path. Release builds write the
key from the `CURSEFORGE_API_KEY` repository secret before packaging, so the installer still ships
with one while the sources do not.

## Tests and what they cover

The 55 suites are fixture-driven and must not need a Minecraft installation or external network
access. They cover IPC ownership and argument validation, the preload contract,
version/manifest resolution,
Java selection, loader installers, the launch command builder and legacy instance migration,
mod/modpack pipelines (including CurseForge parity), the description HTML sanitizer, secrets
handling, log analysis, join payloads, support-bundle redaction and UI helpers.

## Known limitations and unverified behavior

- Real end-to-end launch was not exercised. `launch:dryrun` resolves versions, Java, libraries and
  the full argument list, but no Minecraft process was started, so "the game boots and reaches
  the main menu" remains unproven here.
- Live CurseForge and Modrinth API calls were not exercised in this pass. CurseForge needs its key
  and network access; the test suites use fixtures and the missing-key path is covered.
- The interactive Microsoft sign-in flow (browser round-trip, token refresh) was not run; it
  requires a real account.
- The Windows installer was built but not installed or started. Discord rich presence connected
  during the shell smoke test, but nothing beyond that connection was verified.
- The macOS and Linux installers are produced by CI on their native runners only; neither was
  installed or started here.

## Repository notes

- The launcher has no server and no database; all state lives in the Electron userData directory.
- [`SUMMARY.md`](SUMMARY.md) is stale: it documents the deleted PostgreSQL backend, the friends
  service and an older cosmetics UI. Do not treat it as current.

## License

Source-available, **not** open source. You may use Bamboo Launcher for free — including in
monetized videos and streams — and build it for your own use. Selling it, redistributing it,
publishing modified versions and creating forks are not allowed. The full terms are in
[`LICENSE`](LICENSE).

Bundled third-party components keep their own licenses. Bamboo Launcher is not affiliated with
Mojang Studios or Microsoft.
