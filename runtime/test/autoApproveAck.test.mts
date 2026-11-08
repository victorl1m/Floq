import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { SettingsStore } from "../dist/settings.js";

function store() {
  const row: Record<string, unknown> = { user_id: "u1", claude_auto_approve: true, codex_auto_approve: true, auto_approve_ack_at: null };
  let exists = false;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT * FROM user_settings")) return { rows: exists ? [row] : [] };
      if (sql.startsWith("SELECT login")) return { rows: [] };
      if (sql.startsWith("INSERT INTO user_settings")) { exists = true; return { rows: [] }; }
      if (sql.startsWith("UPDATE user_settings")) {
        if (sql.includes("auto_approve_ack_at = COALESCE")) row.auto_approve_ack_at ??= new Date();
        if (sql.includes("claude_auto_approve = $2")) row.claude_auto_approve = values[1];
        if (sql.includes("codex_auto_approve = $3") || sql.includes("codex_auto_approve = $2")) row.codex_auto_approve = values[sql.includes("claude_auto_approve = $2") ? 2 : 1];
        return { rows: [] };
      }
      throw new Error("unexpected query " + sql);
    },
  } as never as pg.Pool;
  return new SettingsStore(pool, { gitCoauthor: "", encryptionKey: Buffer.alloc(32) } as never);
}

test("auto-approve stays on by default and starts unacknowledged", async () => {
  const s = await store().get("u1");
  assert.equal(s.claudeAutoApprove, true);
  assert.equal(s.codexAutoApprove, true);
  assert.equal(s.autoApproveAcknowledged, false);
});

test("'keep on' records the acknowledgement without changing auto-approve", async () => {
  const st = store();
  const s = await st.update("u1", { autoApproveAcknowledged: true });
  assert.equal(s.autoApproveAcknowledged, true);
  assert.equal(s.claudeAutoApprove, true);
  assert.equal(s.codexAutoApprove, true);
});

test("'turn off' records the acknowledgement and disables auto-approve for both providers", async () => {
  const s = await store().update("u1", { claudeAutoApprove: false, codexAutoApprove: false, autoApproveAcknowledged: true });
  assert.equal(s.autoApproveAcknowledged, true);
  assert.equal(s.claudeAutoApprove, false);
  assert.equal(s.codexAutoApprove, false);
});

test("the acknowledgement cannot be withdrawn or set to a non-true value", async () => {
  const st = store();
  await assert.rejects(st.update("u1", { autoApproveAcknowledged: false as never }), /only be set to true/);
  await assert.rejects(st.update("u1", { autoApproveAcknowledged: "yes" as never }), /only be set to true/);
});
