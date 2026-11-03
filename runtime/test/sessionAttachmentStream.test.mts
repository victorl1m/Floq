import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { SessionManager } from "../dist/manager.js";
import { formatBytes, streamToFile, validAttachmentName } from "../dist/attachments.js";

function managerFor(home: string) {
  const manager = Object.create(SessionManager.prototype);
  manager.live = new Map([["session-1", { userId: "owner-1" }]]);
  const handle = { mountPath: home, uid: process.getuid?.() ?? 1000 };
  manager.shards = { driver: { hostPath: (_h, relative) => join(home, relative), homePath: () => "/home/agent" } };
  manager.withUserShardActivity = async (_userId, operation) => operation(handle);
  return manager;
}

test("attachment names must be a single safe path component", () => {
  for (const bad of ["", ".", "..", "a/b", "a\\b", "bad\nname", "nul\u0000", "x".repeat(256), 5, null, undefined]) assert.equal(validAttachmentName(bad), false, String(bad));
  for (const good of ["PRODUCAO.zip", "quote's file.bin", "résumé.pdf", ".env"]) assert.equal(validAttachmentName(good), true, good);
});

test("formats byte sizes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(8 * 1024 ** 3), "8 GiB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5 MiB");
});

test("streamToFile writes the body and enforces the byte cap, deleting partial files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "floq-stream-"));
  try {
    const ok = join(dir, "ok.bin");
    assert.equal(await streamToFile(Readable.from([Buffer.alloc(10, 1), Buffer.alloc(5, 2)]), ok, 100, 15), 15);
    assert.equal(statSync(ok).size, 15);

    const big = join(dir, "big.bin");
    await assert.rejects(streamToFile(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), big, 100, null), { status: 413 });
    assert.equal(existsSync(big), false);

    const declared = join(dir, "declared.bin");
    await assert.rejects(streamToFile(Readable.from([Buffer.alloc(1)]), declared, 100, 101), { status: 413 });
    assert.equal(existsSync(declared), false);

    const short = join(dir, "short.bin");
    await assert.rejects(streamToFile(Readable.from([Buffer.alloc(5)]), short, 100, 10), { status: 400 });
    assert.equal(existsSync(short), false);

    const empty = join(dir, "empty.bin");
    await assert.rejects(streamToFile(Readable.from([]), empty, 100, null), { status: 400 });
    assert.equal(existsSync(empty), false);

    const aborted = join(dir, "aborted.bin");
    const source = new PassThrough();
    const pending = streamToFile(source, aborted, 100, null);
    source.write(Buffer.alloc(5));
    source.destroy();
    await assert.rejects(pending, { status: 400 });
    assert.equal(existsSync(aborted), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamed attachment upload checks ownership and name, then lands beside the base64 path", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-attachment-stream-"));
  try {
    const manager = managerFor(home);
    const upload = SessionManager.prototype.uploadSessionAttachmentStream;
    const options = { maxBytes: 1024, contentLength: 4 };
    await assert.rejects(upload.call(manager, "session-1", "another-user", "a.txt", Readable.from([Buffer.from("data")]), options));
    await assert.rejects(upload.call(manager, "session-1", "owner-1", "../a.txt", Readable.from([Buffer.from("data")]), options));

    const result = await upload.call(manager, "session-1", "owner-1", "PRODUCAO.zip", Readable.from([Buffer.from("da"), Buffer.from("ta")]), options);
    assert.equal(result.size, 4);
    assert.match(result.path, /^\/home\/agent\/\.floq\/attachments\/[\w-]+\/PRODUCAO\.zip$/);
    const directory = join(home, ".floq", "attachments", result.path.split("/").at(-2)!);
    assert.deepEqual(readdirSync(directory), ["PRODUCAO.zip"]);
    assert.equal(readFileSync(join(directory, "PRODUCAO.zip"), "utf8"), "data");
    assert.equal(statSync(join(directory, "PRODUCAO.zip")).mode & 0o777, 0o600);

    await assert.rejects(upload.call(manager, "session-1", "owner-1", "big.bin", Readable.from([Buffer.alloc(2000)]), { maxBytes: 1024, contentLength: null }), { status: 413 });
    const directories = readdirSync(join(home, ".floq", "attachments"));
    assert.equal(directories.length, 1, "failed upload removes its directory");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
