import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../dist/session.js";

test("native title updates keep the Floq session ID and broadcast a state frame", () => {
  const pty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 42 };
  const session = new Session({
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    userId: "user-1",
    provider: "claude",
    title: "Claude Code",
    cwd: "workspace/repo",
    cols: 120,
    rows: 32,
    outputBufferBytes: 1024,
    pty,
  });
  const frames = [];
  session.subscribe((frame) => frames.push(frame));
  session.setTitle("Fix workspace startup");
  assert.equal(session.toSummary().id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(session.toSummary().title, "Fix workspace startup");
  assert.deepEqual(frames.map((frame) => frame.type), ["state"]);
  assert.equal(frames[0].session.id, session.id);
  session.setTitle("Fix workspace startup");
  assert.equal(frames.length, 1);
});
