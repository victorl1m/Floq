import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface Rule {
  names: string[];
  action: string;
  args?: unknown[];
  includes?: unknown;
}
const profile = JSON.parse(readFileSync(new URL("../seccomp-floq.json", import.meta.url), "utf8")) as { defaultAction: string; syscalls: Rule[] };
const unconditional = new Set(
  profile.syscalls.filter((r) => r.action === "SCMP_ACT_ALLOW" && !r.args && !r.includes).flatMap((r) => r.names),
);

// Unlisted syscalls fail with EPERM, which is exactly what Dart's dart:io / pub report as "Operation not permitted".
test("default action is errno and file syscalls used by Dart, glibc and pub are allowed", () => {
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  for (const name of [
    "utimensat", "fchmod", "fchmodat", "fchmodat2", "fchown", "fchownat", "renameat2", "copy_file_range", "sendfile",
    "openat2", "statx", "faccessat2", "close_range", "fallocate", "ftruncate", "fsync", "fdatasync", "flock", "fcntl",
    "fadvise64", "sync_file_range", "symlinkat", "linkat", "memfd_create", "getrandom", "rseq", "set_robust_list",
    "inotify_init1", "inotify_add_watch", "setfsuid", "setfsgid", "setgroups", "pidfd_open",
  ]) {
    assert.ok(unconditional.has(name), name + " must stay allowed");
  }
});
