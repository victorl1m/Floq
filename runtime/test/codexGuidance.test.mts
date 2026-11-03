import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOQ_CODEX_GUIDANCE, FLOQ_GUIDANCE_BEGIN, FLOQ_GUIDANCE_END, mergeFloqGuidance, syncCodexManagedGuidance, syncProtectedFloqSkill } from "../dist/codexGuidance.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "floq-codex-guidance-"));
}

const owner = () => typeof process.getuid === "function" ? process.getuid() : undefined;

test("managed instructions preserve user text and update idempotently", () => {
  const existing = "# My instructions\nKeep my preferred editor.\n";
  const first = mergeFloqGuidance(existing);
  assert.ok(first.startsWith(existing.trimEnd()));
  assert.ok(first.includes(FLOQ_CODEX_GUIDANCE));
  assert.equal(mergeFloqGuidance(first), first);
});

test("image seed uses the same managed guidance that start/resume refreshes", () => {
  const buildScript = readFileSync(join(process.cwd(), "image", "build-skel.sh"), "utf8");
  const begin = buildScript.indexOf(FLOQ_GUIDANCE_BEGIN);
  const end = buildScript.indexOf(FLOQ_GUIDANCE_END);
  assert.ok(begin >= 0 && end > begin);
  const block = buildScript.slice(begin, end + FLOQ_GUIDANCE_END.length).replace(/\r\n/g, "\n");
  assert.equal(block, FLOQ_CODEX_GUIDANCE);
});

test("start/resume sync updates the effective non-empty override, preserving the standard file", (t) => {
  const home = fixture();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const standard = join(home, "AGENTS.md");
  const override = join(home, "AGENTS.override.md");
  writeFileSync(standard, "# Standard\nUser standard instructions.\n");
  writeFileSync(override, "# Override\nUser override instructions.\n");
  assert.equal(syncCodexManagedGuidance(home, owner()), override);
  assert.equal(readFileSync(standard, "utf8"), "# Standard\nUser standard instructions.\n");
  const updated = readFileSync(override, "utf8");
  assert.ok(updated.startsWith("# Override\nUser override instructions."));
  assert.ok(updated.includes("floq mcp list --provider codex"));
  assert.equal(syncCodexManagedGuidance(home, owner()), override);
  assert.equal(readFileSync(override, "utf8"), updated);
});

test("empty override falls back to standard AGENTS instructions", (t) => {
  const home = fixture();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const standard = join(home, "AGENTS.md");
  writeFileSync(join(home, "AGENTS.override.md"), "");
  writeFileSync(standard, "Keep the user's existing global instructions.\n");
  assert.equal(syncCodexManagedGuidance(home, owner()), standard);
  assert.ok(readFileSync(standard, "utf8").startsWith("Keep the user's existing global instructions."));
});

test("protected Floq skill refresh updates canonical files without deleting unrelated files", (t) => {
  const home = fixture();
  const source = fixture();
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); });
  const sourceSkill = join(source, "SKILL.md");
  const destinationSkill = join(home, "skills", "floq-orchestrate", "SKILL.md");
  mkdirSync(join(home, "skills", "floq-orchestrate", "references"), { recursive: true });
  writeFileSync(destinationSkill, "Old bundled guidance");
  writeFileSync(join(home, "skills", "floq-orchestrate", "custom.md"), "User file");
  writeFileSync(sourceSkill, "New canonical guidance");
  mkdirSync(join(source, "references"));
  writeFileSync(join(source, "references", "inspiration.md"), "Reference");
  syncProtectedFloqSkill(home, source, owner());
  assert.equal(readFileSync(destinationSkill, "utf8"), "New canonical guidance");
  assert.equal(readFileSync(join(home, "skills", "floq-orchestrate", "custom.md"), "utf8"), "User file");
  assert.equal(readFileSync(join(home, "skills", "floq-orchestrate", "references", "inspiration.md"), "utf8"), "Reference");
});

test("managed sync refuses to follow an AGENTS override symlink", (t) => {
  const home = fixture();
  const outside = join(home, "outside.md");
  const linkHome = join(home, "session");
  mkdirSync(linkHome);
  writeFileSync(outside, "Do not modify this file");
  try { symlinkSync(outside, join(linkHome, "AGENTS.override.md")); }
  catch { t.skip("symlinks are unavailable in this environment"); return; }
  assert.throws(() => syncCodexManagedGuidance(linkHome, owner()), /unsafe Codex instruction path/);
  assert.equal(readFileSync(outside, "utf8"), "Do not modify this file");
  t.after(() => rmSync(home, { recursive: true, force: true }));
});
