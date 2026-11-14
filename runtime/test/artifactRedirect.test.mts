import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const hook = (payload: string) => spawnSync(process.execPath, ["--import", "tsx", new URL("../image/floq-artifact-redirect.mts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { input: payload, encoding: "utf8" });

test("publish (explicit and default), delete, open, quickstart and asset uploads are denied with the Artifacts folder hint", () => {
  const inputs = [{ action: "publish", file_path: "/x.html" }, { file_path: "/x.html" }, {}, { action: "delete", url: "u" }, { action: "open", url: "u" }, { action: "pin", url: "u" }, { action: "quickstart", intent: "other" }, { action: "publish", url: "u", asset: true, file_path: "/a.png" }];
  for (const tool_input of inputs) {
    const r = hook(JSON.stringify({ tool_name: "Artifact", tool_input }));
    assert.equal(r.status, 2, JSON.stringify(tool_input));
    assert.match(r.stderr, /FLOQ_ARTIFACTS_DIR[\s\S]*Artifacts tab[\s\S]*instead of using the Artifact tool[\s\S]*file name/);
  }
});

test("read and list are allowed", () => {
  for (const action of ["read", "list"]) assert.equal(hook(JSON.stringify({ tool_name: "Artifact", tool_input: { action, url: "u" } })).status, 0);
});

test("malformed or empty stdin fails open", () => {
  for (const payload of ["not json", "", "null"]) assert.equal(hook(payload).status, 0, payload);
});

test("the redirect names the session's real Artifacts path when FLOQ_ARTIFACTS_DIR is set", async () => {
  const { redirectMessage } = await import("../image/floq-artifact-redirect.mts");
  assert.match(redirectMessage("/home/user/Artifacts/p1"), /\/home\/user\/Artifacts\/p1 \(\$FLOQ_ARTIFACTS_DIR\)/);
  assert.match(redirectMessage(""), /folder at \$FLOQ_ARTIFACTS_DIR \(shown/);
});
