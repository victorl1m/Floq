import test from "node:test";
import assert from "node:assert/strict";
import { parseManifest, ManifestError } from "../dist/plugins/manifest.js";

const valid = () => ({
  id: "movidesk", name: "Movidesk", version: "1.0.0", apiVersion: 1, tier: "core",
  description: "Movidesk tickets as a Tasks source.", icon: "IconHeadset", scope: "user",
  secrets: [{ name: "MOVIDESK_TOKEN", description: "API token", required: true }],
  network: { allow: ["api.movidesk.com"] },
  settings: [{ key: "defaultQuery", type: "text", label: "Default filter", required: false }],
  contributes: {
    views: [{ id: "inbox", label: "Inbox", icon: "IconInbox" }],
    taskSources: [{ id: "tickets", label: "Movidesk", view: "generic" }],
    mcpServers: [{ name: "md", type: "stdio", command: "md-mcp", envSecrets: { MD_TOKEN: "MOVIDESK_TOKEN" } }],
    routes: true, migrations: true,
  },
});
const rejects = (m: unknown, re: RegExp) => assert.throws(() => parseManifest(m), (e: unknown) => e instanceof ManifestError && re.test(e.message));

test("a valid manifest parses and gets defaults", () => {
  const m = parseManifest(valid());
  assert.equal(m.id, "movidesk");
  assert.equal(m.contributes.views.length, 1);
  assert.deepEqual(m.contributes.rightSidebarTabs, []);
  assert.equal(m.contributes.internalRoutes, false);
});
test("minimal manifest parses", () => {
  const m = parseManifest({ id: "ab", name: "A", version: "0.1.0", apiVersion: 1, tier: "core", description: "d", scope: "install" });
  assert.deepEqual(m.secrets, []);
  assert.deepEqual(m.network.allow, []);
});
test("rejects a bad id", () => { for (const id of ["A1", "x", "1ab", "a_b", "a".repeat(33), "a--b", "ab-", "a-"]) rejects({ ...valid(), id }, /id/); });
test("rejects unknown keys at every level", () => {
  rejects({ ...valid(), bogus: 1 }, /unknown key/);
  rejects({ ...valid(), contributes: { ...valid().contributes, nope: 1 } }, /unknown key/);
  rejects({ ...valid(), secrets: [{ name: "A_B", extra: 1 }] }, /unknown key/);
});
test("rejects an undeclared envSecrets reference", () => {
  const m = valid(); m.contributes.mcpServers[0].envSecrets = { X: "OTHER_SECRET" };
  rejects(m, /undeclared secret/);
});
test("rejects an undeclared headerSecrets placeholder", () => {
  const m: any = valid(); m.contributes.mcpServers = [{ name: "h", type: "http", url: "https://x.test", headerSecrets: { Authorization: "Bearer {{NOPE}}" } }];
  rejects(m, /undeclared secret/);
});
test("rejects a secret name failing VAULT_NAME", () => {
  for (const name of ["lower", "1ABC", "A-B", "A".repeat(65)]) rejects({ ...valid(), secrets: [{ name }] }, /secret name/);
});
test("rejects tier external", () => rejects({ ...valid(), tier: "external" }, /tier/));
test("rejects apiVersion other than 1", () => { rejects({ ...valid(), apiVersion: 2 }, /apiVersion/); rejects({ ...valid(), apiVersion: "1" }, /apiVersion/); });
test("rejects a duplicate view id", () => {
  const m = valid(); m.contributes.views.push({ id: "inbox", label: "Again", icon: "x" });
  rejects(m, /duplicate view id/);
});
test("rejects bad view and source ids", () => {
  const m = valid(); m.contributes.views[0].id = "Bad_Id"; rejects(m, /view id/);
  const s = valid(); s.contributes.taskSources[0].id = "9x"; rejects(s, /task source id/);
});
test("rejects the reserved canvasNodes", () => {
  rejects({ ...valid(), contributes: { ...valid().contributes, canvasNodes: [] } }, /canvasNodes.*reserved/);
});
test("rejects non-objects", () => { rejects(null, /object/); rejects([], /object/); rejects("x", /object/); });
test("error messages never echo values", () => {
  const SECRET = "Sk_Super_Secret_Value_123";
  const cases: unknown[] = [
    { ...valid(), id: SECRET }, { ...valid(), tier: SECRET }, { ...valid(), apiVersion: SECRET },
    { ...valid(), [SECRET]: 1 }, { ...valid(), secrets: [{ name: SECRET }] },
    { ...valid(), contributes: { ...valid().contributes, [SECRET]: 1 } },
    { ...valid(), contributes: { views: [{ id: SECRET, label: "x" }] } },
    { ...valid(), contributes: { mcpServers: [{ name: "m", type: "stdio", command: "c", envSecrets: { X: SECRET } }] } },
    { ...valid(), name: 5 as never, description: SECRET },
  ];
  for (const c of cases) {
    try { parseManifest(c); assert.fail("should reject"); }
    catch (e) { assert.ok(e instanceof ManifestError); assert.ok(!e.message.includes(SECRET), e.message); }
  }
});

test("network allow-list rejects IP literals and too-broad wildcards", () => {
  for (const host of ["169.254.169.254", "10.0.0.1", "*.com", "localhost", "a.b.1", "*."]) rejects({ ...valid(), network: { allow: [host] } }, /network\.allow/);
  const ok = parseManifest({ ...valid(), network: { allow: ["api.x.test", "*.x.test"] } });
  assert.equal(ok.network.allow.length, 2);
});
test("single hyphens inside ids are fine", () => { assert.equal(parseManifest({ ...valid(), id: "azure-devops" }).id, "azure-devops"); });

test("access: owner is only valid for install scope; the default is everyone", () => {
  assert.equal(parseManifest(valid()).access, "everyone");
  assert.equal(parseManifest({ ...valid(), scope: "install", access: "owner" }).access, "owner");
  rejects({ ...valid(), scope: "user", access: "owner" }, /access/);
  rejects({ ...valid(), access: "nobody" }, /access/);
});
