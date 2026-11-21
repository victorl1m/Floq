import test, { mock } from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugins/storage-sense/index.js";

function fake(awake: string[]) {
  const kv = new Map<string, unknown>();
  const routes = new Map<string, (a: any) => Promise<any>>();
  const scheduled: { ms: number; fn: () => Promise<void> }[] = [];
  const runs: unknown[] = [];
  const ctx: any = {
    kv: { get: async (u: string, k: string) => kv.get(u + k), set: async (u: string, k: string, v: unknown) => { kv.set(u + k, v); } },
    settings: { get: async () => ({}) },
    enabledUserIds: async () => ["u"],
    events: { publish: () => undefined },
    log: { info: () => undefined, warn: () => undefined },
    routes: { get: (p: string, h: any) => routes.set("GET" + p, h), post: (p: string, h: any) => routes.set("POST" + p, h) },
    schedule: (ms: number, fn: () => Promise<void>) => { scheduled.push({ ms, fn }); return () => undefined; },
    httpError: (s: number, c: string, m: string) => new Error(c + m),
    storageSense: {
      awakeUserIds: () => awake, freePercent: async () => 23.5, notify: async () => undefined,
      run: async (_u: string, _c: unknown, o: any) => { runs.push(o); return { at: new Date().toISOString(), dryRun: o.dryRun, trigger: o.trigger, durationMs: 1, partial: false, freedBytes: 0, freePercentBefore: 23.5, counts: { removed: 0, kept: 0, failed: 0, attention: 0 }, entries: [] }; },
    },
  };
  return { ctx, kv, routes, scheduled, runs };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

test("the first automatic run happens within minutes of start, and a run that removes nothing still stores a report", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake(["u"]);
  try {
    await plugin.start!(f.ctx);
    assert.ok(f.scheduled[0].ms <= 5 * 60_000, "re-check interval is a few minutes");
    mock.timers.tick(60_000);
    await flush();
    assert.equal(f.runs.length, 1);
    assert.equal((f.runs[0] as any).trigger, "schedule");
    const state = await f.routes.get("GET/state")!({ userId: "u" });
    assert.ok(state.report && state.lastRunAt, "report stored even though nothing was removed");
    assert.equal(state.report.counts.removed, 0);
    // not due again until a day passes
    await f.scheduled[0].fn();
    assert.equal(f.runs.length, 1);
  } finally { await plugin.stop?.(); mock.timers.reset(); }
});

test("a sleeping home is skipped, then picked up by the next check once awake", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const awake: string[] = [];
  const f = fake(awake);
  try {
    await plugin.start!(f.ctx);
    mock.timers.tick(60_000); await flush();
    assert.equal(f.runs.length, 0);
    awake.push("u");
    await f.scheduled[0].fn();
    assert.equal(f.runs.length, 1);
  } finally { await plugin.stop?.(); mock.timers.reset(); }
});
