import test from "node:test";
import assert from "node:assert/strict";
import { CodexModelCatalog, fetchCodexModelList } from "../dist/codexModels.js";

test("fetches visible model pages and uses the CLI model id", async () => {
  const calls = [];
  const rpc = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return {};
      if (!params.cursor) {
        return {
          data: [
            { id: "internal-id", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "Balanced" },
            { id: "hidden", hidden: true, displayName: "Hidden" },
          ],
          nextCursor: "page-2",
        };
      }
      return { data: [{ id: "visible-two", displayName: "Visible Two", hidden: false }], nextCursor: null };
    },
    notify(method) { calls.push({ method }); },
  };
  const models = await fetchCodexModelList(rpc, "test-version", [{ id: "fallback", label: "Fallback" }]);
  assert.deepEqual(models, [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", description: "Balanced" },
    { id: "visible-two", label: "Visible Two" },
  ]);
  assert.equal(calls[0].method, "initialize");
  assert.equal(calls[1].method, "initialized");
  assert.equal(calls[2].method, "model/list");
  assert.equal(calls[2].params.includeHidden, false);
  assert.equal(calls[3].params.cursor, "page-2");
});

test("caches and deduplicates by user, without sharing account catalogs", async () => {
  const calls = [];
  const catalog = new CodexModelCatalog(async (userId) => {
    calls.push(userId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [{ id: `model-${userId}`, label: userId }];
  }, [], 60_000);
  const [first, duplicate] = await Promise.all([catalog.get("user-a"), catalog.get("user-a")]);
  const other = await catalog.get("user-b");
  assert.deepEqual(first, duplicate);
  assert.deepEqual(other, [{ id: "model-user-b", label: "user-b" }]);
  assert.deepEqual(calls, ["user-a", "user-b"]);
});

test("uses the configured fallback when discovery times out", async () => {
  const fallback = [{ id: "safe-fallback", label: "Fallback" }];
  const catalog = new CodexModelCatalog(async () => { throw new Error("simulated timeout"); }, fallback, 60_000);
  assert.deepEqual(await catalog.get("user-a"), fallback);
});

test("invalidating a user detaches an old account request and avoids stale cache writes", async () => {
  const resolvers = [];
  let calls = 0;
  const catalog = new CodexModelCatalog(() => new Promise((resolve) => {
    calls++;
    resolvers.push(resolve);
  }), [], 60_000);
  const oldAccountRequest = catalog.get("user-a");
  catalog.invalidate("user-a");
  const newAccountRequest = catalog.get("user-a");
  resolvers[0]([{ id: "old-account", label: "Old account" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  resolvers[1]([{ id: "new-account", label: "New account" }]);
  assert.deepEqual(await newAccountRequest, [{ id: "new-account", label: "New account" }]);
  assert.deepEqual(await oldAccountRequest, [{ id: "new-account", label: "New account" }]);
  assert.deepEqual(await catalog.get("user-a"), [{ id: "new-account", label: "New account" }]);
});
