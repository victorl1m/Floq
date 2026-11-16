import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/manager.js";

const cfg = { providers: { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "agy", shell: "bash" }, models: { claude: [], codex: [], opencode: [], antigravity: [] }, passHostEnv: false, sessionEnvAllow: [], cacheDisable: false, outputBufferBytes: 65536 };
const profile = { opencodeAutoApprove: false, antigravityAutoApprove: false, gitName: null, gitEmail: null, gitCoauthor: "", githubToken: null };

/** A fake `agy acp --login`: prints the URL, reads one line (the code), writes the token file under $HOME and exits with `exit`. */
function fakePty(mount: string, script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { env: { ...env, HOME: mount }, stdio: ["pipe", "pipe", "pipe"] });
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  child.stdout.on("data", (d) => dataCbs.forEach((cb) => cb(String(d))));
  child.on("exit", (code) => exitCbs.forEach((cb) => cb({ exitCode: code ?? 0 })));
  return { pid: child.pid, onData: (cb: any) => dataCbs.push(cb), onExit: (cb: any) => exitCbs.push(cb), write: (d: string) => child.stdin.write(d), resize() {}, kill: () => child.kill(), pause() {}, resume() {} };
}

function setup(token: string | null) {
  const mount = mkdtempSync(join(tmpdir(), "floq-agy-"));
  const script = join(mount, "fake-agy.cjs");
  writeFileSync(script, `
const fs = require("fs"), path = require("path");
console.log("Open this link in a browser to log in with Google:");
console.log("  https://accounts.google.com/o/oauth2/auth?client_id=x");
console.log("Then paste the authorization code, or the full URL of the page you land on, and press Enter:");
process.stdin.once("data", () => {
  const file = path.join(process.env.HOME, ".gemini/antigravity-cli/antigravity-oauth-token");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ${token === null ? "" : `fs.writeFileSync(file, ${JSON.stringify(token)});`}
  process.exit(0);
});
`);
  const handle = { userId: "u1", uid: process.getuid!(), mountPath: mount };
  const driver = {
    name: "local",
    hostPath: (_h: unknown, rel: string) => join(mount, rel),
    homePath: () => mount,
    spawn: (_h: unknown, o: { env: Record<string, string> }) => fakePty(mount, script, o.env),
  };
  const manager = Object.create(SessionManager.prototype) as any;
  Object.assign(manager, {
    config: cfg,
    lifecycle: { close() {} },
    loginTasks: new Map(),
    logins: new Map(),
    live: new Map(),
    lockTimers: new Map(),
    credMtime: new Map(),
    agyConnected: new Map(),
    agyExpired: new Set(),
    shards: { wake: async () => handle, awakeHandle: () => handle, driver },
    scheduleLock() {},
    cancelLock() {},
    assertLifecycleOpen() {},
  });
  return { manager, mount, handle };
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail("timed out");
};

for (const [name, token] of [["JSON token", JSON.stringify({ access_token: "ya29.x", refresh_token: "1//r" })], ["opaque token file (exit 0 + fresh non-empty file)", "ZW5jb2RlZC10b2tlbg=="]] as const) {
  test("antigravity login: " + name + " finishes, then disconnect removes the token and scope file", async () => {
    const { manager, mount } = setup(token);
    const summary = await manager.startLogin("u1", "antigravity", profile);
    const session = manager.live.get(summary.id);
    let out = "";
    session.subscribe((f: any) => { if (f.type === "output") out += f.data; });
    await waitFor(() => /authorization code/.test(out));
    assert.match(out, /accounts\.google\.com/);
    assert.equal(await manager.antigravityConnected("u1"), false);
    session.write("4/0code\r");
    await waitFor(async () => (await manager.antigravityConnected("u1")) === true || manager.agyConnected.get("u1") === true);
    const tokenFile = join(mount, ".gemini/antigravity-cli/antigravity-oauth-token");
    assert.ok(existsSync(tokenFile));
    assert.ok(!existsSync(join(mount, ".floq/login-antigravity-" + summary.id)), "no throwaway login dir for antigravity");
    mkdirSync(join(mount, ".config/antigravity"), { recursive: true });
    writeFileSync(join(mount, ".config/antigravity/credential-user-scope"), "x");
    await waitFor(() => !manager.logins.has(summary.id), 5000);
    await manager.disconnectProvider("u1", "antigravity");
    assert.ok(!existsSync(tokenFile));
    assert.ok(!existsSync(join(mount, ".config/antigravity/credential-user-scope")));
    assert.equal(await manager.antigravityConnected("u1"), false);
    rmSync(mount, { recursive: true, force: true });
  });
}

test("antigravity status never wakes a sleeping shard, and an expired login is not trusted", async () => {
  const { manager } = setup(null);
  let wakes = 0;
  manager.shards.awakeHandle = () => undefined;
  manager.shards.wake = async () => { wakes++; return {}; };
  assert.equal(await manager.antigravityConnected("u1"), false);
  manager.agyConnected.set("u1", true);
  assert.equal(await manager.antigravityConnected("u1"), true);
  manager.markAgyLoginLost("u1");
  assert.equal(await manager.antigravityConnected("u1"), false);
  assert.equal(wakes, 0);
});
