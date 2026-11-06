import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type NamedArgs = Record<string, string | boolean>;
export interface ScopeResult { scope?: "global" | "project"; projectId?: string; dryRun?: boolean }
export interface AgentEntry { project?: { id: string | null; name: string; same: boolean }; role?: string | null; self?: boolean; name: string; id: string; provider: string; model?: string | null; state: string; lead?: boolean }
export interface ModelEntry { id: string; label: string }
export interface McpReview { name: string; type: "stdio" | "http"; summary: string; secrets?: { target: string; secret: string }[]; plaintext?: string[] }
export interface McpServer { provider: string; name: string; transport: string; command?: string; urlHost?: string; usesSecrets?: boolean; secretNames?: string[]; protected?: boolean; source?: string }
export interface SkillSummary { provider: string; name: string; source: string; description?: string }

export function parseArgs(args: string[]): { positional: string[]; named: NamedArgs } {
  const positional = [];
  const named: NamedArgs = {};
  const booleanFlags = new Set(["isolated", "global", "dry-run", "allow-plaintext", "wait", "no-wait", "full", "no-wire", "all-projects", "here", "consume"]);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      positional.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (name === "project") {
      // Optional value: a project UUID, otherwise "this session's project".
      named.project = i + 1 < args.length && PROJECT_ID.test(args[i + 1]) ? args[++i] : true;
      continue;
    }
    if (booleanFlags.has(name)) named[name] = true;
    else if (i + 1 < args.length) named[name] = args[++i];
    else named[name] = true;
  }
  return { positional, named };
}

export function formatAgentListEntry(agent: AgentEntry) {
  const where = agent.project ? "  project " + JSON.stringify(agent.project.name) + (agent.project.same ? " (this project)" : "") : "";
  return (agent.self ? "* " : "  ") + agent.name + "  " + agent.id + where + "  [" + agent.provider + ", configured model: " + (agent.model ?? "default") + ", " + agent.state + (agent.role ? ", role " + agent.role : "") + (agent.lead ? ", lead" : "") + "]";
}

export function formatRecruitment(agent: Pick<AgentEntry, "name" | "id" | "provider" | "model"> & { skills?: string[] }) {
  return "recruited " + agent.name + " " + agent.id + " (" + agent.provider + ", configured model: " + (agent.model ?? "default") + (agent.skills?.length ? ", skills: " + agent.skills.join(", ") : "") + ")";
}

export interface SubagentEntry { id: string; name: string; role: string; provider: string; model: string; state: string; depth: number; parentId?: string | null }

export function formatSubagentRecruit(r: { id: string; name: string; role: string; provider: string; model: string; depth: number; wired?: boolean; skills?: string[] }) {
  return "recruited subagent " + r.name + " " + r.id + " (role " + r.role + ", " + r.provider + ", model " + r.model + ", depth " + r.depth + (r.skills?.length ? ", skills " + r.skills.join(", ") : "") + (r.wired === false ? ", not wired" : ", wired to you") + "). Read its report with: floq subagent result " + r.id;
}

export function formatSubagentLine(s: SubagentEntry) {
  return "  ".repeat(Math.max(0, s.depth - 1)) + s.name + "  " + s.id + "  [" + s.role + ", " + s.provider + ", " + s.state + ", depth " + s.depth + "]";
}

export interface RoleEntry { id: string; label: string; summary: string; capability: string; readOnly: boolean }

export function formatRoleLine(role: RoleEntry) {
  return [role.id.padEnd(12), role.capability.padEnd(16), role.readOnly ? "read-only" : "read-write", role.summary].join("  ");
}

export function formatModel(provider: string, model: ModelEntry) {
  return provider + "\t" + model.id + "\t" + model.label;
}

export function buildRecruitPayload(positional: string[], named: NamedArgs) {
  return {
    name: positional[0],
    provider: named.provider,
    model: named.model,
    cwd: named.cwd,
    role: named.role,
    isolated: named.isolated === true,
    skills: named.skill,
  };
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits `a b -- c d` into [["a","b"], ["c","d"]]; the second part is null without a `--`. */
export function splitDashDash(args: string[]): [string[], string[] | null] {
  const at = args.indexOf("--");
  return at < 0 ? [args, null] : [args.slice(0, at), args.slice(at + 1)];
}

/** `--global` or `--project [UUID]` -> body fields; nothing given lets the runtime pick (this session's project, else global). */
export function scopeFields(named: NamedArgs): ScopeResult {
  if (named.global && named.project) throw new Error("use either --global or --project, not both");
  if (named.global) return { scope: "global" };
  if (named.project === true) return { scope: "project" };
  if (typeof named.project === "string") {
    if (!PROJECT_ID.test(named.project)) throw new Error("--project takes a project UUID");
    return { scope: "project", projectId: named.project };
  }
  return {};
}

export function checkProvider(value: string | boolean | undefined, allowBoth: boolean): "claude" | "codex" | "both" | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "codex" || (allowBoth && value === "both")) return value;
  throw new Error("--provider must be claude, codex" + (allowBoth ? " or both" : ""));
}

export function scopeLabel(result: ScopeResult & { scope?: string; projectId?: string }) {
  return result.scope === "project" ? "project " + result.projectId : "global (your whole home)";
}

/** Review text printed before and after an MCP install. Only names of env/header entries, never values. */
export function formatMcpReview(review: McpReview, result: ScopeResult & { dryRun?: boolean }) {
  const lines = [
    (result.dryRun ? "Would install" : "Installing") + " MCP server \"" + review.name + "\" (" + (review.type === "stdio" ? "stdio" : "HTTP") + ")",
    review.type === "stdio" ? "  runs:  " + review.summary : "  url:   " + review.summary,
  ];
  for (const { target, secret } of review.secrets ?? []) lines.push("  " + target + " <- vault secret " + secret + " (read from the vault when the server starts; never written to the config)");
  const plain = review.plaintext ?? [];
  if (plain.length) lines.push("  stored as plain text in the config file: " + plain.map((n) => n + "=****").join(", ") + " (values hidden)");
  lines.push("  scope: " + scopeLabel(result));
  if (review.type === "stdio") lines.push("  note:  a stdio MCP server runs this command with the agent's permissions.");
  if (result.scope === "project") lines.push("  note:  values saved in a project's config can be committed to git.");
  return lines.join("\n");
}

export function formatMcpServer(server: McpServer) {
  const detail = server.command ?? server.urlHost ?? "";
  return server.provider + "\t" + server.name + "\t" + server.transport + (detail ? "\t" + detail : "") + (server.usesSecrets ? "\t(uses vault secrets" + (server.secretNames?.length ? ": " + server.secretNames.join(",") : "") + ")" : "") + (server.protected || server.source === "bundled" ? "\t(bundled, protected)" : "");
}

export function formatSkill(skill: SkillSummary) {
  return skill.provider + "\t" + skill.name + "\t" + skill.source + (skill.description ? "\t" + skill.description.replace(/\s+/g, " ").slice(0, 100) : "");
}

/** Parses the `secrets add` arguments. The value is never an argument: any extra positional or --value is refused. */
export function parseSecretsAdd(positional: string[], named: NamedArgs): { name: string; keychain?: string } {
  if (positional.length !== 1) throw new Error("usage: floq secrets add NAME [--keychain NAME]  (the value is read from stdin or a hidden prompt, never from an argument)");
  if ("value" in named || "expose" in named) throw new Error("secrets add does not accept --value or --expose; the value comes from stdin or a hidden prompt, and agent-created secrets always live in a keychain");
  if ("keychain" in named && typeof named.keychain !== "string") throw new Error("--keychain needs a keychain name");
  return { name: positional[0], keychain: typeof named.keychain === "string" ? named.keychain : undefined };
}

/** Trims exactly one trailing newline from piped input. */
export function cleanSecretInput(raw: string) {
  return raw.replace(/\r?\n$/, "");
}

const SKILL_LIMITS = { files: 120, total: 512 * 1024, file: 64 * 1024 };

/**
 * Reads a skill directory for `floq skills create --from DIR`: regular UTF-8 text files only, no symbolic links, within the same
 * limits the runtime enforces (it checks again). Returns { "SKILL.md": text, "references/x.md": text, ... }.
 */
export function readSkillDirectory(root: string): Record<string, string> {
  let rootStat;
  try { rootStat = lstatSync(root); } catch { throw new Error("--from: cannot read " + root); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("--from must be a real directory, not a link or a file");
  const files: Record<string, string> = {};
  let count = 0;
  let total = 0;
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const rel = prefix + entry.name;
      const full = join(current, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("--from: " + rel + " is a symbolic link. Links are not followed; copy the real file into the directory.");
      if (stat.isDirectory()) { walk(full, rel + "/"); continue; }
      if (!stat.isFile()) throw new Error("--from: " + rel + " is not a regular file");
      if (++count > SKILL_LIMITS.files) throw new Error("--from: a skill can have at most " + SKILL_LIMITS.files + " files");
      if (stat.size > SKILL_LIMITS.file) throw new Error("--from: " + rel + " is larger than 64 KiB");
      total += stat.size;
      if (total > SKILL_LIMITS.total) throw new Error("--from: the files add up to more than 512 KiB");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(full)); } catch { throw new Error("--from: " + rel + " is not UTF-8 text"); }
      if (text.includes("\u0000")) throw new Error("--from: " + rel + " contains NUL bytes");
      files[rel] = text;
    }
  };
  walk(root, "");
  if (!("SKILL.md" in files)) throw new Error("--from: the directory must contain a SKILL.md");
  return files;
}

export interface Delivery { mode: "full" | "inbox"; chars: number; sha256: string; inboxId?: string }
export interface AgentReply { status: string; output: string; truncated?: number; source?: string; delivery?: Delivery }

/** Longest message accepted as command-line text. Longer ones must come from a file or stdin, where no shell, TUI or argv limit can cut them. */
export const MAX_ARGV_MESSAGE_CHARS = 4_000;

/** Where `floq ask` takes the message from: argv words, `-` (stdin) or `--file PATH`. Never mixes sources. */
export function messageSource(positional: string[], named: NamedArgs): { kind: "argv"; text: string } | { kind: "stdin" } | { kind: "file"; path: string } {
  const words = positional.slice(1);
  if (named.file !== undefined) {
    if (typeof named.file !== "string" || !named.file) throw new Error("--file takes a path");
    if (words.length) throw new Error("use either message text or --file, not both");
    return { kind: "file", path: named.file };
  }
  if (words.length === 1 && words[0] === "-") return { kind: "stdin" };
  const text = words.join(" ");
  if (text.length > MAX_ARGV_MESSAGE_CHARS) {
    throw new Error("the message is " + text.length + " chars, too long to pass as a command-line argument (max " + MAX_ARGV_MESSAGE_CHARS + "); a long argument can be cut off by your terminal. Write it to a file and run: floq ask <agent> --file PATH   (or pipe it: floq ask <agent> -  < PATH)");
  }
  return { kind: "argv", text };
}

/** One receipt line for stderr after a message was typed into the other agent's terminal. */
export function formatDelivery(d: Delivery | undefined): string {
  if (!d) return "";
  return d.mode === "full"
    ? "delivered " + d.chars + " chars (full, sha256 " + d.sha256 + ")"
    : "delivered preview + inbox id " + d.inboxId + " (" + d.chars + " chars, sha256 " + d.sha256 + "); the receiver reads it with: floq inbox read " + d.inboxId;
}

/**
 * Render a check/ask/wait response: an explicit `status:` first line, then the reply. Exit codes: 0 finished or
 * sent, 3 still working after the timeout, 4 waiting for input, 5 exited/asleep.
 */
export function formatAgentReply(command: "ask" | "check" | "wait", id: string, reply: AgentReply, timeoutSec?: number): { text: string; code: number } {
  const status = reply.status;
  let label = status;
  let code = 0;
  if (status === "done" || status === "quiet") label = "idle";
  else if (status === "timeout") { label = "working (timed out" + (timeoutSec ? " after " + timeoutSec + "s" : "") + "; still working, run `floq wait " + id + "` to keep waiting)"; code = 3; }
  else if (status === "waiting-for-input") { label = "waiting-for-input (the agent is stopped on a prompt; check the terminal)"; code = 4; }
  else if (status === "exit" || status === "exited" || status === "asleep") { label = status === "asleep" ? "asleep" : "exited"; code = status === "asleep" ? 0 : 5; }
  else if (status === "working" && command !== "check") code = 3;
  const lines = ["status: " + label];
  if (command === "check" && reply.source) lines.push("source: " + (reply.source === "transcript" ? "last reply" : reply.source === "terminal" ? "terminal tail (no finished reply yet)" : reply.source));
  if (reply.output) lines.push(reply.output);
  else if (status !== "sent") lines.push("(no output)");
  if (reply.truncated) lines.push("[truncated: " + reply.truncated + " more chars, use --full]");
  return { text: lines.join("\n"), code };
}

/** Paths of `floq display` inside the sandbox's private /tmp (never the shared netns, never /run, which is root-owned). */
export const DISPLAY_DIR = "/tmp/floq-display";
export const DISPLAY_PATHS = {
  sockets: DISPLAY_DIR + "/sockets",
  logs: DISPLAY_DIR + "/log",
  runtime: DISPLAY_DIR + "/xdg",
  socket: DISPLAY_DIR + "/sockets/xpra.sock",
  /** X cookie file; the runtime sets XAUTHORITY to this path in every session (display.ts DISPLAY_XAUTHORITY). */
  xauthority: DISPLAY_DIR + "/Xauthority",
} as const;

/** FLOQ_DISPLAY / FLOQ_DISPLAY_PORT / FLOQ_DISPLAY_TOKEN injected by the runtime, or an error message. */
export function displayFromEnv(env: Record<string, string | undefined>): { display: string; port: number; token: string } | { error: string } {
  const display = env.FLOQ_DISPLAY?.trim() ?? "";
  const port = Number(env.FLOQ_DISPLAY_PORT);
  const token = env.FLOQ_DISPLAY_TOKEN ?? "";
  if (!/^:\d{1,5}$/.test(display) || !Number.isInteger(port) || port < 1024 || port > 65535 || !token) {
    return { error: "this session has no display slot (FLOQ_DISPLAY/FLOQ_DISPLAY_PORT/FLOQ_DISPLAY_TOKEN missing); restart the session with \"floq session restart\"" };
  }
  return { display, port, token };
}

/**
 * Argv for `xpra start`. The password is NOT here: auth=env reads XPRA_PASSWORD from the server's environment, so it
 * never shows up in a process listing.
 * X11: Xvfb keeps its abstract socket (@/tmp/.X11-unix/XN) on purpose. Abstract names are global in the shared netns,
 * and libxcb tries the abstract name first, so leaving it unbound would let another user bind it and receive this
 * session's app windows. Holding it, plus the MIT cookie (-auth $XAUTHORITY, file in the private /tmp), keeps other
 * users both out of it and off it. No TCP (-nolisten tcp).
 * Xpra: the explicit --bind path replaces xpra's "auto" local sockets, which on Linux include an abstract socket with
 * peercred-only auth (xpra/net/socket_util.py setup_local_sockets).
 */
export function xpraStartArgs(display: string, port: number): string[] {
  return [
    "start", display,
    "--daemon=yes",
    "--bind=" + DISPLAY_PATHS.socket,
    "--socket-dir=" + DISPLAY_PATHS.sockets,
    "--socket-dirs=" + DISPLAY_PATHS.sockets,
    "--log-dir=" + DISPLAY_PATHS.logs,
    "--bind-ws=127.0.0.1:" + port + ",auth=env",
    "--html=on",
    "--xvfb=Xvfb +extension GLX +extension Composite +extension RANDR +extension RENDER -extension DOUBLE-BUFFER -screen 0 1920x1080x24+32 -nolisten tcp -noreset -auth $XAUTHORITY -dpi 96x96",
    "--resize-display=yes",
    "--mdns=no",
    "--pulseaudio=no",
    "--speaker=off",
    "--microphone=off",
    "--webcam=no",
    "--printing=no",
    "--notifications=no",
    "--file-transfer=no",
    "--open-files=no",
    "--open-url=no",
    "--systemd-run=no",
    "--dbus-launch=",
    "--start-via-proxy=no",
    "--exit-with-children=no",
    // Low CPU: no video encoder pipeline (no GPU here), plain picture encodings.
    "--video-encoders=none",
    "--encoding=jpeg",
    "--quality=70",
    "--speed=80",
  ];
}

export function xpraStopArgs(display: string): string[] {
  return ["stop", display, "--socket-dirs=" + DISPLAY_PATHS.sockets];
}

/** Listening abstract unix sockets from /proc/net/unix ("@name" paths), with their inodes. */
export function parseAbstractListeners(text: string): { path: string; inode: string }[] {
  const out: { path: string; inode: string }[] = [];
  for (const line of text.split("\n").slice(1)) {
    // Num RefCount Protocol Flags Type St Inode Path; Flags 00010000 = listening (__SO_ACCEPTCON)
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || !cols[7].startsWith("@") || (Number.parseInt(cols[3], 16) & 0x10000) === 0) continue;
    out.push({ path: cols.slice(7).join(" "), inode: cols[6] });
  }
  return out;
}

/** Abstract socket name of X display ":N". */
export function abstractXSocket(display: string): string {
  return "@/tmp/.X11-unix/X" + display.replace(/^:/, "").split(".")[0];
}

/**
 * Problems with this session's abstract sockets after (or before) starting the display: the X name held by another
 * process (hijack), or an abstract socket of ours other than the X name (xpra created one it should not have).
 */
export function abstractSocketProblems(listeners: { path: string; inode: string }[], ownInodes: ReadonlySet<string>, display: string, expectXOwned: boolean): string[] {
  const xName = abstractXSocket(display);
  const problems: string[] = [];
  const x = listeners.filter((l) => l.path === xName);
  if (x.some((l) => !ownInodes.has(l.inode))) problems.push("another process on this server holds the abstract X socket " + xName + " (possible hijack attempt)");
  else if (expectXOwned && !x.length) problems.push("the X server is not holding its abstract socket " + xName);
  for (const l of listeners) if (l.path !== xName && ownInodes.has(l.inode) && /xpra/i.test(l.path)) problems.push("xpra created the abstract socket " + l.path);
  return problems;
}

/** Shell lines for `eval "$(floq display env)"`; values are fixed formats (":N", a /tmp path), quoted anyway. */
export function displayEnvExports(display: string): string {
  return "export DISPLAY='" + display + "' XAUTHORITY='" + DISPLAY_PATHS.xauthority + "'";
}
