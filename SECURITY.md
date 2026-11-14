# Security Policy

> [!WARNING]
> **Run the runtime only on a dedicated VM or a single-tenant host.** The runtime container runs as root with broad capabilities (`SYS_ADMIN`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE` and others), `apparmor:unconfined` and `/dev/fuse`, because gocryptfs and bubblewrap need them. It is not a hardened boundary against a hostile agent or a hostile co-tenant.
> **Auto-approve is on by default**, so an agent can run commands in the container without asking. The first run asks you to confirm this and explains the effect.

## Supported versions

Floq is early (0.x) software. Only the latest released `0.x` version (and the `main` branch) receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub Security Advisories).

Include what you found, how to reproduce it, the affected version or commit, and the impact you expect. This is a small project, so please allow some time for a response, and give us a reasonable window to fix the issue before disclosing it publicly.

## Security model in brief

Floq is designed for **one owner running their own server**, optionally shared with a few people they trust. The full model is in [`runtime/README.md`](runtime/README.md#security-model). The points that matter for reports:

- **Sandboxed agents.** Each session runs as an unprivileged user in a bubblewrap sandbox (own PID/IPC/UTS namespaces, only that user's home mounted, read-only system directories, no capabilities, `no-new-privs`). The runtime container is not a hardened boundary by itself: it needs `SYS_ADMIN`, `SETUID`, `/dev/fuse` and relaxed AppArmor for FUSE and bubblewrap, and it uses a custom seccomp profile. Sandboxes run in per-user network namespaces by default (see below); with `FLOQ_NETNS=off` they share the container's network.
- **Approval flow.** Auto-approve is on by default for both providers (users can turn it off). Irreversible or outward actions by agents can require a real, user-issued approval in the app.
- **Encrypted data.** Provider logins, GitHub tokens, vault secrets are encrypted with AES-256-GCM using `FLOQ_ENCRYPTION_KEY`. Each user's home is a gocryptfs-encrypted volume, mounted only while the user has a terminal open. Secrets are write-only over the API. Secrets exposed to an agent can be read by that agent.
- **Accounts.** better-auth with scrypt password hashes, rate limits and 7-day sessions; signup is closed by default.
- **Per-user mkcert CA (HTTPS dev servers).** The image ships `mkcert` and `certutil`; each agent environment sets `CAROOT=~/.local/share/mkcert` and `TRUST_STORES=nss`, so `mkcert -install` creates a CA in that user's encrypted home and trusts it only in that user's own `~/.pki/nssdb` (which the user's shared agent Chromium reads). It is never installed system-wide (`/etc` and `/usr` are read-only) and never for another user; the CA key stays in the owner's home. Anyone with access to a user's sandbox can mint certificates their own browser trusts, which is the same trust boundary as the home itself.
- **Known limitations.** The Tauri window currently sets `"csp": null`; Windows installers are unsigned; the isolation has not been independently reviewed.

- **Host public address (hairpin).** Tenant namespaces reach "the host" through pasta, so the host's own public IP would expose every service published on it (other projects' databases, SSH, a deploy panel). The namespace firewall therefore drops the host's public addresses: set `FLOQ_HOST_PUBLIC_IPS` (comma-separated) on every multi-tenant host, and the runtime also auto-detects its egress address (`FLOQ_HOST_PUBLIC_IP_URL`, default api.ipify.org, refreshed every 5 minutes, rules re-applied on change). Residual risk: other addresses of the same machine or provider network that are neither configured nor detected (extra IPs, a floating IP different from the egress address, a neighbouring VM on the same private provider range outside the blocked RFC1918/CGNAT ranges) stay reachable; list them in `FLOQ_HOST_PUBLIC_IPS`, and still firewall services on the host itself. `scripts/netns-smoke.sh` with `SMOKE_HOST_PUBLIC_IP` checks it.
- **Browser network limits.** Per-user network namespaces are on by default (`FLOQ_NETNS=required`; the runtime refuses to start without them). With `FLOQ_NETNS=off` (single-tenant hosts only), the agent browser blocks loopback and private addresses for web pages and workers through a CDP interceptor, but cannot see WebSocket/WebTransport handshakes, so never run `FLOQ_NETNS=off` on multi-user hosts. The Chromium download in the image build is pinned by revision over HTTPS, not by a sha256. Session cookies do not survive a browser restart.
- **Chromium sandbox.** The agent browser tries Chromium's own namespace sandbox first. `FLOQ_BROWSER_SANDBOX=required` makes the browser refuse to start without it; the default `auto` falls back to `--no-sandbox` (the bubblewrap + per-user uid sandbox is then the only boundary) and logs `browser.chromium_sandbox_off` as a warning. On Ubuntu 23.10+/24.04 hosts (`kernel.apparmor_restrict_unprivileged_userns=1`) the sandbox needs the container to run under the `runtime/apparmor/floq-runtime` AppArmor profile instead of `unconfined` (`FLOQ_APPARMOR_PROFILE`); the profile only adds the `userns` permission. The setuid `chrome-sandbox` is never used. See `runtime/README.md`.
- **Browser cookie import.** Users can import cookies (Netscape cookies.txt, JSON exports) and bookmarks they exported themselves into the shared agent browser (Settings > Agents > Browser, or the Browser node). The file is uploaded over the authenticated API (5 MiB limit), parsed on the runtime, and only the parsed result is kept in memory for 10 minutes, per user and single use; it is never written to the host disk and neither file text nor cookie values are logged (counts only). Chosen cookies are applied through CDP by a helper inside that user's own sandbox, so they live only in the user's encrypted home. Imported sessions can be used by all of that user's agents ("agents act as you on those sites"); the UI says so. Users can list, remove per domain or clear everything. Floq never reads local Chrome/Edge/Firefox stores, and does not import Chromium profile folders (OS-keyring-encrypted blobs). Details: `docs/design/agent-browser.md` §A.13.

Reports about these documented limitations are welcome as hardening suggestions, but they are known and not treated as vulnerabilities by themselves.

## Operating a runtime safely

Keep PostgreSQL unpublished, serve the runtime over HTTPS only, use the strong generated secrets described in `runtime/.env.example`, back up `FLOQ_ENCRYPTION_KEY`, and do not host Floq for people you do not trust.
