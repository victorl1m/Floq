/**
 * Features this runtime offers beyond the base protocol, advertised in /v1/info so a newer app can fall back on an
 * older runtime (the runtime is deployed separately from the desktop app). Old runtimes omit the field.
 * - branch-switch-v2: POST .../branch honours {dryRun:true} as a read-only pre-flight, never requires agents to be
 *   asleep, and lets git decide about local changes.
 */
export const RUNTIME_CAPABILITIES: readonly string[] = ["branch-switch-v2"];
