import test from "node:test";
import assert from "node:assert/strict";
import { agentStatus, analyzeTranscript, endsWithAssistantText, truncateReply, truncationNote } from "../dist/turn.js";
import { formatAgentReply, parseArgs } from "../dist/image/floq-args.mjs";

const jl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
const asst = (id: string, content: unknown[], stop_reason: string | null = null) => ({ type: "assistant", message: { id, role: "assistant", content, stop_reason } });

test("Claude transcript: finished turn returns the full final reply, not earlier text", () => {
  const turn = analyzeTranscript("claude", jl(
    user("review this"),
    asst("m1", [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "Read", input: {} }], "tool_use"),
    toolResult,
    asst("m2", [{ type: "text", text: "Finding 1: bug.\n" }]),
    asst("m2", [{ type: "text", text: "Finding 2: leak." }], "end_turn"),
  ));
  assert.deepEqual(turn, { prompts: 1, status: "idle", reply: "Finding 1: bug.\nFinding 2: leak." });
});

test("Claude transcript: open turn is working and a new prompt resets the reply", () => {
  const working = analyzeTranscript("claude", jl(user("a"), asst("m1", [{ type: "text", text: "done" }], "end_turn"), user("b"), asst("m2", [{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"), toolResult));
  assert.equal(working.status, "working");
  assert.equal(working.prompts, 2);
  assert.equal(working.reply, null);
  assert.equal(analyzeTranscript("claude", jl(user("a"), { type: "system", subtype: "turn_duration" })).status, "idle");
});

test("Claude transcript: tolerates a partial first line and ignores sidechains and meta users", () => {
  const text = "{\"type\":\"assis\n" + jl({ ...user("sub"), isSidechain: true }, { ...user("meta"), isMeta: true }, user("real"), asst("m", [{ type: "text", text: "hi" }], "end_turn"));
  assert.deepEqual(analyzeTranscript("claude", text), { prompts: 1, status: "idle", reply: "hi" });
});

test("trailing text-only assistant record detection", () => {
  assert.equal(endsWithAssistantText(jl(user("a"), asst("m", [{ type: "text", text: "x" }]))), true);
  assert.equal(endsWithAssistantText(jl(user("a"), asst("m", [{ type: "tool_use", id: "t", name: "x", input: {} }]))), false);
  assert.equal(endsWithAssistantText(jl(asst("m", [{ type: "text", text: "x" }]), user("b"))), false);
});

test("Codex rollout: task_complete closes the turn with the last agent message", () => {
  const ev = (payload: unknown) => ({ type: "event_msg", payload });
  const open = analyzeTranscript("codex", jl(ev({ type: "user_message", message: "go" }), ev({ type: "task_started" }), ev({ type: "agent_message", message: "working on it" })));
  assert.equal(open.status, "working");
  const done = analyzeTranscript("codex", jl(ev({ type: "user_message", message: "go" }), ev({ type: "agent_message", message: "partial" }), ev({ type: "task_complete", last_agent_message: "Final report" })));
  assert.deepEqual(done, { prompts: 1, status: "idle", reply: "Final report" });
});

test("agentStatus combines session state, transcript and terminal quiet", () => {
  const base = { alive: true, sessionState: "running", outputQuietMs: 0, transcriptQuietMs: 0 };
  const working = { prompts: 1, status: "working" as const, reply: null };
  assert.equal(agentStatus({ ...base, turn: working }), "working");
  assert.equal(agentStatus({ ...base, turn: { ...working, status: "idle" } }), "idle");
  assert.equal(agentStatus({ ...base, turn: working, outputQuietMs: 61_000 }), "waiting-for-input");
  assert.equal(agentStatus({ ...base, turn: { ...working, trailingAssistantText: true }, outputQuietMs: 9_000, transcriptQuietMs: 9_000 }), "idle");
  assert.equal(agentStatus({ ...base, turn: null, outputQuietMs: 1_000 }), "working");
  assert.equal(agentStatus({ ...base, turn: null, outputQuietMs: 6_000 }), "idle");
  assert.equal(agentStatus({ ...base, alive: false, turn: working }), "exited");
  assert.equal(agentStatus({ ...base, sessionState: "sleeping", turn: working }), "asleep");
});

test("truncateReply keeps the start and reports how much was cut", () => {
  assert.deepEqual(truncateReply("abcdef", 4), { text: "abcd", truncated: 2 });
  assert.deepEqual(truncateReply("abcdef", null), { text: "abcdef", truncated: 0 });
  assert.deepEqual(truncateReply("abc", 10), { text: "abc", truncated: 0 });
  assert.equal(truncationNote(2), "[truncated: 2 more chars, use --full]");
  assert.equal(truncationNote(0), "");
});

test("formatAgentReply prints a status line first and maps exit codes", () => {
  assert.deepEqual(formatAgentReply("check", "id", { status: "idle", source: "transcript", output: "report", truncated: 5 }), {
    text: "status: idle\nsource: last reply\nreport\n[truncated: 5 more chars, use --full]", code: 0,
  });
  assert.equal(formatAgentReply("ask", "id", { status: "done", output: "full" }).text, "status: idle\nfull");
  const timeout = formatAgentReply("ask", "abc", { status: "timeout", output: "tail" }, 60);
  assert.equal(timeout.code, 3);
  assert.match(timeout.text, /^status: working \(timed out after 60s; still working, run `floq wait abc`/);
  assert.equal(formatAgentReply("wait", "id", { status: "waiting-for-input", output: "" }).code, 4);
  assert.equal(formatAgentReply("ask", "id", { status: "exit", output: "" }).code, 5);
  assert.equal(formatAgentReply("ask", "id", { status: "sent", output: "" }).text, "status: sent");
  assert.equal(formatAgentReply("check", "id", { status: "working", output: "" }).code, 0);
});

test("ask/wait flags parse as booleans", () => {
  assert.deepEqual(parseArgs(["id", "hello", "--wait", "--full", "--timeout", "30"]), { positional: ["id", "hello"], named: { wait: true, full: true, timeout: "30" } });
  assert.deepEqual(parseArgs(["id", "msg", "--no-wait"]).named, { "no-wait": true });
});
