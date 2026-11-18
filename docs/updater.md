# In-app updater

Floq (Windows, NSIS) checks for a signed update, downloads it in the background and asks the user to restart.

## How it works

1. **Schedule** (`src/lib/updater.ts`, logic in `src/lib/updater-logic.ts`): first check 30 s after launch, then every 6 h (30 min retry after a failure). Packaged desktop builds only; dev builds never auto-check. Settings > Advanced > Updates has the current version, **Check for updates** (also works in dev) and **Update automatically** (default on, stored per device).
2. **Check + download**: `tauri-plugin-updater` fetches the feed, compares versions (it only accepts a version strictly newer than the running one, so there is no downgrade), downloads the installer and verifies its **minisign signature** against `plugins.updater.pubkey`. Progress is shown in Settings.
3. **Prompt**: a persistent toast "Floq X.Y.Z is ready" with **Restart now**, **Later** and a release-notes link. Restart = `install()` (passive NSIS installer: progress bar, no wizard; it closes Floq and restarts it) then `relaunch()` for other platforms. Agents keep running on the runtime server, so restarting the app does not interrupt them.
4. **Later** dismisses the toast. The downloaded bytes live in memory only, so the update is offered (and downloaded again) at the next launch or the next scheduled check. There is no install-on-quit.

Security: HTTPS endpoint on github.com only (Tauri rejects plain http in release builds), signature required, installer URL in the feed must be on github.com (the feed builder refuses anything else), the capability grants only `updater:allow-check/download/install` and `process:allow-restart`.

## Endpoint design

Releases are pre-releases created with `--latest=false`, so `releases/latest/download/latest.json` does not resolve. The feed lives on a fixed pre-release tagged **`updater`**:

`https://github.com/victorl1m/Floq/releases/download/updater/latest.json`

Each `vX.Y.Z` tag build uploads its installer to the `vX.Y.Z` release first, then replaces `latest.json` (`--clobber`) on `updater`, which points at the versioned installer URL. A guard (`scripts/updater/latest-json.mjs guard`) refuses to replace the feed with an older version (for example when an old tag is re-run). Chosen over a `{{target}}/{{current_version}}` scheme because that needs a server or one file per version; this needs nothing but GitHub. The repository must be public (or the assets reachable without a token), since the app downloads without credentials.

## One-time key setup (maintainer)

```
npx tauri signer generate -w ~/.tauri/floq.key
```

1. Put the **public** key (`floq.key.pub` contents) in `src-tauri/tauri.conf.json` > `plugins.updater.pubkey`, replacing `PUBKEY_PLACEHOLDER` (TODO: until then, update checks fail with "Updates are not configured in this build").
2. Add repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never commit the private key.
3. Without those secrets CI still builds; it just skips signing and publishes no `latest.json`.

## Shipping a release

Bump the version (`tauri.conf.json`, `Cargo.toml`, `package.json`), add `docs/releases/vX.Y.Z.md` (becomes the update notes), tag `vX.Y.Z` and push the tag. CI builds, SignPath signs (if configured), then **after** SignPath the final installer is signed with `tauri signer sign` (the `.sig` must cover the file users download), `latest.json` is built and published as above. The tag must equal the `tauri.conf.json` version or the feed step fails.

## Rotating keys

Installed apps only trust the pubkey baked into them, so a rotation needs a bridge release:

1. Generate the new pair. Release version N signed with the **old** key but containing the **new** pubkey in its config.
2. Once users are on N, switch the secrets to the new key; N+1 and later are signed with it.
3. Anyone who skips N must reinstall manually. If the old key leaked, ship N immediately and tell users to update by hand.

## Tests

`node --test scripts/dev/updater-logic.test.mts scripts/dev/updater-feed.test.mts` (scheduling, state machine, feed builder, downgrade guard). The Rust side is the stock plugin registration and is only compiled in CI on Windows.
