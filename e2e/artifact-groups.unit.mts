// Run: node --experimental-strip-types --test e2e/artifact-groups.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, groupArtifacts, matchesQuery } from "../src/lib/artifact-groups.ts";

const now = new Date(2026, 10, 14, 15, 0, 0); // Sat 14 Nov 2026, 15:00 local
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const e = (path: string, ms: number) => ({ name: path.split("/").pop()!, path, size: 1, modifiedAt: ms });

test("groups newest first by local day with Today / Yesterday / dated labels", () => {
  const groups = groupArtifacts([e("old.md", at(9, 10)), e("a.md", at(14, 9)), e("y.md", at(13, 23, 59)), e("b.md", at(14, 14))], "", now);
  assert.deepEqual(groups.map((g) => g.label.split(",")[0]), ["Today", "Yesterday", "Monday"]);
  assert.deepEqual(groups[0].entries.map((x) => x.path), ["b.md", "a.md"]);
});

test("group key is the local day start, so it survives the label changing at midnight", () => {
  assert.equal(dayKey(at(14, 0, 0)), dayKey(at(14, 23, 59)));
  assert.notEqual(dayKey(at(13, 23, 59)), dayKey(at(14, 0, 0)));
});

test("search matches every word against the path, case-insensitive, and drops empty days", () => {
  assert.ok(matchesQuery(e("Reports/Q3 Sales.pdf", 0), "q3 reports"));
  assert.ok(!matchesQuery(e("Reports/Q3 Sales.pdf", 0), "q4"));
  assert.ok(matchesQuery(e("x", 0), "   "));
  const groups = groupArtifacts([e("charts/chart.png", at(14, 9)), e("report.md", at(13, 9))], "CHART", now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries[0].path, "charts/chart.png");
});
