import { badRequest } from "./errors.js";

/**
 * Skills a recruiter hands to the agent it recruits (`floq recruit … --skill NAME`, `floq subagent recruit … --skill NAME`).
 *
 * Why: a recruited agent starts with none of its recruiter's context. A lead that was asked for an Artifact knows to
 * load the artifact skills; the Sonnet it recruits does not, and writes a plain HTML file instead. Naming the skills at
 * recruit time puts them in the new agent's system-level instructions on every start and resume (so they survive
 * compaction), telling it to load them before it works.
 *
 * Names are not checked against installed skills: built-in and plugin skills (e.g. `artifact-design`,
 * `anthropic-skills:docs`) are not files the runtime can see. They are only checked for shape.
 */

export const MAX_RECRUIT_SKILLS = 8;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/;

/** Accepts `"a,b"`, `["a","b"]` or nothing. Returns a de-duplicated list (case-insensitive), or throws 400. */
export function parseRecruitSkills(value: unknown): string[] {
  if (value === undefined || value === null || value === false || value === "") return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!raw || raw.some((item) => typeof item !== "string")) throw badRequest("skill must be a skill name or a comma-separated list of names", "invalid_skill");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw as string[]) {
    const name = item.trim();
    if (!name) continue;
    if (!SKILL_NAME.test(name)) throw badRequest(`Invalid skill name "${name.slice(0, 80)}": use the name as your skill list shows it (letters, digits, : . _ -)`, "invalid_skill");
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > MAX_RECRUIT_SKILLS) throw badRequest(`At most ${MAX_RECRUIT_SKILLS} skills per recruit`, "too_many_skills");
  return out;
}

/** Reads the stored column (TEXT[] from pg, or anything else) back into a clean list; never throws. */
export function storedRecruitSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  try { return parseRecruitSkills(value.filter((item) => typeof item === "string")); } catch { return []; }
}

/** System-level instruction for the recruited agent; empty when no skills were given. */
export function buildRecruitSkillsBlock(skills: readonly string[], provider: "claude" | "codex" | string): string {
  if (!skills.length) return "";
  const list = skills.map((name) => "`" + name + "`").join(", ");
  const how = provider !== "claude"
    ? "Read each skill's SKILL.md (in " + (provider === "codex" ? "~/.codex/skills/<name>/" : "the CLI's skills folder") + " or the project's skills folder) before you start, and follow it."
    : "Before you start the task, load each one with the Skill tool (exact name as listed), and follow it.";
  return [
    "[FLOQ RECRUIT SKILLS]",
    `The agent that recruited you asked you to use these skills: ${list}. ${how}`,
    "They decide HOW to produce the result (for example: publish a page with the Artifact tool, or create a document through the docs connector, instead of writing a local HTML or Markdown file). Do not substitute your own format for what a skill prescribes.",
    "If a skill is not available to you, say so in your report instead of silently doing the work another way.",
  ].join("\n");
}
