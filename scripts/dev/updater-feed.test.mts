import test from "node:test";
import assert from "node:assert/strict";
import { buildLatestJson, compareVersions, installerUrl, shouldPublish } from "../updater/latest-json.mjs";

test("version comparison", () => {
  assert.equal(compareVersions("1.0.20", "1.0.9"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
  assert.throws(() => compareVersions("1.0", "1.0.0"));
});

test("the feed is never downgraded", () => {
  assert.equal(shouldPublish(null, "1.0.21"), true);
  assert.equal(shouldPublish("1.0.20", "1.0.21"), true);
  assert.equal(shouldPublish("1.0.21", "1.0.21"), true);
  assert.equal(shouldPublish("1.0.21", "1.0.20"), false);
});

test("installer url stays on github.com", () => {
  assert.equal(installerUrl("victorl1m/Floq", "v1.0.21", "Floq_1.0.21_x64-setup.exe"), "https://github.com/victorl1m/Floq/releases/download/v1.0.21/Floq_1.0.21_x64-setup.exe");
  assert.throws(() => installerUrl("evil.com/x/y", "v1", "a.exe"));
});

test("latest.json shape", () => {
  const url = installerUrl("victorl1m/Floq", "v1.0.21", "Floq_1.0.21_x64-setup.exe");
  const feed = buildLatestJson({ version: "1.0.21", notes: "# n", pubDate: "2026-11-18T10:00:00Z", signature: "SIG\n", url });
  assert.deepEqual(feed, {
    version: "1.0.21", notes: "# n", pub_date: "2026-11-18T10:00:00.000Z",
    platforms: { "windows-x86_64": { signature: "SIG", url } },
  });
  assert.throws(() => buildLatestJson({ version: "1.0.21", notes: "", pubDate: 0, signature: "", url }));
  assert.throws(() => buildLatestJson({ version: "1.0.21", notes: "", pubDate: 0, signature: "s", url: "http://evil.com/a.exe" }));
  assert.throws(() => buildLatestJson({ version: "x", notes: "", pubDate: 0, signature: "s", url }));
});
