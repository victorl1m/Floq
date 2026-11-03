import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_ROLES, composeRolePrompt, describeRole, formatRoleLine, getAgentRole, listAgentRoles, parseRoleId, pickModelForCapability } from "../dist/roles.js";
import { formatRoleLine as cliRoleLine } from "../dist/image/floq-args.mjs";

test("role presets are well formed and chain spec -> plan -> implement -> review", () => {
  const ids = AGENT_ROLES.map((r) => r.id);
  assert.deepEqual(ids, ["specifier", "planner", "implementer", "reviewer", "tester"]);
  for (const role of AGENT_ROLES) {
    assert.ok(role.prompt.includes("Handoff") && role.prompt.includes("Do NOT"), role.id);
    for (const other of [...role.handoffFrom, ...role.handoffTo]) assert.ok(getAgentRole(other), other);
  }
  assert.equal(getAgentRole("reviewer")?.readOnly, true);
  assert.equal(getAgentRole("specifier")?.handoffTo[0], "planner");
  assert.ok(!("model" in AGENT_ROLES[0]), "roles do not hardcode a model");
  assert.notEqual(listAgentRoles()[0], AGENT_ROLES[0]);
});

test("parseRoleId allowlists ids and treats generalist/empty as none", () => {
  for (const none of [undefined, null, "", "generalist"]) assert.equal(parseRoleId(none), null);
  assert.equal(parseRoleId("planner")?.id, "planner");
  for (const bad of ["Planner", "root", 7, "../x", {}]) assert.throws(() => parseRoleId(bad), /role must be one of/);
});

test("composeRolePrompt injects the role into the first message", () => {
  const reviewer = getAgentRole("reviewer")!;
  const withTask = composeRolePrompt(reviewer, "Review src/auth")!;
  assert.match(withTask, /^\[Floq role preset: Reviewer\]/);
  assert.match(withTask, /read-only/);
  assert.ok(withTask.endsWith("Your task:\nReview src/auth"));
  assert.match(composeRolePrompt(reviewer, undefined)!, /ready as Reviewer/);
  assert.equal(composeRolePrompt(null, "hi"), "hi");
  assert.equal(composeRolePrompt(null, undefined), undefined);
});

test("list and describe output", () => {
  const line = formatRoleLine(getAgentRole("tester")!);
  assert.match(line, /^tester\s+fast-cheap\s+read-write\s+Writes and runs tests/);
  assert.equal(cliRoleLine(getAgentRole("tester")!), line);
  const text = describeRole(getAgentRole("implementer")!);
  for (const part of ["Implementer (implementer)", "Capability: code-heavy", "When to use:", "When not to use:", "Inputs:", "Outputs:", "Receives handoff from: planner, specifier", "Hands off to: reviewer, tester"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(describeRole(getAgentRole("specifier")!), /none \(start of chain\)/);
});

test("model selection falls back deterministically and never invents ids", () => {
  const claude = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }];
  assert.equal(pickModelForCapability("reasoning-heavy", claude), "opus");
  assert.equal(pickModelForCapability("code-heavy", claude), "sonnet");
  assert.equal(pickModelForCapability("fast-cheap", claude), "haiku");
  assert.equal(pickModelForCapability("fast-cheap", [{ id: "gpt-5-mini", label: "m" }]), "gpt-5-mini");
  assert.equal(pickModelForCapability("reasoning-heavy", [{ id: "default", label: "Default" }, { id: "gpt-6-astra", label: "A" }]), null);
  assert.equal(pickModelForCapability("code-heavy", []), null);
});
