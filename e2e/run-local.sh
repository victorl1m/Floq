#!/usr/bin/env bash
# Runs the Playwright suite on a host without chromium system libs and without root.
# Downloads the missing Debian 12 libs once into .tmp/pw-libs (git-ignored), extracts them with dpkg -x
# and runs playwright with LD_LIBRARY_PATH pointing at them. Usage: e2e/run-local.sh [playwright args]
set -euo pipefail
cd "$(dirname "$0")/.."
LIBS="$PWD/.tmp/pw-libs"; ROOT="$LIBS/root"
export LD_LIBRARY_PATH="$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ ! -d "$ROOT" ]; then
  mkdir -p "$LIBS/debs" "$LIBS/apt/state/lists/partial" "$LIBS/apt/cache/archives/partial" "$LIBS/apt/etc" "$ROOT"
  echo "deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian bookworm main" > "$LIBS/apt/etc/sources.list"; : > "$LIBS/apt/status"
  cat > "$LIBS/apt/apt.conf" <<CONF
Dir::State "$LIBS/apt/state"; Dir::State::status "$LIBS/apt/status"; Dir::Cache "$LIBS/apt/cache"; Dir::Etc::sourcelist "$LIBS/apt/etc/sources.list"; Dir::Etc::sourceparts "/nonexistent"; Dir::Etc::parts "/nonexistent"; APT::Sandbox::User ""; Debug::NoLocking "true"; APT::Architecture "amd64";
CONF
  export APT_CONFIG="$LIBS/apt/apt.conf"; apt-get update >/dev/null
  (cd "$LIBS/debs" && for p in libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libdrm2 libxcb1 libxkbcommon0 libasound2 libxau6 libxdmcp6 libbsd0 libmd0 libffi8 libpcre2-8-0 libwayland-server0 libexpat1 libxrender1 libxi6; do apt-get download "$p" >/dev/null; done)
  for d in "$LIBS"/debs/*.deb; do dpkg -x "$d" "$ROOT"; done
fi
mkdir -p .tmp/island-pw
exec npx playwright test "$@"
