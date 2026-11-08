# Contributing to Floq

Thanks for your interest. Floq is early (0.x) software; small, focused pull requests are easiest to review. For anything large, open an issue first so we can agree on the approach.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development setup

Prerequisites: Node.js 22, Rust (stable) and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your platform. Python 3 with Playwright is only needed for the optional `scripts/*.py` browser probes.

```bash
npm ci                 # app dependencies
npm run dev            # interface in a browser at http://localhost:1420
npm run tauri dev      # desktop app

cd runtime && npm ci   # runtime dependencies (separate project)
```

The runtime needs PostgreSQL and the variables in [`runtime/.env.example`](runtime/.env.example). Full agent sessions need FUSE and bubblewrap and are meant to run in the container; see [`runtime/README.md`](runtime/README.md).

## Checks to run before opening a PR

```bash
# App
npx tsc --noEmit -p .
npm run build
node --test scripts/dev/test-*.mjs

# Runtime
cd runtime
npm run typecheck
npm test               # builds, then node --import tsx --test test/*.test.mts

# Desktop shell (if you touched src-tauri/)
cd src-tauri && cargo check
```

Browser probes in `scripts/dev/` (`probe-*.py`, `verify-*.py`) run against `npm run dev` with synthetic API responses. Each file starts with a one-line description; set `FLOQ_UI_URL` if your dev server is not on the default port.

## Code style

- TypeScript is strict. Follow the surrounding code and the rules in [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/UX-CONTRACT.md`](docs/UX-CONTRACT.md) for UI work.
- `.editorconfig` and `.gitattributes` define whitespace and LF line endings. Do not reformat unrelated code.
- No secrets, personal data, customer names or absolute local paths in code, tests, fixtures or docs. Use neutral names such as "Acme" in fixtures.
- Add or update tests for behavior changes (runtime tests are `runtime/test/*.test.mts`, client tests are `scripts/dev/test-*.mjs`).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, optionally with a scope (`feat(ui): ...`). Keep the subject short and imperative.

## Pull request checklist

- [ ] The change is focused and described (what and why).
- [ ] `tsc`, `npm run build` and the relevant tests pass locally.
- [ ] New behavior has tests, or the PR explains why not.
- [ ] Docs (`README.md`, `runtime/README.md`, `.env.example`) are updated if behavior or configuration changed.
- [ ] No secrets, personal data or machine-specific paths were added.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
