# CLI project creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Let agents create arbitrary named projects without Git, with optional Git import.

**Architecture:** Share project creation behavior between authenticated app and agent routes. Extend managed project lifecycle without changing nullable database schema.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL.

**Spec:** docs/superpowers/specs/2026-11-05-cli-project-creation-design.md

## Global Constraints

- CLI: `floq project create --name NAME [--git-url URL]`.
- Plain project name is nonempty after trimming and at most 120 characters.
- Git remains optional; preserve URL deduplication and existing Git import callers.
- Authenticated identity only; preserve tenant isolation and deletion safeguards.
- No sidebar UI changes, dependencies, schema migration, commits, push or deploy.
- Worktree `/home/agent/.floq/projects/1151cd0e-3578-48c7-8816-0d0c82f16a7f/.tmp/cli-project-creation`; baseline `/home/agent/.floq/projects/1151cd0e-3578-48c7-8816-0d0c82f16a7f/.tmp/cli-project-baseline`; preserve unrelated edits.

## Review Focus

- Blank, malformed and oversized names must fail before allocating a directory.
- Concurrent plain projects with identical names remain distinct by UUID.
- Failed database registration removes only the new unregistered directory.
- Plain projects may acquire files or Git later; deletion must not silently lose files.
- Existing Git-only callers and authenticated user scoping remain compatible.

### Task 1: Shared non-Git project creation and agent CLI

**Files:** runtime/src/manager.ts, runtime/src/server.ts, runtime/image/floq.mts, runtime/image/floq-args.mts as needed; focused tests under runtime/test; runtime/README.md for CLI usage.

**Interfaces:** App `POST /v1/projects` and agent `POST /internal/projects/create` accept `{name?: string, gitUrl?: string}`. Without Git require a name; Git import keeps optional name. Return `{project: RuntimeProject}`. Keep existing `createProject(userId, profile, gitUrl, name?)` callers compatible; implement a shared input-validation/creation path or optional Git signature as appropriate to existing patterns.

- [x] Add meaningful failing manager, CLI and route tests for plain creation, name validation, tenant scoping, same-name concurrency, cleanup, deletion behavior and optional Git import.
- [x] Run new tests and record expected missing-feature failures.
- [x] Implement empty managed directory plus transactional project/Main workspace registration; preserve Git clone and dedup path.
- [x] Add app and internal route validation/delegation and strict CLI parsing/help/output. Add documentation examples.
- [x] Verify session binding to plain Main workspace, clear Git-isolation rejection, and safe plain project deletion status (including nonempty directories).
- [x] Run focused tests and runtime typecheck. Record commands and results, including unrelated failures.
- [x] Self-review and write report `/home/agent/.floq/projects/1151cd0e-3578-48c7-8816-0d0c82f16a7f/.tmp/cli-project-creation-report.md` listing exact changed files and tests. No commit; advisor integrates only feature delta and dispatches independent review.

## Progress

User approved design and execution. Implementer e3db9400-9d6a-4575-80f9-6ce3a2462844; reviewer 35e23e91-bae9-4a51-8a44-89c3cec11701. Isolated worktree includes shared in-progress baseline; compare feature delta against snapshot rather than HEAD.
