<div align="center">

<a href="https://github.com/victorl1m/Floq">
  <img alt="Floq" src="public/floq.svg" width="120" height="120">
</a>

<h1>Floq</h1>

<h3>A desktop workspace for running Claude Code and Codex agents on a server you host.</h3>

<p>
Agents on a canvas · Encrypted per-user sandboxes · Subagent orchestration<br/>
<b>your subscriptions, your server, one app.</b>
</p>

<p>
  <a href="https://github.com/victorl1m/Floq/releases"><img alt="Releases" src="https://img.shields.io/github/v/release/victorl1m/Floq?include_prereleases&style=for-the-badge&color=ff8a08&logo=github&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-18181b?style=for-the-badge"></a>
  <a href="https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml"><img alt="Build Windows" src="https://github.com/victorl1m/Floq/actions/workflows/build-windows.yml/badge.svg"></a>
</p>

<p>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind-4-38bdf8?style=flat-square&logo=tailwindcss&logoColor=white">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169e1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ed?style=flat-square&logo=docker&logoColor=white">
</p>

<p>
  <a href="#-the-product">Product</a> ·
  <a href="#-install">Install</a> ·
  <a href="#-self-hosting-the-runtime">Self-hosting</a> ·
  <a href="#-architecture">Architecture</a> ·
  <a href="#-security-model">Security</a> ·
  <a href="#-documentation">Docs</a> ·
  <a href="#-code-signing-policy">Code signing</a>
</p>

</div>

<br/>

> [!WARNING]
> **Run the runtime only on a dedicated VM or a single-tenant host.** The runtime container runs as root with broad capabilities (`SYS_ADMIN`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE` and others), `apparmor:unconfined` and `/dev/fuse`, because gocryptfs and bubblewrap need them. It is not a hardened boundary against a hostile agent or a hostile co-tenant.
> **Auto-approve is on by default**, so an agent can run commands in the container without asking. The first run asks you to confirm this and explains the effect.

## ✦ The product

Floq is a Tauri desktop app that connects to a **runtime** you host. The runtime starts [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex) sessions inside a container, each behind a PTY and a per-user sandbox, and streams the terminals to the app over WebSocket. Agents sign in with **your own Claude or ChatGPT subscription**, not with API keys.

> **Status:** pre-release software. Expect rough edges and breaking changes. The Windows installers are **unsigned** until SignPath signing is enabled, so SmartScreen will warn when you run them. macOS binaries are not published yet (building from source on macOS works). Read the [security model](#-security-model) before you deploy a runtime.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🧭 Canvas</h3>
      <b>Agents</b>: start Claude Code, Codex or a plain shell in a cloud terminal and arrange them with notes, wires and an app window (marquee selection included).<br/><br/>
      <b>Sleep and resume</b>: idle terminals sleep and resume the same conversation.<br/><br/>
      <b>Notes and wires</b>: sticky notes wired to the agents that should read them.
    </td>
    <td width="33%" valign="top">
      <h3>🤝 Orchestration</h3>
      <b>Subagents</b>: lead agents recruit and dismiss other agents, optionally in an isolated Git worktree. Defaults: 6 awake and 24 total per lead, configurable up to 32 and 200 (operators can lower the ceilings with <code>FLOQ_SUBAGENT_CEIL_CHILDREN</code> and <code>FLOQ_SUBAGENT_CEIL_TOTAL</code>).<br/><br/>
      <b>Messaging</b>: agents talk across projects and organizations with the <code>floq</code> CLI.<br/><br/>
      <b>Approvals</b>: push, merge and deploy can require your explicit approval in the app.
    </td>
    <td width="33%" valign="top">
      <h3>🗂️ Workspace</h3>
      <b>Organizations and projects</b>: a Personal organization per user, shared ones with owner, admin and member roles and invitation tokens. Clone by URL or from GitHub, group projects into folders, review changes from the titlebar branch pill.<br/><br/>
      <b>Files and Artifacts</b>: create files inline, preview docx, xlsx, xls, csv and pdf, download files and folders.<br/><br/>
      <b>Vault</b>: a per-user write-only vault for secrets.
    </td>
  </tr>
</table>

Also included:

- **Usage meter.** The footer shows your Claude Pro or Max usage (plan label, windows and extra usage), and says so when usage is unavailable.
- **Port forwarding, skills and MCP servers.** Forward sandbox ports to your machine, browse and manage skills, and install MCP servers from the app or the `floq` CLI with credentials from your vault.
- **Look and feel.** Light and dark themes, acrylic surfaces, a command palette and a custom window frame. Agents get robot avatars and role icons.

<br/>

## ✦ Install

- **Prebuilt installers:** The Windows installer (`.exe`) is attached to GitHub Releases. It is unsigned until SignPath signing is enabled (see [Code signing policy](#-code-signing-policy)). Installing it over an older version (including an old `.msi` install) replaces it; a running Floq is closed first. macOS binaries are not published yet.
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

## ✦ Self-hosting the runtime

The runtime (`runtime/`) ships a Dockerfile and a Docker Compose file with the runtime and PostgreSQL. Any host that runs Compose behind TLS works.

1. Create a Compose service from `runtime/docker-compose.yml` (build context is `runtime/`).
2. Fill in the environment from [`runtime/.env.example`](runtime/.env.example). Required: `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `FLOQ_ENCRYPTION_KEY`, `BETTER_AUTH_URL`. Generator commands are in the file.
3. Set `FLOQ_BOOTSTRAP_ADMIN_EMAIL` to the first account's address. On first start the runtime prints a one-time setup token to its logs (look for `FLOQ SETUP TOKEN`). In the app choose **Set up the administrator**, enter the token and the email, and pick a password. The token works once; only its hash is stored, and a new one is printed on restart while the account is still unclaimed.
4. Publish the `runtime` service on port `8787` over HTTPS. Do not publish host ports and keep PostgreSQL unpublished.
5. Deploy, then enter the runtime URL in the app and sign in.

Before building the image, sync the bundled orchestration skill (PowerShell, from `runtime/`): `powershell -NoProfile -ExecutionPolicy Bypass -File ../scripts/sync-floq-orchestrate-skill.ps1`.

### WhatsApp (Settings > Integrations)

WhatsApp is part of Floq: an inbox in the sidebar (several accounts, chats with their history, media, voice notes, reactions, groups, login by QR code) that agents can read, with free messages to your own number and your approval for anything sent to other people. An administrator sets it up in **Settings > Integrations > WhatsApp**. The card only offers the switch when a WhatsApp (WAHA) server exists: the one compose runs beside the runtime (next section), or a WAHA server of your own that you connect there with its address and API key (Floq tests them before saving). Without a server the card explains both ways. With one it shows the switch, the connection, the linked accounts, whether WhatsApp's events reach Floq (with a repair button), the settings (your own number, what the AI may send, history limits) and **Open WhatsApp**. Incoming messages also show on the island with an inline reply.

WhatsApp used to be the catalog plugin `waha` (`victorl1m/floq-plugin-waha`). That plugin is deprecated: a runtime with the built-in integration adopts an installed copy by itself on its first start (chats, accounts, settings, API key and webhook address stay as they are, the installed package is removed), and Settings > Plugins no longer lists or offers it. Details: [`runtime/README.md`](runtime/README.md#whatsapp-integration).

### WhatsApp server (optional)

Floq's WhatsApp integration talks to a [WAHA](https://github.com/devlikeapro/waha) server. The compose file runs one for you by default: deploy and scan the QR code in the app. Floq wires the address, the key and the webhook by itself, keeps the server on the newest stable release (Settings > Updates, automatic by default, with rollback) and keeps its sessions across updates and redeploys. It is WAHA Core (Apache-2.0), the official image in its own container: one WhatsApp account per server, media kept locally. You can point the integration at your own WAHA instead. WAHA is an unofficial WhatsApp client: numbers used for spam or bulk messages can be banned. Details: [`runtime/README.md`](runtime/README.md#built-in-whatsapp-server).

Host requirements (`/dev/fuse`, AppArmor on Ubuntu 25.04+, the seccomp profile, `FLOQ_MOUNT_ROOT`), the HTTP API, sleep and resume, the vault and administration are documented in [`runtime/README.md`](runtime/README.md).

Inside a Floq session, `floq setup --dry-run --agents` previews exporting the agent workflow to the repository's instruction files. Run `floq setup --agents` to write it to `CLAUDE.md` and `AGENTS.md`; without `--agents`, `AGENTS.md` is updated only when it already exists. The command targets the Git root, or the current directory for a project without Git, and prints that location. Existing content is preserved, and files with Floq guidance are left untouched. This export is optional: Floq already injects its workflow when sessions start or resume. Review the resulting diff before committing it.

## ✦ Downloading files and "Open in Explorer"

In the right sidebar's **Files** tab, right-click a file or folder to **Download** it (a folder is streamed as a zip; `.git` and `node_modules` are left out). Downloads use a signed link that is valid for 60 seconds, works once and is bound to its audience.

**Open in Explorer** (desktop app, HTTPS runtimes only) mounts the project's folders as a **read-write** WebDAV share that Windows Explorer, Finder and Linux file managers can use like a network drive. Nothing needs installing on Windows. Anyone who holds the share URL can change files, so treat it as a credential. Revealing a mounted item opens its folder in the platform file manager.

- **Use HTTPS.** The Windows WebDAV client cannot send our bearer header, so the share is addressed by an unguessable token in the URL path (`/dav/<token>/`). The action is hidden when the runtime URL is plain `http://`.
- **Token lifetime.** A share lasts 8 hours, until you choose **Stop Explorer access**, until you sign out (or the sign-in session ends), or until the runtime restarts. It only works while your workspace is awake and you are using Floq; it never wakes a sleeping workspace.
- **Reverse proxy.** Forward `OPTIONS`, `PROPFIND`, `GET`, `HEAD`, `PUT`, `DELETE` and `Range` requests (and the other WebDAV write methods) for `/dav/` untouched, do not buffer responses, and **redact `/dav/` paths from access logs** (the token is the credential). The token also shows up in Explorer's recent places and `net use` listings.
- **Windows limits.** Needs the WebClient service (absent on Windows Server, and Microsoft lists the WebDAV client as deprecated, so treat this as best effort). WebClient refuses files larger than 50 MB by default; use **Download** for those. Folders over about 2,000 entries are truncated in listings.

## ✦ Testing

```bash
npx tsc --noEmit                              # type-check the app
npm run test:e2e                              # Playwright specs in e2e/ (starts npm run dev, Tauri APIs mocked)
bash e2e/run-local.sh                         # same suite on a host without Chromium system libraries
cd runtime && npm test                        # build, then the runtime tests (node --test)
cd runtime && npm run typecheck               # runtime and image type-check
cd src-tauri && cargo test                    # Rust tests
```

On a fresh checkout run `npx playwright install chromium` once before the Playwright suite. The runtime tests need `cd runtime && npm ci` first.

## ✦ Architecture

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

## ✦ Security model

Summary; the full model is in [`runtime/README.md`](runtime/README.md#security-model) and [`SECURITY.md`](SECURITY.md).

- Accounts use better-auth with scrypt-hashed passwords, rate limits and 7-day sessions. **Signup is closed by default.**
- Provider logins, GitHub tokens and vault secrets are encrypted with AES-256-GCM using `FLOQ_ENCRYPTION_KEY`. Losing or changing that key makes them unreadable.
- Each user gets a numeric uid and a gocryptfs-encrypted home, mounted only while the user has a terminal open. Agents run unprivileged inside a bubblewrap sandbox with their own PID/IPC/UTS namespaces, read-only system directories, no capabilities and `no-new-privs`.
- **Limits.** Auto-approve is on by default for both providers (each user can turn it off), so an agent can run arbitrary commands inside the container. The container itself is not a hardened boundary (its compose file adds `SYS_ADMIN`, `SETUID`, `apparmor:unconfined` and `/dev/fuse`), sandboxes share the container's network, and the Tauri window currently sets `"csp": null`. The isolation has not been independently reviewed; do not host Floq for people you do not trust.
- Agents use the CLIs' own subscription sign-in flows. Check that this matches the terms of your Claude and ChatGPT plans.

## ✦ Repository structure

```text
src/             React interface (components, hooks, lib/runtime client and store)
src-tauri/       Tauri 2 shell (Rust): window, plugins, port forwarding, capabilities
runtime/         self-hosted server: src/, image/, prisma/, test/, Dockerfile, docker-compose.yml
skills/          canonical source of the floq-orchestrate skill
scripts/         build helpers; scripts/dev/ holds client-side checks (test-*.mjs) and Playwright probes with synthetic data
docs/            orchestration, secrets, plugins, release notes and UI notes (see below)
```

## ✦ Documentation

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

## ✦ Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Windows release installers (and the app executable inside) are signed only when built from a version tag in this repository's GitHub Actions workflow, and each release is approved manually. Builds from other branches are unsigned. See [`docs/code-signing.md`](docs/code-signing.md).

- Authors, reviewers and approvers: [@victorl1m](https://github.com/victorl1m) (sole maintainer).
- Privacy: Floq sends no data to any system except the runtime you configure and services you explicitly use in your agents. See [SECURITY.md](SECURITY.md).

## ✦ Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## ✦ License

Released under the [MIT License](LICENSE). [`NOTICE`](NOTICE) carries the Apache-2.0 attribution for `runtime/seccomp-floq.json` (derived from Docker's default seccomp profile) and notes on third-party skills fetched when the runtime image is built, which keep their own licenses. The optional WhatsApp server is [WAHA Core](https://github.com/devlikeapro/waha) (Apache-2.0), pulled as its official, unmodified image; it is a separate project, not affiliated with Floq or WhatsApp.
