import { posix as path } from "node:path";

const { dirname, relative, resolve, sep } = path;

/** Bind one user's existing decrypted home at its host path inside the sandbox for Git worktree metadata. */
export function ownHomeAliasArgs(mountPath: string, mountRoot: string): string[] {
  const root = resolve(mountRoot);
  const home = resolve(mountPath);
  const sandboxRoot = resolve("/mnt");
  const relRoot = relative(sandboxRoot, root);
  const relHome = relative(root, home);
  if (relRoot === ".." || relRoot.startsWith(".." + sep) || relHome === ".." || relHome.startsWith(".." + sep) || relHome.includes(sep)) {
    throw new Error("shard home must be a direct child of a mount root under /mnt");
  }

  const args: string[] = [];
  const parent = dirname(home);
  const components = relative(sandboxRoot, parent).split(sep).filter(Boolean);
  let current = sandboxRoot;
  args.push("--perms", "0755", "--dir", current);
  for (const part of components) {
    current = resolve(current, part);
    args.push("--perms", "0755", "--dir", current);
  }
  args.push("--bind", home, home);
  return args;
}
