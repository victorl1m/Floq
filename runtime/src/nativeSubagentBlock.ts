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

export const QUESTION_HOOK_PATH = "/usr/local/bin/floq-native-question.mjs";
export const PERMISSION_HOOK_PATH = "/usr/local/bin/floq-permission-request.mjs";
export const BLOCK_HOOK_PATH = "/usr/local/bin/floq-block-native-subagent.mjs";
export const ARTIFACT_HOOK_PATH = "/usr/local/bin/floq-artifact-redirect.mjs";
export const CLAUDE_BLOCKED_TOOLS = ["Agent", "Task"] as const;
export const CODEX_DISABLED_FEATURES = ["multi_agent", "multi_agent_v2"] as const;
/** PreToolUse hooks arrived in Claude Code 1.0.38; older builds are only covered by the deny flag. */
const MIN_HOOK_VERSION: [number, number, number] = [1, 0, 38];
const PERMISSION_HOOK_VERSION: [number, number, number] = [2, 0, 45];
const VERIFIED_QUESTION_VERSION: [number, number, number] = [2, 1, 318];

export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

export function claudeBlockSettings(hookPath = BLOCK_HOOK_PATH, questionHookPath: string | null = null, permissionHookPath: string | null = null, artifactHookPath: string | null = null): Record<string, unknown> {
  return {
    permissions: { deny: [...CLAUDE_BLOCKED_TOOLS] },
    // The hook waits < 45 s (Claude auto-blocks unattended prompts then); the timeout is a backstop only.
    hooks: { ...(permissionHookPath ? { PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: `node ${permissionHookPath}`, timeout: 50 }] }] } : {}), PreToolUse: [{ matcher: CLAUDE_BLOCKED_TOOLS.join("|"), hooks: [{ type: "command", command: `node ${hookPath}` }] }, ...(artifactHookPath ? [{ matcher: "^Artifact$", hooks: [{ type: "command", command: `node ${artifactHookPath}` }] }] : []), ...(questionHookPath ? [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: `node ${questionHookPath}`, timeout: 86400 }] }] : [])] },
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
  // Verified against a live interactive Claude Code 2.1.318 capture (test/fixtures/claude-askuserquestion-2.1.318.json):
  // PreToolUse payload + updatedInput.answers resolved the native prompt. Any hook failure falls back to the terminal.
  const questionHook = version && atLeast(version, VERIFIED_QUESTION_VERSION) && (options.hookExists ?? existsSync)(QUESTION_HOOK_PATH) ? QUESTION_HOOK_PATH : null;
  // PermissionRequest exists since Claude Code 2.0.45; the hook only answers allow/deny after the user decides in Floq.
  const permissionHook = (options.hookExists ?? existsSync)(PERMISSION_HOOK_PATH) && (!version || atLeast(version, PERMISSION_HOOK_VERSION)) ? PERMISSION_HOOK_PATH : null;
  // The claude.ai Artifact tool stays available for read/list; the hook refuses publishing and points at the Floq Artifacts folder.
  const artifactHook = (options.hookExists ?? existsSync)(ARTIFACT_HOOK_PATH) ? ARTIFACT_HOOK_PATH : null;
  args.push("--settings", JSON.stringify(claudeBlockSettings(hookPath, questionHook, permissionHook, artifactHook)));
  return args;
}
