import type { UiPluginDefinition } from "./sdk";

/**
 * UI halves compiled into the app, code-split and keyed by plugin id; each loader's module default-exports `defineUiPlugin({...})`.
 * Storage Sense is the one production half (its runtime half is bundled): installed plugins ship their UI inside the package (see remote-ui.ts). The example is dev builds only.
 */
export const UI_PLUGINS: Record<string, () => Promise<{ default: UiPluginDefinition }>> = {
  "storage-sense": () => import("./storage-sense"),
  ...(import.meta.env.DEV ? { example: () => import("./example") } : {}),
};
