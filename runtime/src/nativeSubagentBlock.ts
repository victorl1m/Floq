/**
 * Hard enforcement: provider-native subagents (Claude Code's Agent/Task tool and background agents, Codex multi_agent)
 * are never allowed in Floq sessions, whatever the "always recruit" setting says. Hidden agents cannot be seen or
 * messaged on the canvas and burn quota invisibly; Floq recruiting (`floq subagent recruit`) is the only path.
 *
 * Claude layers: CLI --disallowedTools (removes the tool from the model's tool list; CLI flags outrank user/project
 * settings), an inline --settings PreToolUse hook that explains the refusal, and image-level managed settings
 * (/etc/claude-code/managed-settings.json, read-only to the agent). Codex: -c feature overrides (outrank config.toml).
 */
import { existsSync } from "node:fs";
import type { ProviderId } from "./types.js";

export const BLOCK_HOOK_PATH = "/usr/local/bin/floq-block-native-subagent.mjs";
export const CLAUDE_BLOCKED_TOOLS = ["Agent", "Task"] as const;
export const CODEX_DISABLED_FEATURES = ["multi_agent", "multi_agent_v2"] as const;
/** PreToolUse hooks arrived in Claude Code 1.0.38; older builds are only covered by the deny flag. */
const MIN_HOOK_VERSION: [number, number, number] = [1, 0, 38];

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

export function claudeBlockSettings(hookPath = BLOCK_HOOK_PATH): Record<string, unknown> {
  return {
    permissions: { deny: [...CLAUDE_BLOCKED_TOOLS] },
    hooks: { PreToolUse: [{ matcher: CLAUDE_BLOCKED_TOOLS.join("|"), hooks: [{ type: "command", command: `node ${hookPath}` }] }] },
  };
}

export interface NativeBlockOptions {
  /** `--version` output of the provider CLI, if known. Unknown is treated as modern. */
  version?: string | null;
  hookPath?: string;
  hookExists?: (path: string) => boolean;
  warn?: (message: string) => void;
}

/** Launch args that disable native subagents; identical for fresh starts and resumes. Never throws. */
export function nativeSubagentBlockArgs(provider: ProviderId, options: NativeBlockOptions = {}): string[] {
  if (provider === "codex") return CODEX_DISABLED_FEATURES.flatMap((f) => ["-c", `features.${f}=false`]);
  if (provider !== "claude") return [];
  const args = ["--disallowedTools", CLAUDE_BLOCKED_TOOLS.join(",")];
  const hookPath = options.hookPath ?? BLOCK_HOOK_PATH;
  const version = parseVersion(options.version);
  if (version && !atLeast(version, MIN_HOOK_VERSION)) {
    options.warn?.(`Claude Code ${version.join(".")} predates hooks; native subagents blocked by deny flag only`);
    return args;
  }
  if (!(options.hookExists ?? existsSync)(hookPath)) {
    options.warn?.(`native-subagent hook missing at ${hookPath}; native subagents blocked by deny flag only`);
    return args;
  }
  args.push("--settings", JSON.stringify(claudeBlockSettings(hookPath)));
  return args;
}
