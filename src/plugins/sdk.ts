import type { ComponentType } from "react";
import type { PluginInfo, PluginViewDecl, PluginTaskSourceDecl, PluginRightSidebarTabDecl } from "../lib/runtime/types";

export type {
  PluginInfo, PluginScope, PluginStatus, PluginSettingDecl, PluginSettingType, PluginSettingValues,
  PluginViewDecl, PluginTaskSourceDecl, PluginRightSidebarTabDecl, PluginContributes,
} from "../lib/runtime/types";

/** Props every plugin view receives. */
export interface PluginViewProps { plugin: PluginInfo; view: PluginViewDecl }
export interface PluginTabProps { plugin: PluginInfo; tab: PluginRightSidebarTabDecl }
export interface PluginTaskSourceProps { plugin: PluginInfo; source: PluginTaskSourceDecl }

/**
 * UI half of a plugin. Keys must match ids declared in the plugin's manifest (`contributes.*`);
 * a component without a matching declaration, or a declaration without a component, is ignored.
 */
export interface UiPluginDefinition {
  views?: Record<string, ComponentType<PluginViewProps>>;
  rightSidebarTabs?: Record<string, ComponentType<PluginTabProps>>;
  taskSources?: Record<string, ComponentType<PluginTaskSourceProps>>;
  /** Custom settings component rendered below the generic form when `contributes.settingsPanel` is true. */
  settingsPanel?: ComponentType<{ plugin: PluginInfo }>;
}

export const defineUiPlugin = (def: UiPluginDefinition): UiPluginDefinition => def;
