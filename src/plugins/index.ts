import type { UiPluginDefinition } from "./sdk";

/**
 * UI halves compiled into the app, code-split and keyed by plugin id; each loader's module default-exports `defineUiPlugin({...})`.
 * Storage Sense and WhatsApp (id "waha") are the production halves (their runtime halves are bundled): installed plugins ship their UI inside the package (see remote-ui.ts). The example is dev builds only.
 */
export const UI_PLUGINS: Record<string, () => Promise<{ default: UiPluginDefinition }>> = {
  "storage-sense": () => import("./storage-sense"),
  waha: () => import("./whatsapp"),
  ...(import.meta.env.DEV ? { example: () => import("./example") } : {}),
};
