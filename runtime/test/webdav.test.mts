import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, renameSync, writeFileSync, utimesSync, readFileSync, existsSync, readdirSync, lstatSync, linkSync } from "node:fs";
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
    + "<D:response><D:href>/dav/t/app/</D:href><D:propstat><D:prop><D:displayname>app</D:displayname><D:resourcetype><D:collection/></D:resourcetype><D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified><D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
    + '<D:response><D:href>/dav/t/app/a%20&amp;b.txt</D:href><D:propstat><D:prop><D:displayname>a &amp;b.txt</D:displayname><D:resourcetype/><D:getcontentlength>255</D:getcontentlength><D:getcontenttype>text/plain</D:getcontenttype><D:getetag>"ff-' + Date.UTC(2026, 0, 2, 3, 4, 5).toString(16) + '"</D:getetag><D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified><D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
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

const fixtureDirs = (base) => ({ root: join(base, "home", "app"), other: join(base, "home", "b", "app"), outside: join(base, "outside") });

async function davServer(t, opts = {}) {
  const { base, home } = fixture(t);
  const pool = fakePool();
  const mounts = new DavMounts(pool);
  const activity = [];
  const state = { awake: opts.awake ?? true };
  const shards = { awakeHandle: () => (state.awake ? { mountPath: home } : undefined), driver: { hostPath: (h, rel) => join(base, rel.replace(/^\/home\/a\//, "home/")) } };
  const manager = { withUserShardActivity: async (_u, op) => { activity.push("enter"); try { return await op(); } finally { activity.push("exit"); } } };
  mkdirSync(join(base, "home/b/app"), { recursive: true });
  const dav = new WebDav({ mounts, shards, manager, maxPutBytes: opts.maxPutBytes, writer: { minFreeBytes: 0, minFreeFraction: 0, ...opts.writer } });
  const server = createServer((req, res) => { if (dav.handles(req)) void dav.handle(req, res); else res.writeHead(404).end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const mount = await mounts.create("owner", "sid-1", PROJECT);
  const call = (method, path, headers = {}, payload) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
  return { call, port: server.address().port, mount, mounts, pool, state, activity, base: `/dav/${mount.token}`, fs: fixtureDirs(base) };
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

test("unsupported methods are refused", async (t) => {
  const { call, base } = await davServer(t);
  for (const method of ["POST", "PATCH", "TRACE"]) assert.equal((await call(method, `${base}/app/README.md`)).status, 405, method);
  const options = await call("OPTIONS", `${base}/app/`);
  assert.match(options.headers.allow, /PUT/);
  assert.match(options.headers.allow, /DELETE/);
});

test("MKCOL creates folders; existing, missing parent, bodies and mount roots are refused", async (t) => {
  const { call, base, fs } = await davServer(t);
  assert.equal((await call("MKCOL", `${base}/app/newdir`)).status, 201);
  assert.ok(lstatSync(join(fs.root, "newdir")).isDirectory());
  assert.equal((await call("MKCOL", `${base}/app/newdir`)).status, 405);
  assert.equal((await call("MKCOL", `${base}/app/missing/child`)).status, 409);
  assert.equal((await call("MKCOL", `${base}/app/withbody`, {}, "<x/>")).status, 415);
  assert.equal((await call("MKCOL", `${base}/app`)).status, 405);
  assert.equal((await call("MKCOL", `${base}/newroot`)).status, 404);
  assert.equal((await call("MKCOL", `${base}/app/.git/x`)).status, 404);
  assert.equal((await call("MKCOL", `${base}/app/node_modules`)).status, 404);
  assert.equal((await call("MKCOL", `${base}/app/escape/pwn`)).status, 403, "symlinked folder to outside");
  assert.ok(!existsSync(join(fs.outside, "pwn")));
});

test("PUT creates, overwrites, caps size and leaves no temp files", async (t) => {
  const { call, base, fs } = await davServer(t, { maxPutBytes: 100 });
  const created = await call("PUT", `${base}/app/new.txt`, {}, "hello");
  assert.equal(created.status, 201);
  assert.equal(readFileSync(join(fs.root, "new.txt"), "utf8"), "hello");
  assert.equal((await call("PUT", `${base}/app/new.txt`, {}, "second")).status, 204);
  assert.equal(readFileSync(join(fs.root, "new.txt"), "utf8"), "second");
  assert.equal((await call("PUT", `${base}/app/new.txt`, { "If-None-Match": "*" }, "x")).status, 412);
  assert.equal((await call("PUT", `${base}/app/empty.txt`, {}, "")).status, 201);
  assert.equal(readFileSync(join(fs.root, "empty.txt"), "utf8"), "");
  assert.equal((await call("PUT", `${base}/app/src`, {}, "x")).status, 405, "folders cannot be overwritten");
  assert.equal((await call("PUT", `${base}/app/nodir/f.txt`, {}, "x")).status, 409);
  assert.equal((await call("PUT", `${base}/app/big.bin`, {}, Buffer.alloc(101))).status, 413);
  assert.ok(!existsSync(join(fs.root, "big.bin")));
  assert.deepEqual(readdirSync(fs.root).filter((n) => n.startsWith(".dav-")), []);
  assert.equal((await call("GET", `${base}/app/new.txt`)).body, "second");
});

test("PUT refuses traversal, hidden names, symlink targets and symlink escapes", async (t) => {
  const { call, base, fs } = await davServer(t);
  for (const path of [`${base}/app/..%2foutside%2fx.txt`, `${base}/app/%2e%2e/x.txt`, `${base}/app/a%5cb.txt`, `${base}/app/x%00.txt`, `${base}/app/.git/hook`, `${base}/app/node_modules/x`, `${base}/app/bad%01name`]) {
    const r = await call("PUT", path, {}, "pwn");
    assert.ok([400, 403, 404].includes(r.status), `${path} -> ${r.status}`);
  }
  assert.equal((await call("PUT", `${base}/app/leak.txt`, {}, "pwn")).status, 403, "existing symlink is never written through");
  assert.equal(readFileSync(join(fs.outside, "secret.txt"), "utf8"), "secret");
  assert.equal((await call("PUT", `${base}/app/escape/new.txt`, {}, "pwn")).status, 403);
  assert.ok(!existsSync(join(fs.outside, "new.txt")));
  assert.equal(readFileSync(join(fs.root, "README.md"), "utf8"), "0123456789");
  assert.equal((await call("PUT", `${base}/app/inner.txt`, {}, "pwn")).status, 403, "even a link that stays inside");
});

test("macOS AppleDouble and .DS_Store are accepted and discarded", async (t) => {
  const { call, base, fs } = await davServer(t);
  assert.equal((await call("PUT", `${base}/app/._README.md`, {}, "junk")).status, 201);
  assert.equal((await call("PUT", `${base}/app/.DS_Store`, {}, "junk")).status, 201);
  assert.ok(!existsSync(join(fs.root, "._README.md")) && !existsSync(join(fs.root, ".DS_Store")));
  assert.equal((await call("DELETE", `${base}/app/.DS_Store`)).status, 204);
});

test("MOVE renames files and folders within the mount and checks Destination", async (t) => {
  const { call, base, fs, mount } = await davServer(t);
  const host = "127.0.0.1";
  assert.equal((await call("MOVE", `${base}/app/README.md`, { Destination: `${base}/app/moved.md` })).status, 201);
  assert.ok(existsSync(join(fs.root, "moved.md")) && !existsSync(join(fs.root, "README.md")));
  assert.equal((await call("MOVE", `${base}/app/moved.md`, { Host: "files.test", Destination: `http://files.test${base}/app/src/in.md` })).status, 201, "absolute Destination with the same host");
  assert.equal((await call("MOVE", `${base}/app/src/in.md`, { Host: "files.test", Destination: `http://other.test${base}/app/moved.md` })).status, 502, "other host");
  assert.equal((await call("MOVE", `${base}/app/src/in.md`, { Destination: `${base}/app/moved.md` })).status, 201);
  writeFileSync(join(fs.root, "a.txt"), "A");
  writeFileSync(join(fs.root, "b.txt"), "B");
  assert.equal((await call("MOVE", `${base}/app/a.txt`, { Destination: `${base}/app/b.txt`, Overwrite: "F" })).status, 412);
  assert.equal((await call("MOVE", `${base}/app/a.txt`, { Destination: `${base}/app/b.txt` })).status, 204);
  assert.equal(readFileSync(join(fs.root, "b.txt"), "utf8"), "A");
  assert.equal((await call("MOVE", `${base}/app/src`, { Destination: `${base}/app/src2` })).status, 201);
  assert.ok(existsSync(join(fs.root, "src2", "a.ts")));
  assert.equal((await call("MOVE", `${base}/app/src2`, { Destination: `${base}/app/b.txt` })).status, 412, "never overwrite with a folder");
  assert.equal((await call("MOVE", `${base}/app/b.txt`, { Destination: `${base}/app/src2` })).status, 412, "never overwrite a folder");
  assert.equal((await call("MOVE", `${base}/app/src2`, { Destination: `${base}/app/src2/deeper` })).status, 403, "into itself");
  assert.equal((await call("MOVE", `${base}/app/b.txt`, { Destination: `${base}/app/b.txt` })).status, 403);
  assert.equal((await call("MOVE", `${base}/app/b.txt`, {})).status, 400, "no Destination");
  // Destination must be same host, same token, inside the roots
  const wrongToken = `/dav/${"1".repeat(32)}/app/x.txt`;
  for (const destination of [wrongToken, `${base}/app/../../outside/x.txt`, `${base}/app/escape/x.txt`, `${base}/app/.git/x`, `${base}`, `${base}/app`, `http://evil.example${base}/app/x.txt`, "ftp://%%%", "/etc/passwd"]) {
    const r = await call("MOVE", `${base}/app/b.txt`, { Destination: destination });
    assert.ok([400, 403, 404, 502].includes(r.status), `${destination} -> ${r.status}`);
  }
  assert.ok(existsSync(join(fs.root, "b.txt")) && !existsSync(join(fs.outside, "x.txt")));
  assert.equal((await call("MOVE", `${base}/app/leak.txt`, { Destination: `${base}/app/leak2.txt` })).status, 201, "a link moves as a link");
  assert.equal(readFileSync(join(fs.outside, "secret.txt"), "utf8"), "secret");
  assert.equal((await call("MOVE", `${base}/app/b.txt`, { Destination: `${base}/app%20(2)/b.txt` })).status, 201, "other folder of the mount");
  assert.ok(existsSync(join(fs.other, "b.txt")));
  void mount;
});

test("COPY copies files and folders, honours Overwrite and Depth, skips links", async (t) => {
  const { call, base, fs } = await davServer(t);
  writeFileSync(join(fs.root, "src", "link-target.txt"), "t");
  assert.equal((await call("COPY", `${base}/app/README.md`, { Destination: `${base}/app/copy.md` })).status, 201);
  assert.equal(readFileSync(join(fs.root, "copy.md"), "utf8"), "0123456789");
  assert.ok(existsSync(join(fs.root, "README.md")));
  assert.equal((await call("COPY", `${base}/app/README.md`, { Destination: `${base}/app/copy.md`, Overwrite: "F" })).status, 412);
  writeFileSync(join(fs.root, "x.md"), "new");
  assert.equal((await call("COPY", `${base}/app/x.md`, { Destination: `${base}/app/copy.md` })).status, 204);
  assert.equal(readFileSync(join(fs.root, "copy.md"), "utf8"), "new");
  assert.equal((await call("COPY", `${base}/app/src`, { Destination: `${base}/app/srccopy` })).status, 201);
  assert.equal(readFileSync(join(fs.root, "srccopy", "a.ts"), "utf8"), "export {};\n");
  assert.equal((await call("COPY", `${base}/app/src`, { Destination: `${base}/app/shallow`, Depth: "0" })).status, 201);
  assert.deepEqual(readdirSync(join(fs.root, "shallow")), []);
  assert.equal((await call("COPY", `${base}/app/src`, { Destination: `${base}/app/srccopy` })).status, 412, "no overwriting folders");
  assert.equal((await call("COPY", `${base}/app/src`, { Destination: `${base}/app/src/in` })).status, 403);
  assert.equal((await call("COPY", `${base}/app/leak.txt`, { Destination: `${base}/app/leakcopy.txt` })).status, 403, "links are not copied");
  assert.equal((await call("COPY", `${base}/app/escape`, { Destination: `${base}/app/escapecopy` })).status, 403);
  assert.ok(!existsSync(join(fs.root, "escapecopy")) && !existsSync(join(fs.root, "leakcopy.txt")));
  assert.equal((await call("COPY", `${base}/app/nothere`, { Destination: `${base}/app/z` })).status, 404);
  assert.deepEqual(readdirSync(fs.root).filter((n) => n.startsWith(".dav-")), []);
});

test("DELETE removes files and folders recursively, never through links or the mount root", async (t) => {
  const { call, base, fs } = await davServer(t);
  assert.equal((await call("DELETE", `${base}/app/README.md`)).status, 204);
  assert.ok(!existsSync(join(fs.root, "README.md")));
  assert.equal((await call("DELETE", `${base}/app/README.md`)).status, 404);
  assert.equal((await call("DELETE", `${base}/app/src`)).status, 204);
  assert.ok(!existsSync(join(fs.root, "src")));
  assert.equal((await call("DELETE", `${base}/app/leak.txt`)).status, 204, "removes the link");
  assert.equal((await call("DELETE", `${base}/app/escape`)).status, 204, "removes the folder link only");
  assert.equal(readFileSync(join(fs.outside, "secret.txt"), "utf8"), "secret");
  assert.ok(existsSync(fs.outside));
  assert.equal((await call("DELETE", `${base}/app`)).status, 403, "mount root");
  assert.equal((await call("DELETE", `${base}`)).status, 403);
  assert.equal((await call("DELETE", `${base}/app/.git`)).status, 404);
  assert.equal((await call("DELETE", `${base}/app/..%2f..%2foutside`)).status, 400);
  assert.ok(existsSync(fs.root));
});

test("PROPPATCH answers 207 without storing, 404 for missing resources", async (t) => {
  const { call, base } = await davServer(t);
  const body = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32LastModifiedTime>Mon, 01 Jan 2026 00:00:00 GMT</Z:Win32LastModifiedTime></D:prop></D:set></D:propertyupdate>';
  const ok = await call("PROPPATCH", `${base}/app/README.md`, {}, body);
  assert.equal(ok.status, 207);
  assert.match(ok.body, /xmlns:Z="urn:schemas-microsoft-com:"/);
  assert.match(ok.body, /<Z:Win32LastModifiedTime\/>/);
  assert.match(ok.body, /200 OK/);
  assert.equal((await call("PROPPATCH", `${base}/app/nothing.txt`, {}, body)).status, 404);
});

test("LOCK / UNLOCK: exclusive lock, enforcement through the If header, refresh, lock-null creation", async (t) => {
  const { call, base, fs } = await davServer(t);
  const lockBody = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>me &amp; you</D:href></D:owner></D:lockinfo>';
  const locked = await call("LOCK", `${base}/app/README.md`, { Timeout: "Second-120", Depth: "0" }, lockBody);
  assert.equal(locked.status, 200);
  const token = /<(opaquelocktoken:[0-9a-f-]{36})>/.exec(locked.headers["lock-token"])[1];
  assert.match(locked.body, /Second-1[12]\d/);
  assert.match(locked.body, /<D:exclusive\/>/);
  assert.equal((await call("LOCK", `${base}/app/README.md`, {}, lockBody)).status, 423, "second lock");
  assert.equal((await call("PUT", `${base}/app/README.md`, {}, "x")).status, 423);
  assert.equal((await call("DELETE", `${base}/app/README.md`)).status, 423);
  assert.equal((await call("MOVE", `${base}/app/README.md`, { Destination: `${base}/app/r.md` })).status, 423);
  assert.equal((await call("PUT", `${base}/app/README.md`, { If: `(<${token}>)` }, "locked-write")).status, 204);
  assert.equal(readFileSync(join(fs.root, "README.md"), "utf8"), "locked-write");
  assert.equal((await call("LOCK", `${base}/app/README.md`, { If: `(<${token}>)`, Timeout: "Second-300" })).status, 200, "refresh");
  assert.equal((await call("UNLOCK", `${base}/app/README.md`, { "Lock-Token": "<opaquelocktoken:00000000-0000-4000-8000-000000000000>" })).status, 409);
  assert.equal((await call("UNLOCK", `${base}/app/README.md`)).status, 400);
  assert.equal((await call("UNLOCK", `${base}/app/README.md`, { "Lock-Token": `<${token}>` })).status, 204);
  assert.equal((await call("PUT", `${base}/app/README.md`, {}, "free")).status, 204);
  const fresh = await call("LOCK", `${base}/app/office.docx`, {}, lockBody);
  assert.equal(fresh.status, 201, "lock-null creates an empty file");
  assert.ok(existsSync(join(fs.root, "office.docx")));
  // A folder lock (depth infinity) covers children and blocks removing the folder
  const dirLock = await call("LOCK", `${base}/app/src`, {}, lockBody);
  assert.equal(dirLock.status, 200);
  assert.equal((await call("PUT", `${base}/app/src/new.ts`, {}, "x")).status, 423);
  assert.equal((await call("LOCK", `${base}/app/src/a.ts`, {}, lockBody)).status, 423);
  assert.equal((await call("DELETE", `${base}/app/src`)).status, 423);
  assert.equal((await call("LOCK", `${base}/app/.git/x`, {}, lockBody)).status, 404);
});

test("writes keep working only while the shard is awake and the mount is live", async (t) => {
  const { call, base, state, mounts } = await davServer(t);
  state.awake = false;
  assert.equal((await call("PUT", `${base}/app/x.txt`, {}, "x")).status, 503);
  state.awake = true;
  assert.equal((await call("PUT", `${base}/app/x.txt`, {}, "x")).status, 201);
  mounts.revokeSession("sid-1");
  assert.equal((await call("PUT", `${base}/app/y.txt`, {}, "x")).status, 404, "revoked");
  assert.equal((await call("MKCOL", `${base}/app/z`)).status, 404);
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

const swapForLink = (dir, name, target) => { rmSync(join(dir, name), { recursive: true, force: true }); symlinkSync(target, join(dir, name), "dir"); };

test("COPY of a folder never follows a subfolder swapped for a link mid-walk", async (t) => {
  let swapped = false;
  const ctx = await davServer(t, { writer: { onEntry: (dir, name) => { if (name === "sub" && dir.endsWith("/big") && !swapped) { swapped = true; swapForLink(dir, "sub", join(ctx.fs.outside)); } } } });
  const { call, base, fs } = ctx;
  mkdirSync(join(fs.root, "big", "sub"), { recursive: true });
  writeFileSync(join(fs.root, "big", "sub", "f.txt"), "f");
  writeFileSync(join(fs.root, "big", "top.txt"), "top");
  const res = await call("COPY", `${base}/app/big`, { Destination: `${base}/app/bigcopy` });
  assert.ok(swapped);
  assert.equal(res.status, 201);
  assert.equal(readFileSync(join(fs.root, "bigcopy", "top.txt"), "utf8"), "top");
  assert.ok(!existsSync(join(fs.root, "bigcopy", "sub", "secret.txt")), "outside files are not copied");
  assert.ok(!readdirSync(join(fs.root, "bigcopy")).includes("sub"), "the link is skipped");
  assert.equal(readFileSync(join(fs.outside, "secret.txt"), "utf8"), "secret");
});

test("DELETE of a folder never follows a subfolder swapped for a link mid-walk", async (t) => {
  let swapped = false;
  const ctx = await davServer(t, { writer: { onEntry: (dir, name) => { if (name === "sub" && dir.endsWith("/big") && !swapped) { swapped = true; swapForLink(dir, "sub", ctx.fs.outside); } } } });
  const { call, base, fs } = ctx;
  mkdirSync(join(fs.root, "big", "sub"), { recursive: true });
  writeFileSync(join(fs.root, "big", "sub", "f.txt"), "f");
  const res = await call("DELETE", `${base}/app/big`);
  assert.ok(swapped);
  assert.equal(res.status, 204);
  assert.ok(!existsSync(join(fs.root, "big")));
  assert.equal(readFileSync(join(fs.outside, "secret.txt"), "utf8"), "secret", "the link target survives");
});

test("writes: 507 when free space is short, COPY byte budget, If-None-Match exclusivity, per-user concurrency cap", async (t) => {
  const low = await davServer(t, { writer: { minFreeBytes: Number.MAX_SAFE_INTEGER } });
  assert.equal((await low.call("PUT", `${low.base}/app/new.txt`, { "Content-Length": "3" }, "abc")).status, 507);
  assert.equal((await low.call("COPY", `${low.base}/app/src`, { Destination: `${low.base}/app/srccopy` })).status, 507);
  assert.ok(!existsSync(join(low.fs.root, "srccopy")), "rolled back");
  assert.equal((await low.call("COPY", `${low.base}/app/README.md`, { Destination: `${low.base}/app/r2.md` })).status, 507);
  assert.deepEqual(readdirSync(low.fs.root).filter((n) => n.startsWith(".dav-")), []);

  const ok = await davServer(t);
  assert.equal((await ok.call("PUT", `${ok.base}/app/n.txt`, { "If-None-Match": "*" }, "one")).status, 201);
  assert.equal((await ok.call("PUT", `${ok.base}/app/n.txt`, { "If-None-Match": "*" }, "two")).status, 412);
  assert.equal(readFileSync(join(ok.fs.root, "n.txt"), "utf8"), "one");

  const cap = await davServer(t, { writer: { maxConcurrentWrites: 1 } });
  // Hold one PUT open (body unfinished): a second write by the same user is turned away.
  const req = request({ host: "127.0.0.1", port: cap.port, method: "PUT", path: `${cap.base}/app/slow.txt`, headers: { "Content-Length": "10" } });
  req.on("error", () => {});
  req.write("abc");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await cap.call("PUT", `${cap.base}/app/other.txt`, {}, "x")).status, 429);
  req.destroy();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await cap.call("PUT", `${cap.base}/app/other.txt`, {}, "x")).status, 201, "slot released");
});

test("concurrent writes share the free-space reserve instead of each getting the whole room", async (t) => {
  const ctx = await davServer(t, { writer: { freeBytes: () => 100 } });
  writeFileSync(join(ctx.fs.root, "forty.bin"), "x".repeat(40));
  const hold = request({ host: "127.0.0.1", port: ctx.port, method: "PUT", path: `${ctx.base}/app/a.bin`, headers: { "Content-Length": "70" } });
  hold.on("error", () => {});
  hold.write("abc");
  t.after(() => hold.destroy());
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await ctx.call("PUT", `${ctx.base}/app/b.bin`, { "Content-Length": "40" }, "x".repeat(40))).status, 507, "70 held + 40 > 100");
  assert.equal((await ctx.call("COPY", `${ctx.base}/app/forty.bin`, { Destination: `${ctx.base}/app/forty2.bin` })).status, 507, "COPY draws on the same reserve");
  assert.ok(!existsSync(join(ctx.fs.root, "forty2.bin")));
  assert.equal((await ctx.call("PUT", `${ctx.base}/app/c.bin`, { "Content-Length": "30" }, "x".repeat(30))).status, 201, "70 held + 30 fits");
  assert.equal((await ctx.call("COPY", `${ctx.base}/app/README.md`, { Destination: `${ctx.base}/app/r2.md` })).status, 201, "a finished write gave its bytes back");
  hold.destroy();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await ctx.call("PUT", `${ctx.base}/app/b.bin`, { "Content-Length": "100" }, "x".repeat(100))).status, 201, "the held reservation was released");
  assert.deepEqual(readdirSync(ctx.fs.root).filter((n) => n.startsWith(".dav-")), []);
});

test("MOVE with Overwrite:F is exclusive against a creator that races the check", async (t) => {
  let raced = false;
  const ctx = await davServer(t, { writer: { beforeMove: (_src, dst) => { if (!raced) { raced = true; writeFileSync(dst, "winner"); } } } });
  writeFileSync(join(ctx.fs.root, "a.txt"), "A");
  const res = await ctx.call("MOVE", `${ctx.base}/app/a.txt`, { Destination: `${ctx.base}/app/b.txt`, Overwrite: "F" });
  assert.ok(raced);
  assert.equal(res.status, 412);
  assert.equal(readFileSync(join(ctx.fs.root, "b.txt"), "utf8"), "winner", "the racing file is not clobbered");
  assert.equal(readFileSync(join(ctx.fs.root, "a.txt"), "utf8"), "A", "the source stays");
  assert.equal((await ctx.call("MOVE", `${ctx.base}/app/a.txt`, { Destination: `${ctx.base}/app/c.txt`, Overwrite: "F" })).status, 201);
  assert.ok(existsSync(join(ctx.fs.root, "c.txt")) && !existsSync(join(ctx.fs.root, "a.txt")), "an uncontested move still moves");
});

test("COPY rollback is capped, and COPY skips files the sandbox user does not own", async (t) => {
  const { copyDirectory, TreeBudget } = await import("../dist/davTree.js");
  const { base } = fixture(t);
  const src = join(base, "tree");
  mkdirSync(src);
  for (let i = 0; i < 6; i++) writeFileSync(join(src, `f${i}.txt`), "x");
  // 3 entries copied, the 4th trips the budget; the rollback may visit only 2 entries, so one file is left (the rest is the agent's).
  await assert.rejects(copyDirectory(src, join(base, "capped"), undefined, false, new TreeBudget({ maxEntries: 3, rollbackMaxEntries: 2 })), { status: 413 });
  assert.equal(readdirSync(join(base, "capped")).length, 1, "rollback stopped at its cap");
  // Unbounded default rollback removes everything.
  await assert.rejects(copyDirectory(src, join(base, "full"), undefined, false, new TreeBudget({ maxEntries: 3 })), { status: 413 });
  assert.ok(!existsSync(join(base, "full")));

  const me = process.getuid();
  try { linkSync(join(src, "f0.txt"), join(base, "hard.txt")); } catch { /* no hard links */ }
  await copyDirectory(src, join(base, "foreign"), undefined, false, new TreeBudget({ sourceUid: me + 1 }));
  assert.deepEqual(readdirSync(join(base, "foreign")), [], "files owned by someone else (root, a host file behind a hard link) are skipped");
  await copyDirectory(src, join(base, "own"), undefined, false, new TreeBudget({ sourceUid: me }));
  assert.equal(readdirSync(join(base, "own")).length, 6, "the sandbox user's own files are copied");
});
