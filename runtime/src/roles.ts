/**
 * Agent role presets ("recruit by role"), inspired by GitHub Spec Kit's phase split:
 * specify -> plan -> implement -> review/test. Single source of truth for the UI, the REST API
 * (GET /v1/agent-roles) and the in-sandbox `floq roles|role|recruit --role` commands.
 *
 * A role never hardcodes a model. `capability` is a hint the recruiting AI (or the UI's "Auto") uses
 * with the models list to pick one; `suggestedProvider` is optional and always overridable.
 */
import type { ModelEntry } from "./config.js";
import { badRequest } from "./errors.js";

export type RoleCapability = "reasoning-heavy" | "code-heavy" | "fast-cheap" | "review-strict";

export interface AgentRole {
  id: string;
  label: string;
  summary: string;
  /** UI icon hint (lucide-style name). */
  icon: string;
  capability: RoleCapability;
  /** Plain-language note on how to choose a model for this capability. */
  modelAdvice: string;
  suggestedProvider?: "claude" | "codex";
  /** True when the role must not modify files; the prompt enforces it (no CLI sandbox flag is changed). */
  readOnly: boolean;
  whenToUse: string;
  whenNotToUse: string;
  inputs: string;
  outputs: string;
  handoffFrom: string[];
  handoffTo: string[];
  /** Injected into the agent's first message. Concise and concrete. */
  prompt: string;
}

const CAPABILITY_ADVICE: Record<RoleCapability, string> = {
  "reasoning-heavy": "Pick the strongest reasoning model available (largest/opus-class or highest reasoning tier).",
  "code-heavy": "Pick a strong coding model (sonnet-class or the provider's coding model); balance speed and quality.",
  "fast-cheap": "Pick a small, fast model (haiku-class or mini); the work is mechanical and high-volume.",
  "review-strict": "Pick a strong model, ideally a different one than the implementer, to get independent judgement.",
};

export const ORCHESTRATOR_ROLE_ID = "orchestrator";

const HANDOFF = "End with a section titled 'Handoff' listing: status, artifacts (file paths), the decision ids you asked (not the question text), and the recommended next role. Follow the communication rule in your Floq system prompt for questions and reports (a question only the user can answer is a `floq decision request`).";

/** Orchestrators act on the next step instead of recommending it, so their handoff has no "next role". */
const ORCHESTRATOR_HANDOFF = "End each turn with a short section titled 'Handoff' listing: status, artifacts (file paths) and the decision ids you are waiting on (not the question text). Follow the communication rule in your Floq system prompt: questions only the user can answer go through `floq decision request`.";

export const AGENT_ROLES: readonly AgentRole[] = [
  {
    id: "specifier",
    label: "Specifier",
    summary: "Turns an idea into a clear spec. Writes no code.",
    icon: "file-text",
    capability: "reasoning-heavy",
    modelAdvice: CAPABILITY_ADVICE["reasoning-heavy"],
    readOnly: false,
    whenToUse: "A feature or change is vague; you need requirements, user stories and acceptance criteria before building.",
    whenNotToUse: "The spec already exists, or the task is a small, well-defined fix.",
    inputs: "A rough idea, user request, or existing docs/issues.",
    outputs: "specs/<feature>/spec.md: problem, users, user stories, functional requirements, acceptance criteria, out of scope, unresolved points (asked as Floq decisions).",
    handoffFrom: [],
    handoffTo: ["planner"],
    prompt: [
      "ROLE: Specifier. You turn an idea into a precise, testable specification.",
      "Do: ask clarifying questions as Floq decisions, read relevant code/docs for context, write the spec (problem, users, user stories, numbered requirements, acceptance criteria, out of scope, unresolved points). Describe WHAT and WHY, not HOW.",
      "Do NOT: write or modify source code, pick libraries or architecture, or start implementing. Only create/edit spec documents.",
      "Mark unknowns as 'NEEDS CLARIFICATION' instead of guessing.",
      HANDOFF,
    ].join("\n"),
  },
  {
    id: "planner",
    label: "Planner",
    summary: "Turns a spec into a technical plan and ordered task list.",
    icon: "map",
    capability: "reasoning-heavy",
    modelAdvice: CAPABILITY_ADVICE["reasoning-heavy"],
    readOnly: false,
    whenToUse: "A spec exists and needs an architecture decision, file-level plan and a task breakdown.",
    whenNotToUse: "There is no spec yet (use specifier), or the change is trivial.",
    inputs: "Path to a spec (e.g. specs/<feature>/spec.md) and the existing codebase.",
    outputs: "plan.md (approach, components, data/API changes, risks, test strategy) and tasks.md (ordered, small, independently verifiable tasks with files and done-criteria).",
    handoffFrom: ["specifier"],
    handoffTo: ["implementer"],
    prompt: [
      "ROLE: Planner / Architect. You turn a spec into a technical plan and an ordered task list.",
      "Do: read the spec and the existing code, follow existing conventions, write plan.md (approach, components, data/API changes, risks, test strategy) and tasks.md (small ordered tasks, each with target files and a done-criterion; mark tasks that can run in parallel).",
      "Do NOT: implement tasks or edit source code. Only create/edit plan and task documents. Flag spec gaps instead of silently changing requirements.",
      HANDOFF,
    ].join("\n"),
  },
  {
    id: "implementer",
    label: "Implementer",
    summary: "Builds the tasks from a plan, with tests, in small steps.",
    icon: "hammer",
    capability: "code-heavy",
    suggestedProvider: "codex",
    modelAdvice: CAPABILITY_ADVICE["code-heavy"],
    readOnly: false,
    whenToUse: "A plan/task list or a precise bounded change exists and code must be written.",
    whenNotToUse: "Requirements or design are still unclear; the job is only review or investigation.",
    inputs: "tasks.md / plan.md paths or a precise task description.",
    outputs: "Code and tests committed to the working tree; the checks you ran and their results.",
    handoffFrom: ["planner", "specifier"],
    handoffTo: ["reviewer", "tester"],
    prompt: [
      "ROLE: Implementer. You build the assigned tasks.",
      "Do: read the plan and tasks, implement one task at a time following repo conventions, add or update tests, run the project's type-check/lint/tests, and fix failures you caused.",
      "Do NOT: expand scope beyond the assigned tasks, rewrite the spec or plan (raise a question instead), skip failing tests, or touch unrelated files.",
      "Report files changed and the exact commands you ran with their results.",
      HANDOFF,
    ].join("\n"),
  },
  {
    id: "reviewer",
    label: "Reviewer",
    summary: "Reviews diffs for bugs, security and regressions. Does not edit.",
    icon: "search-check",
    capability: "review-strict",
    modelAdvice: CAPABILITY_ADVICE["review-strict"],
    readOnly: true,
    whenToUse: "After implementation, before merging; you want an independent read of the diff.",
    whenNotToUse: "You want fixes applied (use implementer) or tests written (use tester).",
    inputs: "A branch, diff, or list of changed files, plus the spec/plan if available.",
    outputs: "Findings ordered by severity, each with file:line, why it is a problem, and a suggested fix; plus a verdict (approve / changes requested).",
    handoffFrom: ["implementer"],
    handoffTo: ["implementer"],
    prompt: [
      "ROLE: Reviewer. You review changes for correctness bugs, security issues, regressions, missing tests and deviations from the spec/plan.",
      "Do: inspect the diff and surrounding code (git diff, git log), run read-only checks if useful, and report findings by severity with file:line evidence and a suggested fix. Only report issues you can justify.",
      "Do NOT: edit, create, or delete files, commit, or run commands that change the repo. You are read-only.",
      "Finish with a verdict: APPROVE or CHANGES REQUESTED.",
      HANDOFF,
    ].join("\n"),
  },
  {
    id: "tester",
    label: "Tester",
    summary: "Writes and runs tests, reproduces bugs, reports results.",
    icon: "flask-conical",
    capability: "fast-cheap",
    modelAdvice: CAPABILITY_ADVICE["fast-cheap"],
    readOnly: false,
    whenToUse: "You need test coverage, a bug reproduction, or a regression pass over finished work.",
    whenNotToUse: "The feature code itself must change (use implementer).",
    inputs: "Acceptance criteria or a bug report, and the code under test.",
    outputs: "New/updated tests, a pass/fail summary with commands run, and for bugs a minimal reproduction and suspected cause.",
    handoffFrom: ["implementer"],
    handoffTo: ["implementer", "reviewer"],
    prompt: [
      "ROLE: QA / Tester. You prove the software works or show exactly how it fails.",
      "Do: derive test cases from acceptance criteria (including edge and failure cases), write or extend tests, run them, and reproduce reported bugs with the smallest possible steps.",
      "Do NOT: change production code to make tests pass; report the failure and suspected cause instead.",
      HANDOFF,
    ].join("\n"),
  },
  {
    id: ORCHESTRATOR_ROLE_ID,
    label: "Orchestrator",
    summary: "Coordinates the project: recruits agents, delegates and integrates results. Only orchestrators can recruit.",
    icon: "workflow",
    capability: "reasoning-heavy",
    modelAdvice: CAPABILITY_ADVICE["reasoning-heavy"],
    readOnly: false,
    whenToUse: "A project needs several agents working together; one agent must plan, delegate and keep the picture.",
    whenNotToUse: "A single small task that one agent can finish by itself.",
    inputs: "The user's goal and requests from other agents.",
    outputs: "Delegated tasks, recruited agents, and a consolidated status.",
    handoffFrom: [],
    handoffTo: ["specifier", "planner", "implementer", "reviewer", "tester"],
    prompt: [
      "ROLE: Orchestrator. You coordinate this project: break the goal into tasks, recruit agents with `floq recruit` (use `floq roles` and `floq models` to choose), delegate with `floq ask --no-wait`, and act on replies when they arrive (`floq check` only when needed).",
      "Do NOT do implementation yourself unless it is trivial; delegate it. Other agents cannot recruit: when one messages you asking for a new agent, recruit it for them and tell them its name.",
      "REMINDER: only the orchestrator can recruit agents; everyone else asks the orchestrator.",
      "Drive the work forward yourself: when a report arrives and the best next step is clear (recruit the next agent, dispatch, verify, integrate, commit within what the user authorized), do it right away instead of recommending it and waiting. Stop only for decisions only the user can make and for Floq approvals (push, deploy, force operations).",
      ORCHESTRATOR_HANDOFF,
    ].join("\n"),
  },
];

export const GENERALIST_ID = "generalist";

const ROLE_BY_ID = new Map(AGENT_ROLES.map((r) => [r.id, r]));

export function listAgentRoles(): AgentRole[] {
  return AGENT_ROLES.map((r) => ({ ...r }));
}

export function getAgentRole(id: string): AgentRole | undefined {
  return ROLE_BY_ID.get(id);
}

/** Validate an optional role id from untrusted input. Generalist/empty means no preset (null). */
export function parseRoleId(value: unknown): AgentRole | null {
  if (value === undefined || value === null || value === "" || value === GENERALIST_ID) return null;
  if (typeof value !== "string" || !ROLE_BY_ID.has(value)) {
    throw badRequest("role must be one of: " + [GENERALIST_ID, ...ROLE_BY_ID.keys()].join(", "), "invalid_role");
  }
  return ROLE_BY_ID.get(value)!;
}

/**
 * First message for the agent: the role prompt, then the user's task. Used for both providers
 * because the initial prompt is the one injection point Floq already uses on fresh starts, and the
 * provider conversation keeps it across resume.
 */
export function composeRolePrompt(role: AgentRole | null, prompt: string | undefined): string | undefined {
  if (!role) return prompt;
  const header = "[Floq role preset: " + role.label + "]\n" + role.prompt;
  if (prompt) return header + "\n\nYour task:\n" + prompt;
  return header + "\n\nAcknowledge in one short line that you are ready as " + role.label + ", then wait for instructions.";
}

/** One line per role for comparison (`floq roles`). */
export function formatRoleLine(role: AgentRole): string {
  return [role.id.padEnd(12), role.capability.padEnd(16), role.readOnly ? "read-only" : "read-write", role.summary].join("  ");
}

/** Full description (`floq role ID`). */
export function describeRole(role: AgentRole): string {
  return [
    role.label + " (" + role.id + ")",
    role.summary,
    "",
    "Capability: " + role.capability + " - " + role.modelAdvice,
    "Suggested provider: " + (role.suggestedProvider ?? "any") + " (optional; override freely)",
    "Access: " + (role.readOnly ? "read-only (must not edit files)" : "read-write"),
    "When to use: " + role.whenToUse,
    "When not to use: " + role.whenNotToUse,
    "Inputs: " + role.inputs,
    "Outputs: " + role.outputs,
    "Receives handoff from: " + (role.handoffFrom.join(", ") || "none (start of chain)"),
    "Hands off to: " + (role.handoffTo.join(", ") || "none"),
  ].join("\n");
}

const CAPABILITY_PATTERNS: Record<RoleCapability, RegExp[]> = {
  // Word-boundary patterns: opus, o1/o3-style ids, "-pro" tiers.
  "reasoning-heavy": [/opus/i, /(^|[^a-z])o\d/i, /(^|[^a-z])pro([^a-z]|$)/i],
  "code-heavy": [/sonnet/i, /codex/i],
  "review-strict": [/opus/i, /sonnet/i, /codex/i],
  "fast-cheap": [/haiku/i, /mini/i, /nano/i, /flash/i],
};

/**
 * Deterministic fallback when the recruiting AI/UI does not choose a model: first configured model
 * matching the capability hint; otherwise null = the CLI's default. Never returns an id that is not in `models`.
 */
export function pickModelForCapability(capability: RoleCapability, models: ModelEntry[]): string | null {
  for (const pattern of CAPABILITY_PATTERNS[capability]) {
    const hit = models.find((m) => m.id !== "default" && pattern.test(m.id));
    if (hit) return hit.id;
  }
  return null;
}
