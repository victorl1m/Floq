#!/usr/bin/env node
// floq-vault: lets an agent use the user's registered secrets without ever seeing the values.
//   floq-vault list                      names and descriptions only
//   floq-vault run [--only A,B] -- cmd   run cmd with secrets in its environment; values are redacted from output
//   floq-vault run --stdio --only A,B [--map ENV=NAME]... -- cmd   MCP stdio wrapper: raw stdin/stdout passthrough (no buffering, no
//                                        redaction of the protocol stream), stderr redacted; fails clearly if a named secret is missing
//   floq-vault headers --server NAME --spec BASE64URL   prints HTTP headers as JSON for Claude Code's headersHelper
import { spawn } from "node:child_process";

type SecretValues = Record<string, string>;
type VaultSecret = { name: string; description?: string };
type Redactor = { push(chunk: Buffer): void; end(): void };
type SecretResponse = { secrets: SecretValues };
type SecretListResponse = { secrets: VaultSecret[] };

const url = process.env.FLOQ_API_URL;
const token = process.env.FLOQ_AGENT_TOKEN;
if (!url || !token) {
  console.error("floq-vault: not available in this session");
  process.exit(2);
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("floq-vault: request failed (" + response.status + ") " + text.slice(0, 200));
    process.exit(1);
  }
  return response.json() as Promise<T>;
}

function redactor(secrets: SecretValues, write: (text: string) => void): Redactor {
  const values = Object.values(secrets).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...values.map((v) => v.length)) - 1;
  let tail = "";
  const scrub = (text: string) => {
    for (const value of values) text = text.split(value).join("[REDACTED]");
    return text;
  };
  return {
    push(chunk) {
      // Hold back a tail so a secret split across two chunks is still caught.
      const text = tail + chunk.toString("utf8");
      const cut = Math.max(0, text.length - keep);
      write(scrub(text.slice(0, cut)));
      tail = text.slice(cut);
    },
    end() {
      write(scrub(tail));
      tail = "";
    },
  };
}

/** Redacts complete lines as they arrive (used for the MCP child's stderr; the protocol stream on stdout is never touched). */
function lineRedactor(secrets: SecretValues, write: (text: string) => void): Redactor {
  const values = Object.values(secrets).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  let pending = "";
  const scrub = (text: string) => {
    for (const value of values) text = text.split(value).join("[REDACTED]");
    return text;
  };
  return {
    push(chunk) {
      pending += chunk.toString("utf8");
      const cut = pending.lastIndexOf("\n");
      if (cut >= 0) { write(scrub(pending.slice(0, cut + 1))); pending = pending.slice(cut + 1); }
      else if (pending.length > 65536) { write(scrub(pending.slice(0, 32768))); pending = pending.slice(32768); }
    },
    end() { write(scrub(pending)); pending = ""; },
  };
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Fetches exactly these secrets. A name that is missing (deleted or renamed after the MCP server was set up) is a clear error. */
async function revealExactly(names: string[]): Promise<SecretValues> {
  const { secrets } = await call<SecretResponse>("/internal/vault/reveal", { names });
  const missing = names.filter((name) => !(name in secrets));
  if (missing.length) {
    console.error("floq-vault: secret " + missing.join(", ") + " was not found. It was probably renamed or deleted in Floq > Secrets; recreate it with the same name or reinstall the MCP server.");
    process.exit(1);
  }
  return secrets;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "list") {
  const { secrets } = await call<SecretListResponse>("/internal/vault/secrets");
  if (secrets.length === 0) console.log("No secrets registered.");
  for (const s of secrets) console.log(s.name + (s.description ? "  - " + s.description : ""));
} else if (command === "run") {
  const sep = rest.indexOf("--");
  if (sep === -1 || sep === rest.length - 1) {
    console.error("usage: floq-vault run [--only NAME,NAME] -- command [args...]");
    process.exit(2);
  }
  const options = rest.slice(0, sep);
  const argv = rest.slice(sep + 1);
  const onlyIndex = options.indexOf("--only");
  const names = onlyIndex !== -1 && options[onlyIndex + 1] ? options[onlyIndex + 1].split(",").map((n) => n.trim()) : null;
  if (options.includes("--stdio")) {
    // MCP stdio server: JSON-RPC frames flow through untouched in both directions, so nothing here may buffer or rewrite stdout.
    const maps: [string, string][] = [];
    for (let i = 0; i < options.length; i++) {
      if (options[i] !== "--map") continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]{0,127})=([A-Z][A-Z0-9_]{0,63})$/.exec(options[i + 1] ?? "");
      if (!m) { console.error("floq-vault: --map takes ENV_NAME=SECRET_NAME"); process.exit(2); }
      maps.push([m[1], m[2]]);
    }
    if (!names || names.length === 0 || names.some((n) => !NAME_PATTERN.test(n))) { console.error("floq-vault: --stdio needs --only with valid secret names"); process.exit(2); }
    if (maps.some(([, secret]) => !names.includes(secret))) { console.error("floq-vault: every --map secret must also be listed in --only"); process.exit(2); }
    const secrets = await revealExactly(names);
    const injected = maps.length ? Object.fromEntries(maps.map(([envName, secret]) => [envName, secrets[secret]])) : secrets;
    const executable = argv[0];
    if (!executable) { console.error("usage: floq-vault run [--only NAME,NAME] -- command [args...]"); process.exit(2); }
    const child = spawn(executable, argv.slice(1), {
      stdio: ["inherit", "inherit", "pipe"],
      env: { ...process.env, ...injected, FLOQ_AGENT_TOKEN: "", FLOQ_API_URL: "" },
    });
    const err = lineRedactor(secrets, (text) => process.stderr.write(text));
    child.stderr.on("data", (c) => err.push(c));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) process.on(signal, () => child.kill(signal));
    child.on("error", (e) => { console.error("floq-vault: " + e.message); process.exit(127); });
    child.on("close", (code, signal) => { err.end(); process.exit(code ?? (signal ? 1 : 0)); });
  } else {
  // The runtime launches the command in this sandbox with the secrets injected; the cleartext never comes back here.
  // Trade-offs: output arrives when the command ends (already redacted) and stdin is not forwarded.
  const result = await call<{ code: number; stdout: string; stderr: string; truncated?: boolean }>("/internal/vault/run", { names, argv, cwd: process.cwd(), env: process.env });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.truncated) console.error("floq-vault: output truncated");
  process.exit(result.code);
  }
} else if (command === "headers") {
  // Called by Claude Code as an MCP "headersHelper". It prints header values for one named MCP server, so it is exactly as
  // revealing as "floq-vault run" (an agent can already pipe a secret through a command). The server-name check only stops
  // accidental or casual calls; it is not a security boundary.
  const get = (flag: string) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
  const server = get("--server");
  let spec: Record<string, string> | null;
  try { spec = JSON.parse(Buffer.from(get("--spec") ?? "", "base64url").toString("utf8")); } catch { spec = null; }
  if (!server || !spec || typeof spec !== "object" || Array.isArray(spec)) { console.error("floq-vault: usage: floq-vault headers --server NAME --spec BASE64URL"); process.exit(2); }
  if (process.env.CLAUDE_CODE_MCP_SERVER_NAME !== server) { console.error("floq-vault: headers is only for Claude Code's MCP header helper; use floq-vault run instead"); process.exit(2); }
  const names = [...new Set(Object.values(spec).flatMap((template) => [...template.matchAll(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g)].map((m) => m[1])))];
  const secrets = await revealExactly(names);
  const headers = Object.fromEntries(Object.entries(spec).map(([header, template]) => [header, template.replace(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g, (_match, name: string) => secrets[name] ?? "")]));
  process.stdout.write(JSON.stringify(headers));
} else {
  console.error("usage: floq-vault list | floq-vault run [--only A,B] -- command [args...]");
  process.exit(2);
}
