// Daemon side of the user-IP egress (docs/design/browser-user-egress.md §2.1, §3.1, §2.3).
//   Chromium --socks5://127.0.0.1:<eph>--> SocksListener (peer = uid + Chromium process tree) --> EgressMux --fd 3--> runtime relay.
// Fail closed everywhere: link down, bad peer, bad request => no connection. Nothing here ever opens a socket to a target.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  HEADER, INIT_CREDIT, MAX_DATA, MAX_STREAMS, PROTOCOL_VERSION, REP, RST_REASON, RecordStream, T,
  decodeFrame, encodeFrame, encodeHello, encodeOpen, lengthPrefixed, type Frame, type Target,
} from "./floq-egress-codec.mjs";

const OPEN_TIMEOUT_MS = 15_000;
const IDLE_MS = 15 * 60_000;
const CREDIT_BATCH = 32 * 1024;
/** New SOCKS connections handled per second; above it they are dropped before any /proc read. */
export const ACCEPT_BUDGET_PER_SEC = 200;

// ---------------------------------------------------------------- /proc peer lookup

export interface NetRow { local: string; remote: string; uid: number; inode: string }

/** /proc/net/tcp (IPv4) rows as "a.b.c.d:port" strings. Hex addresses are little-endian words. */
export function parseProcNetTcp4(text: string): NetRow[] {
  const rows: NetRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = hexAddr4(f[1]), remote = hexAddr4(f[2]);
    if (!local || !remote) continue;
    rows.push({ local, remote, uid: Number(f[7]), inode: f[9] });
  }
  return rows;
}
function hexAddr4(s: string): string | null {
  const m = /^([0-9A-Fa-f]{8}):([0-9A-Fa-f]{4})$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${n & 255}.${(n >>> 8) & 255}.${(n >>> 16) & 255}.${n >>> 24}:${parseInt(m[2], 16)}`;
}

/** Pids of `root` and all its descendants (by ppid in /proc/<pid>/stat). */
export function processTree(root: number, procRoot = "/proc"): number[] {
  const kids = new Map<number, number[]>();
  let names: string[] = [];
  try { names = readdirSync(procRoot); } catch { return [root]; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = readFileSync(`${procRoot}/${n}/stat`, "utf8");
      // "pid (comm with spaces) S ppid ..." — comm may contain ')' so cut at the LAST one.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(rest[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid)!.push(Number(n));
    } catch { /* exited */ }
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) ?? []) if (!out.includes(k)) out.push(k);
  return out;
}

/** Socket inodes held by these pids ("socket:[123]" links in /proc/<pid>/fd). `unreadable` counts pids whose fd dir we could not list. */
export function socketInodesOf(pids: number[], procRoot = "/proc"): { inodes: Set<string>; unreadable: number } {
  const inodes = new Set<string>();
  let unreadable = 0;
  for (const pid of pids) {
    let fds: string[];
    try { fds = readdirSync(`${procRoot}/${pid}/fd`); } catch { unreadable++; continue; }
    for (const fd of fds) {
      try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`${procRoot}/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch { /* closed */ }
    }
  }
  return { inodes, unreadable };
}

export interface PeerCheckDeps {
  uid: number;
  /** Current Chromium root pid, or undefined while none is running. */
  rootPid: () => number | undefined;
  readNetTcp?: () => string;
  tree?: (root: number) => number[];
  inodesOf?: (pids: number[]) => { inodes: Set<string>; unreadable: number };
  /** "tree" (default): uid AND inode held by the Chromium tree. "uid": uid only (documented fallback, FLOQ_BROWSER_EGRESS_PEER=uid). */
  strictness?: "tree" | "uid";
  now?: () => number;
}
export type PeerVerdict = { ok: true } | { ok: false; reason: "no_row" | "uid" | "inode" | "no_chromium" };

/**
 * Decides whether an accepted loopback connection comes from this user's Chromium. The row whose LOCAL address is the peer's
 * address and whose REMOTE is our listener is the client side of the connection (its uid and socket inode).
 * The inode set is cached and re-read on a miss (rate-limited against floods).
 */
export class PeerChecker {
  private cache = new Set<string>();
  private cachedRoot: number | undefined;
  private lastRefresh = -Infinity;
  private windowStart = 0;
  private refreshes = 0;
  /** Pids we could not list the fds of, from the last refresh. Exposed for the spike/diagnostics. */
  unreadable = 0;
  /** Size of the last process tree read (diagnostics for peer_refused logs). */
  treeSize = 0;
  constructor(private readonly d: PeerCheckDeps) {}

  private refresh(root: number): void {
    const tree = (this.d.tree ?? ((r: number) => processTree(r)))(root);
    const { inodes, unreadable } = (this.d.inodesOf ?? ((p: number[]) => socketInodesOf(p)))(tree);
    this.cache = inodes; this.cachedRoot = root; this.unreadable = unreadable; this.treeSize = tree.length;
    this.lastRefresh = (this.d.now ?? Date.now)();
  }

  check(peer: { address: string; port: number }, listen: { address: string; port: number }): PeerVerdict {
    const text = (this.d.readNetTcp ?? (() => readFileSync("/proc/net/tcp", "utf8")))();
    const local = `${peer.address}:${peer.port}`, remote = `${listen.address}:${listen.port}`;
    const row = parseProcNetTcp4(text).find((r) => r.local === local && r.remote === remote);
    if (!row) return { ok: false, reason: "no_row" };
    if (row.uid !== this.d.uid) return { ok: false, reason: "uid" };
    if ((this.d.strictness ?? "tree") === "uid") return { ok: true };
    const root = this.d.rootPid();
    if (root === undefined) return { ok: false, reason: "no_chromium" };
    if (this.cachedRoot === root && this.cache.has(row.inode)) return { ok: true };
    const now = (this.d.now ?? Date.now)();
    // A legitimate connection can come from a process that started after the last walk (the network service, a new utility process):
    // a miss therefore re-reads the tree. Only a same-uid stranger (the user's own agent poking the port) can cost a re-read, so the
    // limit is generous and only bites on a flood (> 100 re-reads per second).
    if (now - this.windowStart >= 1000) { this.windowStart = now; this.refreshes = 0; }
    if (this.cachedRoot !== root || this.refreshes++ < 100) this.refresh(root);
    return this.cache.has(row.inode) ? { ok: true } : { ok: false, reason: "inode" };
  }
}

// ---------------------------------------------------------------- SOCKS5 request parsing (pure)

export type SocksParse =
  | { kind: "need_more" }
  | { kind: "greeting_ok"; consumed: number }
  | { kind: "greeting_bad" }
  | { kind: "request"; target: Target; consumed: number }
  | { kind: "refuse"; rep: number };

/** Parses the method-selection message. Only "no authentication" (0x00) is offered by Chromium; anything else is refused. */
export function parseGreeting(buf: Buffer): SocksParse {
  if (buf.length < 2) return { kind: "need_more" };
  if (buf[0] !== 5) return { kind: "greeting_bad" };
  const n = buf[1];
  if (buf.length < 2 + n) return { kind: "need_more" };
  return [...buf.subarray(2, 2 + n)].includes(0) ? { kind: "greeting_ok", consumed: 2 + n } : { kind: "greeting_bad" };
}

/** Parses the CONNECT request. BIND / UDP ASSOCIATE => REP 7, unknown ATYP => REP 8. */
export function parseRequest(buf: Buffer): SocksParse {
  if (buf.length < 4) return { kind: "need_more" };
  if (buf[0] !== 5 || buf[2] !== 0) return { kind: "refuse", rep: REP.GENERAL };
  const cmd = buf[1], atyp = buf[3];
  if (cmd !== 1) return { kind: "refuse", rep: REP.CMD };
  let host: string, end: number;
  if (atyp === 1) {
    if (buf.length < 10) return { kind: "need_more" };
    host = [...buf.subarray(4, 8)].join("."); end = 8;
  } else if (atyp === 4) {
    if (buf.length < 22) return { kind: "need_more" };
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(4 + i * 2).toString(16));
    host = g.join(":"); end = 20;
  } else if (atyp === 3) {
    if (buf.length < 5) return { kind: "need_more" };
    const len = buf[4];
    if (len < 1) return { kind: "refuse", rep: REP.GENERAL };
    if (buf.length < 5 + len + 2) return { kind: "need_more" };
    const raw = buf.subarray(5, 5 + len);
    // A hostname is printable ASCII (IDNs arrive as punycode). Anything else is a malformed or hostile request.
    if (raw.some((b) => b <= 0x20 || b >= 0x7f)) return { kind: "refuse", rep: REP.GENERAL };
    host = raw.toString("latin1"); end = 5 + len;
  } else return { kind: "refuse", rep: REP.ATYP };
  const port = buf.readUInt16BE(end);
  if (port === 0) return { kind: "refuse", rep: REP.GENERAL };
  return { kind: "request", target: { atyp: atyp as 1 | 3 | 4, host, port }, consumed: end + 2 };
}

export const socksReply = (rep: number): Buffer => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);

// ---------------------------------------------------------------- mux client

export interface EgressSink { write(data: Buffer): boolean; onDrain(cb: () => void): void }

interface Stream {
  id: number;
  socket: Socket;
  state: "opening" | "open";
  /** Bytes we may still send toward the desktop (their window). */
  sendCredit: number;
  /** Bytes received from the desktop that we have not yet written to the socket. */
  recvPending: number;
  /** Bytes written to the socket not yet returned as CREDIT. */
  toCredit: number;
  localEnded: boolean;
  remoteEnded: boolean;
  idle: NodeJS.Timeout;
  openTimer?: NodeJS.Timeout;
  early: Buffer[];
  /** Socket bytes read but not yet sent because the desktop's window is exhausted. */
  outq: Buffer[];
  /** Local end reached while data was still queued: FIN goes out when the queue drains. */
  finPending: boolean;
}

export interface MuxEvents { onState?(link: boolean): void; log?(event: string, extra?: Record<string, unknown>): void }

/** One per daemon. `link` mirrors the runtime's LINK frames: false (the default) means every request fails with REP 1. */
export class EgressMux {
  private streams = new Map<number, Stream>();
  private nextId = 1;
  private link = false;
  private paused = false;
  private readonly records: RecordStream;

  constructor(private readonly sink: EgressSink, private readonly ev: MuxEvents = {}) {
    this.records = new RecordStream((r) => this.onRecord(r), (reason) => { this.ev.log?.("egress.fd3_protocol_error", { reason }); this.setLink(false); });
    sink.onDrain(() => { this.paused = false; for (const s of this.streams.values()) this.maybeResume(s); });
    this.send(encodeHello({ v: PROTOCOL_VERSION }));
  }

  get linkUp(): boolean { return this.link; }
  get openStreams(): number { return this.streams.size; }

  /** Bytes read from fd 3. */
  push(chunk: Buffer): void { this.records.push(chunk); }

  private send(frame: Buffer): void { if (!this.sink.write(lengthPrefixed(frame))) this.pauseAll(); }
  private pauseAll(): void { this.paused = true; for (const s of this.streams.values()) s.socket.pause(); }

  private onRecord(record: Buffer): void {
    const d = decodeFrame(record);
    if (!d.ok) { this.ev.log?.("egress.bad_frame", { reason: d.reason }); return; }
    this.onFrame(d.frame);
  }

  private onFrame(f: Frame): void {
    switch (f.type) {
      case T.LINK: this.setLink(f.payload[0] === 1); return;
      case T.PING: this.send(encodeFrame(T.PONG, 0, f.payload)); return;
      case T.OPENED: {
        const s = this.streams.get(f.streamId);
        if (!s || s.state !== "opening") return;
        clearTimeout(s.openTimer);
        const rep = f.payload[0];
        if (rep !== REP.OK) { s.socket.end(socksReply(rep)); this.drop(s); return; }
        s.state = "open";
        s.socket.write(socksReply(REP.OK));
        for (const chunk of s.early.splice(0)) this.sendData(s, chunk);
        this.maybeResume(s);
        return;
      }
      case T.DATA: {
        const s = this.streams.get(f.streamId);
        if (!s || s.state !== "open") return;
        s.recvPending += f.payload.length;
        if (s.recvPending > INIT_CREDIT) return this.reset(s, RST_REASON.PROTOCOL);
        this.touch(s);
        const n = f.payload.length;
        s.socket.write(f.payload, () => {
          s.recvPending -= n; s.toCredit += n;
          if (s.toCredit >= CREDIT_BATCH && this.streams.has(s.id)) { this.send(encodeFrame(T.CREDIT, s.id, u32(s.toCredit))); s.toCredit = 0; }
        });
        return;
      }
      case T.CREDIT: {
        const s = this.streams.get(f.streamId);
        if (!s) return;
        // Never above the window: the peer's grants are clamped by the hub, and this keeps a bogus total from growing unbounded.
        s.sendCredit = Math.min(s.sendCredit + f.payload.readUInt32BE(0), INIT_CREDIT);
        this.flush(s);
        this.maybeResume(s);
        return;
      }
      case T.FIN: {
        const s = this.streams.get(f.streamId);
        if (!s) return;
        s.remoteEnded = true;
        s.socket.end();
        if (s.localEnded) this.drop(s);
        return;
      }
      case T.RST: {
        const s = this.streams.get(f.streamId);
        if (!s) return;
        if (s.state === "opening") { clearTimeout(s.openTimer); s.socket.end(socksReply(REP.GENERAL)); } else s.socket.destroy();
        this.drop(s);
        return;
      }
      default: return; // OPEN/HELLO/PONG from the runtime: ignored
    }
  }

  /** Called by the listener for an accepted, peer-checked SOCKS connection that asked for `target`. Takes ownership of the socket. */
  connect(socket: Socket, target: Target, leftover: Buffer): void {
    if (!this.link || this.streams.size >= MAX_STREAMS) { socket.end(socksReply(REP.GENERAL)); return; }
    const id = this.nextId; this.nextId += 2;
    const s: Stream = { id, socket, state: "opening", sendCredit: INIT_CREDIT, recvPending: 0, toCredit: 0, localEnded: false, remoteEnded: false, early: [], outq: [], finPending: false, idle: setTimeout(() => this.reset(this.streams.get(id)!, RST_REASON.IDLE), IDLE_MS) };
    s.idle.unref?.();
    this.streams.set(id, s);
    socket.pause();
    if (leftover.length) s.early.push(leftover);
    s.openTimer = setTimeout(() => { if (s.state === "opening") { socket.end(socksReply(REP.TIMEOUT)); this.send(encodeFrame(T.RST, id, Buffer.from([RST_REASON.GENERIC]))); this.drop(s); } }, OPEN_TIMEOUT_MS);
    s.openTimer.unref?.();
    socket.on("data", (chunk: Buffer) => {
      if (s.state === "opening") { s.early.push(chunk); socket.pause(); return; }
      this.sendData(s, chunk);
    });
    socket.on("end", () => {
      s.localEnded = true;
      if (s.state === "opening") { this.send(encodeFrame(T.RST, id, Buffer.from([RST_REASON.GENERIC]))); this.drop(s); return; }
      if (s.outq.length) { s.finPending = true; return; } // after the queued data, not before it
      this.send(encodeFrame(T.FIN, id));
      if (s.remoteEnded) this.drop(s);
    });
    const gone = () => { if (this.streams.get(id) === s) { if (s.state === "open" || s.state === "opening") this.send(encodeFrame(T.RST, id, Buffer.from([RST_REASON.GENERIC]))); this.drop(s); } };
    socket.on("error", gone);
    socket.on("close", gone);
    this.send(encodeFrame(T.OPEN, id, encodeOpen(target)));
  }

  /** Queues socket bytes and sends as much as the desktop's window allows; the rest waits for CREDIT (never exceeds the window). */
  private sendData(s: Stream, chunk: Buffer): void {
    this.touch(s);
    s.outq.push(chunk);
    this.flush(s);
    if (s.outq.length || s.sendCredit < MAX_DATA) s.socket.pause();
  }

  private flush(s: Stream): void {
    while (s.outq.length && s.sendCredit > 0) {
      const head = s.outq[0];
      const n = Math.min(head.length, MAX_DATA, s.sendCredit);
      s.outq[0] = head.subarray(n);
      if (!s.outq[0].length) s.outq.shift();
      s.sendCredit -= n;
      this.send(encodeFrame(T.DATA, s.id, head.subarray(0, n)));
    }
    if (!s.outq.length && s.finPending) {
      s.finPending = false;
      this.send(encodeFrame(T.FIN, s.id));
      if (s.remoteEnded) this.drop(s);
    }
  }

  /** Reading from the socket resumes only with a whole chunk of credit and an empty queue (no dribbling on a few spare bytes). */
  private maybeResume(s: Stream): void {
    if (s.state === "open" && !this.paused && !s.outq.length && s.sendCredit >= MAX_DATA && !s.localEnded) s.socket.resume();
  }

  private touch(s: Stream): void { s.idle.refresh(); }

  private reset(s: Stream | undefined, reason: number): void {
    if (!s) return;
    this.send(encodeFrame(T.RST, s.id, Buffer.from([reason])));
    s.socket.destroy();
    this.drop(s);
  }

  private drop(s: Stream): void {
    clearTimeout(s.idle); clearTimeout(s.openTimer);
    this.streams.delete(s.id);
  }

  private setLink(up: boolean): void {
    if (up === this.link) return;
    this.link = up;
    if (!up) for (const s of [...this.streams.values()]) { if (s.state === "opening") s.socket.end(socksReply(REP.GENERAL)); else s.socket.destroy(); this.drop(s); }
    this.ev.onState?.(up);
  }

  /** Daemon stopping or fd 3 closed: nothing may stay half open. */
  close(): void { this.setLink(false); this.link = false; }
}

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
void HEADER;

// ---------------------------------------------------------------- SOCKS5 listener

export interface ListenerOptions {
  mux: EgressMux;
  peers: PeerChecker;
  log: (event: string, extra?: Record<string, unknown>) => void;
  /** Test knob; default ACCEPT_BUDGET_PER_SEC. */
  acceptBudgetPerSec?: number;
}

/** Binds 127.0.0.1:0 and serves SOCKS5. Peer verification happens before a single byte is read from the connection. */
export function startSocksListener(opts: ListenerOptions): Promise<{ server: Server; port: number }> {
  // Loopback is shared with other tenants (no netns): a flood of connects must not make us parse /proc/net/tcp each time.
  let budgetStart = 0, budgetUsed = 0, refusedLogged = 0, suppressed = 0;
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
    const nowMs = Date.now();
    if (nowMs - budgetStart >= 1000) { budgetStart = nowMs; budgetUsed = 0; }
    if (++budgetUsed > (opts.acceptBudgetPerSec ?? ACCEPT_BUDGET_PER_SEC)) { socket.on("error", () => undefined); socket.destroy(); suppressed++; return; }
    const peer = { address: socket.remoteAddress ?? "", port: socket.remotePort ?? 0 };
    const listen = { address: socket.localAddress ?? "127.0.0.1", port: socket.localPort ?? 0 };
    socket.on("error", () => undefined);
    let verdict;
    try { verdict = opts.peers.check(peer, listen); } catch (e) { verdict = { ok: false as const, reason: "no_row" as const }; opts.log("egress.peer_check_failed", { message: (e as Error).message }); }
    if (!verdict.ok) {
      // One log line per second at most (with the count it stands for), so a stranger cannot fill the log either.
      suppressed++;
      if (nowMs - refusedLogged >= 1000) { opts.log("egress.peer_refused", { reason: verdict.reason, tree: opts.peers.treeSize, unreadable: opts.peers.unreadable, count: suppressed }); refusedLogged = nowMs; suppressed = 0; }
      socket.destroy(); return;
    }
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "request" = "greeting";
    const timer = setTimeout(() => socket.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) { cleanup(); socket.destroy(); return; }
      for (;;) {
        if (stage === "greeting") {
          const g = parseGreeting(buf);
          if (g.kind === "need_more") return;
          if (g.kind === "greeting_bad") { cleanup(); socket.end(Buffer.from([5, 0xff])); return; }
          if (g.kind !== "greeting_ok") return;
          buf = buf.subarray(g.consumed); stage = "request"; socket.write(Buffer.from([5, 0]));
          continue;
        }
        const r = parseRequest(buf);
        if (r.kind !== "request" && r.kind !== "refuse") return; // need_more
        cleanup();
        if (r.kind === "refuse") { socket.end(socksReply(r.rep)); return; }
        opts.mux.connect(socket, r.target, buf.subarray(r.consumed));
        return;
      }
    };
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); };
    socket.on("data", onData);
    socket.on("close", () => clearTimeout(timer));
    socket.resume();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** Wraps fd 3 (or any duplex) as a sink and feeds the mux. Returns a closer. */
export function attachMuxToStream(mux: EgressMux, stream: Socket): void {
  stream.on("data", (c: Buffer) => mux.push(c));
  stream.on("error", () => mux.close());
  stream.on("close", () => mux.close());
}
export const socketSink = (stream: Socket): EgressSink => ({
  write: (data) => (stream.writable ? stream.write(data) : true),
  onDrain: (cb) => { stream.on("drain", cb); },
});
