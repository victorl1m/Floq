import test from "node:test";
import assert from "node:assert/strict";
import { IdempotencyCache } from "../dist/idempotency.js";

test("coalesces concurrent create requests and replays the successful result", async () => {
  const cache = new IdempotencyCache();
  let creates = 0;
  let finish;
  const operation = () => {
    creates++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = cache.run("user", "request-key", "payload", operation);
  const duplicate = cache.run("user", "request-key", "payload", operation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  finish({ id: "session" });
  assert.deepEqual(await first, { id: "session" });
  assert.deepEqual(await duplicate, { id: "session" });
  assert.deepEqual(await cache.run("user", "request-key", "payload", operation), { id: "session" });
  assert.equal(creates, 1);
});

test("isolates scopes, rejects key reuse with a different payload, and permits retry after failure", async () => {
  const cache = new IdempotencyCache();
  await cache.run("user-a", "key", "one", async () => "a");
  await assert.rejects(cache.run("user-a", "key", "two", async () => "wrong"), /different input/);
  assert.equal(await cache.run("user-b", "key", "two", async () => "b"), "b");
  await assert.rejects(cache.run("user-a", "failed", "x", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await cache.run("user-a", "failed", "x", async () => "retry"), "retry");
});
