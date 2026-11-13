/**
 * Features this runtime offers beyond the base protocol, advertised in /v1/info so a newer app can fall back on an
 * older runtime (the runtime is deployed separately from the desktop app). Old runtimes omit the field.
 * - branch-switch-v2: POST .../branch honours {dryRun:true} as a read-only pre-flight, never requires agents to be
 *   asleep, and lets git decide about local changes.
 */
export const RUNTIME_CAPABILITIES: readonly string[] = ["branch-switch-v2"];

/** The agent browser in this runtime's image: "available", "disabled" (FLOQ_AGENT_BROWSER=off) or "missing" (image built without it). */
export type BrowserCapability = "available" | "disabled" | "missing";

/** The base capability list plus "agent-browser" when the browser is usable on this server. */
export function runtimeCapabilities(browser: BrowserCapability = "missing"): string[] {
  return [...RUNTIME_CAPABILITIES, ...(browser === "available" ? ["agent-browser"] : [])];
}
