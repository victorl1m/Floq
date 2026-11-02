/**
 * Turns what people copy from MCP docs into the "Add MCP server" form. Nothing is sent anywhere: the user reviews the
 * filled form first. The runtime validates the final values again (runtime/src/mcpConfig.ts), so this is only a convenience.
 *
 * Accepted: {"mcpServers":{"name":{...}}}, {"servers":{...}}, {"name":{...}}, or a single server object with a "name".
 *
 * Each env var and header is a row with a mode:
 *   existing - read from a vault secret that already exists (the config holds only a reference, written as ${vault:NAME})
 *   new      - the typed value is saved as a new vault secret, and the config holds the reference
 *   literal  - stored as plain text in the config file
 */
export type ValueMode = "literal" | "existing" | "new";
export interface McpRow {
  key: string;
  mode: ValueMode;
  /** literal value, or the value of a new secret. Cleared as soon as it is no longer needed. */
  value: string;
  /** secret name for "existing", or an override of the suggested name for "new" ("" = use the suggestion). */
  secret: string;
  /** text before the secret in a header value, for example "Bearer ". */
  prefix: string;
  /** true once the user picked a mode, so changing the key no longer changes it. */
  touched: boolean;
}
export interface McpFormValues {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env: McpRow[];
  headers: McpRow[];
}

const SERVER_KEYS = new Set(["command", "args", "env", "url", "type", "headers", "transport", "name"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Names that usually hold credentials. Rows with these names default to a vault secret. */
export const looksSensitive = (name: string) => /(TOKEN|KEY|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|BEARER)/i.test(name);

export const emptyRow = (key = ""): McpRow => ({ key, mode: looksSensitive(key) ? "new" : "literal", value: "", secret: "", prefix: "", touched: false });
export const rowMode = (row: McpRow): ValueMode => (row.touched ? row.mode : looksSensitive(row.key) ? "new" : "literal");

/** `<SERVER>_<KEY>` as a valid vault name (A-Z, 0-9, _; starts with a letter; at most 64). */
export function suggestSecretName(server: string, key: string): string {
  const clean = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  let name = [clean(server), clean(key)].filter(Boolean).join("_") || "MCP_SECRET";
  if (!/^[A-Z]/.test(name)) name = "S_" + name;
  return name.slice(0, 64).replace(/_+$/, "") || "MCP_SECRET";
}
export const secretNameOf = (row: McpRow, server: string) => (rowMode(row) === "existing" ? row.secret : row.secret || suggestSecretName(server, row.key));

const REF = /^(.*)\$\{vault:([A-Z][A-Z0-9_]{0,63})\}$/;
function rowsFrom(value: unknown, withPrefix: boolean): McpRow[] {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([key, item]) => {
    const text = typeof item === "string" ? item : String(item);
    const ref = REF.exec(text);
    if (ref && (withPrefix || ref[1] === "")) return { key, mode: "existing" as const, value: "", secret: ref[2], prefix: ref[1], touched: true };
    // "Bearer abc" in a credential header: keep the scheme as text before the secret and save only the token.
    const scheme = withPrefix && looksSensitive(key) ? /^(Bearer |Basic |Token )(.+)$/i.exec(text) : null;
    if (scheme) return { key, mode: "new" as const, value: scheme[2], secret: "", prefix: scheme[1], touched: false };
    return { key, mode: looksSensitive(key) ? "new" as const : "literal" as const, value: text, secret: "", prefix: "", touched: false };
  });
}

export function parseMcpPaste(text: string): { values: McpFormValues } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { error: "That is not valid JSON. Paste the block from the server's docs, including the braces." }; }
  if (!isObject(parsed)) return { error: "Paste a JSON object." };
  let name = "";
  let node: Record<string, unknown> = parsed;
  const wrapper = (["mcpServers", "servers", "mcp_servers"] as const).find((key) => isObject(parsed[key]));
  if (wrapper) {
    const entries = Object.entries(parsed[wrapper] as Record<string, unknown>);
    if (entries.length !== 1) return { error: `This config has ${entries.length} servers. Paste one server at a time.` };
    name = entries[0][0];
    if (!isObject(entries[0][1])) return { error: "The server entry must be an object." };
    node = entries[0][1] as Record<string, unknown>;
  } else if (Object.keys(parsed).length === 1 && !SERVER_KEYS.has(Object.keys(parsed)[0]) && isObject(Object.values(parsed)[0])) {
    name = Object.keys(parsed)[0];
    node = Object.values(parsed)[0] as Record<string, unknown>;
  }
  if (!name && typeof node.name === "string") name = node.name;
  const rawType = typeof node.type === "string" ? node.type : typeof node.transport === "string" ? node.transport : undefined;
  if (rawType === "sse") return { error: "SSE servers are not supported here. Use a stdio or HTTP server." };
  const type: "stdio" | "http" = rawType === "http" || rawType === "streamable-http" || rawType === "streamableHttp" || rawType === "streamable_http" || (rawType === undefined && typeof node.url === "string" && node.command === undefined) ? "http" : "stdio";
  return {
    values: {
      name,
      type,
      command: typeof node.command === "string" ? node.command : "",
      args: Array.isArray(node.args) ? node.args.map((item) => String(item)) : [],
      url: typeof node.url === "string" ? node.url : "",
      env: rowsFrom(node.env, false),
      headers: rowsFrom(node.headers, true),
    },
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VAULT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Rows that will be written (a row with no key and no value is ignored). */
export const activeRows = (rows: McpRow[]) => rows.filter((row) => row.key || row.value || row.secret);

/**
 * Mirrors the runtime's checks so mistakes show up before the review step. `existing` is the user's current vault names.
 * Returns an error message or null. A new secret whose name is taken is reported by `conflictingNewSecrets` instead.
 */
export function validateMcpForm(form: McpFormValues, existing: ReadonlySet<string>): string | null {
  if (!NAME.test(form.name)) return "Name must be 1-64 letters, digits, hyphens or underscores, starting with a letter or digit.";
  if (form.type === "stdio") {
    const command = form.command;
    if (!command.trim()) return "Enter the command to run, for example npx.";
    if (/\s/.test(command) || command.startsWith("-") || CONTROL.test(command) || command.length > 500) return "Command must be just the program (for example npx). Put its arguments in Arguments, one per line.";
    if (form.args.length > 50 || form.args.some((arg) => CONTROL.test(arg) || arg.length > 2000)) return "Arguments must be plain text, at most 50 lines.";
  } else {
    let url: URL;
    try { url = new URL(form.url); } catch { return "Enter a full URL, for example https://example.com/mcp."; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "The URL must start with http:// or https://.";
    if (url.username || url.password) return "Do not put credentials in the URL; use a header instead.";
    if (form.url.length > 2048 || CONTROL.test(form.url)) return "The URL is not valid.";
  }
  const isHttp = form.type === "http";
  const label = isHttp ? "Header" : "Environment variable";
  const rows = activeRows(isHttp ? form.headers : form.env);
  const seen = new Set<string>();
  const newNames = new Set<string>();
  for (const row of rows) {
    if (!(isHttp ? HEADER_KEY : ENV_KEY).test(row.key)) return `${label} names can only use letters, digits${isHttp ? " and hyphens" : " and underscores"}.`;
    if (seen.has(row.key.toLowerCase())) return `${label} ${row.key} is listed twice.`;
    seen.add(row.key.toLowerCase());
    const mode = rowMode(row);
    if (mode === "existing") {
      if (!row.secret) return `Choose a vault secret for ${row.key}.`;
      if (!existing.has(row.secret)) return `The vault secret ${row.secret} no longer exists. Choose another.`;
    } else if (mode === "new") {
      const secret = secretNameOf(row, form.name);
      if (!VAULT_NAME.test(secret)) return `Secret names use A-Z, 0-9 and _, start with a letter, and have at most 64 characters (${row.key}).`;
      if (!row.value) return `Enter a value for ${row.key}, or choose a different option.`;
      if (newNames.has(secret)) return `Two rows would create a secret named ${secret}. Give them different names.`;
      newNames.add(secret);
    }
    if (mode !== "existing" && (CONTROL.test(row.value) || row.value.length > 8192)) return `${label} values must be plain text on one line.`;
    if (isHttp && (CONTROL.test(row.prefix) || row.prefix.length > 64)) return "The text before a secret in a header must be short plain text.";
  }
  return null;
}

/** New secrets whose chosen name is already in the vault. The user must pick the existing one or rename; nothing is overwritten. */
export function conflictingNewSecrets(form: McpFormValues, existing: ReadonlySet<string>): Array<{ row: McpRow; name: string }> {
  return activeRows(form.type === "http" ? form.headers : form.env)
    .filter((row) => rowMode(row) === "new" && existing.has(secretNameOf(row, form.name)))
    .map((row) => ({ row, name: secretNameOf(row, form.name) }));
}

const quote = (part: string) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part));
/** Exactly what will be launched or contacted. Never includes env or header values. */
export const describeMcpForm = (form: McpFormValues) => (form.type === "stdio" ? [form.command, ...form.args].map(quote).join(" ") : form.url);

/** Config value for one row: a reference for secrets, the literal otherwise. */
function draftValue(row: McpRow, server: string): string {
  const mode = rowMode(row);
  return mode === "literal" ? row.value : row.prefix + "${vault:" + secretNameOf(row, server) + "}";
}
const toRecord = (rows: McpRow[], server: string) => Object.fromEntries(activeRows(rows).map((row) => [row.key, draftValue(row, server)]));

export function toMcpDraft(form: McpFormValues) {
  return form.type === "stdio"
    ? { name: form.name, type: "stdio" as const, command: form.command, args: form.args, env: toRecord(form.env, form.name) }
    : { name: form.name, type: "http" as const, url: form.url, headers: toRecord(form.headers, form.name) };
}

/** Secrets to create before installing (never overwrites; the runtime refuses a taken name). */
export function newSecretsOf(form: McpFormValues) {
  return activeRows(form.type === "http" ? form.headers : form.env)
    .filter((row) => rowMode(row) === "new")
    .map((row) => ({ name: secretNameOf(row, form.name), value: row.value, description: `Used by MCP server ${form.name} (${row.key})` }));
}

/** True when the user explicitly kept a credential-looking value as plain text in the config. */
export const keepsSensitivePlaintext = (form: McpFormValues) =>
  activeRows(form.type === "http" ? form.headers : form.env).some((row) => rowMode(row) === "literal" && looksSensitive(row.key));

/** Codex cannot read vault secrets for HTTP headers (verified: its header helper runs without Floq session credentials). */
export const codexHttpSecretBlocked = (form: McpFormValues, providers: "claude" | "codex" | "both") =>
  form.type === "http" && providers !== "claude" && activeRows(form.headers).some((row) => rowMode(row) !== "literal");
