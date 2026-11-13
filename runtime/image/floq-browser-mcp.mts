#!/usr/bin/env node
// floq-browser-mcp: launched by Claude Code / Codex as the stdio MCP server "floq-browser" (docs/design/agent-browser.md §A.2).
// Asks the runtime for this user's browser endpoint (starting the daemon on demand), then runs the pinned @playwright/mcp attached
// to it over CDP. The token reaches the MCP only through its argv; it is never written to ~/.claude.json or config.toml.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fail = (message: string, code = 1): never => {
  console.error("floq-browser: " + message);
  process.exit(code);
};

const url = process.env.FLOQ_API_URL;
const token = process.env.FLOQ_AGENT_TOKEN;
if (!url || !token) fail("not available in this session (no Floq API credentials)", 2);

type Ensure = { wsEndpoint?: string; token?: string; chromium?: string; error?: { message?: string; code?: string } };
let reply: Ensure;
try {
  const response = await fetch(url + "/internal/browser/ensure", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  try { reply = JSON.parse(text) as Ensure; } catch { reply = { error: { message: text.slice(0, 200) } }; }
  if (!response.ok && !reply.error) reply = { error: { message: "HTTP " + response.status } };
} catch (e) {
  reply = { error: { message: "could not reach the Floq runtime: " + (e instanceof Error ? e.message : String(e)) } };
}
if (reply.error || !reply.wsEndpoint || !reply.token) {
  const why = reply.error?.message ?? "the runtime returned no browser endpoint";
  fail(reply.error?.code === "disabled" ? "the agent browser is turned off in Floq settings (Settings > Agents > Browser)" : why);
}
// Reject anything that is not a loopback ws endpoint: the runtime is trusted, but this keeps the token off the network by construction.
if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser(\?agent=[A-Za-z0-9-]{8,64})?$/.test(reply.wsEndpoint!)) fail("the runtime returned an unexpected endpoint");

const cli = process.env.FLOQ_BROWSER_MCP_CLI || "/opt/floq/playwright-mcp/node_modules/@playwright/mcp/cli.js";
if (!existsSync(cli)) fail("Playwright MCP is not installed in this image (" + cli + ")");
const output = join(process.env.HOME || homedir(), ".floq", "browser", "output");
mkdirSync(output, { recursive: true, mode: 0o700 });
const args = [cli, "--cdp-endpoint", reply.wsEndpoint!, "--cdp-header", "Authorization: Bearer " + reply.token, "--output-dir", output, "--image-responses", "omit"];
// Connected over CDP, so it never launches a browser; the explicit path (when known) guarantees it can never try to download one.
if (process.env.FLOQ_BROWSER_EXECUTABLE) args.push("--executable-path", process.env.FLOQ_BROWSER_EXECUTABLE);
const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
