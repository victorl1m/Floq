// Egress mux frame codec. VERBATIM COPY of image/floq-egress-codec.mts below this line (the runtime tsconfig cannot import from image/); test/browserEgress.test.mts fails if they drift.
// See docs/design/browser-user-egress-protocol.md.
//   frame: u8 type | u32 BE streamId | payload.  On the fd 3 pipe each frame is prefixed with u32 BE length.

export const T = { OPEN: 1, OPENED: 2, DATA: 3, CREDIT: 4, FIN: 5, RST: 6, PING: 7, PONG: 8, HELLO: 9, LINK: 10 } as const;
export type FrameType = (typeof T)[keyof typeof T];
export const MAX_DATA = 32 * 1024;
export const MAX_HELLO = 4096;
export const MAX_CONTROL = 1024;
export const HEADER = 5;
export const MAX_FRAME_LEN = HEADER + MAX_DATA;
export const INIT_CREDIT = 256 * 1024;
export const MAX_STREAMS = 256;
export const CONN_UNACKED_CAP = 8 * 1024 * 1024;
export const PROTOCOL_VERSION = 1;

/** SOCKS5 REP codes used in OPENED.result. */
export const REP = { OK: 0, GENERAL: 1, NOT_ALLOWED: 2, NET_UNREACHABLE: 3, HOST_UNREACHABLE: 4, REFUSED: 5, TIMEOUT: 6, CMD: 7, ATYP: 8 } as const;
/** RST reasons. */
export const RST_REASON = { GENERIC: 0, GUARD: 1, STREAMS: 2, RATE: 3, BANDWIDTH: 4, DAILY: 5, IDLE: 6, PROTOCOL: 7, KILLED: 8, SHUTDOWN: 9, UPSTREAM: 10, LINK_DOWN: 11 } as const;
/** WS close codes of the hub (protocol doc, Connection). */
export const CLOSE = { INCOMPATIBLE: 4400, DESKTOP_OPEN: 4401 } as const;

export interface Frame { type: number; streamId: number; payload: Buffer }

const KNOWN = new Set<number>(Object.values(T));

export function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  payload.copy(out, HEADER);
  return out;
}

/** The fd 3 form: u32 length + frame. */
export function lengthPrefixed(frame: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + frame.length);
  out.writeUInt32BE(frame.length, 0);
  frame.copy(out, 4);
  return out;
}

export type DecodeResult = { ok: true; frame: Frame } | { ok: false; reason: string };

/** One whole frame (a WS binary message, or one fd 3 record without its length prefix). Structural checks only. */
export function decodeFrame(buf: Buffer): DecodeResult {
  if (buf.length < HEADER) return { ok: false, reason: "short" };
  const type = buf.readUInt8(0), streamId = buf.readUInt32BE(1), payload = buf.subarray(HEADER);
  if (!KNOWN.has(type)) return { ok: false, reason: "unknown_type" };
  const max = type === T.DATA ? MAX_DATA : type === T.HELLO ? MAX_HELLO : MAX_CONTROL;
  if (payload.length > max) return { ok: false, reason: "too_big" };
  const connLevel = type === T.PING || type === T.PONG || type === T.HELLO || type === T.LINK;
  if (connLevel !== (streamId === 0)) return { ok: false, reason: "bad_stream_id" };
  const exact: Partial<Record<number, number>> = { [T.CREDIT]: 4, [T.RST]: 1, [T.OPENED]: 1, [T.PING]: 8, [T.PONG]: 8, [T.LINK]: 1, [T.FIN]: 0 };
  const want = exact[type];
  if (want !== undefined && payload.length !== want) return { ok: false, reason: "bad_payload" };
  if (type === T.OPEN && payload.length < 4) return { ok: false, reason: "bad_payload" };
  return { ok: true, frame: { type, streamId, payload } };
}

/** Reassembles u32-length-prefixed records from the fd 3 byte stream. A bad length is fatal (`onError`), never buffered. */
export class RecordStream {
  private buf: Buffer = Buffer.alloc(0);
  private dead = false;
  constructor(private readonly onRecord: (record: Buffer) => void, private readonly onError: (reason: string) => void) {}
  push(chunk: Buffer): void {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < HEADER || len > MAX_FRAME_LEN) { this.dead = true; this.buf = Buffer.alloc(0); return this.onError("bad_length"); }
      if (this.buf.length < 4 + len) break;
      const record = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onRecord(record);
    }
  }
}

// ---- OPEN payload: u8 atyp | addr | u16 port. atyp 1 = 4 bytes, 3 = u8 len + name, 4 = 16 bytes.
export type Target = { atyp: 1 | 3 | 4; host: string; port: number };

export function encodeOpen(t: Target): Buffer {
  let addr: Buffer;
  if (t.atyp === 3) {
    const name = Buffer.from(t.host, "latin1");
    if (name.length < 1 || name.length > 255) throw new Error("bad host length");
    addr = Buffer.concat([Buffer.from([name.length]), name]);
  } else if (t.atyp === 1) {
    const parts = t.host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("bad ipv4");
    addr = Buffer.from(parts);
  } else {
    addr = ipv6ToBuffer(t.host);
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(t.port, 0);
  return Buffer.concat([Buffer.from([t.atyp]), addr, port]);
}

export function parseOpen(payload: Buffer): Target | null {
  if (payload.length < 4) return null;
  const atyp = payload[0];
  let host: string, end: number;
  if (atyp === 1) { if (payload.length !== 7) return null; host = [...payload.subarray(1, 5)].join("."); end = 5; }
  else if (atyp === 4) { if (payload.length !== 19) return null; host = bufferToIpv6(payload.subarray(1, 17)); end = 17; }
  else if (atyp === 3) {
    const len = payload[1];
    if (len < 1 || payload.length !== 2 + len + 2) return null;
    host = payload.subarray(2, 2 + len).toString("latin1"); end = 2 + len;
  } else return null;
  return { atyp, host, port: payload.readUInt16BE(end) };
}

export function ipv6ToBuffer(host: string): Buffer {
  const h = host.replace(/^\[|\]$/g, "");
  const halves = h.split("::");
  if (halves.length > 2) throw new Error("bad ipv6");
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").flatMap((g) => {
    if (g.includes(".")) { const p = g.split(".").map(Number); return [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]; }
    return [parseInt(g, 16)];
  }));
  const head = parse(halves[0]), tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0 || [...head, ...tail].some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) throw new Error("bad ipv6");
  const groups = [...head, ...new Array(fill).fill(0), ...tail];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}
export function bufferToIpv6(b: Buffer): string {
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16));
  return g.join(":");
}

export function encodeHello(obj: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  return encodeFrame(T.HELLO, 0, json.subarray(0, MAX_HELLO));
}
export function parseHello(payload: Buffer): Record<string, unknown> | null {
  try { const v = JSON.parse(payload.toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}
