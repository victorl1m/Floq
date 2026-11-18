# Windows installer and uninstaller performance

Scope: Tauri v2 NSIS installer (`bundle.windows`, `src-tauri/windows/installer-hooks.nsh`).
No Windows or makensis was available here, so the numbers below are estimates from the NSIS template's
behaviour, not measurements. Verify on a Windows CI build (see "Untested").

## Where the time went

| Source | Cost | Cause |
|---|---|---|
| `taskkill` + `Sleep 1000` in PREINSTALL | ~1.0-1.2 s, even if Floq was closed | unconditional |
| Same again in PREUNINSTALL | ~1.0-1.2 s | on an upgrade the old uninstaller runs inside the installer, so kill+sleep happened twice |
| Per-file deletes by the uninstaller, Defender scanning | scales with file count | outside our control; a smaller install tree is the only lever |
| WebView2 | 0 s if present (template checks the registry first); otherwise a bootstrapper download | default `downloadBootstrapper` fails or stalls on slow networks |

## Changes

1. `FLOQ_STOP_APP` only runs `taskkill` when `nsProcess::_FindProcess` finds `floq.exe`, and then polls every 200 ms
   (max 3 s) instead of a fixed 1 s sleep. Not running: cost ~0 ms. Running: usually 200-400 ms.
2. PREUNINSTALL skips the stop entirely while the upgrade marker exists (PREINSTALL just stopped the app).
   The Run-key removal is still skipped during upgrades and still done on a real uninstall.
3. `webviewInstallMode` is `embedBootstrapper` (silent): adds about 1.8 MB to the installer but removes the
   network download when WebView2 is missing. When it is present nothing is installed, as before.
4. Compression left at the default (solid LZMA). LZMA decompresses at tens of MB/s, so for an app of this size it
   costs well under a second; zlib/none would only grow the installer and the updater download. Revisit only if a
   Windows measurement shows extraction dominating.

App data is not touched by any of this: the uninstaller's "delete app data" option is unchanged and upgrades pass
through the update path that keeps it.

## Expected effect

| Scenario | Before | After |
|---|---|---|
| Fresh install, app not running | +1.0 s hook | ~0 s hook |
| Upgrade, app running | 2 x (kill + 1 s) | one kill, ~0.2-0.5 s wait |
| Upgrade, app closed | ~2 s of sleeps | ~0 s |
| Uninstall, app closed | +1.0 s | ~0 s |
| Updater `/UPDATE` passive | same as upgrade | same as upgrade |

Important: an upgrade runs the OLD version's uninstaller, with the old hooks. The uninstall-side saving (item 2)
takes effect only for upgrades from the version that contains this change onward; the first upgrade onto it still
pays the old second kill.

## Untested

- NSIS compile (CI Windows build is the only check); labels `floq_wait_loop`/`floq_wait_done` are unique per
  section but check for "label already declared" warnings.
- That `nsProcess` is available to hooks (the Tauri template includes it and uses it for its own running-app
  check). If the build fails on it, fall back to the previous unconditional taskkill.
- Real timings.

`node scripts/check-installer-hooks.mjs` does a static check (balanced macros/If/Push/Pop, defined labels,
marker and Run-key logic present).
