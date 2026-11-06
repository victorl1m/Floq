import type { PluginDefinition } from "./sdk.js";

import example from "./example/index.js";
import azureDevops from "./azure-devops/index.js";
import movidesk from "./movidesk/index.js";
import waha from "./waha/index.js";

/** Tier 1 plugins compiled into the runtime. Static imports only. The example is dev-only: FLOQ_DEV_PLUGINS=1. */
export const BUILTIN_PLUGINS: PluginDefinition[] = [
  movidesk,
  azureDevops,
  waha,
  ...(process.env.FLOQ_DEV_PLUGINS === "1" ? [example] : []),
];
