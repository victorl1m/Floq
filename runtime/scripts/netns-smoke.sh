#!/usr/bin/env bash
# Smoke test for FLOQ_NETNS (per-user network namespaces). NOT run in CI: needs root, CAP_SYS_ADMIN, and the image tools
# (unshare, nsenter, pasta, nft, socat, ip, python3). Run inside the runtime container or on a Linux host:
#   cd runtime && npm run build && sudo scripts/netns-smoke.sh
# Env: SMOKE_PUBLIC_HOST (default example.com), SMOKE_DB_PORT (default 5432: expected to be BLOCKED on the gateway).
set -u
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
[ -f dist/netns.js ] || { echo "run npm run build first"; exit 2; }
for t in unshare nsenter pasta nft socat ip python3 node; do command -v "$t" >/dev/null || { echo "missing tool: $t"; exit 2; }; done

RUNTIME_PORT=${SMOKE_RUNTIME_PORT:-18787}
DB_PORT=${SMOKE_DB_PORT:-5432}
PUBLIC_HOST=${SMOKE_PUBLIC_HOST:-example.com}
A=70001; B=70002
DIR=$(mktemp -d /run/floq-netns-smoke.XXXXXX)
PASS=0; FAIL=0
ok()   { echo "PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
refuse() { local name=$1; shift; if "$@" >/dev/null 2>&1; then bad "$name (unexpectedly succeeded)"; else ok "$name"; fi; }
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  node --input-type=module -e "
    import { NetnsManager } from './dist/netns.js';
    const m = new NetnsManager({ mode: 'on', dir: '$DIR/ns', runtimePort: $RUNTIME_PORT, metaDir: '$DIR' });
    await m.cleanStale();" 2>/dev/null
  rm -rf "$DIR"
}
trap cleanup EXIT

# 1. Fake "runtime" on host loopback, and a fake "db" listener (must stay unreachable from the namespaces).
python3 -m http.server "$RUNTIME_PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 & PIDS+=($!)
python3 -m http.server "$DB_PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 & PIDS+=($!)
sleep 1

# 2. Create both namespaces through the real manager (unshare + nft + pasta).
mkdir -p "$DIR/ns"
node --input-type=module -e "
  import { NetnsManager } from './dist/netns.js';
  const m = new NetnsManager({ mode: 'on', dir: '$DIR/ns', runtimePort: $RUNTIME_PORT, metaDir: '$DIR' });
  await m.init();
  if (!m.isEnabled) { console.error('netns probe failed'); process.exit(1); }
  console.log(await m.ensure($A)); console.log(await m.ensure($B));
  console.log('idempotent:', (await m.ensure($A)) === '$DIR/ns/$A');
  setInterval(() => {}, 1000);   // keep pasta supervised until killed
" > "$DIR/mgr.log" 2>&1 & PIDS+=($!)
for _ in $(seq 40); do [ -e "$DIR/ns/$B" ] && grep -q idempotent "$DIR/mgr.log" && break; sleep 0.5; done
grep -q idempotent "$DIR/mgr.log" || { cat "$DIR/mgr.log"; echo "namespaces were not created"; exit 1; }
NA="$DIR/ns/$A"; NB="$DIR/ns/$B"
inA() { nsenter --net="$NA" -- "$@"; }
inB() { nsenter --net="$NB" -- "$@"; }

# 3. Isolation: a listener (TCP and abstract unix socket) in B is not reachable from A.
nsenter --net="$NB" -- python3 -c '
import socket,time
s=socket.socket(); s.bind(("127.0.0.1",9001)); s.listen(5)
u=socket.socket(socket.AF_UNIX); u.bind("\0/tmp/.X11-unix/X101"); u.listen(5)
time.sleep(60)' & PIDS+=($!)
sleep 1
check  "B reaches its own loopback listener"      inB socat -T2 /dev/null TCP:127.0.0.1:9001
refuse "A cannot reach B's loopback port"          inA socat -T2 /dev/null TCP:127.0.0.1:9001
check  "B reaches its own abstract socket"         inB socat -T2 /dev/null ABSTRACT-CONNECT:/tmp/.X11-unix/X101
refuse "A cannot reach B's abstract X socket"      inA socat -T2 /dev/null ABSTRACT-CONNECT:/tmp/.X11-unix/X101
refuse "A cannot reach the host loopback directly" inA socat -T2 /dev/null TCP:127.0.0.1:"$RUNTIME_PORT"
inA python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",9001))' >/dev/null 2>&1 && ok "A can bind a port B holds (separate namespaces)" || bad "A cannot bind 9001"

# 4. Gateway: only the runtime port; the db port and everything else on the gateway is dropped.
GW=10.255.255.1
check  "runtime port reachable via the gateway"    inA python3 -c "import urllib.request;urllib.request.urlopen('http://$GW:$RUNTIME_PORT/',timeout=3)"
refuse "db port blocked on the gateway"            inA socat -T2 /dev/null TCP:$GW:"$DB_PORT"

# 5. Egress policy.
refuse "cloud metadata 169.254.169.254 blocked"    inA socat -T2 /dev/null TCP:169.254.169.254:80
refuse "RFC1918 192.168.1.1 blocked"               inA socat -T2 /dev/null TCP:192.168.1.1:80
refuse "RFC1918 10.0.0.1 blocked"                  inA socat -T2 /dev/null TCP:10.0.0.1:80
refuse "CGNAT 100.64.0.1 blocked"                  inA socat -T2 /dev/null TCP:100.64.0.1:80
check  "DNS resolves through the forwarder"        inA python3 -c "import socket;socket.setdefaulttimeout(3);socket.getaddrinfo('$PUBLIC_HOST',80)"
check  "outbound internet works"                   inA python3 -c "import urllib.request;urllib.request.urlopen('https://$PUBLIC_HOST/',timeout=8)"

# 6. Tunnel helper (what server.ts uses): socat in the namespace reaches the user's own listener.
echo ping | nsenter --net="$NB" -- socat -T2 STDIO TCP:127.0.0.1:9001 >/dev/null 2>&1 && ok "tunnel helper connects inside the namespace" || bad "tunnel helper"

echo; echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = 0 ]
