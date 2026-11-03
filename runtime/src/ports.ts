import { readdir, readFile, readlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type { WebSocket } from "ws";

/**
 * Port forwarding support. Sandboxed sessions run under bwrap WITHOUT --unshare-net (see shard.ts), so a
 * session's listening sockets live in the runtime host's network namespace and are reachable at 127.0.0.1.
 * We attribute a listener to a session by matching socket inodes held by the session's process tree, never by
 * port number alone, so a tunnel can only reach ports the session itself opened. If the sandbox ever gains its
 * own netns, connect from inside it (e.g. via nsenter) instead of net.connect here.
 */

export interface ListeningPort {
  port: number;
  /** Address the session bound (0.0.0.0 / :: mean all interfaces). */
  address: string;
}

interface RawListener extends ListeningPort {
  inode: string;
}

const TCP_LISTEN = "0A";
const HIGH_WATER = 1024 * 1024;
const MIN_MANUAL_PORT = 1024;
/** Never tunnel these on a manual request: the database default, plus the runtime's own listen port (added by the caller). */
export const MANUAL_DENY_PORTS: readonly number[] = [5432];

function hexToIpv4(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join(".");
}

function hexToIpv6(hex: string): string {
  // /proc prints four 32-bit words, each in host (little-endian) byte order.
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 8) {
    for (let j = 6; j >= 0; j -= 2) bytes.push(Number.parseInt(hex.slice(i + j, i + j + 2), 16));
  }
  if (bytes.every((b) => b === 0)) return "::";
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "::1";
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(":");
}

/** Parse the contents of /proc/net/tcp or /proc/net/tcp6, keeping LISTEN sockets only. */
export function parseProcNetTcp(text: string, v6: boolean): RawListener[] {
  const out: RawListener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== TCP_LISTEN) continue;
    const [addr, portHex] = cols[1].split(":");
    const port = Number.parseInt(portHex ?? "", 16);
    const inode = cols[9];
    if (!addr || !Number.isInteger(port) || port < 1 || port > 65535 || !inode || inode === "0") continue;
    out.push({ port, address: v6 ? hexToIpv6(addr) : hexToIpv4(addr), inode });
  }
  return out;
}

/** Match listeners to the socket inodes a session owns; one entry per port, sorted. */
export function selectSessionPorts(listeners: RawListener[], inodes: ReadonlySet<string>): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const l of listeners) {
    if (inodes.has(l.inode) && !byPort.has(l.port)) byPort.set(l.port, { port: l.port, address: l.address });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Port of a postgres connection string, or 0 when it has none or cannot be parsed. */
export function databasePort(databaseUrl: string): number {
  try { return Number.parseInt(new URL(databaseUrl).port, 10) || 0; } catch { return 0; }
}

/** Where the runtime should connect to reach a listener, or null when the port is not a detected listener. */
export function tunnelTarget(
  ports: ListeningPort[],
  port: number,
  manual?: { denyPorts: readonly number[] },
): { host: string; port: number } | null {
  const found = ports.find((p) => p.port === port);
  if (!found) {
    // Explicit user request for a port detection has not seen (yet): loopback only, unprivileged, never a Floq internal port.
    if (!manual || !Number.isInteger(port) || port < MIN_MANUAL_PORT || port > 65535 || manual.denyPorts.includes(port)) return null;
    return { host: "127.0.0.1", port };
  }
  const host = found.address === "0.0.0.0" ? "127.0.0.1" : found.address === "::" ? "::1" : found.address;
  return { host, port };
}

async function descendants(root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
      const list = children.get(ppid) ?? [];
      list.push(Number(name));
      children.set(ppid, list);
    } catch { /* process exited */ }
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}

async function socketInodes(pids: number[]): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const pid of pids) {
    let fds: string[];
    try { fds = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`));
        if (match) inodes.add(match[1]);
      } catch { /* fd closed */ }
    }
  }
  return inodes;
}

/** TCP ports the process tree rooted at `pid` is listening on. Empty off Linux or on any read failure. */
export async function listSessionPorts(pid: number | null): Promise<ListeningPort[]> {
  if (pid === null || process.platform !== "linux") return [];
  try {
    const inodes = await socketInodes(await descendants(pid));
    if (!inodes.size) return [];
    const [v4, v6] = await Promise.all([
      readFile("/proc/net/tcp", "utf8").catch(() => ""),
      readFile("/proc/net/tcp6", "utf8").catch(() => ""),
    ]);
    return selectSessionPorts([...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)], inodes);
  } catch {
    return [];
  }
}

/** Pipe one WebSocket (binary frames) to one TCP connection, with backpressure and close propagation. */
export function pipeTunnel(ws: WebSocket, target: { host: string; port: number }, connectFn: typeof connect = connect): Socket {
  const socket = connectFn({ host: target.host, port: target.port });
  const closeBoth = (code = 1000, reason = "") => {
    socket.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
  };
  socket.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true }, () => { if (ws.bufferedAmount < HIGH_WATER) socket.resume(); });
    if (ws.bufferedAmount > HIGH_WATER) socket.pause();
  });
  socket.on("end", () => closeBoth());
  socket.on("close", () => closeBoth());
  socket.on("error", () => closeBoth(1011, "Connection to the port failed"));
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    if (!socket.write(data)) {
      ws.pause();
      socket.once("drain", () => ws.resume());
    }
  });
  ws.on("close", () => socket.destroy());
  ws.on("error", () => socket.destroy());
  return socket;
}
