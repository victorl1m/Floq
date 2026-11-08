// Pure contribution logic. Relative imports only so scripts/dev/test-plugin-host.mjs can load it without a bundler.
import type { ComponentType } from "react";
import type { PluginInfo, PluginViewDecl, PluginRightSidebarTabDecl, PluginTaskSourceDecl } from "../lib/runtime/types";
import type { PluginViewProps, PluginTabProps, PluginTaskSourceProps, UiPluginDefinition } from "./sdk";

export interface ActiveView { pluginId: string; viewId: string; label: string; icon?: string; plugin: PluginInfo; decl: PluginViewDecl; Component: ComponentType<PluginViewProps> }
export interface ActiveTab { pluginId: string; tabId: string; label: string; icon?: string; plugin: PluginInfo; decl: PluginRightSidebarTabDecl; Component: ComponentType<PluginTabProps> }
export interface ActiveTaskSource { pluginId: string; sourceId: string; label: string; plugin: PluginInfo; decl: PluginTaskSourceDecl; Component: ComponentType<PluginTaskSourceProps> | null }

export interface Contributions { plugins: PluginInfo[]; views: ActiveView[]; tabs: ActiveTab[]; taskSources: ActiveTaskSource[] }

/** A plugin contributes only while the server says it is enabled for this user. Status disabled/failed/invalid, or unknown to the server, contributes nothing. */
export const isActive = (p: PluginInfo) => p.status === "enabled" && p.enabled && p.userEnabled;

/**
 * Server list x loaded UI halves -> what the app may render. Plugins sort by name (docs/DESIGN.md "Plugins"), then manifest order.
 * A view needs both a manifest declaration and a UI component; UI definitions for plugins the server does not list are ignored.
 */
export function activeContributions(server: PluginInfo[], loaded: Record<string, UiPluginDefinition | undefined>): Contributions {
  const plugins = server.filter(isActive).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const out: Contributions = { plugins, views: [], tabs: [], taskSources: [] };
  for (const plugin of plugins) {
    const ui = loaded[plugin.id];
    for (const decl of plugin.contributes.views) {
      const Component = ui?.views?.[decl.id];
      if (Component) out.views.push({ pluginId: plugin.id, viewId: decl.id, label: decl.label, icon: decl.icon ?? plugin.icon, plugin, decl, Component });
    }
    for (const decl of plugin.contributes.rightSidebarTabs) {
      const Component = ui?.rightSidebarTabs?.[decl.id];
      if (Component) out.tabs.push({ pluginId: plugin.id, tabId: decl.id, label: decl.label, icon: decl.icon ?? plugin.icon, plugin, decl, Component });
    }
    for (const decl of plugin.contributes.taskSources) {
      // "generic" sources are rendered by the host; "custom" ones need the plugin's component.
      const Component = ui?.taskSources?.[decl.id] ?? null;
      if (decl.view === "generic" || Component) out.taskSources.push({ pluginId: plugin.id, sourceId: decl.id, label: decl.label, plugin, decl, Component });
    }
  }
  return out;
}

/** Ids the provider should load UI code for. */
export const idsToLoad = (server: PluginInfo[], known: Record<string, unknown>, loaders: Record<string, unknown>) =>
  server.filter((p) => isActive(p) && loaders[p.id] && !(p.id in known)).map((p) => p.id);
