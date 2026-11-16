/**
 * Mirrors Google Antigravity (agy) swarm workers and core subagents as virtual agents on the Floq canvas.
 * agy runs them all inside its own process, so the only evidence is files under ~/.gemini/antigravity-cli:
 *   brain/<conv>/.system_generated/swarm/{members.json,board.jsonl}   (swarm roster + board, authoritative for swarms)
 *   brain/<conv>/.system_generated/logs/transcript.jsonl              (per conversation step log)
 *   conversation_summaries.db                                         (SQLite summary cache: parent links, killed, step count)
 * Everything read is untrusted: reads are confined to the user's home (realpath, no symlinks), size capped, torn lines
 * skipped, unknown fields ignored, and scoped strictly to the host session's root conversation tree.
 * The parsers are pure; AgySwarmMirror does the polling. The format is agy-internal (1.5.x preview): parse defensively.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import type { VirtualAgent, VirtualAgentStatus, VirtualAgentStep } from "./types.js";

export const POLL_MS = 1500;
export const MAX_MEMBERS_BYTES = 1 << 20;
export const MAX_BOARD_TAIL_BYTES = 256 * 1024;
export const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export const MAX_DB_ROWS = 2000;
export const MAX_AGENTS_PER_HOST = 64;
const TREE_HARD_CAP = 256;
export const MAX_DB_BYTES = 64 * 1024 * 1024;
export const DB_TIMEOUT_MS = 3000;
export const DB_MIN_INTERVAL_MS = 5000;
export const MAX_DB_STDOUT_BYTES = 4 * 1024 * 1024;
export const FALLBACK_READ_BYTES = 2 * 1024 * 1024;
const FALLBACK_BUDGET = 10;
const FALLBACK_WINDOW_MS = 10_000;
export const ERROR_AFTER_MS = 60_000;
export const STUCK_AFTER_MS = 10 * 60_000;
const MAX_ACTIVITY = 200;
const MAX_STEP_TEXT = 4000;
const MAX_SUMMARY = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isConversationId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);

/* ----------------------------------------------------------------------------------------------- pure parsers */

export interface SwarmMember { name: string; conversationId: string; model: string | null; role: string; killed: boolean; lastReadSeq: number }
export interface SwarmRoster { title: string | null; members: SwarmMember[] }

/** members.json: {"title","members":{name:{conversation_id,model,role,killed,last_read_seq,...}}}. Bad entries are dropped. */
export function parseMembers(text: string): SwarmRoster | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isObj(parsed) || !isObj(parsed.members)) return null;
  const members: SwarmMember[] = [];
  for (const [name, raw] of Object.entries(parsed.members)) {
    if (!isObj(raw) || !isConversationId(raw.conversation_id)) continue;
    const cleanName = str(name, 80);
    if (!cleanName) continue;
    members.push({
      name: cleanName,
      conversationId: raw.conversation_id.toLowerCase(),
      model: str(raw.model, 100),
      role: str(raw.role, 40) ?? "worker",
      killed: raw.killed === true,
      lastReadSeq: Math.max(0, num(raw.last_read_seq) ?? 0),
    });
  }
  return { title: str(parsed.title, 200), members };
}

export interface BoardPost { seq: number; agent: string; text: string; time: string | null }

/** board.jsonl: one JSON per line. A torn last line (or garbage) is skipped. */
export function parseBoard(text: string): BoardPost[] {
  const posts: BoardPost[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (!isObj(parsed)) continue;
    const seq = num(parsed.seq);
    if (seq === null) continue;
    posts.push({ seq, agent: str(parsed.agent, 80) ?? "", text: str(parsed.text, 2000) ?? "", time: str(parsed.time, 40) });
  }
  return posts;
}

export const boardHead = (posts: BoardPost[]): number => posts.reduce((max, p) => (p.seq > max ? p.seq : max), 0);

/** agy tool args are an object or a JSON-quoted string. */
function toolArgs(args: unknown): Obj {
  if (isObj(args)) return args;
  if (typeof args === "string") {
    try { const v: unknown = JSON.parse(args); if (isObj(v)) return v; } catch { /* plain string */ }
  }
  return {};
}

export interface RawStep extends VirtualAgentStep { thinking: string | null; tools: { name: string; summary: string | null }[] }

/** transcript.jsonl: one step per line (type, status, step_index, created_at, thinking, tool_calls, error). Torn lines are skipped. */
export function parseTranscript(text: string): RawStep[] {
  const steps: RawStep[] = [];
  let fallback = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (!isObj(parsed)) continue;
    const index = num(parsed.step_index) ?? fallback;
    fallback = index + 1;
    const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    const tools: { name: string; summary: string | null }[] = [];
    for (const call of calls.slice(0, 20)) {
      if (!isObj(call)) continue;
      const name = str(call.name, 80);
      if (!name) continue;
      tools.push({ name, summary: str(toolArgs(call.args).toolSummary, MAX_SUMMARY) });
    }
    const err = parsed.error;
    const error = typeof err === "string" ? str(err, 1000) : isObj(err) ? str(err.message ?? err.text ?? JSON.stringify(err), 1000) : null;
    const body = str(parsed.content, MAX_STEP_TEXT) ?? str(parsed.text, MAX_STEP_TEXT) ?? str(parsed.response, MAX_STEP_TEXT);
    const thinking = str(parsed.thinking, MAX_STEP_TEXT);
    steps.push({
      index,
      type: str(parsed.type, 40) ?? "UNKNOWN",
      status: str(parsed.status, 20),
      createdAt: normalizeTime(parsed.created_at),
      text: body ?? thinking,
      thinking,
      tools,
      error,
    });
  }
  return steps;
}

function normalizeTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string" || !value) return null;
  // "YYYY-MM-DD HH:MM:SS" is the LS's local time; treat as UTC (only used for ordering and coarse ageing).
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(" ", "T") + "Z" : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const toStep = ({ index, type, status, createdAt, text, tools, error }: RawStep): VirtualAgentStep => ({ index, type, status, createdAt, text, tools, error });
export { toStep as publicStep };

/** Newest tool summary, else the newest bold heading in thinking. */
export function deriveActivity(steps: RawStep[]): string | null {
  for (let i = steps.length - 1; i >= 0 && i >= steps.length - 12; i--) {
    const s = steps[i]!;
    for (let j = s.tools.length - 1; j >= 0; j--) {
      const t = s.tools[j]!;
      const label = t.summary ?? t.name;
      if (label) return label.slice(0, MAX_ACTIVITY);
    }
  }
  for (let i = steps.length - 1; i >= 0 && i >= steps.length - 12; i--) {
    const thinking = steps[i]!.thinking;
    if (!thinking) continue;
    const all = [...thinking.matchAll(/\*\*([^*\n]{2,160})\*\*/g)];
    if (all.length) return all[all.length - 1]![1]!.trim().slice(0, MAX_ACTIVITY);
  }
  return null;
}

const QUOTA = /RESOURCE_EXHAUSTED|\b429\b/;
export interface StatusInput { killed: boolean; nowMs: number; /** mtime of the transcript: ageing uses it, since step timestamps are the LS's local time without a zone. */ lastWriteMs?: number | null }

/**
 * Status rules copied from agy's swarm_board sidecar (turnEnded/statusOf/stepFailure):
 * killed > error (newest step ERROR_MESSAGE, or a failed tool step that stayed last for 60 s) > waiting (newest step is a
 * PLANNER_RESPONSE with no tool calls, or a swarm_wait batch whose result is DONE) > working.
 * "Stuck" (no transcript change for 10 min) stays "working" (the enum has no such state) and is flagged in the activity.
 */
export function deriveStatus(steps: RawStep[], input: StatusInput): { status: VirtualAgentStatus; stalled: boolean; quota: boolean } {
  if (input.killed) return { status: "killed", stalled: false, quota: false };
  const last = steps[steps.length - 1];
  if (!last) return { status: "working", stalled: false, quota: false };
  const lastMs = input.lastWriteMs ?? (last.createdAt ? Date.parse(last.createdAt) : NaN);
  const age = typeof lastMs === "number" && Number.isFinite(lastMs) ? input.nowMs - lastMs : 0;
  const failText = last.error ?? last.text ?? "";
  if (last.type === "ERROR_MESSAGE") return { status: "error", stalled: false, quota: QUOTA.test(failText) };
  if (last.type !== "PLANNER_RESPONSE" && last.status === "ERROR" && age >= ERROR_AFTER_MS) return { status: "error", stalled: false, quota: QUOTA.test(failText) };
  let waiting = false;
  if (last.type === "PLANNER_RESPONSE" && last.tools.length === 0 && last.status !== "RUNNING") waiting = true;
  else {
    const batch = last.tools.length ? last : steps[steps.length - 2];
    if (batch && batch.tools.some((t) => t.name === "swarm_wait") && last.status === "DONE") waiting = true;
  }
  if (waiting) return { status: "waiting", stalled: false, quota: false };
  return { status: "working", stalled: age > STUCK_AFTER_MS, quota: false };
}

export interface DbRow { conversationId: string; agentName: string | null; parentId: string | null; depth: number; status: string | null; stepCount: number; lastModified: string | null; killed: boolean; notFullyIdle: boolean; title: string | null }

/** Rows as returned by SELECT on conversation_summaries; unknown shapes are dropped. */
export function parseDbRows(rows: unknown[]): DbRow[] {
  const out: DbRow[] = [];
  for (const raw of rows.slice(0, MAX_DB_ROWS)) {
    if (!isObj(raw) || !isConversationId(raw.conversation_id)) continue;
    const parent = isConversationId(raw.parent_conversation_id) ? raw.parent_conversation_id.toLowerCase() : null;
    out.push({
      conversationId: raw.conversation_id.toLowerCase(),
      agentName: str(raw.agent_name, 80),
      parentId: parent,
      depth: Math.max(0, num(raw.nesting_depth) ?? 0),
      status: str(raw.status, 40),
      stepCount: Math.max(0, num(raw.step_count) ?? 0),
      lastModified: normalizeTime(raw.last_modified_time),
      killed: num(raw.killed) === 1 || raw.killed === true,
      notFullyIdle: num(raw.not_fully_idle) === 1 || raw.not_fully_idle === true,
      title: str(raw.title, 200),
    });
  }
  return out;
}

/** Everything the poller read for one conversation, so assembly stays pure. */
export interface ConvInfo { steps: RawStep[]; lastWriteMs: number | null }
export interface BuildInput {
  hostSessionId: string;
  projectId: string;
  rootConv: string;
  rosters: Map<string, SwarmRoster>;         // coordinator conv -> roster
  boardHeads: Map<string, number>;           // coordinator conv -> board head seq
  db: DbRow[];
  convs: Map<string, ConvInfo>;
  nowMs: number;
  /** Stable subset to show (the 64-cap, by first-seen). */
  only?: Set<string>;
}

/** Conversations that belong to the root's tree: roster members and DB children, followed transitively. Never anything else. */
export function collectTree(rootConv: string, rosters: Map<string, SwarmRoster>, db: DbRow[]): { order: string[]; parent: Map<string, string>; member: Map<string, { roster: SwarmRoster; m: SwarmMember; coordinator: string }>; rows: Map<string, DbRow> } {
  const rows = new Map(db.map((r) => [r.conversationId, r]));
  const parent = new Map<string, string>();
  const member = new Map<string, { roster: SwarmRoster; m: SwarmMember; coordinator: string }>();
  const order: string[] = [];
  const queue = [rootConv];
  const seen = new Set([rootConv]);
  while (queue.length && order.length < TREE_HARD_CAP) {
    const cur = queue.shift()!;
    const kids: { id: string; hint?: { roster: SwarmRoster; m: SwarmMember } }[] = [];
    const roster = rosters.get(cur);
    if (roster) for (const m of roster.members) if (m.conversationId !== cur) kids.push({ id: m.conversationId, hint: { roster, m } });
    for (const r of db) if (r.parentId === cur) kids.push({ id: r.conversationId });
    for (const k of kids) {
      if (seen.has(k.id)) { if (k.hint && !member.has(k.id)) member.set(k.id, { ...k.hint, coordinator: cur }); continue; }
      seen.add(k.id);
      parent.set(k.id, cur);
      if (k.hint) member.set(k.id, { ...k.hint, coordinator: cur });
      order.push(k.id);
      queue.push(k.id);
      if (order.length >= TREE_HARD_CAP) break;
    }
  }
  return { order, parent, member, rows };
}

export function buildAgents(input: BuildInput): VirtualAgent[] {
  const { order, parent, member, rows } = collectTree(input.rootConv, input.rosters, input.db);
  const agents: VirtualAgent[] = [];
  const raw = new Map<string, VirtualAgentStatus>();
  for (const conv of order) {
    if (input.only && !input.only.has(conv)) continue;
    const mem = member.get(conv);
    const row = rows.get(conv);
    const info = input.convs.get(conv);
    const steps = info?.steps ?? [];
    const killed = mem?.m.killed === true || row?.killed === true;
    let { status, stalled } = deriveStatus(steps, { killed, nowMs: input.nowMs, lastWriteMs: info?.lastWriteMs ?? null });
    if (!steps.length && !killed && row) {
      // No transcript yet: fall back on the summary cache.
      status = row.notFullyIdle ? "working" : /done|complete|idle|finish/i.test(row.status ?? "") ? "done" : "working";
    } else if (!mem && row && status === "waiting" && !row.notFullyIdle && /done|complete|finish|idle/i.test(row.status ?? "")) {
      status = "done"; // a core subagent that finished its task
    }
    raw.set(conv, status);
    const parentConv = parent.get(conv)!;
    const coordinator = mem?.coordinator ?? null;
    const head = coordinator ? input.boardHeads.get(coordinator) ?? 0 : 0;
    const lastStep = steps[steps.length - 1];
    const lastAt = lastStep?.createdAt ?? row?.lastModified ?? (info?.lastWriteMs ? new Date(info.lastWriteMs).toISOString() : null);
    let activity = deriveActivity(steps);
    if (stalled) activity = ("No progress for 10+ min" + (activity ? ": " + activity : "")).slice(0, MAX_ACTIVITY);
    const lastIndex = lastStep ? lastStep.index + 1 : 0;
    agents.push({
      id: "agy:" + conv,
      hostSessionId: input.hostSessionId,
      projectId: input.projectId,
      parentId: parentConv === input.rootConv ? input.hostSessionId : "agy:" + parentConv,
      name: mem?.m.name ?? row?.agentName ?? row?.title ?? conv.slice(0, 8),
      role: mem ? mem.m.role : "subagent",
      kind: mem ? "swarm" : "subagent",
      model: mem?.m.model ?? null,
      status,
      activity,
      steps: Math.max(lastIndex, row?.stepCount ?? 0),
      lastAt,
      swarmTitle: mem?.roster.title ?? null,
      unread: mem ? Math.max(0, head - mem.m.lastReadSeq) : 0,
    });
  }
  // A swarm is finished when its coordinator's turn ended and every live member is waiting: then its members are "done".
  const byConv = new Map(agents.map((a) => [a.id.slice(4), a]));
  const coordinators = new Set<string>();
  for (const conv of order) { const m = member.get(conv); if (m && byConv.has(conv)) coordinators.add(m.coordinator); }
  for (const coord of coordinators) {
    const coordStatus = coord === input.rootConv ? deriveStatus(input.convs.get(coord)?.steps ?? [], { killed: false, nowMs: input.nowMs, lastWriteMs: input.convs.get(coord)?.lastWriteMs ?? null }).status : raw.get(coord);
    const hasSteps = coord !== input.rootConv || (input.convs.get(coord)?.steps.length ?? 0) > 0;
    if (!hasSteps || coordStatus !== "waiting" && coordStatus !== "done") continue;
    const mine = order.filter((c) => member.get(c)?.coordinator === coord && byConv.has(c) && byConv.get(c)!.status !== "killed");
    if (mine.length && mine.every((c) => byConv.get(c)!.status === "waiting" || byConv.get(c)!.status === "done")) for (const c of mine) byConv.get(c)!.status = "done";
  }
  return agents;
}

/** Host went away: keep the last snapshot but nothing is running any more. */
export const stoppedSnapshot = (agents: VirtualAgent[]): VirtualAgent[] => agents.map((a) => (a.status === "killed" ? a : { ...a, status: "stopped" as const }));

/* ------------------------------------------------------------------------------------- confined file reads */

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Resolve `path` under `trustedRoot` without following any symlink; null when it is outside, linked or not a regular file. A symlinked root itself is fine (it is realpath'ed first). */
export function confinedFile(path: string, trustedRoot: string): { path: string; size: number; mtimeMs: number; dev: number; ino: number } | null {
  try {
    const root = realpathSync(trustedRoot);
    const rawRoot = resolve(trustedRoot);
    const given = resolve(path);
    const absolute = within(rawRoot, given) ? join(root, relative(rawRoot, given)) : given;
    if (!within(root, absolute)) return null;
    let current = root;
    for (const part of relative(root, absolute).split(sep).filter(Boolean).slice(0, -1)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(absolute) !== absolute) return null;
    return { path: absolute, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  } catch { return null; }
}

/** Read at most the last `maxBytes` of a confined file. A cut start drops the partial first line. */
export function readConfinedTail(path: string, trustedRoot: string, maxBytes: number): { text: string; size: number; truncated: boolean } | null {
  const info = confinedFile(path, trustedRoot);
  if (!info) return null;
  let fd = -1;
  try {
    fd = openSync(info.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== info.dev || st.ino !== info.ino) return null;
    const length = Math.min(st.size, maxBytes);
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, st.size - length + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString("utf8");
    const truncated = st.size > maxBytes;
    if (truncated) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; }
    return { text, size: st.size, truncated };
  } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
}

/**
 * The summaries query runs in a killable CHILD PROCESS (the database is agent-writable: a crafted table can make SQLite burn
 * CPU and native memory that no in-process limit reclaims). In the runtime the child is spawned inside the user's own sandbox
 * (MirrorHost.spawnDb); it also gets CPU and address-space ulimits, a wall timeout with SIGKILL and a bounded stdout.
 * The script refuses anything but a real table.
 */
const DB_SCRIPT = `
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    db.exec("PRAGMA busy_timeout = 100");
    const kind = db.prepare("SELECT type FROM sqlite_master WHERE name = 'conversation_summaries'").all();
    const rows = kind.length === 1 && kind[0].type === "table"
      ? db.prepare("SELECT conversation_id, agent_name, parent_conversation_id, nesting_depth, status, step_count, last_modified_time, killed, not_fully_idle, title FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT " + ${MAX_DB_ROWS}).all()
      : [];
    process.stdout.write(JSON.stringify(rows));
  } finally { try { db.close(); } catch {} }
} catch (e) { if (/memory|too big|toobig|nomem/i.test(String(e && e.message))) process.exitCode = 3; else process.stdout.write("[]"); }
`;

const DB_SHELL = 'ulimit -t 5; ulimit -v 1048576; exec "$0" -e "$@"';
/** argv for `sh -c`: CPU and address-space ulimits, then `<node> -e script path`. */
export const dbReaderCommand = (nodeBin: string, dbPath: string): { file: string; args: string[] } => ({ file: "sh", args: ["-c", DB_SHELL, nodeBin, DB_SCRIPT, dbPath] });

export type DbSpawn = (command: { file: string; args: string[] }) => ChildProcess;
const defaultDbSpawn: DbSpawn = ({ file, args }) => spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } });

/** `failed`: the child was killed (timeout, output cap) or died on a limit: stop reading the db for that host. */
export interface DbReadResult { rows: unknown[]; failed: boolean }
export type DbReader = (dbPath: string, host: MirrorHost) => Promise<DbReadResult>;

const liveReaders = new Set<ChildProcess>();
/** Kill every summaries reader still alive (runtime shutdown). */
export function killDbReaders(): void { for (const c of liveReaders) try { c.kill("SIGKILL"); } catch { /* gone */ } }

export interface ReadDbOptions { spawn?: DbSpawn; /** Interpreter name as the child sees it ("node" inside a sandbox; default: the runtime's own). */ nodeBin?: string; timeoutMs?: number }
export function readSummariesDb(dbPath: string, options: ReadDbOptions = {}): Promise<DbReadResult> {
  const spawnDb = options.spawn ?? defaultDbSpawn;
  const timeoutMs = options.timeoutMs ?? DB_TIMEOUT_MS;
  const nodeBin = options.nodeBin ?? (options.spawn ? "node" : process.execPath);
  return new Promise((done) => {
    let child: ChildProcess;
    try { child = spawnDb(dbReaderCommand(nodeBin, dbPath)); } catch { return done({ rows: [], failed: true }); }
    liveReaders.add(child);
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    // stderr is never read: drain it so a full pipe cannot stall the reader.
    child.stderr?.on("data", () => undefined);
    child.stderr?.on("error", () => undefined);
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    let out = "";
    let bytes = 0;
    let failed = false;
    let finished = false;
    const kill = () => { failed = true; try { child.kill("SIGKILL"); } catch { /* gone */ } };
    const finish = (rows: unknown[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(hard);
      liveReaders.delete(child);
      done({ rows, failed });
    };
    const timer = setTimeout(kill, timeoutMs);
    // If the kill is not reported by 'close' in time, stop waiting (the reader is flagged failed and never restarted).
    const hard = setTimeout(() => { failed = true; finish([]); }, timeoutMs + 2000);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_DB_STDOUT_BYTES) { kill(); out = ""; return; }
      if (!failed) out += chunk.toString("utf8");
    });
    child.on("error", () => { failed = true; finish([]); });
    child.on("close", (code, signal) => {
      if (signal || code !== 0) failed = true;
      let rows: unknown[] = [];
      if (!failed) try { const parsed: unknown = JSON.parse(out); if (Array.isArray(parsed)) rows = parsed; } catch { failed = true; }
      finish(rows);
    });
  });
}

/* ------------------------------------------------------------------------------------------ the watcher */

export interface MirrorHost {
  sessionId: string;
  userId: string;
  projectId: string;
  /** Host path of the user's home (confinement root). */
  home: string;
  /** Host path of <home>/.gemini/antigravity-cli. */
  appData: string;
  /** The agy session's root conversation id; null until captured. */
  rootConv: string | null;
  /** Spawn the summaries reader inside the user's sandbox (as the user's uid). Omitted: a plain, limited child of the runtime (tests/dev). */
  spawnDb?: DbSpawn;
  /** The database path as the sandboxed child sees it (the home is mounted elsewhere than on the host). */
  sandboxDbPath?: string;
}

interface HostState {
  host: MirrorHost;
  running: boolean;
  agents: VirtualAgent[];
  json: string;
  fp: Map<string, string>;
  cache: Map<string, unknown>;
  /** Async summaries read: last good rows, the fingerprint they were read for, and the read in flight. */
  dbRows: DbRow[];
  dbFp: string | null;
  dbInflight: Promise<void> | null;
  /** Set after a kill/limit: no further reads of the db for this host (the swarm files still work) until the host restarts. */
  dbDisabled: boolean;
  /** Start time of the last summaries read (min interval between reads; the files keep the fast poll). */
  dbLastAt: number;
  /** First-seen order of conversations, so the 64-cap never rotates. */
  seen: Map<string, number>;
  seenCounter: number;
}
const newState = (host: MirrorHost, prev?: HostState): HostState => ({ host, running: true, agents: prev?.agents ?? [], json: prev?.json ?? "[]", fp: new Map(), cache: new Map(), dbRows: [], dbFp: null, dbInflight: null, dbDisabled: false, dbLastAt: 0, seen: new Map(), seenCounter: 0 });

export interface MirrorOptions { pollMs?: number; dbMinIntervalMs?: number; now?: () => number; readDb?: DbReader }
export type MirrorFrame = { type: "virtual-agents"; projectId: string; hostSessionId: string; agents: VirtualAgent[] };

export class AgySwarmMirror {
  private readonly hosts = new Map<string, HostState>();
  private readonly subs = new Set<{ userId: string; fn: (frame: MirrorFrame) => void }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly readDb: DbReader;
  private readonly dbMinIntervalMs: number;
  private readonly fallbackHits = new Map<string, number[]>();

  constructor(options: MirrorOptions = {}) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.dbMinIntervalMs = options.dbMinIntervalMs ?? DB_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.readDb = options.readDb ?? ((path, host) => readSummariesDb(host.sandboxDbPath ?? path, { spawn: host.spawnDb }));
  }

  subscribe(userId: string, fn: (frame: MirrorFrame) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  /** Start (or restart after a resume) mirroring for a live agy session. Keeps the old snapshot until the first poll replaces it. */
  track(host: MirrorHost): void {
    const rootConv = host.rootConv && isConversationId(host.rootConv) ? host.rootConv.toLowerCase() : null;
    const prev = this.hosts.get(host.sessionId);
    this.hosts.set(host.sessionId, newState({ ...host, rootConv }, prev));
    this.ensureTimer();
    this.pollHost(this.hosts.get(host.sessionId)!);
  }

  /** The root conversation id was captured/changed. */
  setRoot(sessionId: string, conv: string): void {
    const state = this.hosts.get(sessionId);
    if (!state || !isConversationId(conv)) return;
    const next = conv.toLowerCase();
    if (state.host.rootConv === next) return;
    state.host.rootConv = next;
    state.fp.clear();
    state.cache.clear();
    state.dbFp = null;
    state.dbLastAt = 0;
    state.seen.clear();
    this.pollHost(state);
  }

  /** Host slept or exited: stop polling, keep the snapshot with every live agent "stopped". */
  stop(sessionId: string): void {
    const state = this.hosts.get(sessionId);
    if (!state) return;
    state.running = false;
    state.fp.clear();
    state.cache.clear();
    this.publish(state, stoppedSnapshot(state.agents));
    this.maybeStopTimer();
  }

  /** Host removed: drop the snapshot and tell subscribers it is empty. */
  forget(sessionId: string): void {
    const state = this.hosts.get(sessionId);
    if (!state) return;
    this.hosts.delete(sessionId);
    this.publish(state, []);
    this.maybeStopTimer();
  }

  /** Session ids currently held (running or kept as stopped snapshots). */
  hostIds(): string[] { return [...this.hosts.keys()]; }

  /** Current snapshot frame of every host of a user: pushed right after a /v1/events subscribe. */
  frames(userId: string): MirrorFrame[] {
    const out: MirrorFrame[] = [];
    for (const s of this.hosts.values()) if (s.host.userId === userId && s.agents.length) out.push({ type: "virtual-agents", projectId: s.host.projectId, hostSessionId: s.host.sessionId, agents: s.agents });
    return out;
  }

  /** Resolves when no summaries read is in flight (tests). */
  async idle(): Promise<void> { for (const s of this.hosts.values()) await s.dbInflight; }

  /** All agents of a user's project (seed for the client). */
  snapshot(userId: string, projectId: string): VirtualAgent[] {
    const out: VirtualAgent[] = [];
    for (const s of this.hosts.values()) if (s.host.userId === userId && s.host.projectId === projectId) out.push(...s.agents);
    return out;
  }

  /**
   * Parsed transcript steps with index >= since, paged. Served from the poller's cached tail when `since` falls inside it;
   * older pages re-read the file (smaller cap, per-user budget). Null when the agent is unknown or not the user's; "rate" when over budget.
   */
  transcript(userId: string, vid: string, since = 0, limit = 50): { steps: VirtualAgentStep[]; next: number | null } | null | "rate" {
    const found = this.find(userId, vid);
    if (!found) return null;
    const conv = vid.slice(4).toLowerCase();
    const cap = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    const from = Math.max(0, Math.floor(since) || 0);
    const page = (all: RawStep[]) => {
      const rest = all.filter((st) => st.index >= from);
      const slice = rest.slice(0, cap);
      return { steps: slice.map(toStep), next: rest.length > cap ? slice[slice.length - 1]!.index + 1 : null };
    };
    const tail = found.state.cache.get("t:" + conv) as RawStep[] | undefined;
    if (tail && tail.length && (from >= tail[0]!.index || tail[0]!.index === 0)) return page(tail);
    if (!this.allowFallback(userId)) return "rate";
    const file = readConfinedTail(join(found.state.host.appData, "brain", conv, ".system_generated", "logs", "transcript.jsonl"), found.state.host.home, FALLBACK_READ_BYTES);
    return page(file ? parseTranscript(file.text) : []);
  }

  private allowFallback(userId: string): boolean {
    const now = this.now();
    const hits = (this.fallbackHits.get(userId) ?? []).filter((t) => now - t < FALLBACK_WINDOW_MS);
    if (hits.length >= FALLBACK_BUDGET) { this.fallbackHits.set(userId, hits); return false; }
    hits.push(now);
    this.fallbackHits.set(userId, hits);
    return true;
  }

  find(userId: string, vid: string): { state: HostState; agent: VirtualAgent } | null {
    if (typeof vid !== "string" || !vid.startsWith("agy:") || !isConversationId(vid.slice(4))) return null;
    const id = "agy:" + vid.slice(4).toLowerCase();
    for (const state of this.hosts.values()) {
      if (state.host.userId !== userId) continue;
      const agent = state.agents.find((a) => a.id === id);
      if (agent) return { state, agent };
    }
    return null;
  }

  dispose(): void {
    killDbReaders();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hosts.clear();
    this.subs.clear();
  }

  /** One synchronous poll of every running host (the timer calls this; exposed for tests). */
  pollAll(): void {
    for (const state of this.hosts.values()) if (state.running) this.pollHost(state);
  }

  private ensureTimer(): void {
    if (this.timer || this.pollMs <= 0) return;
    this.timer = setInterval(() => this.pollAll(), this.pollMs);
    this.timer.unref();
  }

  private maybeStopTimer(): void {
    if (!this.timer) return;
    for (const s of this.hosts.values()) if (s.running) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private publish(state: HostState, agents: VirtualAgent[]): void {
    const json = JSON.stringify(agents);
    if (json === state.json) return;
    state.json = json;
    state.agents = agents;
    const frame: MirrorFrame = { type: "virtual-agents", projectId: state.host.projectId, hostSessionId: state.host.sessionId, agents };
    for (const sub of this.subs) {
      if (sub.userId !== state.host.userId) continue;
      try { sub.fn(frame); } catch { /* a dead socket must not block others */ }
    }
  }

  /** Re-read only what changed (stat fingerprint), then rebuild: time-based status rules need the rebuild every tick. */
  private pollHost(state: HostState): void {
    try {
      const { host } = state;
      const root = host.rootConv;
      if (!root) return;
      const brain = join(host.appData, "brain");
      const touched = new Set<string>();
      const cached = <T>(key: string, fingerprint: string, load: () => T): T => {
        touched.add(key);
        if (state.fp.get(key) === fingerprint && state.cache.has(key)) return state.cache.get(key) as T;
        const value = load();
        state.fp.set(key, fingerprint);
        state.cache.set(key, value);
        return value;
      };
      const stamp = (path: string): string => { const f = confinedFile(path, host.home); return f ? f.mtimeMs + ":" + f.size : "-"; };

      const dbFile = confinedFile(join(host.appData, "conversation_summaries.db"), host.home);
      const walFile = dbFile ? confinedFile(dbFile.path + "-wal", host.home) : null;
      const dbFp = dbFile ? dbFile.mtimeMs + ":" + dbFile.size + "|" + (walFile ? walFile.mtimeMs + ":" + walFile.size : "-") : "-";
      if (!dbFile || dbFile.size > MAX_DB_BYTES || (walFile && walFile.size > MAX_DB_BYTES)) { state.dbRows = []; state.dbFp = dbFp; }
      else if (state.dbFp !== dbFp && !state.dbInflight && !state.dbDisabled && this.now() - state.dbLastAt >= this.dbMinIntervalMs) {
        state.dbFp = dbFp;
        state.dbLastAt = this.now();
        // dbInflight is cleared only when the child has really exited ('close'), so there is never a second reader alive for a host.
        state.dbInflight = this.readDb(dbFile.path, host).then((result) => {
          if (result.failed) { state.dbDisabled = true; state.dbRows = []; } else state.dbRows = parseDbRows(result.rows);
        }).catch(() => { state.dbDisabled = true; }).then(() => { state.dbInflight = null; if (this.hosts.get(host.sessionId) === state && state.running) this.pollHost(state); });
      }
      const db = state.dbRows;

      const rosters = new Map<string, SwarmRoster>();
      const boardHeads = new Map<string, number>();
      let tree = collectTree(root, rosters, db);
      // Rosters can introduce members that introduce further rosters: iterate until the tree stops growing.
      const loaded = new Set<string>();
      for (let pass = 0; pass < 6; pass++) {
        let grew = false;
        for (const conv of [root, ...tree.order]) {
          if (loaded.has(conv)) continue;
          loaded.add(conv);
          const dir = join(brain, conv, ".system_generated", "swarm");
          const membersPath = join(dir, "members.json");
          const roster = cached("m:" + conv, stamp(membersPath), () => {
            const file = readConfinedTail(membersPath, host.home, MAX_MEMBERS_BYTES);
            return file && !file.truncated ? parseMembers(file.text) : null;
          });
          if (!roster) continue;
          rosters.set(conv, roster);
          const boardPath = join(dir, "board.jsonl");
          boardHeads.set(conv, cached("b:" + conv, stamp(boardPath), () => {
            const file = readConfinedTail(boardPath, host.home, MAX_BOARD_TAIL_BYTES);
            return file ? boardHead(parseBoard(file.text)) : 0;
          }));
          grew = true;
        }
        if (!grew) break;
        tree = collectTree(root, rosters, db);
      }

      const convs = new Map<string, ConvInfo>();
      const nowMs = this.now();
      // Stable window: first-seen order decides which 64 conversations are shown, so nodes never rotate in and out.
      for (const conv of tree.order) if (!state.seen.has(conv)) state.seen.set(conv, state.seenCounter++);
      for (const conv of [...state.seen.keys()]) if (!tree.order.includes(conv)) state.seen.delete(conv);
      const shown = [...tree.order].sort((a, b) => state.seen.get(a)! - state.seen.get(b)!).slice(0, MAX_AGENTS_PER_HOST);
      const only = new Set(shown);
      const readTranscript = (conv: string): void => {
        const tpath = join(brain, conv, ".system_generated", "logs", "transcript.jsonl");
        const steps = cached("t:" + conv, stamp(tpath), () => {
          const file = readConfinedTail(tpath, host.home, MAX_TRANSCRIPT_TAIL_BYTES);
          return file ? parseTranscript(file.text) : [];
        });
        convs.set(conv, { steps, lastWriteMs: confinedFile(tpath, host.home)?.mtimeMs ?? null });
      };
      readTranscript(root);
      for (const conv of shown) readTranscript(conv);
      for (const key of [...state.cache.keys()]) if (!touched.has(key)) { state.cache.delete(key); state.fp.delete(key); }

      this.publish(state, buildAgents({ hostSessionId: host.sessionId, projectId: host.projectId, rootConv: root, rosters, boardHeads, db, convs, nowMs, only }));
    } catch { /* keep the last snapshot; the format is agy-internal and may change under us */ }
  }
}
