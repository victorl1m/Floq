import test from "node:test";
import assert from "node:assert/strict";

test("runtime git on agent repos is wrapped in the agent's bwrap sandbox and netns, as the user uid, with no caps", async () => {
  const { LinuxShardDriver } = await import("../dist/shard.js");
  const driver = Object.create(LinuxShardDriver.prototype) as any;
  Object.assign(driver, { cipherRoot: "/var/lib/floq/shards/cipher", mountRoot: "/mnt/floq", metaRoot: "/var/lib/floq/shards/meta", netns: null });
  const handle = { userId: "u", uid: 40001, mountPath: "/mnt/floq/40001" };
  const build = (h: object) => {
    try {
      return driver.sandboxLaunch(h, { file: "git", args: ["status"], env: {}, cwd: "." });
    } catch (error) {
      // An unprivileged run cannot create /mnt/floq/<uid>; nothing to assert on the argv then.
      assert.match(String(error), /EACCES|ENOENT|EPERM/);
      return null;
    }
  };
  const launch = build(handle);
  if (!launch) return;
  assert.match(launch.file, /bwrap$/);
  const argv = launch.args;
  assert.ok(argv.includes("--unshare-pid"));
  assert.ok(argv.includes("--reuid=40001"));
  assert.ok(argv.includes("--no-new-privs"));
  assert.deepEqual(argv.slice(-2), ["git", "status"]);
  // With a per-user netns the launch is nsenter-wrapped, same as the agent session.
  driver.netns = { isHealthy: () => true, resolvConfPath: () => "/run/floq/netns/40001.resolv.conf" };
  const withNetns = build({ ...handle, netns: "/run/floq/netns/40001" });
  assert.equal(withNetns.file, "nsenter");
});
