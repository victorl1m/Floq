import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESUME_SUMMARY_MAX_CHARS, RESUME_SUMMARY_PREFIX, buildResumeSummary, redactForSummary } from "../dist/resumeSummary.js";
import { checkpointTranscript, readCheckpointText } from "../dist/checkpoints.js";

const j = (...recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (text: string, extra: object = {}) => ({ type: "user", message: { role: "user", content: text }, ...extra });
const asst = (content: object[], id = "m1") => ({ type: "assistant", message: { id, role: "assistant", content } });

const claude = j(
  user("Add a dark mode toggle to the settings page"),
  asst([{ type: "text", text: "On it." }, { type: "tool_use", name: "Read", input: { file_path: "/w/a.ts" } }]),
  asst([{ type: "tool_use", name: "Edit", input: { file_path: "/w/src/settings.tsx" } }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }], "m2"),
  asst([{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "wire toggle", status: "completed" }, { content: "write tests", status: "in_progress" }, { content: "docs", status: "pending" }] } }], "m3"),
  user("<system-reminder>ignore me</system-reminder>"),
  user("also persist it in localStorage"),
  { type: "user", isSidechain: true, message: { content: "sidechain prompt" } },
  asst([{ type: "text", text: "Done, the toggle persists." }], "m4"),
);

test("claude: goals, actions, files, todos and last reply", () => {
  const out = buildResumeSummary({ provider: "claude", tailText: claude, cwd: "/w" })!;
  assert.ok(out.startsWith("You are resuming work after your previous conversation could not be restored"));
  assert.ok(out.startsWith(RESUME_SUMMARY_PREFIX));
  assert.match(out, /Add a dark mode toggle/);
  assert.match(out, /also persist it in localStorage/);
  assert.doesNotMatch(out, /ignore me|sidechain prompt/);
  assert.match(out, /Edit \/w\/src\/settings\.tsx/);
  assert.match(out, /Bash: npm test/);
  assert.doesNotMatch(out, /Read \/w\/a\.ts/);
  assert.match(out, /\[x\] wire toggle/);
  assert.match(out, /\[~\] write tests/);
  assert.match(out, /Done, the toggle persists\./);
  assert.match(out, /Working directory: \/w/);
});

test("claude: first prompt comes from the head when the tail lost it", () => {
  const tail = j(user("latest request"), asst([{ type: "text", text: "ok" }]));
  const out = buildResumeSummary({ provider: "claude", headText: j(user("the very first task")), tailText: tail })!;
  assert.match(out, /## Original task[\s\S]*the very first task/);
});

const codex = j(
  { type: "session_meta", payload: { id: "x" } },
  { type: "event_msg", payload: { type: "user_message", message: "Refactor the parser" } },
  { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "cargo build"] }) } },
  { type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "split lexer", status: "completed" }, { step: "add tests", status: "pending" }] }) } },
  { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/parser.rs\n*** Add File: src/lexer.rs\n*** End Patch" } },
  { type: "event_msg", payload: { type: "agent_message", message: "Parser split." } },
  { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Parser split into lexer and parser." } },
);

test("codex rollout: goals, shell actions, patched files, plan, last reply", () => {
  const out = buildResumeSummary({ provider: "codex", tailText: codex })!;
  assert.match(out, /Refactor the parser/);
  assert.match(out, /Shell: bash -lc cargo build/);
  assert.match(out, /- src\/parser\.rs/);
  assert.match(out, /- src\/lexer\.rs/);
  assert.match(out, /\[x\] split lexer/);
  assert.match(out, /Parser split into lexer and parser\./);
});

test("empty or machinery-only transcript gives null", () => {
  assert.equal(buildResumeSummary({ provider: "claude", tailText: "" }), null);
  assert.equal(buildResumeSummary({ provider: "claude", tailText: "garbage\n{not json" }), null);
  assert.equal(buildResumeSummary({ provider: "claude", tailText: j(user("<system-reminder>x</system-reminder>")) }), null);
});

test("size cap holds for huge transcripts, prefix survives", () => {
  const recs: object[] = [user("word ".repeat(10_000))];
  for (let i = 0; i < 500; i++) recs.push(asst([{ type: "tool_use", name: "Bash", input: { command: "echo " + "yy ".repeat(150) + i } }], "b" + i));
  recs.push(asst([{ type: "text", text: "zz ".repeat(20_000) }], "last"));
  const out = buildResumeSummary({ provider: "claude", tailText: j(...recs) })!;
  assert.ok(out.length <= RESUME_SUMMARY_MAX_CHARS, String(out.length));
  assert.ok(out.length > 4000);
  assert.ok(out.startsWith(RESUME_SUMMARY_PREFIX));
});

test("obvious secrets are redacted everywhere in the summary", () => {
  const sk = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const aws = "AKIAIOSFODNN7EXAMPLE";
  const t = j(
    user(`use key ${sk} and ${gh} for the deploy`),
    asst([{ type: "tool_use", name: "Bash", input: { command: `AWS_ACCESS_KEY_ID=${aws} AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY curl -H "Authorization: Bearer abcdef1234567890" x` } }]),
    asst([{ type: "text", text: `I stored ${aws} in the config` }], "r"),
  );
  const out = buildResumeSummary({ provider: "claude", tailText: t })!;
  for (const leak of [sk, gh, aws, "wJalrXUtnFEMI", "abcdef1234567890", "sk-ant"]) assert.ok(!out.includes(leak), "leaked " + leak);
  assert.match(out, /\[redacted\]/);
  assert.match(redactForSummary("password=hunter2hunter2 and TOKEN: abc"), /password=\[redacted\]/);
});

test("file paths survive redaction", () => {
  const out = buildResumeSummary({ provider: "claude", tailText: j(user("go"), asst([{ type: "tool_use", name: "Write", input: { file_path: "/home/agent/.floq/projects/some-long-project-name/src/components/canvas/agent-node.tsx" } }])) })!;
  assert.match(out, /agent-node\.tsx/);
});

test("summary can be built from a checkpoint copy", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-sum-"));
  try {
    const SID = "22222222-2222-4222-8222-222222222222";
    const dir = join(home, ".claude", "projects", "-w");
    mkdirSync(dir, { recursive: true });
    const source = join(dir, SID + ".jsonl");
    writeFileSync(source, claude);
    const uid = process.getuid?.() ?? null;
    await checkpointTranscript({ home, uid, sessionId: SID, provider: "claude", providerSessionId: SID, sourcePath: source });
    rmSync(source);
    const text = readCheckpointText({ home, uid }, SID, "claude", SID)!;
    assert.ok(text);
    assert.match(buildResumeSummary({ provider: "claude", tailText: text.tail, headText: text.head })!, /dark mode toggle/);
    assert.equal(readCheckpointText({ home, uid }, SID, "opencode", SID), null);
    assert.equal(readCheckpointText({ home, uid }, SID, "claude", "33333333-3333-4333-8333-333333333333"), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
