import type { UiPluginDefinition } from "./sdk";

/**
 * UI halves compiled into the app, code-split and keyed by plugin id; each loader's module default-exports `defineUiPlugin({...})`.
 * There are none in production: installed plugins ship their UI inside the package (see remote-ui.ts). The example is dev builds only.
 */
export const UI_PLUGINS: Record<string, () => Promise<{ default: UiPluginDefinition }>> = {
  ...(import.meta.env.DEV ? { example: () => import("./example") } : {}),
};
