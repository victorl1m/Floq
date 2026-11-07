<div align="center">

<h1>Floq</h1>

<h3>A desktop workspace for running Claude Code and Codex agents on a server you host.</h3>

[![Build Windows](https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml/badge.svg)](https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: early 0.x](https://img.shields.io/badge/status-early%200.x-orange)

</div>

Floq is a Tauri desktop app that connects to a **runtime** you host. The runtime starts [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex) sessions inside a container, each behind a PTY and a per-user sandbox, and streams the terminals to the app over WebSocket. Agents sign in with **your own Claude or ChatGPT subscription**, not with API keys.

> **Status:** early (`0.x`) software. Expect rough edges and breaking changes. The Windows installers are **unsigned**, so SmartScreen will warn when you run them. macOS binaries are not published yet (building from source on macOS works). Read the [security model](#security-model) before you deploy a runtime.

## Features

- **Agents on a canvas.** Start Claude Code, Codex or a plain shell in a cloud terminal and arrange agents, notes, keychains and wires on a canvas. Idle terminals sleep and resume the same conversation.
- **Projects, folders and organizations.** Clone a repository by URL or from a connected GitHub account, group projects into folders, review changed files, and share a runtime with an organization (owner, admin and member roles, invitation tokens).
- **Notes, keychains and wires.** Sticky notes on the canvas, scoped keychains of secrets that are delivered only to the agents wired to them, and a per-user write-only vault.
- **Cross-project agent messaging and approvals.** Agents can message each other across your projects with the `floq` CLI. Irreversible or outward actions (push, merge, deploy) can require an explicit approval from you in the app.
- **Subagent recruiting.** Lead agents recruit and dismiss other agents through Floq, optionally in an isolated Git worktree.
- **Port forwarding.** Forward ports from an agent's sandbox to your machine from the right sidebar.
- **Skills and MCP servers.** Browse, add and remove skills; install MCP servers from the app or the `floq` CLI, with credentials taken from your vault.
- **Light and dark themes**, a command palette and a custom window frame.

## Install

- **Prebuilt installers:** The Windows installer (`.exe`) is attached to GitHub Releases. It is unsigned. Installing it over an older version (including an old `.msi` install) replaces it; a running Floq is closed first. macOS binaries are not published yet.
- **From source:** see below.

### Build from source

Prerequisites: [Node.js 22](https://nodejs.org), [Rust (stable)](https://rustup.rs) and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/victorl1m/Floq.git
cd Floq
npm ci

npm run dev          # the interface in a browser at http://localhost:1420
npm run tauri dev    # the desktop app in development
npm run build        # TypeScript check and Vite production build
npm run tauri build  # desktop bundles
```

The app needs a runtime to talk to. To prefill the runtime URL at build time set `VITE_FLOQ_RUNTIME_URL` (for example `https://floq.example.com`); otherwise the app remembers the last URL you used.

## Self-hosting the runtime

The runtime (`runtime/`) ships a Dockerfile and a Docker Compose file with the runtime and PostgreSQL. It is written for [Dokploy](https://dokploy.com), but any host that runs Compose behind TLS works.

1. Create a Compose service from `runtime/docker-compose.yml` (build context is `runtime/`).
2. Fill in the environment from [`runtime/.env.example`](runtime/.env.example). Required: `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `FLOQ_ENCRYPTION_KEY`, `BETTER_AUTH_URL`. Generator commands are in the file.
3. Set `FLOQ_BOOTSTRAP_ADMIN_EMAIL` to the first account's address; the admin chooses a password in the app on first sign-in.
4. Publish the `runtime` service on port `8787` over HTTPS. Do not publish host ports and keep PostgreSQL unpublished.
5. Deploy, then enter the runtime URL in the app and sign in.

Before building the image, sync the bundled orchestration skill (PowerShell, from `runtime/`): `powershell -NoProfile -ExecutionPolicy Bypass -File ../scripts/sync-floq-orchestrate-skill.ps1`.

Host requirements (`/dev/fuse`, AppArmor on Ubuntu 25.04+, the seccomp profile, `FLOQ_MOUNT_ROOT`), the HTTP API, sleep and resume, the vault and administration are documented in [`runtime/README.md`](runtime/README.md).

Inside a Floq session, `floq setup --dry-run --agents` previews exporting the agent workflow to the repository's instruction files. Run `floq setup --agents` to write it to `CLAUDE.md` and `AGENTS.md`; without `--agents`, `AGENTS.md` is updated only when it already exists. The command targets the Git root, or the current directory for a project without Git, and prints that location. Existing content is preserved, and files with Floq guidance are left untouched. This export is optional: Floq already injects its workflow when sessions start or resume. Review the resulting diff before committing it.

## Downloading files and "Open in Explorer"

In the right sidebar's **Files** tab, right-click a file or folder to **Download** it (a folder is streamed as a zip; `.git` and `node_modules` are left out). Downloads use a signed link that is valid for 60 seconds and works once.

**Open in Explorer** (desktop app, HTTPS runtimes only) mounts the project's folders as a **read-only** WebDAV share that Windows Explorer, Finder and Linux file managers can browse like a network drive. Nothing needs installing on Windows.

- **Use HTTPS.** The Windows WebDAV client cannot send our bearer header, so the share is addressed by an unguessable token in the URL path (`/dav/<token>/`). The action is hidden when the runtime URL is plain `http://`.
- **Token lifetime.** A share lasts 8 hours, until you choose **Stop Explorer access**, until you sign out (or the sign-in session ends), or until the runtime restarts. It only works while your workspace is awake and you are using Floq; it never wakes a sleeping workspace.
- **Reverse proxy.** Forward `OPTIONS`, `PROPFIND`, `GET`, `HEAD` and `Range` requests for `/dav/` untouched, do not buffer responses, and **redact `/dav/` paths from access logs** (the token is the credential). The token also shows up in Explorer's recent places and `net use` listings.
- **Windows limits.** Needs the WebClient service (absent on Windows Server, and Microsoft lists the WebDAV client as deprecated, so treat this as best effort). WebClient refuses files larger than 50 MB by default; use **Download** for those. Folders over about 2,000 entries are truncated in listings.

## Architecture

```text
 Floq app (Tauri 2, React 19, xterm.js)
        |  HTTPS + WebSocket (bearer token)
        v
 runtime (Node.js, better-auth, node-pty) ---- PostgreSQL (state, wrapped keys, encrypted credentials)
        |
        +-- per-user gocryptfs-encrypted home (shards volume)
        +-- bubblewrap sandbox per user and session  --> claude / codex CLI
```

| Component | Stack | Responsibility |
|---|---|---|
| **App** (`src/`, `src-tauri/`) | Tauri 2, React 19, Vite, Tailwind 4, shadcn / Base UI, xterm.js | Sign-in, canvas, projects, terminals, settings, skills, secrets. The Rust side is small: window setup, clipboard and opener plugins, port forwarding. |
| **Runtime** (`runtime/`) | Node.js, TypeScript, better-auth, node-pty, ws, pg, Prisma | Auth, organizations, sessions and PTYs, WebSocket streaming, credential refresh, vault, GitHub device flow, per-user shards. |
| **Image** (`runtime/image/`) | Shell, Node | Home skeleton for new users, the `floq` and `floq-vault` CLIs, bundled skills, a system `commit-msg` hook. |

## Security model

Summary; the full model is in [`runtime/README.md`](runtime/README.md#security-model) and [`SECURITY.md`](SECURITY.md).

- Accounts use better-auth with scrypt-hashed passwords, rate limits and 7-day sessions. **Signup is closed by default.**
- Provider logins, GitHub tokens and vault secrets are encrypted with AES-256-GCM using `FLOQ_ENCRYPTION_KEY`. Losing or changing that key makes them unreadable.
- Each user gets a numeric uid and a gocryptfs-encrypted home, mounted only while the user has a terminal open. Agents run unprivileged inside a bubblewrap sandbox with their own PID/IPC/UTS namespaces, read-only system directories, no capabilities and `no-new-privs`.
- **Limits.** Auto-approve is on by default for both providers (each user can turn it off), so an agent can run arbitrary commands inside the container. The container itself is not a hardened boundary (its compose file adds `SYS_ADMIN`, `SETUID`, `apparmor:unconfined` and `/dev/fuse`), sandboxes share the container's network, and the Tauri window currently sets `"csp": null`. The isolation has not been independently reviewed; do not host Floq for people you do not trust.
- Agents use the CLIs' own subscription sign-in flows. Check that this matches the terms of your Claude and ChatGPT plans.

## Repository structure

```text
src/             React interface (components, hooks, lib/runtime client and store)
src-tauri/       Tauri 2 shell (Rust): window, plugins, port forwarding, capabilities
runtime/         self-hosted server: src/, image/, prisma/, test/, Dockerfile, docker-compose.yml
skills/          canonical source of the floq-orchestrate skill
scripts/         client-side checks (test-*.mjs) and Playwright probes with synthetic data
docs/            orchestration, secrets and design notes
DESIGN.md        interface design rules
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE). [`NOTICE`](NOTICE) carries the Apache-2.0 attribution for `runtime/seccomp-floq.json` (derived from Docker's default seccomp profile) and notes on third-party skills fetched when the runtime image is built, which keep their own licenses.
