/**
 * Deterministic handoff for the Codex fallback step (docs/design/claude-swap-fallback.md section 3.7). Claude is blocked, so the
 * summary is built from local state only: no model call. The result is written by the runtime as the user's uid, mode 0600.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

export const HANDOFF_MAX_CHARS = 20_000;
const FIRST_PROMPT_CHARS = 4_000;
const PROMPT_CHARS = 1_500;
const REPLY_CHARS = 3_000;
const MAX_TODOS = 40;
const MAX_CHANGES = 60;

/** Same shape as the log scrubber: long token-like strings never reach a file other agents read. Absolute file paths are kept (the handoff points at them). */
export function redactSecrets(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=.:%]{24,}/g, (m) => (isFilePath(m) ? m : "[redacted]"));
}

/**
 * A file path, not a token: only path characters (no base64 "+" or "="), at least one slash, and either an absolute/home/relative
 * start or a file extension. "src/components/canvas/agent-node.tsx" and "/home/agent/.claude/projects/-w/abc.jsonl" are paths;
 * "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" (no extension, no leading slash) is not.
 */
function isFilePath(m: string): boolean {
  if (m.length > 400 || !/^[\w.@~/-]+$/.test(m) || !m.includes("/")) return false;
  return /^(~|\.{1,2})?\//.test(m) || /\.[A-Za-z0-9]{1,8}$/.test(m);
}

function lines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const rec: unknown = JSON.parse(line); if (isRec(rec)) out.push(rec); } catch { /* partial line */ }
  }
  return out;
}

function promptText(rec: Rec): string | null {
  if (rec.type !== "user" || rec.isSidechain === true || rec.isMeta === true || !isRec(rec.message)) return null;
  const content = rec.message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(isRec).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n") : "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export interface ClaudeContext {
  firstPrompt: string | null;
  lastPrompts: string[];
  lastReply: string | null;
  todos: Array<{ status: string; content: string }>;
}

/** What a Claude transcript says about the task: the first real prompt (from the head), the recent ones and reply (from the tail), the latest TodoWrite. */
export function parseClaudeContext(headText: string, tailText: string): ClaudeContext {
  let firstPrompt: string | null = null;
  for (const rec of lines(headText)) { const p = promptText(rec); if (p) { firstPrompt = p; break; } }
  const prompts: string[] = [];
  let lastReply: string | null = null;
  let todos: ClaudeContext["todos"] = [];
  let replyId: string | null = null;
  for (const rec of lines(tailText)) {
    if (rec.isSidechain === true) continue;
    const p = promptText(rec);
    if (p) { prompts.push(p); lastReply = null; replyId = null; continue; }
    if (rec.type !== "assistant" || !isRec(rec.message) || rec.isApiErrorMessage === true) continue;
    const items = Array.isArray(rec.message.content) ? rec.message.content.filter(isRec) : [];
    const text = items.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
    if (text.trim()) {
      const id = typeof rec.message.id === "string" ? rec.message.id : null;
      lastReply = id !== null && id === replyId && lastReply ? lastReply + text : text;
      replyId = id;
    }
    for (const item of items) {
      if (item.type === "tool_use" && item.name === "TodoWrite" && isRec(item.input) && Array.isArray(item.input.todos)) {
        todos = item.input.todos.filter(isRec).filter((t) => typeof t.content === "string").map((t) => ({ status: typeof t.status === "string" ? t.status : "pending", content: t.content as string }));
      }
    }
  }
  return { firstPrompt: firstPrompt ?? prompts[0] ?? null, lastPrompts: prompts.slice(-3), lastReply, todos };
}

export interface HandoffInput {
  direction: "to-codex" | "to-claude";
  title: string;
  cwd: string;
  role: string | null;
  parentSessionId: string | null;
  /** Window that was blocked and when it resets (UTC ISO), for the reader's context. */
  reason: { window: string; resetsAt: string | null } | null;
  context: ClaudeContext;
  git: { branch: string | null; changes: Array<{ status: string; path: string }>; truncated: boolean } | null;
  /** Sandbox path of the full transcript the reader may open (Claude: ~/.claude/projects/.../<id>.jsonl). */
  transcriptPath: string | null;
  /** to-claude: the Codex agent's final reply. */
  codexReply?: string | null;
  /** to-claude: the earlier handoff file the Codex agent started from. */
  previousHandoff?: string | null;
}

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "\n[cut: " + (text.length - max) + " more chars]" : text);
const fence = (text: string) => "```text\n" + text.replace(/```/g, "'''") + "\n```";

/** Markdown handoff, at most HANDOFF_MAX_CHARS, token-like strings redacted. */
export function buildHandoff(input: HandoffInput): string {
  const out: string[] = [];
  out.push(input.direction === "to-codex" ? "# Handoff: Claude to Codex" : "# Handoff: Codex back to Claude");
  out.push(
    input.direction === "to-codex"
      ? "The Claude agent hit its plan usage limit" + (input.reason ? ` (${input.reason.window}${input.reason.resetsAt ? ", resets " + input.reason.resetsAt : ""})` : "") + ". You continue its task in the same checkout. Do not redo finished steps."
      : "A Codex agent continued this task while Claude was limited. What it did is below; the checkout already contains its changes.",
  );
  out.push(`- Agent: ${input.title}\n- Directory: ${input.cwd}${input.role ? `\n- Role: ${input.role}` : ""}${input.parentSessionId ? `\n- Parent agent (Floq UUID): ${input.parentSessionId}` : ""}`);
  if (input.direction === "to-claude") {
    out.push("## What the Codex agent reported last\n" + (input.codexReply ? fence(cut(input.codexReply, REPLY_CHARS)) : "(no final message)"));
    if (input.previousHandoff) out.push("It started from " + input.previousHandoff);
  } else {
    out.push("## Original task\n" + (input.context.firstPrompt ? fence(cut(input.context.firstPrompt, FIRST_PROMPT_CHARS)) : "(not found in the transcript)"));
    if (input.context.lastPrompts.length) out.push("## Latest requests\n" + input.context.lastPrompts.map((p, i) => `${i + 1}. ${cut(p, PROMPT_CHARS).replace(/\n+/g, " ")}`).join("\n"));
    if (input.context.lastReply) out.push("## Claude's last reply\n" + fence(cut(input.context.lastReply, REPLY_CHARS)));
    if (input.context.todos.length) {
      out.push("## Todo list at the time\n" + input.context.todos.slice(0, MAX_TODOS).map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${cut(t.content, 200)}`).join("\n"));
    }
  }
  if (input.git) {
    const changes = input.git.changes.slice(0, MAX_CHANGES).map((c) => `${c.status.padEnd(2)} ${c.path}`);
    out.push(`## Working tree${input.git.branch ? ` (branch ${input.git.branch})` : ""}\n` + (changes.length ? fence(changes.join("\n") + (input.git.truncated || input.git.changes.length > MAX_CHANGES ? "\n[more files not listed]" : "")) : "No uncommitted changes."));
  }
  if (input.transcriptPath) out.push("## Full history\nThe complete Claude conversation is at " + input.transcriptPath + " (JSON lines). Read it only if this summary is not enough.");
  const text = redactSecrets(out.join("\n\n")) + "\n";
  return text.length > HANDOFF_MAX_CHARS ? text.slice(0, HANDOFF_MAX_CHARS - 30) + "\n[handoff cut at the size limit]\n" : text;
}

/** Initial prompt for the fresh Codex conversation (typed as argv after `--`, no shell). */
export function codexHandoffPrompt(sandboxPath: string): string {
  return `[Floq] You are taking over a task from a Claude agent that hit its usage limit. Read ${sandboxPath} first, then continue the work. Do not redo finished steps.`;
}

export function codexResumeNotice(sandboxPath: string): string {
  return `[Floq] Claude hit its usage limit again and this task is back with you. Read ${sandboxPath}, then continue the work. Do not redo finished steps.`;
}

export function claudeBackNotice(sandboxPath: string): string {
  return `[Floq] Back on Claude (limit reset). While you were limited, a Codex agent continued this task: read ${sandboxPath} for what changed.`;
}
