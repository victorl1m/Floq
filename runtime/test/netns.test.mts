import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  NETNS_DNS, NETNS_GATEWAY, acquireTunnelSlot, duplexFromChild, netnsMode, netnsPath, nextRestart, nftRuleset, nsenterArgv,
  parseAllowList, parseHostAddresses, pastaArgv, procNetTcpPaths, tunnelLimit, resolvConf, tunnelHelperArgv, unshareArgv, wrapLaunch,
} from "../dist/netns.js";
import { listAllListeners, listSessionPorts } from "../dist/ports.js";
import { portIsFreeInNetns } from "../dist/display.js";

test("flag off: the launch is exactly the unwrapped bwrap argv", () => {
  const args = ["--die-with-parent", "--unshare-pid", "--", "setpriv", "--reuid=70001", "claude"];
  assert.deepEqual(wrapLaunch("floq-bwrap", args, undefined), { file: "floq-bwrap", args });
  assert.notEqual(wrapLaunch("floq-bwrap", args, undefined).args, args, "copied, not aliased");
});

test("flag on: nsenter joins the namespace and runs the unchanged bwrap argv; no --unshare-net", () => {
  const args = ["--die-with-parent", "--unshare-pid", "--", "setpriv", "claude"];
  const w = wrapLaunch("floq-bwrap", args, "/run/floq/netns/70001");
  assert.equal(w.file, "nsenter");
  assert.deepEqual(w.args, ["--net=/run/floq/netns/70001", "--", "floq-bwrap", ...args]);
  assert.ok(!w.args.includes("--unshare-net"));
});

test("mode parsing: default off, 1 on, required", () => {
  assert.equal(netnsMode({}), "off");
  assert.equal(netnsMode({ FLOQ_NETNS: "0" }), "off");
  assert.equal(netnsMode({ FLOQ_NETNS: "1" }), "on");
  assert.equal(netnsMode({ FLOQ_NETNS: "required" }), "required");
});

test("namespace path and builders", () => {
  assert.equal(netnsPath(70001), "/run/floq/netns/70001");
  assert.throws(() => netnsPath(-1));
  assert.deepEqual(unshareArgv("/p"), ["--net=/p", "--", "ip", "link", "set", "lo", "up"]);
  assert.deepEqual(nsenterArgv("/p", ["nft", "-f", "-"]), ["--net=/p", "--", "nft", "-f", "-"]);
});

test("pasta argv: attached by path, no inbound forwards, DNS forwarder, host loopback mapped to the gateway", () => {
  const a = pastaArgv({ path: "/run/floq/netns/1", pidFile: "/run/floq/netns/1.pasta.pid" });
  const pair = (k: string) => a[a.indexOf(k) + 1];
  assert.equal(pair("--netns"), "/run/floq/netns/1");
  assert.equal(pair("-t"), "none");
  assert.equal(pair("-u"), "none");
  assert.equal(pair("--map-host-loopback"), NETNS_GATEWAY);
  assert.equal(pair("--gateway"), NETNS_GATEWAY);
  assert.equal(pair("--dns-forward"), NETNS_DNS);
  assert.ok(a.includes("--config-net") && a.includes("--foreground") && a.includes("-4"));
});

test("nft ruleset: default drop, DNS + runtime port only on the gateway, private/metadata ranges dropped", () => {
  const r = nftRuleset({ runtimePort: 8787 });
  assert.match(r, /policy drop;/);
  assert.match(r, new RegExp(`ip daddr ${NETNS_GATEWAY} tcp dport 8787 accept`));
  assert.match(r, new RegExp(`ip daddr ${NETNS_GATEWAY} drop`));
  assert.match(r, new RegExp(`ip daddr ${NETNS_DNS} udp dport 53 accept`));
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]) assert.ok(r.includes(range), range);
  assert.ok(r.indexOf("tcp dport 8787 accept") < r.indexOf(`ip daddr ${NETNS_GATEWAY} drop`), "port accept precedes gateway drop");
  assert.ok(r.indexOf(`${NETNS_GATEWAY} drop`) < r.indexOf("10.0.0.0/8"));
  assert.ok(r.trimEnd().endsWith("}"));
});

test("allow list: validated, inserted before the blocked ranges", () => {
  assert.deepEqual(parseAllowList(" 10.1.2.0/24, 192.168.5.5 ,"), ["10.1.2.0/24", "192.168.5.5"]);
  assert.deepEqual(parseAllowList(undefined), []);
  for (const bad of ["10.0.0.0/33", "300.1.1.1", "1.2.3.4; drop", "::1", "a"]) assert.throws(() => parseAllowList(bad), bad);
  const r = nftRuleset({ runtimePort: 1234, allow: ["10.1.2.0/24"] });
  assert.ok(r.indexOf("10.1.2.0/24") < r.indexOf("10.0.0.0/8"));
  assert.throws(() => nftRuleset({ runtimePort: 0 }));
  assert.throws(() => nftRuleset({ runtimePort: 80, allow: ["1.1.1.1\n}"] }));
});

test("resolv.conf names only the namespace-visible forwarder", () => {
  assert.match(resolvConf(), new RegExp(`^nameserver ${NETNS_DNS}\\n`));
  assert.ok(!resolvConf().includes("127."));
});

test("tunnel helper: nsenter first, then setpriv drops to the user uid, then socat; hosts are validated", () => {
  const drop = ["setpriv", "--reuid=70001", "--regid=70001", "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all"];
  assert.deepEqual(tunnelHelperArgv("/p", 70001, { host: "127.0.0.1", port: 3000 }), { file: "nsenter", args: ["--net=/p", "--", ...drop, "socat", "STDIO", "TCP:127.0.0.1:3000"] });
  assert.deepEqual(tunnelHelperArgv("/p", 70001, { host: "::1", port: 3000 }).args.slice(-1), ["TCP6:[::1]:3000"]);
  assert.throws(() => tunnelHelperArgv("/p", 0, { host: "127.0.0.1", port: 1 }), /uid/);
  assert.throws(() => tunnelHelperArgv("/p", 70001, { host: "127.0.0.1,fork", port: 1 }));
  assert.throws(() => tunnelHelperArgv("/p", 70001, { host: "evil.com", port: 1 }));
  assert.throws(() => tunnelHelperArgv("/p", 70001, { host: "127.0.0.1", port: 70000 }));
});

test("pasta runs with an explicit --runas (default 0) and a pid file", () => {
  const a = pastaArgv({ path: "/p", pidFile: "/p.pid" });
  assert.equal(a[a.indexOf("--runas") + 1], "0");
  assert.equal(pastaArgv({ path: "/p", pidFile: "/p.pid", runas: 65534 })[pastaArgv({ path: "/p", pidFile: "/p.pid", runas: 65534 }).indexOf("--runas") + 1], "65534");
  assert.ok(a.includes("--pid"));
});

test("host addresses: parsed from `ip -o -4 addr`, loopback skipped, dropped by the ruleset after the gateway rules", () => {
  const out = "1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 203.0.114.7/24 brd 1.2.3.255 scope global eth0\n3: eth1    inet 172.17.0.2/16 scope global eth1\n";
  assert.deepEqual(parseHostAddresses(out), ["203.0.114.7/32", "172.17.0.2/32"]);
  assert.deepEqual(parseHostAddresses("garbage"), []);
  const r = nftRuleset({ runtimePort: 8787, hostAddresses: parseHostAddresses(out) });
  assert.ok(r.includes("ip daddr { 203.0.114.7/32, 172.17.0.2/32 } drop"));
  assert.ok(r.indexOf("tcp dport 8787 accept") < r.indexOf("203.0.114.7/32"), "gateway:port allow stays first");
  assert.ok(r.indexOf("203.0.114.7/32") < r.indexOf("meta nfproto ipv4 accept"));
  assert.ok(r.indexOf(`ip daddr ${NETNS_DNS} udp dport 53 accept`) < r.indexOf("203.0.114.7/32"));
  assert.throws(() => nftRuleset({ runtimePort: 80, hostAddresses: ["1.1.1.1; flush ruleset"] }));
});

test("documentation ranges are blocked", () => {
  const r = nftRuleset({ runtimePort: 8787 });
  for (const range of ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"]) assert.ok(r.includes(range), range);
});

test("pasta respawn: counter resets after a stable uptime, gives up after the budget", () => {
  assert.deepEqual(nextRestart(0, 100), { restarts: 1, retry: true });
  assert.deepEqual(nextRestart(4, 100), { restarts: 5, retry: true });
  assert.deepEqual(nextRestart(5, 100), { restarts: 6, retry: false });
  assert.deepEqual(nextRestart(5, 120_000), { restarts: 1, retry: true }, "stable run resets the budget");
});

test("tunnel slots: per-user cap, idempotent release, env override", () => {
  const a = acquireTunnelSlot(900001, 2)!;
  const b = acquireTunnelSlot(900001, 2)!;
  assert.ok(a && b);
  assert.equal(acquireTunnelSlot(900001, 2), null);
  assert.ok(acquireTunnelSlot(900002, 2), "other users are independent");
  a(); a();
  const c = acquireTunnelSlot(900001, 2);
  assert.ok(c, "one slot freed once, despite the double release");
  assert.equal(acquireTunnelSlot(900001, 2), null);
  b(); c!();
  assert.equal(tunnelLimit({}), 32);
  assert.equal(tunnelLimit({ FLOQ_NETNS_TUNNEL_LIMIT: "5" }), 5);
  assert.equal(tunnelLimit({ FLOQ_NETNS_TUNNEL_LIMIT: "x" }), 32);
});

test("port detection reads the session process's net tables with a netns, the host's without", async () => {
  assert.deepEqual(procNetTcpPaths(42), ["/proc/42/net/tcp", "/proc/42/net/tcp6"]);
  assert.throws(() => procNetTcpPaths(0));
  // Real Linux check: this process has no listeners it owns, so both modes simply return an array without throwing.
  assert.ok(Array.isArray(await listSessionPorts(process.pid, true)));
  assert.ok(Array.isArray(await listSessionPorts(process.pid, false)));
  // Namespace on but no pid to read it from: empty, never the host's listeners.
  assert.deepEqual(await listAllListeners(null), []);
  assert.deepEqual(await listSessionPorts(null, true), []);
});

test("display probe in a namespace uses that namespace's listeners", { skip: process.platform !== "linux" }, async () => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await portIsFreeInNetns(process.pid)(port), false);
    assert.equal(await portIsFreeInNetns(process.pid)(port === 65535 ? 65534 : port + 1), true);
    assert.equal(await portIsFreeInNetns(null)(port), false);
  } finally { server.close(); }
});

test("duplexFromChild moves bytes both ways and fails on a bad exit", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill() { return true; } });
  const duplex = duplexFromChild(child as never);
  const got: Buffer[] = [];
  duplex.on("data", (c) => got.push(c));
  child.stdout.write("hello");
  duplex.write("up");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Buffer.concat(got).toString(), "hello");
  assert.equal((child.stdin.read() as Buffer).toString(), "up");
  const failed = new Promise((r) => duplex.once("error", r));
  child.emit("exit", 1);
  assert.match(String(await failed), /exited with 1/);
});
