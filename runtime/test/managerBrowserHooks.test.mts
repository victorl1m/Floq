import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../dist/manager.js";

function make(lockMs = 20) {
  const slept: string[] = [];
  const stopped: string[] = [];
  const shards = { sleep: async (id: string) => { stopped.push("order:" + (stopped.length)); slept.push(id); }, driver: { name: "local" } };
  const m = new SessionManager({ shardLockDelayMs: lockMs, models: { codex: [] } } as never, {} as never, shards as never, {} as never);
  const browser: { stop(u: string, r?: string): Promise<void>; onActivity?: (u: string, r: boolean) => void } = { stop: async (u, r) => { stopped.push(`stop:${u}:${r}`); } };
  m.attachBrowser(browser);
  return { m, browser, slept, stopped };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("running browser holds the shard awake; the lock follows once it stops, browser stopped first", async (t) => {
  const { m, browser, slept, stopped } = make();
  t.after(() => clearInterval((m as never as { reaper: NodeJS.Timeout }).reaper));
  browser.onActivity!("u1", true);
  (m as never as { scheduleLock(u: string): void }).scheduleLock("u1");
  await wait(60);
  assert.deepEqual(slept, []);
  browser.onActivity!("u1", true); // idempotent
  browser.onActivity!("u1", false);
  await wait(80);
  assert.deepEqual(slept, ["u1"]);
  assert.equal(stopped[0], "stop:u1:sleep");
});

test("sleepUser stops the browser before the shard sleeps", async (t) => {
  const { m, slept, stopped } = make();
  t.after(() => clearInterval((m as never as { reaper: NodeJS.Timeout }).reaper));
  await m.sleepUser("u2", "logout");
  assert.equal(stopped[0], "stop:u2:sleep");
  assert.deepEqual(slept, ["u2"]);
});
