import type { PluginDefinition } from "./sdk.js";

import example from "./example/index.js";

/**
 * Plugins compiled into the runtime. Static imports only. There are no production built-ins: Movidesk, Azure DevOps and WAHA
 * are installed from Settings > Plugins > Browse plugins (each lives in its own victorl1m/floq-plugin-<id> repository).
 * The example is dev-only: FLOQ_DEV_PLUGINS=1.
 */
export const BUILTIN_PLUGINS: PluginDefinition[] = [
  ...(process.env.FLOQ_DEV_PLUGINS === "1" ? [example] : []),
];
