import type { PluginDefinition } from "./sdk.js";

import example from "./example/index.js";
import storageSense from "./storage-sense/index.js";

/**
 * Plugins compiled into the runtime. Static imports only. The only production built-in is storage-sense (it needs host access to user homes, which an installable package cannot get). Movidesk, Azure DevOps and WAHA
 * are installed from Settings > Plugins > Browse plugins (each lives in its own victorl1m/floq-plugin-<id> repository).
 * The example is dev-only: FLOQ_DEV_PLUGINS=1.
 */
export const BUILTIN_PLUGINS: PluginDefinition[] = [
  storageSense,
  ...(process.env.FLOQ_DEV_PLUGINS === "1" ? [example] : []),
];
