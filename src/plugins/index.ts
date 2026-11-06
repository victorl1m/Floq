import type { UiPluginDefinition } from "./sdk";

/** Tier 1 UI halves, code-split. Keyed by plugin id; each loader's module default-exports `defineUiPlugin({...})`. The example is dev builds only. */
export const UI_PLUGINS: Record<string, () => Promise<{ default: UiPluginDefinition }>> = {
  movidesk: () => import("./movidesk"),
  "azure-devops": () => import("./azure-devops"),
  waha: () => import("./waha"),
  ...(import.meta.env.DEV ? { example: () => import("./example") } : {}),
};
