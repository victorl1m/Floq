import { posix, win32 } from "node:path";

type PathApi = typeof posix;

function pathApi(root: string): PathApi {
  if (posix.isAbsolute(root)) return posix;
  if (win32.isAbsolute(root)) return win32;
  return posix;
}

function safeParts(relativePath: string | null | undefined): string[] | null {
  if (relativePath === null || relativePath === undefined || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.includes("\0")) return null;
  if (relativePath === "") return [];
  const parts = relativePath.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) return null;
  return parts;
}

function inside(api: PathApi, root: string, target: string): boolean {
  const rel = api.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + api.sep) && !api.isAbsolute(rel));
}

/**
 * Build Codex per-invocation config overrides for this user's shard paths only.
 * `aliasHome` is the optional Linux bwrap bind of the same user's home.
 */
export function managedTrustDirectories(
  sandboxHome: string,
  aliasHome: string | null,
  relativeDirectories: Array<string | null | undefined>,
  includeAncestors = false,
): string[] {
  const roots: Array<{ root: string; api: PathApi }> = [];
  const sandboxApi = pathApi(sandboxHome);
  if (sandboxApi.isAbsolute(sandboxHome)) roots.push({ root: sandboxApi.resolve(sandboxHome), api: sandboxApi });

  if (aliasHome) {
    const aliasApi = pathApi(aliasHome);
    const aliasRoot = aliasApi.resolve(aliasHome);
    // The Linux alias must be a per-user directory below /mnt, never a shared mount parent.
    if (aliasApi === posix && aliasApi.isAbsolute(aliasHome)) {
      const beneathMnt = posix.relative("/mnt", aliasRoot);
      if (inside(posix, "/mnt", aliasRoot) && beneathMnt.split("/").filter(Boolean).length >= 2) {
        roots.push({ root: aliasRoot, api: aliasApi });
      }
    }
  }

  const trusted = new Set<string>();
  for (const rel of relativeDirectories) {
    const parts = safeParts(rel);
    if (!parts) continue;
    for (const { root, api } of roots) {
      let current = api.resolve(root, ...parts);
      if (!inside(api, root, current)) continue;
      if (current === root) {
        trusted.add(root);
        continue;
      }
      trusted.add(current);
      while (includeAncestors && current !== root) {
        current = api.dirname(current);
        if (!inside(api, root, current)) break;
        trusted.add(current);
      }
    }
  }

  return [...trusted].sort();
}

export function codexTrustArgs(sandboxHome: string, aliasHome: string | null, relativeDirectories: Array<string | null | undefined>): string[] {
  const entries = managedTrustDirectories(sandboxHome, aliasHome, relativeDirectories, true).map((absolutePath) => `${JSON.stringify(absolutePath)}={trust_level="trusted"}`);
  return entries.length ? ["-c", `projects={${entries.join(",")}}`] : [];
}
