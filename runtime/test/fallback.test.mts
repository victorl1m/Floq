import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type pg from "pg";
import { FallbackService, accountUsable, modelLabel, defaultUsageFallback, fallbackBadge, limitFamily, lowerModel, parseUsageFallback, planFallback, readUsageFallback, type FallbackAccounts, type FallbackHost, type FallbackState } from "../dist/fallback.js";
import { claudeLimitEvent } from "../dist/turn.js";

const fixture = readFileSync(new URL("./fixtures/claude-usage-limit-2.1.319.jsonl", import.meta.url), "utf8");
const lines = fixture.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const fiveHour = lines.find((r) => (r.apiErrorParams as { rate_limit_info: { rateLimitType: string } }).rate_limit_info.rateLimitType === "five_hour")!;
const weekly = lines.find((r) => (r.apiErrorParams as { rate_limit_info: { rateLimitType: string } }).rate_limit_info.rateLimitType === "seven_day")!;
const jl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (text: string) => ({ type: "user", isSidechain: false, uuid: "u" + text, message: { role: "user", content: text } });
/** A copy of a captured record with another window and a future reset time. */
function limit(rec: Record<string, unknown>, type: string, uuid: string, resetsAtSec = Math.floor(Date.now() / 1000) + 3600) {
  const info = { ...(rec.apiErrorParams as { rate_limit_info: object }).rate_limit_info, rateLimitType: type, resetsAt: resetsAtSec };
  return { ...rec, uuid, apiErrorParams: { rate_limit_info: info } };
}

test("T-1 fixture: captured CLI 2.1.319 records carry apiError, rate_limit_info and a synthetic model", () => {
  assert.ok(lines.length >= 2);
  for (const r of lines) {
    assert.equal(r.isApiErrorMessage, true);
    assert.equal(r.apiError, "usage_limit_reached");
    assert.equal((r.message as { model: string }).model, "<synthetic>");
  }
  const types = lines.map((r) => (r.apiErrorParams as { rate_limit_info: { rateLimitType: string } }).rate_limit_info.rateLimitType).sort();
  assert.deepEqual(types, ["five_hour", "seven_day"]);
});

test("T-2 claudeLimitEvent: detects the CLI record, with window and reset time", () => {
  const ev = claudeLimitEvent(jl(user("go"), limit(fiveHour, "five_hour", "e1", 1_900_000_000)));
  assert.equal(ev?.rateLimitType, "five_hour");
  assert.equal(ev?.resetsAt, new Date(1_900_000_000_000).toISOString());
  assert.equal(ev?.uuid, "e1");
});

test("T-2 claudeLimitEvent: model text, tool results, prompts and sidechains never match", () => {
  const quote = "You've hit your 5-hour limit · resets 4:20am (UTC)";
  const assistant = { type: "assistant", isSidechain: false, uuid: "a1", message: { model: "claude-opus", role: "assistant", content: [{ type: "text", text: quote }] } };
  const spoofed = { ...assistant, uuid: "a2", apiError: "usage_limit_reached" }; // missing isApiErrorMessage and rate_limit_info
  const toolResult = { type: "user", isSidechain: false, uuid: "t1", message: { role: "user", content: [{ type: "tool_result", content: JSON.stringify(fiveHour) }] } };
  const sidechain = { ...limit(fiveHour, "five_hour", "s1"), isSidechain: true };
  const notSynthetic = { ...limit(fiveHour, "five_hour", "s2"), message: { ...(fiveHour.message as object), model: "claude-opus" } };
  assert.equal(claudeLimitEvent(jl(user(quote), assistant, spoofed, toolResult, sidechain, notSynthetic)), null);
  assert.equal(claudeLimitEvent(jl(user("x"), { ...limit(fiveHour, "five_hour", "r"), apiErrorParams: { rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } } })), null);
});

test("T-2 claudeLimitEvent: a later real prompt clears the block; partial lines are ignored", () => {
  assert.equal(claudeLimitEvent(jl(limit(fiveHour, "five_hour", "e1"), user("continue"))), null);
  assert.equal(claudeLimitEvent('{"half":' + "\n" + jl(limit(weekly, "seven_day", "e2")))?.uuid, "e2");
});

test("T-4 plan: account-wide windows skip the model step and park", () => {
  const settings = defaultUsageFallback();
  const plan = planFallback({ settings, override: "default", event: { rateLimitType: "five_hour" }, model: "opus", state: null, now: Date.now() });
  assert.deepEqual(plan, { action: "park", reason: "no_step" });
  assert.deepEqual(planFallback({ settings, override: "default", event: { rateLimitType: "seven_day" }, model: "sonnet", state: null, now: Date.now() }), { action: "park", reason: "no_step" });
});

test("T-4 plan: Opus weekly picks Sonnet; Sonnet weekly then picks Haiku; a model below the block is not touched", () => {
  const settings = defaultUsageFallback();
  const now = Date.now();
  assert.deepEqual(planFallback({ settings, override: "default", event: { rateLimitType: "seven_day_opus" }, model: "opus", state: null, now }), { action: "model", model: "sonnet" });
  assert.deepEqual(planFallback({ settings, override: "default", event: { rateLimitType: "seven_day_opus" }, model: null, state: null, now }), { action: "model", model: "sonnet" });
  assert.deepEqual(planFallback({ settings, override: "default", event: { rateLimitType: "seven_day_sonnet" }, model: "sonnet", state: null, now }), { action: "model", model: "haiku" });
  assert.equal(lowerModel(["fable", "opus", "sonnet", "haiku"], "sonnet", "opus"), null);
  assert.equal(lowerModel(["fable", "opus", "sonnet", "haiku"], "haiku", "sonnet"), null);
  assert.equal(lowerModel(["opus", "sonnet"], "my-custom-model", "opus"), null);
  assert.equal(lowerModel(["fable", "opus", "sonnet", "haiku"], "opusplan", "opus"), "sonnet");
  assert.equal(limitFamily("seven_day"), null);
});

test("T-4 plan: disabled steps, the master pause override and the loop guard", () => {
  const now = Date.now();
  const off = defaultUsageFallback();
  off.steps[0]!.enabled = false;
  assert.deepEqual(planFallback({ settings: off, override: "default", event: { rateLimitType: "seven_day_opus" }, model: "opus", state: null, now }), { action: "park", reason: "no_step" });
  assert.deepEqual(planFallback({ settings: defaultUsageFallback(), override: "pause", event: { rateLimitType: "seven_day_opus" }, model: "opus", state: null, now }), { action: "park", reason: "pause_override" });
  const swaps = Array.from({ length: 4 }, (_, i) => new Date(now - i * 60_000).toISOString());
  const state = { origin: { provider: "claude", model: "opus" }, current: { kind: "model", model: "sonnet" }, scope: { window: "seven_day_opus", family: "opus" }, resetsAt: null, since: "", swaps, ineffective: [] } as FallbackState;
  assert.deepEqual(planFallback({ settings: defaultUsageFallback(), override: "default", event: { rateLimitType: "seven_day_opus" }, model: "sonnet", state, now }), { action: "park", reason: "fallback_loop" });
  assert.deepEqual(planFallback({ settings: defaultUsageFallback(), override: "default", event: { rateLimitType: "seven_day_opus" }, model: "sonnet", state: { ...state, swaps: [], ineffective: ["model@seven_day_opus"] }, now }), { action: "park", reason: "no_step" });
});

test("T-12 settings validation: each kind once, unknown kinds and ladder ids rejected, null/garbage reads as defaults", () => {
  const ok = defaultUsageFallback();
  assert.deepEqual(parseUsageFallback(JSON.parse(JSON.stringify(ok))), ok);
  const reordered = { ...ok, steps: [ok.steps[2], ok.steps[0], ok.steps[1]] };
  assert.equal(parseUsageFallback(reordered).steps[0]!.kind, "codex");
  assert.throws(() => parseUsageFallback({ ...ok, steps: [ok.steps[0], ok.steps[0], ok.steps[1]] }), /unique/);
  assert.throws(() => parseUsageFallback({ ...ok, steps: [ok.steps[0], ok.steps[1], { kind: "gpt", enabled: true }] }), /unknown/);
  assert.throws(() => parseUsageFallback({ ...ok, steps: [{ kind: "model", enabled: true, ladder: ["op us"] }, ok.steps[1], ok.steps[2]] }), /ladder/);
  assert.throws(() => parseUsageFallback({ ...ok, steps: [ok.steps[0]] }), /every step/);
  assert.throws(() => parseUsageFallback({ ...ok, swapBack: "yes" }), /swapBack/);
  assert.deepEqual(readUsageFallback(null), ok);
  assert.deepEqual(readUsageFallback({ nonsense: 1 }), ok);
  assert.equal(ok.steps.find((s) => s.kind === "model")!.enabled, true, "defaults: model downgrade on");
  assert.equal(ok.steps.filter((s) => s.enabled).length, 2, "defaults: model downgrade and the other Claude accounts on, Codex off");
  assert.equal(ok.swapBack, true);
});

test("badge: model and paused states, no state is no badge", () => {
  assert.equal(fallbackBadge(null), null);
  const base = { origin: { provider: "claude" as const, model: "opus" }, scope: { window: "seven_day_opus", family: "opus" as const }, resetsAt: "2026-11-16T09:00:00.000Z", since: "", swaps: [], ineffective: [] };
  assert.deepEqual(fallbackBadge({ ...base, current: { kind: "model", model: "sonnet" } }), { kind: "model", label: "Sonnet", originLabel: "Opus", resetsAt: base.resetsAt, keep: false });
  assert.equal(fallbackBadge({ ...base, current: { kind: "paused" } })?.kind, "paused");
});

// ---- service ----

interface Row { id: string; user_id: string; provider: string; model: string | null; state: string; title: string; fallback_state: FallbackState | null; fallback_override: { mode: string } | null; fallback_last_event: string | null; provider_session_id: string | null; parent_session_id: string | null }

function harness(opts: { parent?: string; blocked?: { window: string; resetsAt: string } | null; codexId?: string; failSwitch?: boolean; failResume?: boolean; failRestart?: boolean; stamp?: () => string | null; transcript: string; model?: string | null; live?: boolean; quiet?: number; idle?: boolean; usedPercent?: number; settings?: ReturnType<typeof defaultUsageFallback>; override?: string }) {
  const row: Row = { id: "a1", user_id: "u1", provider: "claude", model: opts.model === undefined ? "opus" : opts.model, state: "running", title: "t", fallback_state: null, fallback_override: opts.override ? { mode: opts.override } : null, fallback_last_event: null, provider_session_id: opts.codexId ?? null, parent_session_id: opts.parent ?? null };
  const calls: string[] = [];
  const notices: string[] = [];
  const user: { ret: { slot: string; window: string; resetsAt: string | null } | null } = { ret: null };
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT user_id, claude_account_return")) return { rows: user.ret ? [{ user_id: "u1", claude_account_return: user.ret }] : [] };
      if (sql.startsWith("SELECT claude_account_return")) return { rows: [{ claude_account_return: user.ret }] };
      if (sql.startsWith("UPDATE user_settings SET claude_account_return = $2")) { user.ret = JSON.parse(values[1] as string); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith("UPDATE user_settings SET claude_account_return = NULL")) { user.ret = null; return { rows: [], rowCount: 1 }; }
      if (sql.includes("fallback_state->'current'->>'kind' = 'account' AND fallback_state->>'keep'")) return { rows: row.fallback_state?.current.kind === "account" && row.fallback_state.keep ? [{ "?column?": 1 }] : [] };
      if (sql.includes("SET fallback_state = NULL WHERE user_id = $1")) { if (row.fallback_state?.current.kind === "account") row.fallback_state = null; return { rows: [], rowCount: 1 }; }
      if (sql.startsWith("SELECT")) return { rows: sql.includes("WHERE fallback_state IS NOT NULL") ? (row.fallback_state ? [row] : []) : [row] };
      if (sql.includes("SET model = $3, fallback_state = $4, fallback_last_event = $5")) { row.model = values[2] as string | null; row.fallback_state = JSON.parse(values[3] as string); row.fallback_last_event = values[4] as string; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET model = $3, fallback_state = $4 WHERE")) { row.model = values[2] as string | null; row.fallback_state = JSON.parse(values[3] as string); return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET fallback_last_event = $3 WHERE")) { row.fallback_last_event = values[2] as string; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET fallback_state = $3, fallback_last_event = $4")) { row.fallback_state = JSON.parse(values[2] as string); row.fallback_last_event = values[3] as string; return { rows: [], rowCount: 1 }; }
      if (sql.includes("AND model IS NOT DISTINCT FROM $4")) {
        const ok = row.model === (values[3] as string | null) && row.fallback_state !== null;
        if (ok) { row.model = values[2] as string | null; row.fallback_state = null; }
        return { rows: [], rowCount: ok ? 1 : 0 };
      }
      if (sql.includes("SET provider = 'claude', model = $3, fallback_state = NULL")) { row.provider = "claude"; row.model = values[2] as string | null; row.fallback_state = null; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET model = $3, fallback_state = NULL, fallback_last_event")) { row.model = values[2] as string | null; row.fallback_state = null; if (values[3]) row.fallback_last_event = values[3] as string; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET model = $3, fallback_state = NULL")) { row.model = values[2] as string | null; row.fallback_state = null; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET model = $3 WHERE")) { row.model = values[2] as string | null; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET fallback_state = NULL")) { row.fallback_state = null; return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET fallback_state = $3")) { row.fallback_state = JSON.parse(values[2] as string); return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET fallback_override")) { row.fallback_override = values[2] ? JSON.parse(values[2] as string) : null; return { rows: [], rowCount: 1 }; }
      throw new Error("unexpected query " + sql);
    },
  } as never as pg.Pool;
  const state = { live: opts.live ?? true, transcript: opts.transcript };
  const host: FallbackHost = {
    readTranscript: () => state.transcript,
    isLive: () => state.live,
    quietMs: () => opts.quiet ?? 30_000,
    isIdle: () => opts.idle ?? true,
    queueNotice: (_id, text) => { notices.push(text); },
    dropNotice: () => { notices.pop(); calls.push("dropNotice"); },
    transcriptStamp: () => (opts.stamp ? opts.stamp() : null),
    restart: async () => { calls.push("restart:" + row.model); if (opts.failRestart) throw new Error("restart failed"); },
    sleep: async (_id, reason) => { calls.push("sleep:" + reason); state.live = false; },
    notifyParent: async (_u, parentId, text) => { calls.push(`parent:${parentId}`); notices.push("PARENT " + text); },
    buildHandoff: async (i) => { calls.push(`handoff:${i.direction}:${i.n}`); return `/home/agent/.floq/handoff/${i.id}-${i.n}.md`; },
    switchProvider: async (_u, _id, to) => { calls.push(`switch:${to.provider}:${to.model}:${to.prompt ? "prompt" : ""}${to.notice ? "notice" : ""}`); if (opts.failSwitch) throw new Error("switch failed"); row.provider = to.provider; row.model = to.model; if (to.notice) notices.push(to.notice); if (to.prompt) notices.push("PROMPT " + to.prompt); },
    resume: async () => { if (opts.failResume) throw new Error("resume failed"); calls.push("resume"); state.live = true; },
  };
  let now = Date.now();
  const svc = new FallbackService(pool, host, async () => opts.settings ?? defaultUsageFallback(), { now: () => now, random: () => 0.5 });
  svc.usage = { claudeBlocked: async () => opts.blocked ?? null, claudeWindow: async () => (opts.usedPercent === undefined ? null : { usedPercent: opts.usedPercent, resetsAt: new Date(now + 60_000).toISOString() }) };
  return { row, user, calls, notices, svc, state, advance: (ms: number) => { now += ms; } };
}

test("T-5 model swap: row model updated, strict restart once, notice queued once, state saved", async () => {
  const h = harness({ transcript: jl(user("go"), limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.row.model, "sonnet");
  assert.deepEqual(h.calls, ["restart:sonnet"]);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!, /^\[Floq\] The Opus weekly limit reached.*You are now on Sonnet\. Continue the task/);
  assert.equal(h.row.fallback_state?.origin.model, "opus");
  assert.equal(h.row.fallback_state?.current.model, "sonnet");
  await h.svc.evaluate("a1", "u1"); // the same record is acted on once
  assert.deepEqual(h.calls, ["restart:sonnet"]);
  h.svc.stop();
});

test("5 h limit with default settings parks the agent (no pointless model swap) and keeps its model", async () => {
  const h = harness({ transcript: jl(user("go"), limit(fiveHour, "five_hour", "e1")) });
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["sleep:usage-limit"]);
  assert.equal(h.row.model, "opus");
  assert.equal(h.row.fallback_state?.current.kind, "paused");
  h.svc.stop();
});

test("no action while output is still flowing, for an expired record, or when the master switch is off", async () => {
  const busy = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), quiet: 100 });
  await busy.svc.evaluate("a1", "u1");
  assert.deepEqual(busy.calls, []);
  busy.svc.stop();
  const stale = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1", Math.floor(Date.now() / 1000) - 60)) });
  await stale.svc.evaluate("a1", "u1");
  assert.deepEqual(stale.calls, []);
  const off = defaultUsageFallback(); off.enabled = false;
  const disabled = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), settings: off });
  await disabled.svc.evaluate("a1", "u1");
  assert.deepEqual(disabled.calls, []);
  const text = harness({ transcript: jl({ type: "assistant", uuid: "z", message: { role: "assistant", model: "claude-opus", content: [{ type: "text", text: "You've hit your 5-hour limit" }] } }) });
  await text.svc.evaluate("a1", "u1");
  assert.deepEqual(text.calls, [], "model text is never a trigger");
});

test("per-agent 'pause' override parks instead of changing model", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), override: "pause" });
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["sleep:usage-limit"]);
  assert.equal(h.row.model, "opus");
  h.svc.stop();
});

test("T-10 same window blocked again right after a model step: step marked ineffective, agent parked", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.evaluate("a1", "u1");
  h.state.transcript = jl(limit(fiveHour, "seven_day_opus", "e2"));
  h.advance(60_000);
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["restart:sonnet", "sleep:usage-limit"]);
  assert.deepEqual(h.row.fallback_state?.ineffective, ["model@seven_day_opus"]);
  h.svc.stop();
});

test("T-9 swap-back restores the origin model with a notice, waits for idle, and is cancelled by a manual model change", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0; h.notices.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.equal(h.row.model, "opus");
  assert.equal(h.row.fallback_state, null);
  assert.deepEqual(h.calls, ["restart:opus"]);
  assert.deepEqual(h.notices, ["[Floq] Back on Opus (limit reset)."]);

  const manual = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await manual.svc.evaluate("a1", "u1");
  manual.row.model = "haiku"; // the user chose a model by hand during the fallback
  manual.calls.length = 0;
  await manual.svc.restore("a1", "u1", { force: false });
  assert.equal(manual.row.model, "haiku");
  assert.equal(manual.row.fallback_state, null, "badge cleared, no swap-back");
  assert.deepEqual(manual.calls, []);
  h.svc.stop(); manual.svc.stop();
});

test("swap-back off keeps the model (Return now still works); Keep cancels the swap-back", async () => {
  const noBack = defaultUsageFallback(); noBack.swapBack = false;
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), settings: noBack });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.equal(h.row.model, "sonnet");
  await h.svc.act("u1", "a1", "return");
  assert.equal(h.row.model, "opus");
  assert.deepEqual(h.calls, ["restart:opus"]);
  const k = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await k.svc.evaluate("a1", "u1");
  await k.svc.act("u1", "a1", "keep");
  k.calls.length = 0;
  await k.svc.restore("a1", "u1", { force: false });
  assert.equal(k.row.model, "sonnet");
  assert.deepEqual(k.calls, []);
  h.svc.stop(); k.svc.stop();
});

test("parked agent: the reset resumes it with a continue notice; a manual resume clears the pause", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(h.calls, ["resume"]);
  assert.deepEqual(h.notices, ["[Floq] Your usage limit reset. Continue the task you were working on."]);
  assert.equal(h.row.fallback_state, null);
  const m = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  await m.svc.evaluate("a1", "u1");
  await m.svc.userResumed("a1", "u1");
  assert.equal(m.row.fallback_state, null);
  h.svc.stop(); m.svc.stop();
});

test("T-9 reset timer still blocked: stays on the fallback and retries instead of swapping back", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), usedPercent: 100 });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  await (h.svc as unknown as { onReset(id: string, userId: string, attempt: number): Promise<void> }).onReset("a1", "u1", 0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.row.model, "sonnet");
  h.svc.stop();
});

test("T-9 boot rebuilds the reset timers from the database", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.evaluate("a1", "u1");
  h.svc.stop();
  const fresh = harness({ transcript: "" });
  fresh.row.fallback_state = h.row.fallback_state;
  await fresh.svc.start();
  assert.equal((fresh.svc as unknown as { timers: Map<string, unknown> }).timers.size, 1);
  fresh.svc.stop();
});

test("T-12 SettingsStore: usageFallback defaults, patch validation, persisted as JSON, null resets", async () => {
  const { SettingsStore } = await import("../dist/settings.js");
  const row: Record<string, unknown> = { user_id: "u1" };
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT * FROM user_settings")) return { rows: [row] };
      if (sql.startsWith("SELECT login")) return { rows: [] };
      if (sql.startsWith("INSERT INTO user_settings")) return { rows: [] };
      if (sql.startsWith("UPDATE user_settings")) { assert.match(sql, /usage_fallback = \$2/); row.usage_fallback = values[1] === null ? null : JSON.parse(values[1] as string); return { rows: [] }; }
      throw new Error("unexpected query " + sql);
    },
  } as never as pg.Pool;
  const store = new SettingsStore(pool, { gitCoauthor: "", encryptionKey: Buffer.alloc(32) } as never);
  assert.deepEqual((await store.get("u1")).usageFallback, defaultUsageFallback());
  const chain = defaultUsageFallback();
  chain.steps = [chain.steps[2]!, chain.steps[0]!, chain.steps[1]!];
  assert.deepEqual((await store.update("u1", { usageFallback: chain })).usageFallback, chain);
  await assert.rejects(store.update("u1", { usageFallback: { ...chain, steps: [chain.steps[0]!, chain.steps[0]!, chain.steps[1]!] } }), /unique/);
  assert.deepEqual((await store.update("u1", { usageFallback: null })).usageFallback, defaultUsageFallback());
});

// ---- reviewer findings on phase 1 ----

test("review 1: a manual resume keeps the handled-record dedupe, so the same limit record does not re-park the agent", async () => {
  const h = harness({ transcript: jl(user("go"), limit(fiveHour, "five_hour", "e1")) });
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["sleep:usage-limit"]);
  await h.svc.userResumed("a1", "u1");
  assert.equal(h.row.fallback_state, null);
  assert.equal(h.row.fallback_last_event, "e1");
  h.state.live = true; h.calls.length = 0;
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, [], "the same record is not acted on again");
  h.svc.stop();
});

test("review 1: a resume that fails at reset keeps the state and a retry timer (the agent is not stranded)", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), failResume: true });
  await h.svc.evaluate("a1", "u1");
  await assert.rejects(h.svc.restore("a1", "u1", { force: false }), /resume failed/);
  assert.equal(h.row.fallback_state?.current.kind, "paused");
  assert.equal((h.svc as unknown as { timers: Map<string, unknown> }).timers.size, 1, "retry timer armed");
  assert.ok(h.calls.includes("dropNotice"), "the queued notice is dropped");
  h.svc.stop();
});

test("review 2: swap to Sonnet, then a later block parks; the reset restores the origin model too", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.row.model, "sonnet");
  h.state.transcript = jl(limit(fiveHour, "five_hour", "e2"));
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.row.fallback_state?.current.kind, "paused");
  assert.equal(h.row.model, "sonnet");
  await h.svc.restore("a1", "u1", { force: false });
  assert.equal(h.row.model, "opus");
  assert.equal(h.row.fallback_state, null);
  h.svc.stop();
  // a model the user picked by hand while parked is kept
  const m = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await m.svc.evaluate("a1", "u1");
  m.state.transcript = jl(limit(fiveHour, "five_hour", "e2"));
  await m.svc.evaluate("a1", "u1");
  m.row.model = "haiku";
  await m.svc.restore("a1", "u1", { force: false });
  assert.equal(m.row.model, "haiku");
  m.svc.stop();
});

test("review 3: a failed restart keeps the swap-back timer and drops the queued notice", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), failRestart: true });
  await assert.rejects(h.svc.evaluate("a1", "u1"), /restart failed/);
  assert.equal((h.svc as unknown as { timers: Map<string, unknown> }).timers.size, 1);
  assert.deepEqual(h.notices, []);
  h.svc.stop();
});

test("review 4: an unchanged transcript stamp skips the read; a changed one is evaluated", async () => {
  let stamp = "1:100";
  const h = harness({ transcript: jl(user("hi")), stamp: () => stamp });
  await h.svc.evaluate("a1", "u1");
  h.state.transcript = jl(user("hi"), limit(fiveHour, "seven_day_opus", "e1"));
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, [], "same stamp: not even read");
  stamp = "2:300";
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["restart:sonnet"]);
  h.svc.stop();
});

test("review 5: an unknown usage window is not 'reset': one short retry, then the clock is trusted", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) }); // usage returns null
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  h.advance(400 * 24 * 3600_000); // past the reported reset: this is the at-reset path
  const onReset = (n: number) => (h.svc as unknown as { onReset(id: string, userId: string, attempt: number): Promise<void> }).onReset("a1", "u1", n);
  await onReset(0);
  assert.deepEqual(h.calls, [], "first look: unknown, wait");
  assert.equal(h.row.model, "sonnet");
  await onReset(1);
  assert.equal(h.row.model, "opus");
  h.svc.stop();
});

test("review 6: Return now pre-empts a swap-back that is waiting for idle", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), idle: false });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  const waiting = h.svc.restore("a1", "u1", { force: false });
  await new Promise((r) => setTimeout(r, 20));
  await h.svc.act("u1", "a1", "return");
  await waiting;
  assert.equal(h.row.model, "opus");
  assert.deepEqual(h.calls, ["restart:opus"]);
  h.svc.stop();
});

test("review 6: a model change made while waiting wins (conditional update, no overwrite)", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), idle: true });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  const realIdle = (h as unknown as { svc: object }).svc;
  void realIdle;
  // The user picks a model in the window between the last check and the final update.
  const pool = (h.svc as unknown as { pool: { query: (sql: string, v?: unknown[]) => Promise<unknown> } }).pool;
  const original = pool.query.bind(pool);
  pool.query = async (sql: string, v?: unknown[]) => { if (sql.includes("IS NOT DISTINCT FROM")) h.row.model = "haiku"; return original(sql, v); };
  await h.svc.restore("a1", "u1", { force: false });
  assert.equal(h.row.model, "haiku");
  assert.deepEqual(h.calls, [], "no restart, the user's model is kept");
  h.svc.stop();
});

test("review 7: ladders with full model ids are matched by family", () => {
  const ladder = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"];
  assert.equal(lowerModel(ladder, "claude-opus-4", "opus"), "claude-sonnet-4");
  assert.equal(lowerModel(ladder, "opus", "opus"), "claude-sonnet-4");
  assert.equal(lowerModel(ladder, "claude-sonnet-4", "sonnet"), "claude-haiku-4");
});

test("review 9: a badge action on an agent without a fallback says it did nothing", async () => {
  const h = harness({ transcript: "" });
  assert.deepEqual(await h.svc.act("u1", "a1", "return"), { applied: false, reason: "no_fallback" });
  assert.deepEqual(await h.svc.act("u1", "a1", "keep"), { applied: false, reason: "no_fallback" });
  assert.deepEqual(await h.svc.act("u1", "a1", "override", "pause"), { applied: true });
  h.svc.stop();
});

test("review 10: an unknown apiError class on a CLI error record is logged once (detection would otherwise stop silently)", async () => {
  const { log } = await import("../dist/logger.js");
  const seen: unknown[] = [];
  const original = log.warn;
  log.warn = ((event: string, fields?: unknown) => { seen.push([event, fields]); }) as typeof log.warn;
  try {
    const odd = { ...limit(fiveHour, "five_hour", "x1"), apiError: "plan_limit_exceeded_v2" };
    assert.equal(claudeLimitEvent(jl(odd)), null);
    claudeLimitEvent(jl(odd));
  } finally { log.warn = original; }
  assert.deepEqual(seen, [["fallback.unknown_api_error", { apiError: "plan_limit_exceeded_v2" }]]);
});


// ---- phase 2: account step ----

function fakeAccounts(opts: { active?: string; since?: number | null; usage?: Record<string, Array<{ id: string; usedPercent: number }> | null>; reserves?: string[] } = {}) {
  const st = { active: opts.active ?? "primary", since: opts.since ?? null, switches: [] as string[] };
  const labels: Record<string, string> = { primary: "Primary", acct_b0b0b0b0: "Work", acct_c1c1c1c1: "Spare" };
  const api: FallbackAccounts = {
    activeSlot: async () => st.active,
    activeSince: async () => st.since,
    reserveSlots: async (_u, order) => (opts.reserves ?? ["acct_b0b0b0b0"]).filter((x) => x !== st.active).sort((a, b) => (order.indexOf(a) + 1000) % 1000 - (order.indexOf(b) + 1000) % 1000).map((slot) => ({ slot, label: labels[slot]! })),
    list: async () => Object.entries(labels).map(([slot, label]) => ({ slot, label })),
    usageOf: async (_u, slot) => (opts.usage?.[slot] ?? null) as never,
    switchTo: async (_u, slot) => { const from = st.active; st.switches.push(slot); st.active = slot; st.since = Date.now(); return { from, to: slot, changed: from !== slot }; },
  };
  return { api, st };
}
const accountChain = () => { const c = defaultUsageFallback(); c.steps = [c.steps[1]!, c.steps[0]!, c.steps[2]!]; c.steps[0]!.enabled = true; return c; };
const okUsage = { acct_b0b0b0b0: [{ id: "five_hour", usedPercent: 10 }, { id: "seven_day", usedPercent: 30 }], primary: [{ id: "five_hour", usedPercent: 100 }] };

test("T-3 accountUsable: unknown usage is tried; a full account-wide/blocked window is not usable", () => {
  assert.equal(accountUsable(null, "five_hour"), true, "unknown usage (usage endpoint rate-limited) must not keep a free reserve idle");
  assert.equal(accountUsable([{ id: "five_hour", usedPercent: 99 } as never], "five_hour"), false, "99 % is exhausted in practice");
  assert.equal(accountUsable([{ id: "five_hour", usedPercent: 90 } as never], "five_hour"), true);
  assert.equal(accountUsable([{ id: "five_hour", usedPercent: 10 }, { id: "extra_usage", usedPercent: 100 }] as never, "spend_limit", "spend"), false, "an exhausted spend cap blocks despite plan room");
  assert.equal(accountUsable([{ id: "five_hour", usedPercent: 10 }, { id: "extra_usage", usedPercent: 100 }] as never, "five_hour"), true);
  assert.equal(accountUsable([{ id: "seven_day", usedPercent: 100 } as never], "five_hour"), false);
  assert.equal(accountUsable([{ id: "seven_day_opus", usedPercent: 100 } as never], "seven_day_opus"), false);
  assert.equal(accountUsable([{ id: "seven_day_opus", usedPercent: 100 } as never], "five_hour"), true);
});

test("T-4 account step: a 5 h block switches the account, restarts the agent with a notice, records the way back", async () => {
  const h = harness({ transcript: jl(user("go"), limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0"]);
  assert.deepEqual(h.calls, ["restart:opus"], "restarted once, model unchanged");
  assert.match(h.notices[0]!, /usage limit on Primary was reached.*You are now on Work\. Continue the task/);
  assert.equal(h.row.fallback_state?.current.kind, "account");
  assert.equal(h.row.fallback_state?.origin.slot, "primary");
  assert.equal(h.user.ret?.slot, "primary");
  assert.equal(h.user.ret?.window, "five_hour");
  assert.equal((h.svc as unknown as { accountTimers: Map<string, unknown> }).accountTimers.size, 1);
  h.svc.stop();
});

test("T-4 account step: skipped when the reserve account is also full; the agent parks", async () => {
  for (const usage of [{ acct_b0b0b0b0: [{ id: "five_hour", usedPercent: 100 }] }]) {
    const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
    const a = fakeAccounts({ usage }); h.svc.accounts = a.api;
    await h.svc.evaluate("a1", "u1");
    assert.deepEqual(a.st.switches, []);
    assert.deepEqual(h.calls, ["sleep:usage-limit"]);
    h.svc.stop();
  }
});

test("T-4 account step: unknown reserve usage (usage endpoint rate-limited) still switches to it", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: {} }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  assert.equal(a.st.switches.length, 1, "the reserve is tried instead of parking the agent");
  h.svc.stop();
});

test("T-4 account step: on by default (a 5 h block cannot be helped by a smaller model), and a per-agent 'Model only' override skips it", async () => {
  const off = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  const a1 = fakeAccounts({ usage: okUsage }); off.svc.accounts = a1.api;
  await off.svc.evaluate("a1", "u1");
  assert.deepEqual(a1.st.switches, ["acct_b0b0b0b0"], "the other account takes over with the default settings");
  const only = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain(), override: "model" });
  const a2 = fakeAccounts({ usage: okUsage }); only.svc.accounts = a2.api;
  await only.svc.evaluate("a1", "u1");
  assert.deepEqual(a2.st.switches, []);
  assert.deepEqual(only.calls, ["sleep:usage-limit"]);
  off.svc.stop(); only.svc.stop();
});

test("T-7 account switch is idempotent: an older record than the switch only restarts the agent (no second switch)", async () => {
  const rec = limit(fiveHour, "five_hour", "e1");
  (rec as Record<string, unknown>).timestamp = new Date(Date.now() - 120_000).toISOString();
  const h = harness({ transcript: jl(user("go"), rec), settings: accountChain() });
  const a = fakeAccounts({ active: "acct_b0b0b0b0", since: Date.now() - 60_000, usage: okUsage }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, []);
  assert.deepEqual(h.calls, ["restart:opus"]);
  assert.match(h.notices[0]!, /You are now on Work/);
  assert.equal(h.row.fallback_state, null, "no way back exists (manual switch): no badge that nothing would ever clear");
  assert.equal(h.row.fallback_last_event, "e1");
  // with a recorded way back the agent does carry the badge
  const m = harness({ transcript: jl(user("go"), rec), settings: accountChain() });
  const b = fakeAccounts({ active: "acct_b0b0b0b0", since: Date.now() - 60_000, usage: okUsage }); m.svc.accounts = b.api;
  m.user.ret = { slot: "primary", window: "five_hour", resetsAt: new Date(Date.now() + 3600_000).toISOString() };
  await m.svc.evaluate("a1", "u1");
  assert.equal(m.row.fallback_state?.current.kind, "account");
  h.svc.stop(); m.svc.stop();
});

test("T-9 account swap-back: restores the primary login user-wide, clears badges, restarts nobody", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0", "primary"]);
  assert.equal(h.user.ret, null);
  assert.equal(h.row.fallback_state, null);
  assert.deepEqual(h.calls, []);
  h.svc.stop();
});

test("T-9 account swap-back is cancelled by Keep and by turning swap-back off (Return now still works)", async () => {
  const kept = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); kept.svc.accounts = a.api;
  await kept.svc.evaluate("a1", "u1");
  await kept.svc.act("u1", "a1", "keep");
  await kept.svc.restoreAccount("u1", { force: false });
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0"]);
  await kept.svc.act("u1", "a1", "return");
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0", "primary"]);
  const noBack = accountChain(); noBack.swapBack = false;
  const n = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: noBack });
  const b = fakeAccounts({ usage: okUsage }); n.svc.accounts = b.api;
  await n.svc.evaluate("a1", "u1");
  await n.svc.restoreAccount("u1", { force: false });
  assert.deepEqual(b.st.switches, ["acct_b0b0b0b0"]);
  kept.svc.stop(); n.svc.stop();
});

test("T-10 same window blocked again right after an account switch: step ineffective, agent parked", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  const later = limit(fiveHour, "five_hour", "e2");
  (later as Record<string, unknown>).timestamp = new Date(Date.now() + 90_000).toISOString(); // written after the switch
  h.state.transcript = jl(later);
  h.advance(60_000);
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0"]);
  assert.deepEqual(h.calls, ["restart:opus", "sleep:usage-limit"]);
  assert.deepEqual(h.row.fallback_state?.ineffective, []);
  assert.deepEqual(h.row.fallback_state?.tried?.map((t) => t.slot).sort(), ["acct_b0b0b0b0", "primary"], "both blocked slots are remembered, none is left to try");
  h.svc.stop();
});

test("T-9 boot rebuilds the user-level account swap-back timer", async () => {
  const h = harness({ transcript: "" });
  h.user.ret = { slot: "primary", window: "five_hour", resetsAt: new Date(Date.now() + 3600_000).toISOString() };
  await h.svc.start();
  assert.equal((h.svc as unknown as { accountTimers: Map<string, unknown> }).accountTimers.size, 1);
  h.svc.stop();
});


// ---- phase 3: Codex step ----

const codexChain = (order: Array<"model" | "account" | "codex"> = ["codex", "model", "account"]) => {
  const base = defaultUsageFallback();
  const c = { ...base, steps: order.map((k) => base.steps.find((st) => st.kind === k)!) };
  c.steps.find((st) => st.kind === "codex")!.enabled = true;
  return c;
};
const codexPort = (usable = true) => ({ usable: async () => usable, defaultModel: async () => "gpt-auto" });

test("T-6 codex step: same agent flips to Codex with the handoff as the first prompt; state records origin and file", async () => {
  const h = harness({ transcript: jl(user("go"), limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["handoff:to-codex:1", "switch:codex:gpt-auto:prompt"]);
  assert.match(h.notices[0]!, /^PROMPT \[Floq\] You are taking over a task from a Claude agent.*Read \/home\/agent\/\.floq\/handoff\/a1-1\.md first.*Do not redo finished steps/);
  assert.equal(h.row.provider, "codex");
  assert.equal(h.row.fallback_state?.current.kind, "codex");
  assert.equal(h.row.fallback_state?.origin.model, "opus");
  assert.deepEqual(h.row.fallback_state?.handoffs, ["/home/agent/.floq/handoff/a1-1.md"]);
  assert.equal(fallbackBadge(h.row.fallback_state)?.kind, "codex");
  h.svc.stop();
});

test("T-6 codex step: a configured Codex model wins over auto; an existing Codex conversation resumes with a notice instead of a prompt", async () => {
  const chain = codexChain();
  (chain.steps.find((st) => st.kind === "codex") as { model: string }).model = "gpt-pinned";
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: chain, codexId: "codex-conv-1" });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["handoff:to-codex:1", "switch:codex:gpt-pinned:notice"]);
  assert.match(h.notices[0]!, /Claude hit its usage limit again and this task is back with you/);
  h.svc.stop();
});

test("T-4 codex step: skipped when Codex is not usable, with 'Model only' override, and when the step is off; order is respected", async () => {
  const unusable = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  unusable.svc.codex = codexPort(false);
  await unusable.svc.evaluate("a1", "u1");
  assert.deepEqual(unusable.calls, ["sleep:usage-limit"]);
  const only = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain(), override: "model" });
  only.svc.codex = codexPort();
  await only.svc.evaluate("a1", "u1");
  assert.deepEqual(only.calls, ["sleep:usage-limit"]);
  const off = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  off.svc.codex = codexPort();
  await off.svc.evaluate("a1", "u1");
  assert.deepEqual(off.calls, ["sleep:usage-limit"]);
  // order: with model first, an Opus-weekly block downgrades instead of going to Codex; with codex first it goes to Codex
  const modelFirst = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), settings: codexChain(["model", "codex", "account"]) });
  modelFirst.svc.codex = codexPort();
  await modelFirst.svc.evaluate("a1", "u1");
  assert.deepEqual(modelFirst.calls, ["restart:sonnet"]);
  const codexFirst = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), settings: codexChain(["codex", "model", "account"]) });
  codexFirst.svc.codex = codexPort();
  await codexFirst.svc.evaluate("a1", "u1");
  assert.equal(codexFirst.row.provider, "codex");
  for (const x of [unusable, only, off, modelFirst, codexFirst]) x.svc.stop();
});

test("T-6 codex swap-back: back to Claude with the origin model, the handoff-back notice, state cleared, same agent", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0; h.notices.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(h.calls, ["handoff:to-claude:2", "switch:claude:opus:notice"]);
  assert.match(h.notices[0]!, /Back on Claude.*a Codex agent continued this task: read \/home\/agent\/\.floq\/handoff\/a1-2\.md/);
  assert.equal(h.row.provider, "claude");
  assert.equal(h.row.model, "opus");
  assert.equal(h.row.fallback_state, null);
  h.svc.stop();
});

test("T-9 codex swap-back: waits for idle, user's own provider change cancels it, Keep stops it, a failed switch keeps the state", async () => {
  const busy = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain(), idle: false });
  busy.svc.codex = codexPort();
  await busy.svc.evaluate("a1", "u1");
  busy.calls.length = 0;
  const waiting = busy.svc.restore("a1", "u1", { force: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(busy.calls, [], "still waiting for an idle agent");
  await busy.svc.act("u1", "a1", "return"); // Return now pre-empts the wait
  await waiting;
  assert.equal(busy.row.provider, "claude");

  const manual = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  manual.svc.codex = codexPort();
  await manual.svc.evaluate("a1", "u1");
  manual.row.provider = "shell"; // changed by hand
  manual.calls.length = 0;
  await manual.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(manual.calls, []);
  assert.equal(manual.row.fallback_state, null);

  const kept = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  kept.svc.codex = codexPort();
  await kept.svc.evaluate("a1", "u1");
  await kept.svc.act("u1", "a1", "keep");
  kept.calls.length = 0;
  await kept.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(kept.calls, []);
  assert.equal(kept.row.provider, "codex");

  const failing = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  failing.svc.codex = codexPort();
  await failing.svc.evaluate("a1", "u1");
  (failing as unknown as { svc: { host: FallbackHost } }).svc.host.switchProvider = async () => { throw new Error("switch failed"); };
  await assert.rejects(failing.svc.restore("a1", "u1", { force: false }), /switch failed/);
  assert.equal(failing.row.fallback_state?.current.kind, "codex", "state kept so the swap-back retries");
  for (const x of [busy, manual, kept, failing]) x.svc.stop();
});

test("T-6 codex swap-back of a sleeping agent flips the row without waking it", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  h.state.live = false; h.calls.length = 0; h.notices.length = 0;
  await h.svc.restore("a1", "u1", { force: false });
  assert.deepEqual(h.calls, [], "no handoff, no launch");
  assert.equal(h.row.provider, "claude");
  assert.equal(h.row.model, "opus");
  assert.match(h.notices[0]!, /Back on Claude/);
  h.svc.stop();
});

test("T-10 same window blocked again right after the Codex step: marked ineffective (cannot happen on Codex, but the guard holds)", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  h.row.provider = "claude"; // e.g. the user flipped it back and hit the same limit
  const later = limit(fiveHour, "five_hour", "e2");
  (later as Record<string, unknown>).timestamp = new Date(Date.now() + 90_000).toISOString();
  h.state.transcript = jl(later);
  h.calls.length = 0;
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.row.fallback_state?.ineffective, ["codex@five_hour"]);
  assert.deepEqual(h.calls, ["sleep:usage-limit"]);
  h.svc.stop();
});

test("T-14 security: no credential bytes in notices, prompts, handoff names or state (token fixtures grepped)", async () => {
  const token = "sk-ant-oat01-SECRETSECRETSECRETSECRET1234567890";
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain() });
  h.svc.codex = codexPort();
  await h.svc.evaluate("a1", "u1");
  const dump = JSON.stringify([h.calls, h.notices, h.row.fallback_state]);
  assert.ok(!dump.includes(token) && !dump.includes("accessToken") && !dump.includes("refreshToken"));
  h.svc.stop();
});


// ---- launch-time check, recruit flag ----

const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

test("T-11 launch check: a full Opus window downgrades the model BEFORE the process starts (row, state, timer, notice)", async () => {
  const h = harness({ transcript: "", blocked: { window: "seven_day_opus", resetsAt: inOneHour() } });
  const pre = await h.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" });
  assert.equal(pre?.model, "sonnet");
  assert.match(pre!.notice!, /Opus weekly limit is reached.*You are on Sonnet/);
  assert.equal(h.row.model, "sonnet");
  assert.equal(h.row.fallback_state?.current.model, "sonnet");
  assert.equal(h.row.fallback_state?.origin.model, "opus");
  assert.equal((h.svc as unknown as { timers: Map<string, unknown> }).timers.size, 1, "swap-back timer set");
  assert.deepEqual(h.calls, [], "nothing was restarted: the agent has not started yet");
  assert.equal(await h.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "sonnet" }), null, "already on a fallback: nothing more");
  h.svc.stop();
});

test("T-11 launch check: an account-wide full window switches the account first when that step is on; otherwise nothing (the user's start goes ahead)", async () => {
  const h = harness({ transcript: "", blocked: { window: "five_hour", resetsAt: inOneHour() }, settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); h.svc.accounts = a.api;
  const pre = await h.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" });
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0"]);
  assert.equal(pre?.model, "opus");
  assert.match(pre!.notice!, /You are on Work/);
  assert.equal(h.user.ret?.slot, "primary");
  assert.equal(h.row.fallback_state?.current.kind, "account");
  const plain = harness({ transcript: "", blocked: { window: "five_hour", resetsAt: inOneHour() } });
  assert.equal(await plain.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" }), null);
  assert.equal(plain.row.model, "opus");
  h.svc.stop(); plain.svc.stop();
});

test("T-11 launch check: no block, 'Pause instead', master switch off, or a Codex agent: nothing changes", async () => {
  const none = harness({ transcript: "" });
  assert.equal(await none.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" }), null);
  const blocked = { window: "seven_day_opus", resetsAt: inOneHour() };
  const pause = harness({ transcript: "", blocked, override: "pause" });
  assert.equal(await pause.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" }), null);
  const off = defaultUsageFallback(); off.enabled = false;
  const disabled = harness({ transcript: "", blocked, settings: off });
  assert.equal(await disabled.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "claude", model: "opus" }), null);
  const codex = harness({ transcript: "", blocked });
  assert.equal(await codex.svc.beforeLaunch({ id: "a1", user_id: "u1", provider: "codex", model: "gpt" }), null);
  for (const x of [none, pause, disabled, codex]) { assert.equal(x.row.model, "opus"); x.svc.stop(); }
});

test("recruit flag: --fallback reaches the recruit payload only when given; per-agent override persists and is user-validated", async () => {
  const { buildRecruitPayload, parseArgs } = await import("../dist/image/floq-args.mjs");
  const given = parseArgs(["Builder", "--fallback", "pause"]);
  assert.equal((buildRecruitPayload(given.positional, given.named) as { fallback?: string }).fallback, "pause");
  const omitted = parseArgs(["Builder"]);
  assert.equal("fallback" in buildRecruitPayload(omitted.positional, omitted.named), false);
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  await h.svc.act("u1", "a1", "override", "pause");
  assert.deepEqual(h.row.fallback_override, { mode: "pause" });
  await assert.rejects(h.svc.act("u1", "a1", "override", "everything" as never), /override must be/);
  await h.svc.act("u1", "a1", "override", "default");
  assert.equal(h.row.fallback_override, null);
  h.svc.stop();
});


// ---- reviewer 2 and advisor round ----

test("review2-4 chained account switch keeps the FIRST origin; switching back to it ends the fallback; a manual switch clears the way back", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: { ...okUsage, acct_c1c1c1c1: [{ id: "five_hour", usedPercent: 5 }] }, reserves: ["acct_b0b0b0b0", "acct_c1c1c1c1"] }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.user.ret?.slot, "primary");
  const later = limit(fiveHour, "seven_day", "e2");
  (later as Record<string, unknown>).timestamp = new Date(Date.now() + 90_000).toISOString();
  h.state.transcript = jl(later);
  h.advance(60_000);
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, ["acct_b0b0b0b0", "acct_c1c1c1c1"]);
  assert.equal(h.user.ret?.slot, "primary", "the way back still leads to the primary, not to the middle account");
  assert.equal(h.user.ret?.window, "five_hour");
  await h.svc.accountChangedByUser("u1");
  assert.equal(h.user.ret, null);
  assert.equal(h.row.fallback_state, null, "badges of the automatic switch are cleared");
  assert.equal((h.svc as unknown as { accountTimers: Map<string, unknown> }).accountTimers.size, 0);
  h.svc.stop();
});

test("review2-3 account swap-back that is deferred (Keep / swap-back off) re-arms its timer instead of going silent", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() });
  const a = fakeAccounts({ usage: okUsage }); h.svc.accounts = a.api;
  await h.svc.evaluate("a1", "u1");
  await h.svc.act("u1", "a1", "keep");
  assert.equal(await h.svc.restoreAccount("u1", { force: false }), false);
  assert.equal((h.svc as unknown as { accountTimers: Map<string, unknown> }).accountTimers.size, 1);
  assert.notEqual(h.user.ret, null, "the way back is still recorded");
  h.svc.stop();
});

test("review2-2 arming twice leaves one live timer (the replaced one is cleared)", async () => {
  const h = harness({ transcript: "" });
  const svc = h.svc as unknown as { arm(id: string, u: string, d: number, a: number): void; timers: Map<string, { _destroyed?: boolean }> };
  svc.arm("a1", "u1", 60_000, 0);
  const first = svc.timers.get("a1")!;
  svc.arm("a1", "u1", 60_000, 1);
  assert.equal(first._destroyed, true);
  assert.equal(svc.timers.size, 1);
  h.svc.stop();
});

test("review2-5 failed Codex switch: the agent is paused until the reset (badge not 'Codex'), Codex is not retried for this window", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: codexChain(), failSwitch: true });
  h.svc.codex = codexPort();
  await assert.rejects(h.svc.evaluate("a1", "u1"), /switch failed/);
  assert.equal(h.row.fallback_state?.current.kind, "paused");
  assert.deepEqual(h.row.fallback_state?.ineffective, ["codex@five_hour"]);
  assert.equal(fallbackBadge(h.row.fallback_state)?.kind, "paused");
  assert.equal((h.svc as unknown as { timers: Map<string, unknown> }).timers.size, 1, "the reset timer resumes it");
  h.svc.stop();
});

test("advisor-4 Return now to a limit that is still on is refused (no swap loop); a paused agent can always be resumed by hand", async () => {
  const full = new Date(Date.now() + 3600_000).toISOString();
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  h.svc.usage = { claudeBlocked: async () => null, claudeWindow: async () => ({ usedPercent: 100, resetsAt: full }) };
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  assert.deepEqual(await h.svc.act("u1", "a1", "return"), { applied: false, reason: "still_limited", resetsAt: full });
  assert.deepEqual(h.calls, []);
  assert.equal(h.row.model, "sonnet");
  h.svc.usage = { claudeBlocked: async () => null, claudeWindow: async () => ({ usedPercent: 40, resetsAt: full }) };
  assert.deepEqual(await h.svc.act("u1", "a1", "return"), { applied: true });
  assert.equal(h.row.model, "opus");
  const p = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  p.svc.usage = { claudeBlocked: async () => null, claudeWindow: async () => ({ usedPercent: 100, resetsAt: full }) };
  await p.svc.evaluate("a1", "u1");
  assert.deepEqual(await p.svc.act("u1", "a1", "return"), { applied: true }, "Resume now on a paused agent is the user's choice");
  h.svc.stop(); p.svc.stop();
});

test("advisor-7 park reasons: policy, loop guard, steps with no room, and no step at all", async () => {
  const reasonOf = async (opts: Parameters<typeof harness>[0], setup?: (h: ReturnType<typeof harness>) => void) => {
    const h = harness(opts);
    setup?.(h);
    await h.svc.evaluate("a1", "u1");
    const r = fallbackBadge(h.row.fallback_state)?.reason;
    h.svc.stop();
    return r;
  };
  assert.equal(await reasonOf({ transcript: jl(limit(fiveHour, "five_hour", "e1")), override: "pause" }), "pause_override");
  assert.equal(await reasonOf({ transcript: jl(limit(fiveHour, "five_hour", "e1")) }), "no_step");
  assert.equal(await reasonOf({ transcript: jl(limit(fiveHour, "five_hour", "e1")), settings: accountChain() }, (h) => { h.svc.accounts = fakeAccounts({ usage: { acct_b0b0b0b0: [{ id: "five_hour", usedPercent: 100 }] } }).api; }), "steps_unavailable");
});

test("advisor-9/10 labels: models read as Sonnet/Opus, unknown ids stay as configured", () => {
  assert.equal(modelLabel("sonnet"), "Sonnet");
  assert.equal(modelLabel("opusplan"), "Opus");
  assert.equal(modelLabel("claude-haiku-4"), "Haiku");
  assert.equal(modelLabel("my-model"), "my-model");
  assert.equal(modelLabel(null), "the default model");
});

test("advisor parent notice: one short message to the parent per agent and window, for a model swap and for a park", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), parent: "11111111-2222-4333-8444-555555555555" });
  await h.svc.evaluate("a1", "u1");
  const note = h.notices.find((n) => n.startsWith("PARENT "))!;
  assert.match(note, /^PARENT \[Floq\] Your subagent t \(a1\) hit a Claude usage limit: now on Sonnet \(was Opus\), switching back at the reset\.$/);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("parent:")), ["parent:11111111-2222-4333-8444-555555555555"]);
  const again = limit(fiveHour, "seven_day_opus", "e2", Math.floor(new Date(h.row.fallback_state!.resetsAt!).getTime() / 1000));
  (again as Record<string, unknown>).timestamp = new Date(Date.now() + 90_000).toISOString();
  h.state.transcript = jl(again);
  h.advance(30 * 60_000);
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.calls.filter((c) => c.startsWith("parent:")).length, 1, "same window: no second notice");
  const parked = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")), parent: "11111111-2222-4333-8444-555555555555" });
  await parked.svc.evaluate("a1", "u1");
  assert.match(parked.notices.find((n) => n.startsWith("PARENT "))!, /paused until \d\d:\d\d UTC; it continues on its own/);
  const orphan = harness({ transcript: jl(limit(fiveHour, "five_hour", "e1")) });
  await orphan.svc.evaluate("a1", "u1");
  assert.equal(orphan.calls.filter((c) => c.startsWith("parent:")).length, 0, "an agent without a parent tells nobody");
  h.svc.stop(); parked.svc.stop(); orphan.svc.stop();
});

test("advisor reap sweep: live Claude agents are looked at again (the stamp check keeps it a stat)", async () => {
  let stamp = "1:1";
  const h = harness({ transcript: jl(user("hi")), stamp: () => stamp });
  await h.svc.evaluate("a1", "u1");
  h.state.transcript = jl(user("hi"), limit(fiveHour, "seven_day_opus", "e1"));
  h.svc.sweep([{ id: "a1", userId: "u1" }]);
  assert.equal((h.svc as unknown as { debounce: Map<string, unknown> }).debounce.size, 1, "a look is scheduled");
  stamp = "2:2";
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(h.calls, ["restart:sonnet"], "a limit record written without any output is still found");
  h.svc.stop();
});

test("advisor-14 the blocked account decides the reset: a model-step agent checks the slot that was blocked, not the active one", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) });
  const a = fakeAccounts({ active: "acct_b0b0b0b0", usage: { primary: [{ id: "seven_day_opus", usedPercent: 100 }] } });
  h.svc.accounts = a.api;
  h.svc.usage = { claudeBlocked: async () => null, claudeWindow: async () => ({ usedPercent: 0, resetsAt: null }) }; // the ACTIVE account looks fine
  await h.svc.evaluate("a1", "u1");
  assert.equal(h.row.fallback_state?.scope.slot, "acct_b0b0b0b0", "scope records the slot active when the block hit");
  h.row.fallback_state!.scope.slot = "primary"; // the blocked one was primary
  h.calls.length = 0;
  await (h.svc as unknown as { onReset(id: string, u: string, n: number): Promise<void> }).onReset("a1", "u1", 0);
  assert.deepEqual(h.calls, [], "primary is still full: stay on the fallback");
  assert.equal(h.row.model, "sonnet");
  h.svc.stop();
});

test("advisor-3 UsageService.invalidate: after an account switch the next read refetches (the old account's 100 % is not reported for the new one)", async () => {
  const { UsageService } = await import("../dist/usage.js");
  let claudeFetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("anthropic")) claudeFetches++;
    return new Response(JSON.stringify({ five_hour: { utilization: claudeFetches === 1 ? 100 : 5, resets_at: new Date(Date.now() + 3600_000).toISOString() } }), { status: 200 });
  }) as typeof fetch;
  try {
    const svc = new UsageService({ refresh: async () => undefined, get: async () => ({ accessToken: "t", tokens: { access_token: "x" } }) } as never);
    assert.equal((await svc.get("u1")).claude?.windows[0]?.usedPercent, 100);
    assert.equal((await svc.get("u1")).claude?.windows[0]?.usedPercent, 100, "cached for a minute");
    assert.equal(claudeFetches, 1);
    svc.invalidate("u1", "claude");
    assert.equal((await svc.get("u1")).claude?.windows[0]?.usedPercent, 5);
    assert.equal(claudeFetches, 2);
  } finally { globalThis.fetch = realFetch; }
});


// ---- limit kinds, terminal banner, chain walking ----

import { classifyLimitText, classifyBanner, parseResetClock } from "../dist/limitText.js";
import { walkableSlots, markTried, terminalBannerStale } from "../dist/fallback.js";

test("limitText: every limit kind is classified, spend caps win over the window they mention", () => {
  const now = Date.parse("2026-11-18T01:00:00Z");
  assert.equal(classifyLimitText("You've hit your 5-hour limit · resets 4:20am (UTC)", now)?.rateLimitType, "five_hour");
  assert.equal(classifyLimitText("You've hit your weekly limit · resets Nov 12, 3pm (UTC)", now)?.rateLimitType, "seven_day");
  assert.equal(classifyLimitText("You've hit your Opus weekly limit · resets 3pm (UTC)", now)?.rateLimitType, "seven_day_opus");
  assert.equal(classifyLimitText("You've hit your Sonnet weekly limit", now)?.rateLimitType, "seven_day_sonnet");
  const spend = classifyLimitText("You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets 2:50am (UTC)", now);
  assert.deepEqual([spend?.rateLimitType, spend?.kind, spend?.resetsAt], ["spend_limit", "spend", "2026-11-18T02:50:00.000Z"]);
  assert.equal(classifyLimitText("You're out of extra usage · resets 3am", now)?.kind, "extra_usage");
  assert.equal(classifyLimitText("Refactor the usage service please", now), null);
});

test("limitText: reset clock rolls to the next UTC occurrence", () => {
  const now = Date.parse("2026-11-18T03:00:00Z");
  assert.equal(parseResetClock("resets 2:50am (UTC)", now), "2026-11-19T02:50:00.000Z");
  assert.equal(parseResetClock("continuing automatically at 6pm", now), "2026-11-18T18:00:00.000Z");
  assert.equal(parseResetClock("no clock here", now), null);
});

test("limitText: only the CLI's own banner counts as a terminal limit (plain prose does not)", () => {
  const now = Date.now();
  assert.equal(classifyBanner("\u001b[2mUsage limit reached · continuing automatically at 2:50am · Esc to cancel\u001b[0m", now)?.rateLimitType, "usage_limit");
  assert.equal(classifyBanner("the spend limit message says usage limit reached, then what", now), null);
});

test("claudeLimitEvent: a spend-cap record without rate_limit_info is detected from the CLI text", () => {
  const base = limit(fiveHour, "five_hour", "s1") as { message: { content: Array<{ text: string }> } };
  const rec = { ...base, apiErrorParams: {}, message: { ...base.message, content: [{ type: "text", text: "You've hit your org's monthly spend limit · run /usage-credits · your 5-hour limit resets 2:50am (UTC)" }] } };
  const ev = claudeLimitEvent(jl(user("go"), rec));
  assert.equal(ev?.rateLimitType, "spend_limit");
  assert.equal(ev?.kind, "spend");
});

test("walkableSlots/markTried: tried and near-full slots are skipped, expired tries are forgotten", () => {
  const now = Date.now();
  const w = (p: number) => [{ id: "five_hour", usedPercent: p }] as never;
  const cand = [{ slot: "a", windows: w(99) }, { slot: "b", windows: w(10) }, { slot: "c", windows: w(20) }];
  assert.deepEqual(walkableSlots(cand, "five_hour", "window", [], now), ["b", "c"]);
  const tried = markTried(undefined, "b", new Date(now + 60_000).toISOString(), now);
  assert.deepEqual(walkableSlots(cand, "five_hour", "window", tried, now), ["c"]);
  assert.deepEqual(walkableSlots(cand, "five_hour", "window", tried, now + 120_000), ["b", "c"]);
});

test("chain walk: the first reserve is also exhausted, the second is used; terminal banner alone triggers the swap with no quiet wait", async () => {
  const h = harness({ transcript: "", settings: accountChain() });
  const a = fakeAccounts({ usage: { acct_b0b0b0b0: [{ id: "five_hour", usedPercent: 99 }], acct_c1c1c1c1: [{ id: "five_hour", usedPercent: 5 }] }, reserves: ["acct_b0b0b0b0", "acct_c1c1c1c1"] });
  h.svc.accounts = a.api;
  h.svc.onOutput("a1", "u1", "Usage limit reached · continuing automatically at 2:50am · Esc to cancel");
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, ["acct_c1c1c1c1"]);
  assert.ok(h.calls.some((c) => c.startsWith("restart")), "process restarted so the CLI's own wait is gone");
  assert.ok(h.notices.some((n) => n.includes("Continue the task")), "automatic continue turn queued");
  h.svc.stop();
});

test("a limit cleared before its reset time (usage reset) resumes the agent at the next check, not at the reported reset", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")), usedPercent: 100 });
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  const onReset = (n: number) => (h.svc as unknown as { onReset(id: string, userId: string, attempt: number): Promise<void> }).onReset("a1", "u1", n);
  const reset = Date.parse(h.row.fallback_state!.resetsAt!);
  const timers = (h.svc as unknown as { timers: Map<string, unknown> }).timers;
  // Still full before the reset: nothing changes, and a check stays armed.
  await onReset(0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.row.model, "sonnet");
  assert.ok(timers.has("a1"), "keeps checking early");
  assert.ok(Date.now() < reset, "the fixture's reset is still ahead");
  // The user resets their usage: the next early check sees room and restores right away.
  (h.svc as unknown as { usage: { claudeWindow: () => Promise<unknown> } }).usage.claudeWindow = async () => ({ usedPercent: 3, resetsAt: new Date(reset).toISOString() });
  await onReset(0);
  assert.equal(h.row.model, "opus");
  h.svc.stop();
});

test("before the reset, an unknown usage window keeps checking without using up the retries", async () => {
  const h = harness({ transcript: jl(limit(fiveHour, "seven_day_opus", "e1")) }); // usage returns null
  await h.svc.evaluate("a1", "u1");
  h.calls.length = 0;
  const onReset = (n: number) => (h.svc as unknown as { onReset(id: string, userId: string, attempt: number): Promise<void> }).onReset("a1", "u1", n);
  for (let i = 0; i < 5; i++) await onReset(0);
  assert.deepEqual(h.calls, []);
  assert.equal(h.row.model, "sonnet");
  h.svc.stop();
});

test("an old limit banner redrawn when a paused agent wakes is ignored while the account's usage has room: no pause, no account switch", async () => {
  const h = harness({ transcript: "", settings: accountChain() });
  const a = fakeAccounts({ usage: { primary: [{ id: "five_hour", usedPercent: 12 }], acct_b0b0b0b0: [{ id: "five_hour", usedPercent: 5 }] }, reserves: ["acct_b0b0b0b0"] });
  h.svc.accounts = a.api;
  // Claude Code repaints the conversation on resume, including the earlier banner.
  h.svc.onOutput("a1", "u1", "You've hit your limit · resets 3:50pm (UTC)\n");
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, [], "no account switch");
  assert.equal(h.row.fallback_state ?? null, null, "not parked");
  assert.ok(!h.calls.some((c) => c.startsWith("restart")));
  // The same text arriving again does not trip it either (the screen tail was cleared).
  h.svc.onOutput("a1", "u1", "working...\n");
  await h.svc.evaluate("a1", "u1");
  assert.deepEqual(a.st.switches, []);
  h.svc.stop();
});

test("terminalBannerStale: usage decides when known; with usage unknown a 5-hour reset more than 5 hours away is stale", () => {
  const now = Date.parse("2026-11-25T18:00:00Z");
  assert.equal(terminalBannerStale([{ id: "five_hour", label: "", usedPercent: 12, resetsAt: null }], "five_hour", "window", null, now), true);
  assert.equal(terminalBannerStale([{ id: "five_hour", label: "", usedPercent: 99, resetsAt: null }], "five_hour", "window", null, now), false);
  assert.equal(terminalBannerStale([{ id: "seven_day", label: "", usedPercent: 100, resetsAt: null }], "five_hour", "window", null, now), false);
  assert.equal(terminalBannerStale(null, "five_hour", "window", "2026-11-26T15:50:00Z", now), true);
  assert.equal(terminalBannerStale(null, "five_hour", "window", "2026-11-25T20:50:00Z", now), false);
  assert.equal(terminalBannerStale(null, "seven_day", "window", "2026-11-28T10:00:00Z", now), false);
});
