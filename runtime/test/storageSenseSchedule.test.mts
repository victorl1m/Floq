import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "../src/plugins/manifest.js";
import { storageSenseManifest } from "../src/plugins/storage-sense/index.js";
import { DAY_MS, DEFAULT_CONFIG } from "../src/storageSense/plan.js";
import { HOUR_MS, dueTrigger, effectiveConfig } from "../src/storageSense/schedule.js";

test("the manifest is valid", () => { assert.equal(parseManifest(storageSenseManifest).id, "storage-sense"); });

test("effectiveConfig: defaults, clamping and 0 = off; unknown mode is report-only", () => {
  assert.deepEqual(effectiveConfig({}), { mode: "report", config: DEFAULT_CONFIG });
  const r = effectiveConfig({ mode: "clean", worktreeDays: -5, branchDays: "x", scratchpadDays: 0, attachmentDays: 99999, lowSpacePercent: 500 });
  assert.equal(r.mode, "clean");
  assert.equal(r.config.worktreeDays, 0);
  assert.equal(r.config.branchDays, DEFAULT_CONFIG.branchDays);
  assert.equal(r.config.scratchpadDays, 0);
  assert.equal(r.config.attachmentDays, 3650);
  assert.equal(r.config.lowSpacePercent, 90);
  assert.equal(effectiveConfig({ mode: "delete-everything" }).mode, "report");
});

test("dueTrigger: daily, low space at most hourly, never otherwise", () => {
  const now = 1_000_000_000_000;
  assert.equal(dueTrigger({ now, lastRunAt: null, freePercent: 80, lowSpacePercent: 10 }), "schedule");
  assert.equal(dueTrigger({ now, lastRunAt: now - DAY_MS, freePercent: 80, lowSpacePercent: 10 }), "schedule");
  assert.equal(dueTrigger({ now, lastRunAt: now - 2 * HOUR_MS, freePercent: 80, lowSpacePercent: 10 }), null);
  assert.equal(dueTrigger({ now, lastRunAt: now - 2 * HOUR_MS, freePercent: 4, lowSpacePercent: 10 }), "low-space");
  assert.equal(dueTrigger({ now, lastRunAt: now - 10 * 60_000, freePercent: 4, lowSpacePercent: 10 }), null);
  assert.equal(dueTrigger({ now, lastRunAt: now - 2 * HOUR_MS, freePercent: 4, lowSpacePercent: 0 }), null);
  assert.equal(dueTrigger({ now, lastRunAt: now - 2 * HOUR_MS, freePercent: null, lowSpacePercent: 10 }), null);
});
