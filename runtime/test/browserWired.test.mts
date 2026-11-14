import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_HINT, WiredContext } from "../dist/wiredContext.js";
import { loadConfig } from "../dist/config.js";

const store = { get: async () => null, put: async () => undefined, delete: async () => undefined };
const ctx = () => new WiredContext({ query: async () => ({ rows: [] }) }, store);

test("agents get the browser hint only when the browser is on for their user", async () => {
  const w = ctx();
  assert.equal(await w.blockFor("u", "s"), "", "no hook: no hint, nothing wired");
  w.browserEnabled = async (userId) => userId === "on";
  assert.equal(await w.blockFor("on", "s"), BROWSER_HINT);
  assert.equal(await w.blockFor("off", "s"), "");
  w.browserEnabled = async () => { throw new Error("db down"); };
  assert.equal(await w.blockFor("on", "s"), "", "a failing check never breaks session start");
  assert.match(BROWSER_HINT, /floq-browser/);
  assert.match(BROWSER_HINT, /floq decision request/);
  assert.match(BROWSER_HINT, /untrusted/);
});

test("browser env config: FLOQ_AGENT_BROWSER, idle, memory and private-range switches", () => {
  const base = { BETTER_AUTH_SECRET: "s".repeat(40), BETTER_AUTH_URL: "http://localhost", DATABASE_URL: "postgres://x/y", FLOQ_ENCRYPTION_KEY: "ab".repeat(32) };
  const d = loadConfig(base).browser;
  assert.deepEqual([d.mode, d.idleMs, d.memMb, d.allowPrivate, d.browsersDir, d.sandbox], ["auto", 600000, 0, false, "/opt/floq/browsers", "auto"]);
  assert.equal(loadConfig({ ...base, FLOQ_AGENT_BROWSER: "off" }).browser.mode, "off");
  assert.equal(loadConfig({ ...base, FLOQ_AGENT_BROWSER: "0" }).browser.mode, "off");
  assert.equal(loadConfig({ ...base, FLOQ_AGENT_BROWSER: "on" }).browser.mode, "on");
  assert.equal(loadConfig({ ...base, FLOQ_AGENT_BROWSER: "maybe" }).browser.mode, "auto");
  const c = loadConfig({ ...base, FLOQ_BROWSER_IDLE_MS: "5000", FLOQ_BROWSER_MEM_MB: "2048", FLOQ_BROWSER_ALLOW_PRIVATE: "1", FLOQ_BROWSER_SANDBOX: "required", PLAYWRIGHT_BROWSERS_PATH: "/data/b" }).browser;
  assert.deepEqual([c.idleMs, c.memMb, c.allowPrivate, c.browsersDir, c.sandbox], [5000, 2048, true, "/data/b", "required"]);
  assert.equal(loadConfig({ ...base, FLOQ_BROWSER_IDLE_MS: "-5" }).browser.idleMs, 600000);
});
