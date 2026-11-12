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

- **Sandboxed agents.** Each session runs as an unprivileged user in a bubblewrap sandbox (own PID/IPC/UTS namespaces, only that user's home mounted, read-only system directories, no capabilities, `no-new-privs`). The runtime container is not a hardened boundary by itself: it needs `SYS_ADMIN`, `SETUID`, `/dev/fuse` and relaxed AppArmor for FUSE and bubblewrap, and it uses a custom seccomp profile. Sandboxes share the container's network.
- **Approval flow.** Auto-approve is on by default for both providers (users can turn it off). Irreversible or outward actions by agents can require a real, user-issued approval in the app.
- **Encrypted data.** Provider logins, GitHub tokens, vault secrets are encrypted with AES-256-GCM using `FLOQ_ENCRYPTION_KEY`. Each user's home is a gocryptfs-encrypted volume, mounted only while the user has a terminal open. Secrets are write-only over the API. Secrets exposed to an agent can be read by that agent.
- **Accounts.** better-auth with scrypt password hashes, rate limits and 7-day sessions; signup is closed by default.
- **Known limitations.** The Tauri window currently sets `"csp": null`; Windows installers are unsigned; the isolation has not been independently reviewed.

Reports about these documented limitations are welcome as hardening suggestions, but they are known and not treated as vulnerabilities by themselves.

## Operating a runtime safely

Keep PostgreSQL unpublished, serve the runtime over HTTPS only, use the strong generated secrets described in `runtime/.env.example`, back up `FLOQ_ENCRYPTION_KEY`, and do not host Floq for people you do not trust.
