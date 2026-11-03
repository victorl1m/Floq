FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --include=dev || npm install
COPY tsconfig.json ./
COPY tsconfig.image.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY image ./image
# Prisma generation reads the config's datasource URL but does not connect; use a build-only placeholder.
RUN DATABASE_URL=postgresql://floq:build-only@127.0.0.1:5432/floq npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    FLOQ_SHARD_ROOT=/var/lib/floq/shards \
    FLOQ_SHARD_DRIVER=linux \
    FLOQ_PORT=8787
RUN apt-get update && apt-get install -y --no-install-recommends \
        git openssh-client ca-certificates curl ripgrep tini bash procps \
        bubblewrap fuse3 util-linux strace \
        python3 python3-yaml python3-pymysql python3-psycopg2 default-mysql-client postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force
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
# Fail the image build if the utilities and Codex launch modes required at runtime are missing.
RUN command -v ps \
    && codex --no-daemon --help >/dev/null \
    && codex --no-daemon resume --help >/dev/null
# GitHub CLI from the official signed apt repository (lives under /usr, so it is visible in the sandbox).
RUN mkdir -p /etc/apt/keyrings  \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg  \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg  \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list  \
    && apt-get update && apt-get install -y --no-install-recommends gh  \
    && rm -rf /var/lib/apt/lists/*
# Preinstalled tooling. Everything lives under /usr because agent sandboxes only see /usr.
# Pin these refs to release tags/commits for reproducible builds.
ARG SUPERPOWERS_REF=main
ARG HUMANIZER_REF=main
ARG SPECKIT_REF=main
# Full commit of anthropics/skills (skill-creator); the build fails if it cannot be fetched.
ARG ANTHROPIC_SKILLS_REF=ca45fc496a3436251f191354091d557da31c15b5
ENV UV_TOOL_DIR=/usr/local/share/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    UV_CACHE_DIR=/tmp/uv-cache
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
    && uv tool install specify-cli --from "git+https://github.com/github/spec-kit.git@${SPECKIT_REF}" \
    && chmod -R a+rX /usr/local/share/uv \
    && rm -rf /tmp/uv-cache
COPY --from=build /app/dist/image/floq.mjs /usr/local/bin/floq
COPY --from=build /app/dist/image/floq-args.mjs /usr/local/bin/floq-args.mjs
COPY --from=build /app/dist/image/floq-vault.mjs /usr/local/bin/floq-vault
# Strip CR from the installed scripts: a CRLF shebang makes the kernel look for an interpreter named "node" plus CR.
RUN sed -i 's/\r$//' /usr/local/bin/floq /usr/local/bin/floq-args.mjs /usr/local/bin/floq-vault \
    && chmod 755 /usr/local/bin/floq /usr/local/bin/floq-vault
# Copy of bwrap under a path no host AppArmor profile is attached to (see shard.ts).
RUN cp /usr/bin/bwrap /usr/local/bin/floq-bwrap
# System-wide commit hook: strips agent attribution, adds the Floq co-author trailer. /etc/gitconfig and /usr are read-only inside the sandbox.
COPY image/git-hooks /usr/local/share/floq/git-hooks
RUN sed -i 's/\r$//' /usr/local/share/floq/git-hooks/* && chmod -R a+rX /usr/local/share/floq/git-hooks && chmod 755 /usr/local/share/floq/git-hooks/commit-msg     && git config --system core.hooksPath /usr/local/share/floq/git-hooks
COPY image/skills /tmp/floq-skills
COPY image/build-skel.sh /tmp/build-skel.sh
RUN sed -i 's/\r$//' /tmp/build-skel.sh && SUPERPOWERS_REF=${SUPERPOWERS_REF} HUMANIZER_REF=${HUMANIZER_REF} ANTHROPIC_SKILLS_REF=${ANTHROPIC_SKILLS_REF} sh /tmp/build-skel.sh && rm -rf /tmp/build-skel.sh /tmp/floq-skills

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
