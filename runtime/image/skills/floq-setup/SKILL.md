---
name: floq-setup
description: Optional. Copies Floq's agent workflow into the project's CLAUDE.md so teammates and non-Floq tools see it. Floq agents already get these rules at every launch, so use it only when the user asks to commit them to the repo. Run as /floq-setup.
---

# Floq setup

Inside Floq the workflow rules are injected into every session's system prompt on each start and resume, so this is not needed for Floq agents. Run it only when the user wants the rules in the repository.

1. Run `floq setup` in the project directory (add `--dry-run` to preview; add `--agents` when you are a Codex session, so AGENTS.md is written too).
2. Report its one-line result per file: `created`, `appended`, or `already set up`.
3. When it wrote something, follow the printed rules for the rest of this session (the file is only read at startup).
4. If a file is `already set up`, stop there. Do not open, edit, replace or re-type it.

Never write the block by hand: `floq setup` is idempotent and leaves all existing content untouched. Do not commit the change; tell the user so they can review the diff.
