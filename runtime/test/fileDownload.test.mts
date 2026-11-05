import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadLinks, DOWNLOAD_LINK_TTL_MS } from "../dist/downloadLinks.js";
import { WorkspaceFiles, contentDisposition, openWithin, parseRange } from "../dist/workspaceFiles.js";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "floq-dl-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "home", "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, "src", "node_modules"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "deep", "b.txt"), "bee\n");
  writeFileSync(join(root, "src", "node_modules", "nested.js"), "nested\n");
  writeFileSync(join(root, "README.md"), "0123456789");
  writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(root, ".git", "config"), "[remote]\n");
  writeFileSync(join(root, "node_modules", "dep", "x.js"), "x\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  return { base, root, outside };
}

function trySymlink(target, path, type) {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}

function service(base, activity) {
  const manager = {
    get: async (_id, userId) => { if (userId !== "owner") throw Object.assign(new Error("nope"), { status: 404 }); return { cwd: "workspace" }; },
    withUserShardActivity: async (_user, op) => { activity.push("enter"); try { return await op(); } finally { activity.push("exit"); } },
  };
  const shards = { wake: async () => ({ mountPath: join(base, "home") }), driver: { hostPath: (h, rel) => join(h.mountPath, rel) } };
  return new WorkspaceFiles(manager, shards);
}

async function serve(t, files, userId = "owner") {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    files.download(userId, "s", url.searchParams.get("path"), res, req.headers.range).catch((error) => {
      if (!res.headersSent) res.writeHead(error.status ?? 500, { "Content-Type": "application/json" }).end(JSON.stringify({ code: error.code }));
      else res.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}/?path=${encodeURIComponent(path)}`, init.signal ? init : { headers: init });
}

test("download links: sign, tamper, expiry, single use, revocation", () => {
  let now = 1_000_000;
  const links = new DownloadLinks("a-secret-that-is-long-enough-for-tests", () => now);
  const issue = (over = {}) => links.issue({ userId: "u", authSessionId: "sid", sessionId: "s", path: "src/a.ts", ...over }).token;
  const claims = links.redeem(issue());
  assert.deepEqual([claims?.u, claims?.s, claims?.p], ["u", "s", "src/a.ts"]);
  const token = issue();
  assert.ok(links.redeem(token));
  assert.equal(links.redeem(token), null, "single use");
  const fresh = issue();
  const [payload, sig] = fresh.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), p: ".ssh/id" })).toString("base64url");
  assert.equal(links.redeem(`${forged}.${sig}`), null, "tampered payload");
  assert.equal(links.redeem(`${payload}.${sig.slice(0, -2)}AA`), null, "tampered signature");
  assert.equal(new DownloadLinks("another-secret-another-secret-123456", () => now).redeem(fresh), null, "other secret");
  for (const junk of [undefined, "", "abc", "a.b.c", 5, "x".repeat(5000)]) assert.equal(links.redeem(junk), null);
  assert.ok(links.redeem(fresh));
  const late = issue();
  now += DOWNLOAD_LINK_TTL_MS + 1;
  assert.equal(links.redeem(late), null, "expired");
  const revokedBySession = issue();
  links.revokeSession("sid");
  assert.equal(links.redeem(revokedBySession), null, "sign-out revokes the auth session");
  const otherSession = links.issue({ userId: "u", authSessionId: "sid2", sessionId: "s", path: "" }).token;
  assert.ok(links.redeem(otherSession));
  const beforeUserRevoke = links.issue({ userId: "v", authSessionId: "sid3", sessionId: "s", path: "" }).token;
  links.revokeUser("v");
  assert.equal(links.redeem(beforeUserRevoke), null, "user revocation");
});

test("contentDisposition sanitises and parseRange handles edge cases", () => {
  const header = contentDisposition('a"b\r\nc\\d/é%.txt');
  assert.ok(!/[\r\n]/.test(header));
  assert.ok(header.startsWith('attachment; filename="a_b__c_d_'));
  assert.ok(header.includes("filename*=UTF-8''"));
  assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=5-99", 10), { start: 5, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "invalid");
  assert.equal(parseRange("bytes=-0", 10), "invalid");
  assert.equal(parseRange("bytes=0-1,3-4", 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test("downloads a file with attachment headers, Range, and no size cap", async (t) => {
  const { base, root } = fixture(t);
  writeFileSync(join(root, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  const activity = [];
  const get = await serve(t, service(base, activity));
  const full = await get("README.md");
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  assert.equal(full.headers.get("content-type"), "application/octet-stream");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("content-length"), "10");
  assert.match(full.headers.get("content-disposition") ?? "", /^attachment; filename="README.md"/);
  const html = await get("page.html");
  assert.equal(html.headers.get("content-type"), "application/octet-stream", "never rendered in the app origin");
  await html.arrayBuffer();
  const part = await get("README.md", { Range: "bytes=2-4" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");
  const bad = await get("README.md", { Range: "bytes=50-" });
  assert.equal(bad.status, 416);
  await bad.arrayBuffer();
  const big = await get("big.bin");
  assert.equal((await big.arrayBuffer()).byteLength, 3 * 1024 * 1024);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(activity.filter((a) => a === "enter").length, activity.filter((a) => a === "exit").length);
  assert.ok(activity.length >= 2);
});

test("download refuses traversal, .git, missing paths and other users", async (t) => {
  const { base } = fixture(t);
  const get = await serve(t, service(base, []));
  for (const [path, status] of [["../outside/secret.txt", 400], [".git/config", 400], ["src/.git", 400], ["nope.txt", 404]]) {
    const response = await get(path);
    assert.equal(response.status, status, path);
    await response.arrayBuffer();
  }
  const stranger = await serve(t, service(base, []), "stranger");
  assert.ok((await stranger("README.md")).status >= 400);
  await assert.rejects(service(base, []).authorizeDownload("stranger", "s", "README.md"));
  assert.equal(await service(base, []).authorizeDownload("owner", "s", "src//a.ts"), "src/a.ts");
  await assert.rejects(service(base, []).authorizeDownload("owner", "s", "../x"), { code: "invalid_file_path" });
});

test("download refuses symlinks that escape the workspace", async (t) => {
  const { base, root, outside } = fixture(t);
  const get = await serve(t, service(base, []));
  const dirLink = trySymlink(outside, join(root, "escape"), "dir");
  const fileLink = trySymlink(join(outside, "secret.txt"), join(root, "secret-link.txt"), "file");
  if (!dirLink && !fileLink) return t.skip("symlinks unavailable");
  if (dirLink) for (const path of ["escape", "escape/secret.txt"]) { const r = await get(path); assert.equal(r.status, 400, path); await r.arrayBuffer(); }
  if (fileLink) { const r = await get("secret-link.txt"); assert.equal(r.status, 400); await r.arrayBuffer(); }
});

test("openWithin checks the opened descriptor, so a directory swapped for a symlink after the check is refused", async (t) => {
  const { root, outside } = fixture(t);
  mkdirSync(join(root, "swap"));
  writeFileSync(join(root, "swap", "inner.txt"), "inside\n");
  writeFileSync(join(outside, "inner.txt"), "OUTSIDE\n");
  const realRoot = (await import("node:fs/promises")).realpath(root);
  const checked = join(await realRoot, "swap", "inner.txt");
  // Path was validated while "swap" was a real directory; now the agent replaces it.
  renameSync(join(root, "swap"), join(root, "swap-moved"));
  if (!trySymlink(outside, join(root, "swap"), "dir")) return t.skip("symlinks unavailable");
  await assert.rejects(openWithin(await realRoot, checked), { code: "invalid_file_path" });
  const ok = await openWithin(await realRoot, join(await realRoot, "swap-moved", "inner.txt"));
  await ok.close();
});

const ZIP_SCRIPT = "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nif len(sys.argv)>2: sys.stdout.write(z.read(sys.argv[2]).decode())\nelse: print('\\n'.join(z.namelist()))";
const hasUnzip = (() => { try { execFileSync("python3", ["-I", "-c", "import zipfile"], { stdio: "ignore" }); return true; } catch { return false; } })();
const zipNames = (path) => execFileSync("python3", ["-I", "-c", ZIP_SCRIPT, path], { encoding: "utf8" }).split("\n").filter(Boolean);
const zipRead = (path, name) => execFileSync("python3", ["-I", "-c", ZIP_SCRIPT, path, name], { encoding: "utf8" });

test("downloads a folder as a zip without .git, node_modules at any depth, or escaping links", { skip: !hasUnzip && "python3 zipfile unavailable" }, async (t) => {
  const { base, root, outside } = fixture(t);
  trySymlink(join(outside, "secret.txt"), join(root, "src", "leak.txt"), "file");
  trySymlink(join(root, "README.md"), join(root, "src", "inner-link.txt"), "file");
  trySymlink(outside, join(root, "src", "dir-link"), "dir");
  const activity = [];
  const get = await serve(t, service(base, activity));
  const response = await get("");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /filename="workspace\.zip"/);
  const zipPath = join(base, "out.zip");
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  const names = zipNames(zipPath).sort();
  assert.ok(names.includes("workspace/src/a.ts"));
  assert.ok(names.includes("workspace/src/deep/b.txt"));
  assert.ok(names.includes("workspace/README.md"));
  assert.ok(names.includes("workspace/empty/"));
  assert.ok(names.includes("workspace/src/inner-link.txt"), "symlink to a file inside the root is included");
  assert.ok(!names.some((n) => /(^|\/)(\.git|node_modules)(\/|$)/.test(n)), names.join(","));
  assert.ok(!names.some((n) => n.includes("leak") || n.includes("dir-link") || n.includes("secret")), names.join(","));
  assert.equal(zipRead(zipPath, "workspace/src/a.ts"), "export const a = 1;\n");
  const sub = await get("src/deep");
  writeFileSync(zipPath, Buffer.from(await sub.arrayBuffer()));
  assert.deepEqual(zipNames(zipPath), ["deep/b.txt"]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(activity.includes("enter") && activity.at(-1) === "exit");
});

test("shard activity is held for the whole stream and released if the client disconnects", async (t) => {
  const { base, root } = fixture(t);
  writeFileSync(join(root, "huge.bin"), Buffer.alloc(40 * 1024 * 1024, 1));
  const activity = [];
  const get = await serve(t, service(base, activity));
  const controller = new AbortController();
  const response = await get("huge.bin", { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  assert.deepEqual(activity, ["enter"], "still streaming: shard must stay unlocked");
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(activity, ["enter", "exit"]);
});
