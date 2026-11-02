import test from "node:test";
import assert from "node:assert/strict";
import { codexTrustArgs } from "../dist/codexTrust.js";
import { getProviderDefinition } from "../dist/providers.js";

function inlineProjects(args) {
  assert.deepEqual(args.slice(0, 1), ["-c"]);
  assert.equal(args.length, 2);
  assert.match(args[1], /^projects=\{.*\}$/);
  return args[1];
}

test("trusts managed paths and ancestors in the sandbox and only this user's Linux alias", () => {
  const config = inlineProjects(codexTrustArgs("/home/agent", "/mnt/floq/24017", [
    "workspace/e4fba8b6",
    "projects/demo-repo/subdir",
    "workspace/e4fba8b6",
    null,
  ]));

  for (const path of [
    "/home/agent/workspace/e4fba8b6",
    "/home/agent/workspace",
    "/home/agent/projects/demo-repo",
    "/home/agent",
    "/mnt/floq/24017/workspace/e4fba8b6",
    "/mnt/floq/24017/projects/demo-repo",
    "/mnt/floq/24017",
  ]) {
    assert.ok(config.includes(`${JSON.stringify(path)}={trust_level="trusted"}`), path);
  }
  assert.ok(!config.includes('"/"={'));
  assert.ok(!config.includes('"/mnt"={'));
  assert.ok(!config.includes('"/mnt/floq"={'));
  assert.equal((config.match(/trust_level="trusted"/g) ?? []).length, 12);
});

test("quotes Windows paths, spaces, and embedded quotes in the TOML value", () => {
  const root = "C:\\Users\\agent\\shard";
  const project = "workspace/Repo \"Q\" and spaces";
  const config = inlineProjects(codexTrustArgs(root, null, [project]));
  const expected = "C:\\Users\\agent\\shard\\workspace\\Repo \"Q\" and spaces";
  assert.ok(config.includes(`${JSON.stringify(expected)}={trust_level="trusted"}`));
  assert.ok(!config.includes("/mnt/"));
});

test("empty or dot cwd means only the user's home; unsafe and shared aliases are rejected", () => {
  const config = inlineProjects(codexTrustArgs("/home/agent", "/mnt/floq/24017", ["", ".", null]));
  assert.equal(config, 'projects={"/home/agent"={trust_level="trusted"},"/mnt/floq/24017"={trust_level="trusted"}}');

  assert.deepEqual(codexTrustArgs("/home/agent", "/mnt/floq", ["../other-user", "/etc", "workspace/../../etc", "C:\\other-user"]), []);
  assert.ok(!inlineProjects(codexTrustArgs("/home/agent", "/mnt", ["workspace/project"])).includes("/mnt/"));
});

test("trust config prefixes fresh and resumed Codex args without changing approval flags", () => {
  const definition = getProviderDefinition("codex", { providers: { codex: "codex" } });
  const trusted = codexTrustArgs("/home/agent", "/mnt/floq/24017", ["workspace/project"]);
  for (const codexAutoApprove of [false, true]) {
    const profile = { codexAutoApprove };
    const fresh = [...trusted, ...definition.buildArgs(profile, "session")];
    const resume = [...trusted, ...definition.resumeArgs(profile, "provider-session")];
    assert.deepEqual(fresh.slice(0, trusted.length), trusted);
    assert.deepEqual(resume.slice(0, trusted.length), trusted);
    assert.ok(fresh.indexOf("--no-daemon") > trusted.length - 1);
    assert.ok(resume.indexOf("--no-daemon") > trusted.length - 1);
    assert.equal(fresh.includes("--dangerously-bypass-approvals-and-sandbox"), codexAutoApprove);
    assert.equal(resume.includes("--dangerously-bypass-approvals-and-sandbox"), codexAutoApprove);
    assert.ok(resume.indexOf("resume") > trusted.length);
  }
});
