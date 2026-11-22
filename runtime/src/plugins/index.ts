import type { PluginDefinition } from "./sdk.js";

import example from "./example/index.js";
import storageSense from "./storage-sense/index.js";
import whatsapp from "./whatsapp/index.js";

/**
 * Plugins compiled into the runtime. Static imports only. Production built-ins: storage-sense (it needs host access to user homes, which an installable package cannot get) and
 * whatsapp (id "waha": an integration, managed in Settings > Integrations and not listed under Plugins; it adopts the data of the deprecated
 * floq-plugin-waha in place). Movidesk and Azure DevOps
 * are installed from Settings > Plugins > Browse plugins (each lives in its own victorl1m/floq-plugin-<id> repository).
 * The example is dev-only: FLOQ_DEV_PLUGINS=1.
 */
export const BUILTIN_PLUGINS: PluginDefinition[] = [
  storageSense,
  whatsapp,
  ...(process.env.FLOQ_DEV_PLUGINS === "1" ? [example] : []),
];
