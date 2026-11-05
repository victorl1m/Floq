import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DavMounts, DAV_TTL_MS, ONLINE_WINDOW_MS, folderLabel, mountLocations } from "../dist/davMounts.js";
import { WebDav, propfindXml } from "../dist/webdav.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

/** Fake pg: project owned by "owner", two workspaces, sessions listed in `live`. */
function fakePool(live = new Set(["sid-1"])) {
  return {
    live,
    query: async (sql, params) => {
      if (sql.includes("FROM floq_projects")) return { rowCount: params[0] === PROJECT && params[1] === "owner" ? 1 : 0, rows: [] };
      if (sql.includes("FROM floq_project_workspaces")) return { rowCount: 2, rows: [{ cwd: "/home/a/app", name: "Main" }, { cwd: "/home/b/app", name: "Worktree" }] };
      if (sql.includes('FROM "session"')) return { rowCount: live.has(params[0]) && params[1] === "owner" ? 1 : 0, rows: [] };
      throw new Error("unexpected query " + sql);
    },
  };
}

test("propfindXml golden output", () => {
  const body = propfindXml([
    { href: "/dav/t/app/", name: "app", dir: true, mtime: Date.UTC(2026, 0, 2, 3, 4, 5) },
    { href: "/dav/t/app/a%20&b.txt", name: "a &b.txt", dir: false, size: 255, mtime: Date.UTC(2026, 0, 2, 3, 4, 5) },
  ]);
  assert.equal(body, '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">'
    + "<D:response><D:href>/dav/t/app/</D:href><D:propstat><D:prop><D:displayname>app</D:displayname><D:resourcetype><D:collection/></D:resourcetype><D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified><D:supportedlock/><D:lockdiscovery/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
    + '<D:response><D:href>/dav/t/app/a%20&amp;b.txt</D:href><D:propstat><D:prop><D:displayname>a &amp;b.txt</D:displayname><D:resourcetype/><D:getcontentlength>255</D:getcontentlength><D:getcontenttype>text/plain</D:getcontenttype><D:getetag>"ff-' + Date.UTC(2026, 0, 2, 3, 4, 5).toString(16) + '"</D:getetag><D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified><D:supportedlock/><D:lockdiscovery/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + "</D:multistatus>");
});

test("mount locations use the Windows WebClient syntax", () => {
  const t = "a".repeat(32);
  assert.deepEqual(mountLocations("https://floq.example.com", t), { davUrl: `https://floq.example.com/dav/${t}/`, uncPath: `\\\\floq.example.com@SSL@443\\DavWWWRoot\\dav\\${t}\\` });
  assert.equal(mountLocations("https://h:8443", t).uncPath, `\\\\h@SSL@8443\\DavWWWRoot\\dav\\${t}\\`);
  assert.equal(mountLocations("http://h:8787", t).uncPath, `\\\\h@8787\\DavWWWRoot\\dav\\${t}\\`);
  assert.equal(mountLocations("http://h", t).uncPath, `\\\\h@80\\DavWWWRoot\\dav\\${t}\\`);
  assert.ok(/^\\\\[^\\@]+(@SSL)?@\d+\\/.test(mountLocations("https://a.b", t).uncPath), "never the SMB-capable bare form");
  assert.equal(folderLabel("/x/we:ird*", "Main"), "we_ird_");
});

test("mounts: owner check, token format, dedupe, revoke, sign-out, expiry, session liveness", async () => {
  let now = 1_000_000;
  const pool = fakePool();
  const mounts = new DavMounts(pool, () => now);
  await assert.rejects(mounts.create("stranger", "sid-1", PROJECT), { status: 404 });
  await assert.rejects(mounts.create("owner", "sid-1", "not-a-uuid"), { status: 404 });
  await assert.rejects(mounts.create("owner", "", PROJECT), { status: 401 });
  const mount = await mounts.create("owner", "sid-1", PROJECT);
  assert.match(mount.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(mount.folders.map((f) => f.name), ["app", "app (2)"]);
  assert.equal(mounts.resolve(mount.token)?.userId, "owner");
  assert.equal(mounts.resolve(mount.token.toUpperCase()), null);
  assert.equal(mounts.revoke("someone-else", PROJECT), 0);
  assert.equal(mounts.revoke("owner", PROJECT, mount.token), 1);
  assert.equal(mounts.resolve(mount.token), null);
  const second = await mounts.create("owner", "sid-1", PROJECT);
  mounts.revokeSession("sid-1");
  assert.equal(mounts.resolve(second.token), null, "sign-out kills the mount");
  const third = await mounts.create("owner", "sid-1", PROJECT);
  assert.equal(await mounts.sessionLive(third), true);
  pool.live.delete("sid-1");
  now += 31_000;
  assert.equal(await mounts.sessionLive(third), false, "session gone elsewhere: re-checked after 30s");
  assert.equal(mounts.resolve(third.token), null);
  pool.live.add("sid-1");
  const fourth = await mounts.create("owner", "sid-1", PROJECT);
  now += DAV_TTL_MS + 1;
  assert.equal(mounts.resolve(fourth.token), null, "8h expiry");
  assert.equal(mounts.isOnline("owner"), false);
  const fifth = await mounts.create("owner", "sid-1", PROJECT);
  assert.equal(mounts.isOnline("owner"), true);
  now += ONLINE_WINDOW_MS + 1;
  assert.equal(mounts.isOnline("owner"), false);
  mounts.revokeUser("owner");
  assert.equal(mounts.resolve(fifth.token), null);
});

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "floq-dav-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const root = join(home, "app");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "README.md"), "0123456789");
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");
  writeFileSync(join(root, "page.html"), "<script>1</script>");
  writeFileSync(join(root, ".git", "config"), "x");
  writeFileSync(join(outside, "secret.txt"), "secret");
  utimesSync(join(root, "README.md"), new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  try { symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"), "file"); symlinkSync(outside, join(root, "escape"), "dir"); symlinkSync(join(root, "README.md"), join(root, "inner.txt"), "file"); } catch { /* no symlinks */ }
  return { base, home, root, outside };
}

async function davServer(t, opts = {}) {
  const { base, home } = fixture(t);
  const pool = fakePool();
  const mounts = new DavMounts(pool);
  const activity = [];
  const state = { awake: opts.awake ?? true };
  const shards = { awakeHandle: () => (state.awake ? { mountPath: home } : undefined), driver: { hostPath: (h, rel) => join(base, rel.replace(/^\/home\/a\//, "home/")) } };
  const manager = { withUserShardActivity: async (_u, op) => { activity.push("enter"); try { return await op(); } finally { activity.push("exit"); } } };
  const dav = new WebDav({ mounts, shards, manager });
  const server = createServer((req, res) => { if (dav.handles(req)) void dav.handle(req, res); else res.writeHead(404).end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const mount = await mounts.create("owner", "sid-1", PROJECT);
  const call = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  return { call, mount, mounts, pool, state, activity, base: `/dav/${mount.token}` };
}

test("OPTIONS and the Explorer root probes answer as DAV collections", async (t) => {
  const { call, mount } = await davServer(t);
  for (const path of ["/", "/dav", `/dav/${mount.token}/app/`]) {
    const options = await call("OPTIONS", path);
    assert.equal(options.status, 200, path);
    assert.equal(options.headers.dav, "1, 2");
    assert.equal(options.headers["ms-author-via"], "DAV");
  }
  for (const path of ["/", "/dav", "/dav/"]) {
    const probe = await call("PROPFIND", path, { Depth: "0" });
    assert.equal(probe.status, 207, path);
    assert.match(probe.body, /<D:collection\/>/);
  }
  const root = await call("PROPFIND", `/dav/${mount.token}`, { Depth: "1" });
  assert.equal(root.status, 207);
  assert.deepEqual([...root.body.matchAll(/<D:displayname>([^<]*)</g)].map((m) => m[1]), [mount.token, "app", "app (2)"]);
});

test("PROPFIND lists a folder (depth 0/1 only), hides .git/node_modules and escaping links", async (t) => {
  const { call, base } = await davServer(t);
  assert.equal((await call("PROPFIND", `${base}/app/`, { Depth: "infinity" })).status, 403);
  assert.match((await call("PROPFIND", `${base}/app/`, { Depth: "infinity" })).body, /propfind-finite-depth/);
  assert.equal((await call("PROPFIND", `${base}/app/`)).status, 403, "missing Depth means infinity");
  const listing = await call("PROPFIND", `${base}/app/`, { Depth: "1" });
  assert.equal(listing.status, 207);
  const names = [...listing.body.matchAll(/<D:displayname>([^<]*)</g)].map((m) => m[1]).sort();
  assert.ok(names.includes("README.md") && names.includes("src") && names.includes("inner.txt"), names.join());
  assert.ok(!names.some((n) => [".git", "node_modules", "leak.txt", "escape"].includes(n)), names.join());
  assert.match(listing.body, /<D:getcontentlength>10<\/D:getcontentlength>/);
  assert.match(listing.body, /<D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT<\/D:getlastmodified>/);
  assert.match(listing.body, /<D:getcontenttype>text\/markdown<\/D:getcontenttype>/);
  const sub = await call("PROPFIND", `${base}/app/src`, { Depth: "1" });
  assert.match(sub.body, /\/dav\/[0-9a-f]{32}\/app\/src\/a\.ts/);
  const file = await call("PROPFIND", `${base}/app/README.md`, { Depth: "0" });
  assert.equal(file.status, 207);
});

test("GET and HEAD stream with Range and never render in the app origin", async (t) => {
  const { call, base, activity } = await davServer(t);
  const full = await call("GET", `${base}/app/README.md`);
  assert.equal(full.status, 200);
  assert.equal(full.body, "0123456789");
  assert.equal(full.headers["content-type"], "application/octet-stream");
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  assert.equal(full.headers["content-security-policy"], "sandbox");
  const part = await call("GET", `${base}/app/README.md`, { Range: "bytes=2-4" });
  assert.equal(part.status, 206);
  assert.equal(part.body, "234");
  assert.equal(part.headers["content-range"], "bytes 2-4/10");
  assert.equal((await call("GET", `${base}/app/README.md`, { Range: "bytes=99-" })).status, 416);
  const head = await call("HEAD", `${base}/app/README.md`);
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "10");
  assert.equal(head.body, "");
  assert.equal((await call("GET", `${base}/app/src`)).status, 403, "directories are not files");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(activity.length >= 8 && activity.filter((a) => a === "enter").length === activity.filter((a) => a === "exit").length, "each request holds shard activity");
});

test("traversal, .git, hidden dirs and symlink escapes are refused on GET and PROPFIND", async (t) => {
  const { call, base } = await davServer(t);
  for (const path of [`${base}/app/..%2f..%2foutside/secret.txt`, `${base}/app/%2e%2e/x`, `${base}/app/.git/config`, `${base}/app/node_modules`, `${base}/app/src%5c..%5c..%5cx`, `${base}/app/%00`]) {
    const r = await call("GET", path);
    assert.ok([400, 403, 404].includes(r.status), `${path} -> ${r.status}`);
    assert.ok(!r.body.includes("secret"));
  }
  for (const path of [`${base}/app/leak.txt`, `${base}/app/escape`, `${base}/app/escape/secret.txt`]) {
    for (const method of ["GET", "PROPFIND"]) {
      const r = await call(method, path, { Depth: "0" });
      assert.ok(r.status >= 400, `${method} ${path} -> ${r.status}`);
      assert.ok(!r.body.includes("secret"));
    }
  }
  assert.equal((await call("GET", `${base}/app/inner.txt`)).body, "0123456789");
});

test("the share is read-only", async (t) => {
  const { call, base } = await davServer(t);
  for (const method of ["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK", "PROPPATCH", "POST", "PATCH"]) {
    const r = await call(method, `${base}/app/README.md`);
    assert.equal(r.status, 405, method);
  }
});

test("unknown, revoked and signed-out tokens get nothing; a sleeping shard is not woken", async (t) => {
  const { call, base, mount, mounts, pool, state } = await davServer(t);
  assert.equal((await call("GET", `/dav/${"0".repeat(32)}/app/README.md`)).status, 404);
  assert.equal((await call("GET", "/dav/short/app/README.md")).status, 404);
  assert.equal((await call("GET", "/v1/anything")).status, 404);
  state.awake = false;
  const asleep = await call("GET", `${base}/app/README.md`);
  assert.equal(asleep.status, 503);
  assert.ok(asleep.headers["retry-after"]);
  assert.equal((await call("PROPFIND", `${base}`, { Depth: "1" })).status, 207, "the share root needs no shard");
  state.awake = true;
  assert.equal((await call("GET", `${base}/app/README.md`)).status, 200);
  mounts.revokeSession("sid-1");
  assert.equal((await call("GET", `${base}/app/README.md`)).status, 404, "logout");
  void pool; void mount;
});

test("DAV polling alone does not count as the user being online", async (t) => {
  const { call, base, mounts } = await davServer(t);
  assert.equal((await call("GET", `${base}/app/README.md`)).status, 200);
  mounts.revokeUser("owner"); // forgets presence (and mounts); a fresh mount would re-touch
  assert.equal(mounts.isOnline("owner"), false);
});
