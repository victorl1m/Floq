# Claude swap fallback

Status: design, not implemented. Owner: runtime + frontend. Date: 2026-11-12.

When a Claude Code agent hits its plan usage limit, Floq moves it to a fallback so the work keeps going, and moves it back when the limit window resets.

Decided with the user:

- The chain is configurable in Settings. Every step is optional and the order can be changed: (1) another Claude account the user connected, (2) a lower Claude model (Opus → Sonnet → Haiku), (3) the Codex provider.
- Defaults: model downgrade ON. The other two steps are OFF.
- Swap-back happens automatically when the window resets.

File references are relative to the repo root. `runtime/src/...` is the Node runtime and `src/...` is the SPA.

---

## 0. Findings that shape the design (read first)

1. **A model downgrade does not help with the account-wide windows.** The usage API reports `five_hour` and `seven_day` per account, plus model-specific weekly windows `seven_day_opus` and `seven_day_sonnet` (`runtime/src/usage.ts:29-35`). The 5 h session limit and the overall weekly limit apply to every model on the account. When one of those is at 100 %, Sonnet is blocked too. The model step only helps when a **model-specific** window is exhausted, for example Opus weekly. With the default settings (model step only), the most common case, the 5 h limit, therefore has **no** fallback. The agent is paused and continues on its own at reset (§3.5), and the first time this happens Floq offers to turn on the account or Codex step (§6). The step-eligibility rules in §3.2 enforce this, so Floq never makes a pointless swap. This needs to be confirmed with a captured fixture (§9, T-1).
2. **Claude credentials are per user, not per agent.** Every Claude session of a user reads the same `~/.claude/.credentials.json` (`runtime/src/manager.ts` `writeClaude`, `distribute`). That makes the account step a **user-wide "active Claude account" switch**, not a per-agent one. This matches reality: a limit on account A blocks every agent on A. Per-agent accounts would need a per-session `CLAUDE_CONFIG_DIR`, which moves transcripts (`projects/`), settings, plugins and `.claude.json`, and would break `--resume`. That is deferred to v2 (§10).
3. **`syncBack` assumes one Claude account.** It adopts a credential that the CLI refreshed itself into the user's single `claude` row (`manager.ts` `syncBack`, `credentials.ts` `adopt`). With two accounts, a late CLI refresh of account A written after the file was switched to B would overwrite B's row with A's tokens. §8.3 fixes this by matching adopted credentials to an account by its profile `account.uuid`.
4. **The building blocks already exist:** transcript parsing (`runtime/src/turn.ts`), usage fetch per credential (`runtime/src/usage.ts`), a strict sleep+resume that keeps the conversation (`manager.ts` `restartSelf` → `sleepSession(waitForExit)` + `resumeOnce(strict)`), boot notices typed after a session is ready (`manager.ts` `readyFlow` / `bootNotices`), and long-message delivery through the inbox (`runtime/src/messageDelivery.ts`).

---

## 1. Terms

| Term | Meaning |
|---|---|
| **Account slot** | One connected Claude login. `primary` is the existing one. Extra slots are `acct_<8 hex>`. |
| **Active account** | The slot whose credential is currently written to the user's `~/.claude/.credentials.json`. |
| **Blocked scope** | What a limit blocks: `{ slot, window, family }`. `family` is `null` for account-wide windows (`five_hour`, `seven_day`, `seven_day_oauth_apps`), or `opus` / `sonnet` for model windows. |
| **Origin** | What the agent ran on before the first swap: `{ provider: "claude", model, slot }`. |
| **Fallback state** | Per-agent record of the current swap (`agent_sessions.fallback_state`, §7.1). |

---

## 2. Trigger detection

Floq swaps only on a **real block**: two independent signals, at least one of them structured and written by the CLI. Text the model produces never counts.

### 2.1 Signals

| # | Signal | Source | Trust |
|---|---|---|---|
| S1 | **Transcript API-error record.** When the API refuses a turn, Claude Code appends a synthetic assistant record to `~/.claude/projects/<slug>/<sessionId>.jsonl` with `isApiErrorMessage: true` and an error class (`error: "rate_limit"`). The text reads like "…usage limit reached…" / "You've hit your limit · resets 3pm". These fields are set by the CLI. The model cannot forge them, because model output only ends up in `message.content`. | `runtime/src/turn.ts` (new `claudeLimitEvent(records)`) | Strong |
| S2 | **Usage API confirms.** A forced `GET /api/oauth/usage` for the active slot shows a window with `usedPercent >= 100` and `resetsAt` in the future. | `UsageService` (new `get(userId, { force, slot })`) | Strong |
| S3 | **`StopFailure` hook** with matcher `rate_limit`, if the pinned CLI (2.1.319) supports it. A hook script (`/usr/local/bin/floq-limit-hook.mjs`) POSTs `{sessionId}` to `/v1/agent/limit` with `FLOQ_AGENT_TOKEN`. The script never sends a payload. The runtime re-reads the transcript itself. | `nativeSubagentBlock.ts` `claudeBlockSettings` (add hook, version-gated like `PERMISSION_HOOK_VERSION`) | Wake-up only |
| — | PTY text matching "usage limit" | — | **Never a trigger.** An agent that `cat`s this doc would trip it. At most it can be used as a hint to run the transcript check sooner. |

### 2.2 Rule

```
swap  ⇔  S1 (a new api-error record with a usage-limit class after the last real prompt, and turn status idle)
     AND (S2 confirms a window ≥ 100 % on the active slot
          OR S2 is unavailable (usage API 429/5xx) AND S1's text carries an explicit reset time)
```

- **Transient 429s are excluded.** Claude Code retries overload and RPM 429s by itself. They reach the transcript only after the retries are used up, and then S2 shows no window at 100 %, so no swap. Floq logs `fallback.unconfirmed` and does nothing.
- **"Opus limit reached, now using Sonnet"** is an informational CLI message, not an `isApiErrorMessage` record. It is ignored. If the CLI already downgraded by itself, Floq does nothing.
- **Extra usage (overage credits).** With `extra_usage` enabled and below its cap, the CLI is not blocked, so no S1 and no swap.
- **The blocked scope comes from S2.** Floq picks the exhausted window with the latest `resetsAt` (the binding one). If S2 is unavailable, the scope is `{family: null}` and the reset time is parsed from S1, with the timezone from the user's browser at render time only. The server stores UTC.
- **Detection timing.** On PTY `output` frames (debounced 2 s, like `updateNativeTitle`) and on S3, the runtime reads the transcript tail from a stored byte offset (at most 256 KiB). Cost: one `stat` and a small read per active Claude agent per debounce, and nothing while the agent is idle.
- **Proactive check at launch.** When a Claude agent is created or resumed while the cached usage for the active slot already shows a binding window at 100 %, the chain is applied **before** launch. No turn is wasted and nothing is retried.
- **No proactive swap mid-turn on the meter alone.** 99 % is not 100 %. A running turn is never cut short to save a few percent.

### 2.3 Debounce and loop guards

- One evaluation in flight per agent (coalesce map, same pattern as `resumeTasks`).
- A record is acted on once (dedupe by its `uuid` field).
- At most 4 swaps per agent per hour. Past that, the agent is parked (§3.5) with reason `fallback_loop`.
- If a step was applied and the **very next** turn hits a limit with the **same blocked scope**, the step is marked ineffective for that scope for this window, and the chain advances. This also catches the case where the assumption in §0.1 is wrong.

---

## 3. What happens to the running conversation

All swaps happen at **turn end**. S1 means the CLI already ended the turn and no tool is running. The swap path reuses `restartSelf`'s guarantees: `sleepSession(id, "usage-fallback", { waitForExit: true })`, then a strict resume, so the conversation is never forked or lost. The agent keeps its **Floq UUID**, canvas node, wires, inbox, parent/child links and approvals, because all of those are keyed on `agent_sessions.id`.

### 3.1 Chain evaluation

```
for step in effectiveChain(agent):          # user chain, minus the agent's override, in order
  if !step.enabled or !eligible(step, scope): continue
  apply(step); return
park(agent, scope)                           # nothing eligible
```

### 3.2 Eligibility

| Step | Eligible when |
|---|---|
| **Account** | Another slot is connected and not disconnected, and its forced usage shows the *same window* below 100 % (and, for a model window, the same family below 100 %). Slots are tried in the user's order. |
| **Model** | `scope.family` is not null, the agent's current model is in the ladder, and a lower ladder model exists whose family window is below 100 %. Account-wide scope means not eligible (§0.1). |
| **Codex** | Codex is connected, and its cached usage (`UsageService` codex windows) is below 100 % for both windows. |

Model ladder (configurable, defaults from `config.models.claude`, `runtime/src/config.ts:41-47`): `fable → opus → sonnet → haiku`. `opusplan` is treated as `opus`. A custom model id outside the ladder is not eligible for the model step.

### 3.3 Account step (same conversation, other credential)

1. Take the user-level account lock (in-process and a Postgres advisory lock, like the credential refresh in `credentials.ts:167-215`).
2. Refresh the target slot if due, then `writeClaude(handle, cred)` and the side-file `~/.claude/.floq-account` (`{"slot":"acct_…"}`, 0600, no secrets).
3. Set `user_settings.active_claude_slot`.
4. Restart the **triggering** agent with strict resume. Other Claude agents on the old slot are **not** interrupted. They will either pick up the new file when the CLI re-reads it, or hit the limit and go through this same path. That path then sees the slot already switched (an idempotent no-op swap) and simply restarts them.
5. Notice typed after ready (bootNotice, trusted): `[Floq] The Claude usage limit on your primary account was reached (resets Thu 15:00). You are now on <label>. Continue the task you were working on.`

The conversation continues as is. Transcripts live under `~/.claude/projects`, which is shared by every account in the user's sandbox, so `--resume <id>` works with the other credential.

### 3.4 Model step (same conversation, other model)

1. `UPDATE agent_sessions SET model = $new, fallback_state = … WHERE id = $1`.
2. Strict restart: `--resume <id> --model sonnet` (`providers.ts` `resumeArgs` already takes `row.model`).
3. Notice: `[Floq] Opus weekly limit reached (resets Mon 09:00). You are now on Sonnet. Continue the task you were working on.`

This is better than typing `/model sonnet` into the TUI: it is deterministic, it does not race the user's typing, and it leaves the row in a state that survives reboots.

### 3.5 Park (nothing eligible): pause and continue at reset

- `sleepSession(id, "usage-limit", { resumeOnBoot: false })`, with `fallback_state.parkedUntil = resetsAt`.
- The card shows `Paused · resumes 15:00`, and the user gets one toast (§6).
- The swap-back scheduler (§4) resumes the agent at reset with the notice `[Floq] Your usage limit reset. Continue the task you were working on.`
- The user can always resume by hand. That clears `parkedUntil`, and if the window is still blocked, the agent simply errors again in the TUI with no loop (§2.3).

### 3.6 Codex step (new conversation, handoff)

A Claude conversation cannot be resumed in Codex. The agent **keeps its row and UUID** and switches provider in place:

1. Build the handoff (§3.7) and write it as the user's uid, mode 0600, to `~/.floq/handoff/<sessionId>-<n>.md`.
2. `UPDATE agent_sessions SET provider='codex', model=$codexModel, provider_session_id=$prevCodexIdOrNull, fallback_state=…`. The Claude transcript stays on disk under the same id. `fallback_state.origin` stores provider `claude`, the model and the slot.
3. `sleepSession(waitForExit)`, then `launch(row, …, resume = prevCodexId != null)`.
   - First swap: a fresh Codex start. Its initial prompt (argv after `--`, which is how prompts are already passed) is: `[Floq] You are taking over a task from a Claude agent that hit its usage limit. Read ~/.floq/handoff/<file>.md first, then continue the work. Do not redo finished steps.`
   - Later swaps in the same agent: resume the earlier Codex conversation (`resume <codexId>`), with the handoff delivered as a notice (inbox if over 1500 chars).
4. Everything provider-specific already runs per launch: Codex home, trust args, managed `AGENTS.md` with the same composed system blocks, and native subagent blocking (`manager.ts` `launch`). `assertSelfRestartable` compares `row.provider` with the live provider, so a self-restart during the swap is refused cleanly.

Edge cases:
- **Worktree agents** stay in the same `cwd`, so Codex works on the same branch and checkout.
- **Subagent depth and limits are unchanged.** It is the same row, so `subagents.ts` accounting does not move.
- **The policy text** comes from `composeSystemBlocks` on every launch, so Codex gets the identical Floq policy.

### 3.7 Handoff content (deterministic, no LLM)

Claude is blocked, so the handoff is built by the runtime from local state. It needs no model call:

1. The original task: the first real user prompt (`turn.ts` prompt detection), capped at 4000 chars.
2. The last 3 real user prompts and the last assistant reply (`turn.ts` `reply`), each capped.
3. The latest `TodoWrite` list from the transcript, if present.
4. `git status --short` and `git diff --stat` of `cwd`, run as the user **inside the sandbox**, the same way worktree git runs (`docs/runtime-agents.md` §3).
5. Floq context: the agent's role, its parent UUID, the note and sticky names it is wired to (names only).
6. The path to the full transcript (`~/.claude/projects/<slug>/<id>.jsonl`), which Codex can read in the same sandbox if it needs more.

Total size is at most 20 000 chars. Secrets are not a new risk, because everything in the handoff already sits in the agent's own transcript and checkout in the same sandbox. Even so, the vault redaction used for log hygiene (24+ char token-like strings, `manager.ts:2214`) is applied to the excerpts.

The reverse direction (Codex → Claude on swap-back) uses the same builder over the Codex rollout (`turn.ts` already parses it).

---

## 4. Swap-back

### 4.1 Scheduler

- `FallbackScheduler` (new `runtime/src/fallback.ts`) holds a timer per `(userId, slot, window)` set to `resetsAt + 90 s ± 30 s jitter`. Timers are rebuilt at boot from `agent_sessions.fallback_state` and `user_settings.active_claude_slot`. They are not in-memory-only state.
- When a timer fires, Floq runs a forced usage fetch for the origin slot. If the window is now below 100 %, or its `resetsAt` has moved forward, the window has reset. Otherwise Floq retries in 5 min, then 15 min, for at most 2 h, then follows the new `resetsAt`.
- Usage-API backoff is respected: forced fetches still go through `UsageService`'s 5 min 429 backoff, and only one fetch per slot is in flight.

### 4.2 Per-agent swap-back (model and Codex steps, parked agents)

- **Never interrupt a turn.** Floq waits until the agent is idle (`turn.ts` status `idle` and no PTY output for 20 s), checked on output frames and every 30 s, and gives up after 24 h. An agent on Codex mid-task stays on Codex until it is idle.
- Model: restore `origin.model`, strict restart, and the notice `[Floq] Back on Opus (limit reset).` No "continue" is added when the agent was idle. Floq does not start work the agent had finished.
- Codex → Claude: build the handoff from the Codex rollout, set `provider='claude'`, `model=origin.model`, keep the Codex id in `fallback_state.codexSessionId`, strict-resume `--resume <row.id>`, then send the notice `[Floq] Back on Claude. While you were limited, a Codex agent continued this task: read ~/.floq/handoff/<file>.md.` The original Claude conversation resumes with full context, plus the summary of the delta.
- Parked: resume and send "continue" (§3.5).
- **User intent wins.** If the user changed the agent's model or provider by hand during the fallback, swap-back is cancelled for that agent and the badge is cleared. The user can also click **Keep** on the badge.

### 4.3 Account swap-back (user-wide)

When the primary slot's window resets, the scheduler writes the primary credential back to `~/.claude/.credentials.json` and sets `active_claude_slot = 'primary'`. Running agents are **not** restarted. They are not blocked, and the CLI picks up the file when it re-reads it. The next limit evaluation then starts from the primary account again. This order (primary first) keeps fallback accounts as reserve.

---

## 5. Settings UI

New group **"When Claude hits a usage limit"** in `src/components/settings/accounts-section.tsx` (Settings > LLM Providers), below the Claude accounts.

```
When Claude hits a usage limit
  [x] Keep agents working with a fallback                         (master switch)
  Order (drag ⋮⋮ to reorder)
   ⋮⋮ [x] Lower Claude model      Opus → Sonnet → Haiku   (only helps with model limits, e.g. Opus weekly)
   ⋮⋮ [ ] Another Claude account  Work (Max 5x) ▾          (needs a second account: Connect…)
   ⋮⋮ [ ] Codex                   GPT-6.1 Sol ▾            (new conversation with a handoff summary)
  [x] Switch back automatically when the limit resets
  If nothing is available: agents pause and continue at reset.
```

- Reordering: up/down buttons that are keyboard accessible, plus drag. Disabled steps keep their place.
- An unavailable step (no second account, Codex not connected) shows an inline **Connect** link that opens the existing dialogs (`claude-oauth-dialog.tsx`, `connect-provider-dialog.tsx`). It can be toggled on, but it is skipped until it is available.
- **Accounts section:** Claude gets "Add another Claude account" (the same server-side OAuth flow, `claudeOauth.ts`, with a `slot` parameter). Each row shows the label (editable, default = profile email local part), plan, the usage mini-meter and "Active" for `active_claude_slot`. Connecting an account whose profile `account.uuid` is already connected is refused ("This account is already connected").
- **Per-agent override:** the agent card menu gets **Usage-limit fallback ▸ Use default · Model only · Pause instead · Custom…**. "Custom" opens the same step list scoped to the agent. The account step is shown as "(account: user-wide)" and cannot be toggled per agent (§0.2). "Pause instead" means: when this agent hits a limit, park it, with no model or provider change. The same choice is available at recruit time (`floq subagent recruit --fallback default|model|pause`) so orchestrators can protect agents whose work must stay on Opus.
- **Usage meter** (`src/components/window/usage-meter.tsx`): the Claude item shows the active account label when it is not primary ("Claude · Work"), and the popover lists every slot's windows.

---

## 6. Notifications

| Event | Toast (sonner) | Card badge | Other |
|---|---|---|---|
| Swap applied | `Agent "X" hit the Opus weekly limit. Now on Sonnet until Mon 09:00.` [Undo] | amber `Fallback: Sonnet` / `Fallback: Codex` / `Fallback: Work account` | activity panel entry |
| Account switched | `Claude account switched to Work. Primary resets Thu 15:00.` (once per switch, not per agent) | each affected agent: `Fallback: Work account` | meter label |
| Parked | `Agent "X" paused: Claude 5h limit (resets 15:00). It will continue then.` + the first-time tip `Add a second Claude account or enable Codex to keep working →` | grey `Paused · 15:00` | attention / desktop notification channel, if the user enabled one |
| Swap-back | quiet: no toast, badge removed, activity entry `Back on Opus` | — | — |
| Chain loop / failure | error toast, persistent | red `Fallback failed` | log `fallback.failed` |

- **Badge tooltip/popover:** the reason (window and reset time), the origin (`was Opus`), and the buttons **Return now** (forces swap-back, which fails gracefully if still blocked) and **Keep** (cancels swap-back).
- **Undo** on the swap toast = Return now plus park.
- **Implementation:** `SessionSummary` (`runtime/src/types.ts`, `src/lib/runtime/types.ts`) gains `fallback: { kind: "model" | "account" | "codex" | "paused"; label: string; originLabel: string; resetsAt: string | null } | null`. That gets the badge to the card through the existing `state` frames, with no new channel. The badge is a new `src/components/canvas/fallback-badge.tsx`, rendered by `agent-node.tsx`. It does not touch `agent-canvas-page.tsx`, `store.tsx` or `node-message-bar.tsx`, which other agents are editing. Toasts come from a new runtime event `fallback` on the existing user event stream, handled in a small hook next to `subagent-toaster.tsx`.
- **Agents are told too:** the notice typed into the agent (§3) makes the swap visible in the agent's own conversation. The agent's **parent** gets an inbox message (`[Floq] Your subagent X switched to Sonnet (usage limit)`) so orchestrators can adjust. This is rate-limited to one per agent per window.

---

## 7. Data model

### 7.1 Schema (raw-pg migrations in `runtime/src/db.ts`)

```sql
-- multiple Claude accounts
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS slot TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS account_uuid TEXT;      -- from /api/oauth/profile, not a secret
-- replace PK/unique (user_id, provider) with (user_id, provider, slot); codex keeps slot='primary' only
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS usage_fallback JSONB;          -- null = defaults
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS active_claude_slot TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS fallback_override JSONB;      -- null = use default
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS fallback_state JSONB;         -- null = not swapped
```

`usage_fallback` (validated in `settings.ts`, the same style as the subagent limits):

```ts
interface UsageFallback {
  enabled: boolean;                                   // default true
  steps: Array<
    | { kind: "model"; enabled: boolean; ladder: string[] }          // default on, ["fable","opus","sonnet","haiku"]
    | { kind: "account"; enabled: boolean; slots: string[] }         // default off, slots ordered
    | { kind: "codex"; enabled: boolean; model: string | "auto" }    // default off
  >;                                                  // order = chain order; each kind exactly once
  swapBack: boolean;                                  // default true
}
```

`fallback_state`:

```ts
interface FallbackState {
  origin: { provider: "claude"; model: string | null; slot: string };
  current: { kind: "model" | "account" | "codex" | "paused"; model?: string; slot?: string };
  scope: { slot: string; window: string; family: "opus" | "sonnet" | null };
  resetsAt: string | null;           // UTC ISO
  since: string;
  swaps: string[];                   // timestamps, for the 4/h guard
  ineffective: string[];             // "model@seven_day_opus" etc. for this window
  codexSessionId?: string;           // to resume the same Codex conversation next time
  handoffs: string[];                // relative paths under ~/.floq/handoff
  keep?: boolean;                    // user clicked Keep
}
```

### 7.2 API

- `GET/PATCH /v1/settings` carries `usageFallback` (patch is validated).
- `POST /v1/sessions/:id/fallback` `{ action: "return" | "keep" | "override", override? }`, user auth only. Agents cannot call it (not under the agent-token routes).
- `POST /v1/oauth/claude/start?slot=new` / `finish` gets an optional `slot` and `label`. `DELETE /v1/providers/claude/:slot` disconnects one slot. Disconnecting the active slot switches the active slot to primary first.
- `POST /v1/agent/limit` (agent token, S3 wake-up only). The body is ignored except for the session id from the token.

---

## 8. Security

1. **Credentials never go in env or argv.** Every slot is stored like today: AES-GCM in `provider_credentials`. The AAD stays `<userId>:claude_oauth` for `primary` (no re-encryption of existing rows) and is `<userId>:claude_oauth:<slot>` for extra slots, so a row cannot be swapped to a different slot. The sandbox only ever gets the **active** slot's credential, written to `~/.claude/.credentials.json` as the user's uid with mode 0600 through the existing `writeCredFile`. Inactive slots never touch the disk. `CLAUDE_CODE_OAUTH_TOKEN` and similar env variables are not used. The model id in argv (`--model sonnet`) is not a secret.
2. **Per user.** Slots, settings, state and the scheduler are keyed by `user_id`. A swap only rewrites the owner's sandbox file. Organizations do not share accounts. Every query keeps a `user_id = $n` clause, like `credentials.ts`.
3. **`syncBack` attribution.** When the CLI rewrote the file, the runtime calls `/api/oauth/profile` with the found access token and adopts the credential into the slot whose `account_uuid` matches. If nothing matches, the credential is not adopted and Floq logs `credentials.adopt_unmatched` (key names only). This covers the race in §0.3.
4. **No new agent powers.** Agents cannot trigger a swap, choose an account or read another slot. `/v1/agent/limit` only makes the runtime re-read the transcript it already trusts. Override and return are user-session routes.
5. **Handoff files** are 0600 and owned by the user's uid, inside the user's own sandbox, and pruned after 7 days or when the session is deleted (`projectDelete.ts`, session delete). Token-like strings are redacted.
6. **Logging** covers slot ids, window ids, percentages and decisions. No tokens, emails or account uuids go into logs or notification bodies, and labels are user-chosen.
7. **Approvals are unaffected.** A swap changes the model and credentials, not permissions. The auto-approve flags still come from the profile per provider. When the user has `claudeAutoApprove` on and `codexAutoApprove` off, the Codex fallback runs with prompts. That is correct, and the toast says so ("Codex will ask for approvals").

---

## 9. Test plan

Unit tests use the runtime's test setup. UI tests use Playwright with Tauri APIs mocked (project rule).

| ID | Test | Kind |
|---|---|---|
| T-1 | **Capture real fixtures** with the pinned CLI 2.1.319: a 5 h block, an Opus-weekly block, a transient 429 after retries. Commit the redacted transcript tails and usage payloads. They confirm the S1 record shape and §0.1 (is Sonnet blocked under `five_hour`?). This is a blocker for detection code. | manual + fixtures |
| T-2 | `claudeLimitEvent`: detects S1. Ignores the same text in `message.content` of normal assistant records, in tool results and in user prompts. Ignores sidechain records. Dedupes by uuid. Survives partial lines. | unit (`turn.test.ts`) |
| T-3 | Trigger rule matrix: S1 only, S2 only, S1+S2, S1 + S2 unavailable with and without a reset time, transient 429, extra usage on. | unit |
| T-4 | Eligibility: account-wide scope skips the model step. The Opus window picks Sonnet. A blocked sonnet family skips to haiku. Codex at 100 % is skipped. Order is respected. Disabled steps are skipped. Per-agent `pause` parks. | unit (`fallback.test.ts`) |
| T-5 | Model swap: the row model is updated, launch args contain `--resume <id> --model sonnet`, a strict resume is used (no fresh-start fallback), and the notice is typed once after ready. | unit with fake driver (pattern of the existing manager tests) |
| T-6 | Codex swap: same UUID, provider flips, the handoff file has mode 0600 and the uid owner, the initial prompt is after `--`, and the second swap resumes the stored Codex id. Swap-back restores Claude and resumes `<row.id>`. | unit |
| T-7 | Account swap: the credentials file holds the B slot, `.floq-account` is written, other agents are not restarted, it is idempotent under concurrency (two agents trigger at once, one switch). AAD per slot, and a tampered slot fails to decrypt. | unit + db |
| T-8 | `syncBack` with two slots: a CLI refresh of A after the switch to B is adopted into A by `account_uuid`, and an unknown uuid is not adopted. | unit (profile endpoint mocked) |
| T-9 | Scheduler: timers rebuilt after restart from DB, jitter bounds, retry when not reset yet, waits for idle, gives up after 24 h, `keep` and manual model change cancel it, account swap-back writes primary. | unit with fake clock |
| T-10 | Loop guards: the same scope right after a step marks it ineffective and advances. More than 4 swaps per hour parks with `fallback_loop`. | unit |
| T-11 | Proactive check at launch: usage cached at 100 % applies the chain before the PTY starts. | unit |
| T-12 | Settings validation: each kind exactly once, unknown kinds and ladder ids rejected, null resets to defaults. | unit (`settings.test.ts`) |
| T-13 | UI: the settings group renders the defaults, reorders by keyboard, shows Connect for a missing second account, and persists through PATCH. Badge renders for each `fallback.kind`, its tooltip shows reset and origin, Return/Keep call the API. Swap toast appears once per event. Meter shows the active account label. | Playwright (`e2e/`) |
| T-14 | Security: no credential bytes in the session env, argv or logs during any swap (the env/argv snapshot from the fake driver is grepped for token fixtures). | unit |

---

## 10. Out of scope / v2

- Per-agent Claude accounts (a per-session `CLAUDE_CONFIG_DIR` with shared `projects/`). It needs a safe way to share transcripts and `.claude.json` without symlinks that atomic renames break.
- Codex-as-origin fallback (Codex → Claude when Codex hits its limit). The Codex rollout `rate_limits` events make it possible later with the same machinery.
- An LLM-written handoff summary (Haiku on another slot, if one is available). v1 stays deterministic.
- Proactive "save quota" policies (for example dropping to Sonnet at 90 %).

## 11. Rollout

1. Runtime: schema, `fallback.ts`, detection, model step, park and continue-at-reset, plus the minimal badge and toast. This alone fixes "an agent silently stops at the limit".
2. Multiple Claude accounts plus the account step (`syncBack` fix first).
3. Codex step plus handoff.
4. Settings UI polish, per-agent override, recruit flag, docs (`docs/runtime-agents.md` §4 "Auth" gets an "Accounts and fallback" subsection).

## 12. Implementation status (Nov 2026)

All four rollout phases are built; this section records where the code differs from the design above.

- **T-1 fixture captured offline** from real transcripts written by CLI 2.1.319 (`runtime/test/fixtures/claude-usage-limit-2.1.319.jsonl`, redacted). The real S1 record differs from §2.1: the CLI marks it with `isApiErrorMessage: true`, `apiError: "usage_limit_reached"`, a `<synthetic>` model, and `apiErrorParams.rate_limit_info { status: "rejected", rateLimitType, resetsAt (epoch seconds) }`. The window and the reset time are therefore structured, so S1 alone is enough (the "S1 carries an explicit reset time" branch of §2.2). The usage fetch (S2) gates swap-back and account eligibility, not detection. Captured types: `five_hour`, `seven_day` (both blocked every model). `seven_day_opus` / `seven_day_sonnet` could not be captured; they are matched by name (§0.1 stays unverified for those two). An unknown `apiError` class on a CLI error record logs `fallback.unknown_api_error` once.
- **Runtime:** `fallback.ts` (settings, pure `planFallback`, `FallbackService`: detection, model/account/Codex steps, park, per-agent reset timers and a user-level account timer rebuilt at boot, idle-gated swap-back, Return/Keep/override, launch-time check), `claudeAccounts.ts`, `handoff.ts`, `claudeLimitEvent` in `turn.ts`.
- **Accounts (§7/§8):** differs from the schema sketch. `provider_credentials(claude)` always holds the **active** slot's credential, so refresh, syncBack, usage and the sandbox file are unchanged. Reserve credentials live in the new `claude_accounts` table (AES-GCM, AAD `<user>:claude_oauth:<slot>`); the active slot has a metadata-only row. A switch exchanges the two inside one transaction with an advisory lock. `active_claude_slot`, `active_claude_since` and `claude_account_return` are on `user_settings`. syncBack attributes a rewritten credentials file by profile `account.uuid` (`adoptAttributed`: active / reserve / unmatched). Not written: the `~/.claude/.floq-account` side file (no consumer).
- **Codex step:** same row and UUID; `switchProvider` stops the process, flips provider and model, then starts Codex fresh with the handoff prompt (or resumes the earlier Codex conversation, the handoff arriving as a notice). Swap-back builds a handoff from the Codex reply, flips back and resumes the Claude conversation by the row id. The handoff has no `git diff --stat`, only the status list, and does not name wired notes (names only was optional).
- **Launch-time check:** model and account steps run before the process starts (`beforeLaunch`). Park and the Codex step are not applied there: an explicit start or resume by the user goes ahead and normal detection handles a block.
- **Per-agent override:** `fallback_override` column, `POST /v1/sessions/:id/fallback`, card header menu (Use default / Model only / Pause instead), and `floq recruit|subagent recruit --fallback default|model|pause`, applied by the server to the new agent only.
- **Safety sweep instead of S3:** the S3 `StopFailure` hook is not built. `manager.reap` asks the service to look at every live Claude agent each cycle; a transcript stat makes it free unless the file changed, so a limit record written without further terminal output is still found.
- **Parent notice:** a short typed notice to the parent (`manager.typeNotice`), one per agent per blocked window, for a model swap, an account switch, a Codex swap and a park.
- **Return now** is refused (`applied: false, reason: "still_limited"`) while the blocked window is still full; resuming a paused agent by hand always works. A chained account switch (A to B to C) keeps A as the way back; a manual "Make active" removes the automatic way back.
- **Credential safety on a switch:** the CLI's sandbox file is adopted first (`syncClaudeNow`), the active credential is re-read under the credential broker's advisory lock inside the switch transaction, and a renewed reserve token is persisted (compare-and-set) before the transaction. An account that cannot be identified when a rewritten file is adopted is retried, never dropped.
- **Not built:** handoff pruning on session delete (files older than 7 days are pruned at every write), `Undo` on the swap toast, detecting Codex's own limit, passing `--fallback` into create (it is applied right after recruit), a Connect link next to unavailable steps (an inline note says what is missing).
