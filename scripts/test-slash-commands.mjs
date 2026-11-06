import test from "node:test";
import assert from "node:assert/strict";
import { matchSlash, slashCommandsFor } from "../src/components/canvas/slash-commands.ts";

test("only a leading single-word slash offers commands", () => {
  assert.ok(matchSlash("claude", "/").length > 5);
  assert.deepEqual(matchSlash("claude", "hello /co"), []);
  assert.deepEqual(matchSlash("claude", "/compact now"), []);
  assert.deepEqual(matchSlash("claude", ""), []);
});

test("prefix matches come first, then contains; providers differ; shells get none", () => {
  const names = matchSlash("claude", "/co").map((c) => c.name);
  assert.equal(names[0], "compact");
  assert.ok(names.includes("config") && names.includes("context") && names.includes("cost"));
  assert.ok(names.indexOf("compact") < names.indexOf("export") || !names.includes("export"));
  assert.ok(matchSlash("codex", "/new").some((c) => c.name === "new"));
  assert.ok(!matchSlash("claude", "/new").some((c) => c.name === "new"));
  assert.deepEqual(slashCommandsFor("shell"), []);
});
