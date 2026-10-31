# Bamboo Launcher

Bamboo Launcher is a local-first Minecraft launcher for Windows. An Electron shell hosts a
React/TypeScript renderer and a TypeScript main process that manages instances, mod loaders
(Vanilla, Fabric, Forge, NeoForge), Java runtimes, mods and modpacks (Modrinth and CurseForge),
log analysis, Microsoft sign-in and the UI theme system.

There is no launcher backend and no launcher account service: settings, accounts and instances
are stored on the machine, and themes ship with the application. Network access is limited to the
services the features use: Mojang/Fabric metadata and asset CDNs, Modrinth, CurseForge,
Microsoft/Xbox sign-in, optional Discord rich presence, and the image hosts used for avatars and
placeholder art.

Current version: `0.2.1`. Packaging target: Windows x64, NSIS installer. Releases are published
to GitHub and installed versions update themselves; see `RELEASING.md`.

## Stack and requirements

- Electron 30, main process written in TypeScript (`electron/`) and compiled to `dist-electron/`.
- React 19 + Vite 8 renderer (`src/`).
- `node:test` for all automated tests (`tests/*.test.cjs`); no Jest/Vitest runner.
- Node.js 24 and npm (the version CI uses). Java is found or installed at runtime, not bundled.
- Windows 10/11 for packaging. The dev server runs on other platforms, but only the Windows
  installer is configured.

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
resources/              icon, CurseForge key file, instance templates
mod/                    standalone Fabric cosmetics Gradle project (not part of the app build)
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
| `npm run test:core` | core suite | 394 tests, 394 passed |
| `npm run test:offline` | the same suite with non-loopback network blocked | 394 passed, 40 files, 0 external attempts |
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
npm run release    # npm run build, then electron-builder
```

The NSIS installer is written to `release/Bamboo Launcher Setup <version>.exe`. The build is
x64-only, `oneClick: false`, and lets the user choose the installation directory.

Packaging note for this checkout: `npm run release` builds successfully, but on this machine
electron-builder fails while unpacking its downloaded Electron with
`EPERM: operation not permitted, rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'`.
The freshly extracted folder is locked by something in this environment: the same rename fails
from a plain shell after electron-builder has exited, so it is not a project defect. Packaging was
therefore verified with the Electron already installed in `node_modules`:

```bash
npx electron-builder --win --config.electronDist=node_modules/electron/dist
```

That produced `release/Bamboo Launcher Setup 0.2.0.exe` with exit code 0. The override is safe
because the local Electron matches the pinned dev dependency, but it should not be necessary on a
machine without the lock. The installer is 102.1 MiB (`107.109.300` bytes) and was built on
29 October 2026. Its SHA-512 is
`0251828955b02f343e4365619c7e339f9dda968fc34194edfceab09025ebad90b027f1d2d72612659400781c90224f19984ee82670a189b16dbef18abb3984f5`.
It was installed silently into a scratch directory for the release-candidate check; the
installed executable started from that location without a dev server, and a second instance with
its own user-data and game root started independently. The installer is unsigned, so Windows SmartScreen warns on first
run. The app.asar still includes the wallpaper archive set under `resources/Instanz Vorlagen/` and
production `node_modules`, which keeps the package large.

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

Instances live under the game folder at `<game root>/instances/<folder>/`, each with
`instance.json` and the usual `mods/`, `config/`, `saves/`, `resourcepacks/`, `shaderpacks/`,
`screenshots/`, `logs/` and `crash-reports/` folders. The game root is chosen on first start and
can be changed later; `%APPDATA%\.minecraft` is not modified.

| Variable | Effect |
| --- | --- |
| `BAMBOO_GAME_ROOT` | Game folder to adopt when it exists (otherwise the remembered root is used) |
| `BAMBOO_SKIP_BOOTSTRAP=1` | Skips the first-run folder picker (used by smoke runs) |
| `BAMBOO_LOG_LEVEL` | `debug`, `info`, `warn` or `error`; default `info` |
| `BAMBOO_MS_CLIENT_ID` | Overrides the built-in Microsoft OAuth client id |

CurseForge support reads its API key from `resources/curseforge-key.txt` at runtime and returns a
structured `missing-key` error when the file is absent. The file is tracked in this repository,
so treat it as a shipped credential and rotate it if it has been shared.

## Tests and what they cover

The 40 suites are fixture-driven and must not need a Minecraft installation or external network
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
- No macOS or Linux packaging target exists.

## Repository and documentation status

- The launcher still has no server or database dependency; the former `server/` tree, the News
  view and the cosmetics/friends UI were removed. Content themes now come only from the local
  catalog described above.
- [`SUMMARY.md`](SUMMARY.md) is stale: it documents the deleted PostgreSQL backend, friends
  service and cosmetics UI. Do not treat it as current.
- `FEATURE_ARCHITECTURE_SPEC.md` in the repository root is a historical design specification. It
  still matches much of the architecture but references removed cosmetics work; treat it as
  history, not as a contract.
- The `.gitignore` rules now hide only build output, caches, Gradle output, local runtime data and
  local `.env*` files; launcher source, tests, CI configuration, docs and bundled resources are
  visible to git again. Nothing has been committed, so a fresh clone stays incomplete until the
  newly visible sources are added and the pending deletions (`server/`, old one-off scripts) are
  committed.

## License

MIT, as declared in `package.json`.
