import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { WebSocket } from "ws";
import { createRuntimeServer } from "../dist/server.js";

const TOKEN = "user-session-token";

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
}

/** A live session with `replay` buffered chunks; `emit` pushes live output to the attached sockets. */
function fakeSession(replay: number) {
  const listeners = new Set<(frame: unknown) => void>();
  const chunks = Array.from({ length: replay }, (_, i) => ({ seq: i + 1, data: `r${i + 1};`, ts: 1 }));
  let seq = replay;
  return {
    id: "s-1",
    listeners,
    replaySince: (since: number) => ({ chunks: chunks.filter((c) => c.seq > since), truncatedBytes: 0 }),
    toSummary: () => ({ id: "s-1", seq: replay, startedAt: "t" }),
    subscribe: (fn: (frame: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (data: string) => { seq += 1; for (const fn of listeners) fn({ type: "output", seq, data, ts: 2 }); },
    state: () => { for (const fn of listeners) fn({ type: "state", session: { id: "s-1" } }); },
    write() {}, resize() {}, interrupt() {},
  };
}

async function open(t: test.TestContext, session: ReturnType<typeof fakeSession>, since = 0) {
  const manager = { activeCount: 0, getLive: () => session, findLive: () => session };
  const auth = { handler() {}, api: { getSession: async ({ headers }: { headers: Headers }) => (headers.get("authorization") === "Bearer " + TOKEN ? { user: { id: "owner" } } : null) } };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", providers: { claude: "floq-test-no-claude", codex: "floq-test-no-codex", opencode: "floq-test-no-opencode", antigravity: "floq-test-no-agy", shell: "floq-test-no-shell" }, models: { claude: [], codex: [], opencode: [], antigravity: [] } };
  const server = createRuntimeServer({ config, manager, auth, settings: { async profile() { return {}; } }, github: {}, vault: {}, orchestrator: {}, pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error("unused"); } }, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {} } as never);
  await server.listen();
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/s-1/stream?since=${since}`, { headers: { Authorization: "Bearer " + TOKEN } });
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString("utf8"))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(async () => { ws.terminate(); await server.close(); });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
  return { frames, settle, ws };
}

test("replay reaches the client as few large frames, in order, ending on the session's seq", async (t) => {
  const session = fakeSession(5000);
  const { frames, settle } = await open(t, session);
  await settle();
  assert.equal(frames[0].type, "hello");
  const output = frames.slice(1);
  assert.ok(output.every((f) => f.type === "output"));
  assert.ok(output.length <= 2, `5000 chunks coalesced, got ${output.length} frames`);
  assert.equal(output.at(-1).seq, 5000);
  assert.equal(output.map((f) => f.data).join(""), Array.from({ length: 5000 }, (_, i) => `r${i + 1};`).join(""));
});

test("a reconnect replays only what the client has not seen", async (t) => {
  const { frames, settle } = await open(t, fakeSession(10), 7);
  await settle();
  assert.deepEqual(frames.slice(1).map((f) => [f.seq, f.data]), [[10, "r8;r9;r10;"]]);
});

test("live output is batched, never merged into the replay, and stays ordered around other frames", async (t) => {
  const session = fakeSession(3);
  const { frames, settle } = await open(t, session);
  await settle();
  assert.deepEqual(frames.slice(1).map((f) => f.seq), [3], "replay is its own frame");
  for (let i = 0; i < 200; i += 1) session.emit(`a${i};`);
  session.state();
  session.emit("after;");
  await settle();
  const live = frames.slice(2);
  assert.deepEqual(live.map((f) => f.type), ["output", "state", "output"]);
  assert.equal(live[0].seq, 203);
  assert.equal(live[0].data, Array.from({ length: 200 }, (_, i) => `a${i};`).join(""));
  assert.deepEqual([live[2].seq, live[2].data], [204, "after;"]);
});

test("closing the socket unsubscribes it and drops buffered output", async (t) => {
  const session = fakeSession(0);
  const { settle, ws } = await open(t, session);
  await settle();
  assert.equal(session.listeners.size, 1);
  session.emit("pending;");
  ws.terminate();
  await settle();
  assert.equal(session.listeners.size, 0);
});
