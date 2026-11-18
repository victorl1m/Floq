import test from "node:test";
import assert from "node:assert/strict";
import { projectAgentConnected } from "../../src/lib/browser-autoopen.ts";

const mine = new Set(["a1", "a2"]);

test("opens only when a connected agent belongs to this project", () => {
  assert.equal(projectAgentConnected({ agents: 1, agentSessions: ["a2"] }, mine), true);
  assert.equal(projectAgentConnected({ agents: 2, agentSessions: ["x9", "a1"] }, mine), true);
});
test("an agent of another project does not open a browser here", () => {
  assert.equal(projectAgentConnected({ agents: 1, agentSessions: ["x9"] }, mine), false);
  assert.equal(projectAgentConnected({ agents: 1, agentSessions: ["x9"] }, new Set()), false);
});
test("no connection, or an older runtime without session ids, never opens", () => {
  assert.equal(projectAgentConnected({ agents: 0 }, mine), false);
  assert.equal(projectAgentConnected({ agents: 0, agentSessions: ["a1"] }, mine), false);
  assert.equal(projectAgentConnected({ agents: 3 }, mine), false);
});
