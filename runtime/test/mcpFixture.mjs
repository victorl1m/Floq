import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsService } from "../dist/skills.js";

// Shared fixture: a fake unlocked home on the local filesystem, a fake image bundle with context7, one project "p1" owned by "owner",
// and a shard driver that runs the sandbox helper scripts as ordinary child processes.
export function fixture(extraQuery) {
  const temp = mkdtempSync(join(tmpdir(), "floq-mcp-"));
  const home = join(temp, "home");
  const bundle = join(temp, "bundle");
  mkdirSync(join(home, "repo"), { recursive: true });
  mkdirSync(join(bundle, ".codex"), { recursive: true });
  writeFileSync(join(bundle, ".claude.json"), JSON.stringify({ mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] } } }));
  writeFileSync(join(bundle, ".codex", "config.toml"), '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n');
  const handle = { mountPath: home, uid: typeof process.getuid === "function" ? process.getuid() : 0 };
  const driver = {
    name: "local",
    hostPath: (h, path) => join(h.mountPath, path),
    homePath: (h) => h.mountPath,
    spawn: (h, spec) => {
      const child = spawnChild(spec.file, spec.args, { cwd: join(h.mountPath, spec.cwd), env: spec.env, windowsHide: true });
      const dataListeners = new Set();
      const exitListeners = new Set();
      child.stdout.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
      child.stderr.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
      child.on("close", (exitCode) => { for (const listener of exitListeners) listener({ exitCode: exitCode ?? 1 }); });
      return {
        onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
        onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
        kill(signal) { child.kill(signal); },
      };
    },
  };
  const pool = {
    query: async (sql, params) => {
      const extra = extraQuery && (await extraQuery(sql, params));
      if (extra) return extra;
      if (/FROM floq_projects/.test(sql)) return params[0] === "p1" && params[1] === "owner" ? { rows: [{ cwd: "repo" }] } : { rows: [] };
      return { rows: [] };
    },
  };
  const shards = { awakeHandle: () => handle, driver };
  const service = new SkillsService({ skelDir: bundle, preinstallSkills: true }, shards, pool, async (_user, operation) => operation(handle));
  return { temp, home, bundle, handle, service, repo: join(home, "repo"), shards, driver };
}
