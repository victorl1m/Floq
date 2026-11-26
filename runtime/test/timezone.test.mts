import test from "node:test";
import assert from "node:assert/strict";
import { resolveTimeZone, runtimeTimeZone } from "../dist/timezone.js";
import { buildSessionEnv } from "../dist/providers.js";
import { nextRun } from "../dist/scheduleMath.js";

test("FLOQ_TIMEZONE beats TZ beats the system zone", () => {
  assert.deepEqual(resolveTimeZone({ FLOQ_TIMEZONE: "America/Sao_Paulo", TZ: "Asia/Tokyo" }), { zone: "America/Sao_Paulo", source: "FLOQ_TIMEZONE" });
  assert.deepEqual(resolveTimeZone({ TZ: "Asia/Tokyo" }), { zone: "Asia/Tokyo", source: "TZ" });
  assert.deepEqual(resolveTimeZone({ TZ: ":Europe/Lisbon" }), { zone: "Europe/Lisbon", source: "TZ" });
  const sys = resolveTimeZone({});
  assert.equal(sys.source, "system");
  assert.ok(sys.zone.length > 0);
});

test("an invalid zone is skipped (next source wins) and never throws", () => {
  assert.deepEqual(resolveTimeZone({ FLOQ_TIMEZONE: "Nowhere/Land", TZ: "Asia/Tokyo" }), { zone: "Asia/Tokyo", source: "TZ" });
  assert.equal(resolveTimeZone({ FLOQ_TIMEZONE: "Nowhere/Land", TZ: "UTC0garbage" }).source, "system");
  assert.equal(runtimeTimeZone({ FLOQ_TIMEZONE: "  " }), resolveTimeZone({}).zone);
});

test("agent sessions get TZ from the resolved server zone", () => {
  const cfg = { passHostEnv: false, sessionEnvAllow: [], cacheDisable: false };
  const profile = { gitName: "", gitEmail: "", gitCoauthor: "", githubToken: "" };
  const prev = { f: process.env.FLOQ_TIMEZONE, t: process.env.TZ };
  try {
    process.env.FLOQ_TIMEZONE = "America/Sao_Paulo";
    assert.equal(buildSessionEnv(cfg, "shell", profile, "s1").TZ, "America/Sao_Paulo");
    assert.equal(buildSessionEnv({ ...cfg, passHostEnv: true }, "shell", profile, "s1").TZ, "America/Sao_Paulo");
  } finally {
    if (prev.f === undefined) delete process.env.FLOQ_TIMEZONE; else process.env.FLOQ_TIMEZONE = prev.f;
    if (prev.t === undefined) delete process.env.TZ; else process.env.TZ = prev.t;
  }
});

test("a schedule built from the server zone fires at that zone's wall clock", () => {
  const zone = runtimeTimeZone({ FLOQ_TIMEZONE: "America/Sao_Paulo" });
  const at = nextRun({ kind: "recurring", freq: "daily", interval: 1, time: "09:00", timezone: zone, startDate: "2026-11-18" }, new Date("2026-11-18T00:00:00Z"));
  assert.equal(at?.toISOString(), "2026-11-18T12:00:00.000Z");
});
