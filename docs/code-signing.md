# Windows code signing (SignPath Foundation, free for open source)

Floq's Windows installer can be signed for free through the [SignPath Foundation](https://signpath.org/) OSS program. The certificate is issued to the SignPath Foundation, not to the maintainer, so SmartScreen reputation builds on that publisher name. Nothing is signed until you finish the steps below; without them `build-windows.yml` produces the unsigned installer as before.

## Why SignPath

| Option | Cost | Fit |
| --- | --- | --- |
| SignPath Foundation OSS | free | Real OV-style certificate, HSM-held key, GitHub Actions integration with origin verification, built for OSS. Needs an OSI license, a public repo and manual release approval. **Chosen.** |
| Azure Artifact Signing (ex Trusted Signing) | paid, per month | Needs a verified business or individual identity; not free. |
| Self-signed or own CA cert | free | Not trusted by Windows, SmartScreen still warns. |
| Commercial OV/EV cert | paid | Works, but the user wants no purchase. |

## Requirements (checked 2026-11, [signpath.org/terms](https://signpath.org/terms))

- OSI-approved license for all components, no commercial dual licensing, no proprietary code (Floq is MIT; see `NOTICE` for third-party bits).
- The signing team owns and maintains the public source repository; only binaries built from that source are signed; builds are automated and verifiable (GitHub-hosted runners).
- Roles: authors, reviewers, approvers; MFA for everyone on SignPath and the repo.
- Actively maintained and already released in the form to be signed; every release is manually approved.
- Product name and version metadata set and enforced in SignPath.
- Publish a "Code signing policy" with the attribution text and team roles on the home page and download page, plus a privacy statement.
- No privacy-compromising features, no system changes without warning, uninstall provided, no exploit or vulnerability-scanner features. Reputation is checked once at the start.

Floq points to review: the repository is currently private (the program needs it public), and the app talks only to the runtime you host. Check the privacy wording in the README policy section against that before applying.

## Steps for you

1. Make `victorl1m/Floq` public (the repo is OSS-ready: gitleaks over the full history found only test fixtures and a public GPG key pin; see below). Do this yourself in GitHub settings.
2. Turn on MFA for your GitHub and SignPath accounts.
3. Apply at <https://signpath.org/apply> with the repository URL, license, download page (GitHub Releases) and the Code signing policy section from `README.md`. Wait for approval.
4. In the SignPath web app (organization created by the program):
   - Add the trusted build system **GitHub.com** to the organization and link it to the project.
   - Create the project (slug e.g. `floq`) and an artifact configuration whose root element is `<pe-file>` with Authenticode signing, product name `Floq` and the product version restriction (`<pe-file product-name="Floq" ...>`). Use the same configuration for the exe and the installer, or make it a default one.
   - Signing policy `release-signing`: require approval by you (approver), allow only the origin repo `victorl1m/Floq` and the tag refs `refs/tags/v*`.
   - Create a CI user with submitter permission on that policy and generate its API token.
5. In GitHub: Settings > Secrets and variables > Actions.
   - Secret `SIGNPATH_API_TOKEN` = the CI user token.
   - Variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`; optional `SIGNPATH_SIGNING_POLICY_SLUG` (default `release-signing`) and `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`.
6. Cut a release: `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow sends the app exe, then the NSIS installer, to SignPath; approve each request in SignPath (two approvals per release; you may configure the policy so one approver does both). The published installer and `SHA256SUMS` are the signed files.

## How the workflow behaves

- Signing runs only on `v*` tag pushes and only if `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID` and `SIGNPATH_PROJECT_SLUG` are set. Pushes to main and pull requests always give unsigned builds, because the OSS policy needs a manual approval per request.
- Signed path: `tauri build --no-bundle`, sign `floq.exe`, `tauri bundle --bundles nsis` (installer embeds the signed exe), sign the installer, verify with `Get-AuthenticodeSignature`.
- The signing jobs use GitHub-hosted runners, as origin verification requires. `SHA256SUMS` and the build attestation are produced after signing.
- First signed tag: if `tauri bundle` or the SignPath artifact configuration needs adjusting, the run fails before publishing anything, so no half-signed release goes out.

## Required attribution

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

It must appear on the README (done, section "Code signing policy") and on the download page. Keep the team roles list there in sync with the SignPath permission groups.

## Repository hygiene check

`gitleaks git --redact` (v8.30.1) over 297 commits: 7 `generic-api-key` hits, all false positives (placeholder secrets in `runtime/test/*`, `scripts/test-plugin-settings.mjs`, and a public GPG key SHA-256 pin in `runtime/Dockerfile`). Re-run before going public if more history is added.
