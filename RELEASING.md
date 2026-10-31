# Releasing Bamboo Launcher

The launcher updates itself from GitHub Releases. The public release repository is
`Borisgamer1/Bamboo-Launcher` (configured in `package.json` under `build.publish`). It must stay
public: `electron-updater` reads `latest.yml` and the installer without embedding a GitHub token.

## One-time step for 0.2.0 installations

0.2.0 was built before the updater existed, so it cannot discover 0.2.1 by itself. Install 0.2.1
once over the existing installation. The NSIS installer uses the same `appId`, so settings,
accounts, instances and worlds stay in place. Every release from 0.2.1 onward can update itself.

## Release checklist

1. Set the new version in `package.json`. The renderer reads it through Vite, `electron-builder`
   names the artifacts from it, and the release workflow compares it with the tag. Also update the
   `LAUNCHER_VERSION` constant in `electron/launch/args.ts`; it is embedded in Minecraft launch
   metadata and is intentionally not read from `app.getVersion()` because the core also runs in
   tests without Electron.
2. Run the gates locally:

   ```bash
   npm run lint
   npm run test:offline
   npm run build
   ```

3. Commit the version bump and push it.
4. Create and push an annotated tag that exactly matches the version, for example `v0.2.2`:

   ```bash
   git tag -a v0.2.2 -m "Bamboo Launcher 0.2.2"
   git push origin v0.2.2
   ```

5. The `release` workflow verifies that the tag and `package.json` match, then builds and uploads:
   - `Bamboo-Launcher-Setup-<version>.exe`
   - `Bamboo-Launcher-Setup-<version>.exe.blockmap`
   - `latest.yml`

   The release must be published, not a draft or pre-release; the updater only reads the latest
   published release.

## Publishing from a different repository

If the workflow does not run in `Borisgamer1/Bamboo-Launcher`, create a fine-grained GitHub token
with `Contents: Read and write` for that public repository and store it as the repository secret
`GH_RELEASES_TOKEN`. The workflow falls back to `GITHUB_TOKEN` when it runs in the release
repository itself. Do not put this token in the app: only the build machine needs it.

## Verifying an update

1. Install 0.2.1, then publish 0.2.2.
2. Start 0.2.1 and wait for the first check (15 seconds) or use **Einstellungen → Über → Updates →
   Prüfen**.
3. The status changes to downloading, then a restart dialog appears. Restart and verify that the
   footer and About page show 0.2.2.

The check runs every six hours while the launcher is open. Downloads happen in the background and
are installed on quit even if the restart prompt is dismissed.