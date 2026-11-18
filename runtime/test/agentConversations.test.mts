import test from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeConversationId, planFreshStart, canSwitchTo, recordConversation, listConversations } from "../dist/agentConversations.js";

test("claude id resolves from the conversation row, falling back to the agent id", () => {
  assert.equal(resolveClaudeConversationId({ id: "a" }), "a");
  assert.equal(resolveClaudeConversationId({ id: "a", claude_conversation_id: null }), "a");
  assert.equal(resolveClaudeConversationId({ id: "a", claude_conversation_id: "b" }), "b");
});
test("fresh start for claude ends the current pointer and mints a new id", () => {
  const plan = planFreshStart("claude", "old", () => "new-uuid");
  assert.deepEqual(plan.endCurrent, { provider: "claude", providerSessionId: "old", reason: "fresh_start" });
  assert.equal(plan.newClaudeId, "new-uuid");
  assert.equal(plan.resume, false);
});
test("fresh start for codex clears the live pointer but keeps history", () => {
  const plan = planFreshStart("codex", "rollout-1");
  assert.equal(plan.newClaudeId, null);
  assert.equal(plan.pointerAfter, null);
  assert.equal(plan.endCurrent?.providerSessionId, "rollout-1");
  assert.equal(planFreshStart("codex", null).endCurrent, null);
});
test("switching is limited to the agent's provider", () => {
  assert.equal(canSwitchTo("claude", { provider: "claude", endedReason: "fresh_start" }), true);
  assert.equal(canSwitchTo("claude", { provider: "codex", endedReason: null }), false);
});
test("recordConversation supersedes the old current pointer then inserts", async () => {
  const calls: string[] = [];
  await recordConversation({ query: async (t: string, v?: unknown[]) => { calls.push(t.split(" ")[0] + ":" + JSON.stringify(v)); return { rows: [] }; } }, "s", "codex", "x");
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^UPDATE/);
  assert.match(calls[1]!, /^INSERT/);
});
test("listConversations maps rows", async () => {
  const rows = await listConversations({ query: async () => ({ rows: [{ id: 3, provider: "claude", provider_session_id: "p", started_at: "2026-11-18T00:00:00Z", ended_reason: null }] }) }, "s");
  assert.deepEqual(rows, [{ id: "3", provider: "claude", providerSessionId: "p", startedAt: "2026-11-18T00:00:00.000Z", endedReason: null, current: true }]);
});
