import test from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_CAPABILITIES } from "../dist/capabilities.js";

test("runtime advertises branch-switch-v2", () => {
  assert.ok(RUNTIME_CAPABILITIES.includes("branch-switch-v2"));
});
