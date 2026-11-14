#!/usr/bin/env node
// Claude Code PreToolUse hook for the claude.ai "Artifact" tool: in Floq, deliverables are files in the Floq Artifacts
// folder, never pages published to claude.ai. Reading/listing (e.g. a pasted claude.ai link) stays allowed.
// Contract: tool payload as JSON on stdin; exit 2 + stderr = block and show stderr to the model; exit 0 = allow.
// Any parse problem allows the call (same fail-open behaviour as floq-block-native-subagent).
import { readFileSync } from "node:fs";

export const ALLOWED_ACTIONS = new Set(["read", "list"]);
export const REDIRECT_MESSAGE =
  "Publishing to claude.ai is disabled in Floq. In Floq, deliverables are files in the Floq Artifacts folder at $FLOQ_ARTIFACTS_DIR (shown in the Artifacts tab). Write the HTML/Markdown/PDF/etc. file there instead of using the Artifact tool, then tell the user the file name. (Artifact action \"read\" and \"list\" still work.)";

/** The redirect text with the session's real Artifacts path when the runtime set FLOQ_ARTIFACTS_DIR. */
export function redirectMessage(dir: string | undefined = process.env.FLOQ_ARTIFACTS_DIR): string {
  return dir && dir.trim() ? REDIRECT_MESSAGE.replace("$FLOQ_ARTIFACTS_DIR", `${dir.trim()} ($FLOQ_ARTIFACTS_DIR)`) : REDIRECT_MESSAGE;
}

export function decide(input: string): { block: boolean; message: string } {
  try {
    const payload = JSON.parse(input) as { tool_input?: { action?: unknown } | null };
    const action = payload.tool_input?.action;
    if (typeof action === "string" && ALLOWED_ACTIONS.has(action)) return { block: false, message: "" };
    return { block: true, message: redirectMessage() };
  } catch { /* malformed input: allow */ }
  return { block: false, message: "" };
}

if (process.argv[1] && /floq-artifact-redirect\.m?[jt]s$/.test(process.argv[1])) {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { /* no stdin: allow */ }
  const result = decide(input);
  if (result.block) {
    process.stderr.write(result.message + "\n");
    process.exit(2);
  }
}
