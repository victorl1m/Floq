import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { mkdirOwned, openHomeDir, writeFileOwned } from "./shard.js";

export const FLOQ_GUIDANCE_BEGIN = "<!-- FLOQ MANAGED GUIDANCE: BEGIN -->";
export const FLOQ_GUIDANCE_END = "<!-- FLOQ MANAGED GUIDANCE: END -->";

export const FLOQ_CODEX_GUIDANCE = [
  FLOQ_GUIDANCE_BEGIN,
  "## Floq CLI and MCP",
  "",
  "In Floq sessions, use the floq CLI for agent coordination and for inspecting Floq-installed skills, MCP servers, and secrets. Run floq --help when unsure of a command. On coordination requests, read the floq-orchestrate skill and use floq list to see visible sessions; native subagents are disabled in Floq; recruit visible ones with `floq subagent recruit`. For MCP discovery or troubleshooting, use floq mcp list --provider codex or claude for the current project/scope, and distinguish configured servers from authenticated servers and tools loaded into this session. A configured server is not proof that it is connected.",
  "",
  "If the user asks to use an MCP integration and its tools are available, use those tools directly. For Codex-native status, run codex mcp list --json in this session's current CODEX_HOME; /mcp shows tools available to the running TUI. If status says not_logged_in, explain that the user needs codex mcp login NAME --no-browser in the matching project/session context. Do not claim it works until its tools are available. Do not use an external plugin catalog to determine Floq-installed MCP state; use catalogs only when the user wants a new integration that is not configured. Never expose secret values in logs, tool output, or chat; `floq secrets list` shows names and descriptions only.",
  "",
  "After a user-approved MCP config change and after saving current work, run `floq session restart` to reload this session. It targets only the calling Claude or Codex session, resumes the same conversation, and does not authenticate the MCP server or guarantee its tools loaded; verify availability after the session resumes.",
  FLOQ_GUIDANCE_END,
].join("\n");

/** `extra` (the session's wired-context block) rides inside the managed block, so each start replaces it and an empty one removes it. */
export function mergeFloqGuidance(current: string, extra = ""): string {
  const guidance = extra ? FLOQ_CODEX_GUIDANCE.replace(FLOQ_GUIDANCE_END, () => `
${extra}
${FLOQ_GUIDANCE_END}`) : FLOQ_CODEX_GUIDANCE;
  const begin = current.indexOf(FLOQ_GUIDANCE_BEGIN);
  const end = current.indexOf(FLOQ_GUIDANCE_END);
  if (begin >= 0 && end > begin) {
    const after = end + FLOQ_GUIDANCE_END.length;
    const beforeText = current.slice(0, begin).trimEnd();
    const afterText = current.slice(after).trim();
    return `${beforeText ? `${beforeText}\n\n` : ""}${guidance}${afterText ? `\n\n${afterText}` : ""}\n`;
  }
  const cleaned = current
    .split(FLOQ_GUIDANCE_BEGIN).join("")
    .split(FLOQ_GUIDANCE_END).join("")
    .trimEnd();
  return `${cleaned}${cleaned ? "\n\n" : ""}${guidance}\n`;
}

/** Read a regular file by descriptor (O_NOFOLLOW, never blocks on a FIFO). */
function readRegular(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Refusing unsafe Codex instruction path");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/**
 * Refresh a small marked instruction block while preserving the rest of the effective AGENTS file. `home` is the user's
 * home when `codeHome` lives inside an agent-writable one: the directory is then opened by descriptor through it (no symlinked
 * component is followed) and all reads and writes go through that descriptor.
 */
export function syncCodexManagedGuidance(codeHome: string, uid?: number, extra = "", home?: string): string {
  const root = home === undefined ? realpathSync(codeHome) : codeHome;
  const dir = openHomeDir(home ?? root, root);
  if (!dir) throw new Error("CODEX_HOME is missing");
  try {
    const override = join(dir.path, "AGENTS.override.md");
    const standard = join(dir.path, "AGENTS.md");
    const info = (path: string) => { try { return lstatSync(path); } catch { return null; } };
    const overrideInfo = info(override);
    const selected = overrideInfo && overrideInfo.size > 0 ? override : standard;
    const selectedInfo = selected === override ? overrideInfo : info(standard);
    if (selectedInfo && (selectedInfo.isSymbolicLink() || !selectedInfo.isFile())) throw new Error("Refusing unsafe Codex instruction path");
    const current = selectedInfo ? readRegular(selected) : "";
    const next = mergeFloqGuidance(current, extra);
    const name = basename(selected);
    if (next === current) return join(root, name);
    writeFileOwned(null, selected, next, uid ?? null, selectedInfo ? selectedInfo.mode & 0o777 : 0o644);
    return join(root, name);
  } finally { dir.close(); }
}

/** Update bundled Floq skill files in a private agent home without following user-created links (descriptor-pinned when `home` is given). */
export function syncProtectedFloqSkill(agentHome: string, sourceSkillDir: string, uid?: number, home?: string): void {
  const root = home === undefined ? realpathSync(agentHome) : agentHome;
  const base = home ?? root;
  const source = realpathSync(sourceSkillDir);
  const skillRoot = join(root, "skills", "floq-orchestrate");
  mkdirOwned(base, skillRoot, uid ?? null);
  const files: string[] = [];
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Bundled Floq skill contains a symbolic link");
      if (entry.isDirectory()) visit(fullPath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  visit(source);

  for (const relativePath of files) {
    const parts = relativePath.split(/[\\/]/);
    const parentPath = parts.length > 1 ? join(skillRoot, ...parts.slice(0, -1)) : skillRoot;
    mkdirOwned(base, parentPath, uid ?? null);
    const parent = openHomeDir(base, parentPath);
    if (!parent) throw new Error("Refusing unsafe protected Floq skill path");
    try {
      const target = join(parent.path, parts[parts.length - 1]);
      let targetStat = null;
      try { targetStat = lstatSync(target); } catch { /* new file */ }
      if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) throw new Error("Refusing unsafe protected Floq skill file");
      writeFileOwned(null, target, readFileSync(join(source, relativePath)), uid ?? null, 0o644);
    } finally { parent.close(); }
  }
}
