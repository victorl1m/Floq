import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { log } from "./logger.js";

/**
 * Optional per-user network namespace for agent sandboxes (feature flag FLOQ_NETNS, default OFF).
 * See the Floq note netns-isolation-spec and runtime/README.md. With the flag off nothing in this file runs
 * and the sandbox argv is byte-identical to before (wrapLaunch is the identity without a netns path).
 *
 *   FLOQ_NETNS unset/0   off: sandboxes share the runtime's network namespace (old behaviour)
 *   FLOQ_NETNS=1         on: one persistent netns per user uid; falls back to off (loud log) if the startup probe fails
 *   FLOQ_NETNS=required  on, and the runtime refuses to start when the probe fails
 */

const run = promisify(execFile);

export type NetnsMode = "off" | "on" | "required";

export const NETNS_DIR = "/run/floq/netns";
/** Address of the namespace's default gateway. pasta maps it (--map-host-loopback) to the runtime's 127.0.0.1. */
export const NETNS_GATEWAY = "10.255.255.1";
/** Address the namespace itself gets (/30 with the gateway). */
export const NETNS_ADDRESS = "10.255.255.2";
/** Resolver address inside the namespace (pasta --dns-forward). Deliberately off-link so it is routed via the gateway. */
export const NETNS_DNS = "10.255.254.53";
export const NETNS_PREFIX = 30;
/** pasta binary: a copy installed under its own path (like floq-bwrap) so no host AppArmor profile named "pasta" applies. */
export const PASTA_BIN = "floq-pasta";
/** Max concurrent tunnel helper processes (nsenter+socat) per user. */
export const DEFAULT_TUNNEL_LIMIT = 32;
/** Destinations dropped for sandbox traffic unless FLOQ_NETNS_ALLOW lists them (private, link-local/metadata, CGNAT, reserved). */
export const NETNS_BLOCKED_RANGES: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  // Documentation ranges: never legitimate destinations, and common stand-ins for operator-internal addresses.
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
];

export function netnsMode(env: NodeJS.ProcessEnv = process.env): NetnsMode {
  const raw = env.FLOQ_NETNS?.trim().toLowerCase();
  if (raw === "required") return "required";
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes" ? "on" : "off";
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

/** Strictly validated IPv4 addresses/CIDRs (the list is pasted into an nft ruleset: nothing else may get through). */
export function parseAllowList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = CIDR.exec(item);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || (m[5] !== undefined && Number(m[5]) > 32)) {
      throw new Error("FLOQ_NETNS_ALLOW: not an IPv4 address or CIDR: " + item.slice(0, 40));
    }
    out.push(item);
  }
  return out;
}

export function netnsPath(uid: number, dir = NETNS_DIR): string {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("invalid uid");
  return join(dir, String(uid));
}

/** unshare creates the namespace and bind-mounts it on `path`; `ip link set lo up` runs inside it. */
export function unshareArgv(path: string): string[] {
  return ["--net=" + path, "--", "ip", "link", "set", "lo", "up"];
}

/** Run a command inside the namespace at `path`. */
export function nsenterArgv(path: string, command: readonly string[]): string[] {
  return ["--net=" + path, "--", ...command];
}

/**
 * Wrap the sandbox launch so it joins the user's namespace. bwrap has no --unshare-net, so it inherits it.
 * Without a namespace path the input is returned untouched (flag off => today's argv, byte for byte).
 */
export function wrapLaunch(file: string, args: readonly string[], netns: string | undefined): { file: string; args: string[] } {
  if (!netns) return { file, args: [...args] };
  return { file: "nsenter", args: nsenterArgv(netns, [file, ...args]) };
}

export interface PastaOptions {
  path: string;
  pidFile: string;
  /** uid pasta runs as after setup. Explicit on purpose: as root pasta otherwise drops to "nobody" and can no longer write its pid file under /run/floq. */
  runas?: number;
}

/** pasta attached to an existing namespace by path: no inbound forwards, static addressing, DNS forwarder, IPv4 only. */
export function pastaArgv(o: PastaOptions): string[] {
  return [
    "--foreground", "--quiet", "-4",
    "--netns", o.path,
    "--config-net",
    "--address", NETNS_ADDRESS,
    "--netmask", String(NETNS_PREFIX),
    "--gateway", NETNS_GATEWAY,
    "-t", "none", "-u", "none",
    "--map-host-loopback", NETNS_GATEWAY,
    "--dns-forward", NETNS_DNS,
    "--no-dhcp",
    "--runas", String(o.runas ?? 0),
    "--pid", o.pidFile,
  ];
}

export interface EgressOptions {
  /** Runtime port reachable on the gateway (and nothing else on the gateway). */
  runtimePort: number;
  /** Extra destinations accepted before the blocked ranges (FLOQ_NETNS_ALLOW). */
  allow?: readonly string[];
  /** The runtime container's own IPv4 addresses (pasta lets the namespace reach them as the host): dropped like the private ranges. */
  hostAddresses?: readonly string[];
}

/** IPv4 addresses from `ip -o -4 addr show` output (loopback and unparsable lines skipped), as /32 entries. */
export function parseHostAddresses(output: string): string[] {
  const out = new Set<string>();
  for (const line of output.split("\n")) {
    const m = /\binet (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\//.exec(line);
    if (!m || m[1].startsWith("127.") || m[1].split(".").some((o) => Number(o) > 255)) continue;
    out.add(m[1] + "/32");
  }
  return [...out];
}

/** nftables ruleset applied inside the namespace: default drop, DNS + runtime port + public IPv4 only. */
export function nftRuleset(o: EgressOptions): string {
  if (!Number.isInteger(o.runtimePort) || o.runtimePort < 1 || o.runtimePort > 65535) throw new Error("invalid runtime port");
  const allow = parseAllowList((o.allow ?? []).join(","));
  const hostAddresses = parseAllowList((o.hostAddresses ?? []).join(",")).filter((a) => a !== NETNS_ADDRESS + "/32");
  const lines = [
    "table inet floq_egress {",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    '    oifname "lo" accept',
    "    meta nfproto ipv6 drop",
    `    ip daddr ${NETNS_DNS} udp dport 53 accept`,
    `    ip daddr ${NETNS_DNS} tcp dport 53 accept`,
    `    ip daddr ${NETNS_GATEWAY} tcp dport ${o.runtimePort} accept`,
    `    ip daddr ${NETNS_GATEWAY} drop`,
  ];
  if (allow.length) lines.push(`    ip daddr { ${allow.join(", ")} } accept`);
  // After the gateway/DNS/allow rules, before the public accept: the container's own (possibly public) addresses and every blocked range.
  if (hostAddresses.length) lines.push(`    ip daddr { ${hostAddresses.join(", ")} } drop`);
  lines.push(
    `    ip daddr { ${NETNS_BLOCKED_RANGES.join(", ")} } drop`,
    "    meta nfproto ipv4 accept",
    "  }",
    "}",
    "",
  );
  return lines.join("\n");
}

/** resolv.conf bound over /etc/resolv.conf in the sandbox: the host's may name Docker's 127.0.0.11, absent inside the namespace. */
export function resolvConf(): string {
  return `nameserver ${NETNS_DNS}\noptions edns0\n`;
}

/**
 * `socat` helper that connects INSIDE the namespace (node cannot setns). Host is a literal IP, validated here.
 * nsenter (needs CAP_SYS_ADMIN for setns) goes first, then setpriv drops to the user's uid before socat runs.
 */
export function tunnelHelperArgv(path: string, uid: number, target: { host: string; port: number }): { file: string; args: string[] } {
  if (!Number.isInteger(uid) || uid < 1) throw new Error("invalid uid");
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("invalid port");
  const v6 = target.host.includes(":");
  if (!(v6 ? /^[0-9a-fA-F:]+$/ : /^\d{1,3}(\.\d{1,3}){3}$/).test(target.host)) throw new Error("invalid tunnel host");
  const address = v6 ? `TCP6:[${target.host}]:${target.port}` : `TCP:${target.host}:${target.port}`;
  const drop = ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all"];
  return { file: "nsenter", args: nsenterArgv(path, [...drop, "socat", "STDIO", address]) };
}

/** Which /proc file lists the LISTEN sockets of the namespace a process lives in. */
export function procNetTcpPaths(pid: number): [string, string] {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("invalid pid");
  return [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`];
}

/** A Duplex over a helper process's stdio, so pipeTunnel can treat it like a socket. */
export function duplexFromChild(child: ChildProcess): Duplex {
  const out = child.stdout;
  const input = child.stdin;
  if (!out || !input) throw new Error("helper without stdio");
  let failed = false;
  const duplex = new Duplex({
    read() { out.resume(); },
    write(chunk, _enc, cb) { input.write(chunk, (err) => cb(err ?? undefined)); },
    final(cb) { input.end(); cb(); },
    destroy(error, cb) { child.kill("SIGKILL"); cb(error); },
  });
  out.on("data", (chunk: Buffer) => { if (!duplex.push(chunk)) out.pause(); });
  out.on("end", () => duplex.push(null));
  input.on("error", () => undefined);
  child.on("error", (error) => { failed = true; duplex.destroy(error); });
  child.on("exit", (code) => { if (code !== 0 && !failed && !duplex.destroyed) duplex.destroy(new Error("tunnel helper exited with " + code)); });
  return duplex;
}

export function connectInNetns(path: string, uid: number, target: { host: string; port: number }, onClose?: () => void): Duplex {
  const { file, args } = tunnelHelperArgv(path, uid, target);
  const duplex = duplexFromChild(spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] }));
  if (onClose) duplex.once("close", onClose);
  return duplex;
}

const tunnelSlots = new Map<number, number>();

export function tunnelLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.FLOQ_NETNS_TUNNEL_LIMIT ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TUNNEL_LIMIT;
}

/** Reserve one helper slot for `uid`; null when the user is at the limit. The returned release is idempotent. */
export function acquireTunnelSlot(uid: number, limit = tunnelLimit()): (() => void) | null {
  const used = tunnelSlots.get(uid) ?? 0;
  if (used >= limit) return null;
  tunnelSlots.set(uid, used + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (tunnelSlots.get(uid) ?? 1) - 1;
    if (left <= 0) tunnelSlots.delete(uid); else tunnelSlots.set(uid, left);
  };
}

function pidIsOurs(pid: number): boolean {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return comm.startsWith("pasta") || comm.startsWith("passt");
  } catch {
    return false;
  }
}

function isMountPoint(path: string): boolean {
  try {
    return readFileSync("/proc/self/mounts", "utf8").split("\n").some((l) => l.split(" ")[1] === path);
  } catch {
    return false;
  }
}

interface Active {
  path: string;
  pasta: ChildProcess | null;
  removing: boolean;
  restarts: number;
}

export interface NetnsOptions {
  dir?: string;
  runtimePort: number;
  allow?: readonly string[];
  mode: Exclude<NetnsMode, "off">;
  /** Where per-user resolv.conf files live (any root-only directory that survives wake/sleep). */
  metaDir: string;
}

/** Creates, supervises and removes the per-user namespaces. All methods are safe to call concurrently. */
export class NetnsManager {
  private readonly dir: string;
  private readonly active = new Map<number, Active>();
  private readonly pending = new Map<number, Promise<string>>();
  private enabled = true;

  constructor(private readonly options: NetnsOptions) {
    this.dir = options.dir ?? NETNS_DIR;
    parseAllowList((options.allow ?? []).join(","));
  }

  get isEnabled(): boolean { return this.enabled; }

  resolvConfPath(uid: number): string { return join(this.options.metaDir, uid + ".netns-resolv.conf"); }

  /** Startup: remove leftovers, then create and tear down a test namespace. Disables netns (or throws when required) on failure. */
  async init(): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o755 });
      await this.cleanStale();
      const probe = join(this.dir, "probe");
      writeFileSync(probe, "");
      try {
        await run("unshare", unshareArgv(probe), { timeout: 10_000 });
      } finally {
        await this.unmount(probe);
        rmSync(probe, { force: true });
      }
      for (const tool of ["pasta", "nft", "socat"]) {
        await run(tool, tool === "pasta" ? ["--version"] : [tool === "nft" ? "--version" : "-V"], { timeout: 5_000 });
      }
      log.info("netns.ready", { dir: this.dir });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n").slice(0, 2).join(" | ") : String(error);
      if (this.options.mode === "required") throw new Error("FLOQ_NETNS=required but network namespaces are unavailable: " + detail);
      this.enabled = false;
      log.error("netns.disabled", { error: detail, message: "FLOQ_NETNS is set but the namespace probe failed; sandboxes share the host network again" });
    }
  }

  /** Path of the user's namespace, created on first use. Idempotent and race-safe per uid. */
  ensure(uid: number): Promise<string> {
    const running = this.pending.get(uid);
    if (running) return running;
    const task = this.create(uid).finally(() => this.pending.delete(uid));
    this.pending.set(uid, task);
    return task;
  }

  private async create(uid: number): Promise<string> {
    const path = netnsPath(uid, this.dir);
    const existing = this.active.get(uid);
    if (existing && !existing.removing && existing.pasta && existing.pasta.exitCode === null && isMountPoint(path)) return path;
    await this.remove(uid);
    const entry: Active = { path, pasta: null, removing: false, restarts: 0 };
    this.active.set(uid, entry);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o755 });
      writeFileSync(path, "", { mode: 0o444 });
      await run("unshare", unshareArgv(path), { timeout: 10_000 });
      await this.applyRules(path);
      writeFileSync(this.resolvConfPath(uid), resolvConf(), { mode: 0o644 });
      this.startPasta(uid, entry);
      await this.waitForAddress(path);
      log.info("netns.created", { uid });
      return path;
    } catch (error) {
      await this.remove(uid);
      throw error;
    }
  }

  private applyRules(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("nsenter", nsenterArgv(path, ["nft", "-f", "-"]), { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr?.on("data", (c: Buffer) => { err += c.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("nft failed: " + err.slice(0, 200)))));
      child.stdin?.end(nftRuleset({ runtimePort: this.options.runtimePort, allow: this.options.allow }));
    });
  }

  private pidFile(uid: number): string { return join(this.dir, uid + ".pasta.pid"); }

  private startPasta(uid: number, entry: Active): void {
    const child = spawn("pasta", pastaArgv({ path: entry.path, pidFile: this.pidFile(uid) }), { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => { if (err.length < 400) err += c.toString(); });
    entry.pasta = child;
    child.on("error", (e) => log.error("netns.pasta_error", { uid, error: e.message }));
    child.on("exit", (code, signal) => {
      if (entry.removing || this.active.get(uid) !== entry) return;
      log.error("netns.pasta_exited", { uid, code, signal, stderr: err.slice(0, 300) });
      if (entry.restarts++ < 5) setTimeout(() => { if (!entry.removing && this.active.get(uid) === entry) this.startPasta(uid, entry); }, 1000);
    });
  }

  /** pasta configures the address after it starts: wait until the namespace has it (or fail, closed). */
  private async waitForAddress(path: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      try {
        const { stdout } = await run("nsenter", nsenterArgv(path, ["ip", "-4", "-o", "addr", "show"]), { timeout: 3_000 });
        if (stdout.includes(NETNS_ADDRESS)) return;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("pasta did not configure the network namespace");
  }

  private async unmount(path: string): Promise<void> {
    if (!isMountPoint(path)) return;
    try { await run("umount", [path], { timeout: 5_000 }); } catch { await run("umount", ["-l", path], { timeout: 5_000 }).catch(() => undefined); }
  }

  /** Stop pasta, unmount and delete the user's namespace. Idempotent. */
  async remove(uid: number): Promise<void> {
    const path = netnsPath(uid, this.dir);
    const entry = this.active.get(uid);
    if (entry) { entry.removing = true; entry.pasta?.kill("SIGTERM"); this.active.delete(uid); }
    this.killPidFile(this.pidFile(uid));
    await this.unmount(path);
    rmSync(path, { force: true });
    rmSync(this.pidFile(uid), { force: true });
    rmSync(this.resolvConfPath(uid), { force: true });
  }

  private killPidFile(file: string): void {
    try {
      const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 1 && pidIsOurs(pid)) process.kill(pid, "SIGTERM");
    } catch { /* none */ }
  }

  /** Runtime start: namespaces and pasta daemons from a previous run are meaningless now. */
  async cleanStale(): Promise<void> {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const path = join(this.dir, name);
      if (name.endsWith(".pasta.pid")) this.killPidFile(path);
      await this.unmount(path);
      rmSync(path, { force: true });
    }
  }

  async shutdown(): Promise<void> {
    for (const uid of [...this.active.keys()]) await this.remove(uid);
  }
}
