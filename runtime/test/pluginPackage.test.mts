import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_MAX_BYTES, PackageError, compareVersions, parsePackage, safeSkillPath, sha256Hex } from "../dist/plugins/package.js";

const manifest = (over: Record<string, unknown> = {}) => ({ id: "echo2", name: "Echo 2", version: "1.2.0", apiVersion: 1, tier: "core", description: "d", scope: "user", contributes: { skills: ["hello"] }, ...over });
const pkg = (over: Record<string, unknown> = {}) => ({ format: 1, manifest: manifest(), runtime: "export default {};", ui: null, skills: { hello: { "SKILL.md": "---\nname: hello\ndescription: d\n---\n" } }, ...over });
const bytes = (p: unknown) => Buffer.from(JSON.stringify(p));
const ref = (b: Buffer, over: Record<string, unknown> = {}) => ({ id: "echo2", version: "1.2.0", sha256: sha256Hex(b), ...over });
const parse = (p: unknown, over: Record<string, unknown> = {}, builtins: string[] = ["movidesk"]) => { const b = bytes(p); return parsePackage(b, ref(b, over) as never, { builtinIds: builtins }); };
const rejects = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PackageError && re.test(e.message));

test("a valid package parses and records the verified sha256", () => {
  const b = bytes(pkg());
  const p = parsePackage(b, ref(b) as never, { builtinIds: ["movidesk"] });
  assert.equal(p.manifest.id, "echo2");
  assert.equal(p.sha256, sha256Hex(b));
  assert.equal(p.ui, null);
  assert.deepEqual(Object.keys(p.skills.hello), ["SKILL.md"]);
  assert.equal(parse(pkg({ ui: "export default {};" })).ui, "export default {};");
});

test("a sha256 mismatch is refused before anything is parsed", () => {
  const b = bytes(pkg());
  rejects(() => parsePackage(b, ref(b, { sha256: "0".repeat(64) }) as never, { builtinIds: [] }), /sha256/);
  rejects(() => parsePackage(b, ref(b, { sha256: "xyz" }) as never, { builtinIds: [] }), /sha256/);
  rejects(() => parsePackage(Buffer.concat([b, Buffer.from(" ")]), ref(b) as never, { builtinIds: [] }), /sha256/); // one extra byte
  rejects(() => parsePackage(Buffer.from("not json"), { id: "echo2", version: "1.2.0", sha256: sha256Hex("not json") }, { builtinIds: [] }), /valid JSON/);
});

test("id and version must match the catalog entry; built-in ids are refused", () => {
  rejects(() => parse(pkg(), { id: "other" }), /id does not match/);
  rejects(() => parse(pkg(), { version: "9.9.9" }), /version does not match/);
  rejects(() => parse(pkg(), {}, ["echo2"]), /built-in/);
  rejects(() => parse(pkg({ manifest: manifest({ apiVersion: 2 }) })), /manifest is invalid/);
  rejects(() => parse(pkg({ manifest: manifest({ tier: "external" }) })), /manifest is invalid/);
});

test("an oversize package is refused", () => {
  const big = Buffer.alloc(PACKAGE_MAX_BYTES + 1, 97);
  rejects(() => parsePackage(big, { id: "echo2", version: "1.2.0", sha256: sha256Hex(big) }, { builtinIds: [] }), /larger than 5 MiB/);
});

test("runtime, ui and format are checked", () => {
  rejects(() => parse(pkg({ runtime: 5 })), /runtime/);
  rejects(() => parse(pkg({ runtime: "  " })), /runtime/);
  rejects(() => parse(pkg({ ui: 5 })), /ui must/);
  rejects(() => parse(pkg({ format: 2 })), /format/);
  rejects(() => parse(pkg({ extra: 1 })), /unknown key/);
  rejects(() => parse([1, 2] as never), /object/);
});

test("skill paths and sizes follow the addSkillPackage rules", () => {
  for (const bad of ["../x", "/abs", "a\\b", "a:b", "a//b", ".", "..", "a/./b", "trailing.", "sp ace ", "\u0000x", "x".repeat(241)]) assert.ok(!safeSkillPath(bad), JSON.stringify(bad));
  for (const ok of ["SKILL.md", "docs/guide.md", "a b.md"]) assert.ok(safeSkillPath(ok), ok);
  const withFiles = (files: Record<string, unknown>) => pkg({ skills: { hello: files } });
  rejects(() => parse(withFiles({ "SKILL.md": "x", "../evil": "y" })), /unsafe/);
  rejects(() => parse(withFiles({ "SKILL.md": 5 })), /text/);
  rejects(() => parse(withFiles({ "SKILL.md": "a\u0000b" })), /text/);
  rejects(() => parse(withFiles({ "SKILL.md": "x".repeat(64 * 1024 + 1) })), /64 KiB/);
  rejects(() => parse(withFiles({ "README.md": "x" })), /SKILL\.md/);
  rejects(() => parse(withFiles({})), /1-120 files/);
  rejects(() => parse(withFiles(Object.fromEntries(Array.from({ length: 121 }, (_, i) => [`f${i}.md`, "x"])))), /1-120 files/);
  rejects(() => parse(withFiles({ "SKILL.md": "x", ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`big${i}.md`, "y".repeat(60 * 1024)])) })), /512 KiB/);
  rejects(() => parse(pkg({ skills: { "Bad Name": { "SKILL.md": "x" } } })), /skill name/);
  rejects(() => parse(pkg({ skills: {} })), /declares a skill the package does not contain/);
  rejects(() => parse(pkg({ skills: "x" })), /skills must be an object/);
});

test("error messages never echo package content", () => {
  const secret = "SECRET_VALUE_IN_PACKAGE";
  for (const p of [pkg({ runtime: 5, [secret]: 1 }), pkg({ manifest: manifest({ id: secret }) }), pkg({ skills: { hello: { [secret + "/../x"]: "y" } } })]) {
    try { parse(p as never); assert.fail("should reject"); } catch (e) { assert.ok(e instanceof PackageError); assert.ok(!e.message.includes(secret), e.message); }
  }
});

test("semver comparison orders versions and refuses to treat equal as newer", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
});
