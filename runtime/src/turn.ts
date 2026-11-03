/** Pure helpers that read an agent's native transcript (Claude projects jsonl, Codex rollout jsonl). */

export type TurnStatus = "working" | "idle";

export interface TranscriptTurn {
  /** Real user prompts seen so far (tool results and meta records are not counted). */
  prompts: number;
  /** working: a turn is open; idle: the last turn completed (or nothing has started). */
  status: TurnStatus;
  /** Full text of the final assistant message of the last turn, or null if there is none yet. */
  reply: string | null;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

function blocks(content: unknown): Rec[] {
  return Array.isArray(content) ? content.filter(isRec) : [];
}

function parseLines(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const rec: unknown = JSON.parse(line); if (isRec(rec)) out.push(rec); } catch { /* partial or malformed line */ }
  }
  return out;
}

function claudeTurn(records: Rec[]): TranscriptTurn {
  const turn: TranscriptTurn = { prompts: 0, status: "idle", reply: null };
  let replyId: string | null = null;
  for (const rec of records) {
    if (rec.isSidechain === true) continue;
    const message = isRec(rec.message) ? rec.message : null;
    if (rec.type === "user" && message) {
      const content = message.content;
      const isPrompt = rec.isMeta !== true && (typeof content === "string" ? content.trim() !== "" : blocks(content).some((b) => b.type === "text"));
      if (isPrompt) { turn.prompts++; turn.status = "working"; turn.reply = null; replyId = null }
    } else if (rec.type === "assistant" && message) {
      const items = blocks(message.content);
      const text = items.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
      if (text.trim()) {
        // One assistant message can be written as several records sharing message.id; join their text blocks.
        const id = typeof message.id === "string" ? message.id : null;
        turn.reply = id !== null && id === replyId && turn.reply ? turn.reply + text : text;
        replyId = id;
      }
      if (message.stop_reason === "end_turn") turn.status = "idle";
    } else if (rec.type === "system" && rec.subtype === "turn_duration") {
      turn.status = "idle";
    }
  }
  return turn;
}

function codexTurn(records: Rec[]): TranscriptTurn {
  const turn: TranscriptTurn = { prompts: 0, status: "idle", reply: null };
  for (const rec of records) {
    const payload = isRec(rec.payload) ? rec.payload : null;
    if (rec.type !== "event_msg" || !payload) continue;
    switch (payload.type) {
      case "user_message": turn.prompts++; turn.status = "working"; turn.reply = null; break;
      case "task_started": turn.status = "working"; break;
      case "agent_message": if (typeof payload.message === "string" && payload.message.trim()) turn.reply = payload.message; break;
      case "task_complete":
        turn.status = "idle";
        if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) turn.reply = payload.last_agent_message;
        break;
      case "turn_aborted": turn.status = "idle"; break;
    }
  }
  return turn;
}

/** Summarize the last turn of a transcript (jsonl text). A partial first line (tail read) is ignored. */
export function analyzeTranscript(provider: "claude" | "codex", text: string): TranscriptTurn {
  const records = parseLines(text);
  return provider === "claude" ? claudeTurn(records) : codexTurn(records);
}

/** Whether the last line of a Claude transcript is a finished text-only assistant message (no stop_reason written). */
export function endsWithAssistantText(text: string): boolean {
  const records = parseLines(text);
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!;
    if (rec.isSidechain === true || (rec.type !== "assistant" && rec.type !== "user")) continue;
    if (rec.type !== "assistant" || !isRec(rec.message)) return false;
    const items = blocks(rec.message.content);
    return !items.some((b) => b.type === "tool_use") && items.some((b) => b.type === "text");
  }
  return false;
}

export const DEFAULT_REPLY_CHARS = 20_000;

/**
 * Cap a reply at `limit` characters keeping the START of the message (reports lead with findings) and say how
 * much was cut. `full` or a null limit returns the text unchanged.
 */
export function truncateReply(text: string, limit: number | null): { text: string; truncated: number } {
  if (limit === null || text.length <= limit) return { text, truncated: 0 };
  return { text: text.slice(0, limit), truncated: text.length - limit };
}

export function truncationNote(truncated: number): string {
  return truncated > 0 ? "[truncated: " + truncated + " more chars, use --full]" : "";
}

export type AgentStatus = "working" | "idle" | "waiting-for-input" | "exited" | "asleep";

/** A turn that looks open but has had no terminal output this long (the spinner animates while working) is stuck on a prompt. */
export const WAITING_INPUT_QUIET_MS = 60_000;
/** Claude may not write stop_reason: a text-only assistant message with an untouched transcript this long is final. */
export const TRAILING_TEXT_IDLE_MS = 8_000;
/** Without a transcript, no terminal output for this long counts as idle. */
export const TERMINAL_QUIET_MS = 5_000;

export interface StatusInput {
  alive: boolean;
  sessionState: string;
  turn: (TranscriptTurn & { trailingAssistantText?: boolean }) | null;
  /** ms since the terminal last produced output. */
  outputQuietMs: number;
  /** ms since the transcript file was last written (when there is a transcript). */
  transcriptQuietMs: number;
}

export function agentStatus(input: StatusInput): AgentStatus {
  if (input.sessionState === "sleeping") return "asleep";
  if (!input.alive || input.sessionState === "exited" || input.sessionState === "failed") return "exited";
  const turn = input.turn;
  if (!turn) return input.outputQuietMs >= TERMINAL_QUIET_MS ? "idle" : "working";
  if (turn.status === "idle") return "idle";
  if (turn.trailingAssistantText && input.transcriptQuietMs >= TRAILING_TEXT_IDLE_MS && input.outputQuietMs >= TERMINAL_QUIET_MS) return "idle";
  return input.outputQuietMs >= WAITING_INPUT_QUIET_MS ? "waiting-for-input" : "working";
}
