import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/manager.js";

function managerFor(home: string, uid = process.getuid?.() ?? 1000) {
  const manager = Object.create(SessionManager.prototype);
  manager.live = new Map([["session-1", { userId: "owner-1" }]]);
  const handle = { mountPath: home, uid };
  manager.shards = { driver: {
    hostPath: (_handle, relativePath) => join(home, relativePath),
    homePath: () => "/home/agent",
  } };
  manager.withUserShardActivity = async (_userId, operation) => operation(handle);
  return manager;
}

test("attachment upload validates names, ownership, base64, and size before writing", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-attachment-validation-"));
  try {
    const manager = managerFor(home);
    const upload = SessionManager.prototype.uploadSessionAttachment;
    await assert.rejects(upload.call(manager, "session-1", "another-user", "a.txt", Buffer.from("x").toString("base64")));
    await assert.rejects(upload.call(manager, "session-1", "owner-1", "../a.txt", Buffer.from("x").toString("base64")));
    await assert.rejects(upload.call(manager, "session-1", "owner-1", "bad\nname.txt", Buffer.from("x").toString("base64")));
    await assert.rejects(upload.call(manager, "session-1", "owner-1", "a.txt", "not base64!"));
    await assert.rejects(upload.call(manager, "session-1", "owner-1", "a.txt", Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64")));

    let reachedStorage = false;
    manager.withUserShardActivity = async (_userId, _operation) => {
      reachedStorage = true;
      return { path: "/home/agent/.floq/attachments/test/large.bin", size: 4 * 1024 * 1024 };
    };
    const validMaxSize = await upload.call(manager, "session-1", "owner-1", "large.bin", Buffer.alloc(4 * 1024 * 1024, 0x5a).toString("base64"));
    assert.equal(reachedStorage, true);
    assert.equal(validMaxSize.size, 4 * 1024 * 1024);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("attachment upload writes private, owned bytes outside the checkout and returns the container path", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-attachment-write-"));
  try {
    const manager = managerFor(home);
    const data = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    const result = await SessionManager.prototype.uploadSessionAttachment.call(
      manager,
      "session-1",
      "owner-1",
      "quote's file.bin",
      data.toString("base64"),
    );
    assert.equal(result.size, data.length);
    assert.match(result.path, /^\/home\/agent\/\.floq\/attachments\/[\w-]+\/quote's file\.bin$/);
    const diskPath = join(home, ".floq", "attachments", result.path.split("/").at(-2)!, "quote's file.bin");
    assert.deepEqual(readFileSync(diskPath), data);
    const stat = lstatSync(diskPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, process.getuid?.());
    const duplicateName = await SessionManager.prototype.uploadSessionAttachment.call(
      manager,
      "session-1",
      "owner-1",
      "quote's file.bin",
      Buffer.from("second upload").toString("base64"),
    );
    assert.notEqual(duplicateName.path, result.path);

    const outside = mkdtempSync(join(tmpdir(), "floq-attachment-outside-"));
    try {
      const linkedHome = mkdtempSync(join(tmpdir(), "floq-attachment-link-"));
      try {
        const { symlinkSync } = await import("node:fs");
        symlinkSync(outside, join(linkedHome, ".floq"), "dir");
        const linkedManager = managerFor(linkedHome);
        await assert.rejects(SessionManager.prototype.uploadSessionAttachment.call(linkedManager, "session-1", "owner-1", "escape.txt", Buffer.from("x").toString("base64")));
      } finally {
        rmSync(linkedHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
