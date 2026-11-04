# Real-Electron auth harness

Proves the Microsoft login path in the shipped runtime (Electron 30, real
`main.js`, real `preload.js`, real core, real `safeStorage`/DPAPI), on Windows.

```bash
node scripts/e2e-auth/run.cjs
```

It runs **ten real Electron processes**:

1. `earliest` — clicks "Mit Microsoft anmelden" the moment the bundled page's
   DOM is ready, before React has mounted, and proves the click reaches a
   registered handler. It also records that all five `bamboo:auth:*` handlers
   were registered before the `BrowserWindow` existed.
2. `login` — a complete sign-in through the actual loopback redirect, then an
   inspection of the bytes on disk.
3. `restore` — a fresh process on the same user data dir with an **already
   expired** access token, so the session can only come back by refreshing.
4. `expiry` — signs in with a one-second token, waits for it to die, then asks
   the real launch path (`core.getLaunchIdentity`, the same call the launch
   service makes) for a token and proves the refreshed one is handed out.
5. `rejected` — the token endpoint answers `invalid_grant` on refresh: the
   account and its tokens are removed, the status and UI are signed out, no
   retry happens, and a fresh sign-in works.
6. `login` + 7. `offline` — a stored session started while every request fails:
   the user stays signed in with the stale token flagged, the account and
   encrypted tokens are untouched, no browser is opened, and the rendered
   Konto tab shows the stored account with its refresh/sign-out actions.
8. `unavailable` — a core that genuinely fails to initialize (the real
   `main.js` catches the rejection, so the window opens with no
   `bamboo:auth:*` handler at all). The rendered Konto tab must show the
   single "Microsoft-Anmeldung nicht verfügbar" card, no sign-in button, and
   **no** `No handler registered` / `bamboo:auth` text anywhere in the DOM.
9. `login` + 10. `mid-session` — a stored session whose background restore is
   rejected as `invalid_grant` after the tab already read it. The tab first
   renders signed in, then main pushes the new status
   (`bamboo:auth:changed`) and the open tab flips to signed out without a
   reload, without a contradictory "Kein Microsoft-Konto angemeldet" error.

Every state above records the rendered `document.body.innerText` in its
report (`report-<run>-<mode>.json`), and the driver prints the Konto readouts
in its summary. These are DOM observations, not unit tests of the predicate.

The matching regression test lives in `tests/startup-order.test.cjs` and runs
with `npm run test:core`: it boots the real `main.js` with a fake `electron`
module and fails if any auth handler is registered after the window.

Afterwards the driver scans every file under the user data dir for every token
the stub issued, independently of Electron.

## What is doubled, and why that cannot ship

Two things a local run cannot own are replaced **only inside the harness
process**:

| Double | Where it lives | Production impact |
| --- | --- | --- |
| `globalThis.fetch` for five Microsoft/Xbox/Minecraft URLs | `main.cjs`, set before the app starts | none: the shipped app has no such override, no env switch, and never imports `scripts/` |
| `shell.openExternal` | `main.cjs` | none: it records the authorize URL and plays the browser; the real app hands the URL to the OS |

Everything else is the real thing: the real OAuth/PKCE builder, the real
loopback listener on port 3377, the real token chain, the real account store
and `safeStorage` encryption, the real IPC handlers, and the real renderer
loaded from `dist/index.html`.

The stub identity provider never receives a real credential, and the harness
never reaches Microsoft. It cannot turn a failing production path into a pass:
the code under test is unchanged.

## What it checks

- Startup: every `bamboo:auth:*` handler exists before the window, and a
  sign-in at `dom-ready` completes instead of hitting an unregistered handler.
- Expiry: the launch path refreshes an expired access token before handing one
  to the game; an `invalid_grant` signs out once with no retry; an unreachable
  Microsoft keeps the stored session and its encrypted tokens.
- Konto tab (rendered DOM): auth-unavailable card with no raw handler error,
  signed-in card for an offline start, and a live sign-out transition pushed
  from main mid-session.
- Avatars: only `https:` URLs reach the UI (unit-tested), other values fall back
  to the generated profile avatar.
- Authorize URL: consumers authority, `redirect_uri=http://localhost:3377`,
  `response_type=code`, 43-char PKCE `S256` challenge, 32-hex state, Xbox Live
  + `offline_access` scope; the token exchange repeats the redirect URI and
  sends the verifier.
- The loopback listener answers the redirect with HTTP 200 and is **closed**
  (connection refused) once the attempt settles.
- `accounts.tokens.json` contains `v10`-prefixed ciphertext only; `safeStorage.decryptString`
  round-trips it in the same process, and neither token appears as plaintext in
  the file or anywhere else under the user data dir.
- `accounts.json` has metadata only (no `accessToken`/`refreshToken`).
- Restart: no browser opened, `authStatus` signed in, `grant_type=refresh_token`
  with the stored refresh token, fresh (non-expired) token, rewritten ciphertext,
  and the real TopBar shows the account.
- Bridge: exactly `authStatus`, `authLogin`, `authCancel`, `authRefresh`,
  `authSignOut` plus the `onAuthStatus` push subscription; no legacy login
  channel; renderer has no `require`/`process`/
  `module`; status and `getPlayerIdentity` carry no token key.

Results land in `.e2e-auth/report-login.json`, `.e2e-auth/report-restore.json`
and the two `secrets-*.json` files (fake tokens, used by the disk scan only).
The directory is git-ignored.

## What it cannot prove

The **real** Azure app registration behind the client id. This harness never
contacts Microsoft, so it cannot show that
`d5b2e079-2c2c-4ade-9dab-1c1eb204162a` (or `BAMBOO_MS_CLIENT_ID`) is a public
client that allows `http://localhost:3377`, nor that real consent, real XSTS
and a real Minecraft profile succeed. That requires a registered client and a
human signing in with a Microsoft account that owns Java Edition. Everything
up to and including "hand the authorize URL to the browser" is exercised here;
the round trip with Microsoft itself is the remaining manual step.
