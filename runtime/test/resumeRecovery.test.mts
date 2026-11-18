import test from "node:test";
import assert from "node:assert/strict";
import { classifyResumeExit, resumeRetryDelay, bootRetryDelay, isTransientBootError, claudeProjectSlug } from "../dist/resumeRecovery.js";

test("classifies conversation-not-found across providers", () => {
  assert.equal(classifyResumeExit("\u001b[31mNo conversation found with session ID: abc\u001b[0m\r\n"), "not_found");
  assert.equal(classifyResumeExit("Error: no rollout found for thread id 123"), "not_found");
  assert.equal(classifyResumeExit("Session not found"), "not_found");
});
test("classifies id-in-use", () => {
  assert.equal(classifyResumeExit("Error: Session ID 1234 is already in use."), "in_use");
});
test("anything else is transient, and only the tail counts", () => {
  assert.equal(classifyResumeExit("ECONNRESET while starting"), "transient");
  assert.equal(classifyResumeExit(""), "transient");
  assert.equal(classifyResumeExit("No conversation found" + "x".repeat(5000)), "transient");
});
test("retry schedules", () => {
  assert.deepEqual([0, 1, 2, 3].map(resumeRetryDelay), [2000, 10000, 30000, null]);
  assert.deepEqual([0, 1, 2].map(bootRetryDelay), [30000, 120000, null]);
});
test("boot errors", () => {
  assert.equal(isTransientBootError({ code: "worktree_deleted" }), false);
  assert.equal(isTransientBootError({ status: 404 }), false);
  assert.equal(isTransientBootError(new Error("not connected")), true);
});
test("claude slug", () => {
  assert.equal(claudeProjectSlug("/home/agent/.floq/x"), "-home-agent--floq-x");
});
