## What and why

## How it was tested

- [ ] `npx tsc --noEmit -p .` and `npm run build`
- [ ] `node --test scripts/dev/test-*.mjs`
- [ ] Runtime: `npm run typecheck` and the relevant `runtime/test` suites (if the runtime changed)

## Checklist

- [ ] Focused change with a conventional commit title (`feat:`, `fix:`, `chore:` ...)
- [ ] Docs and `.env.example` updated if behavior or configuration changed
- [ ] No secrets, personal data or local absolute paths added
