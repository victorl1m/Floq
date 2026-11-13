#!/usr/bin/env node
// floq-browser-mcp: launched by Claude Code / Codex as the stdio MCP server "floq-browser" (docs/design/agent-browser.md §A.2).
// Asks the runtime for this user's browser endpoint (starting the daemon on demand), then runs the pinned @playwright/mcp attached
// to it over CDP. The token reaches the MCP only through its argv; it is never written to ~/.claude.json or config.toml.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
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
/** Asks the runtime for the user's current browser endpoint (starting the daemon on demand). Never throws. */
async function ensure(): Promise<Ensure> {
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
  return reply;
}
// Reject anything that is not a loopback ws endpoint: the runtime is trusted, but this keeps the token off the network by construction.
const WS_RE = /^ws:\/\/127\.0\.0\.1:(\d{1,5})(\/devtools\/browser(?:\?agent=[A-Za-z0-9-]{8,64})?)$/;
const reply = await ensure();
if (reply.error || !reply.wsEndpoint || !reply.token) {
  const why = reply.error?.message ?? "the runtime returned no browser endpoint";
  fail(reply.error?.code === "disabled" ? "the agent browser is turned off in Floq settings (Settings > Agents > Browser)" : why);
}
if (!WS_RE.test(reply.wsEndpoint!)) fail("the runtime returned an unexpected endpoint");

// The daemon's port and token change every time it restarts (egress switch, idle stop, crash), but Playwright keeps the endpoint it was
// started with and reconnects to it. So Playwright talks to a stable loopback forwarder instead, and the forwarder asks the runtime for the
// CURRENT endpoint on every new connection, injecting the current token. The forwarder only serves a caller that knows a per-process secret
// (loopback is shared between users' sandboxes: without it any local process could borrow the token).
const secret = randomBytes(24).toString("hex");
const forwarder = createServer((client) => {
  client.on("error", () => client.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) { if (head.length > 16_384) client.destroy(); return; }
    client.off("data", onData); client.pause();
    void relay(client, head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
  };
  client.on("data", onData);
});
async function relay(client: Socket, requestHead: string, rest: Buffer): Promise<void> {
  const lines = requestHead.split("\r\n");
  const m = /^GET \/([0-9a-f]{48})(\/devtools\/browser(?:\?[^ ]*)?) HTTP\/1\.1$/.exec(lines[0] ?? "");
  if (!m || m[1] !== secret) { client.destroy(); return; }
  const fresh = await ensure();
  const target = fresh.token && fresh.wsEndpoint ? WS_RE.exec(fresh.wsEndpoint) : null;
  if (!target || client.destroyed) { client.destroy(); return; }
  const out = [`GET ${target[2]} HTTP/1.1`, `Host: 127.0.0.1:${target[1]}`, `Authorization: Bearer ${fresh.token}`];
  // Everything else (Upgrade, Connection, Sec-WebSocket-*) is the client's own handshake; its Host and Authorization are replaced.
  for (const l of lines.slice(1)) if (!/^(host|authorization):/i.test(l)) out.push(l);
  const upstream = connect({ host: "127.0.0.1", port: Number(target[1]) }, () => {
    upstream.write(out.join("\r\n") + "\r\n\r\n");
    if (rest.length) upstream.write(rest);
    client.pipe(upstream); upstream.pipe(client); client.resume();
  });
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}
const listening = await new Promise<number>((resolve) => forwarder.listen(0, "127.0.0.1", () => resolve((forwarder.address() as AddressInfo).port)));
forwarder.unref();
const endpoint = `ws://127.0.0.1:${listening}/${secret}/devtools/browser`;

const cli = process.env.FLOQ_BROWSER_MCP_CLI || "/opt/floq/playwright-mcp/node_modules/@playwright/mcp/cli.js";
if (!existsSync(cli)) fail("Playwright MCP is not installed in this image (" + cli + ")");
const output = join(process.env.HOME || homedir(), ".floq", "browser", "output");
mkdirSync(output, { recursive: true, mode: 0o700 });
const args = [cli, "--cdp-endpoint", endpoint, "--output-dir", output, "--image-responses", "omit"];
// Connected over CDP, so it never launches a browser; the explicit path (when known) guarantees it can never try to download one.
if (process.env.FLOQ_BROWSER_EXECUTABLE) args.push("--executable-path", process.env.FLOQ_BROWSER_EXECUTABLE);
const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
