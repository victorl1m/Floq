// Bundled plugins that are integrations: managed in Settings > Integrations, never listed in Settings > Plugins or the plugin catalog.
// Relative imports only (runs under plain node tests).
import type { PluginInfo } from "../lib/runtime/types";

/** WhatsApp: the former catalog plugin "waha" (floq-plugin-waha), now part of Floq under the same id. */
export const WHATSAPP_PLUGIN_ID = "waha";
export const INTEGRATION_PLUGIN_IDS: readonly string[] = [WHATSAPP_PLUGIN_ID];

export const isIntegration = (p: Pick<PluginInfo, "id" | "integration">): boolean => Boolean(p.integration) || INTEGRATION_PLUGIN_IDS.includes(p.id);
