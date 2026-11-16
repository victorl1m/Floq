import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgySwarmMirror, buildAgents, confinedFile, deriveActivity, deriveStatus, parseBoard, parseDbRows, parseMembers, parseTranscript, readConfinedTail, readSummariesDb,
  type MirrorFrame,
} from "../dist/agySwarmMirror.js";
import { buildSubagentInstruction } from "../dist/subagents.js";
import { FLOQ_RULES_GUIDANCE } from "../dist/cliProviders.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const W2 = "33333333-3333-4333-8333-333333333333";
const SUB = "44444444-4444-4444-8444-444444444444";
const OTHER = "99999999-9999-4999-8999-999999999999";

const members = JSON.stringify({
  title: "Refactor parser",
  members: {
    parser: { conversation_id: W1, model: "gemini-3", role: "worker", killed: false, last_read_seq: 1 },
    tester: { conversation_id: W2, model: "gemini-3-flash", role: "monitor", killed: true, last_read_seq: 0 },
    bogus: { conversation_id: "not-a-uuid" },
  },
});
const board = [
  JSON.stringify({ seq: 1, agent: "parser", text: "hi", time: "2026-11-16 10:00:00" }),
  JSON.stringify({ seq: 3, agent: "tester", text: "@parser ping", time: "2026-11-16 10:01:00" }),
  '{"seq":4,"agent":"par', // torn
].join("\n");
const step = (o: object) => JSON.stringify(o);
const tx = [
  step({ type: "USER_INPUT", status: "DONE", step_index: 0, created_at: "2026-11-16T10:00:00Z" }),
  step({ type: "PLANNER_RESPONSE", status: "DONE", step_index: 1, thinking: "**Reading files**\nblah", tool_calls: [{ name: "view_file", args: JSON.stringify({ toolSummary: "Viewing a.ts" }) }] }),
  step({ type: "GENERIC", status: "DONE", step_index: 2 }),
  '{"type":"PLANNER_RESP', // torn tail
].join("\n");

test("parseMembers keeps valid members, ignores unknown ids", () => {
  const roster = parseMembers(members)!;
  assert.equal(roster.title, "Refactor parser");
  assert.deepEqual(roster.members.map((m) => m.name), ["parser", "tester"]);
  assert.equal(roster.members[1]!.killed, true);
  assert.equal(parseMembers("{nope"), null);
  assert.equal(parseMembers("[]"), null);
});

test("parseBoard skips torn lines", () => {
  const posts = parseBoard(board);
  assert.deepEqual(posts.map((p) => p.seq), [1, 3]);
});

test("parseTranscript parses steps, JSON-quoted args and tolerates a torn line", () => {
  const steps = parseTranscript(tx);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[1]!.tools, [{ name: "view_file", summary: "Viewing a.ts" }]);
  assert.equal(deriveActivity(steps), "Viewing a.ts");
  assert.equal(deriveActivity(parseTranscript(step({ type: "PLANNER_RESPONSE", thinking: "x **Plan it** y **Write code**" }))), "Write code");
});

test("deriveStatus follows the sidecar rules", () => {
  const now = Date.parse("2026-11-16T11:00:00Z");
  const s = (lines: object[]) => parseTranscript(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(deriveStatus(s([{ type: "PLANNER_RESPONSE", step_index: 0 }]), { killed: true, nowMs: now }).status, "killed");
  assert.equal(deriveStatus(s([{ type: "PLANNER_RESPONSE", status: "DONE", step_index: 0 }]), { killed: false, nowMs: now }).status, "waiting");
  assert.equal(deriveStatus(s([{ type: "PLANNER_RESPONSE", status: "DONE", step_index: 0, tool_calls: [{ name: "x" }] }]), { killed: false, nowMs: now }).status, "working");
  assert.equal(deriveStatus(s([{ type: "PLANNER_RESPONSE", step_index: 0, tool_calls: [{ name: "swarm_wait" }] }, { type: "GENERIC", status: "DONE", step_index: 1 }]), { killed: false, nowMs: now }).status, "waiting");
  const err = deriveStatus(s([{ type: "ERROR_MESSAGE", step_index: 0, error: "RESOURCE_EXHAUSTED" }]), { killed: false, nowMs: now });
  assert.equal(err.status, "error");
  assert.equal(err.quota, true);
  const failTool = s([{ type: "GENERIC", status: "ERROR", step_index: 0 }]);
  assert.equal(deriveStatus(failTool, { killed: false, nowMs: now, lastWriteMs: now - 10_000 }).status, "working");
  assert.equal(deriveStatus(failTool, { killed: false, nowMs: now, lastWriteMs: now - 90_000 }).status, "error");
  const stuck = deriveStatus(s([{ type: "PLANNER_RESPONSE", step_index: 0, tool_calls: [{ name: "x" }] }]), { killed: false, nowMs: now, lastWriteMs: now - 11 * 60_000 });
  assert.equal(stuck.status, "working");
  assert.equal(stuck.stalled, true);
});

test("parseDbRows maps columns and drops bad rows", () => {
  const rows = parseDbRows([
    { conversation_id: SUB, agent_name: "helper", parent_conversation_id: W1, nesting_depth: 2, status: "idle", step_count: 7, killed: 0, not_fully_idle: 0 },
    { conversation_id: "x" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.parentId, W1);
});

test("buildAgents scopes to the root tree and assembles parents", () => {
  const db = parseDbRows([
    { conversation_id: SUB, agent_name: "helper", parent_conversation_id: W1, nesting_depth: 2, status: "done", step_count: 7, killed: 0, not_fully_idle: 0 },
    { conversation_id: OTHER, agent_name: "stranger", parent_conversation_id: "55555555-5555-4555-8555-555555555555", nesting_depth: 1, status: "x", step_count: 1, killed: 0, not_fully_idle: 1 },
  ]);
  const agents = buildAgents({
    hostSessionId: "host", projectId: "p", rootConv: ROOT,
    rosters: new Map([[ROOT, parseMembers(members)!]]),
    boardHeads: new Map([[ROOT, 3]]),
    db,
    convs: new Map([[W1, { steps: parseTranscript(tx), lastWriteMs: null }]]),
    nowMs: Date.parse("2026-11-16T11:00:00Z"),
  });
  assert.deepEqual(agents.map((a) => a.id), ["agy:" + W1, "agy:" + W2, "agy:" + SUB]);
  const [parser, tester, helper] = agents;
  assert.equal(parser!.parentId, "host");
  assert.equal(parser!.kind, "swarm");
  assert.equal(parser!.unread, 2);
  assert.equal(parser!.activity, "Viewing a.ts");
  assert.equal(parser!.status, "working");
  assert.equal(parser!.swarmTitle, "Refactor parser");
  assert.equal(tester!.status, "killed");
  assert.equal(tester!.role, "monitor");
  assert.equal(helper!.parentId, "agy:" + W1);
  assert.equal(helper!.kind, "subagent");
  assert.equal(helper!.name, "helper");
  assert.equal(helper!.steps, 7);
  assert.ok(!agents.some((a) => a.id === "agy:" + OTHER), "other swarms never leak in");
});

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "agymirror-"));
  const appData = join(home, ".gemini", "antigravity-cli");
  const swarm = join(appData, "brain", ROOT, ".system_generated", "swarm");
  mkdirSync(swarm, { recursive: true });
  writeFileSync(join(swarm, "members.json"), members);
  writeFileSync(join(swarm, "board.jsonl"), board);
  const logs = join(appData, "brain", W1, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "transcript.jsonl"), tx);
  return { home, appData, logs };
}

test("confinement: symlinks and escapes are refused", () => {
  const { home, appData, logs } = fixtureHome();
  try {
    const outside = mkdtempSync(join(tmpdir(), "agyoutside-"));
    writeFileSync(join(outside, "secret.jsonl"), "secret");
    symlinkSync(join(outside, "secret.jsonl"), join(logs, "link.jsonl"));
    assert.equal(confinedFile(join(logs, "link.jsonl"), home), null);
    assert.equal(readConfinedTail(join(outside, "secret.jsonl"), home, 100), null);
    const linkDir = join(appData, "brain", "linked");
    symlinkSync(outside, linkDir);
    assert.equal(confinedFile(join(linkDir, "secret.jsonl"), home), null);
    assert.ok(confinedFile(join(logs, "transcript.jsonl"), home));
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readConfinedTail caps size and drops the cut first line", () => {
  const { home, logs } = fixtureHome();
  try {
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: "GENERIC", step_index: i, status: "DONE" })).join("\n");
    writeFileSync(join(logs, "transcript.jsonl"), lines);
    const tail = readConfinedTail(join(logs, "transcript.jsonl"), home, 500)!;
    assert.equal(tail.truncated, true);
    const steps = parseTranscript(tail.text);
    assert.ok(steps.length > 0 && steps.length < 200);
    assert.equal(steps[steps.length - 1]!.index, 199);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("real read-only SQLite summaries feed the mirror; hub diffs, scopes by user, and stop keeps a stopped snapshot", async () => {
  const { home, appData } = fixtureHome();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(appData, "conversation_summaries.db"));
    db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, status TEXT, step_count INTEGER, last_modified_time TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, not_fully_idle INTEGER)`);
    db.prepare("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?)").run(SUB, "t", "done", 5, "2026-11-16T10:00:00Z", "helper", W1, 2, 0, 0);
    db.close();
    assert.equal((await readSummariesDb(join(appData, "conversation_summaries.db"))).rows.length, 1);

    const mirror = new AgySwarmMirror({ pollMs: 0, now: () => Date.parse("2026-11-16T11:00:00Z") });
    const mine: MirrorFrame[] = [];
    const theirs: MirrorFrame[] = [];
    mirror.subscribe("u1", (f) => mine.push(f));
    mirror.subscribe("u2", (f) => theirs.push(f));
    mirror.track({ sessionId: "host", userId: "u1", projectId: "p", home, appData, rootConv: null });
    assert.equal(mine.length, 0, "no root conversation yet");
    mirror.setRoot("host", ROOT);
    await mirror.idle();
    assert.equal(mine.length, 2, "files first, then the summaries rows");
    assert.deepEqual(mine[mine.length - 1]!.agents.map((a) => a.name), ["parser", "tester", "helper"]);
    assert.equal(theirs.length, 0);
    mirror.pollAll();
    await mirror.idle();
    assert.equal(mine.length, 2, "unchanged snapshot is not republished");
    assert.equal(mirror.frames("u1").length, 1);
    assert.equal(mirror.frames("u2").length, 0);

    assert.equal(mirror.snapshot("u1", "p").length, 3);
    assert.equal(mirror.snapshot("u2", "p").length, 0);
    const page = mirror.transcript("u1", "agy:" + W1, 1, 1)!;
    assert.ok(page && page !== "rate");
    assert.equal(page.steps.length, 1);
    assert.equal(page.steps[0]!.index, 1);
    assert.equal(page.next, 2);
    assert.ok(mirror.hostIds().includes("host"));
    assert.equal(mirror.transcript("u2", "agy:" + W1), null);
    assert.equal(mirror.transcript("u1", "agy:../../etc"), null);

    mirror.stop("host");
    const last = mine[mine.length - 1]!;
    assert.deepEqual(last.agents.map((a) => a.status), ["stopped", "killed", "stopped"]);
    mirror.forget("host");
    assert.deepEqual(mine[mine.length - 1]!.agents, []);
    mirror.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("hostile summaries databases cannot hang the read: a VIEW over a recursive query is rejected", async () => {
  const { home, appData } = fixtureHome();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(appData, "conversation_summaries.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE VIEW conversation_summaries AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT '${SUB}' AS conversation_id, x AS step_count FROM r`);
    db.close();
    const started = Date.now();
    assert.deepEqual((await readSummariesDb(path)).rows, []);
    assert.ok(Date.now() - started < 2500, "returned promptly");
    // the event loop stays responsive while a mirror polls it
    const mirror = new AgySwarmMirror({ pollMs: 0 });
    mirror.track({ sessionId: "h", userId: "u", projectId: "p", home, appData, rootConv: ROOT });
    await mirror.idle();
    assert.deepEqual(mirror.snapshot("u", "p").map((a) => a.name), ["parser", "tester"]);
    mirror.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a TABLE with a heavy generated column returns [] promptly, kills the child and disables further reads", async () => {
  const { home, appData } = fixtureHome();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(appData, "conversation_summaries.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, status TEXT, step_count INTEGER, last_modified_time TEXT, killed INTEGER, not_fully_idle INTEGER)");
    const ins = db.prepare("INSERT INTO conversation_summaries (conversation_id, last_modified_time) VALUES (?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) ins.run(SUB, String(i));
    db.exec("COMMIT");
    // added afterwards, so creating the fixture is cheap; reading it is not
    db.exec("ALTER TABLE conversation_summaries ADD COLUMN title TEXT AS (printf('%.*c', 900000000, 'x'))");
    db.close();
    const pids: number[] = [];
    const { spawn } = await import("node:child_process");
    const spawnDb = (c: { file: string; args: string[] }) => { const child = spawn(c.file, c.args.map((a) => (a === "node" ? process.execPath : a)), { stdio: ["ignore", "pipe", "ignore"] }); pids.push(child.pid!); return child; };
    const started = Date.now();
    const result = await readSummariesDb(path, { spawn: spawnDb, timeoutMs: 1500 });
    assert.deepEqual(result.rows, []);
    assert.equal(result.failed, true);
    assert.ok(Date.now() - started < 6000, "returned promptly");
    assert.equal(pids.length, 1);
    assert.throws(() => process.kill(pids[0]!, 0), "child is gone");

    // The poller disables db reads for that host and keeps serving the swarm files, with no second reader started.
    let reads = 0;
    const mirror = new AgySwarmMirror({ pollMs: 0, readDb: async () => { reads++; return { rows: [], failed: true }; } });
    mirror.track({ sessionId: "h", userId: "u", projectId: "p", home, appData, rootConv: ROOT });
    await mirror.idle();
    writeFileSync(path + "-wal", "x");
    mirror.pollAll();
    await mirror.idle();
    assert.equal(reads, 1);
    assert.deepEqual(mirror.snapshot("u", "p").map((a) => a.name), ["parser", "tester"]);
    mirror.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("summaries reads are at least dbMinIntervalMs apart per host", async () => {
  const { home, appData } = fixtureHome();
  try {
    let clock = 1_000_000;
    let reads = 0;
    writeFileSync(join(appData, "conversation_summaries.db"), "x");
    const mirror = new AgySwarmMirror({ pollMs: 0, now: () => clock, readDb: async () => { reads++; return { rows: [], failed: false }; } });
    mirror.track({ sessionId: "h", userId: "u", projectId: "p", home, appData, rootConv: ROOT });
    await mirror.idle();
    assert.equal(reads, 1);
    const dbPath = join(appData, "conversation_summaries.db");
    writeFileSync(dbPath, "a");
    clock += 1500;
    mirror.pollAll();
    await mirror.idle();
    assert.equal(reads, 1, "too soon");
    clock += 4000;
    mirror.pollAll();
    await mirror.idle();
    assert.equal(reads, 2, "after the interval the pending change is read");
    mirror.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("cache is pruned and the 64-cap is stable by first-seen", async () => {
  const { home, appData } = fixtureHome();
  try {
    const ids = Array.from({ length: 70 }, (_, i) => "aaaaaaaa-aaaa-4aaa-8aaa-" + String(i).padStart(12, "0"));
    const roster = (list: string[]) => JSON.stringify({ title: "big", members: Object.fromEntries(list.map((id, i) => ["w" + id.slice(-3), { conversation_id: id, role: "worker" }])) });
    const swarm = join(appData, "brain", ROOT, ".system_generated", "swarm", "members.json");
    writeFileSync(swarm, roster(ids.slice(0, 64)));
    const mirror = new AgySwarmMirror({ pollMs: 0 });
    mirror.track({ sessionId: "h", userId: "u", projectId: "p", home, appData, rootConv: ROOT });
    const first = mirror.snapshot("u", "p").map((a) => a.id);
    assert.equal(first.length, 64);
    // six newcomers arrive first in the roster and the oldest leave: the shown window must not rotate for the survivors
    writeFileSync(swarm, roster([...ids.slice(64), ...ids.slice(0, 60)]));
    mirror.pollAll();
    const second = mirror.snapshot("u", "p").map((a) => a.id);
    assert.equal(second.length, 64);
    assert.deepEqual(second.filter((id) => first.includes(id)), first.filter((id) => second.includes(id)));
    const state = (mirror as any).hosts.get("h");
    const tKeys = [...state.cache.keys()].filter((k: string) => k.startsWith("t:"));
    assert.ok(tKeys.length <= 65, "transcript cache bounded: " + tKeys.length);
    writeFileSync(swarm, roster(ids.slice(0, 2)));
    mirror.pollAll();
    assert.ok([...state.cache.keys()].filter((k: string) => k.startsWith("t:")).length <= 3, "untouched keys pruned");
    mirror.dispose();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a finished swarm turns its members done; a symlinked home root still works; fallback reads are rate limited", () => {
  const roster = parseMembers(members)!;
  const waiting = parseTranscript(step({ type: "PLANNER_RESPONSE", status: "DONE", step_index: 0 }));
  const agents = buildAgents({
    hostSessionId: "host", projectId: "p", rootConv: ROOT,
    rosters: new Map([[ROOT, roster]]), boardHeads: new Map(), db: [],
    convs: new Map([[ROOT, { steps: waiting, lastWriteMs: null }], [W1, { steps: waiting, lastWriteMs: null }]]),
    nowMs: 0,
  });
  assert.equal(agents.find((a) => a.name === "parser")!.status, "done");
  assert.equal(agents.find((a) => a.name === "tester")!.status, "killed");
  const busy = buildAgents({ hostSessionId: "host", projectId: "p", rootConv: ROOT, rosters: new Map([[ROOT, roster]]), boardHeads: new Map(), db: [], convs: new Map([[ROOT, { steps: parseTranscript(step({ type: "PLANNER_RESPONSE", step_index: 0, tool_calls: [{ name: "x" }] })), lastWriteMs: null }]]), nowMs: 0 });
  assert.notEqual(busy.find((a) => a.name === "parser")!.status, "done");
  const { home, logs } = fixtureHome();
  try {
    const link = home + "-link";
    symlinkSync(home, link);
    assert.ok(confinedFile(join(link, ".gemini", "antigravity-cli", "brain", W1, ".system_generated", "logs", "transcript.jsonl"), link));
    rmSync(link);
    void logs;
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("agy policy text allows the native swarm, others still forbid it", () => {
  assert.match(FLOQ_RULES_GUIDANCE, /swarm.*allowed/is);
  assert.doesNotMatch(FLOQ_RULES_GUIDANCE, /Native subagents are disabled/);
  const agy = buildSubagentInstruction({ enabled: true, depth: 0, provider: "antigravity" });
  assert.match(agy, /\/swarm.*allowed/s);
  assert.doesNotMatch(agy, /DISABLED in Floq/);
  assert.match(buildSubagentInstruction({ enabled: true, depth: 0, provider: "claude" }), /DISABLED in Floq/);
  assert.match(buildSubagentInstruction({ enabled: false, depth: 0, provider: "antigravity" }), /allowed in Floq/);
});
