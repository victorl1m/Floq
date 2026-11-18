import { randomUUID } from "node:crypto";

/** Pointer history: every provider conversation an agent has had. Rows are deleted only with the agent (ON DELETE CASCADE). */
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface ConversationRow {
  id: string;
  provider: string;
  providerSessionId: string;
  startedAt: string;
  endedReason: string | null;
  current: boolean;
}

export type EndedReason = "fresh_start" | "provider_switch" | "switched" | "superseded";

/** Claude's conversation id: the current agent_conversations row, or the agent id for agents that predate the table. */
export function resolveClaudeConversationId(row: { id: string; claude_conversation_id?: string | null }): string {
  return row.claude_conversation_id || row.id;
}

/** What "Start fresh" does to the pointers. Pure so the state change is testable without a database. */
export function planFreshStart(provider: string, currentPointer: string | null, newId: () => string = randomUUID): {
  endCurrent: { provider: string; providerSessionId: string; reason: EndedReason } | null;
  /** Claude only: the new conversation id to launch with (--session-id) and record. */
  newClaudeId: string | null;
  /** Non-Claude: the agent_sessions.provider_session_id after the change (null = capture the new conversation). */
  pointerAfter: string | null;
  resume: false;
} {
  const endCurrent = currentPointer ? { provider, providerSessionId: currentPointer, reason: "fresh_start" as const } : null;
  if (provider === "claude") return { endCurrent, newClaudeId: newId(), pointerAfter: null, resume: false };
  return { endCurrent, newClaudeId: null, pointerAfter: null, resume: false };
}

/** Whether a history row can be switched to for an agent currently on `provider`. */
export function canSwitchTo(agentProvider: string, target: { provider: string; endedReason: string | null }): boolean {
  return target.provider === agentProvider;
}

export const CLAUDE_CONVERSATION_SQL =
  "(SELECT c.provider_session_id FROM agent_conversations c WHERE c.session_id = s.id AND c.provider = 'claude' AND (c.ended_reason IS NULL OR c.ended_reason = 'provider_switch') ORDER BY c.id DESC LIMIT 1)";

/** Record a pointer as the agent's current conversation for that provider; an older current one is marked superseded. */
export async function recordConversation(db: Queryable, sessionId: string, provider: string, providerSessionId: string): Promise<void> {
  await db.query(
    "UPDATE agent_conversations SET ended_reason = 'superseded' WHERE session_id = $1 AND provider = $2 AND ended_reason IS NULL AND provider_session_id <> $3",
    [sessionId, provider, providerSessionId],
  );
  await db.query(
    "INSERT INTO agent_conversations (session_id, provider, provider_session_id) VALUES ($1, $2, $3) ON CONFLICT (session_id, provider, provider_session_id) DO UPDATE SET ended_reason = NULL WHERE agent_conversations.ended_reason = 'superseded'",
    [sessionId, provider, providerSessionId],
  );
}

export async function endConversation(db: Queryable, sessionId: string, provider: string, providerSessionId: string, reason: EndedReason): Promise<void> {
  await db.query(
    "UPDATE agent_conversations SET ended_reason = $4 WHERE session_id = $1 AND provider = $2 AND provider_session_id = $3 AND ended_reason IS NULL",
    [sessionId, provider, providerSessionId, reason],
  );
}

export async function listConversations(db: Queryable, sessionId: string): Promise<ConversationRow[]> {
  const r = await db.query(
    "SELECT id, provider, provider_session_id, started_at, ended_reason FROM agent_conversations WHERE session_id = $1 ORDER BY started_at DESC, id DESC",
    [sessionId],
  );
  return r.rows.map((x) => ({ id: String(x.id), provider: x.provider, providerSessionId: x.provider_session_id, startedAt: new Date(x.started_at).toISOString(), endedReason: x.ended_reason, current: x.ended_reason === null }));
}
