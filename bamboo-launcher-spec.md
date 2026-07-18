# Bamboo Launcher — Project Specification

> Status: **Pre-v1.0** — current focus is **Cosmetics System** (logging achievement unlocks) followed by **polish & cleanup** in preparation for the **first public release**.  
> Document generated from a 3-round interview. All decisions reflect the direction stated by the project owner. Underspecified areas are listed in §13 (open questions) and must be resolved before implementation work begins.

---

## 1. Vision & Goals

### 1.1 Purpose
A community-driven **Minecraft launcher** built for players who care about modpacks, cosmetics, and friends — not just a vanilla launcher. Targets the German modding community first (DE-primary localization), with English secondary.

### 1.2 Differentiator
Free, **achievement-driven cosmetics** (capes, auras, hats/ears, ranks) that users unlock by actually playing/using the launcher — no shop, no premium currency. Combined with discoverable modpacks (Modrinth + CurseForge), profile sharing, and a friend/social layer.

### 1.3 Active Milestone
1. **In flight:** Cosmetics System (with achievement unlock plumbing).
2. **Next:** Polish, refactor, packaging → first public release (v1.0).
3. **Cross-platform** (Linux/macOS) is a later milestone; not in scope for v1.0.

### 1.4 Localization
DE-primary. EN-secondary. Continue with the current `src/lib/translations.ts` mirror structure. Do not migrate to `react-i18next` for v1.0.

---

## 2. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│            Bamboo Launcher (Electron, Windows)               │
│ • React 19 + Vite 8 + Tailwind 4 + Framer Motion             │
│ • Renderer → preload.js → main.js IPC                         │
│ • MCLC v3 (Vanilla / Fabric / Forge / NeoForge launcher)      │
│ • GitHub Releases → auto-update of launcher binary            │
└────────────┬──────────────────────────────────┬──────────────┘
             │ HTTPS REST (JSON)                 │
             ▼                                   ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│  Bamboo Backend (NEW)    │         │  GitHub (source + bin)   │
│  Express REST API        │         │  • Release artifacts     │
│  Self-hosted             │         │  • Source code mirror    │
│  Single source of truth  │         │  • NOT for content CDN   │
└────────────┬─────────────┘         └──────────────────────────┘
             │
             ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│  PostgreSQL (NEW target) │    │  C:\BambooContent\ (NEW)     │
│  • users                 │    │  • cosmetische Bilder        │
│  • cosmetics metadata    │    │  • Models / Texturen         │
│  • rank / entitlements   │    │  • Banners / News-Bilder     │
│  • launcher version log  │    │  • Launcher-Assets / Themes  │
│  • friends relations     │    │  • Filenames correlate with  │
│  • news, events, …       │    │    Postgres metadata paths   │
└──────────────────────────┘    └──────────────────────────────┘
```

### 2.1 Hard Rules (round 3 confirmation)
- The Launcher **never** writes to PostgreSQL directly. It goes through the Bamboo Backend REST API.
- PostgreSQL is the **single source of truth** for all dynamic/admin state.
- GitHub **is not a database** and **does not store user data, cosmetics, news, or runtime data**. It hosts source code and release artifacts only.
- `C:\BambooContent\` holds **only file bytes** (PNG, GLB, etc.). Postgres stores metadata + path references.

### 2.2 Existing Stacks to Migrate / Replace
- **Existing friends backend** (`server/src/index.js`, Express + WebSocket on `localhost:3400`/`3401`, JSON flat-files in `server/data/`) — **deprecated**. Functionality moves into the new Bamboo Backend.
- **Existing friends client** (`src/friends/*`, talks to `localhost:3400`/`3401`) — refactor to talk to the new Bamboo Backend REST API.
- **Existing friends data** (`C:\BambooLaufwerk\friends\store.json`) — one-time migration script to import into Postgres `users` + `friend_relations` tables. Open question §13.
- **Existing local Cosmetic / Friend / News fallback** (none exists yet — to be created).

### 2.3 What Stays the Same
- Electron 31 + Vite 8 + React 19 + Tailwind 4 + Framer Motion + Lucide.
- MCLC v3 game launching pipeline (Fabric/Forge/NeoForge/Vanilla + Java auto-detection + `quickPlay`-based server-join).
- 8-theme system (with planned CSS-variable refactor — see §11).
- Mod browser (Modrinth + CurseForge) wired through IPC.
- Profile export/import (`.bamboo`, `.mrpack`, raw `.zip`).
- Microsoft device-code login (to be linked against Bamboo Backend users).
- Window/UI invariants (frameless, custom titlebar, persist window state).

---

## 3. Cosmetic System (v1.0 scope)

### 3.1 Cosmetic types
Per Round 2:
| Type     | Examples                          | Asset formats           |
|----------|-----------------------------------|-------------------------|
| Cape     | Feathered wings, dragon wing      | PNG (transparent cape skin) |
| Aura     | Trailing fire, halo, particle ring| PNG sprite sequence or Lottie JSON |
| Hat/Ear  | Cat ears, duck crown, top hat     | PNG (worn on model)     |
| Rank     | Title badge / accent             | PNG + accent colour override |

### 3.2 Display medium (per Round 3)
- **In-Launcher:** `CosmeticsView` tab renders a **3D Player Model preview** outfitted with the user's currently-equipped cosmetics (cape swinging, hat/hair bounce, aura particle loop). Choice of model format (GLB / Blockbench JSON / raw OBJ) is open §13.
- **In-Game:** User is **undecided** between
  - the existing **Bamboo Mod** (currently a tiny Fabric mod for MC 26.x only — `ensureBambooClientMod()` in `main.js`) — would need expansion to other loaders / versions.
  - a **third-party mod** like "Custom Skin Render" or OptiFine/Iris-compatible cape rendering — zero integration.
  Recommend spec'ing a **`bamboo-cosmetics-mod`**. Maintain a separate Modrinth project page flag for compatibility. **Decision block** in §13.

### 3.3 Unlock mechanics
- All cosmetics are **free** (no shop, no premium currency).
- Unlocked via the **achievement system** — see §6.

### 3.4 Metadata (planned Postgres shape)
```
cosmetics (
  id            uuid PK,
  slug          text unique,           -- e.g. 'duck_crown'
  name          text,                  -- display name
  type          enum (cape|auras|hat|ear|rank),
  rarity        enum (common|rare|epic|legendary),
  bamboo_content_path text,            -- e.g. 'cosmetics/duck_crown/'
  unlock_id     uuid FK -> achievements,
  preview_url   text,
  is_active     bool default true,
  created_at    timestamptz,
  updated_at    timestamptz
)
cosmetic_unlocks (
  user_id       uuid,
  cosmetic_id   uuid,
  unlocked_at   timestamptz,
  PK (user_id, cosmetic_id)
)
```

### 3.5 Asset Loading
- Launcher reads **both** Postgres metadata (for what exists + unlock status) and `C:\BambooContent\` (for actual PNG/GLB files).
- Resolution path: `C:\BambooContent\<bamboo_content_path>\<file>.png`.
- **Distribution mechanism of `BambooContent\` itself is open §13.**

---

## 4. Bamboo Backend (Express REST API)

### 4.1 Why a separate backend
The owner explicitly stated: *"Das Backend kommuniziert ausschließlich mit PostgreSQL."* This separates the Launcher (client) from the schema, enables shared state across many user installs, and centralises business logic.

### 4.2 Deployment model
- **Self-hosted** (per Round 2).
- Hosting target open §13 — likely Docker on a Linux VPS; same host as Postgres for simple ops, separate host for prod reliability.

### 4.3 Authentication
- JWT-based, 30-day expiry (current pattern in `server/src/index.js`).
- bcrypt password hashes.
- Microsoft linking as **secondary** identity (device-code flow exists, to be wired through this backend).
- Refresh-token story: open §13.

### 4.4 REST Endpoints (skeleton)

| Route                                  | Verb   | Notes                                  |
|----------------------------------------|--------|----------------------------------------|
| `/health`                              | GET    | Reused                                 |
| `/auth/register`                       | POST   | Username + password                    |
| `/auth/login`                          | POST   | Returns JWT + sanitised user           |
| `/users/search`                        | GET    | q= param                                |
| `/users/{id}`                          | GET    | Privacy-aware                          |
| `/profile/me`                          | GET    | Self fetch                             |
| `/profile/me`                          | PUT    | Self update                             |
| `/friends/request`                     | POST   |                                        |
| `/friends/accept`                      | POST   | Triggers `friends_accept` WS broadcast |
| `/friends/decline`                     | POST   |                                        |
| `/friends/block`                       | POST   |                                        |
| `/friends/remove`                      | POST   |                                        |
| `/friends`                             | GET    | List                                   |
| `/friends/requests`                    | GET    | Pending                                |
| `/friends/suggestions`                 | GET    |                                        |
| `/cosmetics`                           | GET    | All catalogue (limited fields)         |
| `/cosmetics/{id}`                      | GET    | Full metadata                          |
| `/cosmetics/equipped`                  | GET    | Current user equipped set              |
| `/cosmetics/equip`                     | POST   | `{ cosmetic_id }`                      |
| `/achievements`                        | GET    | Catalogue                              |
| `/achievements/unlock`                 | POST   | Body: `{ event }` — server validates    |
| `/news`                                | GET    | Banner / news feed                     |
| `/redeem`                              | POST   | Redeem code                            |
| `/version/current`                     | GET    | Latest launcher app version             |
| `/version/migrate`                     | POST   | Server-driven data migrations          |
| `/`                                    | WS     | Friends status / notifications         |
| `/admin/*`                             | various| Admin Panel API (see §13)              |

WebSocket server binding (single port or split under `:3401`) — open §13.

### 4.5 Existing code to replace
- Drop the entire `server/src/index.js` REST & WebSocket bodies (CSV-flat-file persistence).
- Move the same Routes into a new repo/package (`bamboo-backend`) using Express + `ws` + a `pg` (Postgres) driver or `Prisma`. Open §13 on the orm-vs-sql choice.

---

## 5. Database (PostgreSQL Schema)

### 5.1 Domain model (post-Round 3 confirmation)

| Table                | Purpose                                                 | Relationships                                         |
|----------------------|---------------------------------------------------------|-------------------------------------------------------|
| `users`              | Auth + profile (displayName, avatar, banner, bio)       | 1:1 → `privacy_settings`, 1:N → `cosmetic_unlocks`, `friend_relations_out`, `playtime`, `redeem_history` |
| `privacy_settings`   | Per-user privacy (auto-created default)                 | 1:1 → `users`                                          |
| `roles`              | Admin / user / future custom roles                      |                                                       |
| `permissions`        | Role-permission matrix                                 | M:N → `roles`                                          |
| `friends_relations`  | Edge list: from_user_id ↔ to_user_id, accepted          | 2 edges per pair (bidirectional query)                |
| `friends_requests`   | Pending friend requests (from, to, ts)                  |                                                       |
| `blocked_users`      | One-way block list                                     |                                                       |
| `cosmetics`          | Catalogue metadata (§3.4)                              | 1:N → `cosmetic_unlocks`                              |
| `cosmetic_unlocks`   | M:N users ↔ cosmetics                                 |                                                       |
| `achievements`       | Catalogue — `id`, `slug`, `name`, `description`, `points`, `reward_cosmetic_id` | 1:N → `achievement_unlocks` |
| `achievement_unlocks`| M:N users ↔ achievements                              |                                                       |
| `news`               | Banner feed (`title`, `body`, `image_url`, `category`) |                                                       |
| `events`             | One-off calendar events (`name`, `starts_at`, `ends_at`) | optional FK `reward_cosmetic_id` → `cosmetics` |
| `redeem_codes`       | `code`, `value`, `max_uses`, `expires_at`, `reward_cosmetic_id` | |
| `redeem_history`     | Audit log of code usage                               |                                                       |
| `launcher_settings`  | Per-user JSONB (mcOptions, theme, lang, RAM)            |                                                       |
| `logs`               | Launcher-emitted events (crash, perf, install errors)   |                                                       |
| `version_history`    | Launcher release records (`version`, `release_notes`, `min_app_version_required`) | drives auto-update |
| `playtime` (future)  | Per-instance playtime, daily totals                     |                                                       |

### 5.2 Schema-versioning strategy
- `version_history` doubles as a **migration manifest**. On launcher startup: POST `/version/migrate` with current app version → server returns required migrations or schema-compat checks. If server says current app version is too old → Launcher prompts update (driven by GitHub Releases — §7).

---

## 6. Achievement / Unlock Flow

### 6.1 Trigger detection in Launcher
Detector fire-and-call to Backend on:
| Event                | Achievement(s) unlocked                              |
|----------------------|------------------------------------------------------|
| Account created      | `welcome_cap`, `first_steps`                         |
| Profile upload       | `self_expressionist`                                  |
| First instance created | `first_pack`                                         |
| X hours played (computed locally) | `playtime_bronze/silver/gold` |
| First mod installed  | `modder_novice`                                       |
| First fabric/forge/neoforge mod | `chooser_of_paths`                       |
| 10 mods in one instance | `customizer`                                       |
| Server joined        | `connection_made`                                     |
| Friend request sent  | `social_butterfly_starter`                            |
| Friend request accepted (inc + out) | `social_butterfly`                        |
| 10/25/100 friends    | `circle_of_friends` tier                              |
| Theme switched       | `aesthetic_explorer`                                  |
| Used Bamboo for 7 | 30 | 365 days | `devoted` tier                          |

(Initial list — owner can edit/add categories. Catalogue stored as seed JSON loaded into Postgres via Admin Panel.)

### 6.2 REST flow (per Round 3)
```
Launcher detects event.E
   │
   │ POST /achievements/unlock  { event_code: E, instance_id: i, metadata: {...} }
   ▼
Bamboo Backend validates
   ├─ eligible? → insert achievement_unlocks + cosmetic_unlocks + log + notify
   │                                                          │
   │                                                          │ WebSocket ──► Launcher.A (animated unlock modal)
   │                                                          │         ──► Friends (status update)
   ▼
Response { achievements_unlocked: [...], cosmetics_unlocked: [...] }
   │
   ▼
Launcher animates unlock in CosmeticsView
   ↓ shows "new!" tag, equips default if none equipped
```

### 6.3 Direct REST (per Round 3 answer "Push events to REST API"). No WebSocket dependency for the push step itself. WS used only for fanout.

### 6.4 Offline / disconnect handling
Open §13 — recommend: pending queue in local sqlite + flush on reconnect.

---

## 7. Launcher Auto-Update (GitHub Releases)

### 7.1 Mechanism
- On Launcher startup (after successful Backend health-check), call `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`.
- Compare `tag_name` (e.g. `v0.2.0`) with the locally running version (currently `0.1.0` in `package.json`).
- If newer:
  - Surface a non-blocking "Update available — restart later?" toast.
  - Optional auto-download `assets[0].browser_download_url` (Windows: `…-Setup-…exe`).
- Integrity verification — open §13 (recommend GitHub's HTTPS + a server-returned SHA-256 sidecar or pinned release tag pattern).

### 7.2 Version metadata
- After successful install/updgrade, Launcher reports via `POST /version/migrate` (or `/logs`):
  - `app_version`, `os_version`, `arch`, `fingerprint` (random UUID stored in `app.getPath('userData')`).
- Server can issue back: "you must update to >= v0.2.0 to keep using Cosmetics" → Launcher forces update.

### 7.3 GitHub repository split (spec only)
Assume two repos:
1. **Bamboo-Launcher** — Electron source code + Launched GitHub Releases.
2. **Bamboo-Launcher-Docs** (separate, optional) — installer guide, troubleshooting.

Open §13: single vs multi-repo + monorepo considerations.

---

## 8. Cross-Platform Path Abstraction (pre-release refactor)

All `C:\BambooLaufwerk\…` and `C:\BambooContent\…` literals must move to `app.getPath('userData')` so a future Linux/macOS port doesn't require path surgery.

| Old literal                              | New semantics                          |
|------------------------------------------|---------------------------------------|
| `C:\BambooLaufwerk`                      | `path.join(app.getPath('userData'), 'BambooLaufwerk')` |
| `C:\BambooLaufwerk\profiles\{folderName}` | same w/ subfolder                      |
| `C:\BambooLaufwerk\settings.json`        | same w/ filename                       |
| `C:\BambooLaufwerk\friends\`             | deprecated (migrate to Postgres)      |
| `C:\BambooLaufwerk\profiles\{name}\saves\` | same                                       |
| `C:\BambooContent\`                      | OS-portable constant via env or user setting (open §13) |

---

## 9. Localization (mirror for v1.0)

- Keep `src/lib/translations.ts` structure.
- All UI strings in German by default.
- All error/info toasts must run through `t.<key> || '...'` so both languages are covered.
- Cosmetic description fields stored in db should accept both `name_de` and `name_en` (open §13 on catalog format).
- For v1.0, **no third language**.

---

## 10. Cosmetic View UI (in-Launcher 3D preview)

### 10.1 Required interactions
- Render an animated Steve / Alex model (or the user's actual skin if linked to a Microsoft account).
- Apply currently-equipped **cape** (visible on back), **hat/ear** (on head), **rank badge** (overlay), **aura** (looping particle effect around feet).
- Hot-swap any slot from a drawer — `lock`-style preview that updates in real time.
- Show stats: total cosmetics owned, % completion, next achievement preview.

### 10.2 Architecture
- 3D preview should be **sandboxed** (no read of system paths outside BambooContent).
- Choice of three.js / react-three-fiber — open §13.

### 10.3 Empty state
- Currently placeholder ("Coming Soon"). Replace with an "Unlock your first cosmetic" CTA driven by `achievement_unlocks` join against `users`.

---

## 11. Polish & Cleanup (pre-release checklist)

### 11.1 Theme refactor (high priority)
The 8 themes currently require a `switch (theme)` block in **7+ components** (`Sidebar`, `TopBar`, `Dashboard`, `ModsView`, `SettingsView`, `ParticleBackground`, `App.tsx`). Refactor to:
- CSS custom properties set on `:root` (already done partially via `--theme-accent`, etc.).
- Tailwind named tokens per theme in a single source of truth (`src/theme/tokens.ts`), looked up by id.
- All `getThemeStyles()` switch-case functions collapse into one helper.
- Particle configs live in a single data table (no per-Theme `if` chains).

### 11.2 IPC handler cleanup
`main.js` accumulated many stale/unused handlers (`detectLanServer`, `getActiveLaunches`, etc.) — audit, keep only handlers referenced in `preload.js`. Add a **lint-style check** that flags orphaned `ipcMain.on/handle` keys.

### 11.3 Hard-coded secrets
- `server/src/index.js` line 13: `JWT_SECRET || 'bamboo-friends-dev-secret-2026'` — must move to env var with **no default in production**.
- `main.js`: hardcoded CurseForge API key (`'$2a$10$…'`) — move to env var with monthly rotation reminder comment.
- `main.js`: hardcoded Discord `largeImageKey: 'bamboo'` + deep-link protocol `bamboo-launcher://` — extract to a `constants.ts`.

### 11.4 Error handling
Many `catch {}` blocks silently swallow errors (e.g. instance loading, settings load). Replace with **structured toast logging** via a shared `Logger` (UI-tied) + `console.error`.

### 11.5 Crash / telemetry
- Open §13. Recommend opt-in, off-by-default, IP-anonymised, sent to a tiny `/logs` endpoint, with an explicit "Delete my data" button in Settings.

### 11.6 CI/CD (open §13)
- Single GitHub Action: run `pnpm install`, `pnpm typecheck`, `pnpm lint`, build artifacts.
- On tag, run electron-builder, upload to GitHub Releases.
- `pnpm version` should mirror `package.json` `version` automatically.

### 11.7 README + onboarding
- Replace current English README placeholder (`React + TypeScript + Vite` template) with project README.
- Include: screenshots, install steps, dev-port (5173 + 3400/3401), build commands.

### 11.8 Cosmetics view polish (in-flight)
- Live preview, equip/unequip, achievement popups.
- Empty states for unowned cosmetics.

### 11.9 Friends view polish (placeholder still)
- Friend list, search, request send/accept, profile pop-over with equipped cosmetics.
- Status (online/away/DND) + activity ("playing Sodium 1.21.4").
- Privacy controls.

### 11.10 SettingsView — Microsoft login is wired superficially
- The Microsoft device-code flow exists (`startMicrosoftLogin` → IPC `ms-device-code` events) but the actual MS OAuth exchange code in `main.js` is presumably missing or stubbed. Spec calls for **complete the MS code exchange + token storage + linking to Backend user**.

### 11.11 About / version page
- New section under Settings showing: app version, latest from `/version/current`, link to GitHub repo, link to "What's new" changelog.
- Check for updates button.

### 11.12 Installer refinements
- License agreement screen (currently NSIS oneClick=false + change install dir = good base).
- Add uninstall script that wipes `BambooLaufwerk/` **only when user picks at uninstall time**.
- Code-signing — open §13.

### 11.13 XSS sanitization on profile import
- The `import-profile` flow accepts `.bamboo` archive with `manifest.json` + `icon.png`. The `icon` field is sometimes an `<img src="data:...">` HTML string — currently injected via `dangerouslySetInnerHTML`-ish patterns in render. Add **HTML sanitation** for any user-controlled rich text. Already partly done in `ModsView` markdown renderer; extend to Profiles/Cosmetics.

---

## 12. Friends View (replacement for "Coming Soon")

### 12.1 Features
- Friend list with online/offline status, custom status message, currently-playing instance.
- Search/add friend (calls Backend REST + WebSocket).
- Pending requests list (incoming + outgoing).
- Block list + privacy settings (mapping to `privacy_settings` table).
- Profile pop-over: equipped cosmetics, banner, recent activity.
- **Activity feed** pulling from `logs` + WS updates (when friend plays an instance, you see it).

### 12.2 Migration scope
- **Replace** `server/src/index.js`'s JSON storage with Postgres.
- **Replace** the `src/friends/*` client-side singleton-store (currently file-backed via `window.electronAPI.getFriendsStore/saveFriendsStore`) with proper REST+WS client that hits Bamboo Backend.

### 12.3 Privacy alignment
- Per-user `privacy_settings` controls what other users see.
- Status visibility (`everyone | friends | nobody`).
- Who's allowed to send friend requests.
- Whether real-time activity is shown.

---

## 13. Open Questions / Decisions Needed

> These MUST be resolved before kicking off implementation. Some have a **recommendation**, some are pure ✅ decisions.

1. **Cosmetic in-game rendering** — pick the approach. Owner undecided.
   - ✅ Recommendation: spec a **bamboo-cosmetics-mod** as a Fabric mod (using Fabric API which is already familiar; existing Bamboo Mod seeds this) — publish on Modrinth with a unique `bamboo-cosmetics` slug. Cucumber-loaded cape/hat via the player model layer; aura via FlameLib or simple looping particle group.
   - Alternative: a thin CompatibilityLayer that feeds cape URL to OptiFine/Iris settings.
2. **BambooContent distribution** — how does asset bytes reach the user's `C:\BambooContent\` from the designer's repo?
   - ✅ Recommendation: Bamboo Backend can host a small `/content/…` endpoint that streams `BambooContent/` over HTTP, cached client-side. First-run downloads initial bundle; subsequent runs uses `If-Modified-Since`. Symlinks/backups: open.
   - Alternative: bundle with NSIS installer for v1 (smallest, but updates are heavy).
3. **Admin Panel** — where does it live, what's its scope?
   - ✅ Recommendation: separate **web app** (React/Vite) talking only to Bamboo Backend. Lives at `/admin/*` only when you have admin role. Provides: cosmetics CRUD, achievements CRUD, news composer, redeem codes, user management.
   - Alternative: separate Electron admin-only mode (one app, two routes).
4. **Backend hosting target** — Docker vs bare-metal, same host as DB vs separate?
   - ✅ Recommendation: Docker Compose on a Linux VPS (single compose file: `postgres`, `backend`, optional `caddy` for TLS).
5. **Migration of existing flat-file friends data** — one-shot script or fresh start?
   - ✅ Recommendation: provide **one-time migration script** in Bamboo Backend's repo that reads `server/data/*.json` and writes to Postgres.
6. **Achievement catalogue** — initial seed list of achievements and their rewards. (Sketch in §6.1.) Owner to review.
7. **BambooContent ↔ Postgres sync** — what happens if a file in BambooContent is deleted but Postgres still references it? UI must handle missing assets gracefully (placeholder image + flag).
8. **Cosmetic asset formats and 3D model rendering** — Blockbench JSON? glb? Three.js + react-three-fiber? cap PNG (64×32)?
   - ✅ Recommendation: 3D preview uses **react-three-fiber + a Steve-classic GLB**. Cosmetic PNG overlays applied as textures. Cosmetic 3D accessories attached as children of the relevant bone.
9. **Cosmetic name localisation (DE/EN)** fields.
10. **Refresh tokens** — JWT 30-day vs refresh-token rotation.
    - ✅ Recommendation: keep JWT; add `last_password_change_at` on `users` → tokens issued before that are invalid post-change.
11. **Crash reporting / telemetry** — opt-in? logs sent to backend? in-game crash overlay?
    - ✅ Recommendation: opt-in via Settings toggle; logs POST to `/logs`; one-click "Send crash report" button in crash UI.
12. **Auto-update integrity** — GitHub Releases asset vs signed hash stored in Postgres.
    - ✅ Recommendation: hash stored on Backend `/version/current` response, client verifies after download.
13. **Repository strategy** — single repo (Electron + Backend + Content?) vs separate (Bamboo-Launcher / Bamboo-Backend / Bamboo-Content).
    - ✅ Recommendation: **two repos** — `bamboo-launcher` (Electron + Releases) + `bamboo-backend` (Express + Postgres schema). BambooContent lives on the backend host (no repo).
14. **Code signing** self-signed vs EV certificate.
    - Open until v1 release.
15. **First-time user onboarding** tutorial — drive them from install → first cosmetic unlock.
    - ✅ Recommendation: 3-step modal on first start (welcome → pick theme → create instance).

---

## 14. Implementation Phases (suggested order)

| Phase | Scope                                                                              | Deliverable                                  |
|-------|------------------------------------------------------------------------------------|----------------------------------------------|
| **P1** | Cosmetics v1 (round 2 work)                                              | Cosmetic metadata CRUD; backend catalogue endpoint; cosmetic_unlocks table; achievement_unlocks table; CosmeticsView 3D preview empty-state; basic unlock REST. |
| **P2** | Achievement detection + REST plumbing                              | Detect events → POST → validate → unlock; small set of canonical achievements defined. |
| **P3** | Friends migration (flat-file → Postgres)                            | Drop `server/src/index.js` flat-file layer; new `bamboo-backend` Express + pg + ws; migration script. |
| **P4** | Refactor: theme tokens + IPC cleanup + path abstraction            | Single theme tokens source; `app.getPath('userData')` for all paths; audit IPC handlers. |
| **P5** | FriendsView full implementation                                     | Move `src/friends/*` client to REST+WS; render friend list, requests, presence, equipped cosmetics preview. |
| **P6** | Auto-update + version check (GitHub Releases + Backend gates)      | Version poll, redirect to GitHub Releases, optional enforcement via `/version/current`. |
| **P7** | Polish: README, About page, error toasts, logging, CI, build.       | Production-grade build; tested installer; basic lint + typecheck. |
| **P8** | Pre-release: code-signing + first-time onboarding + uninstall ergonomics. | Ready for first public release. |

---

## 15. Appendix — Existing Code Reference Map

| Concern                       | Files                                                                |
|-------------------------------|----------------------------------------------------------------------|
| Electron entrypoint           | `main.js`, `preload.js`                                              |
| Renderer bootstrap             | `src/main.tsx`, `src/App.tsx`                                        |
| Theme system                  | `src/components/Sidebar.tsx`, `TopBar.tsx`, `ParticleBackground.tsx`, `App.tsx`, `Dashboard`, `ModsView`, `SettingsView` |
| Routing (single TabState)      | `src/App.tsx` (no React Router)                                       |
| Settings persistence          | `main.js get-settings/save-settings` → `C:\BambooLaufwerk\settings.json` |
| Profile persistence           | `main.js get-profiles/save-profiles` → `C:\BambooLaufwerk\profiles.json` |
| MCLC launch pipeline           | `main.js:launchGame` IPC → `launcher.launch()`                     |
| Java detection              | `main.js:scanJavaCandidates`, `selectBestJavaForMcVersion`           |
| Mod installer (Fabric/Forge/Neo) | `main.js:installModloader`, `installForgeLoaderClean`, `installNeoforgeLoaderClean` |
| Modpack installer (.mrpack)  | `main.js:install-modpack-mrpack`                                     |
| Mod browser                 | `src/components/ModsView.tsx` (Modrinth direct + CurseForge proxied) |
| Servers pinging              | `main.js:ping-server` IPC → `https://api.mcsrvstat.us/3/`         |
| Microsoft device-code login   | `main.js` handlers + `preload.js:startMicrosoftLogin`, `onMsDeviceCode`, etc. |
| Deep link invites           | `main.js:buildInviteUrl`, `handleDeepLinkUrl` + `app.setAsDefaultProtocolClient('bamboo-launcher')` |
| Discord RPC                  | `src/discordRPC.js`, `main.js:updateDiscordPresence`                |
| Friends (old)                 | `server/src/index.js`, `src/friends/*` (deps in `src/friends/index.ts`) |
| Cosmetics (placeholder)       | `src/components/CosmeticsView.tsx`                                   |
| Theme particles (canvas)      | `src/components/ParticleBackground.tsx` (per-ThemeType)              |
| Translations                  | `src/lib/translations.ts` (en + de mirror)                           |
| Version metadata (caches)    | `src/lib/versionApi.ts:fetchVersionMap` (Mojang + Fabric + NeoForge + Forge) |
| Icon cache (eager-loaded)     | `preload.js` IPC `get-icons` → `C:\Bamboo Launcher\resources\SystemIcons\` |

### 15.1 Pre-existing constants (to move to env)
- `INVITE_PROTOCOL = 'bamboo-launcher'`
- `CURSEFORGE_API_KEY` (hardcoded, main.js)
- `JWT_SECRET = 'bamboo-friends-dev-secret-2026'` (server/src/index.js)
- `MAX_CONCURRENT_LAUNCHES = 4`
- `DISCORD_PRESENCE_DEFAULTS.largeImageKey = 'bamboo'`

### 15.2 Pre-existing assets paths
- Themes background images: `/images/bamboo_forest.png`, `cherry_blossom.png`, `frozen_ice.png`, `nether_amber.png`
- Logo: `./images/LauncherOnlyOutline.png`
- SystemIcons: `resources/SystemIcons/LauncherThin.png` + others

---

## 16. Glossary

- **Backend, Bamboo Backend**: New self-hosted Express REST API replacing the current JSON-file friends server.
- **BambooContent**: Local folder `C:\BambooContent\` containing cosmetic PNGs, models, banners, theme files. Not in any repo.
- **Cap**: cosmetic PNG (64×32) attached to player back, visible in cape slot.
- **Cucumper-loaded**: hypothetical in-game loader for cosmetic renders (placeholder term — see §13.1).
- **MCLC**: `minecraft-launcher-core` — NodeJS library driving MC installs and launches.
- **Modpack**: A curated set of mods + content for one Minecraft version/loader combo.
- **Render distance / Simulation distance / Quick Play**: vanilla MC options set in `options.txt` via `main.js:write-options-txt`.

---

*End of spec.*
