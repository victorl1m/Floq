#!/usr/bin/env node
// Claude Code PreToolUse hook (defence in depth behind the --disallowedTools deny rule): refuses the provider-native
// subagent tools ("Agent", formerly "Task") and tells the model how to recruit through Floq instead.
// Contract: tool payload as JSON on stdin; exit 2 + stderr = block and show stderr to the model; exit 0 = allow.
// Any parse problem allows the call: the deny rule is the hard layer, this one only improves the message.
import { readFileSync } from "node:fs";

export const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
export const BLOCK_MESSAGE =
  'Native subagents are disabled in Floq (they are invisible to the user and cannot be messaged). Recruit a visible Floq subagent instead: floq subagent recruit "Name" --task "self-contained task with paths and a done-criterion". Then use floq subagent list|ask|result|dismiss.';

export function decide(input: string): { block: boolean; message: string } {
  try {
    const payload = JSON.parse(input) as { tool_name?: unknown };
    if (typeof payload.tool_name === "string" && NATIVE_SUBAGENT_TOOLS.has(payload.tool_name)) return { block: true, message: BLOCK_MESSAGE };
  } catch { /* malformed input: allow */ }
  return { block: false, message: "" };
}

if (process.argv[1] && /floq-block-native-subagent\.m?[jt]s$/.test(process.argv[1])) {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { /* no stdin: allow */ }
  const result = decide(input);
  if (result.block) {
    process.stderr.write(result.message + "\n");
    process.exit(2);
  }
}
