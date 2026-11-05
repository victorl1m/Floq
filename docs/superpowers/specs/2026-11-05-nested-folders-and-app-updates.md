# Nested sidebar folders and automatic app updates

Status: Sidebar folder decisions approved and implementation completed in the current worktree, 2026-11-05. Desktop automatic updates remain pending; see the shared Floq note `nested-folders-app-updates`.

## Problem and users

Floq users need to organize larger project collections in nested sidebar folders. Desktop users need to receive app releases without manually finding and replacing installers. Desired depth and update automation policy are NEEDS CLARIFICATION.

## Existing behavior and scope decisions

- Sidebar folders already persist per user on the runtime, with ordered root entries, project membership, expansion state and conflict handling. Membership currently contains projects only; nesting extends this existing organization feature.
- Treat folders as sidebar organization; moving an item must not move filesystem directories or change project identity.
- Existing administrator update settings concern the runtime and bundled agent CLIs. This spec interprets “app updates” as the installed Floq desktop client; confirmation is NEEDS CLARIFICATION.
- Deliverable is a specification only. Implementation, release publication and deployment are outside this task.

## User stories

- As a user with many projects, I can group related folders within folders and find projects without changing their contents.
- As a desktop user, I can learn that an app update exists and complete the agreed update flow without losing my workspace.

## Numbered requirements

1. Users can create a folder inside another folder, rename it, expand/collapse it, and move folders and projects between supported levels and the root. Maximum depth and the required move controls are NEEDS CLARIFICATION.
2. Each item has a single location. Moving a folder retains its descendants and their order. Self-parenting and placement inside a descendant are rejected without losing the previous organization.
3. Existing flat layouts remain intact when nesting becomes available. Hierarchy, ordering and expansion survive reload and synchronize for the same user; conflicts must not silently remove projects or subtrees. Different users remain isolated.
4. Folder operations never delete project data or stop agents. Deleting a nonempty folder requires a defined descendant disposition before implementation: NEEDS CLARIFICATION.
5. Nested items remain identifiable and operable by keyboard and assistive technology; folder expansion exposes its state and hidden descendants cannot receive focus.
6. The desktop app discovers newer compatible releases automatically under an agreed trigger and schedule. Startup-only versus periodic checks, release channels, supported platforms and opt-out behavior are NEEDS CLARIFICATION.
7. Users can distinguish checking, current, update available, downloading, ready to install and failure states, and can retry a failed check/download. Exact visible states depend on the chosen automation policy.
8. Only authentic releases compatible with the installed platform/version may be installed. Invalid or incomplete downloads must leave the current installation usable.
9. Update installation/restart preserves saved workspace state. Whether downloads and installation happen automatically, whether restart requires consent, and treatment of active connections or unsaved work are NEEDS CLARIFICATION. No forced restart policy is assumed.
10. Desktop app updates must not implicitly update the remote runtime or agent CLIs. Runtime/client compatibility requirements are NEEDS CLARIFICATION.

## Acceptance criteria

- Create A / B / project P; collapse and reopen A; reload and sign in on another client as the same user. P retains its identity and nested location.
- Move B to root and back under A; descendants and their order remain intact. Attempt A under B while B is inside A: reject the move and retain the original tree.
- Load a pre-feature flat layout: names, membership, root order and project access remain unchanged. Concurrent edits and another user's account do not cause cross-user leakage or silently missing items.
- Complete supported folder actions using the keyboard; confirm accessible names, expansion state and focus behavior.
- Offer a newer compatible release through the test release source: the app discovers it without a manual check and completes the agreed download/install/restart policy. This case is blocked until requirement 6 and 9 decisions are resolved.
- Test offline checks, interrupted downloads, invalid authenticity and incompatible releases: show a recoverable outcome and retain a usable installed app.
- After an allowed update/relaunch, verify the reported version and saved workspace; verify the remote runtime and CLI versions were not changed by this flow.

## Relevant files (context, not mandated implementation)

- Sidebar: `src/components/sidebar/project-list.tsx`, `project-folder.tsx`, `canonical-project-list.tsx`.
- Layout persistence: `src/lib/project-folders.ts`, `project-folders-cache.ts`, `project-folders-sync.ts`, `use-project-folders-sync.ts`; `runtime/src/projectFolders.ts`, `runtime/src/server.ts`, `runtime/src/db.ts`.
- Desktop boundary: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`.
- Existing separate update controls: `src/components/settings/updates-group.tsx`, `runtime/src/updates.ts`.
- Release artifact production and distribution ownership: NEEDS CLARIFICATION; no release workflow is prescribed here.

## Out of scope

Filesystem folder management, project deletion, changes to runtime/CLI update behavior, implementation architecture or library selection, publishing releases, and deploying the app-debug image.

## Resolved folder decisions

- Maximum nesting depth: 8.
- Deleting a folder promotes its immediate children to its parent at the deleted folder's position.
- Older clients may flatten nested folders if they save a changed layout.
- These decisions were approved in Floq approval `KL2WDMCEUCKDMXNSSZMFXSCHDM`.

## Open questions

All NEEDS CLARIFICATION: nesting depth; move interaction and ordering rules; deletion disposition; whether “app” means desktop client; supported operating systems/channels; automatic check cadence; download/install/restart consent and deferral; unsaved-work handling; runtime compatibility; release distribution ownership.

## Handoff

- Status: foldering implemented; desktop updater remains pending configuration and release inputs.
- Artifacts: `docs/superpowers/specs/2026-11-05-nested-folders-and-app-updates.md`.
- Open questions: listed above; no user-approved decisions were inferred from feature names.
- Recommended next role: Specifier with the product owner to resolve questions, then Planner after approval.

## Implementation direction (2026-11-05)

The implementer review confirmed this is a coordinated persistence migration: the current client normalizer promotes every folder to root, and old clients replace the whole server document. A server-only change would therefore allow an old client to flatten a nested tree.

Proposed compatibility direction for implementation:

- Keep the existing `folders` name records and add an optional `children: Record<folderId, Array<{kind: "project" | "folder", id: string}>>` tree for folder contents. The existing `root` remains the ordered root list; existing `membership` remains accepted as the legacy project-only representation.
- Normalize legacy documents by converting each folder's `membership[folderId]` to project child entries. New writes emit `children`; when reading legacy data, preserve its project ordering and current root ordering.
- Make the client sync merge compare and merge the full tree as one layout unit. Keep the existing last local layout edit behavior, while folder names and expansion continue their current merge policy. Never merge membership and children as separate competing layouts.
- On old-client writes that omit `children`, retain the last server tree only when the submitted legacy layout has not explicitly changed; otherwise apply the legacy layout and flatten by user action. This policy requires a document version/schema marker or equivalent server-side detection and must be implemented before rollout.
- Permit arbitrary nesting up to a finite depth of 8. Reject unknown IDs, repeated placement, cycles, and over-limit child arrays. Moving/deleting a folder retains descendants; deleting a folder promotes its immediate children into its parent at the deleted folder's position.
- Render child entries recursively and route drag/drop through tree-aware operations. Maintain the existing per-user sync and expansion persistence.

Updater implementation remains blocked on trusted release inputs: Tauri updater public key, endpoint/template, supported target platforms, and release workflow ownership. Do not ship updater checks or configure a placeholder key/URL. The existing `@tauri-apps/plugin-updater` package-only change is preparatory and does not enable updates.

These are engineering proposals to unblock implementation, not user-approved product decisions. In particular, the depth limit, delete disposition, and legacy-client write policy still need product approval before implementation or release.
