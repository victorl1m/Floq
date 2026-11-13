import { log } from "./logger.js";
import {
  CLOSE, CONN_UNACKED_CAP, INIT_CREDIT, MAX_STREAMS, PROTOCOL_VERSION, RST_REASON, RecordStream, T,
  decodeFrame, encodeFrame, encodeHello, lengthPrefixed, parseHello, type Frame,
} from "./egressCodec.js";

/**
 * Per-user egress relay (docs/design/browser-user-egress.md §2.3, §2.4, §3.1; wire spec: browser-user-egress-protocol.md).
 *
 * A dumb, authenticated frame relay between the user's browser daemon (fd 3 pipe) and the user's desktop app (WebSocket).
 * It NEVER opens a socket to a target: the only thing that can leave through it is a frame for the paired desktop of the SAME user.
 * It enforces the protocol (who may send what, stream ids, credit windows, caps) so a broken or hostile end cannot flood the other.
 */

export const PING_EVERY_MS = 20_000;
export const DEAD_AFTER_MS = 65_000;
export const HELLO_TIMEOUT_MS = 10_000;
const MAX_MACHINE = 64;
/** Desktop WebSockets kept per user; the oldest is closed beyond this. */
export const MAX_DESKTOPS = 8;

/** Where frames for the daemon go (a length-prefixed fd 3 write). */
export interface DaemonSink { write(data: Buffer): void; close(): void }
/** Where frames for a desktop go (one WS binary message each). */
export interface DesktopSink { send(frame: Buffer): void; close(code: number, reason: string): void }

export type EgressLinkState = "up" | "down" | "standby" | "none";
export interface EgressInfo { state: EgressLinkState; machine?: string; rttMs?: number }

interface Flow { d2u: number; u2d: number; opened: boolean; finD: boolean; finU: boolean }
interface Desktop {
  id: number;
  sink: DesktopSink;
  ready: boolean; // HELLO received and accepted
  standbySent?: boolean;
  machine: string;
  lastSeen: number;
  rttMs?: number;
  pingNonce?: bigint;
  pingSentAt?: number;
  helloTimer?: NodeJS.Timeout;
}
interface UserHub {
  daemon: { sink: DaemonSink; records: RecordStream; id: number } | null;
  desktops: Desktop[]; // connection order; the last ready one is active
  activeDesk?: Desktop;
  flows: Map<number, Flow>;
  lastOpenId: number;
  d2uTotal: number;
  u2dTotal: number;
  linkSent: boolean | null;
}

export interface EgressHubOptions {
  now?: () => number;
  /** Test knobs. */
  pingEveryMs?: number;
  deadAfterMs?: number;
  helloTimeoutMs?: number;
  /** Called after any change a viewer should see (desktop connected/dropped, standby, rtt). `rttOnly`: nothing but the measured round trip changed. */
  onChange?: (userId: string, rttOnly?: boolean) => void;
}

export class EgressHub {
  private readonly users = new Map<string, UserHub>();
  private nextId = 1;
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly opts: EgressHubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timer = setInterval(() => this.tick(), Math.min(opts.pingEveryMs ?? PING_EVERY_MS, 1000));
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    for (const [userId, hub] of this.users) {
      for (const d of [...hub.desktops]) { try { d.sink.close(1001, "Shutting down"); } catch { /* gone */ } this.removeDesktop(userId, d); }
      hub.daemon?.sink.close();
    }
  }

  private hub(userId: string): UserHub {
    let h = this.users.get(userId);
    if (!h) { h = { daemon: null, desktops: [], flows: new Map(), lastOpenId: 0, d2uTotal: 0, u2dTotal: 0, linkSent: null }; this.users.set(userId, h); }
    return h;
  }

  private active(h: UserHub): Desktop | undefined {
    for (let i = h.desktops.length - 1; i >= 0; i--) if (h.desktops[i].ready) return h.desktops[i];
    return undefined;
  }

  /** What a viewer / GET /v1/browser should show. */
  info(userId: string): EgressInfo {
    const h = this.users.get(userId);
    if (!h) return { state: "none" };
    const a = this.active(h);
    if (a) return { state: "up", machine: a.machine, ...(a.rttMs !== undefined ? { rttMs: a.rttMs } : {}) };
    return h.desktops.length ? { state: "down" } : { state: "none" };
  }

  /** True when a desktop is connected and ready, i.e. the user's browser can egress through it right now. */
  isUp(userId: string): boolean { const h = this.users.get(userId); return !!h && !!this.active(h); }

  // ------------------------------------------------------------------ daemon end (fd 3)

  /** The user's daemon opened its fd 3 pipe. A previous daemon handle of the same user is closed. Returns the handle the pipe reader/closer calls. */
  attachDaemon(userId: string, sink: DaemonSink): { push(chunk: Buffer): void; close(): void } {
    const h = this.hub(userId);
    if (h.daemon) { const old = h.daemon; h.daemon = null; this.resetFlows(userId, h, RST_REASON.SHUTDOWN, false); try { old.sink.close(); } catch { /* gone */ } }
    const id = this.nextId++;
    const records = new RecordStream((r) => this.fromDaemon(userId, r), (reason) => { log.warn("egress.daemon_protocol_error", { userId, reason }); this.detachDaemon(userId, id); });
    h.daemon = { sink, records, id };
    h.linkSent = null;
    h.lastOpenId = 0; // a new daemon numbers its streams from 1 again
    this.syncLink(userId, h);
    return { push: (chunk) => { if (h.daemon?.id === id) records.push(chunk); }, close: () => this.detachDaemon(userId, id) };
  }

  private detachDaemon(userId: string, id: number): void {
    const h = this.users.get(userId);
    if (!h?.daemon || h.daemon.id !== id) return;
    const d = h.daemon;
    h.daemon = null; h.linkSent = null;
    this.resetFlows(userId, h, RST_REASON.SHUTDOWN, false);
    try { d.sink.close(); } catch { /* gone */ }
    this.prune(userId, h);
  }

  private toDaemon(h: UserHub, frame: Buffer): void { try { h.daemon?.sink.write(lengthPrefixed(frame)); } catch { /* pipe closed: detach follows */ } }
  private toDesktop(h: UserHub, frame: Buffer): void { const a = h.activeDesk; if (a) { try { a.sink.send(frame); } catch { /* socket closing */ } } }

  /** Keeps the daemon's idea of the link equal to "an active desktop exists". */
  private syncLink(userId: string, h: UserHub): void {
    if (!h.daemon) return;
    const up = !!h.activeDesk;
    if (h.linkSent === up) return;
    h.linkSent = up;
    this.toDaemon(h, encodeFrame(T.LINK, 0, Buffer.from([up ? 1 : 0])));
    void userId;
  }

  private fromDaemon(userId: string, record: Buffer): void {
    const h = this.users.get(userId);
    if (!h) return;
    const d = decodeFrame(record);
    if (!d.ok) { log.warn("egress.daemon_bad_frame", { userId, reason: d.reason }); return; }
    const f = d.frame;
    switch (f.type) {
      case T.HELLO: return; // version is ours to enforce; the daemon is the image's own binary
      case T.OPEN: return this.onOpen(userId, h, f);
      case T.DATA: {
        const flow = h.flows.get(f.streamId);
        if (!flow || !flow.opened) return; // data before the desktop accepted: drop (the daemon only sends after OPENED)
        flow.d2u += f.payload.length; h.d2uTotal += f.payload.length;
        if (flow.d2u > INIT_CREDIT || h.d2uTotal > CONN_UNACKED_CAP) return this.killFlow(h, f.streamId, RST_REASON.PROTOCOL);
        return this.toDesktop(h, record);
      }
      case T.CREDIT: {
        const flow = h.flows.get(f.streamId);
        if (!flow) return;
        const n = Math.min(f.payload.readUInt32BE(0), flow.u2d);
        flow.u2d -= n; h.u2dTotal -= n;
        // Forward the CLAMPED grant: the peer must never hold more credit than the window we account for.
        return n > 0 ? this.toDesktop(h, encodeFrame(T.CREDIT, f.streamId, u32(n))) : undefined;
      }
      case T.FIN: {
        const flow = h.flows.get(f.streamId);
        if (!flow) return;
        flow.finD = true;
        this.toDesktop(h, record);
        if (flow.finU) this.endFlow(h, f.streamId);
        return;
      }
      case T.RST: {
        if (!h.flows.has(f.streamId)) return;
        this.toDesktop(h, record);
        this.endFlow(h, f.streamId);
        return;
      }
      case T.PING: return this.toDaemon(h, encodeFrame(T.PONG, 0, f.payload));
      default: return; // OPENED/PONG/LINK from a daemon make no sense: ignored
    }
  }

  private onOpen(userId: string, h: UserHub, f: Frame): void {
    const id = f.streamId;
    // Odd, strictly increasing: the daemon never reuses an id, so a repeat is a bug or an attack on an old stream's state.
    if (id % 2 === 0 || id <= h.lastOpenId) return this.toDaemon(h, encodeFrame(T.RST, id, Buffer.from([RST_REASON.PROTOCOL])));
    h.lastOpenId = id;
    if (!h.activeDesk) return this.toDaemon(h, encodeFrame(T.RST, id, Buffer.from([RST_REASON.LINK_DOWN])));
    if (h.flows.size >= MAX_STREAMS) return this.toDaemon(h, encodeFrame(T.RST, id, Buffer.from([RST_REASON.STREAMS])));
    h.flows.set(id, { d2u: 0, u2d: 0, opened: false, finD: false, finU: false });
    this.toDesktop(h, encodeFrame(T.OPEN, id, f.payload));
    void userId;
  }

  // ------------------------------------------------------------------ desktop end (WS)

  /**
   * An authenticated desktop WebSocket of `userId`. The caller passes every message to onMessage and calls onClose once.
   * Nothing flows until a valid HELLO arrived.
   */
  attachDesktop(userId: string, sink: DesktopSink, opts: { peerIp?: string } = {}): { onMessage(data: Buffer, isBinary: boolean): void; onClose(): void } {
    const h = this.hub(userId);
    // Bounded per user: beyond the cap the oldest connection goes (a runaway client cannot pile up sockets and timers).
    while (h.desktops.length >= MAX_DESKTOPS) {
      const old = h.desktops[0];
      try { old.sink.close(1008, "Too many connections"); } catch { /* gone */ }
      this.removeDesktop(userId, old);
    }
    const d: Desktop = { id: this.nextId++, sink, ready: false, machine: "", lastSeen: this.now() };
    d.helloTimer = setTimeout(() => { if (!d.ready) { try { sink.close(1008, "HELLO expected"); } catch { /* gone */ } this.removeDesktop(userId, d); } }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    d.helloTimer.unref?.();
    h.desktops.push(d);
    // The runtime speaks first (protocol doc, HELLO): the desktop waits for this before it sends its own. `peer` is the address the
    // desktop dialed from, i.e. its public IP as seen here; the desktop refuses it as an egress target (hairpin to its own router).
    const peer = opts.peerIp && /^[0-9a-fA-F:.]{2,45}$/.test(opts.peerIp) ? opts.peerIp : undefined;
    try { sink.send(encodeHello({ v: PROTOCOL_VERSION, role: "runtime", ...(peer ? { peer } : {}) })); } catch { /* closing */ }
    return {
      onMessage: (data, isBinary) => this.fromDesktop(userId, d, data, isBinary),
      onClose: () => this.removeDesktop(userId, d),
    };
  }

  private protocolError(userId: string, d: Desktop, why: string): void {
    log.warn("egress.desktop_protocol_error", { userId, why });
    try { d.sink.close(1008, "Protocol error"); } catch { /* gone */ }
    this.removeDesktop(userId, d);
  }

  private fromDesktop(userId: string, d: Desktop, data: Buffer, isBinary: boolean): void {
    const h = this.users.get(userId);
    if (!h || !h.desktops.includes(d)) return;
    if (!isBinary) return this.protocolError(userId, d, "text_message");
    const dec = decodeFrame(data);
    // Forward compatibility: a frame type we do not know is ignored once the desktop is ready (before HELLO it is an error).
    if (!dec.ok) return dec.reason === "unknown_type" && d.ready ? undefined : this.protocolError(userId, d, dec.reason);
    const f = dec.frame;
    d.lastSeen = this.now();
    if (!d.ready) {
      if (f.type !== T.HELLO) return this.protocolError(userId, d, "hello_first");
      const hello = parseHello(f.payload);
      if (!hello || hello.v !== PROTOCOL_VERSION) {
        try { d.sink.close(CLOSE.INCOMPATIBLE, "incompatible app"); } catch { /* gone */ }
        this.removeDesktop(userId, d);
        return;
      }
      clearTimeout(d.helloTimer);
      d.machine = typeof hello.machine === "string" ? hello.machine.replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, MAX_MACHINE) : "";
      d.ready = true;
      this.promote(userId, h);
      return;
    }
    // From here on only the ACTIVE desktop may move data; a standby one just keeps its WS alive.
    const isActive = h.activeDesk === d;
    switch (f.type) {
      case T.HELLO: return this.protocolError(userId, d, "second_hello");
      case T.OPEN: try { d.sink.close(CLOSE.DESKTOP_OPEN, "OPEN from desktop"); } catch { /* gone */ } this.removeDesktop(userId, d); return;
      case T.LINK: return this.protocolError(userId, d, "forbidden_type");
      case T.PING: { try { d.sink.send(encodeFrame(T.PONG, 0, f.payload)); } catch { /* closing */ } return; }
      case T.PONG: {
        if (d.pingNonce !== undefined && f.payload.readBigUInt64BE(0) === d.pingNonce && d.pingSentAt !== undefined) {
          d.rttMs = Math.max(0, this.now() - d.pingSentAt); d.pingNonce = undefined;
          this.opts.onChange?.(userId, true);
        }
        return;
      }
      default: break;
    }
    if (!isActive) return;
    switch (f.type) {
      case T.OPENED: {
        const flow = h.flows.get(f.streamId);
        if (!flow || flow.opened) return;
        if (f.payload[0] === 0) flow.opened = true; else this.endFlow(h, f.streamId);
        return this.toDaemon(h, data);
      }
      case T.DATA: {
        const flow = h.flows.get(f.streamId);
        if (!flow) return;
        if (!flow.opened) return this.killFlow(h, f.streamId, RST_REASON.PROTOCOL);
        flow.u2d += f.payload.length; h.u2dTotal += f.payload.length;
        if (flow.u2d > INIT_CREDIT || h.u2dTotal > CONN_UNACKED_CAP) return this.killFlow(h, f.streamId, RST_REASON.PROTOCOL);
        return this.toDaemon(h, data);
      }
      case T.CREDIT: {
        const flow = h.flows.get(f.streamId);
        if (!flow) return;
        const n = Math.min(f.payload.readUInt32BE(0), flow.d2u);
        flow.d2u -= n; h.d2uTotal -= n;
        return n > 0 ? this.toDaemon(h, encodeFrame(T.CREDIT, f.streamId, u32(n))) : undefined;
      }
      case T.FIN: {
        const flow = h.flows.get(f.streamId);
        if (!flow) return;
        flow.finU = true;
        this.toDaemon(h, data);
        if (flow.finD) this.endFlow(h, f.streamId);
        return;
      }
      case T.RST: {
        if (!h.flows.has(f.streamId)) return;
        this.toDaemon(h, data);
        this.endFlow(h, f.streamId);
        return;
      }
      default: return;
    }
  }

  private removeDesktop(userId: string, d: Desktop): void {
    const h = this.users.get(userId);
    if (!h) return;
    const i = h.desktops.indexOf(d);
    if (i < 0) return;
    clearTimeout(d.helloTimer);
    h.desktops.splice(i, 1);
    this.promote(userId, h);
    this.prune(userId, h);
  }

  /** Re-evaluates who is active: newest ready desktop; the rest get standby. Resets streams on a change, syncs LINK to the daemon, notifies viewers. */
  private promote(userId: string, h: UserHub): void {
    const a = this.active(h), prev = h.activeDesk;
    if (a !== prev) {
      // The streams belonged to the old desktop: they end now, toward the daemon, and toward the old desktop if it is still connected.
      for (const id of [...h.flows.keys()]) {
        const rst = encodeFrame(T.RST, id, Buffer.from([RST_REASON.LINK_DOWN]));
        this.toDaemon(h, rst);
        if (prev && h.desktops.includes(prev)) { try { prev.sink.send(rst); } catch { /* closing */ } }
        this.endFlow(h, id);
      }
      h.d2uTotal = 0; h.u2dTotal = 0;
      h.activeDesk = a;
    }
    for (const d of h.desktops) {
      if (!d.ready) continue;
      const standby = d !== a;
      if (d.standbySent === standby) continue;
      d.standbySent = standby;
      try { d.sink.send(encodeHello({ v: PROTOCOL_VERSION, standby })); } catch { /* closing */ }
    }
    this.syncLink(userId, h);
    this.opts.onChange?.(userId);
  }

  private prune(userId: string, h: UserHub): void {
    if (!h.daemon && !h.desktops.length) this.users.delete(userId);
  }

  // ------------------------------------------------------------------ flows

  private endFlow(h: UserHub, id: number): void {
    const flow = h.flows.get(id);
    if (!flow) return;
    h.d2uTotal -= flow.d2u; h.u2dTotal -= flow.u2d;
    h.flows.delete(id);
  }
  /** Reset one stream toward both ends. */
  private killFlow(h: UserHub, id: number, reason: number): void {
    if (!h.flows.has(id)) return;
    const rst = encodeFrame(T.RST, id, Buffer.from([reason]));
    this.toDaemon(h, rst); this.toDesktop(h, rst);
    this.endFlow(h, id);
  }
  /** Every stream is over: tell the surviving end(s). `toDesk`: also tell the active desktop (false when the desktop is the one that left or the daemon went away and its streams are moot). */
  private resetFlows(userId: string, h: UserHub, reason: number, toDaemon: boolean): void {
    void userId;
    for (const id of [...h.flows.keys()]) {
      const rst = encodeFrame(T.RST, id, Buffer.from([reason]));
      if (toDaemon) this.toDaemon(h, rst); else this.toDesktop(h, rst);
      this.endFlow(h, id);
    }
    h.d2uTotal = 0; h.u2dTotal = 0;
  }

  // ------------------------------------------------------------------ keep-alive

  private lastPing = 0;
  private tick(): void {
    const t = this.now();
    const every = this.opts.pingEveryMs ?? PING_EVERY_MS, dead = this.opts.deadAfterMs ?? DEAD_AFTER_MS;
    const doPing = t - this.lastPing >= every;
    if (doPing) this.lastPing = t;
    for (const [userId, h] of [...this.users]) {
      for (const d of [...h.desktops]) {
        if (!d.ready) continue;
        if (t - d.lastSeen > dead) {
          log.info("egress.desktop_dead", { userId });
          try { d.sink.close(1001, "Ping timeout"); } catch { /* gone */ }
          this.removeDesktop(userId, d);
          continue;
        }
        if (doPing) {
          const nonce = BigInt(t);
          const payload = Buffer.alloc(8); payload.writeBigUInt64BE(nonce);
          d.pingNonce = nonce; d.pingSentAt = t;
          try { d.sink.send(encodeFrame(T.PING, 0, payload)); } catch { /* closing */ }
        }
      }
    }
  }
}

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
