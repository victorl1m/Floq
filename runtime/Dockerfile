FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY tsconfig.image.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY image ./image
# `npm run build` ends with scripts/copy-plugin-assets.mjs (copies plugin skill folders next to the compiled plugins).
COPY scripts/copy-plugin-assets.mjs ./scripts/copy-plugin-assets.mjs
# Prisma generation reads the config's datasource URL but does not connect, so the build URL carries no credentials.
# --build-arg WITHOUT_LOCAL_EMBEDDINGS=1 leaves out the optional local embedding stack (@huggingface/transformers + onnxruntime, ~hundreds of MB);
# memory then needs FLOQ_EMBEDDINGS=openai or off (full-text search). Default: keep it.
ARG WITHOUT_LOCAL_EMBEDDINGS=0
RUN DATABASE_URL=postgresql://127.0.0.1:5432/floq npm run build && npm prune --omit=dev \
    && if [ "$WITHOUT_LOCAL_EMBEDDINGS" = "1" ]; then rm -rf node_modules/@huggingface node_modules/onnxruntime-node node_modules/onnxruntime-web node_modules/onnxruntime-common; fi

# passt/pasta built from a pinned upstream release. Debian bookworm ships passt 0.0~git20230309, which predates
# --map-host-loopback (the runtime API is reached through it); bookworm-backports has no passt and the trixie package
# would drag in a newer libc. The tarball checksum is verified; the build fails on a mismatch or when the flag is missing.
FROM node:22-bookworm-slim AS passt
ARG PASST_VERSION=2025_05_03.587980c
ARG PASST_SHA256=bacb2f4a15b1851e927016220891b479daea4be5beef80d296c0d14b51820720
RUN apt-get update && apt-get install -y --no-install-recommends gcc make libc6-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/passt.tgz "https://passt.top/passt/snapshot/passt-${PASST_VERSION}.tar.gz" \
    && echo "${PASST_SHA256}  /tmp/passt.tgz" | sha256sum -c - \
    && tar -xzf /tmp/passt.tgz -C /tmp && cd /tmp/passt-${PASST_VERSION} && make -j2 pasta \
    && install -m 755 pasta /out-pasta \
    && /out-pasta --help 2>&1 | grep -q -- --map-host-loopback

# ---- browser: pinned Playwright MCP + full Chromium (independent of the app build; cached until image/browser/package*.json changes) ----
# The pin lives in image/browser/package.json only. The Chromium revision follows from the playwright-core in the committed lockfile
# (the full `chromium` build, run with --headless=new; downloaded over HTTPS from Playwright's CDN; the zip is NOT pinned by a sha256 here, only the revision is, so
# the CDN and TLS are trusted for that one artifact). See docs/design/agent-browser.md section A.12.
FROM node:22-bookworm-slim AS browser
WORKDIR /opt/floq/playwright-mcp
COPY image/browser/package.json image/browser/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/floq/browsers
RUN node node_modules/playwright-core/cli.js install --no-shell chromium \
    && rm -rf /opt/floq/browsers/ffmpeg-* \
    && node -e 'const fs=require("fs");const rd=(p)=>JSON.parse(fs.readFileSync(p,"utf8"));const b=rd("node_modules/playwright-core/browsers.json").browsers.find(x=>x.name==="chromium");const m=rd("node_modules/@playwright/mcp/package.json");if(!b)throw new Error("no chromium in browsers.json");fs.writeFileSync("/opt/floq/browsers/VERSION.json",JSON.stringify({chromium:b.browserVersion,revision:b.revision,build:"chromium",playwrightMcp:m.version}))' \
    && test -s /opt/floq/browsers/VERSION.json

FROM node:22-bookworm-slim AS runtime
# --build-arg FLOQ_BROWSER=0 builds the image without the agent browser (no Chromium, libs or fonts; capabilities.browser = "missing").
ARG FLOQ_BROWSER=1
ENV NODE_ENV=production \
    FLOQ_SHARD_ROOT=/var/lib/floq/shards \
    FLOQ_SHARD_DRIVER=linux \
    FLOQ_PORT=8787
RUN apt-get update && apt-get install -y --no-install-recommends \
        git openssh-client ca-certificates curl ripgrep tini bash procps \
        bubblewrap fuse3 util-linux strace \
        socat nftables iproute2 ffmpeg \
        libnss3-tools \
        python3 python3-yaml python3-pymysql python3-psycopg2 default-mysql-client postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.328 @openai/codex@0.167.0 opencode-ai@1.19.5 \
    && npm cache clean --force
# Agent browser, layer 1: only the shared libraries the full chrome binary links against (ldd; adds libcups2, libcairo2, libpango to the shell's set) + fontconfig + fonts. No X server, no GTK.
# fonts-noto-cjk is ~91 MB: swap for fonts-wqy-zenhei (~17 MB) if size matters more than CJK quality.
RUN if [ "$FLOQ_BROWSER" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libdbus-1-3 \
        libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2 libcups2 libcairo2 libpango-1.0-0 \
        fontconfig fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*; fi
# gocryptfs from the pinned upstream static release, NOT Debian's 2.3 package. Debian bookworm builds 2.3 against a
# newer golang.org/x/sys whose Setreuid/Setregid affect every thread, which breaks gocryptfs's per-request uid switch
# when run as root with -allow_other: concurrent mkdir/open(O_CREAT) fail randomly with EPERM
# (https://github.com/rfjakob/gocryptfs/issues/892, fixed upstream in v2.5.1). The build fails if the checksum differs.
ARG GOCRYPTFS_VERSION=2.6.1
ARG GOCRYPTFS_SHA256_AMD64=49b8c0eb0f6373b6ac99c394a52909d8478e74c08d0961527c1162967cc28c44
ARG GOCRYPTFS_SHA256_ARM64=64576d550ab8af3f1dc729e93779540c5ecc00967d0185aae51a29a3755d86d0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sha="$GOCRYPTFS_SHA256_AMD64" ;; \
      arm64) arch=arm64; sha="$GOCRYPTFS_SHA256_ARM64" ;; \
      *) echo "unsupported architecture for gocryptfs" >&2; exit 1 ;; \
    esac; \
    f="gocryptfs_v${GOCRYPTFS_VERSION}_linux-static_${arch}.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/rfjakob/gocryptfs/releases/download/v${GOCRYPTFS_VERSION}/$f"; \
    echo "$sha  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /usr/local/bin gocryptfs; \
    rm -f "/tmp/$f"; \
    chmod 755 /usr/local/bin/gocryptfs; \
    gocryptfs -version | grep -q "gocryptfs v${GOCRYPTFS_VERSION}"
# Antigravity CLI (agy) 1.5.9 from the pinned upstream tarball (no npm package). The build fails if the sha512 differs.
# The CLI self-updates in the background; AGY_CLI_DISABLE_AUTO_UPDATE is forced for sessions (providers.ts forcedSessionEnv).
ARG AGY_VERSION=1.5.9
ARG AGY_URL_AMD64=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-x64/cli_linux_x64.tar.gz
ARG AGY_SHA512_AMD64=d01eb13ba7750eed18907f1ae8860864371e0ad9064415e8d033d22b4bd7b9b4e4c7f962058520b452d67db1c33163d9a889d55a7dffa159596ec6cd91a87b79
ARG AGY_URL_ARM64=https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.9-4515810895593472/linux-arm/cli_linux_arm64.tar.gz
ARG AGY_SHA512_ARM64=16c632a09b81f598f7652bc11180861f9d2ee4408ffa161dadc83b2010de7a9cd055e97b4b46cd01903e35c0e8bf21d8262462ba7c5f168cc6dada9ac3d522c0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) url="$AGY_URL_AMD64"; sha="$AGY_SHA512_AMD64" ;; \
      arm64) url="$AGY_URL_ARM64"; sha="$AGY_SHA512_ARM64" ;; \
      *) echo "unsupported architecture for agy" >&2; exit 1 ;; \
    esac; \
    mkdir /tmp/agy; \
    curl -fsSL -o /tmp/agy/cli.tar.gz "$url"; \
    echo "$sha  /tmp/agy/cli.tar.gz" | sha512sum -c -; \
    tar -xzf /tmp/agy/cli.tar.gz -C /tmp/agy antigravity; \
    install -m 755 /tmp/agy/antigravity /usr/local/bin/agy; \
    rm -rf /tmp/agy; \
    AGY_CLI_DISABLE_AUTO_UPDATE=true agy --version | grep -q "${AGY_VERSION}"
# Fail the image build if the utilities and Codex launch modes required at runtime are missing.
RUN command -v ps \
    && codex --no-daemon --help >/dev/null \
    && codex --no-daemon resume --help >/dev/null \
    && opencode --version | grep -q "1.19.5" \
    && opencode --help 2>&1 | grep -q -- "--session" \
    && opencode session list --help >/dev/null 2>&1 \
    && agy --version | grep -q "1.5.9" \
    && agy --help 2>&1 | grep -q -- "--conversation"
# GitHub CLI from the official signed apt repository (lives under /usr, so it is visible in the sandbox).
RUN mkdir -p /etc/apt/keyrings  \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg  \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg  \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list  \
    && apt-get update && apt-get install -y --no-install-recommends gh  \
    && rm -rf /var/lib/apt/lists/*
# Preinstalled tooling. Everything lives under /usr because agent sandboxes only see /usr.
# Pinned to release tags (verified upstream). Bump deliberately; override with --build-arg.
ARG SUPERPOWERS_REF=v7.0.2
ARG HUMANIZER_REF=v3.1.0
ARG SPECKIT_REF=v1.3.2
# uv is pinned to a release; the versioned installer downloads that release and verifies its checksum.
ARG UV_VERSION=0.13.7
# Full commit of anthropics/skills (skill-creator); the build fails if it cannot be fetched.
ARG ANTHROPIC_SKILLS_REF=ca45fc496a3436251f191354091d557da31c15b5
ENV UV_TOOL_DIR=/usr/local/share/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    UV_CACHE_DIR=/tmp/uv-cache
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
    && uv tool install specify-cli --from "git+https://github.com/github/spec-kit.git@${SPECKIT_REF}" \
    && chmod -R a+rX /usr/local/share/uv \
    && rm -rf /tmp/uv-cache
COPY --from=build /app/dist/image/floq.mjs /usr/local/bin/floq
COPY --from=build /app/dist/image/floq-args.mjs /usr/local/bin/floq-args.mjs
COPY --from=build /app/dist/image/floq-setup.mjs /usr/local/bin/floq-setup.mjs
COPY --from=build /app/dist/image/floq-vault.mjs /usr/local/bin/floq-vault
COPY --from=build /app/dist/image/floq-browserd.mjs /usr/local/bin/floq-browserd
COPY --from=build /app/dist/image/floq-browserd-core.mjs /usr/local/bin/floq-browserd-core.mjs
COPY --from=build /app/dist/image/floq-egress.mjs /usr/local/bin/floq-egress.mjs
COPY --from=build /app/dist/image/floq-egress-codec.mjs /usr/local/bin/floq-egress-codec.mjs
COPY --from=build /app/dist/image/floq-browser-mcp.mjs /usr/local/bin/floq-browser-mcp
COPY --from=build /app/dist/image/floq-block-native-subagent.mjs /usr/local/bin/floq-block-native-subagent.mjs
COPY --from=build /app/dist/image/floq-artifact-redirect.mjs /usr/local/bin/floq-artifact-redirect.mjs
COPY --from=build /app/dist/image/floq-native-question.mjs /usr/local/bin/floq-native-question.mjs
COPY --from=build /app/dist/image/floq-permission-request.mjs /usr/local/bin/floq-permission-request.mjs
# Managed (policy) settings outrank user, project and local settings and are read-only to agents: native subagents stay denied.
COPY image/claude-managed-settings.json /etc/claude-code/managed-settings.json
# Strip CR from the installed scripts: a CRLF shebang makes the kernel look for an interpreter named "node" plus CR.
RUN sed -i 's/\r$//' /usr/local/bin/floq /usr/local/bin/floq-args.mjs /usr/local/bin/floq-setup.mjs /usr/local/bin/floq-vault /usr/local/bin/floq-browserd /usr/local/bin/floq-browserd-core.mjs /usr/local/bin/floq-egress.mjs /usr/local/bin/floq-egress-codec.mjs /usr/local/bin/floq-browser-mcp \
    && chmod 755 /usr/local/bin/floq /usr/local/bin/floq-vault /usr/local/bin/floq-browserd /usr/local/bin/floq-browser-mcp && chmod 644 /usr/local/bin/floq-browserd-core.mjs /usr/local/bin/floq-egress.mjs /usr/local/bin/floq-egress-codec.mjs && chmod 644 /usr/local/bin/floq-block-native-subagent.mjs /usr/local/bin/floq-artifact-redirect.mjs /usr/local/bin/floq-native-question.mjs /usr/local/bin/floq-permission-request.mjs /etc/claude-code/managed-settings.json
# mkcert for HTTPS dev servers (`next dev --experimental-https` etc.): pinned release binary, sha256 verified (the build fails on a mismatch).
# certutil comes from libnss3-tools above. Agents run it with CAROOT=~/.local/share/mkcert and TRUST_STORES=nss (set by the runtime), so
# `mkcert -install` only touches the user's own ~/.pki/nssdb (never /etc, never another user). See SECURITY.md.
ARG MKCERT_VERSION=1.4.4
ARG MKCERT_SHA256_AMD64=6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52
ARG MKCERT_SHA256_ARM64=b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) sum="$MKCERT_SHA256_AMD64" ;; arm64) sum="$MKCERT_SHA256_ARM64" ;; *) echo "mkcert: unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL -o /usr/local/bin/mkcert "https://github.com/FiloSottile/mkcert/releases/download/v${MKCERT_VERSION}/mkcert-v${MKCERT_VERSION}-linux-${arch}" \
    && echo "${sum}  /usr/local/bin/mkcert" | sha256sum -c - \
    && chmod 755 /usr/local/bin/mkcert && mkcert -version
# Rootless apt/apt-get for agents (no root in the sandbox): per-user lists, packages unpacked under ~/.floq/apt, launchers in
# ~/.local/bin. Root keeps the real tools (they sit later in PATH; the wrapper execs them for uid 0).
COPY image/floq-apt /usr/local/bin/floq-apt
RUN sed -i 's/\r$//' /usr/local/bin/floq-apt && chmod 755 /usr/local/bin/floq-apt \
    && ln -sf floq-apt /usr/local/bin/apt && ln -sf floq-apt /usr/local/bin/apt-get && ln -sf floq-apt /usr/local/bin/apt-cache
# Copy of bwrap under a path no host AppArmor profile is attached to (see shard.ts).
RUN cp /usr/bin/bwrap /usr/local/bin/floq-bwrap
# pasta (FLOQ_NETNS) from the passt stage, installed under its own path for the same AppArmor reason as floq-bwrap
# (Ubuntu hosts attach a "pasta" profile to /usr/bin/pasta). The name must keep the substring "pasta": passt selects its mode from argv[0].
COPY --from=passt /out-pasta /usr/local/bin/floq-pasta
# System-wide commit hook: strips agent attribution, adds the Floq co-author trailer. /etc/gitconfig and /usr are read-only inside the sandbox.
COPY image/git-hooks /usr/local/share/floq/git-hooks
RUN sed -i 's/\r$//' /usr/local/share/floq/git-hooks/* && chmod -R a+rX /usr/local/share/floq/git-hooks && chmod 755 /usr/local/share/floq/git-hooks/commit-msg     && git config --system core.hooksPath /usr/local/share/floq/git-hooks
COPY image/skills /tmp/floq-skills
COPY image/build-skel.sh /tmp/build-skel.sh
RUN sed -i 's/\r$//' /tmp/build-skel.sh && SUPERPOWERS_REF=${SUPERPOWERS_REF} HUMANIZER_REF=${HUMANIZER_REF} ANTHROPIC_SKILLS_REF=${ANTHROPIC_SKILLS_REF} sh /tmp/build-skel.sh && rm -rf /tmp/build-skel.sh /tmp/floq-skills

# Agent browser, layer 2: Playwright MCP + full Chromium from the browser stage. Copied after the CLI/app layers so source
# edits never invalidate it and a browser bump never rebuilds the apt layer. /opt/floq is bound read-only into sandboxes (shard.ts).
COPY --from=browser --chown=root:root /opt/floq /opt/floq
RUN [ "$FLOQ_BROWSER" = 1 ] || rm -rf /opt/floq/browsers /opt/floq/playwright-mcp; \
    [ ! -d /opt/floq ] || chmod -R a+rX,go-w /opt/floq
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/floq/browsers
# Build checks (FLOQ_BROWSER=1): every shared library resolves, the emoji and CJK fonts are visible to fontconfig, VERSION.json exists.
RUN if [ "$FLOQ_BROWSER" = 1 ]; then \
      exe="$(ls /opt/floq/browsers/chromium-*/chrome-linux64/chrome)" \
      && ! ldd "$exe" | grep 'not found' \
      && fc-list | grep -qi 'Noto Color Emoji' && fc-list | grep -qi 'Noto Sans CJK' \
      && test -s /opt/floq/browsers/VERSION.json \
      && "$exe" --version; \
    fi

# The runtime runs as root so it can mount each user's encrypted home and start
# agent processes under a per-user uid inside a bubblewrap sandbox. Agents never run as root.
RUN mkdir -p /var/lib/floq/shards && chmod 700 /var/lib/floq/shards
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
COPY package.json ./
VOLUME ["/var/lib/floq/shards"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]

# App debugging toolchains (opt-in: docker build --target app-debug). See the Floq notes app-debug-order / app-debug-spec-*.
# Everything installs under /usr, because agent sandboxes see /usr read-only and have no root.
FROM runtime AS app-debug
# --- FLUTTER (spec 1) ---
# Flutter stable at /usr/local/flutter, precached for web + linux, analytics off. The SDK stays read-only in sandboxes, but the
# flutter tool writes stamps and a lockfile in bin/cache on every run (verified: `flutter --version` fails on a read-only SDK).
# So /usr/local/bin/flutter and dart are floq-flutter, which runs them from a ~0.5 MB per-user shadow SDK in ~/.floq/sdk/flutter
# (real bin/ and bin/cache files, symlinks to the read-only bulk). PUB_CACHE and Flutter/Dart config live in $HOME.
# Flutter publishes Linux release archives for x64 only. Pin version + checksum from releases_linux.json.
ARG FLUTTER_VERSION=3.47.9
ARG FLUTTER_SHA256=25ed8c3c29d51a7353f2a944310b478af8214920639524b19c50a19e6c044c5a
RUN set -eu; \
    [ "$(dpkg --print-architecture)" = amd64 ] || { echo "flutter: Linux release archives exist for amd64 only" >&2; exit 1; }; \
    apt-get update; apt-get install -y --no-install-recommends xz-utils unzip zip libglu1-mesa; rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/flutter.tar.xz "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"; \
    echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/flutter.tar.xz -C /usr/local; rm -f /tmp/flutter.tar.xz; \
    git config --system --add safe.directory /usr/local/flutter; \
    git config --system --add safe.directory /usr/local/flutter/.git; \
    export HOME=/tmp/flutter-build-home PUB_CACHE=/tmp/flutter-build-home/.pub-cache FLUTTER_SUPPRESS_ANALYTICS=true; \
    /usr/local/flutter/bin/flutter config --no-analytics --no-cli-animations; \
    /usr/local/flutter/bin/dart --disable-analytics; \
    /usr/local/flutter/bin/flutter precache --web --linux --no-android --no-ios --no-macos --no-windows --no-fuchsia; \
    /usr/local/flutter/bin/flutter --version; \
    printf '%s %s\n' "$FLUTTER_VERSION" "$(git -C /usr/local/flutter rev-parse HEAD)" > /usr/local/flutter/.floq-seed; \
    rm -rf /tmp/flutter-build-home; \
    chown -R root:root /usr/local/flutter; chmod -R a+rX,go-w /usr/local/flutter
COPY image/floq-flutter /usr/local/bin/floq-flutter
RUN sed -i 's/\r$//' /usr/local/bin/floq-flutter && chmod 755 /usr/local/bin/floq-flutter \
    && ln -sf floq-flutter /usr/local/bin/flutter && ln -sf floq-flutter /usr/local/bin/dart
# --- END FLUTTER ---
# --- GUI (spec 2): xpra, Xvfb, WebKitGTK/GTK dev, Rust ---
# Xpra from the xpra.org bookworm repository (Debian's own xpra is too old for the HTML5 client and auth=env), Xvfb,
# fonts, the Tauri v2 Linux prerequisites and the Flutter Linux desktop build deps. `floq display start` runs it per session.
# The repository key is pinned by checksum (like gocryptfs above); the sources entry is written here, not downloaded.
ARG XPRA_KEY_SHA256=4df3209ea4b759f0b5838b60baedb6893ec62df7abad9046462176a6e6a7ed7d
RUN set -eu; \
    curl -fsSL https://xpra.org/xpra.asc -o /usr/share/keyrings/xpra.asc; \
    echo "${XPRA_KEY_SHA256}  /usr/share/keyrings/xpra.asc" | sha256sum -c -; \
    chmod 644 /usr/share/keyrings/xpra.asc; \
    printf 'Types: deb\nURIs: https://xpra.org\nSuites: bookworm\nComponents: main\nSigned-By: /usr/share/keyrings/xpra.asc\n' > /etc/apt/sources.list.d/xpra.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        xpra xpra-html5 xvfb xauth x11-utils \
        fonts-dejavu-core fonts-noto-color-emoji \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
        build-essential pkg-config file \
        clang cmake ninja-build libstdc++-12-dev; \
    rm -rf /var/lib/apt/lists/*; \
    xpra --version; test -f /usr/share/xpra/www/index.html; command -v Xvfb xauth
# Rust (for Tauri): pinned rustup-init (checksummed) and a pinned toolchain; bump both deliberately.
# The toolchain is read-only in the sandbox and agent sessions get a filtered environment (this stage's ENV only reaches
# root shells in the image, not agents), so /usr/local/bin shims pin RUSTUP_HOME and default CARGO_HOME to ~/.cargo.
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_SHA256_AMD64=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
ARG RUSTUP_SHA256_ARM64=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c
ARG RUST_TOOLCHAIN=1.91.0
ENV RUSTUP_HOME=/usr/local/rustup
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu; sha="$RUSTUP_SHA256_AMD64" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sha="$RUSTUP_SHA256_ARM64" ;; \
      *) echo "unsupported architecture for rustup" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init"; \
    echo "${sha}  /tmp/rustup-init" | sha256sum -c -; chmod 755 /tmp/rustup-init; \
    CARGO_HOME=/usr/local/rustup/cargo /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN" -c rustfmt -c clippy; \
    rm -f /tmp/rustup-init; \
    for tool in cargo rustc rustdoc rustup rustfmt cargo-fmt cargo-clippy clippy-driver; do \
      printf '#!/bin/sh\nexport RUSTUP_HOME=/usr/local/rustup\nexport CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"\nexec /usr/local/rustup/cargo/bin/%s "$@"\n' "$tool" > "/usr/local/bin/$tool"; \
      chmod 755 "/usr/local/bin/$tool"; \
    done; \
    chmod -R a+rX,go-w /usr/local/rustup; \
    HOME=/tmp/rust-check cargo --version; HOME=/tmp/rust-check rustc --version; rm -rf /tmp/rust-check
# Note: the legacy builder (DOCKER_BUILDKIT=0) builds every stage, this one included, even for the default target;
# BuildKit builds app-debug only with --target app-debug.
# --- END GUI ---

# Default target stays the slim runtime image.
FROM runtime
