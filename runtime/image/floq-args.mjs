import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function parseArgs(args) {
  const positional = [];
  const named = {};
  const booleanFlags = new Set(["isolated", "global", "dry-run", "allow-plaintext"]);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      positional.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (name === "project") {
      // Optional value: a project UUID, otherwise "this session's project".
      named.project = i + 1 < args.length && PROJECT_ID.test(args[i + 1]) ? args[++i] : true;
      continue;
    }
    if (booleanFlags.has(name)) named[name] = true;
    else if (i + 1 < args.length) named[name] = args[++i];
    else named[name] = true;
  }
  return { positional, named };
}

export function formatAgentListEntry(agent) {
  return (agent.self ? "* " : "  ") + agent.name + "  " + agent.id + "  [" + agent.provider + ", configured model: " + (agent.model ?? "default") + ", " + agent.state + (agent.lead ? ", lead" : "") + "]";
}

export function formatRecruitment(agent) {
  return "recruited " + agent.name + " " + agent.id + " (" + agent.provider + ", configured model: " + (agent.model ?? "default") + ")";
}

export function formatModel(provider, model) {
  return provider + "\t" + model.id + "\t" + model.label;
}

export function buildRecruitPayload(positional, named) {
  return {
    name: positional[0],
    provider: named.provider,
    model: named.model,
    cwd: named.cwd,
    role: named.role,
    isolated: named.isolated === true,
  };
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits `a b -- c d` into [["a","b"], ["c","d"]]; the second part is null without a `--`. */
export function splitDashDash(args) {
  const at = args.indexOf("--");
  return at < 0 ? [args, null] : [args.slice(0, at), args.slice(at + 1)];
}

/** `--global` or `--project [UUID]` -> body fields; nothing given lets the runtime pick (this session's project, else global). */
export function scopeFields(named) {
  if (named.global && named.project) throw new Error("use either --global or --project, not both");
  if (named.global) return { scope: "global" };
  if (named.project === true) return { scope: "project" };
  if (typeof named.project === "string") {
    if (!PROJECT_ID.test(named.project)) throw new Error("--project takes a project UUID");
    return { scope: "project", projectId: named.project };
  }
  return {};
}

export function checkProvider(value, allowBoth) {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "codex" || (allowBoth && value === "both")) return value;
  throw new Error("--provider must be claude, codex" + (allowBoth ? " or both" : ""));
}

export function scopeLabel(result) {
  return result.scope === "project" ? "project " + result.projectId : "global (your whole home)";
}

/** Review text printed before and after an MCP install. Only names of env/header entries, never values. */
export function formatMcpReview(review, result) {
  const lines = [
    (result.dryRun ? "Would install" : "Installing") + " MCP server \"" + review.name + "\" (" + (review.type === "stdio" ? "stdio" : "HTTP") + ")",
    review.type === "stdio" ? "  runs:  " + review.summary : "  url:   " + review.summary,
  ];
  for (const { target, secret } of review.secrets ?? []) lines.push("  " + target + " <- vault secret " + secret + " (read from the vault when the server starts; never written to the config)");
  const plain = review.plaintext ?? [];
  if (plain.length) lines.push("  stored as plain text in the config file: " + plain.map((n) => n + "=****").join(", ") + " (values hidden)");
  lines.push("  scope: " + scopeLabel(result));
  if (review.type === "stdio") lines.push("  note:  a stdio MCP server runs this command with the agent's permissions.");
  if (result.scope === "project") lines.push("  note:  values saved in a project's config can be committed to git.");
  return lines.join("\n");
}

export function formatMcpServer(server) {
  const detail = server.command ?? server.urlHost ?? "";
  return server.provider + "\t" + server.name + "\t" + server.transport + (detail ? "\t" + detail : "") + (server.usesSecrets ? "\t(uses vault secrets" + (server.secretNames?.length ? ": " + server.secretNames.join(",") : "") + ")" : "") + (server.protected || server.source === "bundled" ? "\t(bundled, protected)" : "");
}

export function formatSkill(skill) {
  return skill.provider + "\t" + skill.name + "\t" + skill.source + (skill.description ? "\t" + skill.description.replace(/\s+/g, " ").slice(0, 100) : "");
}

/** Parses the `secrets add` arguments. The value is never an argument: any extra positional or --value is refused. */
export function parseSecretsAdd(positional, named) {
  if (positional.length !== 1) throw new Error("usage: floq secrets add NAME [--description TEXT]  (the value is read from stdin or a hidden prompt, never from an argument)");
  if ("value" in named || "expose" in named) throw new Error("secrets add does not accept --value or --expose; the value comes from stdin or a hidden prompt, and agent-created secrets are always tool-only");
  return { name: positional[0], description: typeof named.description === "string" ? named.description : undefined };
}

/** Trims exactly one trailing newline from piped input. */
export function cleanSecretInput(raw) {
  return raw.replace(/\r?\n$/, "");
}

const SKILL_LIMITS = { files: 120, total: 512 * 1024, file: 64 * 1024 };

/**
 * Reads a skill directory for `floq skills create --from DIR`: regular UTF-8 text files only, no symbolic links, within the same
 * limits the runtime enforces (it checks again). Returns { "SKILL.md": text, "references/x.md": text, ... }.
 */
export function readSkillDirectory(root) {
  let rootStat;
  try { rootStat = lstatSync(root); } catch { throw new Error("--from: cannot read " + root); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("--from must be a real directory, not a link or a file");
  const files = {};
  let count = 0;
  let total = 0;
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const rel = prefix + entry.name;
      const full = join(current, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error("--from: " + rel + " is a symbolic link. Links are not followed; copy the real file into the directory.");
      if (stat.isDirectory()) { walk(full, rel + "/"); continue; }
      if (!stat.isFile()) throw new Error("--from: " + rel + " is not a regular file");
      if (++count > SKILL_LIMITS.files) throw new Error("--from: a skill can have at most " + SKILL_LIMITS.files + " files");
      if (stat.size > SKILL_LIMITS.file) throw new Error("--from: " + rel + " is larger than 64 KiB");
      total += stat.size;
      if (total > SKILL_LIMITS.total) throw new Error("--from: the files add up to more than 512 KiB");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(full)); } catch { throw new Error("--from: " + rel + " is not UTF-8 text"); }
      if (text.includes("\u0000")) throw new Error("--from: " + rel + " contains NUL bytes");
      files[rel] = text;
    }
  };
  walk(root, "");
  if (!("SKILL.md" in files)) throw new Error("--from: the directory must contain a SKILL.md");
  return files;
}
