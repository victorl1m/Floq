// Run: node --experimental-strip-types --test e2e/slash-commands.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { matchSlash, slashCommandsFor } from "../src/components/canvas/slash-commands.ts";

test("an exact command name is offered first, so Enter sends exactly what was typed", () => {
  for (const provider of ["claude", "codex"]) {
    for (const { name } of slashCommandsFor(provider)) assert.equal(matchSlash(provider, "/" + name)[0]?.name, name, `${provider} /${name}`);
  }
});

test("a prefix still lists the commands that start with it", () => {
  const names = matchSlash("claude", "/mo").map((c) => c.name);
  assert.ok(names.includes("model"));
  assert.ok(names.every((n, i) => i === 0 || n.startsWith("mo") || !names.slice(0, i).some((m) => !m.startsWith("mo"))));
});

test("text with arguments is not a slash query", () => {
  assert.deepEqual(matchSlash("claude", "/model opus"), []);
});
