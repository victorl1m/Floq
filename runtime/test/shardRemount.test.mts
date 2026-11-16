import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encryptSecret } from "../dist/crypto.js";
import { ShardService } from "../dist/shards.js";

test("wake remounts a home whose mount died while the shard was awake", async () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-remount-"));
  try {
    const encryptionKey = randomBytes(32);
    const row = { uid: 20000, data_key_enc: encryptSecret(encryptionKey, randomBytes(32).toString("hex"), "shard:u1") };
    const pool = { query: async (sql: string) => ({ rows: sql.startsWith("SELECT uid") ? [row] : [] }) };
    let alive = true;
    let wakes = 0;
    const driver = {
      name: "linux",
      wake: async () => { wakes += 1; alive = true; return { userId: "u1", uid: 20000, mountPath: temp }; },
      isAlive: () => alive,
    };
    const config = { encryptionKey, skelDir: join(temp, "no-skel"), preinstallSkills: false };
    const service = new ShardService(pool as never, config as never, driver as never);

    await service.wake("u1");
    await service.wake("u1");
    assert.equal(wakes, 1, "a live mount is reused");

    alive = false;
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000; // past the liveness-probe throttle
    try {
      const handle = await service.wake("u1");
      assert.equal(wakes, 2, "a dead mount is woken again");
      assert.equal(handle.mountPath, temp);
      assert.equal(service.isAwake("u1"), true);
    } finally {
      Date.now = realNow;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
