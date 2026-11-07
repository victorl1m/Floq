import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_BLOCK, hasFloqInstructions, runSetup } from "../image/floq-setup.mts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "floq-setup-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const cli = fileURLToPath(new URL("../dist/image/floq.mjs", import.meta.url));
const setupCli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, "setup", ...args], {
  cwd, encoding: "utf8", env: { ...process.env, FLOQ_API_URL: "http://127.0.0.1:1", FLOQ_AGENT_TOKEN: "setup-test" },
});

test("appending preserves all existing bytes, including trailing whitespace", () => {
  const d = tmp();
  const original = "# Mine\n\nKeep this line.  \n\n\t\n";
  writeFileSync(join(d, "CLAUDE.md"), original);
  runSetup(d);
  assert.ok(readFileSync(join(d, "CLAUDE.md"), "utf8").startsWith(original));
});

test("CLI dry-run with --agents previews both files in either flag order without writing", () => {
  for (const flags of [["--agents", "--dry-run"], ["--dry-run", "--agents"]]) {
    const d = tmp();
    const result = setupCli(d, ...flags);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(d, "CLAUDE.md")), false);
    assert.equal(existsSync(join(d, "AGENTS.md")), false);
    assert.match(result.stdout, /CLAUDE.md: would create/);
    assert.match(result.stdout, /AGENTS.md: would create/);
    assert.doesNotMatch(result.stdout, /Apply these rules now/);
  }
});

test("CLI rejects stray arguments before creating instruction files", () => {
  const d = tmp();
  const result = setupCli(d, "unexpected");
  assert.equal(result.status, 2);
  assert.equal(existsSync(join(d, "CLAUDE.md")), false);
});

test("CLI writes at the Git root from a subdirectory and creates Codex instructions", () => {
  const d = tmp();
  assert.equal(spawnSync("git", ["init", d]).status, 0);
  const sub = join(d, "nested");
  mkdirSync(sub);
  assert.equal(setupCli(sub, "--agents").status, 0);
  assert.match(readFileSync(join(d, "AGENTS.md"), "utf8"), /floq:setup:start/);
  assert.equal(existsSync(join(sub, "CLAUDE.md")), false);
  const before = readFileSync(join(d, "AGENTS.md"), "utf8");
  assert.match(setupCli(sub, "--agents").stdout, /already set up/);
  assert.equal(readFileSync(join(d, "AGENTS.md"), "utf8"), before);
});

test("creates CLAUDE.md with the block; AGENTS.md is not created", () => {
  const d = tmp();
  assert.deepEqual(runSetup(d), [{ file: "CLAUDE.md", action: "created" }]);
  assert.equal(readFileSync(join(d, "CLAUDE.md"), "utf8"), SETUP_BLOCK + "\n");
  assert.equal(existsSync(join(d, "AGENTS.md")), false);
});

test("appends after existing user content and leaves it untouched; second run is a no-op", () => {
  const d = tmp();
  writeFileSync(join(d, "CLAUDE.md"), "# Mine\n\nUse tabs.\n");
  writeFileSync(join(d, "AGENTS.md"), "# Agents\n");
  assert.deepEqual(runSetup(d).map((r) => r.action), ["appended", "appended"]);
  assert.ok(readFileSync(join(d, "CLAUDE.md"), "utf8").startsWith("# Mine\n\nUse tabs.\n\n<!-- floq:setup:start"));
  const before = readFileSync(join(d, "CLAUDE.md"), "utf8");
  assert.deepEqual(runSetup(d).map((r) => r.action), ["already", "already"]);
  assert.equal(readFileSync(join(d, "CLAUDE.md"), "utf8"), before);
});

test("hand-written Floq guidance counts as already set up; dry run writes nothing", () => {
  const d = tmp();
  writeFileSync(join(d, "CLAUDE.md"), "Recruit with `floq subagent recruit`.\n");
  assert.equal(runSetup(d)[0].action, "already");
  assert.equal(hasFloqInstructions("nothing about it"), false);
  const e = tmp();
  assert.equal(runSetup(e, true)[0].action, "created");
  assert.equal(existsSync(join(e, "CLAUDE.md")), false);
});

test("block stays small and tells agents not to block", () => {
  assert.ok(SETUP_BLOCK.length < 3500);
  assert.match(SETUP_BLOCK, /--no-wait/);
  assert.match(SETUP_BLOCK, /Never freeze/);
});

test("CRLF files keep CRLF line endings", () => {
  const d = tmp();
  writeFileSync(join(d, "CLAUDE.md"), "# Mine\r\n");
  runSetup(d);
  assert.ok(!/[^\r]\n/.test(readFileSync(join(d, "CLAUDE.md"), "utf8")));
});

test("the injected system block carries the non-blocking rules for every agent and stays small", async () => {
  const { buildSubagentInstruction } = await import("../src/subagents.ts");
  for (const enabled of [true, false]) for (const depth of [0, 1]) {
    const text = buildSubagentInstruction({ enabled, depth });
    assert.match(text, /Conversation never blocks/);
    assert.match(text, /final text is NOT delivered/);
    assert.ok(text.length < 12_000, "system block budget: " + text.length);
  }
});
