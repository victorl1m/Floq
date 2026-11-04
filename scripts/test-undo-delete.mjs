import test from "node:test";
import assert from "node:assert/strict";
import { PendingDeletes, describeBatch } from "../src/lib/undo-delete.ts";

function harness(extra = {}) {
  const clock = { now: 1000, timers: [] };
  const calls = { finalize: [], unload: [], failed: [], finalized: [] };
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  const options = {
    graceMs: 8000,
    mergeMs: 3000,
    now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, at: clock.now + ms, live: true }; clock.timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
    storage,
    finalize: async (id) => { calls.finalize.push(id); if (extra.fail?.has(id)) throw new Error("boom"); },
    sendOnUnload: (id) => calls.unload.push(id),
    onFailed: (item, error) => calls.failed.push([item.id, error.message]),
    onFinalized: (items) => calls.finalized.push(items.map((i) => i.id)),
    ...extra.options,
  };
  const make = () => new PendingDeletes(options);
  const advance = async (ms) => {
    clock.now += ms;
    for (const t of clock.timers) if (t.live && t.at <= clock.now) { t.live = false; t.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  return { clock, calls, store, make, advance };
}

const item = (id, kind = "terminal") => ({ id, label: `L-${id}`, kind });

test("schedule hides immediately and finalises once after the grace period", async () => {
  const h = harness();
  const reg = h.make();
  reg.schedule([item("a")]);
  assert.ok(reg.has("a"));
  await h.advance(7999);
  assert.deepEqual(h.calls.finalize, []);
  await h.advance(1);
  assert.deepEqual(h.calls.finalize, ["a"]);
  assert.ok(!reg.has("a"));
  assert.deepEqual(h.calls.finalized, [["a"]]);
  await h.advance(20000);
  assert.deepEqual(h.calls.finalize, ["a"], "never sent twice");
  assert.equal(h.store.size, 0);
});

test("undo restores without ever calling the server and cancels the timer", async () => {
  const h = harness();
  const reg = h.make();
  reg.schedule([item("a")]);
  const restored = reg.undo();
  assert.deepEqual(restored.map((i) => i.id), ["a"]);
  assert.ok(!reg.has("a"));
  await h.advance(60000);
  assert.deepEqual(h.calls.finalize, []);
  assert.deepEqual(reg.undo(), [], "nothing left to undo");
});

test("deletes within the merge window aggregate into one batch, others do not", async () => {
  const h = harness();
  const reg = h.make();
  const first = reg.schedule([item("a")]);
  h.clock.now += 2000;
  const second = reg.schedule([item("b"), item("a")]);
  assert.equal(second.key, first.key);
  assert.deepEqual(second.items.map((i) => i.id), ["a", "b"]);
  assert.equal(second.deadline, h.clock.now + 8000, "deadline extends");
  h.clock.now += 5000;
  const third = reg.schedule([item("c")]);
  assert.notEqual(third.key, first.key);
  assert.deepEqual(reg.undo().map((i) => i.id), ["c"], "undo targets the latest batch");
  assert.ok(reg.has("a") && reg.has("b"));
  assert.deepEqual(reg.undo().map((i) => i.id), ["a", "b"]);
});

test("a delete while a previous undo is pending keeps both undoable", async () => {
  const h = harness();
  const reg = h.make();
  reg.schedule([item("a")]);
  h.clock.now += 4000;
  reg.schedule([item("b")]);
  await h.advance(4001);
  assert.deepEqual(h.calls.finalize, ["a"], "older batch expires on its own deadline");
  assert.ok(reg.has("b"));
});

test("dismiss finalises immediately; dismiss after undo is a no-op", async () => {
  const h = harness();
  const reg = h.make();
  const batch = reg.schedule([item("a"), item("b")]);
  await reg.dismiss(batch.key);
  assert.deepEqual(h.calls.finalize.sort(), ["a", "b"]);
  const batch2 = reg.schedule([item("c")]);
  reg.undo(batch2.key);
  await reg.dismiss(batch2.key);
  assert.ok(!h.calls.finalize.includes("c"));
});

test("a failed finalise restores the item and reports it; storage is cleaned", async () => {
  const h = harness({ fail: new Set(["b"]) });
  const reg = h.make();
  reg.schedule([item("a"), item("b")]);
  await h.advance(8000);
  assert.deepEqual(h.calls.failed, [["b", "boom"]]);
  assert.ok(!reg.has("b") && !reg.has("a"));
  assert.deepEqual(h.calls.finalized, [["a"]]);
  assert.equal(h.store.size, 0);
});

test("in-flight ids stay hidden until the server answers", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ options: { finalize: async () => { await gate; } } });
  const reg = h.make();
  reg.schedule([item("a")]);
  await h.advance(8000);
  assert.ok(reg.has("a"));
  assert.equal(reg.latest(), null, "no longer undoable");
  release();
  await new Promise((r) => setImmediate(r));
  assert.ok(!reg.has("a"));
});

test("flushAll sends keepalive deletes, stops timers, keeps the ids persisted", async () => {
  const h = harness();
  const reg = h.make();
  reg.schedule([item("a"), item("b")]);
  reg.flushAll();
  assert.deepEqual(h.calls.unload.sort(), ["a", "b"]);
  await h.advance(60000);
  assert.deepEqual(h.calls.finalize, [], "timer cancelled");
  assert.ok(reg.has("a"));
  assert.equal(JSON.parse(h.store.get("floq.pendingDeletes")).length, 2);
});

test("a new registry recovers persisted deletes: hidden at once, finalised on recover()", async () => {
  const h = harness();
  const first = h.make();
  first.schedule([item("a", "agent"), item("b")]);
  first.flushAll();
  const second = h.make();
  assert.ok(second.has("a") && second.has("b"), "hidden before the client is ready");
  assert.equal(second.latest(), null, "no undo after a reload");
  await second.recover();
  assert.deepEqual(h.calls.finalize.sort(), ["a", "b"]);
  assert.ok(!second.has("a"));
  assert.equal(h.store.size, 0);
  const third = h.make();
  assert.ok(!third.has("a"));
});

test("recover reports failures and restores the item", async () => {
  const h = harness({ fail: new Set(["a"]) });
  const first = h.make();
  first.schedule([item("a")]);
  first.flushAll();
  const second = h.make();
  await second.recover();
  assert.deepEqual(h.calls.failed, [["a", "boom"]]);
  assert.ok(!second.has("a"));
});

test("corrupt storage is ignored and subscribers are notified", () => {
  const h = harness();
  h.store.set("floq.pendingDeletes", "{not json");
  const reg = h.make();
  assert.equal(reg.pendingIds().size, 0);
  let n = 0;
  reg.subscribe(() => n++);
  reg.schedule([item("a")]);
  reg.undo();
  assert.equal(n, 2);
});

test("describeBatch wording", () => {
  assert.equal(describeBatch([item("a")]).title, 'Terminal "L-a" deleted');
  assert.equal(describeBatch([item("a"), item("b")]).title, "2 terminals deleted");
  assert.equal(describeBatch([item("a", "agent"), item("b", "agent")]).title, "2 agents deleted");
  assert.equal(describeBatch([item("a"), item("b", "agent")]).title, "2 sessions deleted");
});
