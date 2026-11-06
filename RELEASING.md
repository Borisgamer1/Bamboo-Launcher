# Releasing Bamboo Launcher

The launcher updates itself from GitHub Releases. The public release repository is
`Borisgamer1/Bamboo-Launcher` (configured in `package.json` under `build.publish`). It must stay
public: `electron-updater` reads `latest.yml` and the installer without embedding a GitHub token.

## The one rule

The updater asks GitHub for the **newest published release** and then downloads `latest.yml` from
that release. A release that contains only the installer is dead as an update channel — every
installed launcher reports "Update-Prüfung fehlgeschlagen" and nobody can tell why.Every release must therefore carry the Windows updater set, plus the macOS and Linux sets for those
platforms:

- Windows: `Bamboo-Launcher-Setup-<version>.exe`, its `.blockmap`, `latest.yml`
- macOS: `Bamboo-Launcher-<version>-universal.dmg`, `Bamboo-Launcher-<version>-universal.zip`,
  `latest-mac.yml`
- Linux: `Bamboo-Launcher-<version>-<arch>.AppImage`, `Bamboo-Launcher-<version>-<arch>.deb`,
  `latest-linux.yml`

It must be **published**, not a draft and not a pre-release (`/releases/latest` skips both). v0.2.1
shipped with the installer alone, so no installed copy of it can discover anything; v0.2.2 fixes
the channel for everyone because the updater reads the newest release, not its own.

`electron-updater` on macOS only installs signed updates. The CI build is unsigned, so macOS users
have to install new versions by hand until signing and notarization are configured.

## One-time step for 0.2.0 installations

0.2.0 was built before the updater existed, so it cannot discover 0.2.1 by itself. Install 0.2.1
(or newer) once over the existing installation. The NSIS installer uses the same `appId`, so
settings, accounts, instances and worlds stay in place.

## Release checklist

1. Set the new version in `package.json`. The renderer reads it through Vite, `electron-builder`
   names the artifacts from it, and the release workflow compares it with the tag. Also update the
   `LAUNCHER_VERSION` constant in `electron/launch/args.ts`; it is embedded in Minecraft launch
   metadata and is intentionally not read from `app.getVersion()` because the core also runs in
   tests without Electron. `tests/release-feed.test.cjs` fails when the two disagree.
2. Write the entry for that version in `CHANGELOG.md` (both languages — the in-app "what's new"
   dialog reads the file, and `tests/onboarding.test.cjs` fails without it).
3. Run the gates locally:

   ```bash
   npm run lint
   npm run test:offline
   npm run build
   ```

4. Either publish from the tag (preferred, no manual asset handling):

   ```bash
   git tag -a v0.2.3 -m "Bamboo Launcher 0.2.3"
   git push origin v0.2.3
   ```

   The `release` workflow verifies that the tag and `package.json` match, runs lint and the offline
   core suite, then builds Windows, macOS and Linux in parallel. A single publish job waits for all
   three, uploads every asset into one GitHub release and runs
   `node scripts/check-update-feed.cjs --remote`. A release that cannot update anyone turns the
   workflow red instead of shipping silently. `workflow_dispatch` builds without publishing.

   `latest.yml` is what makes the Windows installer findable for every running copy, and the
   `.blockmap` only enables the delta download: without it the update still works, it just
   downloads the full installer instead of the changed blocks. `latest-mac.yml` and
   `latest-linux.yml` do the same for those platforms.

   Or build and publish the Windows release from this machine:

   ```bash
   npm run release           # installer + latest.yml into release/, verified locally
   npm run release:publish   # same, then uploads to GitHub and verifies the published feed
   ```

## Checking an update channel

```bash
npm run check:release        # are the local artifacts complete?
npm run verify:update-feed   # does the newest published release carry everything?
```

`verify:update-feed` exits non-zero and names what is missing when the feed is broken. Run it after
any manual release creation — especially if assets were uploaded through the GitHub UI, where it is
easy to drag only the `.exe`.

## CurseForge key

The key ships inside the installer and is not part of the repository. Store it as the repository
secret `CURSEFORGE_API_KEY`; the workflow writes `resources/curseforge-key.txt` before packaging
and fails the release when the secret is missing. A local `npm run release` reads the same file
from your working copy, so keep it there and never commit it.

## Publishing from a different repository

If the workflow does not run in `Borisgamer1/Bamboo-Launcher`, create a fine-grained GitHub token
with `Contents: Read and write` for that public repository and store it as the repository secret
`GH_RELEASES_TOKEN`. The workflow falls back to `GITHUB_TOKEN` when it runs in the release
repository itself. Do not put this token in the app: only the build machine needs it.

## Verifying an update

1. Install 0.2.1 (or newer), then publish the new version with the installer and `latest.yml`.
2. Start the launcher and wait for the first check (15 seconds) or use **Einstellungen → Über →
   Updates → Prüfen**.
3. The status changes to downloading, then a restart dialog appears. Restart and verify that the
   footer and About page show the new version.

The check runs every six hours while the launcher is open. Downloads happen in the background and
are installed on quit even if the restart prompt is dismissed.
