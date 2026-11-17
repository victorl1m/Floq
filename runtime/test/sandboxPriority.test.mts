import test from "node:test";
import assert from "node:assert/strict";

test("sandboxed processes start below the runtime's CPU priority and above its OOM score", async () => {
  const { sandboxPriorityArgv } = await import("../dist/shard.js");
  const argv = sandboxPriorityArgv({});
  assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.equal(argv[3], "floq-prio");
  assert.match(argv[2], /echo 500 > \/proc\/self\/oom_score_adj/);
  assert.match(argv[2], /exec nice -n 10 "\$@"/);
  assert.match(argv[2], /exec "\$@"$/, "falls through to a plain exec when nice is missing");
});

test("sandbox priority is configurable, clamped, and can be turned off", async () => {
  const { sandboxPriorityArgv } = await import("../dist/shard.js");
  const tuned = sandboxPriorityArgv({ FLOQ_SANDBOX_NICE: "99", FLOQ_SANDBOX_OOM_SCORE_ADJ: "0" })[2];
  assert.match(tuned, /nice -n 19 /);
  assert.doesNotMatch(tuned, /oom_score_adj/);
  assert.deepEqual(sandboxPriorityArgv({ FLOQ_SANDBOX_NICE: "0", FLOQ_SANDBOX_OOM_SCORE_ADJ: "0" }), []);
  // Not a number: defaults, never an injected string.
  assert.match(sandboxPriorityArgv({ FLOQ_SANDBOX_NICE: "5; rm -rf /" })[2], /nice -n 5 /);
  assert.match(sandboxPriorityArgv({ FLOQ_SANDBOX_NICE: "x" })[2], /nice -n 10 /);
});
