import test from "node:test";
import assert from "node:assert/strict";
import { announceBucket, describeAnnouncement, detailIsLong, formatRemaining, newestFirst, riskLevel, RISK_LABEL, titleWithPending } from "../src/lib/approval-format.ts";
import { capText } from "../src/lib/island-contract.ts";

test("risk levels", () => {
  assert.equal(RISK_LABEL[riskLevel("git push origin main", "", true)], "Irreversible · affects production");
  assert.equal(riskLevel("deploy the site", "", true), "production");
  // Agent-written words never raise the label without the server flag.
  assert.equal(riskLevel("git push origin main", "deploy to production", false), "neutral");
  assert.equal(riskLevel("delete the remote branch feature/x", "", true), "irreversible");
  assert.equal(riskLevel("open a draft PR", "", false), "neutral");
  assert.equal(RISK_LABEL.neutral, "Needs your OK");
});

test("remaining time and announcements", () => {
  assert.equal(formatRemaining(581), "9:41");
  assert.equal(formatRemaining(-3), "0:00");
  assert.equal(formatRemaining(3725), "1:02:05");
  assert.deepEqual([600, 61, 60, 11, 10, 0].map(announceBucket), ["start", "start", "60", "60", "10", "10"]);
  assert.match(describeAnnouncement("start", "Acme API", "git push origin main", 600), /Acme API needs your approval: git push origin main\. Expires in 10:00/);
  assert.match(describeAnnouncement("10", "x", "git push", 10), /^10 seconds left/);
});

test("ordering, title and detail collapse", () => {
  assert.deepEqual(newestFirst([{ createdAt: "2026-01-01T00:00:00Z", n: 1 }, { createdAt: "2026-01-02T00:00:00Z", n: 2 }]).map((i) => i.n), [2, 1]);
  assert.equal(titleWithPending("Floq", 2), "(2) Floq");
  assert.equal(titleWithPending("Floq", 0), "Floq");
  assert.ok(detailIsLong("x".repeat(200)) && detailIsLong("a\nb\nc\nd") && !detailIsLong("short"));
});

test("capText keeps the start and the tail of long text", () => {
  assert.equal(capText("short", 10), "short");
  const out = capText("a".repeat(500) + "rm -rf /", 90);
  assert.ok(out.length <= 90);
  assert.ok(out.endsWith("rm -rf /"));
  assert.ok(out.includes("…"));
});
