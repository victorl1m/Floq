import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

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

/** Refresh a small marked instruction block while preserving the rest of the effective AGENTS file. */
export function syncCodexManagedGuidance(codeHome: string, uid?: number, extra = ""): string {
  const root = realpathSync(codeHome);
  const override = join(root, "AGENTS.override.md");
  const standard = join(root, "AGENTS.md");
  const overrideExists = existsSync(override);
  const selected = overrideExists && lstatSync(override).size > 0 ? override : standard;
  if (existsSync(selected)) {
    const stat = lstatSync(selected);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Refusing unsafe Codex instruction path");
  }
  const parent = realpathSync(dirname(selected));
  const fromRoot = relative(root, parent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Codex instruction path escaped CODEX_HOME");
  const current = existsSync(selected) ? readFileSync(selected, "utf8") : "";
  const next = mergeFloqGuidance(current, extra);
  if (next === current) return selected;

  const temporary = join(parent, `.${basename(selected)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, next, { mode: existsSync(selected) ? lstatSync(selected).mode & 0o777 : 0o644, flag: "wx" });
    if (uid !== undefined) chownSync(temporary, uid, uid);
    chmodSync(temporary, existsSync(selected) ? lstatSync(selected).mode & 0o777 : 0o644);
    renameSync(temporary, selected);
  } finally {
    try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch { /* Best-effort temp cleanup. */ }
  }
  return selected;
}

/** Update bundled Floq skill files in a private CODEX_HOME without following user-created links. */
export function syncProtectedFloqSkill(agentHome: string, sourceSkillDir: string, uid?: number): void {
  const root = realpathSync(agentHome);
  const source = realpathSync(sourceSkillDir);
  const skillRoot = ensureDirectory(root, ["skills", "floq-orchestrate"], uid);
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
    const parent = parts.length > 1 ? ensureDirectory(skillRoot, parts.slice(0, -1), uid) : skillRoot;
    const target = join(parent, parts[parts.length - 1]);
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error("Refusing unsafe protected Floq skill file");
    }
    const contents = readFileSync(join(source, relativePath));
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { mode: 0o644, flag: "wx" });
      if (uid !== undefined) chownSync(temporary, uid, uid);
      renameSync(temporary, target);
    } finally {
      try { if (existsSync(temporary)) rmSync(temporary, { force: true }); } catch { /* Best-effort temp cleanup. */ }
    }
  }
}

function ensureDirectory(root: string, parts: string[], uid?: number): string {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let created = false;
    try { mkdirSync(current, { mode: 0o755 }); created = true; }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing unsafe protected Floq skill path");
    const fromRoot = relative(root, realpathSync(current));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Protected Floq skill path escaped CODEX_HOME");
    if (created && uid !== undefined) chownSync(current, uid, uid);
  }
  return current;
}
