import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecruitSkillsBlock, parseRecruitSkills, storedRecruitSkills } from "../src/recruitSkills.js";

test("parseRecruitSkills accepts comma lists and arrays, trims and de-duplicates case-insensitively", () => {
  assert.deepEqual(parseRecruitSkills("artifact-design, artifact-capabilities"), ["artifact-design", "artifact-capabilities"]);
  assert.deepEqual(parseRecruitSkills(["a", "anthropic-skills:docs"]), ["a", "anthropic-skills:docs"]);
  assert.deepEqual(parseRecruitSkills("Docs,docs, DOCS ,x"), ["Docs", "x"]);
});

test("parseRecruitSkills returns [] for empty input", () => {
  for (const v of [undefined, null, "", false, [], " , "]) assert.deepEqual(parseRecruitSkills(v), []);
});

test("parseRecruitSkills rejects bad names, non-strings and more than 8", () => {
  for (const v of ["bad name", "../x", "-x", "a".repeat(81), [1], 5, { a: 1 }]) assert.throws(() => parseRecruitSkills(v), (e: any) => e.status === 400 || /skill/i.test(String(e.message)));
  assert.equal(parseRecruitSkills("1,2,3,4,5,6,7,8").length, 8);
  assert.throws(() => parseRecruitSkills("1,2,3,4,5,6,7,8,9"), /At most 8/);
});

test("storedRecruitSkills never throws", () => {
  assert.deepEqual(storedRecruitSkills(null), []);
  assert.deepEqual(storedRecruitSkills("a,b"), []);
  assert.deepEqual(storedRecruitSkills(["bad name", "ok"]), []);
  assert.deepEqual(storedRecruitSkills(["ok", 3, "ok2"]), ["ok", "ok2"]);
});

test("buildRecruitSkillsBlock is empty without skills and provider specific otherwise", () => {
  assert.equal(buildRecruitSkillsBlock([], "claude"), "");
  const claude = buildRecruitSkillsBlock(["artifact-design"], "claude");
  assert.ok(claude.includes("[FLOQ RECRUIT SKILLS]") && claude.includes("`artifact-design`") && claude.includes("Skill tool"));
  const codex = buildRecruitSkillsBlock(["artifact-design"], "codex");
  assert.ok(codex.includes("SKILL.md") && !codex.includes("Skill tool"));
});
