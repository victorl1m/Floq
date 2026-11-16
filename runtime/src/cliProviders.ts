/**
 * Launch helpers for the API-key CLI providers (OpenCode, Antigravity): per-session config, instructions, native
 * subagent blocking and conversation-id discovery. Pure functions so they stay unit-testable; the manager does the I/O.
 */

/** Private per-session config home (relative to the user's home), the equivalent of codex's CODEX_HOME. */
export const opencodeHomeRel = (id: string) => ".floq/opencode/" + id;

/** Shared, session-agnostic Floq guidance for CLIs that read a global rules file (agy). Per-session text goes in the first prompt. */
export const FLOQ_RULES_GUIDANCE = [
  "# Floq",
  "",
  "You run inside Floq. Use the floq CLI to coordinate agents and to inspect Floq-installed skills, MCP servers and secrets (`floq --help`).",
  "Antigravity's own /swarm, invoke_subagent and run_workflow are allowed here: Floq mirrors every swarm worker and subagent as an agent on the canvas. You can still recruit full Floq agents with `floq subagent recruit`. Read the floq-orchestrate skill before coordinating.",
  "Swarms and subagents spend the user's Gemini quota in parallel: start them only for work that really splits.",
  "Never expose secret values; `floq secrets list` shows names only.",
  "",
].join("\n");

/**
 * Inline OpenCode config (OPENCODE_CONFIG_CONTENT, merged over the user config).
 * - instructions: the composed Floq system block, re-read on every start and resume.
 * - permission.task = deny: OpenCode's native subagent tool; `--auto` approves everything that is not explicitly denied.
 * - autoupdate off: the image pins the version.
 */
export function opencodeConfigContent(instructionsPath: string | null): string {
  return JSON.stringify({
    autoupdate: false,
    permission: { task: "deny" },
    ...(instructionsPath ? { instructions: [instructionsPath] } : {}),
  });
}

/**
 * agy's Google-login token file (~/.gemini/antigravity-cli/antigravity-oauth-token). The format is not verified against a real
 * account: a JSON object must carry a token string; a non-JSON (opaque / encoded) non-empty file is accepted as is.
 */
export function agyTokenValid(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text.trim().length > 0;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return /"[a-z_]*(access|refresh|id)_?token"\s*:\s*"[^"]/i.test(text);
}

/**
 * Session-only Antigravity settings (`--settings`, never saved). `gemini` model provider is what makes GEMINI_API_KEY effective,
 * so it is set only when the API key is the chosen route: a Google login (`oauth`) wins and must not get modelProvider.
 */
export function antigravitySettings(opts: { hasApiKey: boolean; oauth?: boolean; trustedWorkspaces: string[] }): string | null {
  const settings: Record<string, unknown> = {};
  if (opts.hasApiKey && !opts.oauth) settings.modelProvider = "gemini";
  if (opts.trustedWorkspaces.length) settings.trustedWorkspaces = opts.trustedWorkspaces;
  return Object.keys(settings).length ? JSON.stringify(settings) : null;
}

/** argv elements are capped at 128 KiB (MAX_ARG_STRLEN); the whole -i text stays well under it. */
export const AGY_BLOCK_MAX_BYTES = 64 * 1024;
export const AGY_PROMPT_MAX_BYTES = 100 * 1024;

/** Cut `text` to at most `maxBytes` of UTF-8 on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Initial prompt for a (re)started agy session: it has no system-prompt flag, so the Floq block rides in the first message. */
export function antigravityPrompt(block: string, prompt: string | undefined, resuming: boolean): string | null {
  const parts: string[] = [];
  const userBytes = prompt?.trim() ? Buffer.byteLength(prompt, "utf8") : 0;
  const room = Math.max(8 * 1024, Math.min(AGY_BLOCK_MAX_BYTES, AGY_PROMPT_MAX_BYTES - userBytes - 1024));
  if (Buffer.byteLength(block, "utf8") > room) block = truncateUtf8(block, room) + "\n\n[Floq context truncated here; run `floq wired` for the rest.]";
  if (block.trim()) {
    parts.push(
      (resuming ? "[Floq session context, refreshed on resume. Keep following it; no reply needed beyond a brief acknowledgement.]" : "[Floq session context. Follow it for the whole conversation.]") + "\n\n" + block,
    );
  }
  if (prompt?.trim()) parts.push(prompt);
  return parts.length ? parts.join("\n\n---\n\n") : null;
}

/** `opencode session list --format json` output: newest root session id (ses_*) at or after `since`, or null. */
export function parseOpencodeSessionId(stdout: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : [];
  let best: { id: string; t: number } | null = null;
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(id)) continue;
    if (typeof rec.parentID === "string" || typeof rec.parent_id === "string") continue;
    const updated = rec.updated ?? rec.time_updated ?? (typeof rec.time === "object" && rec.time ? (rec.time as Record<string, unknown>).updated : 0);
    const t = typeof updated === "number" ? updated : 0;
    if (!best || t >= best.t) best = { id, t };
  }
  return best?.id ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `cache/last_conversations.json` is a map workspace path -> most recent conversation id (uuid). */
export function parseAntigravityConversationId(json: string, cwds: string[]): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  for (const cwd of cwds) {
    const id = (parsed as Record<string, unknown>)[cwd];
    if (typeof id === "string" && UUID.test(id)) return id;
  }
  return null;
}
