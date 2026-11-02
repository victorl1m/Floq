import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { HttpError, badRequest, conflict } from "./errors.js";

/**
 * Pure helpers for installing and removing one MCP server entry in Claude's JSON config (`~/.claude.json`,
 * project `.mcp.json`) and Codex's TOML config (`~/.codex/config.toml`, project `.codex/config.toml`).
 * Nothing here touches the filesystem: the edits are computed on text and written by the sandboxed helper below.
 * No error produced here ever contains a value from the user's env/headers or a raw parser message.
 */
export const MAX_MCP_CONFIG_BYTES = 256 * 1024;
export type McpProvider = "claude" | "codex";
export interface McpServerSpec {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  /** Literal values, stored in the config file. */
  env: Record<string, string>;
  headers: Record<string, string>;
  /** ENV_NAME -> vault secret name. Written as a floq-vault wrapper; the value never reaches the config. */
  envSecrets: Record<string, string>;
  /** Header name -> value template with {{SECRET}} placeholders, resolved at connect time by `floq-vault headers`. */
  headerSecrets: Record<string, string>;
  /** Literal env/header names that look sensitive: refused unless the caller explicitly allows plain text. */
  plaintextSensitive: string[];
}

/** How the image's floq-vault is launched from a provider config. Tests and local checks can point it elsewhere. */
export interface VaultLauncher { command: string; prefixArgs: string[] }
export const DEFAULT_LAUNCHER: VaultLauncher = { command: "/usr/local/bin/floq-vault", prefixArgs: [] };
/** Forwarded to the wrapper so it can reach the runtime; Codex otherwise scrubs the MCP child's environment. */
export const CODEX_FORWARDED_ENV = ["FLOQ_API_URL", "FLOQ_AGENT_TOKEN"];
export const VAULT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const VAULT_REF = /\$\{vault:([A-Z][A-Z0-9_]{0,63})\}/g;
const SENSITIVE_NAME = /(TOKEN|KEY|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|BEARER)/i;
export const looksSensitive = (name: string) => SENSITIVE_NAME.test(name);

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SERVER_KEYS = new Set(["command", "args", "env", "url", "type", "headers", "transport", "name"]);
const invalid = (message: string) => badRequest(message, "invalid_mcp");

function text(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(label + " is required");
    return "";
  }
  if (typeof value !== "string" || value.length > max || CONTROL.test(value) || LONE_SURROGATE.test(value)) throw invalid(label + " must be plain text of at most " + max + " characters");
  return value;
}

function stringMap(value: unknown, label: string, keyPattern: RegExp, keyHint: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(label + " must be an object of text values");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) throw invalid(label + " can have at most 50 entries");
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!keyPattern.test(key)) throw invalid(label + " has a name that is not " + keyHint);
    if (typeof item !== "string" || item.length > 8192 || CONTROL.test(item) || LONE_SURROGATE.test(item)) throw invalid(label + " values must be plain text of at most 8192 characters");
    out[key] = item;
  }
  return out;
}

/** Env values: a whole-value `${vault:NAME}` is a secret reference, anything else stays literal. */
function splitEnv(values: Record<string, string>) {
  const literal: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const whole = /^\$\{vault:([A-Z][A-Z0-9_]{0,63})\}$/.exec(value);
    if (whole) secrets[key] = whole[1];
    else if (value.includes("${vault:")) throw invalid("An env value that uses a vault secret must be exactly ${vault:NAME}");
    else literal[key] = value;
  }
  return { literal, secrets };
}

/** Header values may embed references (for example "Bearer ${vault:TOKEN}"); they become {{TOKEN}} placeholders. */
function splitHeaders(values: Record<string, string>) {
  const literal: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value.includes("${vault:")) { literal[key] = value; continue; }
    const template = value.replace(VAULT_REF, "{{$1}}");
    if (template.includes("${vault:") || (template.match(/\{\{/g)?.length ?? 0) !== (value.match(VAULT_REF)?.length ?? 0)) throw invalid("A header value can only contain whole ${vault:NAME} references");
    secrets[key] = template;
  }
  return { literal, secrets };
}

/** Names of every vault secret a spec refers to. */
export function specSecretNames(spec: McpServerSpec): string[] {
  const names = new Set<string>(Object.values(spec.envSecrets));
  for (const template of Object.values(spec.headerSecrets)) for (const m of template.matchAll(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g)) names.add(m[1]);
  return [...names];
}

export function validateMcpName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) throw invalid("name must be 1-64 letters, digits, hyphens or underscores, starting with a letter or digit");
  return value;
}

/**
 * Accepts what people copy from docs and what the form sends:
 * `{"mcpServers":{"n":{...}}}` (also `servers`), `{"n":{...}}`, a bare server object with a `name`,
 * or the structured form `{name,type,command,args,url,env,headers}`. Returns a fully validated spec.
 */
export function normalizeMcpInput(input: unknown, nameOverride?: unknown): McpServerSpec {
  let node: unknown = input;
  let name: unknown = nameOverride;
  if (typeof node === "string") {
    if (node.length > 64 * 1024) throw invalid("config is too large");
    try { node = JSON.parse(node); } catch { throw invalid("config is not valid JSON"); }
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw invalid("config must be a JSON object");
  let obj = node as Record<string, unknown>;
  const wrapper = (["mcpServers", "servers", "mcp_servers"] as const).find((key) => key in obj && obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key]));
  if (wrapper) {
    const entries = Object.entries(obj[wrapper] as Record<string, unknown>);
    if (entries.length !== 1) throw invalid("config contains " + entries.length + " servers; install one at a time");
    name ??= entries[0][0];
    node = entries[0][1];
  } else if (!Object.keys(obj).some((key) => SERVER_KEYS.has(key)) && Object.keys(obj).length === 1) {
    const [only, value] = Object.entries(obj)[0];
    name ??= only;
    node = value;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw invalid("server config must be a JSON object");
  obj = node as Record<string, unknown>;
  name ??= obj.name;
  const cleanName = validateMcpName(name);

  const rawType = typeof obj.type === "string" ? obj.type : typeof obj.transport === "string" ? obj.transport : undefined;
  let type: "stdio" | "http";
  if (rawType === undefined) type = obj.url !== undefined && obj.command === undefined ? "http" : "stdio";
  else if (rawType === "stdio") type = "stdio";
  else if (rawType === "http" || rawType === "streamable-http" || rawType === "streamable_http" || rawType === "streamableHttp") type = "http";
  else if (rawType === "sse") throw invalid("SSE servers are not supported here; use a stdio or HTTP server");
  else throw invalid("type must be stdio or http");

  if (type === "stdio") {
    if (obj.url !== undefined || obj.headers !== undefined) throw invalid("A stdio server uses command, args and env, not url or headers");
    const command = text(obj.command, "command", 500);
    if (/\s/.test(command) || command.startsWith("-")) throw invalid("command must be just the program (for example npx); put its arguments in args");
    const args = obj.args === undefined ? [] : obj.args;
    if (!Array.isArray(args) || args.length > 50) throw invalid("args must be a list of at most 50 items");
    const cleanArgs = args.map((arg) => text(arg === "" ? "" : arg, "each arg", 2000, false));
    if (args.some((arg) => typeof arg !== "string")) throw invalid("args must be a list of text items");
    const split = splitEnv(stringMap(obj.env, "env", ENV_KEY, "a valid variable name"));
    return { name: cleanName, type, command, args: cleanArgs, env: split.literal, headers: {}, envSecrets: split.secrets, headerSecrets: {}, plaintextSensitive: Object.keys(split.literal).filter(looksSensitive) };
  }
  if (obj.command !== undefined || obj.args !== undefined || obj.env !== undefined) throw invalid("An HTTP server uses url and headers, not command, args or env");
  const rawUrl = text(obj.url, "url", 2048);
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw invalid("url is not a valid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid("url must start with http:// or https://");
  if (parsed.username || parsed.password) throw invalid("Do not put credentials in the url; use headers instead");
  const split = splitHeaders(stringMap(obj.headers, "headers", HEADER_KEY, "a valid header name"));
  return { name: cleanName, type, url: rawUrl, args: [], env: {}, headers: split.literal, envSecrets: {}, headerSecrets: split.secrets, plaintextSensitive: Object.keys(split.literal).filter(looksSensitive) };
}

/** What the agent will launch or contact, for review screens. Values of env and headers are never included. */
export function describeMcp(spec: McpServerSpec): string {
  return spec.type === "stdio" ? [spec.command, ...spec.args].map(quoteForDisplay).join(" ") : spec.url ?? "";
}
const quoteForDisplay = (part: string | undefined) => (part !== undefined && /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part));

// ---------- Claude (JSON) ----------

const b64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** command + args, wrapped in `floq-vault run --stdio` when env values come from the vault. */
function stdioCommand(spec: McpServerSpec, launcher: VaultLauncher): { command: string; args: string[]; wrapped: boolean } {
  const entries = Object.entries(spec.envSecrets);
  if (!entries.length) return { command: spec.command!, args: spec.args, wrapped: false };
  const names = [...new Set(entries.map(([, name]) => name))];
  return {
    command: launcher.command,
    args: [...launcher.prefixArgs, "run", "--stdio", "--only", names.join(","), ...entries.flatMap(([key, name]) => ["--map", key + "=" + name]), "--", spec.command!, ...spec.args],
    wrapped: true,
  };
}

function claudeEntry(spec: McpServerSpec, launcher: VaultLauncher): Record<string, unknown> {
  if (spec.type === "stdio") {
    const run = stdioCommand(spec, launcher);
    return { type: "stdio", command: run.command, args: run.args, ...(Object.keys(spec.env).length ? { env: spec.env } : {}) };
  }
  const helper = Object.keys(spec.headerSecrets).length
    ? { headersHelper: [launcher.command, ...launcher.prefixArgs, "headers", "--server", spec.name, "--spec", b64url(JSON.stringify(spec.headerSecrets))].join(" ") }
    : {};
  return { type: "http", url: spec.url, ...(Object.keys(spec.headers).length ? { headers: spec.headers } : {}), ...helper };
}

const malformed = (what: string) => badRequest(what + " could not be read, so Floq did not change it. Fix or remove the file by hand and try again.", "mcp_config_malformed");
const tooLarge = () => badRequest("That MCP config is too large to edit safely (over 256 KiB).", "mcp_config_too_large");

function parseJsonConfig(raw: string | null, label: string): { root: Record<string, unknown>; servers: Record<string, unknown> | undefined } {
  if (raw === null || raw.trim() === "") return { root: {}, servers: undefined };
  let root: unknown;
  try { root = JSON.parse(raw); } catch { throw malformed(label); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw malformed(label);
  const servers = (root as Record<string, unknown>).mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw malformed(label);
  return { root: root as Record<string, unknown>, servers: servers as Record<string, unknown> | undefined };
}

function serializeJson(root: unknown, original: string | null): string {
  const indent = original && /^\t/m.test(original) ? "\t" : (original?.match(/^( +)"/m)?.[1].length ?? 2);
  const out = JSON.stringify(root, null, indent) + (original === null || original.endsWith("\n") ? "\n" : "");
  if (Buffer.byteLength(out, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  return out;
}

const hasKeyInsensitive = (object: Record<string, unknown> | undefined, name: string) => Object.keys(object ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());

export function addToJsonConfig(raw: string | null, spec: McpServerSpec, label: string, launcher: VaultLauncher = DEFAULT_LAUNCHER): string {
  if (raw !== null && Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  const { root, servers } = parseJsonConfig(raw, label);
  if (hasKeyInsensitive(servers, spec.name)) throw conflict("An MCP server named " + spec.name + " already exists there", "mcp_exists");
  root.mcpServers = { ...(servers ?? {}), [spec.name]: claudeEntry(spec, launcher) };
  return serializeJson(root, raw);
}

/** Returns the new text, or null when there is no entry with exactly this name. */
export function removeFromJsonConfig(raw: string | null, name: string, label: string): string | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  const { root, servers } = parseJsonConfig(raw, label);
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) return null;
  delete servers[name];
  return serializeJson(root, raw);
}

// ---------- Codex (TOML) ----------

type Plain = Record<string, unknown>;
const isPlain = (value: object) => { const proto = Object.getPrototypeOf(value); return proto === null || proto === Object.prototype; };
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(", ") + "]";
  if (value && typeof value === "object" && isPlain(value)) return "{ " + Object.entries(value).map(([k, v]) => tomlKey(k) + " = " + tomlValue(v)).join(", ") + " }";
  throw new Error("unsupported TOML value");
}

/** Renders `[path]` with its scalar/array keys, then one sub-table per nested object. */
export function renderTomlTable(path: string[], table: Plain): string {
  const lines = ["[" + path.map(tomlKey).join(".") + "]"];
  const nested: Array<[string, Plain]> = [];
  for (const [key, value] of Object.entries(table)) {
    if (value && typeof value === "object" && !Array.isArray(value) && isPlain(value)) nested.push([key, value as Plain]);
    else lines.push(tomlKey(key) + " = " + tomlValue(value));
  }
  return [lines.join("\n"), ...nested.map(([key, value]) => renderTomlTable([...path, key], value).trimEnd())].join("\n\n") + "\n";
}

function codexTable(spec: McpServerSpec, launcher: VaultLauncher): Plain {
  if (spec.type === "stdio") {
    const run = stdioCommand(spec, launcher);
    return { command: run.command, args: run.args, ...(run.wrapped ? { env_vars: CODEX_FORWARDED_ENV } : {}), ...(Object.keys(spec.env).length ? { env: spec.env } : {}) };
  }
  // Verified with codex 0.166: its http_headers_helper runs with a scrubbed environment (no Floq session credentials),
  // so the wrapper cannot authenticate to the vault from there. Refuse instead of writing the value in plain text.
  if (Object.keys(spec.headerSecrets).length) throw badRequest("Codex cannot read vault secrets for HTTP headers: its header helper runs without Floq's session credentials. Install this server for Claude Code only, or keep the header as plain text.", "mcp_secret_unsupported");
  return { url: spec.url, ...(Object.keys(spec.headers).length ? { http_headers: spec.headers } : {}) };
}

function parseTomlConfig(raw: string | null, label: string): Plain {
  if (raw === null || raw.trim() === "") return {};
  try { return parseToml(raw) as Plain; } catch { throw malformed(label); }
}
function tomlServers(root: Plain, label: string): Plain | undefined {
  const servers = root.mcp_servers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) throw malformed(label);
  return servers as Plain | undefined;
}

export function addToTomlConfig(raw: string | null, spec: McpServerSpec, label: string, launcher: VaultLauncher = DEFAULT_LAUNCHER): string {
  if (raw !== null && Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  const before = parseTomlConfig(raw, label);
  if (hasKeyInsensitive(tomlServers(before, label), spec.name)) throw conflict("An MCP server named " + spec.name + " already exists there", "mcp_exists");
  const base = raw === null || raw.trim() === "" ? "" : raw.endsWith("\n") ? raw + "\n" : raw + "\n\n";
  const next = base + renderTomlTable(["mcp_servers", spec.name], codexTable(spec, launcher));
  if (Buffer.byteLength(next, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  // Appending must leave every existing setting exactly as it was; if the file's own layout prevents that, refuse.
  const after = parseTomlConfigSafe(next);
  const expected = structuredClone(before) as Plain;
  expected.mcp_servers = { ...((expected.mcp_servers as Plain | undefined) ?? {}), [spec.name]: codexTable(spec, launcher) };
  if (!after || !sameJson(after, expected)) throw badRequest("That Codex config is laid out in a way Floq cannot extend safely, so it was not changed. Add the server by hand.", "mcp_config_unsupported");
  return next;
}

const HEADER = /^\s*\[(?!\[)\s*(.+?)\s*\]\s*(?:#.*)?$/;
const KEY_TOKEN = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/y;
function headerPath(line: string): string[] | null {
  const match = HEADER.exec(line);
  if (!match) return null;
  const parts: string[] = [];
  KEY_TOKEN.lastIndex = 0;
  const body = match[1];
  let at = 0;
  while (at < body.length) {
    KEY_TOKEN.lastIndex = at;
    const token = KEY_TOKEN.exec(body);
    if (!token) return null;
    const key = token[1];
    try { parts.push(key.startsWith('"') ? (JSON.parse(key) as string) : key.startsWith("'") ? key.slice(1, -1) : key); } catch { return null; }
    at = KEY_TOKEN.lastIndex;
    if (token[2] === "") break;
  }
  return parts;
}

/** Removes `[mcp_servers.NAME]` and its sub-tables line by line, keeping all other text (comments included). */
export function removeFromTomlConfig(raw: string | null, name: string, label: string): string | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) throw tooLarge();
  const before = parseTomlConfig(raw, label);
  const servers = tomlServers(before, label);
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, name)) return null;
  const out: string[] = [];
  let removing = false;
  let removedAny = false;
  for (const line of raw.split("\n")) {
    const path = line.trimStart().startsWith("[") ? headerPath(line.replace(/\r$/, "")) : null;
    if (path || line.trimStart().startsWith("[[")) {
      const hit = Boolean(path) && path!.length >= 2 && path![0] === "mcp_servers" && path![1] === name;
      if (hit && !removing) while (out.length && out[out.length - 1].trim() === "") out.pop();
      if (!hit && removing && out.length && out[out.length - 1].trim() !== "") out.push("");
      removing = hit;
      removedAny ||= hit;
    }
    if (!removing) out.push(line);
  }
  const next = out.join("\n");
  const after = removedAny ? parseTomlConfigSafe(next) : null;
  const expected = structuredClone(before) as Plain;
  delete (expected.mcp_servers as Plain)[name];
  // An emptied [mcp_servers] table and a missing one mean the same thing.
  for (const doc of [expected, after]) if (doc && doc.mcp_servers && typeof doc.mcp_servers === "object" && !Object.keys(doc.mcp_servers).length) delete doc.mcp_servers;
  if (!after || !sameJson(after, expected)) throw badRequest("That server is defined in a form Floq cannot remove safely, so the Codex config was not changed. Remove it by hand.", "mcp_config_unsupported");
  return next;
}

function parseTomlConfigSafe(raw: string): Plain | null {
  try { return parseToml(raw) as Plain; } catch { return null; }
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Codex sessions run with a private CODEX_HOME, so the user's global `~/.codex/config.toml` is not read by them.
 * Returns the session config text with the global servers it does not already define appended, or null when
 * nothing changes or either file cannot be handled safely. Only `mcp_servers` is copied, never other settings.
 */
export function mergeGlobalCodexMcp(globalRaw: string, sessionRaw: string | null): string | null {
  try {
    if (Buffer.byteLength(globalRaw, "utf8") > MAX_MCP_CONFIG_BYTES || (sessionRaw !== null && Buffer.byteLength(sessionRaw, "utf8") > MAX_MCP_CONFIG_BYTES)) return null;
    const global = tomlServers(parseToml(globalRaw) as Plain, "global");
    if (!global) return null;
    const session = sessionRaw === null || sessionRaw.trim() === "" ? {} : (parseToml(sessionRaw) as Plain);
    const have = tomlServers(session, "session") ?? {};
    const present = new Set(Object.keys(have).map((key) => key.toLowerCase()));
    const blocks: string[] = [];
    for (const [name, table] of Object.entries(global)) {
      if (present.has(name.toLowerCase()) || !table || typeof table !== "object" || Array.isArray(table)) continue;
      blocks.push(renderTomlTable(["mcp_servers", name], table as Plain));
    }
    if (!blocks.length) return null;
    const base = sessionRaw === null || sessionRaw.trim() === "" ? "" : sessionRaw.endsWith("\n") ? sessionRaw + "\n" : sessionRaw + "\n\n";
    const next = base + blocks.join("\n");
    const check = parseToml(next) as Plain;
    const merged = tomlServers(check, "session") ?? {};
    return Object.keys(merged).length === present.size + blocks.length ? next : null;
  } catch { return null; }
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ---------- Sandboxed file helper ----------

/**
 * Constant script, run with the shard driver's unprivileged sandbox (like the skill install scripts). It can only
 * read or atomically replace these four config paths, never follows a symlink, and writes only if the file still
 * has the content that was read (compare-and-swap on a SHA-256), so a concurrent change is retried, not clobbered.
 * User content arrives as base64 argv chunks.
 */
export const MCP_FILE_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX = 262144;
const fail = (code) => { process.stderr.write(code); process.exitCode = 1; };
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
let tmp = null;
try {
  const payload = JSON.parse(Buffer.from(process.argv[1] || "", "base64").toString("utf8"));
  const rel = Array.isArray(payload.parts) ? payload.parts.join("/") : "";
  if (!/^(\.claude\.json|\.mcp\.json|\.codex\/config\.toml|\.floq\/codex\/[A-Za-z0-9._-]{1,100}\/config\.toml)$/.test(rel) || rel.includes("..")) throw new Error("UNSAFE");
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  const root = fs.realpathSync(process.cwd());
  if (root !== path.resolve(process.cwd())) throw new Error("UNSAFE");
  const canCreate = payload.op === "write" && parts.length === 2 && parts[0] === ".codex";
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let stat;
    try { stat = fs.lstatSync(dir); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!canCreate) { if (payload.op === "read") { process.stdout.write("MCP_ABSENT"); process.exit(0); } throw error; }
      fs.mkdirSync(dir, { mode: 0o755 });
      stat = fs.lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(dir) !== dir) throw new Error("UNSAFE");
  }
  const file = path.join(dir, name);
  const current = () => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("UNSAFE");
    if (stat.size > MAX) throw new Error("TOO_LARGE");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX) throw new Error("TOO_LARGE");
      return { buffer: fs.readFileSync(fd), mode: opened.mode & 0o777 };
    } finally { fs.closeSync(fd); }
  };
  const hash = (entry) => entry ? crypto.createHash("sha256").update(entry.buffer).digest("hex") : "absent";
  const now = current();
  if (payload.op === "read") {
    process.stdout.write(now ? "MCP_FILE:" + hash(now) + ":" + now.buffer.toString("base64") : "MCP_ABSENT");
  } else if (payload.op === "write") {
    if (hash(now) !== payload.expect) throw new Error("CHANGED");
    const chunks = process.argv.slice(2).map((chunk) => Buffer.from(chunk, "base64"));
    const contents = Buffer.concat(chunks);
    if (!Number.isSafeInteger(payload.bytes) || contents.length !== payload.bytes || contents.length > MAX || chunks.length !== payload.chunks) throw new Error("UNSAFE");
    tmp = path.join(dir, "." + name + "." + crypto.randomBytes(6).toString("hex") + ".tmp");
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, now ? now.mode : 0o600);
    try {
      let offset = 0;
      while (offset < contents.length) offset += fs.writeSync(fd, contents, offset, contents.length - offset);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    tmp = null;
    process.stdout.write("MCP_WRITTEN");
  } else throw new Error("UNSAFE");
} catch (error) {
  if (tmp) try { fs.unlinkSync(tmp); } catch {}
  const message = error && error.message;
  fail(message === "CHANGED" ? "MCP_CHANGED" : message === "TOO_LARGE" ? "MCP_TOO_LARGE" : message === "UNSAFE" ? "MCP_UNSAFE" : "MCP_FAILED");
}
`;

export function mcpHelperError(output: string): HttpError {
  if (output.includes("MCP_UNSAFE")) return badRequest("The MCP config path contains an unsafe entry (a link or unexpected file type), so Floq did not touch it.", "mcp_config_unsafe");
  if (output.includes("MCP_TOO_LARGE")) return tooLarge();
  return badRequest("Could not safely update the MCP config.", "mcp_write_failed");
}

/** Recognises the floq-vault wrapper this module writes. Returns the original command and secret names, or null. */
export function vaultUsage(command: unknown, args: unknown, headersHelper: unknown): { command?: string; secretNames: string[] } | null {
  const base = (value: string) => value.replace(/\\/g, "/").split("/").pop() ?? "";
  if (typeof command === "string" && base(command) === "floq-vault" && Array.isArray(args) && args.every((a) => typeof a === "string")) {
    const list = args as string[];
    const run = list.indexOf("run");
    const only = list.indexOf("--only");
    const sep = list.indexOf("--");
    if (run >= 0 && list.includes("--stdio") && only >= 0 && sep > only) return { command: list[sep + 1], secretNames: (list[only + 1] ?? "").split(",").filter((n) => VAULT_NAME.test(n)) };
  }
  if (typeof headersHelper === "string" && /(^|[\\/ ])floq-vault(\.mjs)? /.test(headersHelper) && headersHelper.includes(" headers ")) {
    const spec = /--spec ([A-Za-z0-9_-]+)/.exec(headersHelper)?.[1];
    try {
      const templates = Object.values(JSON.parse(Buffer.from(spec ?? "", "base64url").toString("utf8")) as Record<string, string>);
      return { secretNames: [...new Set(templates.flatMap((t) => [...String(t).matchAll(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g)].map((m) => m[1])))] };
    } catch { return { secretNames: [] }; }
  }
  return null;
}
