---
name: floq-app-debug
description: Use when the user wants to see, preview, run or debug the app you are building in Floq (Flutter, Tauri, Vite or another web dev server), or asks for DevTools, a live preview or the app window. Explains how to start it so Floq detects it and the user can open it with one click.
---

# See and debug apps from Floq

You run in a remote Linux sandbox. The user cannot see your screen, but the Floq desktop app can forward a port of
this session to their computer (same port number on both sides) and open it in their browser. Floq watches your
terminal output for preview and debugger URLs and offers "Open preview" / "Open DevTools" to the user.

## Rules

- Ports are shared by every user on this server. Never hard-code a port (no `--web-port 8080`, no fixed Vite port
  unless the project requires it): let the tool pick a free one and read it from the output.
- Bind to loopback: `127.0.0.1` / `localhost`. Floq only shows URLs on loopback whose port this session listens on.
- By default other users' sandboxes on this server share the host network, so they can reach any port you listen on,
  loopback included. By default every user has their own network namespace (`FLOQ_NETNS`, unless the operator set it off); then only your own
  sessions share your ports (check: `ip -4 addr` shows 10.255.255.2 and nothing else listens for other users). Either
  way, do not serve secrets or real user data from a dev server, prefer auth-protected tools, and stop servers when
  you are done. With the namespace on, private networks (10/8, 172.16/12, 192.168/16, 169.254/16) are unreachable
  from your sandbox; public internet and DNS work.
- Keep the dev server running in the background and log to a file, then show the URL lines in your terminal so Floq
  (and the user) see them. Output of background jobs is not visible to Floq until you print it.
- The Flutter SDK is read-only; `flutter` keeps its cache and config in your home. It exists only when this server
  runs the app-debug image: check with `flutter --version` and tell the user if it is missing.
- Only the web and linux platforms are installed, and the SDK cache is linked read-only: `flutter upgrade`, `flutter
  channel` and `flutter precache` for another platform (android, ios, ...) fail (read-only file system or permission denied).
  Do not retry them; tell the user the image provides a fixed Flutter version for web and Linux.

## Flutter (web preview + DevTools)

```sh
cd my_app
nohup flutter run -d web-server --web-hostname 127.0.0.1 --pid-file /tmp/flutter.pid > /tmp/flutter-run.log 2>&1 &
# wait for the build, then print the lines Floq looks for:
timeout 180 sh -c 'until grep -q "is being served at" /tmp/flutter-run.log; do sleep 2; done'
grep -E "is being served at|VM Service|DevTools" /tmp/flutter-run.log
```

- The preview line is `lib/main.dart is being served at http://127.0.0.1:PORT`.
- The VM service and DevTools lines appear only after a browser opened the preview (the web-server device needs a
  client). After the user opened it, print them again with the same `grep`.
- Hot reload: `kill -USR1 $(cat /tmp/flutter.pid)`; hot restart: `kill -USR2 $(cat /tmp/flutter.pid)` (needs `--pid-file`).
- Build only: `flutter build web` writes `build/web`; serve it with `python3 -m http.server 0 --bind 127.0.0.1 -d build/web`
  (port 0 picks a free one; it prints the port) and tell the user the URL.

## Tauri / Vite and other web dev servers

```sh
nohup npm run dev > /tmp/dev.log 2>&1 &     # Tauri: the frontend dev server (Vite); `npm run tauri dev` needs the display: see App window below
timeout 60 sh -c 'until grep -q "Local:" /tmp/dev.log; do sleep 1; done'
grep -E "Local:" /tmp/dev.log
```

Vite prints `Local:   http://localhost:PORT/`; Floq picks that up. If a port is taken, Vite moves to the next one
unless `strictPort` is set; prefer leaving it unset.

## App window (Linux desktop build)

To show the real desktop app (Tauri / WebKitGTK, Flutter Linux, any X11 app), run it on this session's virtual display.
The user sees and uses the window in Floq's **App window** panel (right sidebar). Desktop Floq app only.

```sh
floq display start                 # BEFORE launching a GUI app (idempotent; prints "running: display :N")
eval "$(floq display env)"         # in the SAME shell command that launches the app: sets DISPLAY and XAUTHORITY
nohup npm run tauri dev > /tmp/tauri.log 2>&1 &         # Tauri
nohup flutter run -d linux > /tmp/flutter-linux.log 2>&1 &   # Flutter desktop
floq display status                # running | stopped
floq display stop                  # when you are done: stops the display and every app on it
```

Each shell command runs in a fresh shell, so chain them: `floq display start && eval "$(floq display env)" && nohup npm run tauri dev > /tmp/tauri.log 2>&1 &`.

- `DISPLAY` is NOT set by default, on purpose: X display names are shared by every user on this server, and while no
  display runs someone else could own the name. `floq display env` prints it only for your running display after
  checking that this session really holds it. Always get it from there, every time; never set `DISPLAY` by hand.
- Never run a bare `Xvfb`, `xvfb-run`, `Xephyr` or your own `xpra`: they start an X server without the protection
  `floq display` sets up (cookie auth, reserved display, checked socket). If `floq display start` or `env` refuses,
  tell the user.
- The display only exists on servers running the app-debug image. If `floq display start` says xpra is not installed,
  tell the user (use the web preview above instead).
- No GPU: rendering is software-only. Expect slower animations; WebKitGTK may need `WEBKIT_DISABLE_COMPOSITING_MODE=1`
  if the window stays blank.
- Rust comes preinstalled (`cargo`, `rustc`); crates and `cargo install` go to `~/.cargo`. A project pinning another
  toolchain in `rust-toolchain.toml` cannot install it (read-only toolchain): tell the user.

## Handing it to the user

1. Print the URL line(s) as above. Floq shows a toast "Flutter app ready" / "Dev server ready" and lists them under
   **Ports > Previews** in the window footer.
2. If the user does not see it, ask Floq to forward the port explicitly: `floq port open PORT --reason "Flutter web preview"`.
   It waits up to 60 s for the user's Allow. On Allow, tell them the `http://localhost:PORT` URL.
3. Forwarding works only in the Floq desktop app, not in the browser version.

Stop servers you started when you are done (`kill %1`, `pkill -f "flutter run"`), so ports are freed for other users.
