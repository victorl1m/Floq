import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { SettingsStore, subagentCeilingsFromEnv } from "../dist/settings.js";

function store(ceilings?: { maxChildren: number; maxTotal: number }) {
  const row: Record<string, unknown> = { user_id: "u1" };
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT * FROM user_settings")) return { rows: [row] };
      if (sql.startsWith("SELECT login")) return { rows: [] };
      if (sql.startsWith("INSERT INTO user_settings")) return { rows: [] };
      if (sql.startsWith("UPDATE user_settings")) {
        if (sql.includes("subagent_max_children = $2")) row.subagent_max_children = values[1];
        if (sql.includes("subagent_max_total = $2") || sql.includes("subagent_max_total = $3")) row.subagent_max_total = values[sql.includes("subagent_max_children = $2") ? 2 : 1];
        return { rows: [] };
      }
      throw new Error("unexpected query " + sql);
    },
  } as never as pg.Pool;
  return new SettingsStore(pool, { gitCoauthor: "", encryptionKey: Buffer.alloc(32) } as never, ceilings);
}

test("ceilings default to the full range and read the operator env", () => {
  assert.deepEqual(subagentCeilingsFromEnv({}), { maxChildren: 32, maxTotal: 200 });
  assert.deepEqual(subagentCeilingsFromEnv({ FLOQ_SUBAGENT_CEIL_CHILDREN: "8", FLOQ_SUBAGENT_CEIL_TOTAL: "40" }), { maxChildren: 8, maxTotal: 40 });
  assert.deepEqual(subagentCeilingsFromEnv({ FLOQ_SUBAGENT_CEIL_CHILDREN: "99", FLOQ_SUBAGENT_CEIL_TOTAL: "x" }), { maxChildren: 32, maxTotal: 200 });
});

test("settings expose the effective ceilings and reject values above them", async () => {
  const st = store({ maxChildren: 8, maxTotal: 40 });
  assert.deepEqual((await st.get("u1")).subagentCeilings, { maxChildren: 8, maxTotal: 40 });
  await assert.rejects(st.update("u1", { subagentMaxChildren: 9 }), /from 1 to 8/);
  await assert.rejects(st.update("u1", { subagentMaxTotal: 41 }), /from 1 to 40/);
  assert.equal((await st.update("u1", { subagentMaxChildren: 8, subagentMaxTotal: 40 })).subagentMaxChildren, 8);
  assert.equal((await store().update("u1", { subagentMaxChildren: 30, subagentMaxTotal: 150 })).subagentMaxTotal, 150, "default ceilings allow raising");
});

test("children <= total is checked against the effective (ceiling-clamped) defaults", async () => {
  // total ceiling 4 makes the effective default total 4, so the default children 6 clamps to ceiling 6 > 4: invalid
  await assert.rejects(store({ maxChildren: 32, maxTotal: 4 }).update("u1", { subagentMaxChildren: 5 }), /cannot exceed total/);
  await assert.rejects(store().update("u1", { subagentMaxChildren: 30 }), /cannot exceed total/, "30 > default total 24");
  await store().update("u1", { subagentMaxChildren: 30, subagentMaxTotal: 40 });
});
