import type { ProviderId } from "./types.js";

/** `specify init` integration flags per provider (Spec Kit's `--integration` replaced `--ai`). Antigravity's integration is `agy`. */
export function specKitIntegrationArgs(provider: ProviderId): string[] | null {
  switch (provider) {
    case "claude": return ["--integration", "claude"];
    case "codex": return ["--integration", "codex", "--integration-options=--skills"];
    case "opencode": return ["--integration", "opencode"];
    case "antigravity": return ["--integration", "agy"];
    default: return null;
  }
}
