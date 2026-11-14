import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIPv4, isIPv6 } from "node:net";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { log } from "./logger.js";

/**
 * Per-user network namespace for agent sandboxes (FLOQ_NETNS, default REQUIRED on the linux shard driver).
 * See runtime/README.md. With mode off nothing in this file runs and the sandbox argv is byte-identical to the
 * shared-network launch (wrapLaunch is the identity without a netns path).
 *
 *   FLOQ_NETNS unset/required  on, and the runtime refuses to start when the startup probe fails (fail fast)
 *   FLOQ_NETNS=1               on: one persistent netns per user uid; falls back to off (loud log) if the probe fails
 *   FLOQ_NETNS=off|0           off: sandboxes share the runtime's network (single-tenant / trusted hosts only)
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

/** Unset (or anything unrecognised) is "required": isolation is the default, sharing the network needs an explicit opt-out. */
export function netnsMode(env: NodeJS.ProcessEnv = process.env): NetnsMode {
  const raw = env.FLOQ_NETNS?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no" || raw === "disabled") return "off";
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return "on";
  return "required";
}

/** Actionable text for a failed startup probe in mode required (what is missing, and the explicit opt-out). */
export function netnsRequiredMessage(detail: string): string {
  return "Per-user network isolation (FLOQ_NETNS, on by default) is unavailable on this host: " + detail +
    ". Requirements: a Linux kernel with network namespaces and nftables, CAP_SYS_ADMIN + CAP_NET_ADMIN for the runtime container" +
    " (see runtime/docker-compose.yml), and the tools unshare, nsenter, setpriv, socat, nft, ip and floq-pasta (passt) in the image." +
    " Fix the host, or set FLOQ_NETNS=off to let all agent sandboxes share one network (only acceptable on a single-tenant or fully trusted host)." +
    " FLOQ_NETNS=1 keeps isolation when available and logs a fallback instead of refusing to start.";
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

/** pasta attached to an existing namespace by path: no inbound or loopback-outbound forwards, static addressing, DNS forwarder, IPv4 only. */
export function pastaArgv(o: PastaOptions): string[] {
  return [
    "--foreground", "--quiet", "-4",
    "--netns", o.path,
    "--config-net",
    "--address", NETNS_ADDRESS,
    "--netmask", String(NETNS_PREFIX),
    "--gateway", NETNS_GATEWAY,
    // -t/-u none: no inbound. -T/-U none: pasta's outbound default (auto) would mirror every port the runtime container listens on
    // onto the tenant's 127.0.0.1, so a tenant could reach the runtime API/DB-adjacent listeners over its own loopback. The tenant's
    // loopback stays its own; the runtime is reachable only on the gateway (--map-host-loopback), where the nft ruleset allows one port.
    "-t", "none", "-u", "none", "-T", "none", "-U", "none",
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
  /**
   * The host's own PUBLIC egress addresses (FLOQ_HOST_PUBLIC_IPS + auto-detection). A tenant reaching them hairpins back into the
   * host's published services (databases, panels), so IPv4 ones are dropped like hostAddresses. IPv6 entries are accepted and
   * validated but need no rule: the namespace drops all IPv6 already.
   */
  publicAddresses?: readonly string[];
}

export const DEFAULT_PUBLIC_IP_URL = "https://api.ipify.org";
export const DEFAULT_PUBLIC_IP_REFRESH_S = 300;
/** Retry quickly while no address has ever been detected (and none is configured). */
export const PUBLIC_IP_RETRY_S = 30;

/** Strictly validated host public addresses (comma separated IPv4/IPv6 literals, no CIDRs): throws on anything else. */
export function parsePublicIps(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isIPv4(item) && !isIPv6(item)) throw new Error("FLOQ_HOST_PUBLIC_IPS: not an IPv4/IPv6 address: " + item.slice(0, 40));
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** The IP-echo URL (FLOQ_HOST_PUBLIC_IP_URL). null = auto-detection disabled ("off"/"0"/empty-with-off); invalid values throw. */
export function publicIpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FLOQ_HOST_PUBLIC_IP_URL?.trim();
  if (!raw) return DEFAULT_PUBLIC_IP_URL;
  if (["off", "0", "false", "no", "disabled", "none"].includes(raw.toLowerCase())) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("FLOQ_HOST_PUBLIC_IP_URL: not a URL: " + raw.slice(0, 60)); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("FLOQ_HOST_PUBLIC_IP_URL must be http(s)");
  return raw;
}

/** Body of an IP-echo service -> a single IP literal, or null (HTML error pages, empty bodies and multi-line junk are rejected). */
export function parseIpEcho(body: string): string | null {
  const v = body.trim();
  return v.length <= 45 && (isIPv4(v) || isIPv6(v)) ? v : null;
}

/** Ask an IP-echo URL for the egress address. Never throws: null on timeout, HTTP error or a body that is not an IP. */
export async function detectPublicIp(url: string, timeoutMs = 4_000, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  // A ref'd timer (AbortSignal.timeout is unref'd, so a stalled fetch could let the process exit or a test loop drain mid-await).
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: abort.signal, redirect: "error", headers: { accept: "text/plain" } });
    if (!res.ok) return null;
    return parseIpEcho((await res.text()).slice(0, 200));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  const publicV4 = (o.publicAddresses ?? []).filter((a) => !a.includes(":"));
  for (const a of o.publicAddresses ?? []) if (!isIPv4(a) && !isIPv6(a)) throw new Error("invalid public address");
  const dropHosts = [...new Set([...hostAddresses, ...publicV4.map((a) => a + "/32")])].filter((a) => a !== NETNS_ADDRESS + "/32");
  const lines = [
    // add + delete + define in one transaction: applies cleanly the first time and atomically replaces the table on a refresh.
    "add table inet floq_egress",
    "delete table inet floq_egress",
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
  if (dropHosts.length) lines.push(`    ip daddr { ${dropHosts.join(", ")} } drop`);
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
    return comm.includes("pasta") || comm.includes("passt");
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
  startedAt: number;
  /** pasta kept failing and was given up on: the namespace has no connectivity until it is re-created. */
  unhealthy: boolean;
  timer: NodeJS.Timeout | null;
}

export interface NetnsOptions {
  dir?: string;
  runtimePort: number;
  allow?: readonly string[];
  mode: Exclude<NetnsMode, "off">;
  /** Where per-user resolv.conf files live (any root-only directory that survives wake/sleep). */
  metaDir: string;
  /** pasta binary (default floq-pasta). */
  pastaBin?: string;
  /** uid pasta runs as (default 0; see PastaOptions.runas). */
  pastaUid?: number;
  /** Host public addresses (default FLOQ_HOST_PUBLIC_IPS). */
  publicIps?: readonly string[];
  /** IP-echo URL for auto-detection (default FLOQ_HOST_PUBLIC_IP_URL / api.ipify.org; null disables). */
  publicIpUrl?: string | null;
  /** Detector override (tests). */
  detectIp?: (url: string) => Promise<string | null>;
  /** Seconds between re-detections (default FLOQ_HOST_PUBLIC_IP_REFRESH_SECS / 300). */
  publicIpRefreshSecs?: number;
}

/** Default uid for pasta: FLOQ_NETNS_PASTA_UID (0 keeps root) or "nobody". */
function envPastaUid(): number {
  const raw = process.env.FLOQ_NETNS_PASTA_UID?.trim();
  if (raw && /^\d{1,9}$/.test(raw)) return Number(raw);
  return 65534;
}

/** pasta restarts: at most this many in a row; the counter resets once a pasta has stayed up STABLE_MS. */
export const PASTA_MAX_RESTARTS = 5;
export const PASTA_STABLE_MS = 60_000;

/** Pure respawn decision: restart count after an exit, and whether to try again. */
export function nextRestart(restarts: number, uptimeMs: number, max = PASTA_MAX_RESTARTS, stableMs = PASTA_STABLE_MS): { restarts: number; retry: boolean } {
  const base = uptimeMs >= stableMs ? 0 : restarts;
  return { restarts: base + 1, retry: base < max };
}

/** Creates, supervises and removes the per-user namespaces. All methods are safe to call concurrently. */
export class NetnsManager {
  private readonly dir: string;
  private readonly active = new Map<number, Active>();
  private readonly pending = new Map<number, Promise<string>>();
  private enabled = true;
  /** uid pasta actually runs as: resolved at init (dedicated unprivileged uid when it works, 0 only as a logged fallback). */
  private pastaUid: number;
  private readonly configuredIps: string[];
  private readonly echoUrl: string | null;
  private detectedIp: string | null = null;
  private ipTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: NetnsOptions) {
    this.dir = options.dir ?? NETNS_DIR;
    this.pastaUid = options.pastaUid ?? envPastaUid();
    parseAllowList((options.allow ?? []).join(","));
    this.configuredIps = options.publicIps ? parsePublicIps(options.publicIps.join(",")) : parsePublicIps(process.env.FLOQ_HOST_PUBLIC_IPS);
    this.echoUrl = options.publicIpUrl !== undefined ? options.publicIpUrl : publicIpUrl();
  }

  /** Every host public address currently dropped: the configured ones plus the detected egress address. */
  publicAddresses(): string[] {
    return [...new Set([...this.configuredIps, ...(this.detectedIp ? [this.detectedIp] : [])])];
  }

  /** One detection round. On a changed address the rules of every live namespace are re-applied. Returns whether the set changed. */
  async refreshPublicIp(): Promise<boolean> {
    if (!this.echoUrl) return false;
    const found = await (this.options.detectIp ?? ((u: string) => detectPublicIp(u)))(this.echoUrl);
    if (!found) {
      log.warn("netns.public_ip_detect_failed", { url: this.echoUrl.slice(0, 80), known: this.detectedIp, configured: this.configuredIps.length });
      return false;
    }
    if (found === this.detectedIp) return false;
    const before = this.publicAddresses().join(",");
    this.detectedIp = found;
    if (this.publicAddresses().join(",") === before) return false;
    log.info("netns.public_ip_changed", { address: found });
    for (const [uid, entry] of this.active) {
      if (entry.removing) continue;
      try { await this.applyRules(entry.path); } catch (error) { log.error("netns.public_ip_reapply_failed", { uid, error: String(error).slice(0, 160) }); }
    }
    return true;
  }

  private startPublicIpRefresh(): void {
    if (!this.echoUrl || this.ipTimer || this.stopped) return;
    const secs = this.options.publicIpRefreshSecs ?? (Number.parseInt(process.env.FLOQ_HOST_PUBLIC_IP_REFRESH_SECS ?? "", 10) || DEFAULT_PUBLIC_IP_REFRESH_S);
    const tick = (): void => {
      const wait = this.detectedIp || this.configuredIps.length ? secs : Math.min(secs, PUBLIC_IP_RETRY_S);
      this.ipTimer = setTimeout(() => {
        this.ipTimer = null;
        void this.refreshPublicIp().catch(() => undefined).finally(() => { if (!this.stopped) tick(); });
      }, wait * 1000);
      this.ipTimer.unref();
    };
    tick();
  }

  get isEnabled(): boolean { return this.enabled; }

  resolvConfPath(uid: number): string { return join(this.options.metaDir, uid + ".netns-resolv.conf"); }

  /** False when the user's namespace is missing or its pasta was given up on (launches must then fail, never run offline). */
  isHealthy(uid: number): boolean {
    const e = this.active.get(uid);
    return Boolean(e && !e.removing && !e.unhealthy);
  }

  /**
   * Startup: remove leftovers, then REALLY exercise the whole stack on a throwaway namespace (unshare, nft rules, pasta
   * configuring the address) and tear it down. Disables netns (loud log) or, in mode required, throws on any failure.
   * Must run after ShardService.reconcile(): nothing sandboxed is running yet, so stale namespaces are safe to remove.
   */
  async init(): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o755 });
      await this.cleanStale();
      for (const [tool, args] of [["socat", ["-V"]], ["nsenter", ["--version"]], ["setpriv", ["--version"]]] as const) await run(tool, [...args], { timeout: 5_000 });
      // Learn the host's public egress address first so the probe and the first user namespaces already drop it.
      await this.refreshPublicIp();
      if (!this.publicAddresses().length) log.warn("netns.public_ip_unknown", { message: "no host public address known (set FLOQ_HOST_PUBLIC_IPS): tenants may reach the host's published services through its public IP" });
      this.startPublicIpRefresh();
      const probe = join(this.dir, "probe");
      const probePasta = async (): Promise<void> => {
        const entry = this.newEntry(probe);
        try {
          await this.bringUp(probe, join(this.dir, "probe.pasta.pid"), entry);
        } finally {
          entry.removing = true;
          await this.teardown(probe, join(this.dir, "probe.pasta.pid"), entry);
        }
      };
      try {
        await probePasta();
      } catch (error) {
        // pasta parses sandbox-controlled packets, so it should not stay root. Only when the unprivileged run fails
        // (and no uid was configured) do we fall back to root, loudly, rather than losing the namespace.
        if (this.pastaUid === 0 || this.options.pastaUid !== undefined || process.env.FLOQ_NETNS_PASTA_UID) throw error;
        log.warn("netns.pasta_unprivileged_failed", { uid: this.pastaUid, error: String(error).slice(0, 160), message: "falling back to running pasta as root" });
        this.pastaUid = 0;
        await probePasta();
      }
      log.info("netns.ready", { dir: this.dir, publicAddresses: this.publicAddresses().length });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n").slice(0, 2).join(" | ") : String(error);
      if (this.options.mode === "required") throw new Error(netnsRequiredMessage(detail));
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

  private newEntry(path: string): Active {
    return { path, pasta: null, removing: false, restarts: 0, startedAt: 0, unhealthy: false, timer: null };
  }

  private async create(uid: number): Promise<string> {
    const path = netnsPath(uid, this.dir);
    const existing = this.active.get(uid);
    // Reuse only a healthy namespace whose pasta is alive (or being respawned within its retry budget).
    if (existing && !existing.removing && !existing.unhealthy && (existing.pasta?.exitCode === null || existing.timer) && isMountPoint(path)) return path;
    await this.remove(uid);
    const entry = this.newEntry(path);
    this.active.set(uid, entry);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o755 });
      await this.bringUp(path, this.pidFile(uid), entry);
      writeFileSync(this.resolvConfPath(uid), resolvConf(), { mode: 0o644 });
      log.info("netns.created", { uid });
      return path;
    } catch (error) {
      await this.remove(uid);
      throw error;
    }
  }

  /** unshare + lo + egress rules + pasta, then wait for pasta's address. Used for user namespaces and the startup probe. */
  private async bringUp(path: string, pidFile: string, entry: Active): Promise<void> {
    writeFileSync(path, "", { mode: 0o444 });
    await run("unshare", unshareArgv(path), { timeout: 10_000 });
    await this.applyRules(path);
    this.startPasta(path, pidFile, entry);
    await this.waitForAddress(path, entry);
  }

  /** The container's own IPv4 addresses (re-read each time: they can change across restarts). */
  private async hostAddresses(): Promise<string[]> {
    try {
      const { stdout } = await run("ip", ["-o", "-4", "addr", "show"], { timeout: 3_000 });
      return parseHostAddresses(stdout);
    } catch (error) {
      // Failing open here would leave the container's public address reachable: fail the namespace instead.
      throw new Error("cannot list the runtime's own addresses: " + String(error).slice(0, 120));
    }
  }

  private async applyRules(path: string): Promise<void> {
    const ruleset = nftRuleset({ runtimePort: this.options.runtimePort, allow: this.options.allow, hostAddresses: await this.hostAddresses(), publicAddresses: this.publicAddresses() });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("nsenter", nsenterArgv(path, ["nft", "-f", "-"]), { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr?.on("data", (c: Buffer) => { err += c.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("nft failed: " + err.slice(0, 200)))));
      child.stdin?.end(ruleset);
    });
  }

  private pidFile(uid: number): string { return join(this.dir, uid + ".pasta.pid"); }

  private startPasta(path: string, pidFile: string, entry: Active): void {
    entry.timer = null;
    const bin = this.options.pastaBin ?? (process.env.FLOQ_PASTA_BIN?.trim() || PASTA_BIN);
    if (this.pastaUid !== 0) {
      // pasta writes its pid file after dropping to this uid: hand it the (root-created) file first.
      try { writeFileSync(pidFile, "", { mode: 0o644 }); chownSync(pidFile, this.pastaUid, this.pastaUid); } catch (error) { log.warn("netns.pidfile_chown_failed", { error: String(error).slice(0, 120) }); }
    }
    const child = spawn(bin, pastaArgv({ path, pidFile, runas: this.pastaUid }), { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => { if (err.length < 400) err += c.toString(); });
    entry.pasta = child;
    entry.startedAt = Date.now();
    child.on("error", (e) => log.error("netns.pasta_error", { path, error: e.message }));
    child.on("exit", (code, signal) => {
      if (entry.removing || entry.pasta !== child) return;
      log.error("netns.pasta_exited", { path, code, signal, stderr: err.slice(0, 300) });
      const next = nextRestart(entry.restarts, Date.now() - entry.startedAt);
      entry.restarts = next.restarts;
      if (!next.retry) {
        entry.unhealthy = true;
        log.error("netns.pasta_gave_up", { path, message: "pasta keeps failing; the user's namespace is offline until it is re-created (sandbox launches fail until then)" });
        return;
      }
      entry.timer = setTimeout(() => {
        if (entry.removing) return;
        // A dead pasta leaves its address behind only if the tap device outlived it: flush so --config-net can set it again.
        void run("nsenter", nsenterArgv(path, ["ip", "-4", "addr", "flush", "scope", "global"]), { timeout: 3_000 })
          .catch(() => undefined)
          .then(() => { if (!entry.removing) this.startPasta(path, pidFile, entry); });
      }, 1000);
    });
  }

  /** pasta configures the address after it starts: wait until the namespace has it (or fail, closed). */
  private async waitForAddress(path: string, entry: Active): Promise<void> {
    for (let i = 0; i < 40; i++) {
      if (entry.pasta && entry.pasta.exitCode !== null && !entry.timer) break;
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

  private async teardown(path: string, pidFile: string, entry: Active | undefined, resolv?: string): Promise<void> {
    if (entry) { entry.removing = true; if (entry.timer) clearTimeout(entry.timer); entry.timer = null; entry.pasta?.kill("SIGTERM"); }
    this.killPidFile(pidFile);
    await this.unmount(path);
    rmSync(path, { force: true });
    rmSync(pidFile, { force: true });
    if (resolv) rmSync(resolv, { force: true });
  }

  /** Stop pasta, unmount and delete the user's namespace. Idempotent. */
  async remove(uid: number): Promise<void> {
    const entry = this.active.get(uid);
    this.active.delete(uid);
    await this.teardown(netnsPath(uid, this.dir), this.pidFile(uid), entry, this.resolvConfPath(uid));
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
    this.stopped = true;
    if (this.ipTimer) clearTimeout(this.ipTimer);
    this.ipTimer = null;
    for (const uid of [...this.active.keys()]) await this.remove(uid);
  }
}
