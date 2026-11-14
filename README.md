<div align="center">

<h1>Floq</h1>

<h3>A desktop workspace for running Claude Code and Codex agents on a server you host.</h3>

[![Build Windows](https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml/badge.svg)](https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Version 1.0.1 pre-release](https://img.shields.io/badge/version-1.0.1%20pre--release-orange)

</div>

> [!WARNING]
> **Run the runtime only on a dedicated VM or a single-tenant host.** The runtime container runs as root with broad capabilities (`SYS_ADMIN`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE` and others), `apparmor:unconfined` and `/dev/fuse`, because gocryptfs and bubblewrap need them. It is not a hardened boundary against a hostile agent or a hostile co-tenant.
> **Auto-approve is on by default**, so an agent can run commands in the container without asking. The first run asks you to confirm this and explains the effect.

Floq is a Tauri desktop app that connects to a **runtime** you host. The runtime starts [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex) sessions inside a container, each behind a PTY and a per-user sandbox, and streams the terminals to the app over WebSocket. Agents sign in with **your own Claude or ChatGPT subscription**, not with API keys.

> **Status:** v1.0.1, still published as a pre-release. Expect rough edges and breaking changes. The Windows installers are **unsigned**, so SmartScreen will warn when you run them. macOS binaries are not published yet (building from source on macOS works). Read the [security model](#security-model) before you deploy a runtime.

## Features

- **Agents on a canvas.** Start Claude Code, Codex or a plain shell in a cloud terminal and arrange agents, notes, wires and an app window on a canvas (marquee selection included). Agents get robot avatars and role icons. Idle terminals sleep and resume the same conversation.
- **Organizations and projects.** Every user has a Personal organization, and projects are scoped to an organization. Clone a repository by URL or from a connected GitHub account, group projects into folders, and review changed files from the titlebar branch pill (Changes). Shared organizations have owner, admin and member roles and invitation tokens.
- **Files and Artifacts tabs.** Create files inline, open them in a dialog, and preview docx, xlsx, xls, csv and pdf. Each project has an Artifacts folder with its own tab. Right-click to download a file or folder.
- **Notes and wires.** Sticky notes wired to the agents that should read them, and a per-user write-only vault for secrets.
- **Cross-project and cross-organization messaging, approvals.** Agents message each other with the `floq` CLI. Irreversible or outward actions (push, merge, deploy) can require your explicit approval in the app.
- **Subagent recruiting with limits.** Lead agents recruit and dismiss other agents, optionally in an isolated Git worktree. By default 6 agents can be awake and 24 exist in total per lead; the limits are configurable in settings up to ceilings of 32 and 200 (operators can lower the ceilings with `FLOQ_SUBAGENT_CEIL_CHILDREN` and `FLOQ_SUBAGENT_CEIL_TOTAL`).
- **Usage meter.** The footer shows your Claude Pro or Max usage (plan label, windows and extra usage), and says so when usage is unavailable.
- **Port forwarding, skills and MCP servers.** Forward sandbox ports to your machine, browse and manage skills, and install MCP servers from the app or the `floq` CLI with credentials from your vault.
- **Light and dark themes**, acrylic surfaces, a command palette and a custom window frame.

## Install

- **Prebuilt installers:** The Windows installer (`.exe`) is attached to GitHub Releases. It is unsigned until SignPath signing is enabled (see [Code signing policy](#code-signing-policy)). Installing it over an older version (including an old `.msi` install) replaces it; a running Floq is closed first. macOS binaries are not published yet.
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

The app needs a runtime to talk to. To prefill the runtime URL at build time set `VITE_FLOQ_RUNTIME_URL` (for example `https://floq.example.com`); otherwise the app remembers the last URL you used. The runtime URL is chosen at run time, so the desktop app's Content-Security-Policy (`connect-src` in `src-tauri/tauri.conf.json`) allows any `https:`/`wss:` origin but plain `http:`/`ws:` only for `localhost` and `127.0.0.1`. A runtime on a plain-HTTP LAN address is therefore blocked; put it behind TLS or add its origin to `connect-src` in your own build.

## Self-hosting the runtime

The runtime (`runtime/`) ships a Dockerfile and a Docker Compose file with the runtime and PostgreSQL. It is written for [Dokploy](https://dokploy.com), but any host that runs Compose behind TLS works.

1. Create a Compose service from `runtime/docker-compose.yml` (build context is `runtime/`).
2. Fill in the environment from [`runtime/.env.example`](runtime/.env.example). Required: `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `FLOQ_ENCRYPTION_KEY`, `BETTER_AUTH_URL`. Generator commands are in the file.
3. Set `FLOQ_BOOTSTRAP_ADMIN_EMAIL` to the first account's address. On first start the runtime prints a one-time setup token to its logs (look for `FLOQ SETUP TOKEN`). In the app choose **Set up the administrator**, enter the token and the email, and pick a password. The token works once; only its hash is stored, and a new one is printed on restart while the account is still unclaimed.
4. Publish the `runtime` service on port `8787` over HTTPS. Do not publish host ports and keep PostgreSQL unpublished.
5. Deploy, then enter the runtime URL in the app and sign in.

Before building the image, sync the bundled orchestration skill (PowerShell, from `runtime/`): `powershell -NoProfile -ExecutionPolicy Bypass -File ../scripts/sync-floq-orchestrate-skill.ps1`.

Host requirements (`/dev/fuse`, AppArmor on Ubuntu 25.04+, the seccomp profile, `FLOQ_MOUNT_ROOT`), the HTTP API, sleep and resume, the vault and administration are documented in [`runtime/README.md`](runtime/README.md).

Inside a Floq session, `floq setup --dry-run --agents` previews exporting the agent workflow to the repository's instruction files. Run `floq setup --agents` to write it to `CLAUDE.md` and `AGENTS.md`; without `--agents`, `AGENTS.md` is updated only when it already exists. The command targets the Git root, or the current directory for a project without Git, and prints that location. Existing content is preserved, and files with Floq guidance are left untouched. This export is optional: Floq already injects its workflow when sessions start or resume. Review the resulting diff before committing it.

## Downloading files and "Open in Explorer"

In the right sidebar's **Files** tab, right-click a file or folder to **Download** it (a folder is streamed as a zip; `.git` and `node_modules` are left out). Downloads use a signed link that is valid for 60 seconds, works once and is bound to its audience.

**Open in Explorer** (desktop app, HTTPS runtimes only) mounts the project's folders as a **read-write** WebDAV share that Windows Explorer, Finder and Linux file managers can use like a network drive. Nothing needs installing on Windows. Anyone who holds the share URL can change files, so treat it as a credential. Revealing a mounted item opens its folder in the platform file manager.

- **Use HTTPS.** The Windows WebDAV client cannot send our bearer header, so the share is addressed by an unguessable token in the URL path (`/dav/<token>/`). The action is hidden when the runtime URL is plain `http://`.
- **Token lifetime.** A share lasts 8 hours, until you choose **Stop Explorer access**, until you sign out (or the sign-in session ends), or until the runtime restarts. It only works while your workspace is awake and you are using Floq; it never wakes a sleeping workspace.
- **Reverse proxy.** Forward `OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE` and `Range` requests (and the other WebDAV write methods) for `/dav/` untouched, do not buffer responses, and **redact `/dav/` paths from access logs** (the token is the credential). The token also shows up in Explorer's recent places and `net use` listings.
- **Windows limits.** Needs the WebClient service (absent on Windows Server, and Microsoft lists the WebDAV client as deprecated, so treat this as best effort). WebClient refuses files larger than 50 MB by default; use **Download** for those. Folders over about 2,000 entries are truncated in listings.

## Testing

```bash
npx tsc --noEmit                              # type-check the app
npm run test:e2e                              # Playwright specs in e2e/ (starts npm run dev, Tauri APIs mocked)
bash e2e/run-local.sh                         # same suite on a host without Chromium system libraries
cd runtime && npm test                        # build, then the runtime tests (node --test)
cd runtime && npm run typecheck               # runtime and image type-check
cd src-tauri && cargo test                    # Rust tests
```

On a fresh checkout run `npx playwright install chromium` once before the Playwright suite. The runtime tests need `cd runtime && npm ci` first.

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
scripts/         build helpers; scripts/dev/ holds client-side checks (test-*.mjs) and Playwright probes with synthetic data
docs/            orchestration, secrets, plugins, release notes and UI notes (see below)
```

## Documentation

- [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md): how agents recruit and coordinate other agents
- [`docs/runtime-agents.md`](docs/runtime-agents.md): how Claude Code and Codex run inside the runtime image and sandboxes
- [`docs/SECRETS.md`](docs/SECRETS.md): the secrets vault
- [`docs/ENCRYPTED-HOME-CONCURRENCY.md`](docs/ENCRYPTED-HOME-CONCURRENCY.md): known EPERM issue on encrypted homes
- [`docs/plugins/`](docs/plugins/README.md): plugin authoring
- [`docs/component-system.md`](docs/component-system.md), [`docs/view-transitions.md`](docs/view-transitions.md), [`docs/ui-research.md`](docs/ui-research.md): UI system notes
- [`docs/DESIGN.md`](docs/DESIGN.md): interface design rules
- [`docs/UX-CONTRACT.md`](docs/UX-CONTRACT.md): canonical UI behavior map
- [`docs/PRODUCT.md`](docs/PRODUCT.md): product context
- [`docs/code-signing.md`](docs/code-signing.md): Windows code signing with SignPath
- [`docs/releases/`](docs/releases): release notes

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Windows release installers (and the app executable inside) are signed only when built from a version tag in this repository's GitHub Actions workflow, and each release is approved manually. Builds from other branches are unsigned. See [`docs/code-signing.md`](docs/code-signing.md).

- Authors, reviewers and approvers: [@victorl1m](https://github.com/victorl1m) (sole maintainer).
- Privacy: Floq sends no data to any system except the runtime you configure and services you explicitly use in your agents. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE). [`NOTICE`](NOTICE) carries the Apache-2.0 attribution for `runtime/seccomp-floq.json` (derived from Docker's default seccomp profile) and notes on third-party skills fetched when the runtime image is built, which keep their own licenses.
