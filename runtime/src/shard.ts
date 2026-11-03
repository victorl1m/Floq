import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { unavailable } from "./errors.js";
import { log } from "./logger.js";
import { spawnPty, type PtyProcess } from "./pty.js";
import { ownHomeAliasArgs } from "./sandboxPaths.js";

const run = promisify(execFile);
/** A broken FUSE mount must fail fast with a JSON error instead of hanging the request. */
const MOUNT_TIMEOUT_MS = 20_000;

/** Path of a user's home as seen from inside the sandbox. */
export const SANDBOX_HOME = "/home/agent";

export interface ShardIdentity {
  userId: string;
  /** Numeric uid/gid allocated to this user; no /etc/passwd entry on the host. */
  uid: number;
}

export interface ShardHandle extends ShardIdentity {
  /** Host path where the user's decrypted home is mounted. */
  mountPath: string;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Relative to the user's home. */
  cwd: string;
  cols: number;
  rows: number;
}

export interface ShardDriver {
  readonly name: "linux" | "local";
  /** Provision (first use) and unlock the user's encrypted home. */
  wake(identity: ShardIdentity, dataKey: Buffer): Promise<ShardHandle>;
  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess;
  /** Lock the home again. Callers guarantee no sandboxed process still uses it. */
  sleep(handle: ShardHandle): Promise<void>;
  /** Host path of a relative path inside the user's home. */
  hostPath(handle: ShardHandle, relative: string): string;
  /** The user home path as the agent process sees it. */
  homePath(handle: ShardHandle): string;
}

export function safeRelative(input: string): string {
  const parts = input.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..") || input.startsWith("/") || parts.some((p) => /[\0\\]/.test(p))) {
    throw new Error("path escapes the home directory");
  }
  return parts.join("/");
}

/**
 * gocryptfs (root, allow_other) performs every operation as the calling uid, so anything root creates inside a
 * mounted home is root-owned and unwritable for the user. These helpers hand such paths to the user's uid.
 */
export function ownTree(path: string, uid: number, maxDepth = Infinity): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.uid !== uid || stat.gid !== uid) lchownSync(path, uid, uid);
  if (stat.isDirectory() && maxDepth > 0) for (const entry of readdirSync(path)) ownTree(join(path, entry), uid, maxDepth - 1);
}

/** mkdir -p inside a mounted home, creating every missing segment owned by the user. */
export function mkdirOwned(root: string, dir: string, uid: number): void {
  const rel = relative(root, dir);
  if (rel.startsWith("..")) throw new Error("path escapes the home directory");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current);
      lchownSync(current, uid, uid);
    }
  }
}

function isMounted(path: string): boolean {
  try {
    return readFileSync("/proc/self/mounts", "utf8")
      .split("\n")
      .some((line) => line.split(" ")[1] === path);
  } catch {
    return false;
  }
}

/** A FUSE mount whose daemon died keeps its /proc/mounts entry but every access fails with ENOTCONN. */
function isAlive(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === "ENOTCONN" || code === "ECONNABORTED" || code === "EIO");
  }
}

async function lazyUnmount(path: string): Promise<void> {
  try {
    await run("fusermount3", ["-u", "-z", path], { timeout: 10_000 });
  } catch {
    await run("fusermount", ["-u", "-z", path], { timeout: 10_000 }).catch(() => undefined);
  }
}

/**
 * Run gocryptfs without ever giving it a pipe to Node: in daemon mode the forked filesystem process
 * inherits the parent's stdio, and a pipe closed by Node would kill it (EPIPE) right after mounting.
 * Its stderr goes to a private log file instead; we wait for the launcher process to exit.
 */
async function runGocryptfs(args: string[], logFile: string): Promise<void> {
  try {
    if (statSync(logFile).size > 1_000_000) rmSync(logFile, { force: true });
  } catch {
    /* no log yet */
  }
  const fd = openSync(logFile, "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("gocryptfs", args, { stdio: ["ignore", "ignore", fd] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("gocryptfs timed out"));
      }, MOUNT_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("gocryptfs exited with " + (code ?? signal)));
      });
    });
  } finally {
    closeSync(fd);
  }
}

/** Production driver: gocryptfs-encrypted home per user, bubblewrap sandbox, privileges dropped to a per-user uid. */
export class LinuxShardDriver implements ShardDriver {
  readonly name = "linux" as const;
  private readonly cipherRoot: string;
  private readonly mountRoot: string;
  private readonly metaRoot: string;

  constructor(config: Config) {
    this.cipherRoot = join(config.shardRoot, "cipher");
    // Ciphertext and metadata live on the shards volume; only the plaintext mountpoints live under /mnt.
    // Ubuntu >= 25.04 hosts confine /usr/bin/fusermount3 with an AppArmor profile that only allows FUSE
    // mountpoints under $HOME, /mnt, /media, /tmp and /run/user, so a mountpoint on the volume is denied.
    this.mountRoot = config.mountRoot;
    this.metaRoot = join(config.shardRoot, "meta");
    for (const dir of [this.cipherRoot, this.metaRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.mountRoot, { recursive: true, mode: 0o711 });
    this.cleanDeadMounts();
  }

  /** Lazily unmount leftovers whose gocryptfs daemon is gone (e.g. after a crash). */
  private cleanDeadMounts(): void {
    let lines: string[] = [];
    try {
      lines = readFileSync("/proc/self/mounts", "utf8").split("\n");
    } catch {
      return;
    }
    for (const line of lines) {
      const mountPoint = line.split(" ")[1];
      if (mountPoint?.startsWith(this.mountRoot + "/") && !isAlive(mountPoint)) {
        void lazyUnmount(mountPoint).then(() => log.warn("shard.dead_mount_cleaned", { mountPoint }));
      }
    }
  }

  async wake(identity: ShardIdentity, dataKey: Buffer): Promise<ShardHandle> {
    const { userId, uid } = identity;
    const cipher = join(this.cipherRoot, String(uid));
    const mountPath = join(this.mountRoot, String(uid));
    mkdirSync(cipher, { recursive: true, mode: 0o700 });
    mkdirSync(mountPath, { recursive: true, mode: 0o700 });

    // Minimal passwd/group so git, ssh and node resolve the uid inside the sandbox.
    const passwd = join(this.metaRoot, uid + ".passwd");
    writeFileSync(
      passwd,
      "root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:" + uid + ":" + uid + "::" + SANDBOX_HOME + ":/bin/bash\n",
      { mode: 0o644 },
    );
    writeFileSync(join(this.metaRoot, uid + ".group"), "root:x:0:\nagent:x:" + uid + ":\n", { mode: 0o644 });

    // The ciphertext must belong to the user's uid: gocryptfs acts as the caller, and a root-owned ciphertext
    // tree makes every write by the user fail with EACCES. Migrates trees created before this was enforced.
    const confPath = join(cipher, "gocryptfs.conf");
    if (existsSync(confPath) && (statSync(cipher).uid !== uid || statSync(confPath).uid !== uid)) {
      ownTree(cipher, uid);
      log.info("shard.ownership_fixed", { userId, uid });
    }

    let mounted = isMounted(mountPath);
    if (mounted && !isAlive(mountPath)) {
      log.warn("shard.dead_mount", { userId, uid });
      await lazyUnmount(mountPath);
      mounted = false;
    }
    const gocryptfsLog = join(this.metaRoot, uid + ".gocryptfs.log");
    if (!mounted) {
      const passfile = join("/dev/shm", "floq-" + randomBytes(8).toString("hex"));
      writeFileSync(passfile, dataKey.toString("hex"), { mode: 0o600 });
      try {
        if (!existsSync(join(cipher, "gocryptfs.conf"))) {
          await runGocryptfs(["-init", "-q", "-passfile", passfile, "-scryptn", "12", cipher], gocryptfsLog);
          ownTree(cipher, uid);
          log.info("shard.provisioned", { userId, uid });
        }
        await runGocryptfs([
          "-q",
          "-passfile",
          passfile,
          "-allow_other",
          "-nosyslog",
          cipher,
          mountPath,
        ], gocryptfsLog);
        if (!isAlive(mountPath)) throw new Error("mount is not responding");
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n").slice(0, 3).join(" | ") : String(error);
        log.error("shard.mount_failed", { userId, uid, error: detail });
        throw unavailable("Your encrypted workspace could not be mounted right now. Try again shortly.");
      } finally {
        rmSync(passfile, { force: true });
      }
      log.info("shard.wake", { userId, uid });
    }
    return { userId, uid, mountPath };
  }

  hostPath(handle: ShardHandle, relative: string): string {
    return join(handle.mountPath, safeRelative(relative));
  }

  homePath(): string {
    return SANDBOX_HOME;
  }

  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess {
    const { uid } = handle;
    const home = handle.mountPath;
    mkdirOwned(handle.mountPath, this.hostPath(handle, spec.cwd), uid);

    const args = [
      "--die-with-parent",
      // No --new-session: it would drop the PTY's controlling terminal (no job control, Ctrl+C/Z do not reach
      // the foreground job). Its purpose, blocking TIOCSTI injection into the parent terminal, is moot here:
      // the parent terminal is this session's own node-pty slave, and the host kernel has
      // dev.tty.legacy_tiocsti = 0 (TIOCSTI disabled).
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
    ];
    if (existsSync("/lib64")) args.push("--symlink", "usr/lib64", "/lib64");
    // bwrap creates the parent directories of binds as 0700 root, which the per-user uid cannot read
    // (resolv.conf, ssl config): create them 0755 explicitly, before anything is bound into them.
    args.push("--perms", "0755", "--dir", "/etc", "--perms", "0755", "--dir", "/home");
    for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives", "/etc/nsswitch.conf", "/etc/gitconfig", "/etc/localtime"]) {
      if (existsSync(path)) args.push("--ro-bind", path, path);
    }
    args.push(
      "--ro-bind", join(this.metaRoot, uid + ".passwd"), "/etc/passwd",
      "--ro-bind", join(this.metaRoot, uid + ".group"), "/etc/group",
      "--proc", "/proc",
      "--dev", "/dev",
      // 1777 like a real /tmp: the agents create /tmp/claude-<uid> etc. as the unprivileged uid.
      "--perms", "1777", "--tmpfs", "/tmp",
      "--tmpfs", "/run",
      "--bind", home, SANDBOX_HOME,
      // Git linked-worktree metadata stores absolute paths. Bind only this user's shard at that same path;
      // the new sandbox still contains no parent shard roots or other users' homes.
      ...ownHomeAliasArgs(home, this.mountRoot),
      "--chdir", SANDBOX_HOME + "/" + safeRelative(spec.cwd),
      "--",
      "setpriv",
      "--reuid=" + uid,
      "--regid=" + uid,
      "--clear-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      spec.file,
      ...spec.args,
    );

    // Not /usr/bin/bwrap: Ubuntu >= 24.04 hosts attach the AppArmor profile "bwrap" to that path (even inside
    // containers) and run everything under it as "unpriv_bwrap", which denies CAP_SETUID/SETGID/CHOWN, so
    // setpriv could never drop to the per-user uid. The image ships an identical copy at /usr/local/bin/floq-bwrap.
    return spawnPty(process.env.FLOQ_BWRAP_BIN?.trim() || "floq-bwrap", args, {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: "/",
      env: { ...spec.env, HOME: SANDBOX_HOME, USER: "agent", LOGNAME: "agent" },
    });
  }

  async sleep(handle: ShardHandle): Promise<void> {
    if (!isMounted(handle.mountPath)) return;
    if (!isAlive(handle.mountPath)) await lazyUnmount(handle.mountPath);
    else {
      try {
        await run("fusermount3", ["-u", handle.mountPath]);
      } catch {
        await run("fusermount", ["-u", handle.mountPath]);
      }
    }
    log.info("shard.sleep", { userId: handle.userId, uid: handle.uid });
  }
}

/** Development driver (Windows/macOS or FLOQ_SHARD_DRIVER=local): no isolation or encryption. */
export class LocalShardDriver implements ShardDriver {
  readonly name = "local" as const;

  constructor(private readonly config: Config) {}

  async wake(identity: ShardIdentity): Promise<ShardHandle> {
    const mountPath = join(this.config.shardRoot, "local", identity.userId);
    mkdirSync(mountPath, { recursive: true });
    return { ...identity, mountPath };
  }

  hostPath(handle: ShardHandle, relative: string): string {
    return join(handle.mountPath, safeRelative(relative));
  }

  homePath(handle: ShardHandle): string {
    return handle.mountPath;
  }

  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess {
    const cwd = this.hostPath(handle, spec.cwd);
    mkdirSync(cwd, { recursive: true });
    return spawnPty(spec.file, spec.args, {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd,
      env: spec.env,
    });
  }

  async sleep(): Promise<void> {}
}

export function createShardDriver(config: Config): ShardDriver {
  const mode = config.shardDriver === "auto" ? (process.platform === "linux" ? "linux" : "local") : config.shardDriver;
  if (mode === "linux") {
    if (process.platform !== "linux") throw new Error("FLOQ_SHARD_DRIVER=linux requires a Linux host");
    return new LinuxShardDriver(config);
  }
  log.warn("shard.local_driver", { message: "Running without per-user isolation or encryption (development only)" });
  return new LocalShardDriver(config);
}
