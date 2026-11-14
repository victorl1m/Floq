# Notifications (`notify`) — shared design & contract

A third interaction primitive next to **approval** (yes/no gate, blocks the agent) and
**decision** (pick an option, agent waits). `notify` is **one-way: it never blocks the
agent and never requires a response.** If something needs yes/no it stays an approval; if
it needs a choice it stays a decision; `notify` is the one-way lane.

Approach 2 (chosen): the primitive **plus a persistent Notification Center**. Out of scope
this pass (Approach 3, later): OS/push delivery, per-type preferences, do-not-disturb,
folding approvals/decisions into the center.

## Notification object (DB row, REST body, and wire frame all share this shape)

```ts
type NotificationLevel = 'info' | 'success' | 'warning' | 'error';
type NotificationCategory =
  | 'release' | 'build' | 'agent' | 'cost' | 'security' | 'message' | 'system' | 'custom';

type NotificationAction = {
  kind: 'url' | 'canvas' | 'agent' | 'settings';
  target: string;   // url, canvas node id, session id, or settings section id
  label: string;    // button label, <= 40 chars
};

type Notification = {
  id: string;                 // uuid
  userId: string;
  projectId: string | null;
  sessionId: string | null;   // the agent that sent it, if any
  sessionName: string | null;
  level: NotificationLevel;
  category: NotificationCategory;
  title: string;              // one line, required, <= 120 chars, sanitized
  body: string | null;        // optional, <= 2000 chars, sanitized
  action: NotificationAction | null;  // optional 1-click deep-link
  createdAt: string;          // iso
  readAt: string | null;
};
```

Sanitize `title`/`body`/`action.label` like decisions do: reuse `approvalText.ts`
(`neutralizeApprovalMarker`, `foldLookalikes`) + strip control chars. No brackets in
title so an agent can never forge a `[FLOQ ...]` marker.

## Backend — `runtime/src/notifications.ts` (mirror `decisions.ts`)

- `class Notifications` with per-user subscribers, same subscribe pattern as `Decisions`/`Approvals`.
- Frames emitted to `subscribe(userId, fn)`:
  - `{ type: 'notification', notification: Notification }` on create
  - `{ type: 'notification-read', ids: string[] | 'all' }` on mark-read
  - `{ type: 'notification-cleared', ids: string[] | 'all' }` on clear
- Methods: `create(userId, input)` (persist + emit; **no waiter, no resolve**),
  `list(userId, {unreadOnly?, projectId?, limit?, before?})`, `markRead(userId, ids|'all')`,
  `clear(userId, ids|'all')`.
- Persistence: table `agent_notifications`, created with the codebase's
  `ADD COLUMN/CREATE TABLE IF NOT EXISTS` idempotent migration pattern in `db.ts`
  (nullable where the object allows null). Index on `(user_id, created_at desc)`.
  Must run fine on a DB without the collaboration schema (follow the recent
  `noCollaborationSchema` precedent — no hard FK that breaks boot).
- Retention: keep newest 500 per user; prune read notifications older than 30 days on write.
  Document the exact rule in the file.
- Wire into `server.ts`, following the **exact auth pattern decisions/approvals use**:
  - agent-authenticated create (the path the `floq` CLI hits, like `floq decision request`)
  - user-authenticated, org-scoped: `GET /v1/notifications` (list),
    `POST /v1/notifications/read`, `POST /v1/notifications/clear`
  - frames ride the same client push channel decisions/approvals already use — find how
    `Decisions.subscribe` reaches the browser and mirror it exactly.

## CLI — `runtime/image/floq.mts`

```
floq notify --title "..." [--body "..."] [--level info|success|warning|error]
            [--category release|build|agent|cost|security|message|system|custom]
            [--action-url URL --action-label "..."]   (or --action-canvas/-agent/-settings target)
```
Defaults: level `info`, category `custom`. Prints the created id. **Never waits.** Add the
one-line description of `notify` to the agent policy/help so agents know to prefer it over a
decision when no answer is needed.

## Frontend

- `NotificationsProvider` + hook subscribing to the `notification*` frames (mirror how
  `subagent-toaster.tsx` / `fallback-toaster.tsx` subscribe to their frames), holding the
  list + unread count.
- **Toaster** `notification-toaster.tsx`: transient toast per new notification, styled by
  `level` (icon + color). Auto-dismiss info/success (~5s); warning/error persist until
  dismissed. Optional action button. Respect reduced motion. Reuse the existing toaster
  look.
- **Notification Center**: a **bell icon with unread badge** in the window chrome (match the
  existing titlebar/sidebar chrome — builder's call). Panel: newest-first, grouped by day;
  each row = level icon, category tag, title/body, agent/project, relative time, optional
  action button, read/unread dot. "Mark all read", "Clear", filters by level/category/project.
  Acrylic-aware, light + dark, works 820–1920px.
- Deep-link actions: `url` → open external; `canvas` → focus that node; `agent` → focus that
  session; `settings` → open that settings section (reuse the Ctrl+K settings deep-link).
- Keep the existing ad-hoc toasters (subagent/fallback/cross-project/upload) working; route
  only NEW `notify` through the unified system. Unifying the old ones is a follow-up.

## Tests

- Runtime: `Notifications` create/list/markRead/clear, persistence idempotency (incl. no
  collaboration schema), sanitization, and that create never blocks/awaits. CLI arg parsing.
- Playwright: a new notification shows as a toast AND lands in the center; mark-read clears
  the badge; a level filter works; the action button fires its deep-link.
```
